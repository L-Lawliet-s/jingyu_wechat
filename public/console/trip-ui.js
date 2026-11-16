const route='/api/jingyu/trips';
const zone=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const time=at=>typeof at==='number'?zone.format(at):'未填写';
const kinds={indoor:'室内',outdoor:'户外',mixed:'室内外'};
const sourceNames={verified:'已人工核对',estimate:'人工估算'};
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const money=value=>Number.isFinite(value)?(value/100).toFixed(2):'';
const showMoney=value=>Number.isFinite(value)?'¥'+money(value):'待核对';
const button=(action,label)=>`<button class="dinner-button" type="button" data-trip-action="${action}">${label}</button>`;
const submit=label=>`<button class="dinner-button dinner-primary">${label}</button>`;
const options=(values,selected)=>Object.entries(values).map(([value,label])=>`<option value="${value}"${value===selected?' selected':''}>${label}</option>`).join('');
const field=(label,name,value,attributes='')=>`<label>${label}<input name="${name}" value="${escape(value)}" ${attributes}></label>`;
const section=(title,html)=>`<section class="dinner-card"><h2>${title}</h2>${html}</section>`;
const link=(url,label)=>`<a class="dinner-button" href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;

function candidateForm(row) {
  return section(row?'修改方案 '+row.id:'新增备选方案',`<form data-trip-form="candidate">
    <div class="dinner-fields">
      ${field('方案名称','title',row?.title,'maxlength="60" required')}
      ${field('集合地点','place',row?.place,'maxlength="100" required')}
      ${field('开始（北京时间）','start',row?time(row.start).replace(' ','T'):'','type="datetime-local" required')}
      ${field('结束（北京时间）','end',row?time(row.end).replace(' ','T'):'','type="datetime-local" required')}
      ${field('每人基础费用（元）','per',money(row?.per),'type="number" min="0" max="9999.99" step="0.01"')}
      ${field('所有人共摊费用（元）','shared',money(row?.shared),'type="number" min="0" max="9999.99" step="0.01"')}
      <label>场地<select name="kind">${options(kinds,row?.kind??'indoor')}</select></label>
      <label>费用来源<select name="source">${options(sourceNames,row?.source??'estimate')}</select></label>
    </div>
    <p class="dinner-muted">无共摊费用填 0。未知费用留空。票务、住宿和预约由发起人在平台核对。</p>
    <label>发布后可见的安排备注<textarea name="note" maxlength="200" rows="2">${escape(row?.note)}</textarea></label>
    <div class="dinner-actions">${submit('保存方案')}${row?button('add','改为新增'):''}
      ${link('https://www.12306.cn/','铁路 12306')}${link('https://hotels.ctrip.com/hotels','携程酒店')}${link('https://www.amap.com/','高德地图')}</div>
  </form>`);
}

function published(trip) {
  if(trip.status==='closed')return '<p>活动已结束。</p>';
  if(trip.published)return `<p>已发布方案 ${trip.published}。参与者私聊发「出游 ${trip.code} 查看」即可看到。</p>
    <div class="dinner-actions">${button('export','下载日历 .ics')}</div>`;
  return trip.needsReview?'<p class="dinner-alert">活动条件有变更，请比较备选并重新发布。</p>':'<p>行程待发布。</p>';
}
function people(trip,bounds) {
  const common=bounds.timeCount?(bounds.earliest<bounds.latest?`${time(bounds.earliest)} 至 ${time(bounds.latest)}`:'暂时无重合'):'待填写';
  return section('参加人数与条件',`<p>${trip.members.length} 人加入 · ${trip.members.filter(row=>row.conditions).length} 人已确认条件</p>
    <p>已填时间的交集（${bounds.timeCount}/${trip.members.length} 人） ${common}</p>
    <p>已填预算中的最低人均上限（${bounds.budgetCount}/${trip.members.length} 人） ${showMoney(bounds.per)}</p>
    <div class="dinner-options">${trip.members.map(member=>{
      const values=member.conditions??{};
      return `<article class="dinner-option"><h3>${escape(member.label)}</h3>
      <p>时间 ${values.start===undefined?'待补充':`${time(values.start)} 至 ${time(values.end)}`}</p>
      <p>人均预算 ${showMoney(values.budget)}${values.preference?' · '+escape(values.preference):''}</p>
      ${member.hasDraft?'<p class="dinner-muted">对方有待确认草稿</p>':''}
      ${member.submitted?`<p class="dinner-muted">来自微信私聊 · ${time(member.submitted)}</p>`:''}
      ${member.feedback?`<p>活动反馈：${escape(member.feedback)}</p>`:''}</article>`;
    }).join('')}</div>`);
}
function comparison(view) {
  const {candidates,trip}=view;
  if(!candidates.length)return '';
  return section('比较方案',`<div class="dinner-options">${candidates.map(row=>{
    const warning=row.gaps.length>0||row.individual===null;
    return `<article class="dinner-option"><h3>${row.id}. ${escape(row.title)}${trip.published===row.id?' · 已发布':''}</h3>
      <p>${time(row.start)} 至 ${time(row.end)}</p><p>${escape(row.place)} · ${kinds[row.kind]}</p>
      <p>合计 ${showMoney(row.total)} · 人均 ${showMoney(row.individual)} · 按 ${row.people} 人</p>
      <p class="dinner-muted">${sourceNames[row.source]} · 匹配 ${row.hits} 位已填场地偏好</p>
      ${row.conflicts.length?`<p class="dinner-alert">${row.conflicts.map(escape).join('；')}</p>`:''}
      ${row.gaps.length?`<p class="dinner-muted">待补时间或预算：${row.gaps.map(escape).join('、')}</p>`:''}
      ${trip.status==='open'?`<div class="dinner-actions">${button('edit:'+row.id,'修改方案')}</div>
        ${row.conflicts.length?'':`<form data-trip-form="publish" data-trip-id="${row.id}">
          ${warning?'<label class="dinner-check"><input type="checkbox" name="acceptGaps" required>我已核对缺项，仍发布</label>':''}
          ${submit('发布这个方案')}</form>`}`:''}
    </article>`;
  }).join('')}</div>`);
}
function incident(trip) {
  const change=[...(trip.change?.rain?['雨雪变化']:[]),...(trip.change?.bookings??[]).map(id=>'方案 '+id+' 预约不可用')].join('、');
  return section('天气与预约变化',`${change?`<p>当前记录：${change}</p>`:''}
    <form data-trip-form="change"><div class="dinner-fields">
    <label>变化<select name="type"><option value="rain">有雨雪，调整户外计划</option><option value="booking">预约不可用</option><option value="clear">解除变化标记</option></select></label>
    <label>受影响预约<select name="id"><option value="">选择方案</option>${trip.candidates.map(row=>`<option value="${row.id}">${escape(row.title)}</option>`).join('')}</select></label></div>
    ${submit('更新变化')}</form>`);
}
function tasks(trip) {
  return section('活动分工',`${trip.tasks.length?`<ul>${trip.tasks.map(row=>`<li>${row.id}. ${escape(row.title)} · ${row.done?'已完成':row.assignee?'已认领':'待认领'}${row.assignee?' · '+escape(row.assignee):''}</li>`).join('')}</ul>`:''}
    ${trip.status==='open'?`<form data-trip-form="task"><div class="dinner-fields">${field('新增分工','title','','maxlength="50" required placeholder="例如：核对开放时间"')}</div>
      ${submit('添加分工')}</form><p class="dinner-muted">发布后，参与者可在微信发送「出游 ${trip.code} 认领 1」或「出游 ${trip.code} 完成 1」。</p>`:''}`);
}
function workspace(view,editing) {
  const trip=view.trip;
  const picker=section('活动',`<div class="dinner-reminder"><label>选择活动<select data-trip-select><option value="">新建活动</option>
    ${view.list.map(row=>`<option value="${row.code}"${row.code===trip?.code?' selected':''}>${escape(row.title)}${row.status==='closed'?' · 已结束':''}</option>`).join('')}</select></label>
    <div class="dinner-actions">${button('new','新建')}${button('sync','同步')}</div></div>`);
  if(!trip)return picker+section('新建活动',`<form data-trip-form="create">${field('活动名称','title','','maxlength="60" required placeholder="例如：周六一起看展"')}
    <div class="dinner-actions">${submit('创建活动')}</div></form>`);
  return picker+section(escape(trip.title),`${published(trip)}
      ${trip.status==='open'?`<label>邀请语<input data-trip-code value="出游 ${trip.code} 加入" readonly></label>
        <div class="dinner-actions">${button('copy','复制邀请语')}</div>
        <p class="dinner-muted">把邀请语发给已加入微信私聊允许范围的联系人。你也可以私聊小鲸鱼发自己的时间和预算。</p>`:''}`)
    +people(trip,view.bounds)+comparison(view)
    +(trip.status==='open'?candidateForm(view.candidates.find(row=>row.id===editing))+incident(trip):'')
    +tasks(trip)+section('变更记录',`<details data-trip-log><summary>查看 ${trip.events.length} 条记录</summary><ul>${trip.events.map(row=>`<li>${time(row.at)} · ${escape(row.message)}</li>`).join('')}</ul></details>
      <div class="dinner-actions">${trip.status==='open'?button('close','结束活动'):button('delete','删除活动和条件')}</div>`);
}

function download(text) {
  const url=URL.createObjectURL(new Blob([text],{type:'text/calendar;charset=utf-8'}));
  const anchor=document.createElement('a');
  anchor.href=url;
  anchor.download='jingyu-trip.ics';
  anchor.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
export function mountTrips(container,request) {
  const frame=document.createElement('div');
  frame.className='dinner dinner-content';
  frame.innerHTML='<p data-trip-status role="status" class="dinner-message" hidden></p><div data-trip-main class="dinner-content"><p>正在读取出游活动…</p></div>';
  container.replaceChildren(frame);
  const main=frame.querySelector('[data-trip-main]'), status=frame.querySelector('[data-trip-status]');
  const edits=new Set();
  let code='',view,editing,busy=false,polling=false,disposed=false,serial=0,signature='';
  function report(message='',error=false) {
    if(disposed)return;
    status.hidden=!message;
    status.classList.toggle('dinner-alert',error);
    status.textContent=message;
  }
  function paint() {
    if(!view||disposed)return;
    const open=main.querySelector('[data-trip-log]')?.open;
    main.innerHTML=workspace(view,editing);
    if(open && main.querySelector('[data-trip-log]'))main.querySelector('[data-trip-log]').open=true;
  }
  async function sync(force=false) {
    const turn=++serial;
    const next=await (code?request(route,{action:'view',code}):request(route));
    if(disposed||serial!==turn||(!force&&(edits.size||busy)))return;
    const nextSignature=JSON.stringify(next);
    if(force||signature!==nextSignature){view=next;signature=nextSignature;paint();}
  }
  async function perform(fn) {
    if(busy||disposed)return;
    busy=true;
    serial++;
    report();
    frame.setAttribute('aria-busy','true');
    try { await fn(); }
    catch(error) { report(error.message,true); }
    finally {busy=false;frame.removeAttribute('aria-busy');}
  }
  function permit(form) {return ![...edits].some(row=>row!==form)||window.confirm('放弃当前未保存的编辑？');}
  async function choose(next) {
    if(!permit())return;
    edits.clear();
    code=next;
    editing=undefined;
    await sync(true);
  }
  async function save(action,fields,form) {
    if(!permit(form))return;
    const result=await request(route,{action,code,revision:view.trip?.revision,...fields});
    if(disposed)return;
    edits.clear();
    code=result.code;
    if(action==='candidate')editing=undefined;
    await sync(true);
    report(action==='publish'?'已发布。参与者可在微信查看。':'已保存。');
  }
  frame.addEventListener('input',({target})=>{
    const form=target.closest('[data-trip-form]');
    if(form)edits.add(form);
  });
  frame.addEventListener('change',({target})=>{
    if(!target.matches('[data-trip-select]'))return;
    const next=target.value;
    target.value=code;
    void perform(()=>choose(next));
  });
  frame.addEventListener('submit',event=>{
    const form=event.target;
    if(!form.matches('[data-trip-form]'))return;
    event.preventDefault();
    const action=form.dataset.tripForm, fields=Object.fromEntries(new FormData(form));
    if(action==='candidate'&&editing!==undefined)fields.id=editing;
    if(action==='change'&&fields.id)fields.id=Number(fields.id);
    if(action==='publish'){fields.id=Number(form.dataset.tripId);fields.acceptGaps=fields.acceptGaps==='on';}
    void perform(()=>save(action,fields,form));
  });
  frame.addEventListener('click',event=>{
    const target=event.target.closest('[data-trip-action]');
    if(!target)return;
    const [action,id]=target.dataset.tripAction.split(':');
    if(action==='copy'){
      const line=main.querySelector('[data-trip-code]');
      line.select();
      report(document.execCommand('copy')?'邀请语已复制。':'邀请语已选中，可用设备的复制操作。');
      return;
    }
    void perform(async()=>{
      if(action==='sync'||action==='new')return choose(action==='sync'?code:'');
      if(action==='edit'||action==='add'){
        if(!permit())return;
        edits.clear();
        editing=id?Number(id):undefined;
        paint();
        main.querySelector('[data-trip-form=candidate]').scrollIntoView({block:'nearest'});
        return;
      }
      if(action==='export'){
        const result=await request(route,{action,code,revision:view.trip.revision});
        if(!disposed)download(result.content);
        return;
      }
      if(['close','delete'].includes(action)&&window.confirm(action==='close'?'结束这个活动？':'删除这个活动和全部条件？')){
        await save(action,{confirmed:true});
      }
    });
  });
  const timer=setInterval(async()=>{
    if(disposed||busy||polling||edits.size||document.hidden||
      (frame.contains(document.activeElement)&&document.activeElement.matches('input,select,textarea')))return;
    polling=true;
    try{await sync();}catch(error){report(error.message,true);}
    finally{polling=false;}
  },4000);
  void perform(()=>sync(true));
  return ()=>{disposed=true;serial++;clearInterval(timer);};
}
