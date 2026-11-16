export function companionBinding({ api, escapeHtml: e, chatName, toast }) {
  async function mount() {
    const section = document.querySelector('#jingyu-card-binding');
    if (!section) return;
    try {
      const { cards, chats } = await api('/api/jingyu/companion');
      if (!section.isConnected || !chats.length) return;
      section.querySelector('form').hidden = false;
      const form = section.querySelector('form'), { chat, card, quiet } = form.elements;
      chat.innerHTML = chats.map(({ chat }) => `<option value="${e(chat)}">${e(chatName(chat))}</option>`).join('');
      card.innerHTML = '<option value="">沿用原角色卡</option>' + cards.map(row => `<option value="${e(row.id)}">${e(row.title)}</option>`).join('');
      function show() {
        const row = chats.find(item => item.chat === chat.value);
        card.value = cards.some(item => item.id === row?.binding?.card) ? row.binding.card : '';
        quiet.checked = Boolean(row?.binding?.quiet);
      }
      chat.onchange = show; show();
      form.onsubmit = async event => {
        event.preventDefault();
        const selected = chats.find(item => item.chat === chat.value);
        const binding = { chat: chat.value, card: card.value, quiet: quiet.checked };
        const submit = form.querySelector('button');
        submit.disabled = true;
        try {
          await api('/api/jingyu/companion', binding);
          selected.binding = binding.card ? binding : null;
          toast('已保存此会话的表达设置。');
        } catch (error) { toast(error.message); }
        finally { submit.disabled = false; }
      };
    } catch (error) { if (section.isConnected) toast(error.message); }
  }
  const page = () => `<section class="card" id="jingyu-card-binding"><h2>微信与通话个性卡</h2>
    <p class="subtle">在「晚饭与晚间安排」编辑个性卡。这里可以给已允许的联系人或群聊选择表达风格，每个微信账号独立绑定。</p>
    <form hidden><div class="form-grid"><label class="field">微信会话<select name="chat"></select></label>
    <label class="field">表达风格<select name="card"></select></label></div>
    <label><input type="checkbox" name="quiet"> 该会话的学习提醒遵循陪伴暂停和安静时段</label>
    <div class="button-row"><button class="button primary">保存会话个性卡</button></div></form></section>`;
  return { page, mount };
}

export function peopleMemory({ api, escapeHtml: e, chatName, toast }) {
  let selected = '';
  const rows = (items, state) => items.map(item => {
    const owner = item.chat === state.ownerChat;
    const canShare = owner && Number(item.shareable) === 1;
    const scope = owner
      ? item.shareable ? (item.approved === 0 ? '已撤销共享' : item.approved === 1 ? '已确认共享' : state.confirmedMemoryOnly ? '待确认共享' : '可自动共享') : '仅主人'
      : '联系人资料';
    return `<article class="tool-row"><div><strong>${e(chatName(item.chat))} · ${scope}</strong><p>${e(item.text)}</p>
      <small>${e(item.person)} · ${e(new Date(item.at * 1000).toLocaleString())}</small></div>
      <div class="button-row">
      ${canShare && state.confirmedMemoryOnly ? `<button class="button" data-memory-action="share" data-id="${e(item.id)}" data-approve="${!item.approved}">${item.approved ? '撤销共享' : '确认共享此原话'}</button>` : ''}
      ${item.shareable ? `<button class="button" data-memory-action="private" data-id="${e(item.id)}">设为私密</button>` : ''}
      <button class="button danger" data-memory-action="delete" data-id="${e(item.id)}">移出记忆</button></div></article>`;
  }).join('') || '<p class="subtle">这位人物暂无可显示的聊天原话。</p>';

  function page(state) {
    const people = state.memoryPeople ?? [];
    if (!people.some(item => item.chat === selected)) selected = '';
    return `<section class="card" id="jingyu-people-memory"><h2>分人物记忆</h2>
      <p class="subtle">自动聊天记忆收录经允许私聊的本人文字原话。主人可回忆各联系人的资料，联系人可回忆自己和主人允许共享的内容。可按人物调整谁能在对话中引用资料。</p>
      <p class="subtle">共 ${e(state.conversationMemoryCount ?? 0)} 条片段。每个视图显示最近 100 条，移出记忆保留微信原聊天。</p>
      <label><input type="checkbox" id="jingyu-confirmed-memory" ${state.confirmedMemoryOnly ? 'checked' : ''}> 主人原话逐条确认后才共享</label>
      <label class="field">人物<select id="jingyu-memory-person"><option value="">全部人物</option>
      ${people.map(row => `<option value="${e(row.chat)}" ${selected === row.chat ? 'selected' : ''}>${e(row.person)} · ${e(row.chat.split(':').at(-1))} · ${row.count} 条</option>`).join('')}</select></label>
      <label id="jingyu-contact-memory-label" hidden><input type="checkbox" id="jingyu-contact-memory"> 此人资料只供其本人对话使用</label>
      <div id="jingyu-people-rows">${selected ? '<p>正在读取此人记忆…</p>' : rows(state.conversationMemories ?? [], state)}</div></section>`;
  }

  function mount(state, refresh) {
    const section = document.querySelector('#jingyu-people-memory');
    if (!section) return;
    const picker = section.querySelector('#jingyu-memory-person');
    const list = section.querySelector('#jingyu-people-rows');
    const toggle = section.querySelector('#jingyu-contact-memory');
    let wave = 0;
    async function load() {
      const chat = selected, seq = ++wave;
      const person = state.memoryPeople?.find(item => item.chat === chat);
      toggle.parentElement.hidden = !person || chat === state.ownerChat;
      toggle.checked = Boolean(person?.selfOnly);
      list.textContent = '正在读取记忆…';
      try {
        const data = await api('/api/jingyu/people-memory', { chat });
        if (seq === wave) list.innerHTML = rows(data.rows, state);
      } catch (error) { if (seq === wave) list.textContent = error.message; }
    }
    const apply = async (route, body) => {
      try { await api('/api/jingyu/' + route, body); await refresh(); }
      catch (error) { toast(error.message); await load(); }
    };
    picker.onchange = () => { selected = picker.value; void load(); };
    toggle.onchange = () => void apply('memory-contact', { chat: selected, selfOnly: toggle.checked });
    const policy = section.querySelector('#jingyu-confirmed-memory');
    policy.onchange = async () => {
      policy.disabled = true;
      await apply('memory-policy', { confirmedOnly: policy.checked });
      if (policy.isConnected) { policy.checked = state.confirmedMemoryOnly; policy.disabled = false; }
    };
    list.onclick = event => {
      const button = event.target.closest('[data-memory-action]');
      if (!button || button.disabled) return;
      const action = button.dataset.memoryAction, id = button.dataset.id;
      button.disabled = true;
      void apply('conversations/' + action, { id, approved: button.dataset.approve === 'true' });
    };
    if (selected) void load();
  }
  return { page, mount };
}
