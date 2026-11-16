import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { JingyuStore, actorChat } from '../packages/jingyu/store.mjs';
import { TripService, parseTripMessage } from '../packages/jingyu/trip.mjs';
import { intakeConstraints } from '../packages/jingyu/trip-rules.mjs';
import { beijingTime } from '../packages/jingyu/life-calendar.mjs';
import { handleTripMessage } from '../packages/jingyu/trip-chat.mjs';

const account='a'.repeat(64), owner='trip-owner', ann='trip-member-ann', bob='trip-member-bob';
const now=beijingTime('2026-11-16T18:00');
const plan={title:'市博物馆',place:'东门',start:'2026-11-21T10:00',end:'2026-11-21T14:00',kind:'indoor',source:'verified',per:'78.10',shared:'30.01'};
function fixture(t) {
  const parent=fs.realpathSync(os.tmpdir()), root=fs.mkdtempSync(path.join(parent,'jingyu-trip-test-'));
  const store=new JingyuStore(root,account);
  store.saveSettings({ownerWxid:owner,sharedMemoryEnabled:true,allowGroupShared:false});
  const service=new TripService(store,{now:()=>now});
  t.after(()=>{
    store.close();
    const target=fs.realpathSync(root);
    if(path.dirname(target)===parent&&path.basename(target).startsWith('jingyu-trip-test-'))fs.rmSync(target,{recursive:true,force:true});
  });
  let index=0;
  const say=(actor,line,receipt=String(++index))=>service.chat(parseTripMessage(line),{actor,chat:actorChat(actor),name:'同名',receipt});
  const start=()=>service.desktop({action:'create',title:'周末出游'}).code;
  const send=(code,actor,line)=>say(actor,'出游 '+code+' '+line);
  const edit=(code,action,body={})=>service.desktop({action,code,revision:service.view(code).trip.revision,...body});
  return {root,store,service,start,say,send,edit};
}

test('common Chinese availability includes weekends; ambiguous times and budgets need clarification',()=>{
  assert.deepEqual(intakeConstraints('周六上午十点到下午四点有空，人均预算200元，偏好室内看展',now),{
    start:beijingTime('2026-11-21T10:00'),end:beijingTime('2026-11-21T16:00'),budget:20000,preference:'室内看展',tag:'indoor',
  });
  assert.deepEqual(intakeConstraints('预算80.5元',now),{budget:8050});
  assert.equal(intakeConstraints('周六全天',now).end,beijingTime('2026-11-22T00:00'));
  assert.equal(intakeConstraints('周六到周日全天',now).end,beijingTime('2026-11-23T00:00'));
  assert.equal(intakeConstraints('周六上午10点到周日下午4点',now).end,beijingTime('2026-11-22T16:00'));
  assert.equal(intakeConstraints('下周六下午2点到4点',now).start,beijingTime('2026-11-28T14:00'));
  assert.throws(()=>intakeConstraints('周六和周日全天',now),/一个/);
  assert.throws(()=>intakeConstraints('周六上午有空',now),/时间/);
  assert.throws(()=>intakeConstraints('总预算200元',now),/人均/);
  assert.throws(()=>intakeConstraints('预算200～300元',now),/人均/);
});

test('drafts, independent confirmation, budget split and participant visibility are isolated',t=>{
  const {start,send,edit,service}=fixture(t);
  const code=start(), say=(actor,line)=>send(code,actor,line);
  assert.throws(()=>say(ann,'查看'),/加入/);
  say(ann,'加入');say(bob,'加入');
  say(ann,'周六10:00到16:00，预算120元，偏好室内');
  say(bob,'周六9:00到18:00，预算333元，偏好户外');
  assert.match(say(ann,'我的'),/120.00/);
  assert.doesNotMatch(say(owner,'汇总'),/120.00|333.00/);
  assert.doesNotMatch(JSON.stringify(service.view(code)),/33300|12000/);
  say(ann,'预算110元');
  assert.throws(()=>say(ann,'确认 1'),/过期/);
  say(ann,'确认 2');say(bob,'确认 1');
  assert.match(say(owner,'汇总'),/110.00/);
  assert.match(say(owner,'汇总'),/333.00/);
  assert.doesNotMatch(say(bob,'我的'),/110.00/);
  assert.throws(()=>say(bob,'发布 1 V12'),/可以发时间/);
  edit(code,'candidate',plan);
  const selected=service.view(code).candidates[0];
  assert.equal(service.view(code).bounds.per,11000);
  assert.equal(service.view(code).bounds.earliest,beijingTime('2026-11-21T10:00'));
  assert.equal(service.view(code).bounds.latest,beijingTime('2026-11-21T16:00'));
  assert.deepEqual([selected.total,selected.individual,selected.people,selected.hits],[26431,8811,3,1]);
  assert.throws(()=>edit(code,'publish',{id:1}),/待确认/);
  edit(code,'publish',{id:1,acceptGaps:true});
  assert.match(say(bob,'查看'),/市博物馆/);
  assert.doesNotMatch(say(bob,'查看'),/110.00|333.00|同名/);
  assert.match(edit(code,'export').content,/TRIGGER:-PT30M/);
  say(ann,'退出');
  assert.match(say(bob,'查看'),/重新核对/);
  assert(!JSON.stringify(service.view(code)).includes('11000'));
  assert.throws(()=>say(ann,'查看'),/加入/);
});

test('owner can create, compare and publish in chat; revision, weather and booking changes gate publishing',t=>{
  const {say,send,edit,service}=fixture(t);
  assert.throws(()=>say(ann,'出游新建 不允许'),/只有绑定/);
  const reply=say(owner,'出游新建 周末看展','source-1');
  assert.equal(say(owner,'出游新建 周末看展','source-1'),null);
  const code=/出游 ([0-9A-F]{8}) 加入/.exec(reply)[1];
  const chat=line=>send(code,owner,line);
  chat('周六全天，预算150元，偏好室内');chat('确认 1');
  chat('方案 户外步道｜步道入口｜2026-11-21 10:00｜2026-11-21 12:00｜10｜0｜户外');
  edit(code,'candidate',plan);
  const version=chat('汇总').match(/发布 (\d+) V(\d+)/)[0];
  chat(version);
  assert.equal(service.view(code).trip.published,2);
  edit(code,'change',{type:'rain'});
  assert.throws(()=>chat(version),/更新/);
  assert.throws(()=>edit(code,'publish',{id:1}),/已知冲突/);
  edit(code,'publish',{id:2});
  edit(code,'change',{type:'booking',id:2});
  assert.equal(service.view(code).trip.published,null);
  assert.match(service.view(code).candidates.find(row=>row.id===1).conflicts.join(','),/雨雪/);
  assert.match(service.view(code).candidates.find(row=>row.id===2).conflicts.join(','),/预约/);
  chat('修改方案 2｜新展厅｜另一处入口｜2026-11-21 10:00｜2026-11-21 12:00｜50｜0｜室内');
  assert.equal(service.view(code).candidates.find(row=>row.id===2).title,'新展厅');
});

test('task claims, completion, feedback and deletion use the right participant',t=>{
  const {start,send,edit,service}=fixture(t);
  const code=start(), say=(actor,line)=>send(code,actor,line);
  say(ann,'加入');say(bob,'加入');
  edit(code,'candidate',plan);
  edit(code,'task',{title:'核对开放时间'});
  edit(code,'publish',{id:1,acceptGaps:true});
  assert.match(say(ann,'认领 1'),/开放时间/);
  assert.throws(()=>say(bob,'完成 1'),/已认领/);
  assert.match(say(ann,'完成 1'),/完成/);
  assert.match(say(bob,'查看'),/已完成/);
  say(bob,'反馈 下次再早一点');
  assert(service.view(code).trip.members.some(row=>row.feedback==='下次再早一点'));
  say(bob,'清除');
  assert(!JSON.stringify(service.view(code)).includes('下次再早一点'));
  edit(code,'close',{confirmed:true});
  assert.throws(()=>say(ann,'查看'),/结束/);
  edit(code,'delete',{confirmed:true});
  assert.equal(service.view().list.length,0);
});

test('WeChat route requires verified private sender, current account and new event',async t=>{
  const {start,service}=fixture(t);
  const outgoing=[],code=start(),id=actorChat(ann).split(':').at(-1);
  let permitted=true,current=true;
  const base={platform:'wechat',kind:'private',message_type:'text',timestamp:now/1000,sender_name:'主人',sender_id:id,
    conversation_id:id,sender_wxid:ann,message_id:'1',text:'出游 '+code+' 加入'};
  const run=fields=>handleTripMessage({...base,...fields},{account,now:()=>now,allowed:()=>permitted,current:()=>current,
    service:()=>service,send:async packet=>outgoing.push(packet)});
  assert.equal(await run({text:'我在写论文'}),false);
  assert.equal(await run({kind:'group'}),false);
  assert.equal(await run({quoteReply:{}}),false);
  assert.equal(await run({sender_wxid:owner}),true);
  assert.equal(await run({timestamp:now/1000-500}),true);
  permitted=false;assert.equal(await run({}),true);permitted=true;
  current=false;assert.equal(await run({}),true);current=true;
  assert.equal(outgoing.length,0);
  await run({});await run({});
  assert.equal(outgoing.length,1);
  assert.equal(outgoing[0].target,id);
  assert.match(outgoing[0].deliveryId,/^[a-f0-9]{64}$/);
  assert.doesNotMatch(outgoing[0].text,/^主人/);
});

test('activities are separated by login and bound owner',t=>{
  const {root,start,store,service,send}=fixture(t);
  const code=start(), other=new JingyuStore(root,'b'.repeat(64));
  try{
    other.saveSettings({ownerWxid:owner,sharedMemoryEnabled:true,allowGroupShared:false});
    assert.throws(()=>new TripService(other).view(code),/不可用/);
  }finally{other.close();}
  store.saveSettings({ownerWxid:ann,sharedMemoryEnabled:true,allowGroupShared:false});
  assert.equal(service.view().list.length,0);
  assert.throws(()=>send(code,owner,'查看'),/不可用/);
});
