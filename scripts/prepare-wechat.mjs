import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {prepareWeChatComponents,ensureHookToken} from './wechat-components.mjs';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
try{if(process.argv.includes('--token-only'))ensureHookToken(root);else await prepareWeChatComponents({root,onProgress:console.log});}catch(error){console.error('['+(error.code??'HOOK_COMPONENTS_MISSING')+'] '+(error.status?error.message:'微信组件准备未完成，请检查安装资源后重试。'));process.exitCode=1;}
