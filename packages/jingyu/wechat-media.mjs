import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { actorChat, fault, validActor } from './store.mjs';
import { findPython } from './python-runtime.mjs';

const voiceType=34;
const PAT_TYPE=62*2**32+49;
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/u,''));
const rowId=row=>String(row.localId??'');
const hasServerId=row=>/^[1-9]\d{0,31}$/u.test(String(row.serverId??''));
const expires=5*60_000;
const windowMs=90_000;

async function reader(root,route,fetchImpl) {
  const settings=read(path.join(root,'state','wechat-io-config.json'));
  const origin=new URL(settings.reader_base_url);
  if(origin.protocol!=='http:'||origin.hostname!=='127.0.0.1'||origin.username||origin.password)throw fault('微信读取连接无效。',503);
  const response=await fetchImpl(new URL(route,origin),{headers:{Authorization:'Bearer '+settings.reader_token},
    redirect:'error',signal:AbortSignal.timeout(6000)});
  if(!response.ok)throw fault('请先启动微信读取服务。',503);
  const value=await response.json();
  if(value?.success!==true)throw fault('微信读取回执暂不可用。',503);
  return value;
}
async function readRows(root,actor,fetchImpl) {
  const data=await reader(root,'/api/v1/messages?limit=100&talker='+encodeURIComponent(actor),fetchImpl);
  if(!Array.isArray(data.messages))throw fault('微信读取回执格式无效。',503);
  return data.messages;
}
function patDirection(row,own,peer) {
  const raw=String(row.fullText??row.content??'');
  if(raw.length>100000)return false;
  const info=/<patinfo(?:\s[^>]*)?>([\s\S]*?)<\/patinfo>/u.exec(raw)?.[1];
  const actor=info?.match(/<fromusername>(?:<!\[CDATA\[)?([A-Za-z0-9_-]+)(?:\]\]>)?<\/fromusername>/u)?.[1];
  const target=info?.match(/<pattedusername>(?:<!\[CDATA\[)?([A-Za-z0-9_-]+)(?:\]\]>)?<\/pattedusername>/u)?.[1];
  return Boolean(actor&&target&&own&&actor===own&&target===peer);
}
export function newMediaReceipts(rows,{kind,peer,own,baseline,armedAt}) {
  return rows.filter(row=>!baseline.has(rowId(row))&&/^[1-9]\d*$/u.test(rowId(row))&&
    Number(row.createTime)>=Math.floor(armedAt/1000)&&
    (kind==='pat'?Number(row.localType)===PAT_TYPE&&patDirection(row,own,peer):
      Number(row.localType)===voiceType&&(row.isSend===true||row.isSend===1)));
}
function playback(root,payload,signal) {
  const python=findPython(root,'audio')?.executable;
  if(!python)throw fault('请先一键准备语音环境。',409);
  return new Promise((resolve,reject)=>{
    const child=spawn(python,[path.join(import.meta.dirname,'media_worker.py')],{windowsHide:true,signal,stdio:['pipe','pipe','ignore'],
      env:{...process.env,PYTHONUTF8:'1'}});
    let result='';
    child.stdout.on('data',chunk=>{result+=chunk;if(result.length>2000)child.kill();});
    child.stdin.on('error',()=>{});
    const timer=setTimeout(()=>child.kill(),50_000);
    child.once('error',()=>reject(fault('原生语音播放中止，请查看微信录音。',409)));
    child.once('close',()=>{
      clearTimeout(timer);
      try { resolve(JSON.parse(result)); }
      catch { reject(fault('音频输出未完成，请查看微信。',409)); }
    });
    child.stdin.end(JSON.stringify(payload)+'\n');
  });
}
const playErrors={
  FOREGROUND:'没有核对到目标微信聊天和按住 Alt 的状态，请在微信确认联系人后重新准备。',
  INTERRUPTED:'播放期间 Alt 已松开或窗口已切换。请在微信核对是否有不完整的气泡。',
  CLIP_LENGTH:'语音需短于 25 秒，请缩短文字。',
  DEVICE:'音频播放失败，请核对虚拟音频设备与采样率。',
  CONFIG:'微信窗口或虚拟音频设备未核对成功。',
};

export class WeChatMediaSession {
  constructor(store,audio,calls,{root,fetchImpl=fetch,now=Date.now,accountReady=()=>calls.accountReady(),
    messages=actor=>readRows(root,actor,fetchImpl),play=(payload,signal)=>playback(root,payload,signal),
    ownFor=async()=>(await reader(root,'/api/v1/reader/status',fetchImpl)).ownWxid,
    executable=()=>path.resolve(root,read(path.join(root,'config','wechatagent.json')).hook.wechatExecutable)}={}) {
    Object.assign(this,{store,audio,calls,now,accountReady,messages,play,ownFor,executable});
  }
  get(id) {
    if(!this.accountReady())throw fault('微信账号已切换。',409);
    if(!this.draft||this.draft.id!==id||this.draft.issued+expires<=this.now())throw fault('消息准备已过期，请重新准备。',409);
    return this.draft;
  }
  async contact(chat) {
    const target=(await this.calls.contactsFor()).find(row=>row.chat===chat);
    if(!target||target.ambiguous||actorChat(target.actor)!==chat)throw fault('请选择已允许且备注唯一的私聊联系人。',409);
    return target;
  }
  status() {
    const d=this.draft;
    return d&&this.accountReady()&&d.issued+expires>this.now()?
      {id:d.id,kind:d.kind,name:d.name,state:d.state,detail:d.detail??'',received:d.received??null} : {state:'idle'};
  }
  async prepare({chat,kind,text}={}) {
    if(this.busy||this.controller||this.draft?.state==='waiting'&&this.now()<=this.draft.armedAt+windowMs)throw fault('上一条消息仍在处理，请先核对或结束准备。',409);
    if(!this.accountReady()||!['pat','voice'].includes(kind))throw fault('请核对微信账号及消息类型。',409);
    if(kind==='voice'&&(typeof text!=='string'||!text.trim()||text.length>120||/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(text)))throw fault('语音正文需要 1–120 个字。');
    this.busy=true;
    try{
      const target=await this.contact(chat);
      const sample=kind==='voice'?await this.audio.sample({},text.trim()):null;
      if(!this.accountReady())throw fault('微信账号已切换。',409);
      this.draft={id:randomUUID(),kind,chat,actor:target.actor,name:target.name,issued:this.now(),state:'ready',audio:sample?.audio};
      return {...this.status(),...(sample?{preview:sample}:{})};
    }finally{this.busy=false;}
  }
  async arm({id,confirmed}={}) {
    const d=this.get(id);
    if(confirmed!==true||d.state!=='ready'||this.busy)throw fault('需要先核对接收人和消息，已开始的准备不能重复提交。',409);
    if(this.calls.timer||this.calls.starting||this.audio.child)throw fault('请先退出通话监听和本地语音会话。',409);
    this.busy=true;
    try{
      const target=await this.contact(d.chat);
      if(target.actor!==d.actor||target.name!==d.name)throw fault('联系人信息已更新，请重新准备。',409);
      const settings=this.calls.settings();
      if(d.kind==='voice'&&(!settings.routeReady||!Number.isInteger(settings.outputDevice)||settings.outputDevice<0))throw fault('请先保存微信通话的虚拟麦克风输出路由。',409);
      const verified=await this.calls.verify(target);
      const [own,rows]=await Promise.all([this.ownFor(),this.messages(d.actor)]);
      if(!validActor(own)||own===d.actor||!this.accountReady())throw fault('读取账号或联系人无法核验。',409);
      if(d.kind==='voice'&&!Number.isSafeInteger(verified?.pid))throw fault('未能核对当前微信进程。',409);
      const executable=d.kind==='voice'?this.executable():null;
      Object.assign(d,{own,baseline:new Set(rows.map(rowId)),armedAt:this.now(),state:d.kind==='pat'?'waiting':'playing'});
      if(d.kind==='voice'){
        const controller=new AbortController();
        this.controller=controller;
        const guard=setInterval(()=>{
          let valid=false;
          try {valid=this.accountReady();}catch {}
          if(!valid){
            d.state='unknown';
            d.detail='微信账号已切换，原语音已停止。请在微信核对。';
            controller.abort();
          }
        },300);
        guard.unref();
        Promise.resolve().then(()=>this.play({audio:d.audio,device:settings.outputDevice,name:d.name,pid:verified.pid,executable},controller.signal))
          .then(result=>{
            if(this.draft!==d||this.controller!==controller||controller.signal.aborted)return;
            d.state=result.played?'waiting':'unknown';
            d.detail=result.played?'音频已播完。松开 Alt 让微信发送，然后核对回执。':playErrors[result.code]??'音频输出未完成，请查看微信。';
          },error=>{
            if(this.draft===d&&!controller.signal.aborted){d.state='unknown';d.detail=error.status?error.message:'音频输出未完成，请查看微信。';}
          }).finally(()=>{clearInterval(guard);if(this.controller===controller)this.controller=null;});
      }
      return this.status();
    }finally{this.busy=false;}
  }
  async check({id}={}) {
    const d=this.get(id);
    if(d.state==='confirmed'||d.state==='playing')return this.status();
    if(!['waiting','unknown'].includes(d.state)||!d.baseline)throw fault('请先开始回执核对。',409);
    if(this.now()>d.armedAt+windowMs){d.state='unknown';d.detail='回执核对已超时，请在微信检查，避免重复发送。';return this.status();}
    const target=await this.contact(d.chat);
    if(target.actor!==d.actor||target.name!==d.name||!this.accountReady())throw fault('账号或联系人已改变。',409);
    const rows=await this.messages(d.actor);
    if(this.get(id)!==d)return this.status();
    const matches=newMediaReceipts(rows,{...d,peer:d.actor});
    if(matches.length===1&&hasServerId(matches[0])&&d.state==='waiting'){
      d.state='confirmed';d.received=Number(matches[0].createTime);d.detail='已找到该私聊中新增的微信原生消息及服务端回执。';
      delete d.audio;
    }else if(matches.length>1){
      d.state='unknown';d.detail='发现多条候选消息，无法确认对应关系，请在微信核对。';
    }
    return this.status();
  }
  stop() {
    if(this.busy)throw fault('正在核对联系人，请等当前操作完成再结束。',409);
    this.close();
    return {state:'idle'};
  }
  close() { this.controller?.abort();this.controller=null;this.draft=null; }
}
