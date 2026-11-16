const route = '/api/dinner';
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const money = value => value == null ? '' : (value / 100).toFixed(2);
const yuan = value => value == null ? '待核对' : `¥${money(value)}`;
const localTime = value => value ? new Date(value + 8 * 3600_000).toISOString().slice(0, 16) : '';
const dateLabel = value => value ? localTime(value).replace('T', ' ') : '未设置';
const clock = value => value ? localTime(value).slice(-5) : '待核对';
const menuSpice = { unknown: '未确认', none: '不辣', spicy: '有辣味' };
const statuses = { planning: '选餐中', confirmed: '已选择', review: '待核对购物车', checked: '已核对', handled: '已处理，待反馈', completed: '已结束', cancelled: '已取消' };
const decisions = { fit: '符合条件', check: '待核对', conflict: '与条件冲突', stale: '报价已过期' };
const cartActionNotes = {
  submitted: '已发送一次加购操作，请核对购物车。',
  manual: '当前页面无法唯一识别加购按钮，请手动加购。',
  unknown: '上次操作结果待核对，请先查看购物车再决定。',
};
const styleNames = { gentle: '温柔陪伴', playful: '俏皮小鲸鱼', brief: '简洁助手' };
const reminderVoice = { gentle: '到你设的时间了，准备好再继续。', playful: '小鲸鱼来提醒啦，看看你的晚饭安排。', brief: '晚饭提醒已到。' };
const copy = {
  gentle: ['今晚想吃点什么？我陪你慢慢选。', '我们对照预算和时间，挑一份合适的吧。', '看看平台上的最终金额和时间，再决定下一步。', '辛苦啦。记下这次的感受，下次选餐会更顺手。'],
  playful: ['肚子提醒你吃饭啦。今晚想吃什么？', '小鲸鱼来算算，哪份晚饭最合适。', '先看一眼购物车，小鲸鱼可不想算漏。', '今晚的饭怎么样？喜欢的话，我们下次还能选它。'],
  brief: ['填写晚饭需求。', '比较预算、口味和预计送达。', '核对实际费用与送达。', '记录完成结果和口味反馈。'],
};

function button(label, action, id = '', primary = false) {
  return `<button type="button" class="dinner-button${primary ? ' dinner-primary' : ''}" data-dinner-click="${action}"${id ? ` data-id="${escape(id)}"` : ''}>${label}</button>`;
}

function field(name, label, value, type = 'text', attributes = '') {
  return `<label>${label}<input name="${name}" type="${type}" value="${escape(value)}" ${attributes}></label>`;
}

function select(name, label, choices, current) {
  return `<label>${label}<select name="${name}">${Object.entries(choices).map(([key, label]) =>
    `<option value="${escape(key)}" ${key === current ? 'selected' : ''}>${escape(label)}</option>`).join('')}</select></label>`;
}

function textarea(name, label, value, max, placeholder = '', required = false) {
  return `<label>${label}<textarea name="${name}" maxlength="${max}" rows="3" placeholder="${escape(placeholder)}" ${required ? 'required' : ''}>${escape(value)}</textarea></label>`;
}

function check(name, label, attributes = '') {
  return `<label class="dinner-check"><input type="checkbox" name="${name}" ${attributes}><span>${label}</span></label>`;
}

function actions(...markup) { return `<div class="dinner-actions">${markup.join('')}</div>`; }

function panel(title, markup, extraClass = '') {
  return `<section class="dinner-card ${extraClass}"><h2>${title}</h2>${markup}</section>`;
}

function form(name, markup, submitLabel) {
  return `<form data-dinner-form="${name}">${markup}${actions(`<button class="dinner-button dinner-primary">${submitLabel}</button>`)}</form>`;
}

function toDraft(goal) {
  return { ...goal, budget: money(goal.budget), readyAt: localTime(goal.readyAt), latestAt: localTime(goal.latestAt), reminderAt: localTime(goal.reminderAt) };
}

function quoteDraft(row) {
  return { ...row, unitPrice: money(row.unitPrice), packing: money(row.packing), delivery: money(row.delivery), discount: money(row.discount) };
}

function feesField(name, label, value, required = false) {
  return field(name, label, value, 'text', `inputmode="decimal" maxlength="7" ${required ? 'required' : 'placeholder="待核对"'}`);
}

function goalFields(draft, platforms, edit, model) {
  return textarea('goal', '你的晚饭需求', draft.goal, 500, '今天六点下课，晚饭预算 30 元，不吃辣，七点半有社团活动。', true) +
    (!edit ? actions(button('识别需求', 'intent'), model ? button('用 DeepSeek 识别', 'intent-model') : '') : '') +
    `<div class="dinner-fields">
      ${select('platform', '外卖平台', Object.fromEntries(Object.entries(platforms).map(([id, { name }]) => [id, name])), draft.platform ?? 'meituan')}
      ${feesField('budget', '含配送总预算（元）', draft.budget)}
      ${select('spice', '口味', { any: '不限', avoid: '不吃辣' }, draft.spice ?? 'any')}
      ${field('readyAt', '开始点餐（北京时间）', draft.readyAt, 'datetime-local')}
      ${field('latestAt', '最晚送达（北京时间）', draft.latestAt, 'datetime-local')}
      ${field('activity', '晚间安排', draft.activity, 'text', 'maxlength="80" placeholder="例如 社团活动"')}
      ${field('reminderAt', '提醒时间（北京时间）', draft.reminderAt, 'datetime-local')}
    </div>`;
}

function quoteFields(row) {
  return `<div class="dinner-fields">
    ${field('store', '店铺', row.store, 'text', 'maxlength="80" required')}
    ${field('item', '餐品', row.item, 'text', 'maxlength="100" required')}
    ${field('spec', '规格', row.spec, 'text', 'maxlength="80" placeholder="例如 标准份"')}
    ${field('quantity', '份数', row.quantity ?? 1, 'number', 'min="1" max="9" required')}
    ${feesField('unitPrice', '单价（元）', row.unitPrice, true)}
    ${feesField('packing', '包装费（总额）', row.packing)}
    ${feesField('delivery', '配送费', row.delivery)}
    ${feesField('discount', '优惠（总额）', row.discount)}
    ${field('minutes', '预计送达（分钟）', row.minutes, 'number', 'min="0" max="300" placeholder="待核对"')}
    ${select('spice', '辣度', menuSpice, row.spice ?? 'unknown')}
  </div><p class="dinner-muted">费用未知时留空，免收时填 0。保存前请与原始报价对照。</p>`;
}

function optionCard(row, task, editable) {
  const selected = task.selected?.id === row.id;
  const canChoose = ['planning', 'confirmed'].includes(task.status) && ['fit', 'check'].includes(row.decision);
  return `<article class="dinner-option${selected ? ' dinner-option-selected' : ''}">
    <div class="dinner-option-head"><div><h3>${escape(row.item)}${selected ? ' · 已选择' : ''}</h3><p>${escape(row.store)}${row.spec ? ` · ${escape(row.spec)}` : ''} · ${row.quantity} 份</p></div><strong>${yuan(row.total)}</strong></div>
    <p><span class="dinner-state" data-tone="${row.decision}">${decisions[row.decision]}</span> ${row.matchesFavorite ? '<span class="dinner-state">曾喜欢</span>' : ''} ${row.minutes === null ? '送达待核对' : `预计 ${row.minutes} 分钟 · ${clock(row.arrivalAt)}`} · ${menuSpice[row.spice]}</p>
    <p class="dinner-muted">单价 ${yuan(row.unitPrice)} · 包装 ${yuan(row.packing)} · 配送 ${yuan(row.delivery)} · 优惠 ${yuan(row.discount)}</p>
    <p class="dinner-muted">${row.source === 'sample' ? '演示报价' : '用户核对并录入'} · ${dateLabel(row.observedAt)}</p>
    ${row.issues.length ? `<ul class="dinner-issues">${row.issues.map(issue => `<li>${escape(issue)}</li>`).join('')}</ul>` : ''}
    ${actions(canChoose ? button('选这一份', 'choose', row.id, true) : '', editable ? button('更新报价', 'edit-candidate', row.id) + button('移除', 'remove-candidate', row.id) : '')}
  </article>`;
}

function cartReview(task) {
  const selected = task.candidates.find(row => row.id === task.selected?.id);
  if (!selected || !['review', 'checked'].includes(task.status) || task.action?.state === 'running') return '';
  const cart = task.cart;
  const compare = cart ? `<p class="dinner-status-line">${task.sample ? '演示核对' : '人工核对'}于 ${dateLabel(cart.observedAt)} · 应付 ${yuan(cart.total)}${cart.delta ? ` · 与候选相差 ${cart.delta > 0 ? '+' : '−'}${yuan(Math.abs(cart.delta))}` : ''}${cart.arrivalAt ? ` · 预计 ${clock(cart.arrivalAt)}` : ''}</p>` : '';
  const attempt = task.action ? `<p class="dinner-muted">${cartActionNotes[task.action.state] ?? ''}</p>` : '';
  return panel('购物车核对', attempt + compare + (cart?.issues.length ? `<p class="dinner-alert">${escape(cart.issues.join(' '))}</p>` : '') +
    form('review', `<p>核对 ${escape(selected.store)} · ${escape(selected.item)}${selected.spec ? ` · ${escape(selected.spec)}` : ''} · ${selected.quantity} 份。</p>
      ${check('matched', '我已核对店铺、餐品、规格和份数。', 'required')}
      <div class="dinner-fields">
        ${feesField('total', '实际应付（含配送）', money(cart?.total ?? (task.sample ? selected.total : null)), true)}
        ${field('minutes', '预计送达（从当前起的分钟数）', cart?.minutes ?? (task.sample ? selected.minutes : ''), 'number', 'min="0" max="300"')}
        ${select('spice', '确认辣度', menuSpice, cart?.spice ?? selected.spice)}
      </div>`, '保存核对结果'));
}

function reminderFile(task) {
  const date = task.goal.reminderAt;
  if (!date) return;
  const stamp = value => new Date(value).toISOString().replace(/[-:]|\.\d{3}/g, '');
  const label = ('晚饭提醒 ' + (task.goal.activity || '')).replace(/[\\;,]/g, char => '\\' + char).replace(/\r?\n/g, '\\n');
  const encode = new TextEncoder();
  const fold = line => {
    let result = '', bytes = 0;
    for (const char of line) {
      const size = encode.encode(char).length;
      if (bytes + size > 75) { result += '\r\n '; bytes = 1; }
      result += char; bytes += size;
    }
    return result;
  };
  const content = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Jingyu//Dinner//ZH', 'BEGIN:VEVENT',
    `UID:${task.id}@jingyu.local`, `DTSTAMP:${stamp(Date.now())}`, `DTSTART:${stamp(date)}`, `SEQUENCE:${task.revision}`,
    `SUMMARY:${label}`, 'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${label}`, 'TRIGGER:PT0M',
    'END:VALARM', 'END:VEVENT', 'END:VCALENDAR', ''].map(fold).join('\r\n');
  const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = '小鲸鱼晚饭提醒.ics'; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

export function mountDinner(container, request, { desktop = false, onAuthLost = () => {} } = {}) {
  const state = { view: null, id: '', mode: '', busy: false, dirty: false, disposed: false };
  let interval;
  const get = id => request(route + (id ? `?id=${encodeURIComponent(id)}` : ''));
  const post = (action, body = {}) => request(route, { action, ...body });
  const task = () => state.view?.task;
  const mobile = () => state.view?.mobile;
  const payload = () => ({ id: state.id, revision: task()?.revision });

  function message(value, error = false) {
    const node = container.querySelector('[data-dinner-message]');
    if (!node) return;
    node.textContent = value;
    node.classList.toggle('dinner-alert', error);
    node.hidden = !value;
  }

  function reset() {
    Object.assign(state, { mode: '', dirty: false, draft: {}, sample: false, quote: {}, candidateId: '', choice: '', menu: '', preview: null, previewIndex: null });
  }

  function profilePanel(view) {
    const settings = view.companion;
    const cardId = state.cardId ?? settings.task;
    const card = settings.cards.find(item => item.id === cardId) ?? { id: '', title: '', style: 'gentle', address: '', length: 'normal' };
    const choices = Object.fromEntries(settings.cards.map(item => [item.id, item.title]));
    const note = view.preferences.savedAt ? `<p class="dinner-muted">已保存偏好 · ${dateLabel(view.preferences.savedAt)}${view.preferences.avoidSpicy ? ' · 不吃辣' : ''}${view.preferences.favorite ? ` · ${escape(view.preferences.favorite.item)}` : ''}</p>` : '';
    return `<details class="dinner-card"${state.mode === 'companion' ? ' open' : ''}><summary>个性卡、陪伴与口味记忆</summary>
      ${select('cardEditor', '编辑个性卡', { ...choices, new: '新建卡片' }, cardId)}
      ${form('card-save', `<input type="hidden" name="id" value="${escape(card.id)}"><div class="dinner-fields">
      ${field('title', '卡片名称', card.title, 'text', 'required maxlength="24"')}${select('style', '语气', styleNames, card.style)}
      ${field('address', '希望怎么称呼你', card.address, 'text', 'maxlength="16"')}
      ${select('length', '聊天和通话的回复长度', { short: '简短', normal: '自然', detailed: '较详细' }, card.length)}</div>
      <div data-card-preview class="dinner-muted"></div>`, '保存卡片')}
      ${card.id && !Object.hasOwn(styleNames, card.id) ? actions(button('删除此卡', 'card-delete', card.id)) : ''}
      ${form('companion-settings', `<div class="dinner-fields">
      ${select('task', '晚饭任务卡', choices, settings.task)}${select('reminder', '页面提醒卡', { task: '跟随任务卡', ...choices }, settings.reminder)}
      ${select('mode', '陪伴方式', { ask: '只在我问时回应', tasks: '只提醒我设定的事项', daily: '任务提醒与每日回顾' }, settings.mode)}
      ${field('quietStart', '安静开始（北京时间）', settings.quietStart, 'time')}${field('quietEnd', '安静结束（北京时间）', settings.quietEnd, 'time')}</div>
      ${check('paused', '暂停陪伴提醒', settings.paused ? 'checked' : '')}`, '保存陪伴设置')}
      ${note}${note ? actions(button('清除口味记忆', 'clear-preferences')) : ''}</details>`;
  }

  function desktopPanel(view) {
    if (!desktop) return '';
    const pairing = mobile();
    const interfaces = Object.fromEntries(pairing.addresses.map(({ name, address }) => [address, `${name} · ${address}`]));
    return `<details class="dinner-card"${state.mode === 'pairing' ? ' open' : ''}><summary>连接手机${pairing.connected ? ' · 已配对' : ''}</summary>
      <p class="dinner-muted">在自己的可信 Wi-Fi 下连接手机。此入口使用局域网 HTTP，请避免在共享网络试用。</p>
      ${pairing.url ? `<p>手机浏览器输入 <code>${escape(pairing.url)}</code></p>${pairing.code ? `<p>配对码 <strong class="dinner-code">${escape(pairing.code)}</strong> · 5 分钟内一次有效</p>` : ''}
        ${actions(button('生成新配对码', 'mobile-renew'), button('关闭手机入口', 'mobile-stop'))}` : pairing.addresses.length ?
        form('mobile-start', select('address', '电脑的网络地址', interfaces, pairing.addresses[0].address), '开启手机配对') : '<p>电脑尚未连接可用于配对的局域网。</p>'}
      </details><details class="dinner-card"><summary>DeepSeek 整理${view.modelReady ? ' · 已绑定' : ''}</summary>
      <p class="dinner-muted">本地识别无需 Key。选择 DeepSeek 整理时，仅发送当前输入的需求或你提供的菜单摘录。</p>
      ${form('key-save', field('key', '晚饭任务 API Key', '', 'password', 'autocomplete="off" maxlength="512" required'), view.modelReady ? '更新 Key' : '绑定 Key')}
      ${view.modelReady ? actions(button('清除 Key', 'key-clear')) : ''}</details>`;
  }

  function renderTask(current, view) {
    const finished = ['completed', 'cancelled'].includes(current.status);
    const editable = !finished && current.status !== 'handled' && current.action?.state !== 'running';
    const platform = view.platforms[current.goal.platform];
    const hasPlatform = desktop && view.platformWindow && editable && !current.sample;
    const selected = current.candidates.find(row => row.id === current.selected?.id);
    const editing = state.mode === 'revising';
    const activeChoice = current.candidates.find(row => row.id === state.choice);
    const statusLine = `<div class="dinner-summary"><span class="dinner-state">${statuses[current.status]}</span>${current.sample ? ' <span class="dinner-state" data-tone="check">演示数据</span>' : ''}<span class="dinner-muted">任务 ${escape(current.id.slice(0, 8))} · 版本 ${current.revision}</span></div>`;
    const canRemind = current.goal.reminderAt && !finished && current.action?.state !== 'running';
    const goalPanel = panel('晚饭任务', `${statusLine}<p class="dinner-goal">${escape(current.goal.goal)}</p>
      <dl class="dinner-facts"><div><dt>含配送预算</dt><dd>${yuan(current.goal.budget)}</dd></div><div><dt>口味</dt><dd>${current.goal.spice === 'avoid' ? '不吃辣' : '不限'}</dd></div>
      <div><dt>最晚送达</dt><dd>${dateLabel(current.goal.latestAt)}</dd></div><div><dt>晚间安排</dt><dd>${escape(current.goal.activity || '未填写')}</dd></div>
      <div><dt>平台</dt><dd>${escape(platform.name)}</dd></div></dl>
      ${editing ? form('revise', goalFields(state.draft, view.platforms, true, false), '保存调整') + actions(button('收起', 'close-editor')) : ''}
      ${actions(editable && !editing ? button('调整需求', 'edit-goal') : '', editable && ['confirmed', 'review', 'checked'].includes(current.status) ? button('重新选餐', 'replan') : '',
        !finished && current.action?.state !== 'running' ? button('取消任务', 'cancel') : '', finished ? button('删除记录', 'remove-task') : '',
        canRemind ? button(current.reminder?.paused || current.reminder?.dismissedAt ? '恢复提醒' : '暂停提醒', current.reminder?.paused || current.reminder?.dismissedAt ? 'reminder-resume' : 'reminder-pause') + button('导出日历提醒', 'reminder') : '')}
      ${current.goal.reminderAt ? `<p class="dinner-muted">提醒时间 ${dateLabel(current.goal.reminderAt)}${current.reminder?.paused ? ' · 已暂停' : current.reminder?.dismissedAt ? ' · 已读' : ''} · 导出后请在日历中管理</p>` : ''}`);

    const platformActions = current.sample || finished || current.status === 'handled' ? '' : actions(
      hasPlatform ? button('在电脑打开 ' + escape(platform.name), 'platform-open') : '',
      `<a class="dinner-button" href="${escape(platform.url)}" target="_blank" rel="noopener noreferrer">打开${escape(platform.name)}官方入口</a>`);
    const editQuotes = editable && !current.sample;
    const collecting = editQuotes && ['quote', 'menu'].includes(state.mode);
    const offerPanel = panel('候选比较', platformActions +
      (current.candidates.length ? `<div class="dinner-options">${current.candidates.map(row => optionCard(row, current, editQuotes)).join('')}</div>` : '<p>可以从平台选择菜单文字，也可以手工录入费用和预计送达时间。</p>') +
      (editQuotes ? actions(button('录入一份餐品', 'new-candidate', '', true), button('整理菜单摘录', 'edit-menu')) : '') +
      (collecting ? (state.mode === 'quote' ? form('save-candidate', quoteFields(state.quote), '保存报价') : `
        ${textarea('menuText', '菜单摘录', state.menu, 3000, '每行：店铺 | 餐品 | 规格 | 单价 | 包装 | 配送 | 优惠 | 分钟 | 辣度')}
        ${actions(hasPlatform ? button('读取平台所选文字', 'platform-selection') : '', button('按分隔符整理', 'menu-local'), view.modelReady ? button('用 DeepSeek 整理', 'menu-model') : '')}
        ${state.preview ? `<ul class="dinner-previews">${state.preview.map((row, i) => `<li>${escape(row.store)} · ${escape(row.item)} ${button('校对这项', 'use-preview', String(i))}</li>`).join('')}</ul>` : ''}`) + actions(button('收起', 'close-editor')) : ''));

    const confirmPanel = activeChoice ? panel('确认餐品', `<p>${escape(activeChoice.store)} · ${escape(activeChoice.item)} · ${escape(activeChoice.spec || '默认规格')} · ${activeChoice.quantity} 份 · ${yuan(activeChoice.total)}</p>` + form('confirm',
      check('acknowledged', '确认这份餐品与规格。', 'required') + (activeChoice.decision === 'check' ? check('acknowledgedMissing', '我会核对仍缺失的费用、送达或口味。', 'required') : ''), '确认选择')) : '';
    const stepPanel = current.status === 'confirmed' && selected ? panel('继续处理', current.sample ?
      actions(button('进入演示核对', 'handoff', '', true)) : `<p>请打开${escape(platform.name)}，核对店铺、餐品和规格。提交订单及付款在官方平台进行。</p>` +
        (hasPlatform && selected.quantity === 1 && !current.action ? form('platform-add', check('acknowledged', '在当前店铺页面尝试加入已选择的一份餐品。', 'required'), '确认后尝试加购') : '') +
        actions(button('我在平台手工加购', 'handoff', '', true))) : '';

    const pending = current.action?.state === 'running' ? panel('等待操作结果', '<p>加购正在返回。可以稍后同步查看购物车状态。</p>') : '';
    const handledPanel = current.status === 'checked' ? panel('标记已处理', form('mark-handled',
      check('done', current.sample ? '我已完成演示中的点餐。' : '我已自行处理好这次点餐。', 'required'), '记录处理结果')) : '';
    const feedbackPanel = current.status === 'handled' ? panel('用餐反馈', form('finish',
      `<p class="dinner-muted">${current.sample ? '演示' : '用户'}确认于 ${dateLabel(current.handled.at)}。吃完后再来记录感受。</p>` +
      select('rating', '这次体验', { liked: '喜欢', okay: '一般', avoid: '下次换一个' }, 'liked') + textarea('note', '补充感受', '', 300) +
      (current.sample ? '' : check('rememberSpice', '保存这次的辣度要求，供以后选餐使用。') + check('rememberFavorite', '喜欢时记住这份餐品，供下次选餐使用。')), '完成并保存反馈')) : '';
    const feedback = current.feedback ? panel('已保存反馈', `<p>${({ liked: '喜欢', okay: '一般', avoid: '下次换一个' })[current.feedback.rating]}${current.feedback.note ? ` · ${escape(current.feedback.note)}` : ''}</p>`) : '';
    const history = `<details class="dinner-card"><summary>任务记录</summary><ol class="dinner-history">${[...current.events].reverse().map(row => `<li><time>${dateLabel(row.at)}</time><span>${escape(row.note)}</span></li>`).join('')}</ol></details>`;
    return goalPanel + (current.status === 'planning' || current.status === 'confirmed' || collecting ? offerPanel :
      `<details class="dinner-card"><summary>候选及平台入口</summary>${platformActions}<div class="dinner-options">${current.candidates.map(row => optionCard(row, current, false)).join('')}</div></details>`) +
      confirmPanel + stepPanel + pending + cartReview(current) + handledPanel + feedbackPanel + feedback + history;
  }

  function render() {
    if (state.disposed || !container.isConnected) return;
    const view = state.view;
    if (!view) { container.innerHTML = '<p data-dinner-message role="status" aria-live="polite">正在读取晚饭任务…</p>'; return; }
    const current = view.task;
    const stage = !current ? 0 : current.status === 'planning' ? 1 : ['confirmed', 'review'].includes(current.status) ? 2 : 3;
    const greeting = copy[view.profile.style][stage];
    const intro = !current ? panel(state.sample ? '新建演示任务' : '新建晚饭任务',
      `${state.sample ? '<p class="dinner-state" data-tone="check">使用虚构菜单和报价</p>' : ''}` +
      (!state.sample && view.preferences.avoidSpicy ? '<p class="dinner-muted">已带入你确认过的口味偏好“不吃辣”，可为本次任务改选。</p>' : '') +
      form('create', goalFields(state.draft ?? {}, view.platforms, false, view.modelReady && !state.sample), '创建任务')) : renderTask(current, view);
    const reminderCard = view.companion.cards.find(card => card.id === view.companion.reminder) ?? view.profile;
    const reminders = view.dueReminders.length ? panel('晚饭提醒', `<p>${escape(reminderCard.address ? reminderCard.address + '，' : '')}${reminderVoice[reminderCard.style]}</p>` + view.dueReminders.map(item => `<div class="dinner-reminder"><p>${item.sample ? '演示 · ' : ''}${clock(item.at)} · ${escape(item.label || '晚饭待办')}</p>${actions(button('查看', 'show-reminder', item.id), button('标记已读', 'reminder-dismiss', item.id))}</div>`).join('')) : '';
    const recap = view.recap ? panel('今日晚饭回顾', `<p>今天已结束 ${view.recap.completed} 项，还有 ${view.recap.pending} 项进行中。</p>` +
      actions(button('稍后 30 分钟', 'recap-snooze'), button('今天已读', 'recap-dismiss'))) : '';
    container.innerHTML = `<section class="dinner-hero" data-style="${view.profile.style}"><img src="/app-icon.png" alt="" width="46" height="46"><div><span>AI 小鲸鱼 · ${escape(view.profile.title)}</span><p>${view.profile.address ? `${escape(view.profile.address)}，` : ''}${greeting}</p></div></section>
      <div class="dinner-toolbar">${actions(button('新建任务', 'new', '', !current && !state.sample), button('试用演示', 'sample'), button('同步', 'refresh'))}
      ${view.tasks.length ? `<label>最近任务<select data-dinner-select><option value="">选择任务</option>${view.tasks.map(row => `<option value="${escape(row.id)}" ${row.id === state.id ? 'selected' : ''}>${row.sample ? '演示 · ' : ''}${escape(row.goal.slice(0, 44))} · ${statuses[row.status]}</option>`).join('')}</select></label>` : ''}</div>
      <p data-dinner-message class="dinner-message" role="status" aria-live="polite" hidden></p>
      <div class="dinner-content">${reminders}${recap}${intro}${profilePanel(view)}${desktopPanel(view)}</div>`;
    previewCard();
  }

  function previewCard() {
    const form = container.querySelector('[data-dinner-form="card-save"]');
    if (!form) return;
    const { style, address } = form.elements;
    form.querySelector('[data-card-preview]').textContent = [
      copy[style.value][0], copy[style.value][1], reminderVoice[style.value],
    ].map(line => (address.value ? address.value + '，' : '') + line).join('　/　');
  }

  function signature(view) {
    return JSON.stringify([view.task?.revision, view.task?.candidates.map(row => row.decision), view.tasks, view.dueReminders,
      view.companion, view.recap, view.preferences, view.modelReady, view.mobile]);
  }

  async function sync(id = state.id, { poll = false, initial = false } = {}) {
    const before = state.id;
    let view = await get(id);
    if (initial && view.tasks.length) {
      id = (view.tasks.find(row => !['completed', 'cancelled'].includes(row.status)) ?? view.tasks[0]).id;
      view = await get(id);
    }
    if (state.disposed || (poll && (state.id !== before || state.busy))) return;
    if (poll && signature(view) === signature(state.view)) return;
    if (poll && state.dirty) { message('另一台设备更新了任务。保存前请先同步。'); return; }
    const newTask = id !== state.id;
    const changed = view.task?.revision !== state.view?.task?.revision;
    state.view = view;
    state.id = id;
    if (newTask || (poll && changed)) reset();
    if (!state.id && !state.sample && !Object.keys(state.draft ?? {}).length) state.draft = { spice: view.preferences.avoidSpicy ? 'avoid' : 'any' };
    render();
  }

  function report(error) {
    if (error.status === 401 && !desktop) onAuthLost(error.message);
    else message(error.message || '暂时无法连接桌面，请确认应用仍在运行。', true);
  }

  async function run(work) {
    if (state.busy || state.disposed) return;
    state.busy = true;
    container.setAttribute('aria-busy', 'true');
    const controls = [...container.querySelectorAll('button')].filter(node => !node.disabled);
    for (const node of controls) node.disabled = true;
    try { await work(); } catch (error) { report(error); }
    finally { state.busy = false; container.removeAttribute('aria-busy'); for (const node of controls) node.disabled = false; }
  }

  function canDiscard() {
    return !state.dirty || window.confirm('本页有未保存的编辑，要同步或切换任务吗？');
  }

  function usageLine(result, label) {
    const usage = result.usage;
    const tokens = usage?.input != null && usage?.output != null ? ` · 输入 ${usage.input} token，输出 ${usage.output} token` : '';
    message((result.warning || label) + tokens);
  }

  container.addEventListener('input', event => {
    if (event.target.matches('[data-dinner-select]')) return;
    if (event.target.closest('[data-dinner-form="card-save"]')) previewCard();
    if (event.target.name === 'menuText') state.menu = event.target.value;
    if (event.target.closest('form') || event.target.name === 'menuText') state.dirty = true;
  });

  container.addEventListener('change', event => {
    if (event.target.name === 'cardEditor') {
      if (canDiscard()) { reset(); state.mode = 'companion'; state.cardId = event.target.value; render(); }
      else event.target.value = state.cardId ?? state.view.companion.task;
      return;
    }
    if (!event.target.matches('[data-dinner-select]')) return;
    if (!canDiscard()) { event.target.value = state.id; return; }
    const next = event.target.value;
    void run(async () => { reset(); await sync(next); });
  });

  container.addEventListener('submit', event => {
    const action = event.target.dataset.dinnerForm;
    if (!action) return;
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.target));
    for (const name of ['acknowledged', 'acknowledgedMissing', 'matched', 'done', 'rememberSpice', 'rememberFavorite']) {
      if (name in values) values[name] = true;
    }
    void run(async () => {
      let body = { ...payload(), ...values };
      if (action === 'create' || action === 'revise') body = { ...payload(), goal: values, sample: state.sample };
      if (action === 'save-candidate') body = { ...payload(), candidateId: state.candidateId, candidate: values };
      if (action === 'confirm') body.candidateId = state.choice;
      if (action === 'platform-add') body.candidateId = task()?.selected?.id;
      if (['card-save','companion-settings'].includes(action)) body = { ...values, revision: state.view.companion.revision };
      if (action === 'companion-settings') body.paused = values.paused === 'on';
      const result = await post(action, body);
      const id = action === 'create' ? result.id : state.id;
      const nextPreview = action === 'save-candidate' && state.previewIndex !== null
        ? { menu: state.menu, items: state.preview.filter((_, index) => index !== state.previewIndex) } : null;
      reset();
      if (action === 'mobile-start') state.mode = 'pairing';
      if (['card-save','companion-settings'].includes(action)) {
        state.mode = 'companion';
        if (action === 'card-save') state.cardId = values.id || result.companion.cards.at(-1).id;
      }
      if (nextPreview?.items.length) Object.assign(state, { mode: 'menu', menu: nextPreview.menu, preview: nextPreview.items });
      await sync(id);
      if (action === 'platform-add') message(task().events.at(-1).note);
      else if (action === 'key-save') message('DeepSeek Key 已绑定。');
      else if (action === 'mobile-start') message('手机入口已开启。');
      else if (!['create','confirm','finish'].includes(action)) message('已保存。');
    });
  });

  container.addEventListener('click', event => {
    const actionButton = event.target.closest('[data-dinner-click]');
    if (!actionButton) return;
    const action = actionButton.dataset.dinnerClick;
    const id = actionButton.dataset.id;
    void run(async () => {
      if (action === 'refresh') { if (canDiscard()) { reset(); await sync(); message('已同步。'); } return; }
      if (['new', 'sample'].includes(action)) {
        if (!canDiscard()) return;
        state.id = ''; reset(); state.sample = action === 'sample';
        state.draft = state.sample ? { goal: '演示：今晚 30 元以内，不吃辣。', budget: '30.00', spice: 'avoid' } : {};
        await sync(''); return;
      }
      if (action === 'intent' || action === 'intent-model') {
        const values = Object.fromEntries(new FormData(actionButton.closest('form')));
        const result = await post('intent', { text: values.goal, sample: state.sample, model: action === 'intent-model' });
        state.draft = { ...values, ...Object.fromEntries(Object.entries(result.goal).filter(([, value]) => value !== '')) };
        state.dirty = true; render(); usageLine(result, '已填入识别结果，请核对后创建。'); return;
      }
      if (action === 'edit-goal') { if (canDiscard()) { reset(); state.mode = 'revising'; state.draft = toDraft(task().goal); render(); } return; }
      if (action === 'close-editor') { if (canDiscard()) { reset(); render(); } return; }
      if (action === 'new-candidate' || action === 'edit-candidate') {
        if (!canDiscard()) return;
        reset(); state.mode = 'quote'; state.candidateId = id ?? '';
        state.quote = id ? quoteDraft(task().candidates.find(row => row.id === id)) : {};
        render(); return;
      }
      if (action === 'edit-menu') { if (canDiscard()) { reset(); state.mode = 'menu'; render(); } return; }
      if (action === 'platform-selection') {
        const result = await post('platform-selection', payload());
        state.menu = result.text; state.preview = null; state.dirty = true;
        render(); message(`已读入 ${result.source} 的所选文字，请核对内容。`); return;
      }
      if (action === 'menu-local' || action === 'menu-model') {
        const result = await post('menu', { text: state.menu, model: action === 'menu-model' });
        state.preview = result.candidates; state.dirty = true; render();
        usageLine(result, `整理出 ${result.candidates.length} 项。${result.invalid ? `有 ${result.invalid} 项待手工录入。` : ''}`); return;
      }
      if (action === 'use-preview') {
        state.mode = 'quote'; state.candidateId = ''; state.previewIndex = Number(id); state.quote = state.preview[state.previewIndex]; render(); return;
      }
      if (action === 'choose') {
        if (canDiscard()) { reset(); state.choice = id; render(); container.querySelector('[data-dinner-form="confirm"]')?.scrollIntoView({ block: 'nearest' }); }
        return;
      }
      if (action === 'reminder') { reminderFile(task()); return; }
      if (action === 'card-delete') {
        if (!window.confirm('删除这张卡片？引用它的会话将使用原角色卡。')) return;
        await post(action, { id, revision: state.view.companion.revision });
        reset(); state.mode = 'companion'; state.cardId = undefined; await sync(); return;
      }
      if (action === 'recap-dismiss' || action === 'recap-snooze') {
        if (!canDiscard()) return;
        await post(action, { day: state.view.recap.day }); reset(); await sync(); return;
      }
      if (action === 'show-reminder') { if (canDiscard()) { reset(); await sync(id); } return; }
      if (action === 'reminder-dismiss') {
        if (!canDiscard()) return;
        const notice = state.view.dueReminders.find(row => row.id === id);
        await post(action, { id, revision: notice.revision }); reset(); await sync(); return;
      }
      if (action === 'platform-open') { await post(action, payload()); message('已在电脑打开平台窗口。'); return; }
      if (action === 'remove-task') {
        if (!window.confirm('删除这条任务及由它保存的口味偏好？')) return;
        await post(action, { ...payload(), confirmed: true }); reset(); await sync(''); message('已删除任务记录。'); return;
      }
      if (['cancel', 'remove-candidate', 'replan'].includes(action) && state.dirty && !canDiscard()) return;
      await post(action, { ...payload(), candidateId: id });
      reset();
      if (action === 'mobile-renew' || action === 'mobile-stop') state.mode = 'pairing';
      await sync();
      if (action === 'handoff') container.querySelector('[data-dinner-form="review"]')?.scrollIntoView({ block: 'nearest' });
    });
  });

  reset(); render();
  void sync('', { initial: true }).catch(report);
  let polling = false;
  interval = setInterval(async () => {
    if (!container.isConnected || state.disposed) { clearInterval(interval); return; }
    if (!state.view || state.busy || polling || document.hidden) return;
    polling = true;
    try { await sync(state.id, { poll: true }); } catch (error) { report(error); }
    finally { polling = false; }
  }, 4000);
  return () => { state.disposed = true; clearInterval(interval); };
}
