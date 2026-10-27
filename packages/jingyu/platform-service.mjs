import {Bilibili} from './bilibili.mjs';
import {actorChat,fault,hash} from './store.mjs';
export class PlatformService{
 constructor(store,{browser,fetchImpl=fetch}={}){this.store=store;this.browser=browser;this.bili=new Bilibili({fetchImpl,cookieFor:async()=>this.browser?.cookies?this.browser.cookies(store.account,'bilibili'):''});}
 async run(body){
  if(!body||body.account!==undefined&&body.account!==this.store.account)throw fault('微信账号已切换，请重新发起任务。',409);
  const {operation,args={}}=body;if(!args||typeof args!=='object'||Array.isArray(args))throw fault('平台任务参数无效。');
  if(operation==='bili.search')return this.bili.search(args.query,args.page??1);
  if(operation==='bili.popular')return this.bili.popular();
  if(operation==='bili.video')return this.bili.video(args.video);
  if(operation==='bili.comments')return this.bili.comments(args.video,args);
  if(!['browser.open','browser.snapshot','browser.act'].includes(operation))throw fault('不支持的平台动作。');
  if(!this.browser)throw fault('请从鲸鱼桌面程序打开平台窗口，网页版控制台不提供浏览器操作。',503);
  if(operation==='browser.open')return this.browser.open(this.store.account,args);
  if(operation==='browser.snapshot')return this.browser.snapshot(this.store.account,args);
  const requestId=body.requestId;if(typeof requestId!=='string'||!/^[a-f0-9]{64}$/.test(requestId))throw fault('平台操作缺少有效请求编号。');
  const digest=hash(JSON.stringify(args)),previous=this.store.db.prepare('SELECT * FROM jobs WHERE id=?').get(requestId);
  if(previous){if(previous.payload!==digest)throw fault('请求编号已被其他动作使用。',409);if(previous.state==='succeeded')return {...JSON.parse(previous.result),cached:true};throw fault('该动作之前已经提交，结果未确认；请先查看当前页面，不能重复加购。',409);}
  const now=Date.now();this.store.db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run(requestId,'platform',actorChat(this.store.settings().ownerWxid),'desktop',digest,'running',null,now,now);
  try{const result=await this.browser.act(this.store.account,args);this.store.db.prepare('UPDATE jobs SET state=?,result=?,updated=? WHERE id=?').run('succeeded',JSON.stringify(result),Date.now(),requestId);return result;}
  catch(error){this.store.db.prepare('UPDATE jobs SET state=?,updated=? WHERE id=?').run('unknown',Date.now(),requestId);throw error;}
 }
}
