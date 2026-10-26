import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createConsole} from './console-server.mjs';
import {closeJingyu} from '../packages/jingyu/service.mjs';

test('native Jingyu routes require the console token and render memory settings without returning secrets',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jingyu-console-'));fs.mkdirSync(path.join(root,'config'),{recursive:true});fs.mkdirSync(path.join(root,'state/weflow'),{recursive:true});fs.copyFileSync('config/wechatagent.example.json',path.join(root,'config/wechatagent.json'));fs.writeFileSync(path.join(root,'state/weflow/active-account.json'),JSON.stringify({id:'a'.repeat(64)}));
 const app=createConsole({root,port:0}),address=await app.start(),base='http://127.0.0.1:'+address.port;
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));closeJingyu(root);fs.rmSync(root,{recursive:true,force:true});});
 assert.equal((await fetch(base+'/api/jingyu')).status,401);const {token}=await fetch(base+'/api/info').then(r=>r.json());const headers={'X-Console-Token':token,'Content-Type':'application/json'};
 const post=(route,body)=>fetch(base+route,{method:'POST',headers,body:JSON.stringify(body)});
 const settings=await post('/api/jingyu/settings',{ownerWxid:'wxid_fixture_owner',sharedMemoryEnabled:true,allowGroupShared:false});assert.equal(settings.status,200);assert.equal((await settings.json()).keyConfigured,false);
 const response=await post('/api/jingyu/memories',{text:'蓝鲸计划',scope:'owner_shared',status:'published'});assert.equal(response.status,200);
 const data=await fetch(base+'/api/jingyu',{headers}).then(r=>r.json());assert.equal(data.memories[0].text,'蓝鲸计划');assert.equal(data.balance.configured,false);assert(!JSON.stringify(data).includes('apiKey'));
 const runtimes=await fetch(base+'/api/python-runtime',{headers}).then(r=>r.json());assert.equal(runtimes.reader.ready,false);assert.equal(runtimes.audio.ready,false);assert.equal(data.audio.settings.python,undefined);assert.equal((await post('/api/jingyu/audio/probe',{python:process.execPath})).status,400);
 assert.equal((await fetch(base+'/jingyu.js')).status,200);assert.equal((await fetch(base+'/api/jingyu',{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
});
