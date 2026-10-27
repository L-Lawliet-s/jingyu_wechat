import fs from 'node:fs';
import path from 'node:path';
import {jingyuFor} from './service.mjs';
import {actorChat,fault} from './store.mjs';
import {StudyReminders} from './reminders.mjs';
import {pythonStatus} from './python-runtime.mjs';

export async function jingyuConsole(root,route,method,body={},options={}){
 const {store,billing,audio,platforms,calls}=jingyuFor(root,options);
 const configFile=path.join(root,'config/wechatagent.json');const config=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,'')):{};
 const chats=(config.wechat?.whitelist?.private??[]).map(id=>'wechat:private:'+id),reminders=new StudyReminders(store);
 if(route.startsWith('/api/jingyu/call/')&&body.account!==undefined&&body.account!==store.account)throw fault('微信账号已切换。',409);
 if(route==='/api/jingyu/platform'&&method==='POST')return platforms.run(body);
 if(route==='/api/jingyu/call/status'&&method==='GET')return calls.status();
 if(route==='/api/jingyu/call/contacts'&&method==='GET')return {contacts:await calls.contacts()};
 if(route==='/api/jingyu/call/settings'&&method==='POST')return {settings:calls.save(body)};
 if(route==='/api/jingyu/call/probe'&&method==='POST')return calls.probe(body.prepare===true);
 if(route==='/api/jingyu/call/start'&&method==='POST')return calls.start(body);
 if(route==='/api/jingyu/call/listen'&&method==='POST')return calls.listen(body);
 if(route==='/api/jingyu/call/stop-listening'&&method==='POST')return calls.stopListening();
 if(route==='/api/jingyu/call/hangup'&&method==='POST')return calls.hangup();
 if(route==='/api/jingyu/call/reset'&&method==='POST')return calls.reset(body.confirmed);
 if(route==='/api/jingyu'&&method==='GET')return {settings:store.settings(),keyConfigured:billing.configured(),memories:store.listMemories(),conversationMemories:store.listConversationMemories(),conversationMemoryCount:store.conversationMemoryCount(),reminders:reminders.list(),chats,calls:calls.status(),epoch:store.epoch(),balance:await billing.balance(),audio:{settings:audio.settings(),status:audio.status(),runtime:pythonStatus(root,'audio')},capabilities:{memory:true,conversationMemory:true,billing:true,audio:'realtime-driver',pat:false,voiceMessage:false,voiceCall:'probe-required',videoCall:'probe-required'}};
 if(route==='/api/jingyu/audio/settings'&&method==='POST')return {ok:true,settings:audio.save(body)};
 if(route==='/api/jingyu/audio/status'&&method==='GET')return audio.status();
 if(route==='/api/jingyu/audio/sample'&&method==='POST')return audio.sample(body.voice??{});
 if(route==='/api/jingyu/audio/probe'&&method==='POST'){if(Object.hasOwn(body,'python'))throw fault('运行环境由软件自动管理，无需提交程序路径。');return audio.probe();}
 if(route==='/api/jingyu/audio/start'&&method==='POST'){if(calls.timer)throw fault('微信通话正在使用音频，请先结束通话。',409);return audio.start();}
 if(route==='/api/jingyu/audio/stop'&&method==='POST')return audio.stop();
 if(route==='/api/jingyu/reminders'&&method==='POST'){if(!store.settings().ownerWxid)throw fault('请先绑定主人微信 ID。');if(!chats.includes(body.chat))throw fault('请先把接收人加入允许的私聊范围。');return {ok:true,reminder:reminders.save(body)};}
 if(route==='/api/jingyu/reminders/delete'&&method==='POST'){reminders.remove(body.id);return {ok:true};}
 if(route==='/api/jingyu/reminders/pause'&&method==='POST'){return reminders.pause(body.chat);}
 if(route==='/api/jingyu/balance'&&method==='GET')return billing.balance({refresh:true});
 if(route==='/api/jingyu/settings'&&method==='POST'){
  const {apiKey,clearKey,...settings}=body;
  if(apiKey&&clearKey)throw fault('保存密钥和清除密钥不能同时执行。');
  store.validateSettings(settings);if(apiKey)billing.setKey(apiKey);if(clearKey===true)billing.clear();store.saveSettings(settings);
  return {ok:true,settings:store.settings(),keyConfigured:billing.configured()};
 }
 if(route==='/api/jingyu/memories'&&method==='POST'){
  const prefs=store.settings();if(!prefs.ownerWxid)throw fault('请先绑定主人微信 ID。');
  const previous=body.id?store.listMemories().find(item=>item.id===body.id):null;
  if(body.id&&!previous)throw fault('记忆已删除或不存在，请刷新页面。',404);
  const actor=previous?.author??prefs.ownerWxid,chat=previous?.chat??actorChat(actor);
  return {ok:true,memory:store.saveMemory({id:previous?.id,chat,actor,text:body.text,scope:body.scope,status:body.status??'published',source:previous?.source??'desktop',desktop:true})};
 }
 if(route==='/api/jingyu/memories/delete'&&method==='POST'){
  if(typeof body.id!=='string'||body.id.length>60)throw fault('请选择有效记忆。');store.removeMemory(body.id);return {ok:true};
 }
 if(route==='/api/jingyu/conversations/private'&&method==='POST'){store.restrictConversationMemory(body.id);return {ok:true};}
 if(route==='/api/jingyu/conversations/delete'&&method==='POST'){store.restrictConversationMemory(body.id,true);return {ok:true};}
 throw fault('鲸鱼接口不存在。',404);
}
