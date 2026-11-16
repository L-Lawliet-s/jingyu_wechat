const base='/api/jingyu/media';
const names={pat:'拍一拍',voice:'原生语音'};
const states={idle:'尚未准备',ready:'已准备，待核对联系人',playing:'请切到微信，按住 Alt 等待小鲸鱼播放完',
  waiting:'等待微信回执',unknown:'待手动核对',confirmed:'已查到微信回执'};

export function createMediaUI({api,escapeHtml:e,toast}) {
  function page() {
    return `<section class="card"><h2>微信原生消息辅助</h2>
      <p class="subtle">选定联系人后，拍一拍由你在微信点对方头像。语音由小鲸鱼合成，经虚拟麦克风播放到电脑版微信的原生录音。</p>
      <form id="jingyu-native-media"><div class="form-grid">
        <label>私聊联系人<select name="chat" required><option value="">先加载允许联系人</option></select></label>
        <label>消息类型<select name="kind"><option value="pat">拍一拍</option><option value="voice">原生语音</option></select></label>
      </div>
      <div class="field" data-native-voice hidden><label>语音正文<textarea name="text" rows="2" maxlength="120"></textarea></label>
        <small>沿用声音设置。选择在线声音时，正文会发给微软语音服务合成。</small></div>
      <div class="button-row"><button class="button" id="jingyu-media-load" type="button">加载允许联系人</button>
        <button class="button primary" type="submit">准备动作</button></div></form>
      <audio id="jingyu-media-preview" controls hidden></audio>
      <p id="jingyu-media-state" role="status">尚未准备</p><p id="jingyu-media-help" class="subtle"></p>
      <label><input id="jingyu-media-confirm" type="checkbox">我已核对显示的微信小号和接收人</label>
      <div class="button-row"><button class="button primary" id="jingyu-media-arm" disabled>开始辅助</button>
        <button class="button" id="jingyu-media-check" disabled>核对微信回执</button>
        <button class="button" id="jingyu-media-stop" disabled>退出辅助</button></div></section>`;
  }
  function mount() {
    const form=document.querySelector('#jingyu-native-media');
    if(!form)return;
    const select=form.elements.chat,kind=form.elements.kind,source=form.elements.text;
    const confirmed=document.querySelector('#jingyu-media-confirm');
    const arm=document.querySelector('#jingyu-media-arm'),check=document.querySelector('#jingyu-media-check'),stop=document.querySelector('#jingyu-media-stop');
    const box=document.querySelector('#jingyu-media-state'),help=document.querySelector('#jingyu-media-help'),preview=document.querySelector('#jingyu-media-preview');
    let current,previewUrl,busy=false;
    function show(value) {
      if(!form.isConnected)return;
      current=value;
      box.textContent=(value.name?`${value.name} · ${names[value.kind]} · `:'')+states[value.state]+(value.detail?' · '+value.detail:'');
      help.textContent=value.state==='ready'||value.state==='waiting'||value.state==='playing'
        ? value.kind==='pat'?'开始后，在这个人的微信私聊中双击对方头像，再回来核对新增消息。':
          '开始后 18 秒内切到目标私聊，在原生语音模式按住 Alt。若只通过虚拟设备播放，可按试听时长多留约一秒，再松手核对回执。'
        : '';
      arm.disabled=busy||value.state!=='ready'||!confirmed.checked;
      check.disabled=busy||!['playing','waiting','unknown','confirmed'].includes(value.state);
      stop.disabled=busy||value.state==='idle';
    }
    function updateKind() {
      source.closest('[data-native-voice]').hidden=kind.value!=='voice';
      source.required=kind.value==='voice';
    }
    function clearPreview() {
      if(previewUrl)URL.revokeObjectURL(previewUrl);
      previewUrl=null;
      preview.removeAttribute('src');
      preview.hidden=true;
    }
    async function run(fn) {
      if(busy)return;
      busy=true;
      if(current)show(current);
      try{await fn();}catch(error){toast(error.message);}
      finally{busy=false;if(current)show(current);}
    }
    confirmed.oninput=()=>current&&show(current);
    kind.onchange=updateKind;
    updateKind();
    document.querySelector('#jingyu-media-load').onclick=()=>void run(async()=>{
      const {contacts}=await api('/api/jingyu/call/contacts');
      select.innerHTML='<option value="">选择联系人</option>'+contacts.map(row=>
        `<option value="${e(row.chat)}"${row.ambiguous?' disabled':''}>${e(row.name||row.chat)}${row.ambiguous?'（请设置唯一备注）':''}</option>`).join('');
    });
    form.onsubmit=event=>{
      event.preventDefault();
      void run(async()=>{
        const data=await api(base+'/prepare',{chat:select.value,kind:kind.value,text:source.value});
        confirmed.checked=false;
        clearPreview();
        if(data.preview){
          previewUrl=URL.createObjectURL(new Blob([Uint8Array.from(atob(data.preview.audio),char=>char.charCodeAt(0))],{type:'audio/wav'}));
          preview.src=previewUrl;
          preview.hidden=false;
        }
        const {preview:_preview,...status}=data;
        show(status);
      });
    };
    arm.onclick=()=>void run(async()=>show(await api(base+'/arm',{id:current.id,confirmed:confirmed.checked})));
    check.onclick=()=>void run(async()=>show(await api(base+'/check',{id:current.id})));
    stop.onclick=()=>void run(async()=>{show(await api(base+'/stop',{}));confirmed.checked=false;clearPreview();});
    void run(async()=>show(await api(base)));
    const timer=setInterval(()=>{
      if(!form.isConnected){clearInterval(timer);clearPreview();return;}
      if(current?.state==='playing')void run(async()=>show(await api(base)));
    },1100);
  }
  return {page,mount};
}
