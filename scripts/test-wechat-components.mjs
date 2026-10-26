import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {ensureHookToken,prepareWeChatComponents,wechatComponentsStatus} from './wechat-components.mjs';
import {discoverReaderAccounts} from './reader-setup.mjs';
const sha=value=>crypto.createHash('sha256').update(value).digest('hex'),keyFile='components/weflow-cli/resources/key/win32/x64/wx_key.dll';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jingyu-components-'));t.after(()=>{assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});
 const write=(relative,value)=>{const file=path.join(root,relative);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof value==='string'?value:JSON.stringify(value));};
 const config=JSON.parse(fs.readFileSync('config/wechatagent.example.json','utf8'));write('config/wechatagent.json',config);
 const resources=path.join(root,'installer/resources'),native='fixture-native-dll',key='fixture-key-dll';
 write('installer/resources/vendor/wechat/Weixin.exe','signed-exe');write('installer/resources/vendor/wechat/4.1.10.27/Weixin.dll','signed-core');write('installer/resources/vendor/wechat/4.1.10.27/static.json','{}');
 for(const name of ['wechatagent-hook.token','data.db','state.log','WeFlow-config.json'])write('installer/resources/vendor/wechat/4.1.10.27/'+name,'MUST_NOT_COPY');
 write('installer/resources/vendor/hook/version.dll',native);write('installer/resources/vendor/hook/build.json',{targetVersion:'4.1.10.27',initialization:'deferred-module-v3',mutexCompatibility:'legacy-runtime-constructor-v1',exceptionDiagnostics:'seh-cpp-stage-v1',logWriter:'win32-srw-v1',sha256:sha(native)});
 write('installer/resources/project/'+keyFile,key);write('installer/resources/project/deployment.json',{sourceHashes:{[keyFile]:sha(key)}});
 return {root,write,resources,options:{root,sources:[resources],inspect:async()=>({version:'4.1.10.27',valid:true}),keyCheck:()=>true}};
}
test('first-use token creation is idempotent and never replaces an existing or invalid token',t=>{
 const f=fixture(t);assert.equal(ensureHookToken(f.root).created,true);const file=path.join(f.root,'state/hook/native-token.txt'),value=fs.readFileSync(file,'utf8');assert.match(value,/^[a-f0-9]{64}$/);assert.equal(ensureHookToken(f.root).created,false);assert.equal(fs.readFileSync(file,'utf8'),value);fs.writeFileSync(file,'invalid');assert.throws(()=>ensureHookToken(f.root),/格式无效/);assert.equal(fs.readFileSync(file,'utf8'),'invalid');
});
test('component import copies verified program resources without old tokens, databases or credentials',async t=>{
 const f=fixture(t),result=await prepareWeChatComponents(f.options);assert.equal(result.ready,true);assert.equal(wechatComponentsStatus(f.root).ready,true);assert.deepEqual(new Set(result.prepared),new Set(['client','native','reader-key']));
 const folder=path.join(f.root,'state/hook/wechat-4.1.10.27/4.1.10.27');for(const name of ['wechatagent-hook.token','data.db','state.log','WeFlow-config.json'])assert(!fs.existsSync(path.join(folder,name)));assert(fs.existsSync(path.join(folder,'static.json')));assert(!fs.existsSync(path.join(f.root,'state/weflow/WeFlow-config.json')));
 const token=fs.readFileSync(path.join(f.root,'state/hook/native-token.txt'),'utf8');assert.equal((await prepareWeChatComponents(f.options)).prepared.length,0);assert.equal(fs.readFileSync(path.join(f.root,'state/hook/native-token.txt'),'utf8'),token);
});
test('wrong client versions, invalid signatures and altered DLLs stop before activation',async t=>{
 for(const reason of ['version','signature','native','key']){const f=fixture(t);let options=f.options;
  if(reason==='version')options={...options,inspect:async()=>({version:'4.1.15.56',valid:true})};
  if(reason==='signature')options={...options,inspect:async()=>({version:'4.1.10.27',valid:false})};
  if(reason==='native')fs.appendFileSync(path.join(f.resources,'vendor/hook/version.dll'),'tampered');
  if(reason==='key')fs.appendFileSync(path.join(f.resources,'project',keyFile),'tampered');
  await assert.rejects(prepareWeChatComponents(options),/未找到/);assert(!fs.existsSync(path.join(f.root,'state/hook/wechat-4.1.10.27/Weixin.exe')));
 }
});
test('a non-owned installation target is refused',async t=>{
 const f=fixture(t),outside=fs.mkdtempSync(path.join(os.tmpdir(),'jingyu-external-'));t.after(()=>{assert(outside.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(outside,{recursive:true,force:true});});const config=JSON.parse(fs.readFileSync(path.join(f.root,'config/wechatagent.json')));config.hook.wechatExecutable=path.join(outside,'Weixin.exe');f.write('config/wechatagent.json',config);await assert.rejects(prepareWeChatComponents(f.options),/当前项目/);assert.deepEqual(fs.readdirSync(outside),[]);
});
test('a misconfigured client target cannot replace settings or persona directories',async t=>{
 const f=fixture(t);f.write('roles/keep.md','keep');const config=JSON.parse(fs.readFileSync(path.join(f.root,'config/wechatagent.json')));config.hook.wechatExecutable='roles/Weixin.exe';f.write('config/wechatagent.json',config);await assert.rejects(prepareWeChatComponents(f.options),/专用微信目录/);assert.equal(fs.readFileSync(path.join(f.root,'roles/keep.md'),'utf8'),'keep');assert(!fs.existsSync(path.join(f.root,'roles/Weixin.exe')));
});
test('discovery uses old storage directory hints without forwarding old account identities or keys',async t=>{
 const f=fixture(t);f.write('state/weflow/WeFlow-config.json',{dbPath:path.join(f.root,'custom-storage/wxid_previous'),myWxid:'wxid_previous',decryptKey:'DO_NOT_FORWARD'});const calls=[];
 const result=await discoverReaderAccounts({root:f.root,python:'fixture',setup:async({request})=>{calls.push(request);return {ok:true,accounts:request.dbPath?[{dbPath:path.join(request.dbPath,'wxid_current'),myWxid:'wxid_current',ready:true}]:[]};}});
 assert.equal(result.accounts.length,1);assert.equal(calls[1].dbPath,path.join(f.root,'custom-storage'));assert(!JSON.stringify(calls).includes('DO_NOT_FORWARD'));assert(!Object.hasOwn(calls[1],'decryptKey'));assert(!Object.hasOwn(calls[1],'myWxid'));
 calls.length=0;await discoverReaderAccounts({root:f.root,python:'fixture',dbPath:'explicit',setup:async({request})=>{calls.push(request);return {ok:true,accounts:[]};}});assert.equal(calls.length,1);assert.equal(calls[0].dbPath,'explicit');
});
