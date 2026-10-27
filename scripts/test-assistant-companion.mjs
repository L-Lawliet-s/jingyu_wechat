import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {actorChat} from '../packages/jingyu/store.mjs';
import {assistantConversationChatAllowed,assistantSenderAllowed,assistantTaskIntent,verifiedAssistantSender} from '../packages/dsh-social-bridge-plugin/assistant-policy.mjs';
import {SocialEngine} from '../components/qq-bridge/src/core/social-engine.js';import {MessageBuffer} from '../components/qq-bridge/src/core/message-buffer.js';
test('allowed private members can chat with the companion without acquiring administrator tools',()=>{
 const actor='wxid_companion_guest',key=actorChat(actor),w={whitelist:{private:[key.split(':')[2]],groups:[]},assistant:{administrators:[]}};
 assert(assistantConversationChatAllowed(w,key,actor));assert(!assistantSenderAllowed(w,key,actor));assert(!assistantConversationChatAllowed(w,key,'wxid_other'));assert(!assistantConversationChatAllowed(w,key,''));
 for(const text of ['你好呀','我在写论文','今天有点累','你想我了吗','聊天：打开你的心扉'])assert(!assistantTaskIntent(text));
 for(const text of ['帮我整理一下文件','看看这个 BV1GJ411x7h7 的评论','点个外卖','任务状态','取消任务','查询今天的天气','播放这个视频'])assert(assistantTaskIntent(text));
});
test('private role chat is actually delivered by the isolated companion channel',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jingyu-companion-')),actor='wxid_companion_guest',key=actorChat(actor),id=key.split(':')[2],calls=[],sent=[];
 const master=new SocialEngine({buffer:new MessageBuffer(path.join(root,'tasks.json')),workModeFor:()=> 'assistant',assistantAccess:()=>false,assistantBatchMs:5,batchMs:1,minIntervalMs:0,privateMinIntervalMs:0,stickerPolicyFor:()=>({enabled:false}),decide:async(_key,prompt,meta)=>{calls.push({prompt,meta});return 'RESPOND: 小鲸鱼在呢，今天也陪你聊一会儿。';},send:async(_message,text)=>{sent.push(text);return {confirmed:true};}});
 const w={whitelist:{private:[id],groups:[]},assistant:{administrators:[]}},chat=master.createGroupChat({buffer:new MessageBuffer(path.join(root,'chat.json')),assistantAccess:(target,message)=>assistantConversationChatAllowed(w,target,verifiedAssistantSender(message))});
 t.after(()=>{chat.stop();master.stop();assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});chat.receive({platform:'wechat',kind:'private',conversation_id:id,sender_id:id,sender_wxid:actor,sender_name:'测试朋友',text:'你好呀',message_id:'companion-greeting',timestamp:Date.now()/1000});
 for(let n=0;n<100&&!sent.length;n++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(sent.length,1);assert(sent[0].includes('小鲸鱼在呢'));assert.equal(calls[0].meta.assistantChatOnly,true);assert(calls[0].prompt.includes('你好呀'));
});
