const route = '/api/dinner';
const clock = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});
const kindNames = { parcel:'取件', return:'归还', bill:'缴费', appointment:'预约', study:'学习', rest:'休息', other:'其他' };
const stateNames = { open:'进行中', done:'已完成', cancelled:'已取消' };
const sourceNames = { manual:'手动填写', notice:'手动粘贴', 'text-file':'选中的文本文件', screenshot:'选中的截图' };
const levels = { low:'低', mid:'中', high:'高' };
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const time = value => typeof value === 'number' ? clock.format(value).replace(' ', 'T') : value ?? '';
const display = value => time(value).replace('T', ' ') || '未安排';
const button = (action, label, primary = false) => `<button type="button" class="dinner-button${primary ? ' dinner-primary' : ''}" data-life-action="${action}">${label}</button>`;
const submit = label => `<button class="dinner-button dinner-primary">${label}</button>`;
const options = (values, current) => Object.entries(values).map(([value, label]) =>
  `<option value="${value}"${value === current ? ' selected' : ''}>${label}</option>`).join('');
const field = (label, name, value, attrs = '') => `<label>${label}<input name="${name}" value="${escape(value)}" ${attrs}></label>`;
const blank = { title:'', kind:'other', place:'', items:'', start:'', deadline:'', reminder:'', duration:15 };

async function screenshot(file) {
  if (!['image/png', 'image/jpeg'].includes(file.type) || file.size > 12_000_000) throw Error('请选择 12 MB 以内的 PNG 或 JPEG 截图。');
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, 1800 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL('image/jpeg', 0.76).split(',')[1];
    if (!data || data.length > 1_099_960) throw Error('截图太复杂，请裁剪只保留文字区域。');
    return data;
  } finally { bitmap.close(); }
}

function noticeCard({ text, modelReady, ocrReady, source }) {
  return `<section class="dinner-card">
    <h2>从通知创建事项</h2>
    <form data-life-form="notice">
      <label>通知摘录<textarea name="text" rows="3" maxlength="4000" required placeholder="粘贴预约、取件或缴费通知">${escape(text)}</textarea></label>
      <div class="dinner-fields">
        <label>选择文本文件<input type="file" data-life-file="text" accept=".txt,text/plain"></label>
        ${ocrReady ? '<label>选择截图（主机识别）<input type="file" data-life-file="image" accept="image/png,image/jpeg"></label>' : ''}
      </div>
      ${source === 'screenshot' ? '<p class="dinner-muted">请先核对截图识别的文字，尤其是日期、时间和地址。</p>' : ''}
      ${modelReady ? '<label class="dinner-check"><input type="checkbox" name="model">将这段摘录发给 DeepSeek 辅助整理（计入用量）</label>' : ''}
      <p class="dinner-muted">请先删去取件码、验证码、支付链接等敏感内容。生成草稿以后可以核对和修改。</p>
      <div class="dinner-actions">${submit('生成草稿')}</div>
    </form></section>`;
}

function taskCard(task, edit, preview, view) {
  const active = task?.status === 'open';
  const id = task?.id ?? '';
  const source = task?.source ?? preview?.source;
  const title = task ? escape(task.title) : '新建事项';
  const history = task ? `<p class="dinner-muted">${stateNames[task.status]} · ${sourceNames[task.source]} · 版本 ${task.revision}</p>
    ${task.sourceText ? `<details class="life-card-controls"><summary>查看保存的通知摘录</summary><p class="life-source">${escape(task.sourceText)}</p><div class="dinner-actions">${button('delete-source','删除通知摘录')}</div></details>` : ''}
    <details class="life-card-controls"><summary>查看变更记录</summary><ul>${task.events.map(row => `<li>${display(row.at)} · ${escape(row.note)}</li>`).join('')}</ul></details>` : '';
  const form = active || !id ? `<form data-life-form="save">
    ${preview ? `<p class="dinner-muted">来源：${sourceNames[source]} · ${preview.method === 'deepseek' ? 'DeepSeek 辅助整理' : '本地提取'}${preview.uncertain ? ' · 未识别到唯一时间，请补充' : ' · 请核对提取时间'}</p>` : ''}
    <div class="dinner-fields">
      ${field('事项', 'title', edit.title, 'maxlength="100" required')}
      <label>类别<select name="kind">${options(kindNames, edit.kind)}</select></label>
      ${field('地点', 'place', edit.place, 'maxlength="120"')}
      ${field('携带物品或材料', 'items', edit.items, 'maxlength="300"')}
      ${field('开始时间', 'start', time(edit.start), 'type="datetime-local"')}
      ${field('截止时间', 'deadline', time(edit.deadline), 'type="datetime-local"')}
      ${field('提醒时间', 'reminder', time(edit.reminder), 'type="datetime-local"')}
      ${field('预计耗时（分钟）', 'duration', edit.duration, 'type="number" min="5" max="240" required')}
    </div>
    <p class="dinner-muted">全部时间按北京时间填写。开始时间留空的事项可以稍后安排。</p>
    <label class="dinner-check"><input type="checkbox" name="acceptConflict">已核对时间冲突，仍保存</label>
    ${preview ? '<label class="dinner-check"><input type="checkbox" name="keep">在本机保留通知摘录</label>' : ''}
    <div class="dinner-actions">${submit(id ? '保存改期或修改' : '确认建立事项')}</div>
  </form>` : '';
  const controls = active ? `
    ${task.reminder === null ? '' : `<div class="dinner-actions">
      ${task.reminderRead ? '<span class="dinner-muted">提醒已读</span>' : button('read', '标记提醒已读')}
      ${task.reminderPaused ? button('resume', '恢复提醒') : button('pause', '暂停提醒')}
      ${button('snooze', '稍后约 15 分钟')}
    </div>`}
    <div class="dinner-actions">${task.start === null ? '' : button('export', '导出 .ics')}${button('cancel', '取消事项')}</div>
    <form data-life-form="complete">
      <div class="dinner-fields">
        <label>这次安排有帮助吗<select name="helpful" required><option value="">请选择</option><option value="yes">有帮助</option><option value="no">帮助不大</option></select></label>
        ${field('实际耗时（分钟）', 'minutes', '', 'type="number" min="1" max="720"')}
        ${field('反馈', 'note', '', 'maxlength="300"')}
      </div>
      ${submit('完成并记录反馈')}
    </form>` : id ? `${task.outcome ? `<p>反馈：${task.outcome.helpful ? '有帮助' : '帮助不大'}${task.outcome.minutes ? ` · 实际用时 ${task.outcome.minutes} 分钟` : ''}${task.outcome.note ? ` · ${escape(task.outcome.note)}` : ''}</p>` : ''}
    <div class="dinner-actions">${button('delete', '删除事项及摘录')}</div>` : '';
  return `<section id="life-task" class="dinner-card"><h2>${title}</h2>
    ${history}${!active && task ? `<p>开始 ${display(task.start)} · 截止 ${display(task.deadline)}</p>` : ''}${form}${controls}
    ${view.calendar.events.length ? '<p class="dinner-muted life-card-controls">冲突检查包含已导入的日历。</p>' : ''}
  </section>`;
}

function rhythmCard(view, desktop) {
  const { checkin, suggestions, bundles, calendar, recap } = view;
  return `<section class="dinner-card">
    <h2>个人节奏</h2>
    <form data-life-form="checkin">
      <div class="dinner-fields">
        <label>现在的精力<select name="energy">${options(levels,checkin?.energy ?? 'mid')}</select></label>
        <label>现在的任务压力<select name="pressure">${options(levels,checkin?.pressure ?? 'mid')}</select></label>
        ${field('当前可用时间（分钟）', 'available', checkin?.available ?? 30, 'type="number" min="5" max="240" required')}
      </div>
      <p class="dinner-muted">自报状态在 8 小时内有效。建议考虑已录入日程和待办截止时间。</p>
      <div class="dinner-actions">${submit('更新状态并给出建议')}${checkin ? button('clear-checkin','清除状态') : ''}</div>
    </form>
    ${suggestions.length ? `<div class="dinner-options">${suggestions.map((item,index)=>`<article class="dinner-option">
      <h3>${escape(item.title)}</h3><p>${display(item.start)} · ${item.duration} 分钟</p><p class="dinner-muted">${escape(item.reason)}</p>
      <div class="dinner-actions">${button('suggest:'+index,'采用并核对')}</div></article>`).join('')}</div>`
      : checkin ? '<p>当前没有适合可用时长的建议。你可以调整可用时间，或先改期腾出空档。</p>' : ''}
    ${bundles.length ? `<h3>同地点待办</h3><ul>${bundles.map((row,index)=>`<li>${escape(row.place)} · ${row.titles.map(escape).join('、')} · ${row.duration} 分钟 · ${row.start === null ? '暂无合适的连续空档' : `可从 ${display(row.start)} 开始 ${button('bundle:'+index,'按顺序连续安排')}`}</li>`).join('')}</ul>` : ''}
    ${recap.length ? `<details data-life-section="recap" class="life-card-controls"><summary>今日完成 · ${recap.length} 项</summary><ul>${recap.map(row=>`<li>${escape(row.title)}${row.minutes ? ` · ${row.minutes} 分钟` : ''}</li>`).join('')}</ul></details>` : ''}
    ${desktop ? '<p class="dinner-muted life-card-controls"><a href="#jingyu">设置微信工作日学习提醒</a></p>' : ''}
    <details data-life-section="rest" class="life-card-controls">
      <summary>B站休息选项</summary>
      <div class="dinner-actions">${button('bili','读取热门视频')}</div><div data-life-bili class="life-action-panel"></div>
    </details>
  </section>
  <section class="dinner-card">
    <h2>日历占用</h2>
    <p>${calendar.at ? `${calendar.events.length} 条已导入 · ${calendar.skipped} 条未导入 · ${display(calendar.at)}` : '尚未导入外部日历。'}</p>
    <div class="dinner-fields"><label>导入 .ics（最多 12 KB）<input type="file" data-life-file="calendar" accept=".ics,text/calendar"></label></div>
    <p class="dinner-muted">重新导入会替换这一份日历占用。支持单次事件，重复事件和未支持时区会跳过。</p>
    ${calendar.events.length ? `<details data-life-section="calendar" class="life-card-controls"><summary>查看日历占用</summary><ul>
      ${calendar.events.map(row=>`<li>${escape(row.title)} · ${display(row.start)} 至 ${display(row.end)}</li>`).join('')}</ul>
    </details><div class="dinner-actions">${button('clear-calendar','清除日历占用')}</div>` : ''}
  </section>`;
}

function renderBili(root, data) {
  if (!root) return;
  root.innerHTML = data.items.length ? `<ul>${data.items.map(row => {
    if (data.bvid) return `<li>${escape(row.user)} · ${escape(row.text)}</li>`;
    if (!/^BV[A-Za-z0-9]{10}$/.test(row.bvid)) return '';
    return `<li><a href="https://www.bilibili.com/video/${row.bvid}/" target="_blank" rel="noopener noreferrer">${escape(row.title)}</a>
      ${button('comments:'+row.bvid,'查看评论')}</li>`;
  }).join('')}</ul>${data.bvid ? button('bili','返回热门列表') : ''}` : '<p>暂未获取到结果。</p>';
}

function workspace(view, form, importText, source, preview, desktop) {
  const { tasks, selected, due, card } = view;
  const reminders = due.length ? `<section class="dinner-card">
    <h2>到时提醒</h2>
    <p>${card?.address ? escape(card.address)+'，' : ''}${({playful:'叮，和小鲸鱼一起看看该做哪一件啦。',gentle:'有到时的事项，按你方便的节奏处理。'})[card?.style] ?? '请查看到时事项。'}</p>
    ${due.map(row=>`<div class="dinner-reminder"><strong>${escape(row.title)}</strong><div class="dinner-actions">${
      button(`open:${row.id}`,'查看')}${button(`read:${row.id}`,'已读')}${button(`snooze:${row.id}`,'稍后约 15 分钟')}</div></div>`).join('')}
  </section>` : '';
  return `<div class="dinner-content">${reminders}
    <section class="dinner-card"><div class="dinner-reminder">
      <label>选择事项<select data-life-select><option value="">新建事项</option>${tasks.map(row=>`
        <option value="${row.id}"${row.id===selected?.id?' selected':''}>${escape(row.title)} · ${stateNames[row.status]}${row.start ? ' · '+display(row.start) : ''}</option>`).join('')}</select></label>
      ${button('new','新建事项')}${button('refresh','同步')}
    </div></section>
    ${noticeCard({text:importText,source,modelReady:view.modelReady,ocrReady:view.ocrReady})}
    ${taskCard(selected,form,preview,view)}
    ${rhythmCard(view,desktop)}
  </div>`;
}

function downloadCalendar(content) {
  const url = URL.createObjectURL(new Blob([content], { type:'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'jingyu-calendar.ics';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function mountLife(container, request, { onAuthLost, desktop = false } = {}) {
  const frame = document.createElement('div');
  frame.className = 'dinner';
  frame.innerHTML = '<p data-life-status class="dinner-message" role="status" hidden></p><div data-life-main><p>正在同步生活日程…</p></div>';
  container.replaceChildren(frame);
  const main = frame.querySelector('[data-life-main]');
  const status = frame.querySelector('[data-life-status]');
  let id = '', view, edit, preview, importText = '', source = 'notice', bili;
  const dirtyForms = new Set();
  let disposed = false, busy = false, polling = false, generation = 0, signature = '';

  function message(value = '', failure = false) {
    if (disposed) return;
    status.classList.toggle('dinner-alert', failure);
    status.textContent = value;
    status.hidden = !value;
  }
  function render() {
    if (disposed || !view) return;
    const opened = [...main.querySelectorAll('details[open][data-life-section]')].map(row=>row.dataset.lifeSection);
    main.innerHTML = workspace(view, edit ?? view.selected ?? blank, importText, source, preview, desktop);
    for (const row of main.querySelectorAll('details[data-life-section]')) row.open = opened.includes(row.dataset.lifeSection);
    if (bili) renderBili(main.querySelector('[data-life-bili]'), bili);
  }
  async function refresh({force = false} = {}) {
    const key = ++generation;
    const endpoint = `${route}?view=life${id ? '&id='+encodeURIComponent(id) : ''}`;
    let latest;
    try { latest = await request(endpoint); }
    catch (error) {
      if (error.status!==404 || !id || generation!==key) throw error;
      id = '';
      latest = await request(`${route}?view=life`);
    }
    if (disposed || key !== generation || (!force && (dirtyForms.size || busy))) return;
    const next = JSON.stringify(latest);
    if (force || next !== signature) {
      view = latest;
      signature = next;
      render();
    }
  }
  function error(error) {
    if (disposed) return;
    if (error.status===401 && onAuthLost) onAuthLost(error.message);
    else message(error.message, true);
  }
  async function act(fn) {
    if (busy || disposed) return;
    busy = true;
    generation++;
    frame.setAttribute('aria-busy', 'true');
    message();
    try { await fn(); }
    catch (cause) { error(cause); }
    finally {
      busy = false;
      frame.removeAttribute('aria-busy');
    }
  }
  function discard(allowed) {
    if ([...dirtyForms].some(form=>form!==allowed && form!=='notice') && !window.confirm('放弃尚未保存的编辑并继续？')) return false;
    edit = preview = undefined;
    dirtyForms.clear();
    return true;
  }
  async function open(nextId = '', clear = true) {
    if (clear && !discard()) return;
    id = nextId;
    await refresh({force:true});
  }
  async function change(action, fields = {}, target = view.selected) {
    const result = await request(route, { action:'life-'+action, ...(target ? { id:target.id, revision:target.revision } : {}), ...fields });
    if (!disposed) {
      await refresh({force:true});
      message('已同步。');
    }
    return result;
  }
  function details() { main.querySelector('#life-task')?.scrollIntoView({block:'nearest'}); }

  frame.addEventListener('input', event => {
    const { target } = event;
    const form = target.closest('[data-life-form]');
    if (form && target.type !== 'file') dirtyForms.add(form.dataset.lifeForm);
    if (target.matches('[data-life-form="notice"] textarea')) {
      importText = target.value;
      if (!importText) source = 'notice';
    }
  });
  frame.addEventListener('change', ({target}) => {
    if (target.matches('[data-life-select]')) {
      const next = target.value;
      target.value = id;
      void act(()=>open(next));
    }
    if (!target.matches('[data-life-file]')) return;
    const file = target.files[0];
    target.value = '';
    if (!file) return;
    void act(async()=>{
      const type = target.dataset.lifeFile;
      if (type==='calendar') {
        if (file.size>12000) throw Error('请选择不超过 12 KB 的 .ics 文件。');
        if (!discard()) return;
        const data = await change('calendar-import',{content:await file.text()},null);
        message(`导入 ${data.count} 条日历占用，跳过 ${data.skipped} 条。`);
        return;
      }
      if (type==='text' && file.size>12000) throw Error('请选择不超过 12 KB 的文本文件。');
      const area = main.querySelector('[data-life-form="notice"] textarea');
      const data = type==='image' ? (await request(route+'/ocr',{image:await screenshot(file)})).text : (await file.text()).slice(0,4000);
      if (disposed) return;
      importText = data;
      source = type==='image' ? 'screenshot' : 'text-file';
      area.value = importText;
      dirtyForms.add('notice');
      message(type==='image' ? '已提取截图文字，请核对后生成草稿。' : '已载入文本，请核对后生成草稿。');
    });
  });

  frame.addEventListener('submit', event => {
    const form = event.target;
    if (!form.matches('[data-life-form]')) return;
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    void act(async()=>{
      switch(form.dataset.lifeForm) {
        case 'notice': {
          if ([...dirtyForms].some(name=>name!=='notice') && !window.confirm('用这段通知替换尚未保存的编辑？')) return;
          const result = await request(route,{action:'life-preview',text:data.text,model:data.model==='on'});
          if (disposed) return;
          const previous = id;
          id = '';
          edit = result.draft;
          preview = { text:data.text,method:result.method,source,uncertain:result.draft.uncertain };
          dirtyForms.clear();
          dirtyForms.add('save');
          try { await refresh({force:true}); } catch (cause) { id = previous; throw cause; }
          details();
          return;
        }
        case 'save': {
          if ([...dirtyForms].some(name=>!['save','notice'].includes(name)) && !window.confirm('放弃其他未保存的编辑并继续？')) return;
          const result = await request(route, { ...data, action:'life-save', id, revision:view.selected?.revision,
            acceptConflict:data.acceptConflict==='on', source:preview?.source ?? 'manual', sourceText:data.keep==='on' ? preview?.text : '' });
          if (disposed) return;
          if (preview) { importText = ''; source = 'notice'; }
          id = result.id;
          dirtyForms.clear();
          edit = preview = undefined;
          await refresh({force:true});
          message('已保存，手机和桌面共用这条事项。');
          details();
          return;
        }
        case 'checkin':
          if (!discard('checkin')) return;
          await change('checkin', data, null);
          return;
        case 'complete':
          if (!discard('complete')) return;
          await change('complete', { ...data, helpful:data.helpful==='yes' });
          return;
      }
    });
  });

  frame.addEventListener('click', event => {
    const clicked = event.target.closest('[data-life-action]');
    if (!clicked || !view) return;
    const [action,value] = clicked.dataset.lifeAction.split(':');
    void act(async()=>{
      const task = view.selected;
      if (action==='open' || action==='new' || action==='refresh') {
        await open(action==='open' ? value : action==='new' ? '' : id);
        return;
      }
      if (action==='bili' || action==='comments') {
        const data = await request(route,{action:action==='bili'?'life-bili-popular':'life-bili-comments',video:value});
        bili = data;
        if (!disposed) renderBili(main.querySelector('[data-life-bili]'),data);
        return;
      }
      if (action==='suggest') {
        const item = view.suggestions[Number(value)];
        if (!item || !discard()) return;
        await open(item.id ?? '', false);
        edit = { ...(view.selected ?? blank), title:item.title, kind:item.kind, duration:item.duration,
          start:item.start, ...(view.selected?.reminder > item.start ? {reminder:''} : {}) };
        dirtyForms.add('save');
        render();
        details();
        return;
      }
      if (action==='bundle') {
        const group = view.bundles[Number(value)];
        if (group?.start===null || !group || !discard()) return;
        if (!window.confirm(`从 ${display(group.start)} 开始，在${group.place}依次安排：${group.titles.join('、')}？`)) return;
        const result = await change('schedule-bundle',{start:time(group.start),members:group.members},null);
        message(`已连续安排 ${result.count} 项。`);
        return;
      }
      if (action==='export') {
        const result = await request(route,{action:'life-export',id:task.id,revision:task.revision});
        if (!disposed) downloadCalendar(result.content);
        return;
      }
      if (!discard()) return;
      if (['read','pause','resume','snooze'].includes(action)) {
        const target = value ? view.due.find(row=>row.id===value) : task;
        if (target) await change('reminder',{operation:action},target);
      } else if (action==='clear-calendar' || action==='clear-checkin') {
        await change(action,{},null);
      } else if (action==='cancel' && window.confirm('取消这条事项和提醒？')) {
        await change('cancel');
      } else if (action==='delete-source' && window.confirm('删除原摘录，保留已确认的事项？')) {
        await change('delete-source',{confirmed:true});
      } else if (action==='delete' && window.confirm('删除这条事项和已保存的通知摘录？')) {
        await request(route,{action:'life-delete',id:task.id,revision:task.revision,confirmed:true});
        await open('',false);
        message('已删除。');
      }
    });
  });
  const poll = setInterval(async()=>{
    if (disposed || dirtyForms.size || busy || polling || document.hidden ||
        (frame.contains(document.activeElement) && document.activeElement.matches('input,select,textarea'))) return;
    polling = true;
    try { await refresh(); } catch (cause) { error(cause); }
    finally { polling = false; }
  },4000);
  void act(()=>refresh({force:true}));
  return () => { disposed = true; generation++; clearInterval(poll); };
}
