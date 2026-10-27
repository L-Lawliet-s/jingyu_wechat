import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {downloadVerified,extractZip} from './python-runtime.mjs';
export const SPEECH_MODEL={name:'vosk-model-small-cn-0.22',sha256:'3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba',url:'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip'};
export const speechModelDirectory=root=>path.resolve(root,'state/speech',SPEECH_MODEL.name);
function scope(root,target){const base=path.resolve(root,'state/speech');if(!path.resolve(target).startsWith(base+path.sep))throw Error('SPEECH_MODEL_PATH');for(let p=path.resolve(target);p!==path.dirname(p);p=path.dirname(p))if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw Error('SPEECH_MODEL_LINK');}
export async function ensureSpeechModel(root,{onProgress=()=>{},fetchImpl=fetch,extract=extractZip}={}){
 const directory=speechModelDirectory(root);scope(root,directory);if(fs.existsSync(path.join(directory,'am/final.mdl'))&&fs.existsSync(path.join(directory,'conf/model.conf')))return directory;
 const stage=path.resolve(root,'state/speech','.prepare-'+crypto.randomUUID()),archive=path.resolve(root,'state/speech/cache',SPEECH_MODEL.name+'.zip');scope(root,stage);scope(root,archive);fs.mkdirSync(path.dirname(archive),{recursive:true});
 onProgress('正在自动准备中文语音识别模型，无需选择文件夹…');
 try{await downloadVerified(SPEECH_MODEL.url,archive,SPEECH_MODEL.sha256,{fetchImpl});await extract(archive,stage);const prepared=path.join(stage,SPEECH_MODEL.name);if(!fs.existsSync(path.join(prepared,'am/final.mdl')))throw Error('SPEECH_MODEL_INVALID');
  const backup=directory+'.previous-'+crypto.randomUUID();let previous=false;if(fs.existsSync(directory)){scope(root,directory);scope(root,backup);fs.renameSync(directory,backup);previous=true;}
  try{fs.renameSync(prepared,directory);}catch(error){if(previous)fs.renameSync(backup,directory);throw error;}return directory;
 }finally{if(fs.existsSync(stage)){scope(root,stage);fs.rmSync(stage,{recursive:true,force:true});}}
}
