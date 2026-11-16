const route='/api/dinner';
const names={walk:'步行',bus:'公交/地铁',bike:'骑行',drive:'驾车'};
const sourceNames={map:'已在地图核对',personal:'本人估计'};
const weatherNames={clear:'暂未见明显雨雪',wet:'有雨雪可能或现场下雨',strong:'有强降水、雷暴或大风风险',unknown:'该时段天气暂缺'};
const formatter=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const dateInput=at=>typeof at==='number'?formatter.format(at).replace(' ','T'):'';
const display=at=>dateInput(at).replace('T',' ');
const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[char]);
const option=(values,selected)=>Object.entries(values).map(([value,label])=>`<option value="${value}"${value===selected?' selected':''}>${label}</option>`).join('');
const button=(action,label)=>`<button type="button" class="dinner-button" data-commute-action="${action}">${label}</button>`;
const submit=label=>`<button class="dinner-button dinner-primary">${label}</button>`;
const input=(label,name,value,attrs='')=>`<label>${label}<input name="${name}" value="${escape(value)}" ${attrs}></label>`;
const panel=(title,html)=>`<section class="dinner-card"><h2>${title}</h2>${html}</section>`;
const outbound=(url,title)=>`<a class="dinner-button" href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(title)}</a>`;
const papers={
  walk:'穿便于步行的鞋',
  bus:'核对交通卡或乘车码',
  bike:'检查车况、头盔和车灯',
  drive:'核对停车入口与出发路线',
};
function gear(plan) {
  const {temperature,level}=plan.weather, hints=[papers[plan.mode]];
  if (level==='wet'||level==='strong') hints.push(plan.mode==='bike'?'准备合适的雨具，优先比较公交':'准备雨伞或防水外套');
  if (temperature && temperature[0]<=10) hints.push('考虑加一件衣物');
  if (temperature && temperature[1]>=30) hints.push('带水，预留避暑时间');
  return hints.join('、');
}

function goalForm(trip) {
  const goal=trip?.goal??{};
  return panel(trip?'调整出行目标':'新建通勤',`<form data-commute-form="save">
    <div class="dinner-fields">
      ${input('城市','city',goal.city,'maxlength="32" required placeholder="北京，或苏州,江苏"')}
      ${input('起点名称','origin',goal.origin,'maxlength="100" required')}
      ${input('目的地名称','destination',goal.destination,'maxlength="100" required')}
      ${input('目标到达时间（北京）','arrival',dateInput(goal.arrival),'type="datetime-local" required')}
      ${input('预留时间（分钟）','buffer',goal.buffer??10,'type="number" min="0" max="90" required')}
      <label>常用交通方式<select name="preferred">${option(names,goal.preferred??'bus')}</select></label>
    </div>
    <details data-commute-section="coordinates"${goal.from?' open':''}><summary>高德坐标（可选）</summary>
      <p class="dinner-muted">填两组高德拾取坐标后可直达高德路线。留空时按地名打开百度公交、步行或驾车路线；骑行可在高德手机端选起点和目的地。</p>
      <div class="dinner-fields">${input('起点经度,纬度','from',goal.from,'maxlength="38"')}${input('终点经度,纬度','to',goal.to,'maxlength="38"')}</div>
      <div class="dinner-actions">${outbound('https://lbs.amap.com/tools/picker','高德坐标拾取器')}</div>
    </details>
    <label class="dinner-check"><input type="checkbox" name="watch"${trip?.watch?' checked':''}>查看此行程时，临近出发自动刷新城市预报</label>
    <p class="dinner-muted">查天气只向 Open-Meteo 提交城市。打开地图时会把该路线的起终点交给所选地图服务。</p>
    <div class="dinner-actions">${submit(trip?'保存调整':'建立通勤行程')}</div>
  </form>`);
}
function routes(view) {
  const info=view.weather;
  const cards=view.plans.map(plan=>{
    const mode=plan.mode, entry=plan.route, active=view.trip.confirmed?.mode===mode;
    const lines=entry?`<p><strong>建议 ${display(plan.depart)} 出发</strong>${active?' · 已确认':''}</p>
      <p>${entry.minutes} 分钟 · ${sourceNames[entry.source]} · ${display(entry.at)}${plan.stale?' · 已超过 6 小时，请重查':''}</p>
      <p>${weatherNames[plan.weather.level]}${plan.extra?` · 已多留 ${plan.extra} 分钟`:''}${plan.weather.rain===null?'':` · 最高降水概率 ${plan.weather.rain}%`}</p>
      ${plan.weather.complete?'':'<p class="dinner-muted">部分或全部小时预报暂缺。</p>'}
      ${plan.blocked?'<p class="dinner-alert">已标记受阻</p>':''}
      ${plan.overdue?`<p class="dinner-alert">已错过建议出发时间。按当前可出发时间估计 ${display(plan.estimatedArrival)} 到达。</p>`:''}
      ${plan.avoid?'<p class="dinner-alert">存在明显天气风险，请优先核对室内换乘或推迟出发。</p>':''}
      ${plan.conflicts.length?`<p class="dinner-alert">与日程重叠：${plan.conflicts.map(item=>escape(item.title)).join('、')}</p>`:''}
      <p class="dinner-muted">出门前：${gear(plan)}</p>`:'<p class="dinner-muted">核对耗时后生成建议出发时间。</p>';
    const risk=plan.overdue||plan.conflicts?.length||plan.avoid||plan.stale;
    return `<article class="dinner-option"><h3>${names[mode]}${view.recommended===mode?' · 优先比较':''}</h3>${lines}
      <div class="dinner-actions">${outbound(plan.map.url,plan.map.title)}</div>
      <form data-commute-form="route" data-mode="${mode}">
        <div class="dinner-fields">${input('耗时（分钟）','minutes',entry?.minutes,'type="number" min="1" max="360" required')}
          <label>耗时来源<select name="source">${option(sourceNames,entry?.source??'map')}</select></label>
        </div>
        ${submit('保存耗时')}
      </form>
      ${entry&&!plan.blocked?`<form data-commute-form="confirm" data-mode="${mode}">
        ${risk?'<label class="dinner-check"><input type="checkbox" name="acceptRisk" required>已核对当前风险，仍采用</label>':''}
        ${submit(active?'重新确认':'确认此方案')}
      </form>`:''}
    </article>`;
  });
  const hours=view.plans.find(p=>p.mode===(view.trip.confirmed?.mode??view.recommended))?.weather?.hours??[];
  return panel('路线与预报',`<p class="dinner-muted">耗时由你核对录入。实时公交、封路和拥堵请在地图查看。</p>
    ${info?`<p>${escape(info.location)} · 获取于 ${display(info.at)} · ${outbound(info.source,'来源 Open-Meteo')}</p>`:''}
    <div class="dinner-actions">${button('weather','刷新城市天气')}</div>
    ${hours.length?`<details data-commute-section="hours"><summary>查看通勤时段逐小时预报</summary><ul>${hours.map(row=>
      `<li>${display(row.at)} · ${escape(row.label)} · ${row.temperature} °C · ${row.rain===null?'概率暂缺':`降水 ${row.rain}%`} · 阵风 ${row.gust} km/h</li>`).join('')}</ul></details>`:''}
    <div class="dinner-options">${cards.join('')}</div>`);
}
function reports(trip) {
  const reported=[
    ...(trip.incident.rain?['现场下雨']:[]),
    ...(trip.incident.readyAt?['可出发时间 '+display(trip.incident.readyAt)]:[]),
    ...trip.incident.blocked.map(mode=>names[mode]+'受阻'),
  ];
  return panel('临时变化',`${reported.length?`<p>${reported.join('、')}</p>`:''}
    <form data-commute-form="report">
      <div class="dinner-fields">
        <label>发生了什么<select name="event"><option value="rain">现场下雨</option><option value="delay">临时延迟</option><option value="blocked">路线受阻</option></select></label>
        <label data-report-field="delay" hidden>还需等待（分钟）<input type="number" name="delay" min="1" max="180" value="15" disabled></label>
        <label data-report-field="blocked" hidden>受阻交通方式<select name="mode" disabled>${option(names,trip.confirmed?.mode??trip.goal.preferred)}</select></label>
      </div>
      <div class="dinner-actions">${submit('记录变化并重排')}${reported.length?button('clear','解除手工变化'):''}</div>
    </form>`);
}
function recap(view) {
  const {trip,reminder,card,scheduleChange}=view;
  if(scheduleChange)return panel('待重新确认','<p>日历占用有变化，请核对路线后重新确认。</p>');
  if (!trip.confirmed) return trip.reconfirm?panel('待重新确认',`<p>${escape(trip.reconfirm)}</p>`):'';
  const plan=trip.confirmed, words=card?.style==='playful'?'叮，出门小清单来啦。':card?.style==='gentle'?'可以从容准备出门了。':'请核对出行方案。';
  const lines=[
    `准备${names[plan.mode]}去${trip.goal.destination}，计划 ${display(plan.depart)} 出发。`,
    `预计 ${display(plan.estimatedArrival)} 到达。以实际路况为准。`,
  ];
  return panel('已确认的通勤',`<p>${names[plan.mode]} · ${display(plan.depart)} 出发 · 预计 ${display(plan.estimatedArrival)} 到达</p>
    ${reminder?`<p class="dinner-alert">${escape(card?.address?card.address+'，':'')}${words} ${escape(reminder.message)}</p>`:''}
    <div class="dinner-actions">${button('export','导出提醒 .ics')}${button('speak','播报出发提示')}</div>
    <details data-commute-section="share"><summary>分享给同行者</summary><form data-commute-form="share">
      ${input('先核对接收人（备注或姓名）','recipient','','maxlength="64" required')}
      <label>正文<textarea name="content" rows="3" maxlength="360" required>${escape(lines.join('\n'))}</textarea></label>
      <p class="dinner-muted">确认后复制正文，再到微信选择对应联系人。</p>
      <label class="dinner-check"><input type="checkbox" name="confirmed" required>我已核对接收人与正文</label>
      <div class="dinner-actions">${submit('确认复制稿')}</div>
      <div data-commute-share></div>
    </form></details>`);
}
function page(view) {
  const trip=view.trip;
  const picker=panel('选择行程',`<div class="dinner-reminder"><label>通勤记录<select data-commute-select><option value="">新建通勤</option>
    ${view.list.map(row=>`<option value="${row.id}"${row.id===trip?.id?' selected':''}>${escape(row.destination)} · ${display(row.arrival)}${row.status==='archived'?' · 已归档':''}</option>`).join('')}</select></label>
    <div class="dinner-actions">${button('new','新建通勤')}${button('sync','同步')}</div></div>`);
  if(!trip)return picker+goalForm();
  const history=panel('变更记录',`<details data-commute-section="history"><summary>查看 ${trip.events.length} 条记录</summary>
    <ul>${trip.events.map(row=>`<li>${display(row.at)} · ${escape(row.detail)}</li>`).join('')}</ul></details>
    <div class="dinner-actions">${trip.status==='open'?button('archive','归档行程'):button('delete','删除已归档行程')}</div>`);
  if(trip.status==='archived')return picker+panel('已归档',`<p>${escape(trip.goal.origin)} → ${escape(trip.goal.destination)} · ${display(trip.goal.arrival)}</p>`)+history;
  return picker+recap(view)+goalForm(trip)+routes(view)+reports(trip)+history;
}
function download(content) {
  const url=URL.createObjectURL(new Blob([content],{type:'text/calendar;charset=utf-8'}));
  const link=document.createElement('a');
  link.href=url;
  link.download='jingyu-commute.ics';
  link.click();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function speech(view) {
  const trip=view.trip, plan=trip.confirmed;
  const voice=window.speechSynthesis?.getVoices().find(item=>item.localService&&/^zh[-_]CN/i.test(item.lang));
  if(!voice||!window.SpeechSynthesisUtterance)throw Error('设备未提供本地中文朗读声音。');
  const proposal=view.plans.find(row=>row.mode===plan.mode);
  const utterance=new SpeechSynthesisUtterance(`${view.card?.address?view.card.address+'，':''}建议 ${display(plan.depart).slice(-5)} ${names[plan.mode]}出发。${gear(proposal)}。`);
  utterance.voice=voice;
  utterance.lang=voice.lang;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export function mountCommute(container,request,{onAuthLost}={}) {
  window.speechSynthesis?.getVoices();
  const frame=document.createElement('div');
  frame.className='dinner dinner-content';
  frame.innerHTML='<p data-commute-status role="status" class="dinner-message" hidden></p><div data-commute-main class="dinner-content"><p>正在同步通勤…</p></div>';
  container.replaceChildren(frame);
  const main=frame.querySelector('[data-commute-main]'), status=frame.querySelector('[data-commute-status]');
  let id='',view,share,signature='';
  const edits=new Set();
  let busy=false,refreshing=false,disposed=false,generation=0;
  function message(value='',failed=false){
    if(disposed)return;
    status.classList.toggle('dinner-alert',failed);
    status.hidden=!value;
    status.textContent=value;
  }
  function error(cause){
    if(disposed)return;
    if (cause.status===401 && onAuthLost) onAuthLost(cause.message);
    else message(cause.message,true);
  }
  function showShare(){
    const panel=main.querySelector('[data-commute-share]');
    if(!panel||!share||share.revision!==view.trip.revision)return;
    panel.innerHTML=`<p>复制给 ${escape(share.recipient)}</p><textarea data-commute-copy rows="3" readonly aria-label="已确认的分享正文">${escape(share.content)}</textarea>
      <div class="dinner-actions">${button('copy','复制正文')}</div>`;
  }
  function paint(){
    const opened=new Set([...main.querySelectorAll('details[open][data-commute-section]')].map(row=>row.dataset.commuteSection));
    main.innerHTML=page(view);
    for(const row of main.querySelectorAll('details[data-commute-section]'))if(opened.has(row.dataset.commuteSection))row.open=true;
    showShare();
  }
  async function sync(force=false){
    const turn=++generation;
    const latest=await request(`${route}?view=commute${id?'&id='+encodeURIComponent(id):''}`);
    if(disposed||turn!==generation||(!force&&(edits.size||busy)))return;
    // Predicted arrival moves with the clock. Other fields control redraws.
    const next=JSON.stringify(latest,(key,value)=>key==='estimatedArrival'?undefined:value);
    if (force||next!==signature){
      signature=next;
      view=latest;
      if(share?.revision!==view.trip?.revision)share=null;
      paint();
    } else view=latest;
  }
  async function doIt(fn){
    if(busy||disposed)return;
    generation++;
    busy=true;
    frame.setAttribute('aria-busy','true');
    message();
    try{await fn();}catch(cause){error(cause);}
    finally{busy=false;frame.removeAttribute('aria-busy');}
  }
  function canDiscard(form){
    return ![...edits].some(edited=>edited!==form)||window.confirm('放弃尚未保存的其他通勤修改？');
  }
  async function select(next){
    if(!canDiscard())return;
    edits.clear();
    share=null;
    id=next;
    await sync(true);
  }
  function requestAction(action,fields={}){
    return request(route,{action:'commute-'+action,id,revision:view.trip?.revision,...fields});
  }
  async function update(action,fields={}){
    const result=await requestAction(action,fields);
    if(disposed)return;
    id=result.id;
    edits.clear();
    share=null;
    await sync(true);
    message(action==='weather'?'已核对预报，获取时间见路线与预报。':'已保存，并同步到两端。');
  }
  frame.addEventListener('input',({target})=>{
    if(target.matches('[data-commute-copy]'))return;
    const form=target.closest('[data-commute-form]');
    if(form)edits.add(form);
    if(form?.dataset.commuteForm==='share'){
      share=null;
      form.querySelector('[data-commute-share]').replaceChildren();
    }
  });
  frame.addEventListener('change',({target})=>{
    if(target.matches('[data-commute-select]')){
      const next=target.value;
      target.value=id;
      void doIt(()=>select(next));
    }
    if(target.matches('[data-commute-form="report"] [name="event"]')){
      for(const row of target.form.querySelectorAll('[data-report-field]')){
        row.hidden=row.dataset.reportField!==target.value;
        row.querySelector('input,select').disabled=row.hidden;
      }
    }
  });
  frame.addEventListener('submit',event=>{
    const form=event.target;
    if(!form.matches('[data-commute-form]'))return;
    event.preventDefault();
    const fields=Object.fromEntries(new FormData(form));
    const action=form.dataset.commuteForm;
    if(action==='save')fields.watch=fields.watch==='on';
    if(action==='confirm')fields.acceptRisk=fields.acceptRisk==='on';
    if(form.dataset.mode)fields.mode=form.dataset.mode;
    void doIt(async()=>{
      if(!canDiscard(form))return;
      if(action==='share'){
        const result=await requestAction('share',{...fields,confirmed:fields.confirmed==='on'});
        if(disposed)return;
        share={...result,revision:view.trip.revision};
        edits.delete(form);
        showShare();
        message('已确认复制稿，请核对后复制。');
        return;
      }
      await update(action,fields);
    });
  });
  frame.addEventListener('click',event=>{
    const action=event.target.closest('[data-commute-action]')?.dataset.commuteAction;
    if(!action||!view)return;
    if(action==='copy'){
      const field=main.querySelector('[data-commute-copy]');
      if(!field)return;
      field.select();
      if(document.execCommand('copy'))message(`已复制。请在微信核对接收人为 ${share.recipient}。`);
      else message('正文已选中，请使用设备的复制操作。');
      return;
    }
    void doIt(async()=>{
      if(action==='sync'||action==='new')return select(action==='sync'?id:'');
      if(action==='speak'){speech(view);return;}
      if(action==='export'){const result=await requestAction('export');if(!disposed)download(result.content);return;}
      if(!canDiscard())return;
      if(action==='clear')return update('report',{event:'clear'});
      if(action==='archive'&&!window.confirm('归档这条通勤行程？'))return;
      if(action==='delete'){
        if(window.confirm('删除已归档的通勤行程和变更记录？'))await update('delete',{confirmed:true});
        return;
      }
      await update(action);
    });
  });
  const interval=setInterval(async()=>{
    if(disposed||busy||refreshing||edits.size||document.hidden||
        (frame.contains(document.activeElement)&&document.activeElement.matches('input,select,textarea')))return;
    refreshing=true;
    try{
      await sync();
      if(view?.watchDue&&!edits.size&&!busy&&!disposed){
        await requestAction('weather',{automatic:true});
        await sync();
      }
    }catch(cause){error(cause);}
    finally{refreshing=false;}
  },6000);
  void doIt(()=>sync(true));
  return ()=>{disposed=true;generation++;clearInterval(interval);};
}
