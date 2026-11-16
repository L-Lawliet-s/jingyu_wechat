import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fetchHourlyWeather } from '../dsh-social-bridge-plugin/weather-source.mjs';
import { fault } from './store.mjs';
import { quietNow } from './companion.mjs';
import { boundedInteger, text } from './dinner/rules.mjs';
import { beijingTime, lifeCalendar } from './life-calendar.mjs';
const minute = 60_000;
const hour = 60 * minute;
const freshness = 2 * hour;
const weatherCycle = 15 * minute;
const quoteLife = 6 * hour;
const states = { walk:'步行', bus:'公交/地铁', bike:'骑行', drive:'驾车' };
const modeList = Object.keys(states);
const reports = { rain:'现场下雨', delay:'临时延迟', blocked:'路线受阻', clear:'已解除手工变更' };
const sources = { map:'用户核对地图', personal:'用户估计' };
const mapModes = { walk:'walking', bus:'transit', drive:'driving' };
const severe = new Set([56,57,65,66,67,75,82,86,95,96,99]);
const activeTrip = trip => trip.status === 'open';
const execute = promisify(execFile);

function weatherTransport(fetchImpl) {
  if (fetchImpl!==fetch || process.platform!=='win32'|| !process.env.HTTPS_PROXY) return fetchImpl;
  const curl=path.join(process.env.SystemRoot??'C:/Windows','System32','curl.exe');
  if(!existsSync(curl))return fetchImpl;
  return async (url,{signal})=>{
    if(url.protocol!=='https:'||!['geocoding-api.open-meteo.com','api.open-meteo.com'].includes(url.host))throw Error('WEATHER_HOST_INVALID');
    // Windows curl honors the configured proxy on runtimes whose built-in fetch does not.
    const args=['-q','--silent','--fail','--globoff','--proto','=https','--max-time','21','--max-filesize','131072',
      '--header','Accept: application/json','--',url.href];
    const {stdout}=await execute(curl,args,{windowsHide:true,encoding:'buffer',maxBuffer:131072,signal});
    return new Response(stdout);
  };
}

function coordinate(value) {
  if (value===''||value===undefined) return '';
  if (typeof value!=='string') throw fault('请填写高德经度,纬度，或留空。');
  const match = /^(\d{2,3}(?:\.\d{1,8})?)\s*[,，]\s*(\d{1,2}(?:\.\d{1,8})?)$/.exec(value);
  if (!match || Number(match[1]) < 73 || Number(match[1]) > 135 || Number(match[2])<18 || Number(match[2])>54) {
    throw fault('请填写高德坐标拾取器显示的经度,纬度，或留空。');
  }
  return `${match[1]},${match[2]}`;
}
function label(value,max,name) {
  const result=text(value,max,name,true);
  if (/[\r\n\t]/u.test(result)) throw fault(`${name}请填写一行文字。`);
  return result;
}
function tripGoal(body, now) {
  const city = label(body.city,32,'通勤城市');
  if (!/^[\p{Letter}][\p{Letter} .'-]*(?:[,，]\s*[\p{Letter}][\p{Letter} .'-]*)?$/u.test(city)) throw fault('请输入城市名，可用逗号补充省份。');
  const arrival = beijingTime(body.arrival,'目标到达时间');
  if (arrival===null || arrival<=now || arrival>now+90*24*hour) throw fault('请选择未来 90 天内的到达时间。');
  if (!modeList.includes(body.preferred)) throw fault('请选择常用出行方式。');
  const origin = label(body.origin,100,'起点'), destination=label(body.destination,100,'目的地');
  if (origin===destination) throw fault('起点和目的地需要不同。');
  const from=coordinate(body.from), to=coordinate(body.to);
  if (Boolean(from)!==Boolean(to) || (from && from===to)) throw fault('可以同时留空，或填写两个不同的高德坐标。');
  return {city:city.replace('，',','),origin,destination,arrival,preferred:body.preferred,from,to,
    buffer:boundedInteger(body.buffer,'预留时间',0,90,false)};
}
export function mapRoute(goal, mode) {
  if (goal.from && goal.to) {
    const url = new URL('https://uri.amap.com/navigation');
    url.search = new URLSearchParams({ from:goal.from,to:goal.to,mode:mode==='bike'?'ride':mode==='drive'?'car':mode,src:'jingyu',callnative:'0' });
    if (mode==='bike') url.searchParams.set('callnative','1');
    return { title:mode==='bike'?'打开高德地图（手机骑行）':'打开高德路线',url:url.href };
  }
  if (mode==='bike') return { title:'打开高德，选择骑行',url:'https://www.amap.com/' };
  const url = new URL('https://api.map.baidu.com/direction');
  url.search = new URLSearchParams({
    origin:goal.origin,destination:goal.destination,region:goal.city.split(',')[0].trim(),
    mode:mapModes[mode],output:'html',src:'webapp.jingyu.commute',
  });
  return { title:'打开百度地图路线',url:url.href };
}
function hourAt(at) { return Math.floor(at/hour)*hour; }
function inWindow(busy,from,to) {
  return busy.filter(row=>row.start<to&&row.end>from)
    .sort((a,b)=>a.start-b.start)
    .map(({title,start,end})=>({title,start,end}));
}
function weatherWindow(forecast, from, until, now, raining) {
  const current = forecast && now - forecast.at < freshness;
  const first=hourAt(from), last=hourAt(until);
  const hours = current ? forecast.hours.filter(row=>row.at>=first&&row.at<=last) : [];
  const complete = hours.length === (last-first)/hour+1 && new Set(hours.map(row=>row.at)).size === hours.length;
  if (!hours.length && !raining) return {level:'unknown',complete:false,rain:null,temperature:null,gust:null,hours:[]};
  let level=complete?'clear':'unknown';
  if (raining || hours.some(row=>row.rain>=60 || row.precipitation>=0.3 || (row.code>=51 && row.code<=86))) level='wet';
  if (hours.some(row=>severe.has(row.code) || row.gust>=45)) level='strong';
  const chances=hours.map(row=>row.rain).filter(Number.isFinite);
  return {level,complete,rain:chances.length?Math.max(...chances):null,
    temperature:hours.length?[Math.min(...hours.map(row=>row.temperature)),Math.max(...hours.map(row=>row.temperature))]:null,
    gust:hours.length?Math.max(...hours.map(row=>row.gust)):null,hours};
}
function proposal(trip, mode, now, busy) {
  const {goal,forecast,incident}=trip;
  const route=trip.routes[mode];
  const map=mapRoute(goal,mode);
  if (!route) return {mode,map};
  const outdoor=mode==='bike'||mode==='walk';
  const base=goal.arrival-(route.minutes+goal.buffer)*minute;
  // Check the whole plausible travel window, including any weather buffer.
  const weather=weatherWindow(forecast,base-15*minute,goal.arrival,now,incident.rain);
  const extra = weather.level==='strong' ? (outdoor?15:10) : weather.level==='wet' ? (outdoor?10:5) : 0;
  const depart=base-extra*minute;
  const earliest=Math.max(now,incident.readyAt??0);
  const overdue=depart<Math.floor(earliest/minute)*minute;
  const realDepart=Math.max(depart,Math.ceil(earliest/minute)*minute);
  const estimatedArrival=realDepart+(route.minutes+extra)*minute;
  const conflicts=inWindow(busy,realDepart,Math.max(goal.arrival,estimatedArrival)).slice(0,5);
  const blocked=incident.blocked.includes(mode);
  const stale=now-route.at>=quoteLife;
  const avoid=outdoor&&weather.level==='strong';
  const score=Number(blocked)*1000+Number(avoid)*500+Number(overdue)*150+Number(conflicts.length>0)*100+
    Number(stale)*50+Number(outdoor&&weather.level==='wet')*25+Number(mode!==goal.preferred)*4+route.minutes/60;
  return {mode,map,route,extra,depart,weather,conflicts,overdue,blocked,stale,avoid,score,
    estimatedArrival};
}
export function listProposals(trip, now, busy=[]) {
  return modeList.map(mode=>proposal(trip,mode,now,busy));
}
function recommend(plans) {
  return plans.filter(plan=>plan.route&&!plan.blocked).sort((a,b)=>a.score-b.score)[0]?.mode??null;
}
function weatherImpact(plan) {
  return [plan.weather.level,plan.depart,plan.avoid].join('|');
}
function conflictKey(trip,plan,busy) {
  const {depart,estimatedArrival}=plan;
  return JSON.stringify(inWindow(busy,depart,Math.max(trip.goal.arrival,estimatedArrival)).map(({start,end,title})=>[start,end,title]).sort());
}
function note(trip, at, detail) {
  return {...trip,updated:at,events:[...trip.events.slice(-29),{at,detail}]};
}
function invalidated(trip, reason) {
  return trip.confirmed ? {...trip,confirmed:null,reconfirm:reason} : trip;
}
function checkTrip(trip,body) {
  if (trip.revision!==body.revision) throw fault('通勤方案已在另一台设备更新，请同步后再试。',409);
  if (!activeTrip(trip)) throw fault('该行程已归档。',409);
}
function weatherError(error) {
  return ({
    WEATHER_AMBIGUOUS:'天气城市存在同名地点，请补充省份，例如「苏州,江苏」。',
    WEATHER_NOT_FOUND:'未匹配到中国大陆天气城市，请核对城市名。',
  })[error?.message]??'暂未获取到有效天气。可继续核对路线，或稍后刷新。';
}
export class CommuteService {
  constructor(host,{fetchImpl=fetch}={}) {
    this.host=host;
    this.db=host.db;
    this.fetchImpl=weatherTransport(fetchImpl);
    this.cache=new Map();
    this.attempts=new Map();
    this.db.exec(`CREATE TABLE IF NOT EXISTS commute_trips(
      id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated INTEGER NOT NULL, payload TEXT NOT NULL
    ); CREATE INDEX IF NOT EXISTS commute_recent ON commute_trips(updated DESC);`);
  }

  now() { return this.host.now(); }
  get(id) {
    const row=this.db.prepare('SELECT payload FROM commute_trips WHERE id=?').get(typeof id==='string'?id:'');
    if (!row) throw fault('找不到该通勤行程。',404);
    return JSON.parse(row.payload);
  }
  write(trip,detail) {
    const changed=note({...trip,revision:trip.revision+1},this.now(),detail);
    if (trip.revision===0) this.db.prepare('INSERT INTO commute_trips VALUES(?,?,?,?)')
      .run(trip.id,changed.revision,changed.updated,JSON.stringify(changed));
    else if (!this.db.prepare('UPDATE commute_trips SET revision=?,updated=?,payload=? WHERE id=? AND revision=?')
      .run(changed.revision,changed.updated,JSON.stringify(changed),trip.id,trip.revision).changes) {
      throw fault('通勤方案已更新，请同步。',409);
    }
    return {id:changed.id,revision:changed.revision};
  }
  busy() { return this.host.life.busy(this.host.life.tasks()); }
  watchDue(trip, now) {
    if (!activeTrip(trip)||!trip.watch||trip.goal.arrival<=now||(this.attempts.get(trip.id)??0)>now) return false;
    const departures=trip.confirmed?[trip.confirmed.depart]:listProposals(trip,now).filter(p=>p.route&&!p.blocked).map(p=>p.depart);
    return departures.length>0 && Math.min(...departures)-now<=2*hour && (!trip.forecast||now-trip.forecast.at>=weatherCycle);
  }
  view(id) {
    const rows=this.db.prepare('SELECT payload FROM commute_trips ORDER BY updated DESC LIMIT 100').all().map(row=>JSON.parse(row.payload));
    const trip=id?this.get(id):null;
    const now=this.now(), settings=this.host.companion();
    const list=rows.map(({id,revision,goal,status})=>({id,revision,status,destination:goal.destination,arrival:goal.arrival}));
    if (!trip) return {list,trip};
    const busy=this.busy(),plans=listProposals(trip,now,busy);
    const {forecast, ...record} = trip;
    const card=settings.cards.find(row=>row.id===(settings.reminder==='task'?settings.task:settings.reminder));
    const allowed=activeTrip(trip)&&!settings.paused&&settings.mode!=='ask'&&!quietNow(settings,now)&&trip.goal.arrival>now;
    const picked=plans.find(plan=>plan.mode===trip.confirmed?.mode);
    const scheduleChange=Boolean(picked&&conflictKey(trip,trip.confirmed,busy)!==trip.confirmed.calendarImpact);
    let reminder=null;
    if(allowed&&scheduleChange)reminder={type:'change',message:'日历占用有变化，请重新核对并确认。'};
    else if(allowed&&trip.reconfirm)reminder={type:'change',message:trip.reconfirm};
    else if(allowed&&picked?.overdue)reminder={type:'change',message:'已过建议出发时间，请核对预计到达或选择替代路线。'};
    else if(allowed&&picked&&picked.depart<=now+10*minute)reminder={type:'depart',message:'临近出发，请核对交通和随身物品。'};
    return {list,trip:record,plans,scheduleChange,recommended:recommend(plans),weather:forecast?{at:forecast.at,location:forecast.location,source:forecast.source}:null,
      reminder,card:card?{style:card.style,address:card.address}:null,watchDue:this.watchDue(trip,now)};
  }
  save(body) {
    const now=this.now(), goal=tripGoal(body,now);
    const trip=body.id?this.get(body.id):{id:randomUUID(),revision:0,status:'open',routes:{},forecast:null,
      confirmed:null,reconfirm:'',incident:{rain:false,readyAt:null,blocked:[]},events:[]};
    if (trip.revision) checkTrip(trip,body);
    if (typeof body.watch!=='boolean') throw fault('请确认是否启用临近出发天气刷新。');
    const sameRoute=trip.goal&&['city','origin','destination','from','to'].every(key=>trip.goal[key]===goal[key]);
    const sameGoal=sameRoute&&['arrival','preferred','buffer'].every(key=>trip.goal[key]===goal[key]);
    const current=sameGoal?trip:invalidated(trip,'目标时间、地点或准备时间有变化，请重新确认。');
    return this.write({...current,goal,watch:body.watch,routes:sameRoute?trip.routes:{},
      forecast:trip.goal?.city===goal.city?trip.forecast:null,
      incident:sameRoute&&trip.goal.arrival===goal.arrival?trip.incident:{rain:false,readyAt:null,blocked:[]}},
    trip.revision?'已更新出行目标':'已建立通勤行程');
  }
  async weather(trip, body, signal) {
    const now=this.now();
    if (body.automatic===true&&!this.watchDue(trip,now)) return {id:trip.id,revision:trip.revision};
    if((this.attempts.get(trip.id)??0)>now)throw fault('天气刚刷新或暂不可用，请稍后重试。',429);
    if(trip.goal.arrival-now>7*24*hour||trip.goal.arrival<=now)throw fault('当前仅查询未来 7 天内的通勤预报。');
    this.attempts.set(trip.id,now+minute);
    for (const [id, until] of this.attempts) if(until<=now)this.attempts.delete(id);
    try {
      let forecast=this.cache.get(trip.goal.city);
      if (!forecast||now-forecast.at>=weatherCycle) {
        forecast=await fetchHourlyWeather(trip.goal.city,{fetchImpl:this.fetchImpl,now:()=>this.now(),signal});
        signal?.throwIfAborted();
        this.cache.delete(trip.goal.city);
        this.cache.set(trip.goal.city,forecast);
        if(this.cache.size>12)this.cache.delete(this.cache.keys().next().value);
      }
      if (trip.forecast?.at===forecast.at) return {id:trip.id,revision:trip.revision};
      const earliest=trip.goal.arrival-8*hour, until=trip.goal.arrival;
      const hours=forecast.hours.filter(row=>row.at>=hourAt(earliest)&&row.at<=hourAt(until));
      if(!hours.length)throw Error('WEATHER_DATE_UNSUPPORTED');
      let next={...trip,forecast:{...forecast,hours}};
      if(trip.confirmed) {
        const after=proposal(next,trip.confirmed.mode,now,[]);
        if(weatherImpact(after)!==trip.confirmed.weatherImpact)next=invalidated(next,'预报影响了原出发建议，请核对并重新确认。');
      }
      return this.write(next,'已刷新 Open-Meteo 通勤时段预报');
    } catch(error) {
      if(error.status)throw error;
      if(body.automatic===true)this.attempts.set(trip.id,now+weatherCycle);
      throw fault(weatherError(error), 503);
    }
  }
  transition(action, trip, body) {
    const now=this.now(), {mode}=body;
    if (action==='route') {
      if(!modeList.includes(mode)||!Object.hasOwn(sources,body.source))throw fault('请选择交通方式和耗时来源。');
      const entry={minutes:boundedInteger(body.minutes,'预计耗时',1,360,false),source:body.source,at:now};
      const next=trip.confirmed?.mode===mode?invalidated(trip,'已更新所选路线耗时，请重新确认。'):trip;
      return this.write({...next,routes:{...next.routes,[mode]:entry}},`已核对${states[mode]}约 ${entry.minutes} 分钟`);
    }
    if (action==='report') {
      if(!Object.hasOwn(reports,body.event))throw fault('请选择变化类型。');
      let incident={...trip.incident};
      if(body.event==='rain')incident.rain=true;
      if(body.event==='delay')incident.readyAt=Math.ceil(now/minute)*minute+boundedInteger(body.delay,'预计等待时间',1,180,false)*minute;
      if(body.event==='blocked'){
        if(!modeList.includes(mode))throw fault('请选择受阻的交通方式。');
        incident.blocked=[...new Set([...incident.blocked,mode])];
      }
      if(body.event==='clear')incident={rain:false,readyAt:null,blocked:[]};
      return this.write({...invalidated(trip,`${reports[body.event]}，请比较新方案并重新确认。`),incident},reports[body.event]);
    }
    if (action==='confirm') {
      if(!modeList.includes(mode)||trip.goal.arrival<=now)throw fault('请选择仍有效的通勤方案。',409);
      const busy=this.busy(),plan=proposal(trip,mode,now,busy);
      if(!plan.route||plan.blocked)throw fault('请先核对耗时并选择未受阻的方式。',409);
      if((plan.overdue||plan.conflicts.length||plan.avoid||plan.stale)&&body.acceptRisk!==true) {
        throw fault('该方案存在时段、天气或耗时风险，请重新核对后明确确认。',409);
      }
      const depart=Math.max(plan.depart,Math.ceil(now/minute)*minute,trip.incident.readyAt??0);
      if(depart>=trip.goal.arrival)throw fault('已无法在目标时间前出发，请先修改到达时间。',409);
      const confirmed={mode,depart,estimatedArrival:plan.estimatedArrival,weatherImpact:weatherImpact(plan),at:now};
      confirmed.calendarImpact=conflictKey(trip,confirmed,busy);
      return this.write({...trip,confirmed,reconfirm:''},`已确认${states[mode]}方案`);
    }
    if (action==='share' || action==='export') {
      const plan=trip.confirmed;
      if(!plan||trip.goal.arrival<=now)throw fault('请先确认有效的通勤方案。',409);
      if(conflictKey(trip,plan,this.busy())!==plan.calendarImpact) throw fault('日历占用有变化，请先重新确认。',409);
      const title=`前往${trip.goal.destination}`;
      if (action==='export') return {content:lifeCalendar({id:trip.id,title,revision:trip.revision,place:trip.goal.destination,
        start:plan.depart,duration:Math.max(1,Math.ceil((Math.max(trip.goal.arrival,plan.estimatedArrival)-plan.depart)/minute)),
        reminder:plan.depart-10*minute,status:'open'},now)};
      const recipient=label(body.recipient,64,'分享对象');
      const content=text(body.content,360,'分享正文',true);
      if(body.confirmed!==true)throw fault('请核对分享对象与正文后确认。');
      return {recipient,content};
    }
    if (action==='archive') return this.write({...trip,status:'archived',watch:false},'已归档行程');
    throw fault('找不到该通勤操作。',404);
  }

  async dispatch(body, signal) {
    const action=body.action.slice('commute-'.length);
    if(action==='save')return this.save(body);
    const trip=this.get(body.id);
    if(action==='delete'){
      if(trip.status!=='archived'||trip.revision!==body.revision||body.confirmed!==true) throw fault('请先归档并确认删除这条行程。',409);
      if(!this.db.prepare('DELETE FROM commute_trips WHERE id=? AND revision=?').run(trip.id,trip.revision).changes)throw fault('行程已更新，请先同步。',409);
      this.attempts.delete(trip.id);
      return {id:'',revision:0};
    }
    checkTrip(trip,body);
    if(action==='weather')return this.weather(trip,body,signal);
    return this.transition(action,trip,body);
  }
}
