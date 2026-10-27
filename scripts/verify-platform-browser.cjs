// Run with the project's Electron runtime. Exercises a local fixture only.
const {app,BrowserWindow}=require('electron');
const path=require('node:path');
const assert=require('node:assert/strict');
const {snapshotPage,actPage}=require('../apps/console-desktop/platform-browser.cjs');
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
  console.log(JSON.stringify({domReady:true,searchFilled:true,cartAdded:true,paymentBlocked:true,staleTargetBlocked:true}));
 }finally{window.destroy();app.quit();}
}).catch(error=>{console.error('Platform DOM verification failed: '+error.name);app.exit(1);});
