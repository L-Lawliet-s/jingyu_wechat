import { test } from 'node:test';
import assert from 'node:assert/strict';
import { actorChat } from '../packages/jingyu/store.mjs';
import { WeChatMediaSession, newMediaReceipts } from '../packages/jingyu/wechat-media.mjs';

const actor='wxid_test_peer', own='wxid_test_whale', name='测试接收人', chat=actorChat(actor);
const at=Date.parse('2026-11-16T21:55:00+08:00');
const type=62*2**32+49;
const row=(localId,extras={})=>({localId,serverId:'900000000000000000',localType:34,isSend:true,createTime:at/1000,...extras});
const pat=(from,to)=>`<msg><appmsg><type>62</type><patinfo><fromusername>${from}</fromusername><pattedusername>${to}</pattedusername></patinfo></appmsg></msg>`;
const flush=()=>new Promise(resolve=>setImmediate(resolve));

function fixture(options={}) {
  let now=at, account=true, rows=[], ambiguous=false, known=true, routeReady=true;
  const played=[],say=[];
  const audio={sample:async(_voice,text)=>{say.push(text);return {audio:'UklGRg==',mime:'audio/wav'};}};
  const calls={accountReady:()=>account,contactsFor:async()=>known?[{chat,actor,name,ambiguous}]:[],
    verify:async()=>({ready:true,pid:123}),settings:()=>({routeReady,outputDevice:4})};
  const media=new WeChatMediaSession({},audio,calls,{
    now:()=>now,messages:async()=>rows,ownFor:async()=>own,executable:()=>String.raw`D:\test\Weixin.exe`,
    play:async(args)=>{played.push(args);return {played:true};},...options,
  });
  const prep=(kind='voice')=>media.prepare({kind,text:'测试语音',chat});
  const arm=(id)=>media.arm({id,confirmed:true});
  return {media,audio,calls,prep,arm,played,say,setRows:value=>{rows=value;},advance:value=>{now+=value;},
    loseAccount:()=>{account=false;},deny:()=>{known=false;},duplicate:()=>{ambiguous=true;},route:ready=>{routeReady=ready;}};
}

test('assisted voice requires a selected contact, dedicated audio and explicit start; playback alone is not a receipt',async()=>{
  const f=fixture();
  f.setRows([row(1)]);
  const draft=await f.prep();
  assert.equal(draft.state,'ready');
  assert.equal(draft.preview.mime,'audio/wav');
  assert.deepEqual(f.say,['测试语音']);
  assert.equal(f.played.length,0);
  await assert.rejects(f.media.arm({id:draft.id}),/核对接收人/);
  f.route(false);
  await assert.rejects(f.arm(draft.id),/虚拟麦克风/);
  f.route(true);
  f.calls.timer=true;
  await assert.rejects(f.arm(draft.id),/退出通话/);
  f.calls.timer=false;
  assert.equal((await f.arm(draft.id)).state,'playing');
  await flush();
  assert.equal(f.played[0].name,name);
  assert.equal(f.played[0].pid,123);
  assert.equal((await f.media.check({id:draft.id})).state,'waiting');
  f.setRows([row(1),row(2,{isSend:false}),row(3,{localType:1}),row(4,{serverId:'0'})]);
  assert.equal((await f.media.check({id:draft.id})).state,'waiting');
  f.setRows([row(4)]);
  const result=await f.media.check({id:draft.id});
  assert.equal(result.state,'confirmed');
  assert.equal(result.received,at/1000);
  await assert.rejects(f.arm(draft.id),/已开始/);
});

test('pat receipt requires the XML actor and exact recipient rather than nickname or incoming record',async()=>{
  const f=fixture();
  const d=await f.prep('pat');
  assert.equal(d.preview,undefined);
  await f.arm(d.id);
  const opts={kind:'pat',armedAt:at,baseline:new Set(),own,peer:actor};
  const values=[
    row(3,{localType:type,fullText:pat(actor,own)}),
    row(4,{localType:type,fullText:pat(own,actor+'x')}),
    row(5,{localType:type,fullText:pat(own,actor)}),
  ];
  assert.deepEqual(newMediaReceipts(values,opts).map(item=>item.localId),[5]);
  f.setRows(values.slice(0,2));
  assert.equal((await f.media.check({id:d.id})).state,'waiting');
  f.setRows(values);
  assert.equal((await f.media.check({id:d.id})).state,'confirmed');
  assert.equal(f.played.length,0);
});

test('account switch, duplicate display name and contact revocation prevent evidence from crossing conversations',async()=>{
  const f=fixture();
  const draft=await f.prep('pat');
  f.duplicate();
  await assert.rejects(f.arm(draft.id),/备注唯一/);
  f.loseAccount();
  assert.equal(f.media.status().state,'idle');
  await assert.rejects(f.arm(draft.id),/账号已切换/);
  const other=fixture();
  const d=await other.prep();
  await other.arm(d.id);
  await flush();
  other.deny();
  await assert.rejects(other.media.check({id:d.id}),/备注唯一/);
});

test('multiple receipts, cutoff and failed playback remain unconfirmed',async()=>{
  const f=fixture();
  const d=await f.prep();
  await f.arm(d.id);await flush();
  f.setRows([row(2),row(3)]);
  assert.equal((await f.media.check({id:d.id})).state,'unknown');
  f.setRows([row(3)]);
  assert.equal((await f.media.check({id:d.id})).state,'unknown');
  f.advance(91_000);
  assert.match((await f.media.check({id:d.id})).detail,/超时/);
  const rejected=fixture({play:async()=>({played:false,code:'FOREGROUND'})});
  const attempt=await rejected.prep();
  await rejected.arm(attempt.id);await flush();
  rejected.setRows([row(4)]);
  assert.equal((await rejected.media.check({id:attempt.id})).state,'unknown');
});

test('stop clears volatile drafts and aborts playback without a retry',async()=>{
  let signal;
  const f=fixture({play:(_payload,s)=>{signal=s;return new Promise(resolve=>s.addEventListener('abort',()=>resolve({played:false})));}});
  const d=await f.prep();
  await f.arm(d.id);await flush();
  assert.equal(f.media.stop().state,'idle');
  await flush();
  assert.equal(signal.aborted,true);
  await assert.rejects(f.media.check({id:d.id}),/已过期/);
});
