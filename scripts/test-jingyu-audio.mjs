import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {AudioSession,validateAudio} from '../packages/jingyu/audio-session.mjs';

function fixture(t,fetchImpl){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jingyu-audio-test-'));fs.mkdirSync(path.join(root,'am'));fs.writeFileSync(path.join(root,'key.dpapi'),'encrypted-fixture');const values=new Map(),children=[];
 const store={get:(k,f)=>values.has(k)?values.get(k):f,set:(k,v)=>values.set(k,v),settings:()=>({ownerWxid:'wxid_fixture_owner'}),epoch:()=>values.get('epoch')??0};
 const billing={configured:()=>true,file:path.join(root,'key.dpapi'),crypt:()=> 'fixture-private-api-key'};
 const spawnImpl=(exe,args,options)=>{
  assert.equal(exe,process.execPath);assert(!JSON.stringify({args,options}).includes('fixture-private-api-key'));
  const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.sent=[];child.kill=()=>{child.killed=true;child.emit('exit',0);};
  child.stdin.on('data',chunk=>{const body=JSON.parse(chunk.toString());child.sent.push(body);if(body.type==='stop')queueMicrotask(()=>child.emit('exit',0));});children.push(child);return child;
 };
 const session=new AudioSession(store,billing,{root,spawnImpl,fetchImpl,pythonFor:()=>process.execPath,memoryFor:()=> '主人可读的记忆'});session.save({modelPath:root,inputDevice:0,outputDevice:1,voiceName:'',model:'deepseek-flash',maxMinutes:1});
 t.after(()=>{session.stop();fs.rmSync(root,{recursive:true,force:true});});return {session,store,children};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('audio settings require explicit devices, bounded duration and absolute executables',()=>{
 assert.throws(()=>validateAudio({python:'python',maxMinutes:99}));
});
test('legacy interpreter paths are ignored and cannot be submitted through audio settings',t=>{
 const f=fixture(t);f.store.set('audioSettings',{...f.session.settings(),python:'C:\\untrusted\\python.exe'});assert.equal(f.session.settings().python,undefined);assert.throws(()=>f.session.save({...f.session.settings(),python:process.execPath}));
});
test('audio loop uses a bounded text model request, keeps keys in host and records actual usage',async t=>{
 let request;const f=fixture(t,async(url,options)=>{request={url,options};return new Response(JSON.stringify({choices:[{message:{content:'主人，小鲸鱼在听。'}}],usage:{prompt_tokens:18,completion_tokens:7}}));});
 f.session.start();const child=f.children[0];assert.equal(f.session.status().wechatConnected,null);
 child.stdout.write(JSON.stringify({type:'ready'})+'\n');child.stdout.write(JSON.stringify({type:'transcript',text:'你好'})+'\n');await settle();
 assert.equal(request.url,'https://api.deepseek.com/chat/completions');const body=JSON.parse(request.options.body);assert.equal(body.max_tokens,200);assert.equal(body.thinking.type,'disabled');assert(!request.options.body.includes('fixture-private-api-key'));assert(body.messages[0].content.includes('主人可读的记忆'));
 assert.equal(f.session.status().state,'speaking');assert.deepEqual(f.session.status().usage,{input:18,output:7});assert.equal(child.sent.at(-1).type,'speak');assert(!JSON.stringify(child.sent).includes('fixture-private-api-key'));
 child.stdout.write('{"type":"spoken"}\n');assert.equal(f.session.status().state,'listening');
 f.session.stop();assert.deepEqual(f.session.history,[]);
});
test('stopping audio aborts an in-flight model turn and cannot publish a late reply',async t=>{
 let release;const gate=new Promise(resolve=>release=resolve);const f=fixture(t,async()=>{await gate;return new Response(JSON.stringify({choices:[{message:{content:'late'}}]}));});
 f.session.start();const child=f.children[0];child.stdout.write('{"type":"ready"}\n');child.stdout.write('{"type":"transcript","text":"test"}\n');await settle();
 const controller=f.session.controller;f.session.stop();assert(controller.signal.aborted);release();await settle();assert.equal(f.session.status().state,'stopped');assert(!child.sent.some(x=>x.type==='speak'));
});
test('audio stops before forwarding new speech when the memory epoch changes',async t=>{
 let called=false;const f=fixture(t,async()=>{called=true;throw Error();});f.session.start();const child=f.children[0];child.stdout.write('{"type":"ready"}\n');f.store.set('epoch',1);child.stdout.write('{"type":"transcript","text":"test"}\n');await settle();assert.equal(called,false);assert.equal(f.session.status().state,'error');
});
test('failed model calls stop audio and return no invented transcript or billing value',async t=>{
 const f=fixture(t,async()=>new Response('',{status:401}));f.session.start();const child=f.children[0];child.stdout.write('{"type":"ready"}\n');child.stdout.write('{"type":"transcript","text":"test"}\n');await settle();assert.equal(f.session.status().state,'error');assert(!child.sent.some(x=>x.type==='speak'));assert.equal(f.session.status().usage.output,0);
});

test('voice playback keeps the role response but strips chat transport and sticker markers',async t=>{
 const f=fixture(t,async()=>new Response(JSON.stringify({choices:[{message:{content:'RESPOND: **主人，小鲸鱼在呢。** [STICKER:S1]'}}]})));f.session.start();const child=f.children[0];child.stdout.write('{"type":"ready"}\n');child.stdout.write('{"type":"transcript","text":"你好"}\n');await settle();assert.equal(child.sent.at(-1).text,'主人，小鲸鱼在呢。');assert(!JSON.stringify(child.sent).includes('RESPOND:'));
});
