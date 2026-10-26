import fs from 'node:fs';
import path from 'node:path';
import {jingyuFor} from './service.mjs';
import {actorChat,fault} from './store.mjs';
import {StudyReminders} from './reminders.mjs';

export async function jingyuConsole(root,route,method,body={},options={}){
 const {store,billing,audio}=jingyuFor(root,options);
 const configFile=path.join(root,'config/wechatagent.json');const config=fs.existsSync(configFile)?JSON.parse(fs.readFileSync(configFile,'utf8').replace(/^\uFEFF/,'')):{};
 const chats=(config.wechat?.whitelist?.private??[]).map(id=>'wechat:private:'+id),reminders=new StudyReminders(store);
 if(route==='/api/jingyu'&&method==='GET')return {settings:store.settings(),keyConfigured:billing.configured(),memories:store.listMemories(),reminders:reminders.list(),chats,epoch:store.epoch(),balance:await billing.balance(),audio:{settings:audio.settings(),status:audio.status()},capabilities:{memory:true,billing:true,audio:'manual-test',pat:false,voiceMessage:false,voiceCall:false,videoCall:false}};
 if(route==='/api/jingyu/audio/settings'&&method==='POST')return {ok:true,settings:audio.save(body)};
 if(route==='/api/jingyu/audio/status'&&method==='GET')return audio.status();
 if(route==='/api/jingyu/audio/probe'&&method==='POST')return audio.probe(body.python);
 if(route==='/api/jingyu/audio/start'&&method==='POST')return audio.start();
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
 throw fault('鲸鱼接口不存在。',404);
}
