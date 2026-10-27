import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {gunzipSync} from 'node:zlib';

export const PYTHON_VERSION='3.13.16';
export const PYTHON_ARCHIVE={name:`python-${PYTHON_VERSION}-embed-amd64.zip`,sha256:'97dae5274cc54867065e8d5a3226e48c35017ed332a0fdb0e27d5b5821961297'};
export const READER_PACKAGES=[['sqlcipher3','0.6.2'],['cryptography','50.0.2'],['zstandard','0.25.0'],['pycryptodome','3.23.0'],['Pillow','12.3.0'],['imageio-ffmpeg','0.6.0'],['cffi','2.0.0'],['pycparser','2.23']];
export const AUDIO_PACKAGES=[['vosk','0.3.45'],['sounddevice','0.5.3'],['cffi','2.0.0'],['pycparser','2.23'],['requests','2.34.2'],['urllib3','2.8.0'],['charset-normalizer','3.5.2'],['idna','3.20'],['certifi','2026.10.23'],['tqdm','4.70.1'],['colorama','0.4.6'],['websockets','17.3'],['srt','3.5.3']];
// Optional speech and UI drivers share the automatically managed audio runtime.
AUDIO_PACKAGES.push(['edge-tts','7.3.1'],['aiohttp','3.14.5'],['aiohappyeyeballs','2.7.1'],['aiosignal','1.4.0'],['attrs','26.1.0'],['frozenlist','1.8.0'],['multidict','7.2.1'],['propcache','0.5.4'],['yarl','1.25.1'],['typing-extensions','4.16.0'],['tabulate','0.10.0'],['uiautomation','2.0.29'],['comtypes','1.4.17'],['pywin32','312'],['imageio-ffmpeg','0.6.0']);
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const read=(file,fallback=null)=>{try{return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));}catch{return fallback;}};
const problem=message=>Object.assign(new Error(message),{status:503});
export function runtimeSpec(purpose='reader'){
 if(!['reader','audio'].includes(purpose))throw problem('运行环境类型无效。');
 const packages=purpose==='reader'?READER_PACKAGES:AUDIO_PACKAGES;
 return {purpose,packages,revision:digest(JSON.stringify({version:PYTHON_VERSION,packages,layout:1})).slice(0,16)};
}
export function managedDirectory(root,purpose='reader'){const spec=runtimeSpec(purpose);return path.resolve(root,'state/python',purpose+'-'+spec.revision);}

// This check runs before writes, extraction, cleanup, or replacement of a runtime.
export function assertManagedPath(root,target){
 const base=path.resolve(root,'state/python'),resolved=path.resolve(target);
 if(!resolved.startsWith(base+path.sep))throw problem('运行环境位置不在本项目管理范围内。');
 for(let current=resolved;current!==path.dirname(current);current=path.dirname(current))if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw problem('运行环境目录不能包含链接。');
 return resolved;
}

export function findPython(root,purpose='reader'){
 const spec=runtimeSpec(purpose),directory=managedDirectory(root,purpose),marker=read(path.join(directory,'READY.json'));
 if(marker?.revision===spec.revision&&fs.existsSync(path.join(directory,'python.exe'))){assertManagedPath(root,directory);return {executable:path.join(directory,'python.exe'),source:'managed'};}
 const distribution=read(path.join(root,'config/distribution.json')),bundled=distribution?.python;
 if(typeof bundled==='string'&&path.isAbsolute(bundled)&&fs.existsSync(bundled)){
  const dependencies=read(path.join(path.dirname(bundled),'DEPENDENCIES.json'),[]);
  if(purpose==='reader'||Array.isArray(dependencies)&&['vosk','sounddevice'].every(name=>dependencies.some(item=>item.name===name)))return {executable:bundled,source:'bundled'};
 }
 // Migrate the previous app-owned audio environment without asking for a path.
 const legacy=path.join(root,'state/audio-venv');
 if(purpose==='audio'&&fs.existsSync(path.join(legacy,'Scripts/python.exe'))&&fs.existsSync(path.join(legacy,'Lib/site-packages/vosk/__init__.py'))&&fs.existsSync(path.join(legacy,'Lib/site-packages/sounddevice.py')))return {executable:path.join(legacy,'Scripts/python.exe'),source:'existing'};
 return null;
}
export function pythonStatus(root,purpose='reader'){
 const found=findPython(root,purpose),button=purpose==='audio'?'一键准备语音环境':'一键准备环境';return {ready:!!found,source:found?.source??null,message:found?'已自动准备，无需选择程序或填写路径。':`尚未准备，点击“${button}”后自动下载并配置。`};
}

async function command(exe,args,{input='',timeout=30000}={}){
 return new Promise((resolve,reject)=>{
  const child=spawn(exe,args,{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONUTF8:'1'}});let output='';
  const timer=setTimeout(()=>{child.kill();reject(problem('环境准备等待超时，请检查网络后重试。'));},timeout);
  child.stdin.on('error',()=>{});child.stdout.on('data',data=>{output+=data;if(output.length>128000)child.kill();});child.stderr.on('data',()=>{});
  child.once('error',()=>{clearTimeout(timer);reject(problem('无法启动自动环境准备程序。'));});
  child.once('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(problem('运行环境检查未通过，请点击“一键准备环境”重试。'));});child.stdin.end(input);
 });
}
export async function probePython(executable,purpose='reader'){
 const code=purpose==='reader'?'import sqlcipher3,cryptography,zstandard,Crypto,PIL,imageio_ffmpeg; from sqlcipher3 import dbapi2; db=dbapi2.connect(":memory:"); assert db.execute("select 1").fetchone()==(1,)':'import vosk,sounddevice,requests,srt,tqdm,websockets,edge_tts,imageio_ffmpeg,uiautomation,win32gui';
 const output=await command(executable,['-I','-B','-c',`import sys; assert sys.version_info[:2] == (3,13); ${code}; print("JINGYU_RUNTIME_READY")`]);
 if(!output.includes('JINGYU_RUNTIME_READY'))throw problem('自动环境检查未通过。');
}
export async function extractZip(archive,target){
 const script=`$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.Encoding]::UTF8; $p=[Console]::In.ReadToEnd()|ConvertFrom-Json; Add-Type -AssemblyName System.IO.Compression.FileSystem; $base=[IO.Path]::GetFullPath($p.target)+[IO.Path]::DirectorySeparatorChar; [IO.Directory]::CreateDirectory($p.target)|Out-Null; $zip=[IO.Compression.ZipFile]::OpenRead($p.archive); try { $total=0L; foreach($entry in $zip.Entries){ $total+=$entry.Length; if($total -gt 1073741824 -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960){throw 'Invalid archive'}; $file=[IO.Path]::GetFullPath([IO.Path]::Combine($p.target,$entry.FullName)); if(-not $file.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)){throw 'Archive path outside runtime'}; if($entry.FullName.EndsWith('/')){[IO.Directory]::CreateDirectory($file)|Out-Null}else{[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($file))|Out-Null; [IO.Compression.ZipFileExtensions]::ExtractToFile($entry,$file,$true)} } }finally{$zip.Dispose()}`;
 const exe=path.join(process.env.SystemRoot??'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
 await command(exe,['-NoProfile','-NonInteractive','-Command',script],{input:JSON.stringify({archive:path.resolve(archive),target:path.resolve(target)})});
}
export function chooseWheel(metadata){
 const candidates=(metadata.urls??[]).filter(file=>file.packagetype==='bdist_wheel'&&/-((cp313-cp313|cp(?:37|38|39|310|311|312)-abi3)-win_amd64|(?:py2\.)?py3-none-(any|win_amd64))\.whl$/.test(file.filename));
 return candidates.find(file=>file.filename.includes('-cp313-cp313-'))??candidates.find(file=>file.filename.endsWith('-win_amd64.whl'))??candidates[0];
}

// srt 3.5.3 only publishes an sdist. Copy its reviewed pure Python module and
// license, instead of executing setup.py or requiring a system compiler/pip.
export function unpackSrt(bytes,site){
 const tar=gunzipSync(bytes,{maxOutputLength:8*1024*1024});let module,license;
 for(let at=0;at+512<=tar.length;){
  const header=tar.subarray(at,at+512),name=header.subarray(0,100).toString().replace(/\0.*$/s,''),rawSize=header.subarray(124,136).toString().replace(/\0.*$/s,'').trim();if(!name)break;
  if(!/^[0-7]+$/.test(rawSize))throw problem('语音依赖归档格式无效。');const size=parseInt(rawSize,8);if(size>tar.length-at-512)throw problem('语音依赖归档不完整。');
  const content=tar.subarray(at+512,at+512+size);if(header[156]===0||header[156]===48){if(name==='srt-3.5.3/srt.py')module=content;if(name==='srt-3.5.3/LICENSE')license=content;}
  at+=512+Math.ceil(size/512)*512;
 }
 if(!module||!license)throw problem('语音依赖缺少程序或许可文件。');fs.mkdirSync(path.join(site,'licenses'),{recursive:true});fs.writeFileSync(path.join(site,'srt.py'),module);fs.writeFileSync(path.join(site,'licenses/srt-LICENSE'),license);
}

async function fetchJson(url,fetchImpl){const response=await fetchImpl(url,{signal:AbortSignal.timeout(20000),redirect:'error'});if(!response.ok)throw problem('无法获取依赖信息，请检查网络后重试。');return response.json();}
export async function downloadVerified(url,file,sha256,{fetchImpl=fetch}={}){
 if(!/^[a-f0-9]{64}$/.test(sha256))throw problem('下载文件缺少完整校验信息。');
 if(fs.existsSync(file)&&digest(fs.readFileSync(file))===sha256)return;
 const parsed=new URL(url);if(parsed.protocol!=='https:'||!['www.python.org','files.pythonhosted.org','alphacephei.com'].includes(parsed.hostname))throw problem('下载来源无效。');
 const urls=[url];if(parsed.hostname==='files.pythonhosted.org')urls.push('https://pypi.tuna.tsinghua.edu.cn'+parsed.pathname);
 for(const candidate of urls){
  try{
   const response=await fetchImpl(candidate,{signal:AbortSignal.timeout(90000),redirect:'error'});if(!response.ok)continue;
   const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>150*1024*1024)throw problem('下载文件超出允许大小。');chunks.push(chunk);}const bytes=Buffer.concat(chunks);
   if(digest(bytes)!==sha256)throw problem('运行文件校验失败，未安装。');fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,bytes);fs.renameSync(temp,file);return;
  }catch(error){if(error.message==='运行文件校验失败，未安装。')throw error;}
 }
 throw problem('自动下载未完成，请检查网络后再次点击准备；无需手动选择 Python。');
}

export async function buildPython(root,target,purpose='reader',{fetchImpl=fetch,onProgress=()=>{},extract=extractZip,probe=probePython}={}){
 assertManagedPath(root,target);const {packages,revision}=runtimeSpec(purpose),cache=path.resolve(root,'state/python/cache');assertManagedPath(root,cache);fs.mkdirSync(target,{recursive:true});
 onProgress('正在下载并校验独立运行环境…');const archive=path.join(cache,PYTHON_ARCHIVE.name);
 await downloadVerified(`https://www.python.org/ftp/python/${PYTHON_VERSION}/${PYTHON_ARCHIVE.name}`,archive,PYTHON_ARCHIVE.sha256,{fetchImpl});await extract(archive,target);
 const site=path.join(target,'Lib/site-packages'),locked=[];fs.mkdirSync(site,{recursive:true});
 for(let index=0;index<packages.length;index++){
  const [name,version]=packages[index];onProgress(`正在准备${purpose==='audio'?'语音':'微信读取'}组件（${index+1}/${packages.length}）…`);
  const metadata=await fetchJson(`https://pypi.org/pypi/${name}/${version}/json`,fetchImpl),file=name==='srt'?metadata.urls?.find(file=>file.packagetype==='sdist'&&file.filename==='srt-3.5.3.tar.gz'):chooseWheel(metadata);
  if(!file||typeof file.filename!=='string'||file.filename!==path.basename(file.filename)||/[\\/]/.test(file.filename))throw problem('未找到兼容的运行组件：'+name);
  const cached=path.join(cache,file.filename);await downloadVerified(file.url,cached,file.digests?.sha256,{fetchImpl});
  if(name==='srt')unpackSrt(fs.readFileSync(cached),site);else await extract(cached,site);
  locked.push({name,version,filename:file.filename,sha256:file.digests.sha256,url:file.url});
 }
 fs.writeFileSync(path.join(target,'python313._pth'),'python313.zip\n.\nLib/site-packages\n'+(purpose==='audio'?'Lib/site-packages/win32\nLib/site-packages/win32/lib\nLib/site-packages/pywin32_system32\n':'')+'import site\n');fs.writeFileSync(path.join(target,'DEPENDENCIES.json'),JSON.stringify(locked,null,2));
 onProgress('正在验证运行环境…');await probe(path.join(target,'python.exe'),purpose);fs.writeFileSync(path.join(target,'READY.json'),JSON.stringify({purpose,version:PYTHON_VERSION,revision}));return path.join(target,'python.exe');
}

const pending=new Map();
export function ensurePython(root,purpose='reader',options={}){
 const key=path.resolve(root)+'\0'+purpose;if(pending.has(key))return pending.get(key);
 const promise=preparePython(root,purpose,options).finally(()=>pending.delete(key));pending.set(key,promise);return promise;
}
async function preparePython(root,purpose,{onProgress=()=>{},probe=probePython,build=buildPython,...options}={}){
 if(process.platform!=='win32'||process.arch!=='x64')throw problem('自动环境适用于 Windows x64。');
 const found=findPython(root,purpose);if(found){try{await probe(found.executable,purpose);onProgress('已自动找到可用环境，无需填写路径。');return found.executable;}catch{onProgress('现有环境不完整，正在自动重新准备…');}}
 const directory=managedDirectory(root,purpose),lock=path.resolve(root,'state/python',purpose+'.lock');assertManagedPath(root,lock);fs.mkdirSync(path.dirname(lock),{recursive:true});
 const token=crypto.randomUUID();let owned=false,stage;
 try{
  try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token}),{flag:'wx'});owned=true;}catch(error){
   if(error.code!=='EEXIST')throw error;const previous=read(lock);let alive=true;try{if(Number.isSafeInteger(previous?.pid)&&previous.pid>0)process.kill(previous.pid,0);else throw Error();}catch(error){alive=error.code==='EPERM';}
   if(alive)throw problem('已有运行环境准备任务，请等待完成后重试。');fs.unlinkSync(lock);fs.writeFileSync(lock,JSON.stringify({pid:process.pid,token}),{flag:'wx'});owned=true;
  }
  stage=path.resolve(root,'state/python','.prepare-'+purpose+'-'+token);assertManagedPath(root,stage);await build(root,stage,purpose,{...options,onProgress,probe});
  assertManagedPath(root,directory);let previous;
  if(fs.existsSync(directory)){previous=directory+'.previous-'+token;assertManagedPath(root,previous);fs.renameSync(directory,previous);}
  try{fs.renameSync(stage,directory);}catch(error){if(previous)fs.renameSync(previous,directory);throw error;}
  onProgress('运行环境已准备，可以继续连接。');return path.join(directory,'python.exe');
 }finally{
  if(stage&&fs.existsSync(stage)){assertManagedPath(root,stage);fs.rmSync(stage,{recursive:true,force:true});}
  if(owned&&read(lock)?.token===token)fs.unlinkSync(lock);
 }
}
export function configureReaderPython(root,executable){
 const file=path.join(root,'config/wechatagent.json'),config=read(file)??read(path.join(root,'config/wechatagent.example.json'));if(!config?.runtime)throw problem('请先准备项目配置。');
 if(config.runtime.python!==executable){config.runtime.python=executable;fs.mkdirSync(path.dirname(file),{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(config,null,2)+'\n');fs.renameSync(temp,file);}
}
