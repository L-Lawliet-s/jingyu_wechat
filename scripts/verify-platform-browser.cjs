// Run with the project's Electron runtime. Exercises a local fixture only.
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
const assert=require('node:assert/strict');
const {snapshotPage,actPage,addDinnerFromPage}=require('../apps/console-desktop/platform-browser.cjs');
app.setPath('userData',path.resolve(__dirname,'../state/testing/platform-dom-'+process.pid));
app.whenReady().then(async()=>{
 const window=new BrowserWindow({show:false,webPreferences:{sandbox:true,nodeIntegration:false,contextIsolation:true}});
 try{
  const html='<html><head><title>本地平台测试</title></head><body><input type="search" placeholder="搜索餐品"><button id="add" onclick="document.getElementById(\'cart\').innerText=\'购物车：米饭 1 份，合计 18 元\'">加入购物车</button><button id="pay" onclick="window.paymentClicked=true">提交订单并支付</button><p id="cart">购物车为空</p></body></html>';
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
  const snapshot=await window.webContents.executeJavaScript('('+snapshotPage.toString()+')("fixture")');
  const add=snapshot.refs.find(ref=>ref.name==='加入购物车'),pay=snapshot.refs.find(ref=>ref.name==='提交订单并支付'),search=snapshot.refs.find(ref=>ref.name==='搜索餐品');assert(add&&pay&&search);
  const execute=args=>window.webContents.executeJavaScript('('+actPage.toString()+')('+JSON.stringify(args)+')');
  await execute({action:'fill',ref:search.ref,expectedName:search.name,expectedTag:search.tag,value:'米饭'});
  assert.equal(await window.webContents.executeJavaScript('document.querySelector("input").value'),'米饭');
  await execute({action:'click',ref:add.ref,expectedName:add.name,expectedTag:add.tag});assert((await window.webContents.executeJavaScript('document.body.innerText')).includes('合计 18 元'));
  await assert.rejects(execute({action:'click',ref:pay.ref,expectedName:pay.name,expectedTag:pay.tag}));assert.equal(await window.webContents.executeJavaScript('window.paymentClicked===true'),false);
  await window.webContents.executeJavaScript('document.getElementById("add").innerText="立即付款"');await assert.rejects(execute({action:'click',ref:add.ref,expectedName:add.name,expectedTag:add.tag}));
  const shop='<h1>测试饭堂</h1><button id="dinner-add" aria-label="菌菇饭 普通份 加入购物车" onclick="window.count=(window.count||0)+1">加购</button><button id="dinner-pay" aria-label="立即支付" onclick="window.paid=true">支付</button>';
  await window.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(shop));
  const target={href:window.webContents.getURL(),store:'测试饭堂',item:'菌菇饭',spec:'普通份'};
  const attempt=patch=>window.webContents.executeJavaScript('('+addDinnerFromPage.toString()+')('+JSON.stringify({...target,...patch})+')');
  assert.equal(await attempt({store:'其他店'}),'no-match');
  assert.equal(await attempt({spec:'大份'}),'no-match');
  assert.equal(await attempt({item:'立即支付',spec:''}),'no-match');
  assert.equal(await attempt({href:target.href+'#changed'}),'no-match');
  assert.equal(await attempt({}),'submitted');
  await window.webContents.executeJavaScript('document.body.append(document.getElementById("dinner-add").cloneNode(true))');
  assert.equal(await attempt({}),'no-match');
  assert.deepEqual(await window.webContents.executeJavaScript('[window.count,Boolean(window.paid)]'),[1,false]);
  console.log(JSON.stringify({domReady:true,searchFilled:true,cartAdded:true,paymentBlocked:true,staleTargetBlocked:true,dinnerExactMatch:true,dinnerDuplicatesBlocked:true}));
 }finally{window.destroy();app.quit();}
}).catch(error=>{console.error('Platform DOM verification failed: '+error.name);app.exit(1);});
