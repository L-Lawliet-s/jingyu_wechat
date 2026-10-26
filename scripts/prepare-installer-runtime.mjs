import fs from 'node:fs';
import path from 'node:path';
import {projectRoot} from './project-config.mjs';
import {ensurePython} from '../packages/jingyu/python-runtime.mjs';

// Installer and source builds use the same version, hashes and import checks.
const executable=await ensurePython(projectRoot,'reader',{onProgress:console.log});
const runtime=path.resolve(projectRoot,'state/installer-stage/runtime/python');
if(!runtime.startsWith(path.resolve(projectRoot,'state/installer-stage')+path.sep))throw Error('Invalid installer runtime path');
for(let current=runtime;current!==path.dirname(current);current=path.dirname(current))if(fs.existsSync(current)&&fs.lstatSync(current).isSymbolicLink())throw Error('Installer runtime cannot contain links');
fs.mkdirSync(runtime,{recursive:true});
fs.cpSync(path.dirname(executable),runtime,{recursive:true,filter:file=>!fs.lstatSync(file).isSymbolicLink()});
console.log('Installer Python runtime prepared.');
