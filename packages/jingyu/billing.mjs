import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fault,hash} from './store.mjs';

export function windowsSecret(value,protect=true){
  if(process.platform!=='win32')throw fault('此密钥存储需要 Windows 当前用户加密。');
  const script=`Add-Type -AssemblyName System.Security; $s=[Console]::In.ReadToEnd(); $bytes=[Convert]::FromBase64String($s); $r=[Security.Cryptography.ProtectedData]::${protect?'Protect':'Unprotect'}($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($r))`;
  const exe=path.join(process.env.SystemRoot??'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const result=spawnSync(exe,['-NoProfile','-NonInteractive','-Command',script],{input:protect?Buffer.from(value,'utf8').toString('base64'):value,encoding:'utf8',windowsHide:true,timeout:10000});
  if(result.status!==0||result.error||!/^[A-Za-z0-9+/=]+$/.test(result.stdout.trim()))throw fault('无法访问当前 Windows 用户的密钥存储。',503);
  return protect?result.stdout.trim():Buffer.from(result.stdout.trim(),'base64').toString('utf8');
}

export class Billing{
  constructor(store,{fetchImpl=fetch,crypt=windowsSecret,now=Date.now}={}){Object.assign(this,{store,fetchImpl,crypt,now});this.file=path.join(store.directory,'deepseek-key.dpapi');this.cached=null;this.inflight=null;}
  configured(){return fs.existsSync(this.file);}
  setKey(key){if(typeof key!=='string'||key.length<10||key.length>512||/[\s\x00-\x1f]/.test(key))throw fault('API Key 格式无效。');const encrypted=this.crypt(key,true);fs.writeFileSync(this.file+'.tmp',encrypted,{mode:0o600});fs.renameSync(this.file+'.tmp',this.file);this.cached=null;}
  clear(){if(fs.existsSync(this.file))fs.unlinkSync(this.file);this.cached=null;}
  async balance({refresh=false}={}){
    if(!this.configured())return {configured:false,available:null,balances:[],updatedAt:null,notice:'尚未绑定 DeepSeek API Key；此处不代表 DSH 账号登录额度。'};
    const fingerprint=hash(fs.readFileSync(this.file,'utf8'));
    if(this.cachedFingerprint!==fingerprint)this.cached=null;
    if(!refresh&&this.cached&&this.now()-this.cached.updatedAt<60000)return {...this.cached,cached:true};
    if(this.inflight&&this.inflightFingerprint===fingerprint)return this.inflight;
    this.inflightFingerprint=fingerprint;
    const request=this.query(fingerprint).finally(()=>{if(this.inflight===request)this.inflight=null;});this.inflight=request;return request;
  }
  async query(fingerprint){
    try{
      const key=this.crypt(fs.readFileSync(this.file,'utf8'),false);
      const response=await this.fetchImpl('https://api.deepseek.com/user/balance',{method:'GET',headers:{Authorization:'Bearer '+key},redirect:'error',signal:AbortSignal.timeout(5000)});
      if(!response.ok)throw fault(response.status===401?'API Key 无效或已失效。':'余额服务暂不可用。',503);
      const raw=await response.text();if(raw.length>16000)throw fault('余额响应过大。',503);const body=JSON.parse(raw);
      const money=value=>typeof value==='string'&&/^\d{1,12}(\.\d{1,8})?$/.test(value);
      if(typeof body.is_available!=='boolean'||!Array.isArray(body.balance_infos)||body.balance_infos.length>4||body.balance_infos.some(row=>!['CNY','USD'].includes(row.currency)||!['total_balance','granted_balance','topped_up_balance'].every(k=>money(row[k]))))throw fault('余额服务返回的数据格式无效。',503);
      if(!this.configured()||hash(fs.readFileSync(this.file,'utf8'))!==fingerprint)throw fault('余额账户已变化，请重新查询。',409);
      this.cachedFingerprint=fingerprint;this.cached={configured:true,available:body.is_available,balances:body.balance_infos.map(row=>({currency:row.currency,total:row.total_balance,granted:row.granted_balance,toppedUp:row.topped_up_balance})),updatedAt:this.now(),cached:false,stale:false};return this.cached;
    }catch(error){return {configured:true,available:null,balances:this.cached?.balances??[],updatedAt:this.cached?.updatedAt??null,stale:true,error:['API Key 无效或已失效。','余额服务暂不可用。','余额服务返回的数据格式无效。'].includes(error.message)?error.message:'余额查询失败，请检查连接或重新保存 API Key。'};}
  }
}
