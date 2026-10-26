import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {verifyHookBuild} from './hook-build-policy.mjs';
import {windowsPowerShellExecutable,windowsPowerShellEnvironment} from './console-process.mjs';

const VERSION='4.1.10.27',KEY_FILE='components/weflow-cli/resources/key/win32/x64/wx_key.dll';
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const digest=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const failure=(code,message)=>Object.assign(new Error(message),{code,status:503});
function scoped(root,file){
 const base=path.resolve(root),target=path.resolve(file);if(!target.startsWith(base+path.sep))throw failure('HOOK_COMPONENT_PATH_INVALID','组件目标必须位于当前项目目录内。');
 for(let at=target;at!==path.dirname(at);at=path.dirname(at))if(fs.existsSync(at)&&fs.lstatSync(at).isSymbolicLink())throw failure('HOOK_COMPONENT_PATH_INVALID','组件目录不能包含链接。');return target;
}
export function ensureHookToken(root){
 const file=scoped(root,path.join(root,'state/hook/native-token.txt'));fs.mkdirSync(path.dirname(file),{recursive:true});let created=false;
 if(!fs.existsSync(file)){try{fs.writeFileSync(file,crypto.randomBytes(32).toString('hex'),{flag:'wx',mode:0o600});created=true;}catch(error){if(error.code!=='EEXIST')throw error;}}
 if(!/^[a-f0-9]{64}$/.test(fs.readFileSync(file,'utf8').trim()))throw failure('HOOK_TOKEN_INVALID','本机发送令牌格式无效，原文件已保留，请修复微信连接。');return {created};
}
function locations(root){
 const file=path.join(root,'config/wechatagent.json'),config=read(fs.existsSync(file)?file:path.join(root,'config/wechatagent.example.json'));
 const executable=path.resolve(root,config.hook.wechatExecutable);return {config,executable,client:path.dirname(executable),native:path.join(root,'state/hook/native'),key:path.join(root,KEY_FILE)};
}
export function wechatComponentsStatus(root){
 const {executable,client,native,key}=locations(root);let nativeReady=false;try{verifyHookBuild(native);nativeReady=true;}catch{}
 const token=path.join(root,'state/hook/native-token.txt');let tokenReady=false;try{tokenReady=/^[a-f0-9]{64}$/.test(fs.readFileSync(token,'utf8').trim());}catch{}
 const clientReady=fs.existsSync(executable)&&fs.existsSync(path.join(client,VERSION,'Weixin.dll')),keyReady=fs.existsSync(key);
 return {ready:clientReady&&nativeReady&&keyReady&&tokenReady,version:VERSION,items:[{id:'client',label:'匹配微信程序',ready:clientReady},{id:'native',label:'微信发送组件',ready:nativeReady},{id:'reader-key',label:'微信自动连接组件',ready:keyReady},{id:'token',label:'本机连接凭据',ready:tokenReady}]};
}
export function resourceSources(root){
 const sources=[];try{const value=read(path.join(root,'config/distribution.json')).assets;if(typeof value==='string'&&path.isAbsolute(value))sources.push(value);}catch{}
 sources.push(path.resolve(root,'../jingyu_runtime/app/resources'));return [...new Set(sources)].filter(file=>fs.existsSync(path.join(file,'project/deployment.json')));
}
export async function inspectWeChat(executable){
 return new Promise((resolve,reject)=>{
  const script="$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.Encoding]::UTF8; $p=[Console]::In.ReadToEnd()|ConvertFrom-Json; $s=Get-AuthenticodeSignature -LiteralPath $p; @{version=(Get-Item -LiteralPath $p).VersionInfo.FileVersion;valid=($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'Tencent')}|ConvertTo-Json -Compress";
  const child=spawn(windowsPowerShellExecutable(),['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,shell:false,env:windowsPowerShellEnvironment(),stdio:['pipe','pipe','ignore']});let output='';
  const timer=setTimeout(()=>{child.kill();reject(failure('HOOK_CLIENT_CHECK_FAILED','微信版本和签名检查超时。'));},15000);child.stdin.on('error',()=>{});child.stdout.on('data',chunk=>{output+=chunk;if(output.length>16000)child.kill();});
  child.once('error',()=>{clearTimeout(timer);reject(failure('HOOK_CLIENT_CHECK_FAILED','无法验证微信程序。'));});child.once('close',code=>{clearTimeout(timer);try{if(code!==0)throw Error();resolve(JSON.parse(output));}catch{reject(failure('HOOK_CLIENT_CHECK_FAILED','无法验证微信程序。'));}});child.stdin.end(JSON.stringify(executable));
 });
}
async function verifyClient(executable,inspect){
 const core=path.join(path.dirname(executable),VERSION,'Weixin.dll');if(!fs.existsSync(core))throw failure('HOOK_CLIENT_MISSING','匹配微信程序不完整。');
 for(const file of [executable,core]){const value=await inspect(file);if(value.version!==VERSION||value.valid!==true)throw failure('HOOK_VERSION_MISMATCH','需要完整且签名有效的微信 4.1.10.27；当前程序未修改。');}
}
function copyProgram(source,target){
 fs.mkdirSync(target,{recursive:true});for(const entry of fs.readdirSync(source,{withFileTypes:true})){
  if(entry.isSymbolicLink())throw failure('HOOK_COMPONENT_PATH_INVALID','程序资源包含链接，导入已停止。');
  if(/(?:^\.env|\.token$|\.log$|\.(?:db|sqlite|sqlite3)(?:-|$)|^(?:native-token\.txt|social-dsh-token\.txt|WeFlow-config\.json|social-messages\.json|account|accounts|user_data|userdata)$)/i.test(entry.name))continue;
  const from=path.join(source,entry.name),to=path.join(target,entry.name);if(entry.isDirectory())copyProgram(from,to);else if(entry.isFile())fs.copyFileSync(from,to);
 }
}
function validKey(file){try{const bytes=fs.readFileSync(file);const pe=bytes.readUInt32LE(0x3c);return bytes.subarray(0,2).toString()==='MZ'&&bytes.subarray(pe,pe+4).equals(Buffer.from([80,69,0,0]))&&bytes.readUInt16LE(pe+4)===0x8664;}catch{return false;}}

export async function prepareWeChatComponents({root,onProgress=()=>{},sources=resourceSources(root),inspect=inspectWeChat,keyCheck=validKey}={}){
 const token=ensureHookToken(root),target=locations(root),prepared=[];let needsClient=true,needsNative=true,needsKey=!(fs.existsSync(target.key)&&keyCheck(target.key));
 try{await verifyClient(target.executable,inspect);needsClient=false;}catch{}
 try{verifyHookBuild(target.native);needsNative=false;}catch{}
 if(!needsClient&&!needsNative&&!needsKey)return {ready:true,prepared,tokenCreated:token.created};
 let source;
 for(const resources of sources){
  try{
   const client=path.join(resources,'vendor/wechat/Weixin.exe'),native=path.join(resources,'vendor/hook'),key=path.join(resources,'project',KEY_FILE),manifest=read(path.join(resources,'project/deployment.json'));
   if(needsClient)await verifyClient(client,inspect);if(needsNative)verifyHookBuild(native);
   if(needsKey&&(!/^[a-f0-9]{64}$/.test(manifest.sourceHashes?.[KEY_FILE]??'')||digest(key)!==manifest.sourceHashes[KEY_FILE]||!keyCheck(key)))continue;
   source={resources,client,native,key};break;
  }catch{}
 }
 if(!source)throw failure('HOOK_COMPONENTS_MISSING','未找到可验证的完整微信组件。请先准备匹配微信和发送组件，或保留旧安装版的原始程序资源后点击“自动准备微信组件”。原账号数据未改动。');
 const stage=scoped(root,path.join(root,'state/hook/.prepare-'+crypto.randomUUID())),plans=[];fs.mkdirSync(stage,{recursive:true});
 try{
  if(needsClient){
   scoped(root,target.client);if(path.resolve(target.executable).toLowerCase()!==path.resolve(root,'state/hook/wechat-4.1.10.27/Weixin.exe').toLowerCase())throw failure('HOOK_COMPONENT_PATH_INVALID','自动准备只会写入项目专用微信目录，请将匹配微信程序位置恢复为 state/hook/wechat-4.1.10.27/Weixin.exe。');
   onProgress('正在从原始安装资源准备独立匹配微信，不导入账号和聊天数据…');const client=path.join(stage,'client');fs.mkdirSync(client);fs.copyFileSync(source.client,path.join(client,'Weixin.exe'));copyProgram(path.join(path.dirname(source.client),VERSION),path.join(client,VERSION));await verifyClient(path.join(client,'Weixin.exe'),inspect);plans.push({from:client,to:target.client});prepared.push('client');
  }
  if(needsNative){onProgress('正在校验并准备微信发送组件…');const native=path.join(stage,'native');fs.mkdirSync(native);for(const file of ['version.dll','build.json'])fs.copyFileSync(path.join(source.native,file),path.join(native,file));verifyHookBuild(native);plans.push({from:native,to:target.native});prepared.push('native');}
  if(needsKey){onProgress('正在校验并准备微信自动连接组件…');const key=path.join(stage,'wx_key.dll');fs.copyFileSync(source.key,key);if(digest(key)!==digest(source.key))throw failure('READER_KEY_COMPONENT_MISSING','自动连接组件复制校验失败。');plans.push({from:key,to:target.key});prepared.push('reader-key');}
  const backup=scoped(root,path.join(root,'state/hook/.component-backup-'+crypto.randomUUID())),applied=[];
  try{for(const [index,plan]of plans.entries()){
   scoped(root,plan.to);fs.mkdirSync(path.dirname(plan.to),{recursive:true});const saved=path.join(backup,String(index));if(fs.existsSync(plan.to)){fs.mkdirSync(backup,{recursive:true});fs.renameSync(plan.to,saved);}
   try{fs.renameSync(plan.from,plan.to);applied.push({...plan,saved:fs.existsSync(saved)?saved:null});}catch(error){if(fs.existsSync(saved))fs.renameSync(saved,plan.to);throw error;}
  }}catch(error){for(const plan of applied.reverse()){scoped(root,plan.to);fs.renameSync(plan.to,plan.from);if(plan.saved)fs.renameSync(plan.saved,plan.to);}throw failure('HOOK_COMPONENT_IN_USE','微信组件正在使用或无法写入，原组件已保留。请退出项目匹配微信后重试。');}
  onProgress('微信组件和本机连接凭据已准备，请使用项目入口打开匹配微信。');return {ready:true,prepared,tokenCreated:token.created};
 }finally{if(fs.existsSync(stage)){scoped(root,stage);fs.rmSync(stage,{recursive:true,force:true});}}
}
