import { fault } from './store.mjs';
import { cents, localTime, text } from './dinner/rules.mjs';
import { beijingTime } from './life-calendar.mjs';

const minute=60_000;
const day=1440*minute;
const clock='(?:凌晨|早上|上午|中午|下午|晚上)?\\s*\\d{1,2}(?::\\s*\\d{2}|\\s*点(?:半|\\s*\\d{1,2}\\s*分?)?)?';
const range=new RegExp(`(?<start>${clock})\\s*(?:至|到|[-~—])\\s*(?<end>${clock})(?![\\d:])`,'u');
const daySeparator=/\s*(?:至|到|[-~—])\s*$/u;
const leadingTime=new RegExp(`^(${clock})(?![\\d:])`,'u');
const explicitDate=/(20\d{2}-\d{2}-\d{2})|(?:\d{1,2}月\d{1,2}日)|(?:今天|明天|后天|(?:(?:本|这|下)?(?:周|星期))[一二三四五六日天])/gu;
const digits='零一二三四五六七八九';
const pad=value=>String(value).padStart(2,'0');

function replaceHour(text) {
  return text.replace(/([零一二两三四五六七八九十]{1,3})(?=点)/gu,raw=>{
    const value=raw.replace('两','二');
    if(!value.includes('十'))return value.length===1?String(digits.indexOf(value)):raw;
    const [first,last]=value.split('十');
    return String((first?digits.indexOf(first):1)*10+(last?digits.indexOf(last):0));
  });
}

function selectedDate(raw,now) {
  const today=localTime(now).slice(0,10);
  const midnight=beijingTime(today+'T00:00');
  if (/^20\d{2}-/.test(raw)) return raw;
  if(raw.includes('月')) {
    const [m,d]=raw.match(/\d+/g);
    return `${today.slice(0,4)}-${pad(m)}-${pad(d)}`;
  }
  if (['今天','明天','后天'].includes(raw)) return localTime(midnight+['今天','明天','后天'].indexOf(raw)*day).slice(0,10);
  const target='一二三四五六日天'.indexOf(raw.at(-1))+1;
  const weekday=(new Date(midnight+8*3600_000).getUTCDay()+6)%7+1;
  const diff=Math.min(target,7)-weekday;
  const offset=raw.startsWith('下')?diff+7:/^(本|这)/.test(raw)?diff:(diff+7)%7;
  return localTime(midnight+offset*day).slice(0,10);
}

function timeOf(raw,inherit='') {
  const match=/^(凌晨|早上|上午|中午|下午|晚上)?\s*(\d{1,2})(?::\s*(\d{2})|\s*点(半|\s*\d{1,2}\s*分?)?)?$/u.exec(raw.trim());
  if (!match) throw fault('请补充具体的开始和结束时刻。');
  const [,part,hours,mins,spoken]=match, context=part??inherit;
  let h=Number(hours), m=Number(mins??(spoken==='半'?30:spoken?.replace('分','')??0));
  if (context&&h>12) throw fault('请用 24 小时时间，或用「下午三点」这样的写法。');
  if(['下午','晚上'].includes(context)&&h<12)h+=12;
  if(context==='凌晨'&&h===12)h=0;
  if(context==='中午'&&h<8)h+=12;
  if(h>23||m>59)throw fault('请填写有效的时间。');
  return {hhmm:`${pad(h)}:${pad(m)}`,part:context};
}

function windowFor(value,dates,now) {
  const [first,last]=dates;
  const from=selectedDate(first[0],now);
  const tail=(last??first);
  const rest=value.slice(tail.index+tail[0].length).trimStart().replace(/^T(?=\d)/u,'');
  if(last){
    const between=value.slice(first.index+first[0].length,last.index).trim();
    if(!daySeparator.test(between))throw fault('一次请发一个连续时间段，可写「周六到周日全天」。');
    const to=selectedDate(last[0],now);
    const firstHours=between.replace(daySeparator,'').trim().replace(/^T(?=\d)/u,'');
    if(!firstHours&&/^全天/u.test(rest))return [beijingTime(from+'T00:00'),beijingTime(to+'T00:00')+day];
    const lastHours=leadingTime.exec(rest)?.[1];
    if(!firstHours||!lastHours)throw fault('跨日时间请带上开始和结束时刻，或写「周六到周日全天」。');
    return [beijingTime(from+'T'+timeOf(firstHours).hhmm),beijingTime(to+'T'+timeOf(lastHours).hhmm)];
  }
  if(/^全天/u.test(rest)){
    const midnight=beijingTime(from+'T00:00');
    return [midnight,midnight+day];
  }
  const hours=range.exec(rest);
  if(!hours||hours.index!==0)throw fault('时间请写成「周六10:00到16:00」或「周六全天」。');
  const start=timeOf(hours.groups.start);
  const shorthand=/^\s*(?:\d|1[0-2])\s*点/u.test(hours.groups.end);
  const end=timeOf(hours.groups.end,shorthand?start.part:'');
  return [beijingTime(from+'T'+start.hhmm),beijingTime(from+'T'+end.hhmm)];
}

function preferenceTag(value) {
  if(/不(?:想|去|要|考虑)(?:去)?户外|想(?:去)?室内|优先室内|^室内/u.test(value))return 'indoor';
  if(/不(?:想|去|要|考虑)(?:去)?室内|想(?:去)?户外|优先户外|^户外/u.test(value))return 'outdoor';
  return '';
}
export function oneLine(value,max,label) {
  const content=text(value,max,label,true);
  if(/[\r\n\t]/u.test(content))throw fault(`${label}请填写一行文字。`);
  return content;
}
export function intakeConstraints(raw,now) {
  const value=replaceHour(oneLine(raw,240,'出行条件').normalize('NFKC'));
  const result={};
  const dates=[...value.matchAll(explicitDate)];
  if(dates.length>2)throw fault('一次请发一个连续时间段。');
  if(dates.length) {
    const [start,end]=windowFor(value,dates,now);
    if(end<=start||end<=now||start>now+90*day||end-start>4*day)throw fault('请提供未来 90 天内、结束晚于开始、最长 4 天的时段。');
    Object.assign(result,{start,end});
  } else if(/有空|全天|^(?:上午|下午|\d{1,2}点)/u.test(value)) throw fault('请把日期和时段一起发给我，例如「周六10:00到16:00」。');
  if(/预算/u.test(value)){
    const budgets=[...value.matchAll(/预算\s*(?:是|[:：]|最多|不超过|上限|约|大概)?\s*[¥￥]?\s*(\d{1,5}(?:\.\d{1,2})?)(?![\d.])\s*(?:元|块)?/gu)];
    if(budgets.length!==1||/总预算|预算[^,，;；。]{0,20}\d\s*[-~至到]\s*\d/u.test(value))throw fault('预算请发一个人均上限，例如「预算200元」。');
    result.budget=cents(budgets[0][1],'人均预算',{required:true,max:1_000_000});
  }
  const preference=/(?:偏好\s*[:：]?\s*|(?:我)?(?:更?想|喜欢|希望)(?:去)?)([^;；。]{1,60})/u.exec(value)?.[1]
    ?.split(/[,，]\s*(?=预算|(?:本|这|下)?(?:周|星期)|今天|明天|后天)/u)[0]?.trim();
  if(preference){
    result.preference=preference;
    result.tag=preferenceTag(preference);
  }
  if(!Object.keys(result).length)throw fault('可以发时间、预算或偏好，例如「周六10:00到16:00，预算200元，偏好室内看展」。');
  return result;
}

export function candidateSpec(body,now) {
  const start=beijingTime(body.start,'开始时间'),end=beijingTime(body.end,'结束时间');
  if(start===null||end===null||start<Math.floor(now/minute)*minute||end<=start||end-start>72*60*minute||start>now+90*day)throw fault('方案须在未来 90 天，行程最长 72 小时。');
  if(!['indoor','outdoor','mixed'].includes(body.kind)||!['estimate','verified'].includes(body.source))throw fault('请选择场地类型和费用来源。');
  const per=cents(body.per,'人均费用',{max:1_000_000}),shared=cents(body.shared,'总公摊费用',{max:10_000_000});
  return {title:oneLine(body.title,60,'方案名称'),place:oneLine(body.place,100,'集合地点'),start,end,kind:body.kind,source:body.source,
    per,shared,note:text(body.note??'',200,'预约与安排说明')};
}

export function compare(trip,now) {
  const people=Object.values(trip.members), count=Math.max(1,people.length);
  return trip.candidates.map(candidate=>{
    const {per,shared,start,end,kind}=candidate;
    const individual=per!==null&&shared!==null?per+Math.ceil(shared/count):null;
    const total=individual===null?null:per*count+shared;
    const gaps=[],conflicts=[];
    let hits=0;
    for(const member of people){
      const conditions=member.conditions;
      if(!conditions||conditions.start===undefined||conditions.budget===undefined)gaps.push(member.label);
      if(conditions?.start!==undefined&&(conditions.start>start||conditions.end<end))conflicts.push(`${member.label} 的可用时间不覆盖该方案`);
      if(individual!==null&&conditions?.budget!==undefined&&individual>conditions.budget)conflicts.push(`${member.label} 超出人均预算`);
      if(conditions?.tag===kind)hits++;
    }
    if(trip.change?.rain&&kind==='outdoor')conflicts.push('已记录雨雪变化，户外方案需要改排');
    if(trip.change?.bookings.includes(candidate.id))conflicts.push('已记录预约不可用');
    if(start<Math.floor(now/minute)*minute)conflicts.push('方案开始时间已过');
    return {...candidate,total,individual,people:count,gaps,conflicts,hits};
  }).sort((a,b)=>a.conflicts.length-b.conflicts.length||b.hits-a.hits||(a.individual??Infinity)-(b.individual??Infinity)||a.start-b.start);
}

export function planningBounds(trip) {
  const dates=[], budgets=[];
  for(const {conditions} of Object.values(trip.members)) {
    if(conditions?.start!==undefined)dates.push(conditions);
    if(conditions?.budget!==undefined)budgets.push(conditions.budget);
  }
  return {timeCount:dates.length,budgetCount:budgets.length,
    earliest:dates.length?Math.max(...dates.map(row=>row.start)):null,
    latest:dates.length?Math.min(...dates.map(row=>row.end)):null,
    per:budgets.length?Math.min(...budgets):null};
}

export function constraintsText(value) {
  if(!value)return '还没有已确认条件。';
  return [
    ...(value.start===undefined?[]:[`${localTime(value.start).replace('T',' ')} 到 ${localTime(value.end).replace('T',' ')}`]),
    ...(value.budget===undefined?[]:[`人均预算 ¥${(value.budget/100).toFixed(2)}`]),
    ...(value.preference?[`偏好：${value.preference}`]:[]),
  ].join('，');
}
