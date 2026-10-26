import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {ensurePython,findPython,configureReaderPython} from '../packages/jingyu/python-runtime.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),purpose=process.argv.includes('--audio')?'audio':'reader';
try{
 const python=process.argv.includes('--resolve')?findPython(root,purpose)?.executable:await ensurePython(root,purpose,{onProgress:message=>console.log(message)});
 if(!python)throw Error('运行环境尚未准备，请在首次配置中点击“一键准备环境”。');
 if(process.argv.includes('--configure')&&purpose==='reader')configureReaderPython(root,python);
 if(process.argv.includes('--resolve'))process.stdout.write(python);else console.log(purpose==='audio'?'语音环境已就绪。':'微信读取环境已就绪。');
}catch(error){console.error(error.status?error.message:'自动准备未完成，请检查网络后重试；无需手动配置 Python。');process.exitCode=1;}
