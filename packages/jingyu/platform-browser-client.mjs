import fs from 'node:fs';
import path from 'node:path';
import {fault} from './store.mjs';
export async function desktopPlatform(root,body,{fetchImpl=fetch,route='/api/jingyu/platform'}={}){
 if(!/^\/api\/jingyu\/(?:platform|call\/(?:listen|stop-listening|start|hangup|status|contacts))$/.test(route))throw fault('桌面操作路径无效。');
 let runtime;try{runtime=JSON.parse(fs.readFileSync(path.join(root,'state/desktop/runtime.json'),'utf8'));}catch{throw fault('请打开当前项目的鲸鱼桌面程序。',503);}
 if(!Number.isInteger(runtime.port)||runtime.port<1||runtime.port>65535||path.resolve(runtime.root).toLowerCase()!==path.resolve(root).toLowerCase())throw fault('桌面程序不属于当前项目，请重新打开。',503);
 const base='http://127.0.0.1:'+runtime.port,info=await fetchImpl(base+'/api/info',{signal:AbortSignal.timeout(5000)}).then(response=>response.json());
 if(path.resolve(info.root).toLowerCase()!==path.resolve(root).toLowerCase())throw fault('桌面项目已切换。',409);
 const read=route.endsWith('/status')||route.endsWith('/contacts');
 const response=await fetchImpl(base+route,{method:read?'GET':'POST',headers:{'X-Console-Token':info.token,'Content-Type':'application/json'},...(!read?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(90000)}),result=await response.json();
 if(!response.ok)throw fault(result.error??'平台任务未完成，请查看桌面。',response.status);return result;
}
