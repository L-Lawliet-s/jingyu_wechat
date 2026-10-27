export function createPlatformUI({api,escapeHtml:e,toast}){
 let results='';
 const run=async(body)=>{try{return await api('/api/jingyu/platform',body);}catch(error){toast(error.message);return null;}};
 function page(){return `<section class="card"><h2>外卖与 B站</h2><p class="subtle">先在平台窗口手动登录。可以让小鲸鱼看 B站字幕、评论和楼中楼，也可在美团、淘宝闪购选择餐品、加购物车并核对费用。订单提交与付款由你在平台窗口确认。</p><div class="button-row">${[['bilibili','B站'],['meituan','美团外卖'],['taobao','淘宝闪购']].map(([id,label])=>`<button class="button" data-jingyu-platform="${id}">打开${label}</button>`).join('')}</div><form id="jingyu-bili-form" class="space-top"><div class="form-grid"><div class="field"><label>B站搜索词或视频 BV 号 / 链接</label><input name="query" maxlength="300" placeholder="例如：论文写作技巧，或 BV…"></div><div class="field"><label>查看内容</label><select name="action"><option value="search">搜索视频</option><option value="popular">热门视频</option><option value="video">视频资料与字幕</option><option value="comments">视频评论</option></select></div></div><button class="button" type="submit">读取 B站资料</button></form><div id="jingyu-bili-results" class="space-top">${results}</div><p class="subtle">平台操作需要当前项目桌面程序。微信中执行这些操作，请使用“会聊天的小助手”并配置管理员；普通聊天仍保持角色性格。</p></section>`;}
 function mount(){
  for(const button of document.querySelectorAll('[data-jingyu-platform]'))button.onclick=()=>void run({operation:'browser.open',args:{platform:button.dataset.jingyuPlatform}});
  const form=document.querySelector('#jingyu-bili-form');if(!form)return;
  form.onsubmit=event=>{event.preventDefault();void(async()=>{const action=form.elements.action.value,query=form.elements.query.value.trim(),data=await run({operation:'bili.'+action,args:action==='search'?{query}:action==='popular'?{}:{video:query}});if(!data)return;
   const rows=data.items??(data.subtitles?.length?data.subtitles.map(item=>({text:item.text})):[]);results=`<p><strong>${e(data.title??'B站资料')}</strong></p><p class="subtle">${e(data.evidence??'')}</p>${rows.map(item=>`<article class="tool-row"><div><strong>${e(item.title??item.user??'字幕')}</strong><p>${e(item.text??item.description??'')}</p>${item.bvid?`<small>${e(item.bvid)} · ${e(item.up??'')}</small>`:''}</div>${item.url?`<button class="button" data-bili-open="${e(item.url)}">打开视频</button>`:''}</article>`).join('')||'<p>没有取得可显示的资料。</p>'}`;
   const box=document.querySelector('#jingyu-bili-results');if(box){box.innerHTML=results;for(const button of box.querySelectorAll('[data-bili-open]'))button.onclick=()=>void run({operation:'browser.open',args:{platform:'bilibili',url:button.dataset.biliOpen}});}
  })();};
 }
 return {page,mount};
}
