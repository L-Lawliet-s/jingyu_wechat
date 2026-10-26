import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createConsole} from './console-server.mjs';
import {closeJingyu} from '../packages/jingyu/service.mjs';
import {jingyuFor} from '../packages/jingyu/service.mjs';
import {actorChat} from '../packages/jingyu/store.mjs';
import {HistoryStore} from '../packages/dsh-social-bridge-plugin/history-store.mjs';
import {syncConversationMemory} from '../packages/jingyu/conversation-memory.mjs';
import {createJingyuUI} from '../public/console/jingyu.js';

test('native Jingyu routes require the console token and render memory settings without returning secrets',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jingyu-console-'));fs.mkdirSync(path.join(root,'config'),{recursive:true});fs.mkdirSync(path.join(root,'state/weflow'),{recursive:true});fs.copyFileSync('config/wechatagent.example.json',path.join(root,'config/wechatagent.json'));fs.writeFileSync(path.join(root,'state/weflow/active-account.json'),JSON.stringify({id:'a'.repeat(64)}));
 const app=createConsole({root,port:0}),address=await app.start(),base='http://127.0.0.1:'+address.port;
 t.after(async()=>{app.server.closeAllConnections();await new Promise(resolve=>app.server.close(resolve));closeJingyu(root);fs.rmSync(root,{recursive:true,force:true});});
 assert.equal((await fetch(base+'/api/jingyu')).status,401);const {token}=await fetch(base+'/api/info').then(r=>r.json());const headers={'X-Console-Token':token,'Content-Type':'application/json'};
 const post=(route,body)=>fetch(base+route,{method:'POST',headers,body:JSON.stringify(body)});
 const settings=await post('/api/jingyu/settings',{ownerWxid:'wxid_fixture_owner',sharedMemoryEnabled:true,allowGroupShared:false});assert.equal(settings.status,200);assert.equal((await settings.json()).keyConfigured,false);
 const response=await post('/api/jingyu/memories',{text:'蓝鲸计划',scope:'owner_shared',status:'published'});assert.equal(response.status,200);
 const data=await fetch(base+'/api/jingyu',{headers}).then(r=>r.json());assert.equal(data.memories[0].text,'蓝鲸计划');assert.equal(data.balance.configured,false);assert(!JSON.stringify(data).includes('apiKey'));
 const {store}=jingyuFor(root),history=new HistoryStore(root,'a'.repeat(64)),chat=actorChat('wxid_fixture_owner');history.append(chat,{id:'test-thesis',platform:'wechat',kind:'private',sender_id:chat.split(':')[2],conversation_id:chat.split(':')[2],sender_name:'主人',text:'我在写论文',outgoing:false,timestamp:Date.now()/1000});syncConversationMemory(store,history,{allowedChats:[chat]});history.close();
 const automatic=await fetch(base+'/api/jingyu',{headers}).then(r=>r.json());assert.equal(automatic.conversationMemoryCount,1);assert.equal(automatic.settings.conversationMemoryEnabled,true);const memoryId=automatic.conversationMemories[0].id;
 const preview=structuredClone(automatic);preview.conversationMemories[0].text='<img src=x onerror=alert(1)>';preview.conversationMemories[0].person='<svg onload=alert(1)>';
 const escapeHtml=text=>String(text??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');const html=await createJingyuUI({api:async()=>preview,escapeHtml,toast:()=>{}}).page();assert(html.includes('自动聊天记忆'));assert(html.includes('data-jingyu-private-conversation'));assert(!html.includes('<img'));assert(!html.includes('<svg'));assert(html.includes('&lt;img'));
 assert.equal((await fetch(base+'/api/jingyu/conversations/delete',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:memoryId})})).status,401);
 assert.equal((await post('/api/jingyu/conversations/private',{id:memoryId})).status,200);assert.equal(store.listConversationMemories()[0].shareable,0);assert.equal((await post('/api/jingyu/conversations/delete',{id:memoryId})).status,200);assert.equal(store.conversationMemoryCount(),0);
 const runtimes=await fetch(base+'/api/python-runtime',{headers}).then(r=>r.json());assert.equal(runtimes.reader.ready,false);assert.equal(runtimes.audio.ready,false);assert.equal(data.audio.settings.python,undefined);assert.equal((await post('/api/jingyu/audio/probe',{python:process.execPath})).status,400);
 assert.equal((await fetch(base+'/jingyu.js')).status,200);assert.equal((await fetch(base+'/api/jingyu',{headers:{...headers,Origin:'https://untrusted.example'}})).status,403);
});
