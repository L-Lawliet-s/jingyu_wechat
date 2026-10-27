import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import readline from 'node:readline';
import crypto from 'node:crypto';
import {actorChat,fault,validActor} from './store.mjs';
import {findPython} from './python-runtime.mjs';
import {activeReaderAccount} from '../../scripts/reader-account-state.mjs';
import {verifyWeChatAccount} from '../../scripts/wechat-account-check.mjs';

export class WeChatCallWorker{
 constructor(root,{spawnImpl=spawn,pythonFor=()=>findPython(root,'audio')?.executable}={}){Object.assign(this,{root,spawnImpl,pythonFor});this.pending=new Map();}
 async open(){
  if(this.child)return this.ready;
  const python=this.pythonFor();if(!python)throw fault('请先一键准备语音环境。',503);const config=JSON.parse(fs.readFileSync(path.join(this.root,'config/wechatagent.json'),'utf8'));
  const executable=path.resolve(this.root,config.hook.wechatExecutable);this.child=this.spawnImpl(python,[path.join(import.meta.dirname,'call_worker.py')],{windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,PYTHONUTF8:'1'}});const child=this.child;
  this.ready=new Promise((resolve,reject)=>{this.readyResolve=resolve;this.readyReject=reject;});
  const lines=readline.createInterface({input:child.stdout});child.stdin.on('error',()=>{});
  lines.on('line',line=>{if(line.length>16000)return;let value;try{value=JSON.parse(line);}catch{return;}
   if(Object.hasOwn(value,'ready')){clearTimeout(this.readyTimer);if(value.ready)this.readyResolve(value);else this.readyReject(fault('通话控件驱动未就绪，请准备语音环境后重试。',503));return;}
   const pending=this.pending.get(value.id);if(!pending)return;this.pending.delete(value.id);clearTimeout(pending.timer);value.ok?pending.resolve(value):pending.reject(fault(({CHAT_NOT_VERIFIED:'无法核对当前联系人，已停止拨号。',CALL_NOT_CONFIRMED:'未确认已拨号，请查看微信；不要直接重复拨打。',CALL_BUTTON_AMBIGUOUS:'通话按钮有歧义，请在微信中手动处理。',CALL_WINDOW_NOT_VERIFIED:'无法核对通话窗口中的联系人。'})[value.code]??'微信通话控件操作未完成。',503));
  });
  const failed=()=>{if(this.child!==child)return;this.child=null;clearTimeout(this.readyTimer);this.readyReject?.(fault('通话控件进程已停止。',503));for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(fault('通话状态未知，请查看微信窗口。',503));}this.pending.clear();lines.close();};
  child.once('exit',failed);child.once('error',failed);this.readyTimer=setTimeout(()=>{this.readyReject(fault('通话控件加载超时。',503));this.close();},20000);
  child.stdin.write(JSON.stringify({executable})+'\n');return this.ready;
 }
 async rpc(action,args={}){await this.open();const id=crypto.randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(fault('通话操作结果未知，请查看微信。',503));},15000);this.pending.set(id,{resolve,reject,timer});this.child.stdin.write(JSON.stringify({id,action,...args})+'\n');});}
 close(){const child=this.child;if(child){try{child.stdin.write('{"action":"quit"}\n');}catch{}const timer=setTimeout(()=>child.kill(),1500);timer.unref();child.once('exit',()=>clearTimeout(timer));}clearTimeout(this.readyTimer);}
}

export async function callContacts(root,{fetchImpl=fetch}={}){
 const io=JSON.parse(fs.readFileSync(path.join(root,'state/wechat-io-config.json'),'utf8')),url=new URL(io.reader_base_url);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password)throw fault('联系人读取连接无效。',503);
 const response=await fetchImpl(new URL('/api/v1/contacts?kind=private&limit=10000',url),{headers:{Authorization:'Bearer '+io.reader_token},signal:AbortSignal.timeout(8000)});if(!response.ok)throw fault('请先启动微信读取服务，再获取通话联系人。',503);
 const data=await response.json();if(data.success!==true||!Array.isArray(data.contacts))throw fault('联系人读取未完成。',503);
 const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8')),allowed=new Set((config.wechat?.whitelist?.private??[]).map(id=>'wechat:private:'+id));
 const rows=data.contacts.filter(row=>validActor(row.username)&&allowed.has(actorChat(row.username))).map(row=>({chat:actorChat(row.username),actor:row.username,name:String(row.displayName??'').trim()}));
 return rows.map(row=>({...row,ambiguous:!row.name||data.contacts.filter(item=>String(item.displayName??'').trim()===row.name).length!==1}));
}

export class CallSession{
 constructor(store,audio,{root,worker=new WeChatCallWorker(root),contactsFor=()=>callContacts(root),verify=async()=>verifyWeChatAccount({root,config:JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8')),settings:JSON.parse(fs.readFileSync(path.join(root,'state/weflow/WeFlow-config.json'),'utf8')),wait:false}),accountReady=()=>activeReaderAccount(root).id===store.account,now=Date.now}={}){Object.assign(this,{store,audio,root,worker,contactsFor,verify,accountReady,now});this.state='idle';this.generation=0;}
 settings(){return {...{inputDevice:-1,outputDevice:-1,routeReady:false,maxMinutes:5,videoSource:'placeholder'},...this.store.get('callSettings',{})};}
 save(value){if(this.timer)throw fault('请先结束当前通话。',409);if(!value||Object.keys(value).some(key=>!['inputDevice','outputDevice','routeReady','maxMinutes','videoSource'].includes(key))||!Number.isInteger(value.inputDevice)||value.inputDevice<0||!Number.isInteger(value.outputDevice)||value.outputDevice<0||typeof value.routeReady!=='boolean'||!Number.isInteger(value.maxMinutes)||value.maxMinutes<1||value.maxMinutes>15||value.videoSource!=='placeholder')throw fault('请选择两条独立音频通道、1–15 分钟时限，并确认微信设备路由。');this.store.set('callSettings',value);return this.settings();}
 status(){return {state:this.state,kind:this.kind??null,chat:this.contact?.chat??null,connected:this.state==='connected',audio:this.audio.status(),startedAt:this.startedAt??null,error:this.error??null,videoSource:'placeholder',settings:this.settings()};}
 async contacts(){return (await this.contactsFor()).map(({chat,name,ambiguous})=>({chat,name,ambiguous}));}
 async probe(prepare=false){if(!this.accountReady())throw fault('微信账号已切换。',409);await this.verify();return this.worker.rpc(prepare?'prepare':'probe');}
 async start({chat,kind='voice',requestId,accept=false}={}){
  if(accept!==true)throw fault('当前只接听来电，不提供主动拨号。',403);
  if(this.starting||this.timer||['dialing','ringing','connected','connecting','ending','unknown'].includes(this.state))throw fault('已有通话进行中或状态待核对，请先查看微信，不会重复拨号。',409);
  if(!this.accountReady())throw fault('微信账号已切换。',409);if(!['voice','video'].includes(kind)||typeof requestId!=='string'||!/^[a-f0-9]{64}$/.test(requestId))throw fault('通话类型或请求编号无效。');
  const previous=this.store.db.prepare('SELECT state FROM jobs WHERE id=?').get(requestId);if(previous)throw fault('这个通话请求已处理过，请先查看微信当前状态。',409);
  this.starting=true;try{
  const contact=(await this.contactsFor()).find(row=>row.chat===chat);if(!contact||contact.ambiguous||actorChat(contact.actor)!==chat)throw fault('联系人未授权或备注不唯一，请先给联系人设置唯一备注。');
  const settings=this.settings();if(!settings.routeReady)throw fault('请先在通话设置中选择音频通道，并确认微信的麦克风和扬声器路由。');
  if(!this.audio.billing.configured())throw fault('请先绑定用于语音回答的 DeepSeek API Key。');
  await this.verify(contact);const capabilities=await this.worker.rpc('probe');if(!capabilities.accessible)throw fault('微信通话控件尚未激活，请先点击“准备通话控件”。',503);
  const existing=await this.worker.rpc('poll');if(!accept&&(existing.windowPresent||existing.connected))throw fault('微信中已有通话窗口，请先处理当前通话。',409);
  this.previousAudioSettings=this.audio.settings();this.audio.save({...this.previousAudioSettings,inputDevice:settings.inputDevice,outputDevice:settings.outputDevice,maxMinutes:settings.maxMinutes});
  this.contact=contact;this.kind=kind;this.error=null;this.state=accept?'connecting':'dialing';this.startedAt=this.now();this.epoch=this.store.epoch();this.requestId=requestId;const generation=++this.generation;
  this.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run(requestId,'wechat-call',chat,contact.actor,JSON.stringify({kind}),this.state,null,this.now(),this.now());
  try{await this.worker.rpc('accept',{name:contact.name,kind});}catch(error){this.error=error.message;this.end('unknown');throw error;}
  this.timer=setInterval(()=>{if(!this.polling&&this.generation===generation){this.polling=true;void this.poll().finally(()=>{this.polling=false;});}},1000);this.timer.unref();return this.status();
  }finally{this.starting=false;}
 }
 async listen({chat}={}){
  if(this.state==='listening'&&this.contact?.chat===chat)return this.status();
  if(this.starting||this.timer||this.state==='unknown')throw fault('请先停止或核对当前通话状态。',409);
  if(!this.accountReady())throw fault('微信账号已切换。',409);this.starting=true;
  try{
   const contact=(await this.contactsFor()).find(row=>row.chat===chat),settings=this.settings();
   if(!contact||contact.ambiguous||actorChat(contact.actor)!==chat)throw fault('联系人未授权或备注不唯一。');
   if(!settings.routeReady)throw fault('请先确认通话音频路由。');if(!this.audio.billing.configured())throw fault('请先绑定用于语音回答的 DeepSeek API Key。');
   await this.verify(contact);const cap=await this.worker.rpc('probe');if(!cap.accessible)throw fault('接听控件尚未就绪，请先准备通话控件。',503);
   await this.worker.rpc('watch',{name:contact.name});this.contact=contact;this.watch=true;this.state='listening';this.error=null;this.epoch=this.store.epoch();this.requestId=null;this.arm();return this.status();
  }finally{this.starting=false;}
 }
 arm(){clearInterval(this.timer);const generation=++this.generation;this.timer=setInterval(()=>{if(!this.polling&&this.generation===generation){this.polling=true;void this.poll().finally(()=>{this.polling=false;});}},1000);this.timer.unref();}
 stopListening(){this.watch=false;if(this.state==='listening'){this.generation++;clearInterval(this.timer);this.timer=null;this.state='idle';}return this.status();}
 persist(){if(this.requestId)this.store.db.prepare('UPDATE jobs SET state=?,updated=? WHERE id=?').run(this.state,this.now(),this.requestId);}
 async poll(){
  const generation=this.generation;
  try{
   if(!this.accountReady()||this.store.epoch()!==this.epoch)throw Error('账号或记忆权限已变化，AI 音频已停止。');
   if(this.state!=='listening'&&this.now()-this.startedAt>this.settings().maxMinutes*60000){await this.hangup();return;}
   const result=await this.worker.rpc('poll');
   if(generation!==this.generation)return;
   if(this.watch&&this.state==='listening'&&['ringing','connected'].includes(result.state)){
    this.startedAt=this.now();this.requestId=crypto.randomBytes(32).toString('hex');this.kind=result.kind??'voice';this.previousAudioSettings=this.audio.settings();const settings=this.settings();this.audio.save({...this.previousAudioSettings,inputDevice:settings.inputDevice,outputDevice:settings.outputDevice,maxMinutes:settings.maxMinutes});this.state='connecting';
    this.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run(this.requestId,'wechat-call',this.contact.chat,this.contact.actor,JSON.stringify({kind:this.kind,incoming:true}),this.state,null,this.now(),this.now());
    await this.verify(this.contact);if(result.state==='ringing'){await this.worker.rpc('accept',{name:this.contact.name});return;}
   }
   if(result.connected===true&&result.state==='connected'){
    if(this.state!=='connected'){this.kind=result.kind??this.kind;this.audio.start({chat:this.contact.chat,actor:this.contact.actor,connected:true});this.state='connected';this.connectedAt=this.now();this.persist();}
    else if(['stopped','error'].includes(this.audio.status().state)){await this.hangup();return;}
   }else if(this.state==='connected'){this.end(result.windowPresent?'unknown':'ended');}
   else if(this.state!=='listening'&&this.now()-this.startedAt>60000){await this.hangup();}
   else{this.state=result.state==='ringing'?'ringing':this.state;}
  }catch(error){if(generation!==this.generation)return;this.error=error.status?error.message:'通话状态无法核对，AI 音频已停止；请查看微信窗口。';this.end('unknown');}
 }
 end(state='ended'){clearInterval(this.timer);this.timer=null;this.audio.stop();if(this.previousAudioSettings){this.audio.save(this.previousAudioSettings);this.previousAudioSettings=null;}this.state=state;this.persist();if(state==='ended'&&this.watch){this.state='listening';this.requestId=null;this.arm();}else if(state==='unknown')this.watch=false;}
 async hangup(){if(!this.contact||!this.requestId)throw fault('当前没有小鲸鱼管理的通话。',409);this.audio.stop();try{await this.worker.rpc('hangup',{name:this.contact.name});const result=await this.worker.rpc('poll');this.end(result.windowPresent?'unknown':'ended');}catch(error){this.error=error.message;this.end('unknown');throw error;}return this.status();}
 reset(confirmed){if(confirmed!==true||this.timer)throw fault('请先在微信确认已经没有通话，再清除待核对状态。',409);this.generation++;this.audio.stop();this.state='idle';this.contact=null;this.requestId=null;this.error=null;return this.status();}
 close(){this.generation++;this.watch=false;this.end(this.timer?'unknown':this.state);this.worker.close();}
}
