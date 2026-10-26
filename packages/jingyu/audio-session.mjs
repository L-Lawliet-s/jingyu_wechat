import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
import {actorChat,fault} from './store.mjs';
import {findPython} from './python-runtime.mjs';

const defaults={modelPath:'',inputDevice:-1,outputDevice:-1,voiceName:'',model:'deepseek-flash',maxMinutes:5};
export function validateAudio(value){
 if(!value||Object.keys(value).some(k=>!Object.hasOwn(defaults,k))||!['modelPath','voiceName','model'].every(k=>typeof value[k]==='string'&&value[k].length<=1024&&!/[\x00-\x1f]/.test(value[k]))||!path.isAbsolute(value.modelPath)||!Number.isInteger(value.inputDevice)||value.inputDevice<0||!Number.isInteger(value.outputDevice)||value.outputDevice<0||!Number.isInteger(value.maxMinutes)||value.maxMinutes<1||value.maxMinutes>15||!/^[a-zA-Z0-9_.-]{1,80}$/.test(value.model))throw fault('请检查离线模型目录、音频设备编号和 1–15 分钟时限。运行环境由软件自动管理。');
 return {...defaults,...value};
}

// This service handles audio only. It never claims that a WeChat call is connected.
export class AudioSession{
 constructor(store,billing,{root,fetchImpl=fetch,spawnImpl=spawn,pythonFor=()=>findPython(root,'audio')?.executable,accountReady=()=>true,memoryFor=()=>'',personaFor=()=> '你是小鲸鱼，可爱、温柔、有一点傲娇。你是 AI。与主人说话时称呼主人，不攻击或嘲讽他人。',now=Date.now}={}){
  Object.assign(this,{store,billing,root,fetchImpl,spawnImpl,pythonFor,accountReady,memoryFor,personaFor,now});this.worker=path.join(import.meta.dirname,'audio_worker.py');this.state='stopped';this.turns=0;this.usage={input:0,output:0};this.history=[];this.generation=0;
 }
 settings(){const {python,...settings}=this.store.get('audioSettings',{});return {...defaults,...settings};}
 save(value){if(this.child)throw fault('请先停止音频会话，再修改设备。',409);this.store.set('audioSettings',validateAudio(value));return this.settings();}
 status(){return {state:this.state,turns:this.turns,usage:this.usage,startedAt:this.startedAt??null,error:this.error??null,wechatConnected:null,mode:'本地半双工音频测试；不会自动拨号或开启摄像头'};}
 async probe(){
  const python=this.pythonFor();if(!python)throw fault('请先点击“一键准备语音环境”，软件会自动安装和配置。');
  return new Promise(resolve=>{
   const child=this.spawnImpl(python,[this.worker,'--probe'],{windowsHide:true,stdio:['ignore','pipe','ignore'],env:{...process.env,PYTHONUTF8:'1'}});let output='';
   const timer=setTimeout(()=>{child.kill();resolve({available:false,error:'音频检测超时。'});},12000);
   child.stdout.on('data',data=>{output+=data;if(output.length>128000)child.kill();});
   child.once('error',()=>{clearTimeout(timer);resolve({available:false,error:'语音环境无法启动，请重新点击“一键准备语音环境”。'});});
   child.once('exit',code=>{clearTimeout(timer);try{const body=JSON.parse(output);resolve(code===0?body:{available:false,error:body.error??'音频依赖未就绪。'});}catch{resolve({available:false,error:'未检测到有效音频依赖。'});}});
  });
 }
 start(){
  if(this.child)throw fault('音频会话已在运行。',409);if(!this.accountReady()||!this.store.settings().ownerWxid)throw fault('请先连接微信并绑定主人。',409);if(!this.billing.configured())throw fault('实时对话需要绑定 DeepSeek API Key。');
  const settings=validateAudio(this.settings()),python=this.pythonFor();if(!python)throw fault('请先点击“一键准备语音环境”。');if(!fs.existsSync(path.join(settings.modelPath,'am')))throw fault('Vosk 模型目录不存在，请选择已解压的中文模型。');
  const generation=++this.generation;this.owner=this.store.settings().ownerWxid;this.epoch=this.store.epoch();this.history=[];this.turns=0;this.usage={input:0,output:0};this.error=null;this.state='starting';this.startedAt=this.now();
  const child=this.spawnImpl(python,[this.worker],{windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...process.env,PYTHONUTF8:'1'}});this.child=child;
  child.stdin.on('error',()=>{});
  const lines=readline.createInterface({input:child.stdout});lines.on('line',line=>{if(line.length>8000)return;try{this.event(JSON.parse(line),generation);}catch{this.fail('音频进程返回无效数据。');}});
  child.once('error',()=>{if(this.generation===generation)this.fail('音频进程无法启动。');});
  child.once('exit',()=>{lines.close();if(this.child===child){this.child=null;clearTimeout(this.limitTimer);clearTimeout(this.readyTimer);if(!['stopped','error'].includes(this.state)){this.state='error';this.error='音频进程已退出，请检测依赖和设备。';}}});
  this.limitTimer=setTimeout(()=>this.stop(),settings.maxMinutes*60000);this.readyTimer=setTimeout(()=>{if(this.state==='starting')this.fail('音频启动超时。');},25000);
  this.write({type:'configure',settings});return this.status();
 }
 write(value){if(this.child?.stdin.writable)this.child.stdin.write(JSON.stringify(value)+'\n');}
 event(value,generation){
  if(generation!==this.generation||!this.child)return;
  if(!this.accountReady()||this.store.settings().ownerWxid!==this.owner||this.store.epoch()!==this.epoch){this.fail('账号或记忆已变化，请重新启动音频会话。');return;}
  if(value.type==='ready'){clearTimeout(this.readyTimer);this.state='listening';}
  else if(value.type==='spoken')this.state='listening';
  else if(value.type==='error')this.fail('本地语音识别或合成失败，请检查模型、设备和中文声音。');
  else if(value.type==='transcript'&&this.state==='listening'&&typeof value.text==='string'&&value.text.trim()&&value.text.length<=500)void this.reply(value.text.trim(),generation);
 }
 async reply(text,generation){
  if(this.turns>=20){this.fail('已达到本次 20 轮上限，请手动开始下一次会话。');return;}
  this.state='thinking';this.write({type:'pause'});this.turns++;
  const controller=new AbortController();this.controller=controller;const timeout=setTimeout(()=>controller.abort(),15000);
  try{
   const key=this.billing.crypt(fs.readFileSync(this.billing.file,'utf8'),false),chat=actorChat(this.owner),system=this.personaFor(chat).slice(0,5000)+'\n这是与主人进行的实时语音对话。每次一到三句，最多120字，不输出表情标记、Markdown或工具指令。'+this.memoryFor(chat,this.owner,text.slice(0,300));
   const response=await this.fetchImpl('https://api.deepseek.com/chat/completions',{method:'POST',redirect:'error',signal:controller.signal,headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({model:this.settings().model,messages:[{role:'system',content:system},...this.history,{role:'user',content:text}],max_tokens:200,stream:false,thinking:{type:'disabled'}})});
   if(!response.ok)throw Error('MODEL_UNAVAILABLE');const raw=await response.text();if(raw.length>128000)throw Error('RESPONSE_LIMIT');
   const result=JSON.parse(raw),reply=result.choices?.[0]?.message?.content;
   if(typeof reply!=='string'||!reply.trim())throw Error('EMPTY_REPLY');
   if(generation!==this.generation||!this.child)return;if(!this.accountReady()||this.store.epoch()!==this.epoch||this.store.settings().ownerWxid!==this.owner)throw Error('ACCOUNT_CHANGED');
   const spoken=reply.trim().slice(0,500);this.history.push({role:'user',content:text},{role:'assistant',content:spoken});this.history=this.history.slice(-8);
   for(const [key,source]of [['input','prompt_tokens'],['output','completion_tokens']])if(Number.isSafeInteger(result.usage?.[source])&&result.usage[source]>=0)this.usage[key]+=result.usage[source];
   this.state='speaking';this.write({type:'speak',text:spoken});
  }catch{if(generation===this.generation)this.fail('语音对话未完成，请检查 API Key、模型和连接。');}finally{clearTimeout(timeout);if(this.controller===controller)this.controller=null;}
 }
 fail(message){this.stop();this.state='error';this.error=message;}
 stop(){
  this.generation++;this.controller?.abort();this.controller=null;clearTimeout(this.limitTimer);clearTimeout(this.readyTimer);const child=this.child;this.write({type:'stop'});this.child=null;if(child){const timer=setTimeout(()=>child.kill(),2500);timer.unref();child.once('exit',()=>clearTimeout(timer));}this.state='stopped';this.history=[];return this.status();
 }
}
