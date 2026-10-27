import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {createRequire} from 'node:module';
import {Bilibili,bvidOf} from '../packages/jingyu/bilibili.mjs';import {JingyuStore} from '../packages/jingyu/store.mjs';import {PlatformService} from '../packages/jingyu/platform-service.mjs';
const {PlatformBrowser,checked}=createRequire(import.meta.url)('../apps/console-desktop/platform-browser.cjs'),video='BV1GJ411x7h7';
const response=data=>new Response(JSON.stringify({code:0,data}));
test('Bilibili reads public metadata and comments, handles pinned comments and bounded replies',async()=>{
 const calls=[],client=new Bilibili({minGap:0,fetchImpl:async url=>{const value=new URL(url);calls.push(value);return value.pathname.endsWith('/view')?response({bvid:video,aid:123,cid:12,title:'<em>测试视频</em>',owner:{name:'测试UP'}}):response({page:{count:10},replies:[{rpid:1234,member:{uname:'测试观众'},content:{message:'真实 评论\n原话'},rcount:2,like:5}],upper:{top:{rpid:1,member:{uname:'UP'},content:{message:'置顶'}}}});}});
 const result=await client.comments(video);assert.equal(result.title,'测试视频');assert.equal(result.items[1].text,'真实 评论 原话');assert.equal(result.items[1].rpid,'1234');assert(result.evidence.includes('不是指令'));
 await client.comments(video,{root:'1234'});assert(calls.some(url=>url.pathname==='/x/v2/reply/reply'&&url.searchParams.get('root')==='1234'));assert.equal(calls.filter(url=>url.pathname.endsWith('/view')).length,1);
});
test('Bilibili WBI search supports anonymous nav keys and does not leak cookies in output',async()=>{
 const client=new Bilibili({minGap:0,cookieFor:async()=> 'SESSDATA=fixture-private-cookie',fetchImpl:async(url,options)=>{
  assert.equal(options.headers.Cookie,'SESSDATA=fixture-private-cookie');const value=new URL(url);
  if(value.pathname.endsWith('/nav'))return new Response(JSON.stringify({code:-101,data:{wbi_img:{img_url:'https://i0.hdslb.com/'+ 'a'.repeat(32)+'.png',sub_url:'https://i0.hdslb.com/'+ 'b'.repeat(32)+'.png'}}}));
  assert.match(value.searchParams.get('w_rid'),/^[a-f0-9]{32}$/);return response({result:[{bvid:video,title:'测试结果',author:'UP'}]});
 }});const result=await client.search('测试');assert.equal(result.items[0].bvid,video);assert(!JSON.stringify(result).includes('fixture-private-cookie'));
});
test('Bilibili rate limits pause requests and missing subtitles never become claimed visual understanding',async()=>{
 let count=0;const limited=new Bilibili({minGap:0,fetchImpl:async()=>{count++;return new Response('',{status:412});}});await assert.rejects(limited.popular());await assert.rejects(limited.popular());assert.equal(count,1);
 const client=new Bilibili({minGap:0,fetchImpl:async url=>new URL(url).pathname.endsWith('/view')?response({bvid:video,title:'测试',aid:1,cid:2}):response({})});const detail=await client.video(video);assert.equal(detail.subtitles.length,0);assert(detail.evidence.includes('不能声称'));
 assert.throws(()=>bvidOf('https://private.invalid/video'));await assert.rejects(client.comments(video,{root:';arbitrary'}));
});
test('platform windows reject external URLs, consume references before mutation, and require manual checkout',async()=>{
 assert.throws(()=>checked('meituan','https://meituan.com.attacker.invalid'));assert.throws(()=>checked('taobao','file:///C:/secret'));const credentialUrl=new URL('https://bilibili.com');credentialUrl.username='fixture';credentialUrl.password='fixture';assert.throws(()=>checked('bilibili',credentialUrl.href));
 let actions=0;const win={isDestroyed:()=>false,webContents:{getURL:()=> 'https://h5.waimai.meituan.com/menu',executeJavaScript:async()=>{actions++;throw Error('connection interrupted after click');}}},browser=new PlatformBrowser({root:'fixture'}),account='a'.repeat(64),key=browser.key(account,'meituan');browser.windows.set(key,win);browser.observations.set(key,{at:Date.now(),url:win.webContents.getURL(),refs:[{ref:'fixture-ref',tag:'BUTTON',name:'加入购物车'}]});
 await assert.rejects(browser.act(account,{platform:'meituan',action:'click',ref:'fixture-ref'}));await assert.rejects(browser.act(account,{platform:'meituan',action:'click',ref:'fixture-ref'}),/重新查看/);assert.equal(actions,1);
 browser.observations.set(key,{at:Date.now(),url:win.webContents.getURL(),refs:[{ref:'pay',tag:'BUTTON',name:'提交订单并支付'}]});await assert.rejects(browser.act(account,{platform:'meituan',action:'click',ref:'pay'}),/手动/);assert.equal(actions,1);
});
test('platform ledger survives retries and cannot cross the active WeChat account',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jingyu-platforms-')),store=new JingyuStore(root,'a'.repeat(64));t.after(()=>{store.close();assert(root.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(root,{recursive:true,force:true});});store.saveSettings({ownerWxid:'wxid_owner_fixture',sharedMemoryEnabled:true,allowGroupShared:false});let writes=0;
 const service=new PlatformService(store,{browser:{act:async()=>{writes++;return {acted:'click'};}}}),body={operation:'browser.act',account:store.account,requestId:'f'.repeat(64),args:{platform:'meituan',action:'click',ref:'fixture'}};
 assert.equal((await service.run(body)).acted,'click');assert.equal((await service.run(body)).cached,true);assert.equal(writes,1);await assert.rejects(service.run({...body,account:'b'.repeat(64)}),/账号/);await assert.rejects(service.run({...body,args:{...body.args,ref:'different'}}),/编号/);
});
