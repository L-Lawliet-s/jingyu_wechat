import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DinnerService } from '../packages/jingyu/dinner/service.mjs';
import { DinnerGateway } from '../packages/jingyu/dinner/gateway.mjs';
import { beijingTime, parseCalendar } from '../packages/jingyu/life-calendar.mjs';
import { fetchHourlyWeather } from '../packages/dsh-social-bridge-plugin/weather-source.mjs';

const minute=60_000;
const now=beijingTime('2026-11-16T17:30');
const goals={city:'北京',origin:'测试大学东门',destination:'测试图书馆',arrival:'2026-11-16T19:00',buffer:10,preferred:'walk',watch:false};
const place={id:1816670,name:'北京',feature_code:'PPLC',latitude:39.9075,longitude:116.39723,timezone:'Asia/Shanghai',country_code:'CN',country:'中国'};
function forecast(code,options={}) {
  const time=['2026-11-16T17:00','2026-11-16T18:00','2026-11-16T19:00'];
  const values=Array(time.length).fill(code);
  return {utc_offset_seconds:28800,hourly_units:{temperature_2m:'°C',precipitation_probability:'%',precipitation:'mm',wind_gusts_10m:'km/h'},
    hourly:{time,weather_code:values,temperature_2m:[14,13,12],precipitation_probability:values.map(v=>v?85:10),
      precipitation:values.map(v=>v?2:0),wind_gusts_10m:[12,14,17],...options}};
}
function fixture(t, fetchImpl) {
  const temp=fs.realpathSync(os.tmpdir());
  const root=fs.mkdtempSync(path.join(temp,'jingyu-commute-test-'));
  let time=now;
  const options={now:()=>time,fetchImpl};
  const service=new DinnerService(root,options);
  const cleanup=[];
  t.after(async()=>{
    for (const stop of cleanup.reverse()) await stop();
    service.close();
    const target=fs.realpathSync(root);
    if(path.dirname(target)===temp&&path.basename(target).startsWith('jingyu-commute-test-')) fs.rmSync(target,{recursive:true,force:true});
  });
  return {service,root,options,cleanup,advance:n=>time+=n*minute,
    send:(action,fields={})=>service.dispatch({action:'commute-'+action,...fields}),view:id=>service.commute.view(id)};
}
function selected(view,trip,mode) { return view(trip.id).plans.find(plan=>plan.mode===mode); }

test('no-key named routes use official web pages; optional high precision coordinates open AMap', async t=>{
  const {send,view}=fixture(t);
  const initial=await send('save',goals);
  const walk=new URL(selected(view,initial,'walk').map.url);
  assert.equal(walk.origin,'https://api.map.baidu.com');
  assert.equal(walk.pathname,'/direction');
  assert.equal(walk.searchParams.get('origin'),goals.origin);
  assert.equal(walk.searchParams.get('destination'),goals.destination);
  assert.equal(walk.searchParams.get('mode'),'walking');
  assert.equal(new URL(selected(view,initial,'bus').map.url).searchParams.get('mode'),'transit');
  assert.equal(selected(view,initial,'bike').map.url,'https://www.amap.com/');
  await assert.rejects(send('save',{...goals,from:'116.320114,39.992991'}),/同时留空/);
  await assert.rejects(send('save',{...goals,arrival:'2026-11-16T16:00'}),/未来/);
  const route=await send('save',{...goals,...initial,from:'116.32736,40.00829',to:'116.31018,39.99187'});
  const cycle=new URL(selected(view,route,'bike').map.url);
  assert.equal(cycle.origin,'https://uri.amap.com');
  assert.equal(cycle.searchParams.get('mode'),'ride');
  assert.equal(cycle.searchParams.get('from'),'116.32736,40.00829');
  assert.equal(cycle.searchParams.get('callnative'),'1');
});

test('weather uses verified hourly units, city-only lookup, and refresh invalidates weather-sensitive confirmation', async t=>{
  let weatherCode=0, calls=[];
  const fetchImpl=async input=>{
    const url=new URL(input);
    calls.push(url);
    if(url.hostname.startsWith('geocoding')){
      assert.equal(url.searchParams.get('name'),'北京');
      assert.equal(url.searchParams.get('countryCode'),'CN');
      return Response.json({results:[place]});
    }
    assert.equal(url.hostname,'api.open-meteo.com');
    assert.equal(url.searchParams.get('timezone'),'Asia/Shanghai');
    assert.match(url.searchParams.get('hourly'),/wind_gusts/);
    return Response.json(forecast(weatherCode));
  };
  const {send,view,advance}=fixture(t,fetchImpl);
  let trip=await send('save',{...goals,watch:true});
  trip=await send('route',{...trip,mode:'walk',minutes:30,source:'map'});
  trip=await send('route',{...trip,mode:'bus',minutes:35,source:'map'});
  assert.equal(calls.length,0);
  assert.equal(view(trip.id).watchDue,true);
  trip=await send('weather',{...trip,automatic:true});
  assert.equal(calls.length,2);
  assert.equal(view(trip.id).weather.location,'中国 / 北京');
  assert.equal(selected(view,trip,'walk').depart,beijingTime('2026-11-16T18:20'));
  assert.equal(view(trip.id).watchDue,false);
  trip=await send('confirm',{...trip,mode:'walk'});
  weatherCode=95;
  advance(16);
  trip=await send('weather',{...trip,automatic:true});
  assert.equal(view(trip.id).trip.confirmed,null);
  assert.match(view(trip.id).trip.reconfirm,/预报影响/);
  assert.equal(view(trip.id).recommended,'bus');
  assert.equal(selected(view,trip,'walk').extra,15);
  await assert.rejects(send('confirm',{...trip,mode:'walk'}),/风险/);
  const confirmed=await send('confirm',{...trip,mode:'bus'});
  assert.equal(view(confirmed.id).trip.confirmed.mode,'bus');
});

test('network and schema errors preserve plan and show unknown conditions', async t=>{
  const controller=new AbortController();
  const {send,view,service}=fixture(t,async input=>{
    const url=new URL(input);
    return url.hostname.startsWith('geocoding')?Response.json({results:[place]}):Response.json({utc_offset_seconds:0});
  });
  let trip=await send('save',goals);
  trip=await send('route',{...trip,mode:'walk',minutes:30,source:'personal'});
  assert.deepEqual(await send('weather',{...trip,automatic:true}),trip);
  await assert.rejects(send('weather',trip),/未获取到有效天气/);
  assert.equal(selected(view,trip,'walk').weather.level,'unknown');
  assert.equal(view(trip.id).trip.revision,trip.revision);
  controller.abort();
  await assert.rejects(fetchHourlyWeather('北京',{signal:controller.signal,fetchImpl:async(_url,options)=>options.signal.throwIfAborted()}),/aborted/i);
  trip=await send('confirm',{...trip,mode:'walk'});
  assert.equal(service.commute.get(trip.id).confirmed.mode,'walk');
});

test('manual rain, late departure, and route disruption invalidate and compare viable alternatives', async t=>{
  const {send,view,advance}=fixture(t);
  let trip=await send('save',goals);
  trip=await send('route',{...trip,mode:'walk',minutes:30,source:'map'});
  trip=await send('route',{...trip,mode:'bus',minutes:25,source:'map'});
  trip=await send('confirm',{...trip,mode:'walk'});
  trip=await send('report',{...trip,event:'rain'});
  assert.equal(view(trip.id).recommended,'bus');
  assert.equal(selected(view,trip,'walk').extra,10);
  await assert.rejects(send('share',{...trip,confirmed:true,recipient:'同学',content:'测试'}),/有效/);
  trip=await send('confirm',{...trip,mode:'bus'});
  trip=await send('report',{...trip,event:'blocked',mode:'bus'});
  assert.equal(view(trip.id).recommended,'walk');
  await assert.rejects(send('confirm',{...trip,mode:'bus',acceptRisk:true}),/未受阻/);
  advance(30);
  trip=await send('report',{...trip,event:'delay',delay:40});
  const plan=selected(view,trip,'walk');
  assert.equal(plan.overdue,true);
  assert.equal(plan.estimatedArrival, beijingTime('2026-11-16T19:20'));
  await assert.rejects(send('confirm',{...trip,mode:'walk'}),/风险/);
  trip=await send('confirm',{...trip,mode:'walk',acceptRisk:true});
  assert.equal(view(trip.id).trip.confirmed.depart,beijingTime('2026-11-16T18:40'));
  const changed=await send('save',{...goals,...trip,arrival:'2026-11-16T20:00'});
  assert.equal(view(changed.id).trip.confirmed,null);
  assert.equal(view(changed.id).trip.incident.readyAt,null);
});

test('calendar conflict requires a new confirmation; share checks recipient and export uses real interval', async t=>{
  const {send,view,service}=fixture(t);
  let trip=await send('save',goals);
  trip=await send('route',{...trip,mode:'bus',minutes:25,source:'map'});
  trip=await send('confirm',{...trip,mode:'bus'});
  await service.dispatch({action:'life-save',title:'会议',kind:'appointment',place:'教室',items:'',
    start:'2026-11-16T18:30',duration:10});
  assert.equal(view(trip.id).scheduleChange,true);
  await assert.rejects(send('export',trip),/日历/);
  assert.equal(selected(view,trip,'bus').conflicts[0].title,'会议');
  await assert.rejects(send('confirm',{...trip,mode:'bus'}),/风险/);
  trip=await send('confirm',{...trip,mode:'bus',acceptRisk:true});
  await assert.rejects(send('share',{...trip,recipient:'同学',content:'稍后到。'}),/核对分享/);
  await assert.rejects(send('share',{...trip,recipient:'同学\n请代发',content:'稍后到。',confirmed:true}),/一行/);
  assert.deepEqual(await send('share',{...trip,recipient:'同学',content:'稍后到。',confirmed:true}),{recipient:'同学',content:'稍后到。'});
  const exported=await send('export',trip);
  assert.match(exported.content,/TRIGGER:-PT10M/);
  assert.equal(parseCalendar(exported.content).events[0].start,beijingTime('2026-11-16T18:25'));
});

test('reminders respect companion settings; archived trips are persisted and deletable', async t=>{
  const {send,view,service,root,options,advance}=fixture(t);
  let trip=await send('save',goals);
  trip=await send('route',{...trip,mode:'bus',minutes:25,source:'personal'});
  trip=await send('confirm',{...trip,mode:'bus'});
  assert.equal(view(trip.id).reminder,null);
  advance(50);
  assert.equal(view(trip.id).reminder.type,'depart');
  const settings=service.companion();
  service.saveSetting('companion',{...settings,quietStart:'18:00',quietEnd:'19:50'});
  assert.equal(view(trip.id).reminder,null);
  const other=new DinnerService(root,options);
  try { assert.equal(other.commute.view(trip.id).trip.confirmed.mode,'bus'); }
  finally {other.close();}
  await assert.rejects(send('delete',{...trip,confirmed:true}),/归档/);
  let archived=await send('archive',trip);
  assert.equal(view(archived.id).trip.status,'archived');
  assert.equal(view(archived.id).watchDue,false);
  await send('delete',{...archived,confirmed:true});
  assert.equal(view().list.length,0);
});

test('authenticated phone and desktop share one commute and stale copies cannot commit', async t=>{
  const {service,view,send,cleanup}=fixture(t);
  const gateway=new DinnerGateway(service,path.resolve(import.meta.dirname,'../public/console'),{loopback:true});
  cleanup.push(()=>gateway.close());
  const {url,code}=await gateway.start('127.0.0.1');
  const post=(route,data,token)=>fetch(url+route,{method:'POST',headers:{Origin:url,'Content-Type':'application/json',
    ...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data)});
  assert.equal((await fetch(url+'/api/dinner?view=commute')).status,401);
  const {token}=await (await post('/api/dinner/pair',{code})).json();
  const unit=await post('/api/dinner',{action:'commute-save',...goals},token);
  assert.equal(unit.status,200);
  const trip=await unit.json();
  assert.equal(view(trip.id).trip.goal.origin,goals.origin);
  await send('route',{...trip,mode:'bus',minutes:26,source:'map'});
  const stale=await post('/api/dinner',{action:'commute-confirm',...trip,mode:'bus'},token);
  assert.equal(stale.status,409);
  const synced=await fetch(url+'/api/dinner?view=commute&id='+trip.id,{headers:{Authorization:'Bearer '+token}});
  assert.equal((await synced.json()).trip.revision,trip.revision+1);
  await post('/api/dinner/unpair',{},token);
  assert.equal((await post('/api/dinner',{action:'commute-weather',...trip},token)).status,401);
});
