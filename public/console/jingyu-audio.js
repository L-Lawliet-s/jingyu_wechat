export function createAudioUI({api,escapeHtml:e,toast}){
 let timer;
 const status=s=>`状态：${e(({stopped:'已停止',starting:'启动中',listening:'正在聆听',thinking:'正在思考',speaking:'正在说话',error:'未完成'})[s.state]??s.state)} · ${s.turns} 轮 · 输入 ${s.usage.input} / 输出 ${s.usage.output} tokens${s.error?' · '+e(s.error):''}`;
 function page(audio){
  clearInterval(timer);const s=audio.settings;
  const field=(name,label,type='text')=>`<div class="field"><label>${label}</label><input name="${name}" type="${type}" value="${e(String(s[name]))}" required></div>`;
  return `<section class="card"><h2>语音对话 · 本地测试</h2><p class="subtle">这一版轮流听说，尚未接入微信自动拨号。点开始后才采集所选输入设备，识别文字发给 DeepSeek API，生成的声音播放到所选输出设备。每次最多 20 轮，默认 5 分钟。</p><form id="jingyu-audio-settings"><div class="form-grid">${field('python','独立语音环境 Python 完整路径')}${field('modelPath','Vosk 中文模型目录')}${field('inputDevice','接收声音的设备编号','number')}${field('outputDevice','播放声音的设备编号','number')}${field('model','DeepSeek 模型')}${field('maxMinutes','单次时限 / 分钟','number')}<div class="field"><label>Windows 声音名称（留空使用中文女声）</label><input name="voiceName" value="${e(s.voiceName)}"></div></div><div class="button-row"><button class="button primary" type="submit">保存语音设置</button><button class="button" type="button" id="jingyu-audio-probe">检测设备</button></div></form><pre id="jingyu-audio-devices" class="subtle"></pre><p id="jingyu-audio-status">${status(audio.status)}</p><div class="button-row"><button class="button" id="jingyu-audio-start">开始采集并对话</button><button class="button danger" id="jingyu-audio-stop">立即停止</button></div><p class="subtle">接微信前需用两个独立音频通道隔开收音和发声。视频电话沿用这条音频链路；虚拟形象画面需要后续配置。拍一拍、原生语音消息、自动拨号当前未启用。</p></section>`;
 }
 function mount(){
  clearInterval(timer);const form=document.querySelector('#jingyu-audio-settings');if(!form)return;
  const run=async fn=>{try{return await fn();}catch(error){toast(error.message);}};
  form.onsubmit=event=>{event.preventDefault();const v=Object.fromEntries(new FormData(form));for(const name of ['inputDevice','outputDevice','maxMinutes'])v[name]=Number(v[name]);void run(async()=>{await api('/api/jingyu/audio/settings',v);toast('语音设置已保存');});};
  document.querySelector('#jingyu-audio-probe').onclick=()=>void run(async()=>{const r=await api('/api/jingyu/audio/probe',{python:form.elements.python.value});document.querySelector('#jingyu-audio-devices').textContent=r.available?r.devices.map(d=>`${d.id} · ${d.name} · 输入${d.input} / 输出${d.output}`).join('\n')+'\n可用声音：'+(r.voices??[]).map(v=>v.name+' ('+v.culture+')').join('、'):r.error;});
  const update=s=>{const element=document.querySelector('#jingyu-audio-status');if(element)element.innerHTML=status(s);};
  document.querySelector('#jingyu-audio-start').onclick=()=>void run(async()=>update(await api('/api/jingyu/audio/start',{})));
  document.querySelector('#jingyu-audio-stop').onclick=()=>void run(async()=>update(await api('/api/jingyu/audio/stop',{})));
  timer=setInterval(async()=>{if(!form.isConnected){clearInterval(timer);return;}try{update(await api('/api/jingyu/audio/status'));}catch{clearInterval(timer);}},2000);
 }
 return {page,mount};
}
