import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DinnerService } from '../packages/jingyu/dinner/service.mjs';
import { DinnerGateway } from '../packages/jingyu/dinner/gateway.mjs';
import { agendaDraft, firstGap, noticeDraft } from '../packages/jingyu/life.mjs';
import { beijingTime, parseCalendar } from '../packages/jingyu/life-calendar.mjs';

const at = beijingTime('2026-11-16T17:30');
const minute = 60_000;
const draft = { action:'life-save', title:'取教材',kind:'parcel',place:'图书馆',start:'2026-11-16T18:00',
  deadline:'2026-11-16T20:00',reminder:'2026-11-16T17:30',duration:20 };
const calendar = ['BEGIN:VCALENDAR','VERSION:2.0',
  'BEGIN:VEVENT','DTSTART:20261116T100000Z','DTEND:20261116T103000Z','SUMMARY:会议',
  '室','END:VEVENT',
  'BEGIN:VEVENT','DTSTART;TZID=Asia/Shanghai:20261117T080000','DTEND;TZID=Asia/Shanghai:20261117T090000','END:VEVENT',
  'BEGIN:VEVENT','DTSTART;VALUE=DATE:20261118','SUMMARY:全天占用','END:VEVENT',
  'BEGIN:VEVENT','DTSTART:20261116T230000','DTEND:20261117T000000','RRULE:FREQ=DAILY','END:VEVENT',
  'BEGIN:VEVENT','DTSTART;TZID=America/New_York:20261118T080000','DTEND;TZID=America/New_York:20261118T090000','END:VEVENT',
  'BEGIN:VEVENT','DTSTART:20261116T193000','DTEND:20261116T203000','TRANSP:TRANSPARENT','END:VEVENT','END:VCALENDAR',
].map(line => line==='室' ? ' '+line : line).join('\r\n');

function fixture(t, options = {}) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent,'jingyu-life-test-'));
  let now = at;
  const host = new DinnerService(root, { now:()=>now, ...options });
  const clean = [];
  t.after(async()=>{
    for (const close of clean.reverse()) await close();
    host.close();
    const target = fs.realpathSync(root);
    if (path.dirname(target)===parent && path.basename(target).startsWith('jingyu-life-test-')) fs.rmSync(target,{recursive:true,force:true});
  });
  return { host, root, clean, advance: minutes=>now+=minutes*minute,
    send:(action,args={})=>host.dispatch({action:'life-'+action,...args}), view:id=>host.life.view(id) };
}

test('notification extraction separates place and material from ambiguous date/time', () => {
  const source = '快递请在明天下午4点之前领取，地址：南门驿站，请携带校园卡。';
  assert.deepEqual(noticeDraft(source,at).draft,{
    kind:'parcel',title:'领取快递',place:'南门驿站',items:'校园卡',start:'',deadline:'2026-11-17T16:00',uncertain:false,duration:15,reminder:'',
  });
  assert.equal(noticeDraft('预约 2026-11-18T16:00，地点：实验室。',at).draft.start,'2026-11-18T16:00');
  assert.equal(noticeDraft('11 月 18 日下午 4 : 00 预约',at).draft.start,'2026-11-18T16:00');
  assert.equal(noticeDraft('预约明天9:00或后天9:00',at).draft.uncertain,true);
  assert.equal(noticeDraft('归还图书',at).draft.kind,'return');
  assert.equal(noticeDraft('缴费提醒',at).draft.kind,'bill');
  assert.equal(noticeDraft('明天26:00缴费',at).draft.uncertain,true);
  assert.throws(()=>agendaDraft({...draft,start:'2026-02-30T18:30'}),/有效/);
  assert.throws(()=>agendaDraft({...draft,deadline:'2026-11-16T18:05'}),/晚于截止/);
});

test('calendar normalization, all-day occupancy, and imported conflict checks are transactional', async t => {
  const { view, send, host } = fixture(t);
  const parsed = parseCalendar(calendar);
  assert.deepEqual(parsed.events[0],{start:beijingTime(draft.start),end:beijingTime('2026-11-16T18:30'),title:'会议室'});
  assert.equal(parsed.events[2].end - parsed.events[2].start,1440*minute);
  assert.equal(parsed.skipped,2);
  assert.deepEqual(await send('calendar-import',{content:calendar}),{count:3,skipped:2});
  await assert.rejects(send('save', draft), /会议室/);
  assert.equal(view().tasks.length,0);
  await assert.rejects(send('calendar-import',{content:'INVALID'}), /有效/);
  assert.equal(view().calendar.events.length,3);
  const created = await send('save',{...draft,acceptConflict:true,source:'notice',sourceText:'合成通知只用来测试'});
  assert.equal(view().tasks[0].sourceText,undefined);
  assert.equal(view(created.id).selected.sourceText,'合成通知只用来测试');
  await send('calendar-clear');
  const next = await send('save',{...draft,...created,start:'2026-11-16T18:30'});
  assert.equal(view(next.id).selected.revision,2);
  await assert.rejects(send('save',{...draft,...created}), /已更新/);
  await assert.rejects(send('save',{...draft,start:'2026-11-16T18:25'}), /取教材/);
  assert.equal(host.view().tasks.length,0);
  const exported = await send('export',next);
  assert.match(exported.content,/DTSTART:20261116T103000Z/);
  assert.match(exported.content,/TRIGGER:-PT60M/);
  for (const line of exported.content.split('\r\n')) assert(Buffer.byteLength(line)<=75);
  assert.equal(parseCalendar(exported.content).events[0].start,beijingTime('2026-11-16T18:30'));
  await send('delete-source',{...next,confirmed:true});
  assert.equal(view(next.id).selected.sourceText,'');
  assert.equal(view(next.id).selected.status,'open');
});

test('reminders respect quiet mode, snooze, pause and read while a task remains editable', async t => {
  const { view, send, host, advance } = fixture(t);
  const record = await send('save',draft);
  assert.equal(view().due[0].id,record.id);
  const defaults = host.companion();
  host.saveSetting('companion',{...defaults,quietStart:'17:00',quietEnd:'18:15'});
  assert.equal(view().due.length,0);
  host.saveSetting('companion',{...defaults,paused:true});
  assert.equal(view().due.length,0);
  host.saveSetting('companion',{...defaults,mode:'ask'});
  assert.equal(view().due.length,0);
  host.saveSetting('companion',defaults);
  const paused = await send('reminder',{...record,operation:'pause'});
  assert.equal(view().due.length,0);
  const revived = await send('reminder',{...paused,operation:'resume'});
  advance(40);
  const delayed = await send('reminder',{...revived,operation:'snooze'});
  assert.equal(view().due.length,0);
  assert.match((await send('export',delayed)).content,/TRIGGER:PT25M/);
  const changed = await send('save',{...draft,...delayed,title:'取资料',reminder:'2026-11-16T18:25'});
  advance(15);
  assert.equal(view().due[0].title,'取资料');
  const read = await send('reminder',{...changed,operation:'read'});
  assert.equal(view().due.length,0);
  assert.doesNotMatch((await send('export',read)).content,/VALARM/);
});

test('check-in prioritizes small near-deadline work, uses rest feedback, and groups same-place errands', async t => {
  const { view, send, advance } = fixture(t);
  const rest=await send('save',{...draft,kind:'rest',title:'休息',place:''});
  await send('complete',{...rest,helpful:true,minutes:8,note:'合成反馈'});
  const pending=await send('save',{...draft,start:'',reminder:'',duration:10,deadline:'2026-11-16T18:10'});
  const other=await send('save',{...draft,title:'还书',start:'',reminder:'',place:'图 书 馆'});
  assert.deepEqual(view().bundles[0].titles,['取教材','还书']);
  assert.equal(view().bundles[0].start,at);
  await send('checkin',{energy:'low',pressure:'high',available:10});
  assert.deepEqual(view().suggestions.map(row=>row.kind),['rest','parcel']);
  assert.equal(view().suggestions[0].duration,8);
  assert.equal(view().suggestions[1].id,pending.id);
  advance(11);
  assert.equal(view().suggestions.length,0);
  advance(480);
  assert.equal(view().checkin,null);
  assert.equal(firstGap(at,5,[{start:at,end:at+2*minute}],at+7*minute),at+2*minute);
  const cancelled=await send('cancel',other);
  await assert.rejects(send('delete',cancelled),/确认删除/);
  await send('delete',{...cancelled,confirmed:true});
  assert.throws(()=>view(other.id),/找不到/);
});

test('selected notification raw text is optional and model reads are explicit', async t => {
  const { host, send, view } = fixture(t);
  let calls=0;
  host.planner.json=async(prompt, body)=>{
    calls++;
    assert.match(prompt,/资料/);
    assert.match(body,/预约/);
    return {data:{ title:'核对预约', place:'南楼', start:'2099-01-01T20:00' }};
  };
  const text = '预约明天16:00';
  assert.equal((await send('preview',{text})).method,'local');
  assert.equal(calls,0);
  const result = await send('preview',{text,model:true});
  assert.equal(result.method,'deepseek');
  assert.equal(result.draft.start,'2026-11-17T16:00');
  assert.equal(result.draft.title,'核对预约');
  assert.equal(calls,1);
  assert.equal(view().tasks.length,0);
  const saved = await send('save',{...result.draft,source:'screenshot'});
  assert.equal(view(saved.id).selected.sourceText,'');
  await assert.rejects(host.life.ocr({image:'garbage'}),/Windows OCR|截图格式/);
});

test('bundle scheduling is atomic, preserves separate feedback and supports a quiet daily recap', async t => {
  const { view, send, host } = fixture(t);
  const first=await send('save',{...draft,start:'',reminder:''});
  const second=await send('save',{...draft,title:'领取预约单',start:'',reminder:''});
  const spec={start:'2026-11-16T17:30',members:view().bundles[0].members};
  const current=await send('save',{...draft,...second,title:'领预约单',start:'',reminder:''});
  await assert.rejects(send('schedule-bundle',spec),/已变更/);
  assert.equal(view(first.id).selected.start,null);
  const spec2={...spec,members:[first,current]};
  assert.deepEqual(await send('schedule-bundle',spec2),{count:2});
  assert.equal(view(first.id).selected.start,at);
  assert.equal(view(second.id).selected.start,at+20*minute);
  assert.match(view(second.id).selected.events.at(-1).note,/连续安排/);
  await send('complete',{id:first.id,revision:2,helpful:true,minutes:18});
  host.saveSetting('companion',{...host.companion(),mode:'daily'});
  assert.deepEqual(view().recap,[{title:'取教材',minutes:18}]);
  host.saveSetting('companion',{...host.companion(),quietStart:'17:00',quietEnd:'18:00'});
  assert.equal(view().recap.length,0);
});

test('Bilibili suggestions and comments use fixed read-only operations', async t => {
  const bvid='BV1xx411c7mD';
  const mocked={
    '/x/web-interface/popular':{list:[{ bvid,title:'样例视频' }]},
    '/x/web-interface/view':{bvid,aid:101,title:'样例视频'},
    '/x/v2/reply':{replies:[{rpid:1,content:{message:'样例评论'}}]},
  };
  const { send }=fixture(t,{fetchImpl:async input=>{
    const url=new URL(input);
    assert.equal(url.hostname,'api.bilibili.com');
    assert(mocked[url.pathname]);
    return new Response(JSON.stringify({code:0,data:mocked[url.pathname]}));
  }});
  assert.equal((await send('bili-popular')).items[0].bvid,bvid);
  assert.match(JSON.stringify(await send('bili-comments',{video:bvid})),/样例评论/);
});

test('paired phone and desktop share tasks, original text is opt-in, revocation protects routes', async t => {
  const { host, clean, view, send } = fixture(t);
  const gateway = new DinnerGateway(host,path.resolve(import.meta.dirname,'../public/console'), { loopback:true });
  clean.push(()=>gateway.close());
  const { url, code } = await gateway.start('127.0.0.1');
  const get=(part,token)=>fetch(url+part,{headers:token?{Authorization:'Bearer '+token}:{}});
  const post=(part,data,token)=>fetch(url+part,{
    method:'POST',headers:{Origin:url,'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(data),
  });
  assert.equal((await get('/api/dinner?view=life')).status,401);
  assert.equal((await post('/api/dinner/ocr',{image:'abc'})).status,401);
  const { token } = await (await post('/api/dinner/pair',{code})).json();
  const response = await post('/api/dinner',draft,token);
  assert.equal(response.status,200);
  const record = await response.json();
  assert.equal(view(record.id).selected.title,'取教材');
  await send('save',{...draft,...record,start:'2026-11-16T19:00'});
  const synced = await (await get('/api/dinner?view=life&id='+record.id,token)).json();
  assert.equal(synced.selected.revision,2);
  const stale = await post('/api/dinner',{...draft,...record},token);
  assert.equal(stale.status,409);
  assert.equal((await post('/api/dinner/unpair',{},token)).status,200);
  assert.equal((await get('/api/dinner?view=life',token)).status,401);
});
