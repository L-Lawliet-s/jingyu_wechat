import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';
import {runtimeSpec,managedDirectory,assertManagedPath,findPython,pythonStatus,chooseWheel,downloadVerified,ensurePython,configureReaderPython,unpackSrt} from '../packages/jingyu/python-runtime.mjs';
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'jingyu-python-test-'));t.after(()=>{assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});return root;}
function ready(root,purpose='reader',text='runtime'){const dir=managedDirectory(root,purpose);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'python.exe'),text);fs.writeFileSync(path.join(dir,'READY.json'),JSON.stringify({revision:runtimeSpec(purpose).revision}));return path.join(dir,'python.exe');}

test('runtime discovery never searches PATH or accepts the old user-supplied Python setting',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify({runtime:{python:process.execPath}}));const before=fs.readdirSync(root);
 assert.equal(findPython(root),null);assert.equal(pythonStatus(root).ready,false);assert.deepEqual(fs.readdirSync(root),before);
 const exe=ready(root);assert.equal(findPython(root).executable,exe);assert.equal(pythonStatus(root).ready,true);
});
test('bundled reader and existing app-owned audio environments are found without manual configuration',t=>{
 const root=fixture(t),bundle=path.join(root,'bundled');fs.mkdirSync(bundle);fs.writeFileSync(path.join(bundle,'python.exe'),'fixture');fs.mkdirSync(path.join(root,'config'));fs.writeFileSync(path.join(root,'config/distribution.json'),JSON.stringify({python:path.join(bundle,'python.exe')}));assert.equal(findPython(root).source,'bundled');assert.equal(findPython(root,'audio'),null);
 const legacy=path.join(root,'state/audio-venv');fs.mkdirSync(path.join(legacy,'Scripts'),{recursive:true});fs.mkdirSync(path.join(legacy,'Lib/site-packages/vosk'),{recursive:true});fs.writeFileSync(path.join(legacy,'Scripts/python.exe'),'fixture');fs.writeFileSync(path.join(legacy,'Lib/site-packages/vosk/__init__.py'),'');fs.writeFileSync(path.join(legacy,'Lib/site-packages/sounddevice.py'),'');assert.equal(findPython(root,'audio').source,'existing');
});
test('only compatible x64 wheels can be selected',()=>{
 const file=filename=>({filename,packagetype:'bdist_wheel'}),chosen=chooseWheel({urls:[file('a-1-cp313-cp313-win32.whl'),file('a-1-cp313-cp313-manylinux_x86_64.whl'),file('a-1-cp311-abi3-win_amd64.whl'),file('a-1-cp313-cp313-win_amd64.whl')]});assert.equal(chosen.filename,'a-1-cp313-cp313-win_amd64.whl');assert.equal(chooseWheel({urls:[file('a-1-cp313-cp313-win32.whl')]}),undefined);
});
test('bad hashes never install, and a verified download can be reused offline',async t=>{
 const root=fixture(t),file=path.join(root,'archive.zip'),bytes=Buffer.from('trusted-runtime');let requests=0;
 await assert.rejects(downloadVerified('https://files.pythonhosted.org/packages/fixture.zip',file,sha(bytes),{fetchImpl:async()=>new Response('wrong')}),/校验失败/);assert(!fs.existsSync(file));
 await downloadVerified('https://files.pythonhosted.org/packages/fixture.zip',file,sha(bytes),{fetchImpl:async()=>{requests++;return new Response(bytes);}});await downloadVerified('https://files.pythonhosted.org/packages/fixture.zip',file,sha(bytes),{fetchImpl:async()=>{throw Error('offline');}});assert.equal(requests,1);assert(fs.readFileSync(file).equals(bytes));
});
test('runtime writes and cleanup cannot traverse outside the managed directory or through junctions',t=>{
 const root=fixture(t);assert.throws(()=>assertManagedPath(root,root),/管理范围/);const outside=fixture(t);fs.mkdirSync(path.join(root,'state/python'),{recursive:true});const link=path.join(root,'state/python/link');fs.symlinkSync(outside,link,process.platform==='win32'?'junction':'dir');assert.throws(()=>assertManagedPath(root,path.join(link,'file')),/链接/);fs.unlinkSync(link);
});
test('failed replacement preserves the old environment and removes only its own staging directory',async t=>{
 const root=fixture(t),exe=ready(root,'reader','old');await assert.rejects(ensurePython(root,'reader',{probe:async()=>{throw Error('broken');},build:async(_root,stage)=>{fs.mkdirSync(stage,{recursive:true});fs.writeFileSync(path.join(stage,'python.exe'),'incomplete');throw Error('network');}}),/network/);assert.equal(fs.readFileSync(exe,'utf8'),'old');assert(!fs.readdirSync(path.join(root,'state/python')).some(name=>name.startsWith('.prepare-')||name.endsWith('.lock')));
});
test('concurrent preparation shares one operation and activates only the verified stage',async t=>{
 const root=fixture(t);let count=0;const options={probe:async()=>{},build:async(_root,stage,purpose)=>{count++;await new Promise(resolve=>setTimeout(resolve,5));fs.mkdirSync(stage,{recursive:true});fs.writeFileSync(path.join(stage,'python.exe'),'verified');fs.writeFileSync(path.join(stage,'READY.json'),JSON.stringify({revision:runtimeSpec(purpose).revision}));}};
 const [a,b]=await Promise.all([ensurePython(root,'reader',options),ensurePython(root,'reader',options)]);assert.equal(a,b);assert.equal(count,1);assert.equal(findPython(root).executable,a);assert.equal(fs.readFileSync(a,'utf8'),'verified');
});
test('automatic configuration updates only the internal interpreter field',t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'config'));const config={runtime:{python:'python',dshDesktop:'keep'},wechat:{whitelist:{private:['123']}},persona:{default:'keep'}};fs.writeFileSync(path.join(root,'config/wechatagent.json'),JSON.stringify(config));const exe=ready(root);configureReaderPython(root,exe);const actual=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json')));assert.equal(actual.runtime.python,exe);delete actual.runtime.python;delete config.runtime.python;assert.deepEqual(actual,config);
});
test('invalid srt archives are rejected instead of executing package build scripts',t=>{
 const root=fixture(t);assert.throws(()=>unpackSrt(Buffer.from('invalid gzip'),root));assert.deepEqual(fs.readdirSync(root),[]);
});
