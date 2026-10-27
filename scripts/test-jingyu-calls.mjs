import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {JingyuStore,actorChat} from '../packages/jingyu/store.mjs';
import {CallSession} from '../packages/jingyu/call-session.mjs';

function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jingyu-calls-')),store=new JingyuStore(root,'a'.repeat(64)),owner='wxid_call_fixture',chat=actorChat(owner);store.saveSettings({ownerWxid:owner,sharedMemoryEnabled:true,allowGroupShared:false});
 const requests=[],starts=[],stops=[],contacts=[{chat,actor:owner,name:'唯一的测试主人',ambiguous:false}];let state={state:'idle',windowPresent:false,connected:false},audioState='stopped',ready=true;
 const settings={modelPath:root,inputDevice:0,outputDevice:1,voiceName:'fixture',model:'fixture',maxMinutes:5};
 const audio={billing:{configured:()=>true},settings:()=>({...settings}),save:value=>Object.assign(settings,value),start:args=>{starts.push(args);audioState='listening';},stop:()=>{stops.push(true);audioState='stopped';},status:()=>({state:audioState})};
 const worker={async rpc(action,args){requests.push({action,args});return action==='probe'?{accessible:true}:action==='poll'?state:{ok:true};},close(){}};
 const calls=new CallSession(store,audio,{root,worker,contactsFor:async()=>contacts,verify:async()=>{},accountReady:()=>ready});calls.save({inputDevice:4,outputDevice:5,routeReady:true,maxMinutes:5,videoSource:'placeholder'});
 t.after(()=>{calls.close();store.close();assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 return {calls,store,chat,owner,requests,starts,stops,contacts,settings,setState:value=>{state=value;},revoke:()=>{ready=false;}};
}
test('call interface is receive-only and cannot initiate an outgoing call',async t=>{const f=fixture(t);await assert.rejects(f.calls.start({chat:f.chat,kind:'voice',requestId:'c'.repeat(64)}),/只接听/);assert.equal(f.requests.length,0);});
test('incoming voice/video waits for explicit connection evidence before starting AI audio',async t=>{
 const f=fixture(t);await f.calls.listen({chat:f.chat});assert.equal(f.calls.status().state,'listening');assert.equal(f.starts.length,0);
 f.setState({state:'ringing',kind:'video',connected:false,windowPresent:true});await f.calls.poll();assert.equal(f.requests.filter(row=>row.action==='accept').length,1);assert.equal(f.starts.length,0);assert.equal(f.calls.state,'connecting');
 f.setState({state:'connected',connected:true,kind:'video',windowPresent:true});await f.calls.poll();assert.deepEqual(f.starts,[{chat:f.chat,actor:f.owner,connected:true}]);assert.equal(f.calls.status().kind,'video');assert(!f.requests.some(row=>row.action==='dial'));
 f.setState({state:'idle',connected:false,windowPresent:false});await f.calls.poll();assert.equal(f.calls.status().state,'listening');assert.equal(f.settings.inputDevice,0,'local microphone is restored after call');
});
test('unauthorized or ambiguous peers cannot be selected and duplicate listener setup does not answer twice',async t=>{
 const f=fixture(t);f.contacts[0].ambiguous=true;await assert.rejects(f.calls.listen({chat:f.chat}),/不唯一/);assert.equal(f.requests.length,0);f.contacts[0].ambiguous=false;await f.calls.listen({chat:f.chat});const n=f.requests.length;await f.calls.listen({chat:f.chat});assert.equal(f.requests.length,n);
});
test('a previously connected incoming call can attach audio without pressing accept again',async t=>{
 const f=fixture(t);await f.calls.listen({chat:f.chat});f.setState({state:'connected',connected:true,windowPresent:true,kind:'voice'});await f.calls.poll();assert.equal(f.starts.length,1);assert.equal(f.requests.filter(row=>row.action==='accept').length,0);assert.equal(f.settings.inputDevice,4);
});
test('account and memory changes stop the listener before forwarding or accepting new speech',async t=>{
 const f=fixture(t);await f.calls.listen({chat:f.chat});f.revoke();f.setState({state:'ringing',connected:false,windowPresent:true});await f.calls.poll();assert.equal(f.calls.state,'unknown');assert.equal(f.starts.length,0);assert(!f.requests.some(row=>row.action==='accept'));assert.equal(f.calls.timer,null);
});
test('hangup never controls an unrelated call and unknown states cannot silently retry',async t=>{
 const f=fixture(t);await assert.rejects(f.calls.hangup(),/没有/);assert.equal(f.requests.length,0);await f.calls.listen({chat:f.chat});f.store.bumpEpoch();await f.calls.poll();await assert.rejects(f.calls.listen({chat:f.chat}),/核对/);assert.throws(()=>f.calls.reset(false));f.calls.reset(true);assert.equal(f.calls.state,'idle');
});
