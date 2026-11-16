// Electron renderer smoke test using an isolated temporary project and no paid calls.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');

const project = path.resolve(__dirname, '..');
const tempParent = fs.realpathSync(os.tmpdir());
const root = fs.mkdtempSync(path.join(tempParent, 'jingyu-dinner-ui-'));
app.setPath('userData', path.join(root, 'electron'));
app.commandLine.appendSwitch('disable-renderer-backgrounding');

function renderer(options) {
  return new BrowserWindow({ show: false, ...options, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
}

const run = (win, source) => win.webContents.executeJavaScript(source, true).catch(error => {
  throw Error(error.message + ' · ' + source.slice(0,200), {cause:error});
});
const click = (win, selector) => run(win, `document.querySelector(${JSON.stringify(selector)}).click()`);
const form = (win, action, inputs, section = 'dinner', mode) => run(win, `(() => {
  const form = document.querySelector('[data-${section}-form="${action}"]${mode ? '[data-mode="'+mode+'"]' : ''}');
  for (const [name, value] of Object.entries(${JSON.stringify(inputs)})) {
    const field = form.elements.namedItem(name);
    if (field.type === 'checkbox') field.checked = value;
    else field.value = value;
    field.dispatchEvent(new Event('input', { bubbles: true }));
  }
  form.requestSubmit();
})()`);

async function ready(win, expression) {
  for (let i = 0; i < 80; i++) {
    if (await run(win, `Boolean(${expression})`)) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw Error('Renderer state timed out: ' + expression + ' · ' + (await run(win, 'document.querySelector("[data-dinner-message],[data-life-status],[data-commute-status],[data-trip-status],#dinner-pair-status")?.textContent ?? ""')).slice(0, 120));
}

app.whenReady().then(async () => {
  const { createConsole } = await import('./console-server.mjs');
  const { DinnerService } = await import('../packages/jingyu/dinner/service.mjs');
  const { DinnerGateway } = await import('../packages/jingyu/dinner/gateway.mjs');
  const { JingyuStore,actorChat } = await import('../packages/jingyu/store.mjs');
  const { jingyuFor } = await import('../packages/jingyu/service.mjs');
  const { parseTripMessage } = await import('../packages/jingyu/trip.mjs');
  fs.mkdirSync(path.join(root, 'config'), { recursive: true });
  fs.mkdirSync(path.join(root, 'roles'));
  fs.copyFileSync(path.join(project, 'config/wechatagent.example.json'), path.join(root, 'config/wechatagent.example.json'));
  const account='9'.repeat(64);
  fs.mkdirSync(path.join(root,'state/weflow'),{recursive:true});
  fs.writeFileSync(path.join(root,'state/weflow/active-account.json'),JSON.stringify({id:account}));
  const setupStore=new JingyuStore(root,account);
  try{setupStore.saveSettings({ownerWxid:'ui-trip-owner',sharedMemoryEnabled:true,allowGroupShared:false});}
  finally{setupStore.close();}
  const consoleServer = createConsole({ root, port: 0 });
  const dining = new DinnerService(root);
  const gateway = new DinnerGateway(dining, path.join(project, 'public/console'), { loopback: true });
  const desk = renderer({ width: 1260, height: 900 }), phone = renderer({ width: 390, height: 844 });
  try {
    const { port } = await consoleServer.start();
    await desk.loadURL(`http://127.0.0.1:${port}/#dinner`);
    await ready(desk, 'document.querySelector("#dinner-workspace [data-dinner-form=create]")');
    const { url, code } = await gateway.start('127.0.0.1');
    await phone.loadURL(url);
    await run(phone, `document.querySelector('#dinner-pair-form').elements.code.value=${JSON.stringify(code)}; document.querySelector('#dinner-pair-form').requestSubmit()`);
    await ready(phone, 'document.querySelector("[data-dinner-click=sample]")');
    await click(phone, '[data-dinner-click=sample]');
    await ready(phone, 'document.querySelector("[data-dinner-form=create] textarea").value.includes("演示")');
    await form(phone, 'create', {});
    await ready(phone, 'document.querySelectorAll(".dinner-option").length === 3');
    const local = dining.view().tasks[0];
    await ready(desk, 'document.querySelector("[data-dinner-select]")?.options.length === 2');
    await run(desk, `(() => { const picker = document.querySelector('[data-dinner-select]'); picker.value=${JSON.stringify(local.id)}; picker.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await ready(desk, 'document.querySelectorAll(".dinner-option").length === 3');
    await click(desk, '[data-dinner-click=choose]');
    await form(desk, 'confirm', { acknowledged: true });
    await ready(phone, 'document.querySelector("[data-dinner-click=handoff]")');
    await click(phone, '[data-dinner-click=edit-goal]');
    await form(phone, 'revise', { budget: '20' });
    await ready(desk, 'document.querySelector(".dinner-facts").textContent.includes("20.00")');
    assert.equal(await run(desk, 'Boolean(document.querySelector("[data-dinner-click=handoff]"))'), false);
    await click(phone, '[data-dinner-click=choose]');
    await form(phone, 'confirm', { acknowledged: true });
    await ready(phone, 'document.querySelector("[data-dinner-click=handoff]")');
    await click(phone, '[data-dinner-click=handoff]');
    await ready(phone, 'document.querySelector("[data-dinner-form=review]")');
    await form(phone, 'review', { matched: true });
    await ready(phone, 'document.querySelector("[data-dinner-form=mark-handled]")');
    await form(phone, 'mark-handled', { done: true });
    await ready(phone, 'document.querySelector("[data-dinner-form=finish]")');
    await form(phone, 'finish', { rating: 'liked', note: '合成测试反馈' });
    await ready(desk, 'document.body.textContent.includes("已保存反馈")');
    assert.equal(dining.get(local.id).status, 'completed');
    assert.equal(dining.preferences().savedAt, null);
    assert(await run(phone, 'document.documentElement.scrollWidth <= innerWidth'));
    await run(phone, `(() => { const editor = document.querySelector('[name=cardEditor]'); editor.value = 'new'; editor.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await form(phone, 'card-save', { title: '跨端测试卡', style: 'playful', address: '小潮', length: 'short' });
    await ready(phone, 'document.querySelector("[name=cardEditor]").selectedOptions[0].textContent === "跨端测试卡"');
    const card = dining.companion().cards.at(-1);
    await form(phone, 'companion-settings', { task: card.id, mode: 'daily' });
    await ready(desk, 'document.querySelector(".dinner-hero").textContent.includes("跨端测试卡")');
    assert(await run(desk, 'document.querySelector(".dinner-hero").textContent.includes("小潮")'));
    await click(desk, '[data-page=life]');
    await ready(desk, 'document.querySelector("[data-life-form=notice]")');
    await click(phone, '[data-mobile-page=life]');
    await ready(phone, 'document.querySelector("[data-life-form=notice]")');
    await form(phone, 'notice', { text: '预约 2090-11-18T16:00，地点：实验室，请携带校园卡。' }, 'life');
    await ready(phone, 'document.querySelector("[data-life-form=save] [name=start]").value === "2090-11-18T16:00"');
    await form(phone, 'save', { title:'跨端预约', keep:true }, 'life');
    await ready(desk, 'document.querySelector("[data-life-select]").options.length === 2');
    const life = dining.life.view().tasks[0];
    await run(desk, `(() => { const picker = document.querySelector('[data-life-select]'); picker.value=${JSON.stringify(life.id)}; picker.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await ready(desk, 'document.querySelector("#life-task h2").textContent === "跨端预约"');
    await form(desk, 'save', { start:'2090-11-18T16:30' }, 'life');
    await ready(phone, 'document.querySelector("[data-life-form=save] [name=start]").value === "2090-11-18T16:30"');
    assert(await run(phone, 'document.documentElement.scrollWidth <= innerWidth'));
    await form(phone, 'checkin', { energy:'low', pressure:'high', available:'25' }, 'life');
    await ready(phone, 'document.querySelector("[data-life-action^=suggest]")');
    await click(desk, '[data-page=commute]');
    await ready(desk, 'document.querySelector("[data-commute-form=save]")');
    await click(phone, '[data-mobile-page=commute]');
    await ready(phone, 'document.querySelector("[data-commute-form=save]")');
    const zoneDate = new Date(Date.now()+24*3600_000+8*3600_000).toISOString().slice(0,16);
    await form(phone,'save',{city:'北京',origin:'测试校门',destination:'测试车站',arrival:zoneDate,preferred:'walk'},'commute');
    await ready(phone,'document.querySelector("[data-commute-form=route][data-mode=walk]")');
    await form(phone,'route',{minutes:'25',source:'personal'},'commute','walk');
    await ready(phone,'document.querySelector("[data-commute-form=confirm][data-mode=walk]")');
    await form(phone,'route',{minutes:'30',source:'map'},'commute','bus');
    await ready(phone,'document.querySelector("[data-commute-form=confirm][data-mode=bus]")');
    await form(phone,'confirm',{},'commute','walk');
    await ready(phone,'document.querySelector("[data-commute-form=share]")');
    await ready(desk,'document.querySelector("[data-commute-select]").options.length === 2');
    const commute=dining.commute.view().list[0];
    await run(desk, `(() => { const picker = document.querySelector('[data-commute-select]'); picker.value=${JSON.stringify(commute.id)}; picker.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await ready(desk,'document.querySelector("[data-commute-form=share]")');
    await form(desk,'report',{},'commute');
    await ready(phone,'document.body.textContent.includes("待重新确认") && !document.querySelector("[data-commute-form=share]")');
    await form(phone,'confirm',{},'commute','bus');
    await ready(phone,'document.querySelector("[data-commute-form=share]")');
    await form(phone,'share',{recipient:'测试同学',confirmed:true},'commute');
    await ready(phone,'document.querySelector("[data-commute-copy]")?.value.includes("公交")');
    assert(await run(phone, 'document.documentElement.scrollWidth <= innerWidth'));
    await click(desk,'[data-page=trips]');
    await ready(desk,'document.querySelector("[data-trip-form=create]")');
    await form(desk,'create',{title:'跨会话看展'},'trip');
    await ready(desk,'document.querySelector("[data-trip-code]")');
    const {trips}=jingyuFor(root);
    const tripCode=trips.view().list[0].code;
    const actor='ui-trip-member', chat=actorChat(actor);
    const memberSay=(text,receipt)=>trips.chat(parseTripMessage('出游 '+tripCode+' '+text),{actor,chat,name:'测试同行者',receipt});
    memberSay('加入','ui-join');
    memberSay('预算135元','ui-draft');
    await ready(desk,'document.body.textContent.includes("对方有待确认草稿")');
    assert.equal(await run(desk,'document.body.textContent.includes("135.00")'),false);
    memberSay('确认 1','ui-confirm');
    await ready(desk,'document.body.textContent.includes("135.00")');
    const endDate=new Date(Date.now()+25*3600_000+8*3600_000).toISOString().slice(0,16);
    await form(desk,'candidate',{title:'测试展馆',place:'南门',start:zoneDate,end:endDate,per:'80',shared:'10'},'trip');
    await ready(desk,'document.querySelector("[data-trip-form=publish]")');
    await form(desk,'publish',{acceptGaps:true},'trip');
    await ready(desk,'document.body.textContent.includes("已发布方案")');
    assert.match(memberSay('查看','ui-view'),/测试展馆/);
    await click(phone, '#dinner-unpair');
    await ready(phone, 'document.querySelector("#dinner-pair-form")');
    assert.equal(gateway.status().connected, false);
    console.log(JSON.stringify({ desktopEntry:true, mobilePairing:true, taskShared:true, revisionSynced:true, feedbackSaved:true, mobileFits:true, cardSynced:true, lifeSynced:true, lifeSuggestion:true, commuteReplanned:true, commuteSharePrepared:true, tripDraftIsolated:true,tripPublished:true,unpairRevoked:true }));
  } finally {
    desk.destroy(); phone.destroy(); gateway.close(); dining.close();
    if (consoleServer.server.listening) {
      const closed = once(consoleServer.server, 'close');
      consoleServer.close(); await closed;
    }
    app.quit();
  }
}).catch(error => { console.error(error); app.exit(1); });

process.on('exit', () => {
  try {
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) === tempParent && path.basename(resolved).startsWith('jingyu-dinner-ui-')) fs.rmSync(resolved, { recursive: true, force: true });
  } catch {}
});
