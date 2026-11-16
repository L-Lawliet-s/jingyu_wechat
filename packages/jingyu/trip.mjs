import { randomBytes } from 'node:crypto';
import { hash, fault } from './store.mjs';
import { localTime } from './dinner/rules.mjs';
import { lifeCalendar } from './life-calendar.mjs';
import { candidateSpec, compare, constraintsText, intakeConstraints, oneLine, planningBounds } from './trip-rules.mjs';

const minutes=60_000;
const codePattern=/^[0-9A-F]{8}$/;
const kinds={indoor:'室内',outdoor:'户外',mixed:'室内外'};
const yen=amount=>amount===null?'待核对':`¥${(amount/100).toFixed(2)}`;
const label=at=>localTime(at).replace('T',' ');
const scope=(account,actor)=>hash(account+'\0'+actor);
const changed=(trip,at,message)=>({...trip,revision:trip.revision+1,updated:at,
  events:[...trip.events.slice(-19),{at,message}]});
const unpublish=trip=>trip.published?{...trip,published:null,needsReview:true}:trip;

export function parseTripMessage(raw) {
  if(typeof raw!=='string')return null;
  const text=raw.trim();
  const create=/^出游\s*(?:新建|创建)(?:\s+|\s*[:：]\s*)([\s\S]+)$/u.exec(text);
  if(create)return {command:'create',text:create[1]};
  const match=/^出游\s+([0-9a-f]{8})\s+([\s\S]+)$/iu.exec(text);
  return match?{code:match[1].toUpperCase(),text:match[2].trim()}:null;
}

function participantName(display) {
  return (typeof display==='string'?display:'').replace(/[\x00-\x1f\x7f<>]/gu,' ').trim().slice(0,32) || '微信参与者';
}
function publicPlan(trip,member,now) {
  const row=trip.published&&trip.candidates.find(item=>item.id===trip.published);
  if(!row)return trip.needsReview?'方案有变更，正在重新核对。':'发起人还在确认方案，发布后可以在这里查看。';
  if(row.end<=now)return '该活动时间已结束了。';
  const plan=compare(trip,now).find(item=>item.id===row.id);
  const tasks=trip.tasks.map(task=>`${task.id}. ${task.title}（${task.done?'已完成':task.member===member?'你已认领':task.member?'已认领':'待认领'}）`);
  return [
    `「${trip.title}」已发布：${row.title}`,`时间：${label(row.start)} 至 ${label(row.end)}`,`集合：${row.place}`,
    `人均费用：${yen(plan.individual)}（${row.source==='verified'?'发起人已核对':'发起人估算'}，按 ${plan.people} 人）`,
    ...(row.note?[row.note]:[]),...(tasks.length?['分工：\n'+tasks.join('\n')]:[]),
  ].join('\n');
}

export class TripService {
  constructor(store,{now=Date.now}={}) {
    this.store=store;
    this.db=store.db;
    this.now=now;
    this.db.exec(`CREATE TABLE IF NOT EXISTS trip_plans (code TEXT PRIMARY KEY,binding TEXT NOT NULL,updated INTEGER NOT NULL,payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS trip_recent ON trip_plans(binding,updated DESC);
      CREATE TABLE IF NOT EXISTS trip_receipts (id TEXT PRIMARY KEY,at INTEGER NOT NULL);`);
  }
  identity() {
    const actor=this.store.settings().ownerWxid;
    if(!actor)throw fault('请先在「鲸鱼账户与记忆」绑定主人微信 ID。',409);
    return {actor,binding:scope(this.store.account,actor)};
  }
  trip(code,binding) {
    if(!codePattern.test(code??''))throw fault('这个活动码暂不可用。',404);
    const row=this.db.prepare('SELECT payload FROM trip_plans WHERE code=? AND binding=?').get(code,binding);
    if(!row)throw fault('这个活动码暂不可用。',404);
    return JSON.parse(row.payload);
  }
  view(code='') {
    const {binding}=this.identity();
    const list=this.db.prepare('SELECT payload FROM trip_plans WHERE binding=? ORDER BY updated DESC LIMIT 50').all(binding)
      .map(({payload})=>{const {code,title,revision,status,published}=JSON.parse(payload);return {code,title,revision,status,published};});
    if(!code)return {list,trip:null};
    const trip=this.trip(code,binding);
    const members=Object.values(trip.members).map(({id,label,joined,conditions,submitted,draft,feedback})=>
      ({id,label,joined,conditions,submitted,hasDraft:Boolean(draft),feedback}));
    const tasks=trip.tasks.map(({member,...task})=>({...task,assignee:trip.members[member]?.label??''}));
    const {members: _members,...record}=trip;
    return {list,trip:{...record,tasks,members},candidates:compare(trip,this.now()),bounds:planningBounds(trip)};
  }
  save(trip,binding,message) {
    const next=changed(trip,this.now(),message);
    this.db.prepare('UPDATE trip_plans SET updated=?,payload=? WHERE code=? AND binding=?')
      .run(next.updated,JSON.stringify(next),next.code,binding);
    return {code:next.code,revision:next.revision};
  }
  create(title,binding) {
    title=oneLine(title,60,'活动名称');
    const count=this.db.prepare('SELECT COUNT(*) AS total FROM trip_plans WHERE binding=?').get(binding).total;
    if(count>=50)throw fault('已达到 50 条活动，请先删除已结束的活动。',409);
    let code;
    do {code=randomBytes(4).toString('hex').toUpperCase();}
    while(this.db.prepare('SELECT 1 FROM trip_plans WHERE code=?').get(code));
    const at=this.now();
    const data={code,title,status:'open',revision:1,updated:at,published:null,needsReview:false,
      members:{[binding]:{id:1,label:'发起人',joined:at,seq:0}},nextMember:2,candidates:[],nextCandidate:1,
      tasks:[],nextTask:1,change:null,events:[{at,message:'发起人创建活动'}]};
    this.db.prepare('INSERT INTO trip_plans VALUES(?,?,?,?)').run(code,binding,at,JSON.stringify(data));
    return {code,revision:1};
  }
  manage(action,trip,binding,body) {
    if(trip.revision!==body.revision)throw fault('活动收到更新，请同步并重新核对。',409);
    if(action==='delete'){
      if(trip.status!=='closed'||body.confirmed!==true)throw fault('请先结束活动并确认清除。',409);
      this.db.prepare('DELETE FROM trip_plans WHERE code=? AND binding=?').run(trip.code,binding);
      return {code:'',revision:0};
    }
    if(trip.status!=='open')throw fault('这是已结束的活动。',409);
    if(action==='candidate'){
      const spec=candidateSpec(body,this.now());
      const id=body.id===undefined?trip.nextCandidate:body.id;
      const previous=trip.candidates.some(row=>row.id===id);
      if(!previous&&body.id!==undefined)throw fault('找不到该方案。',404);
      if(!previous&&trip.candidates.length>=6)throw fault('每个活动最多比较六个方案。');
      const next={...trip,nextCandidate:trip.nextCandidate+Number(!previous),
        candidates:[...trip.candidates.filter(row=>row.id!==id),{id,...spec}]};
      return this.save(trip.published===id?unpublish(next):next,binding,previous?'发起人修改方案':'发起人补充方案');
    }
    if(action==='publish'){
      const chosen=compare(trip,this.now()).find(row=>row.id===body.id);
      if(!chosen)throw fault('请先选择有效方案。',409);
      if(chosen.conflicts.length)throw fault('该方案有已知冲突，请调整时间、费用或参加范围。',409);
      if((chosen.gaps.length||chosen.individual===null)&&body.acceptGaps!==true)throw fault('还有待确认的参与者条件或费用，请核对后明确确认。',409);
      return this.save({...trip,published:chosen.id,needsReview:false},binding,`发起人发布方案 ${chosen.id}`);
    }
    if(action==='change'){
      if(!['rain','booking','clear'].includes(body.type))throw fault('请选择天气或预约变化。');
      if(body.type==='booking'&&!trip.candidates.some(row=>row.id===body.id))throw fault('请选择失效的方案。');
      const previous=trip.change??{rain:false,bookings:[]};
      const change=body.type==='clear'?null:body.type==='rain'?{...previous,rain:true}:
        {...previous,bookings:[...new Set([...previous.bookings,body.id])]};
      return this.save({...unpublish(trip),change},binding,({rain:'已记录雨雪变化',booking:'已记录预约不可用',clear:'已解除变化标记'})[body.type]);
    }
    if(action==='task'){
      if(trip.tasks.length>=8)throw fault('每个活动最多新增八项分工。');
      const task={title:oneLine(body.title,50,'分工事项'),id:trip.nextTask,member:null,done:false};
      return this.save({...trip,nextTask:trip.nextTask+1,tasks:[...trip.tasks,task]},binding,'发起人新增分工');
    }
    if(action==='close'){
      if(body.confirmed!==true)throw fault('请确认结束活动。');
      return this.save({...trip,status:'closed',published:null},binding,'发起人结束活动');
    }
    if(action==='export'){
      const row=trip.published&&trip.candidates.find(item=>item.id===trip.published);
      if(!row)throw fault('请先发布当前方案。',409);
      return {content:lifeCalendar({id:trip.code,title:trip.title+' · '+row.title,place:row.place,start:row.start,
        duration:(row.end-row.start)/minutes,revision:trip.revision,reminder:row.start-30*minutes,status:'open'},this.now())};
    }
    throw fault('没有这个活动操作。',404);
  }
  desktop(body) {
    if(body?.action==='view')return this.view(body.code);
    return this.store.transaction(()=>{
      const {binding}=this.identity();
      if(body?.action==='create')return this.create(body.title,binding);
      return this.manage(body?.action,this.trip(body?.code,binding),binding,body);
    });
  }
  memberAction(trip,binding,key,sender,command) {
    const member=trip.members[key];
    const prefix=`出游 ${trip.code}`;
    if(command==='加入'){
      if(member)return `你已在「${trip.title}」里。直接发「${prefix} 周六10:00到16:00，预算200元，偏好室内看展」就能更新你的条件。`;
      if(Object.keys(trip.members).length>=16)throw fault('这个活动的参加人数已满。');
      const joined={id:trip.nextMember,label:`${participantName(sender)} #${trip.nextMember}`,joined:this.now(),seq:0};
      this.save({...unpublish(trip),nextMember:trip.nextMember+1,members:{...trip.members,[key]:joined}},binding,'一位参与者加入');
      return `加入「${trip.title}」啦。我是小鲸鱼 AI。发我时间、预算或偏好，再确认一次，发起人就能拿到你的条件做规划。示例：${prefix} 周六10:00到16:00，预算200元，偏好室内看展`;
    }
    if(!member)throw fault('请先用活动码加入该活动。',404);
    if(command==='查看')return publicPlan(trip,key,this.now());
    if(command==='我的')return '你的条件：'+constraintsText(member.conditions)+(member.draft?`\n待确认：${constraintsText(member.draft.values)}\n${prefix} 确认 ${member.draft.seq}`:'');
    if (command==='退出' || command==='清除'){
      if(command==='退出'&&binding===key)throw fault('发起人可清除自己的条件，或在桌面结束活动。');
      const members={...trip.members};
      if(command==='退出')delete members[key];
      else members[key]={id:member.id,label:member.label,joined:member.joined,seq:member.seq};
      const tasks=command==='退出'?trip.tasks.map(task=>task.member===key?{...task,member:null,done:false}:task):trip.tasks;
      this.save({...unpublish(trip),members,tasks},binding,command==='退出'?'一位参与者退出并撤回条件':'一位参与者清除条件');
      return command==='退出'?'你已退出，已撤回本活动的条件和分工。':'已清除你在此活动的条件与反馈。';
    }
    const confirm=/^确认\s+(\d{1,8})$/u.exec(command);
    if(confirm){
      if(!member.draft||member.draft.seq!==Number(confirm[1]))throw fault('这个确认号已过期，发「我的」查看当前草稿。',409);
      const next={...member,conditions:member.draft.values,draft:null,submitted:this.now()};
      this.save({...unpublish(trip),members:{...trip.members,[key]:next}},binding,'一位参与者确认条件');
      return `收到啦，已交给发起人汇总。之后发「${prefix} 查看」就能查发布的行程。`;
    }
    const taskMatch=/^(认领|完成)\s+([1-9]\d?)$/u.exec(command);
    if(taskMatch){
      if(!trip.published)throw fault('活动发布后可以处理分工。',409);
      const task=trip.tasks.find(row=>row.id===Number(taskMatch[2]));
      if(!task||task.member&&task.member!==key||taskMatch[1]==='完成'&&task.member!==key)throw fault('只能完成自己已认领的分工，已有人认领的事项不能重复认领。',409);
      this.save({...trip,tasks:trip.tasks.map(row=>row===task?{...row,member:key,done:row.done||taskMatch[1]==='完成'}:row)},binding,'一位参与者更新分工');
      return `已${taskMatch[1]}：${task.title}。`;
    }
    const feedback=/^反馈(?:\s+|[:：]\s*)(.*)$/u.exec(command);
    if(feedback){
      if(!trip.published)throw fault('方案发布后可以提交反馈。',409);
      const next={...member,feedback:oneLine(feedback[1],100,'活动反馈')};
      this.save({...trip,members:{...trip.members,[key]:next}},binding,'一位参与者提交反馈');
      return '反馈收到啦，发起人可以在活动里查看。';
    }
    const values={...member.conditions,...member.draft?.values,...intakeConstraints(command,this.now())};
    const seq=member.seq+1;
    this.save({...trip,members:{...trip.members,[key]:{...member,seq,draft:{seq,values}}}},binding,'收到一份待确认的参与者条件');
    return `我先记成这样：${constraintsText(values)}。\n核对后发「${prefix} 确认 ${seq}」，我再交给发起人。`;
  }
  hostAction(trip,binding,command) {
    const prefix=`出游 ${trip.code}`;
    if(command==='汇总'){
      const rows=Object.values(trip.members);
      const plans=compare(trip,this.now());
      const bounds=planningBounds(trip);
      const window=!bounds.timeCount?'待填':bounds.earliest>=bounds.latest?'暂时无重合':
        label(bounds.earliest)+' 至 '+label(bounds.latest);
      const people=rows.slice(0,8).map(row=>`${row.label}：${constraintsText(row.conditions)}`);
      const choices=plans.map(row=>`${row.id}. ${row.title} · 人均 ${yen(row.individual)}${row.conflicts.length?` · ${row.conflicts.length} 项冲突`:row.gaps.length?' · 有待回复条件':' · 无已知冲突'}`);
      const first=plans.find(row=>!row.conflicts.length);
      return [`「${trip.title}」共 ${rows.length} 人，已确认条件 ${rows.filter(row=>row.conditions).length} 人。`,
        `已填时间的交集（${bounds.timeCount}/${rows.length} 人）：${window}；已填预算中的最低人均上限：${yen(bounds.per)}。`,
        ...people,...(rows.length>8?['其余参与者可在桌面查看。']:[]),...(choices.length?choices:['还没有备选方案，可在桌面添加。']),
        ...(first?[`核对后发「${prefix} 发布 ${first.id} V${trip.revision}${first.gaps.length||first.individual===null?' 接受缺项':''}」`]:[]),
      ].join('\n');
    }
    const publish=/^发布\s+([1-9]\d*)\s+V(\d+)(?:\s+(接受缺项))?$/iu.exec(command);
    if(publish){
      this.manage('publish',trip,binding,{id:Number(publish[1]),revision:Number(publish[2]),acceptGaps:Boolean(publish[3])});
      return `发布好啦。参与者发「${prefix} 查看」就能看到行程。`;
    }
    const booking=/^预约取消\s+([1-9]\d*)$/u.exec(command);
    if (command==='下雨'||command==='解除变化'||booking) {
      this.manage('change',trip,binding,{revision:trip.revision,type:booking?'booking':command==='下雨'?'rain':'clear',
        ...(booking?{id:Number(booking[1])}:{})});
      return `变化记下啦，发「${prefix} 汇总」比对后再发布。`;
    }
    const candidate=/^(?:方案\s+|修改方案\s+([1-9]\d*)\s*[|｜]\s*)([\s\S]+)$/u.exec(command);
    if(candidate){
      const [title,place,start,end,per,shared,kind,...rest]=candidate[2].split(/[|｜]/u).map(row=>row.trim());
      if(rest.length||!kind||!Object.values(kinds).includes(kind))throw fault(`发「${prefix} 方案 名称｜集合地｜YYYY-MM-DD HH:mm｜YYYY-MM-DD HH:mm｜人均费用｜总公摊｜室内」`);
      this.manage('candidate',trip,binding,{revision:trip.revision,...(candidate[1]?{id:Number(candidate[1])}:{}),title,place,start:start.replace(' ','T'),end:end.replace(' ','T'),per,shared,
        kind:Object.keys(kinds).find(key=>kinds[key]===kind),source:'estimate'});
      return `方案收好啦，发「${prefix} 汇总」就能比较。`;
    }
    return null;
  }
  chat(request,event) {
    const {actor,chat,name,receipt}=event;
    return this.store.transaction(()=>{
      const {binding}=this.identity();
      const key=scope(this.store.account,actor), owner=this.store.owner(chat,actor);
      if(this.db.prepare('SELECT 1 FROM trip_receipts WHERE id=?').get(receipt))return null;
      let reply;
      if(request.command==='create'){
        if(!owner)throw fault('只有绑定的主人可以创建出游活动。',403);
        const created=this.create(request.text,binding);
        reply=`活动建好啦。把「出游 ${created.code} 加入」发给参与者，让他们加小鲸鱼后私聊这句话。你也可以用同一个活动码发自己的条件。`;
      }else{
        const trip=this.trip(request.code,binding);
        if(trip.status!=='open')throw fault('这个活动已结束。',409);
        reply=(owner?this.hostAction(trip,binding,request.text):null)??this.memberAction(trip,binding,key,name,request.text);
      }
      const at=this.now();
      this.db.prepare('DELETE FROM trip_receipts WHERE at<?').run(at-86400000);
      this.db.prepare('INSERT INTO trip_receipts VALUES(?,?)').run(receipt,at);
      return reply;
    });
  }
}
