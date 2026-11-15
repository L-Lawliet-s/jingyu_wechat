import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { DinnerService } from '../packages/jingyu/dinner/service.mjs';
import { DinnerGateway } from '../packages/jingyu/dinner/gateway.mjs';
import { QUOTE_LIFETIME, localIntent, validateGoal, validateCandidate, assessCandidate } from '../packages/jingyu/dinner/rules.mjs';
import { createConsole } from './console-server.mjs';

const at = Date.parse('2026-11-16T17:30:00+08:00');
const request = '今天六点下课，晚饭预算三十元，不吃辣，七点半有社团活动。';
const goal = { goal: request, budget: '30.00', platform: 'meituan', spice: 'avoid', readyAt: '2026-11-16T18:00', latestAt: '2026-11-16T19:30' };
const good = { store: '测试饭堂', item: '菌菇饭', spec: '普通份', unitPrice: '18.90', packing: '1.00', delivery: '2.15', discount: '1.02', minutes: '25', spice: 'none' };
const assets = path.resolve(import.meta.dirname, '../public/console');

function workspace(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, 'jingyu-dinner-test-'));
  const cleanups = [];
  t.after(async () => {
    for (const close of cleanups.reverse()) await close();
    const resolved = fs.realpathSync(root);
    if (path.dirname(resolved) === parent && path.basename(resolved).startsWith('jingyu-dinner-test-')) {
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
  return { root, onClose: fn => cleanups.push(fn) };
}

function service(t, options = {}) {
  const { root, onClose } = workspace(t);
  const opened = new DinnerService(root, { now: () => at, ...options });
  onClose(() => opened.close());
  return { root, opened, onClose };
}

async function withQuote(opened, candidate = good) {
  let current = await opened.dispatch({ action: 'create', goal });
  current = await opened.dispatch({ action: 'save-candidate', ...current, candidate });
  return { ...current, candidateId: opened.get(current.id).candidates[0].id };
}

test('local Chinese request parses constraints without changing the original wording', () => {
  const value = localIntent(request, at);
  assert.equal(value.goal, request);
  assert.equal(value.budget, '30');
  assert.equal(value.readyAt, '2026-11-16T18:00');
  assert.equal(value.latestAt, '2026-11-16T19:30');
  assert.equal(value.activity, '社团活动');
  assert.equal(value.spice, 'avoid');
  assert.equal(localIntent('明天19:00有活动，26.50元以内，淘宝闪购，辣也行。', at, { avoidSpicy: true }).spice, 'any');
  assert.equal(localIntent('明天19:00有活动，26.50元以内，淘宝闪购。', at).budget, '26.5');
  assert.throws(() => validateGoal({ ...goal, latestAt: '2026-02-30T19:30' }), /有效的日期/);
  assert.throws(() => validateGoal({ ...goal, budget: '20.001' }), /最多两位/);
});

test('quotes compare integer amounts, preserve missing fees, and age independently of plan updates', () => {
  const target = validateGoal(goal);
  const row = { ...validateCandidate(good), source: 'manual', observedAt: at };
  assert.equal(assessCandidate(row, target, at).total, 2103);
  assert.equal(assessCandidate(row, target, at).decision, 'fit');
  assert.equal(assessCandidate({ ...row, packing: null }, target, at).total, null);
  assert.equal(assessCandidate({ ...row, packing: null }, target, at).decision, 'check');
  assert.equal(assessCandidate({ ...row, unitPrice: 4000 }, target, at).decision, 'conflict');
  assert.equal(assessCandidate({ ...row, minutes: 110 }, target, at).decision, 'conflict');
  assert.equal(assessCandidate(row, target, at + QUOTE_LIFETIME).decision, 'stale');
  assert.throws(() => validateCandidate({ ...good, discount: '100.00' }), /优惠/);
});

test('demo mode remains separated, changing constraints invalidates approval, and feedback survives reopening', async t => {
  let now = at;
  const { root, opened, onClose } = service(t, { now: () => now });
  let latest = await opened.dispatch({ action: 'create', goal, sample: true });
  const { id } = latest;
  const initial = opened.view(id).task;
  assert.equal(initial.candidates.length, 3);
  assert(initial.candidates.every(row => row.source === 'sample'));
  assert.equal(initial.candidates.at(-1).decision, 'conflict');
  await assert.rejects(opened.dispatch({ action: 'confirm', ...latest, candidateId: initial.candidates.at(-1).id, acknowledged: true }), /冲突/);
  await assert.rejects(opened.dispatch({ action: 'platform-open', ...latest }, { desktop: true }), /演示任务/);
  const chicken = initial.candidates.find(row => row.item === '菌菇鸡肉饭');
  latest = await opened.dispatch({ action: 'confirm', ...latest, candidateId: chicken.id, acknowledged: true });
  const old = latest;
  latest = await opened.dispatch({ action: 'revise', ...latest, goal: { ...goal, budget: '20', latestAt: '2026-11-16T19:10' } });
  assert.equal(opened.get(id).selected, null);
  assert.match(opened.get(id).events.at(-1).note, /30.00 → ¥20.00/);
  await assert.rejects(opened.dispatch({ action: 'handoff', ...old }), /另一台设备/);
  const noodles = opened.view(id).task.candidates[0];
  latest = await opened.dispatch({ action: 'confirm', ...latest, candidateId: noodles.id, acknowledged: true });
  latest = await opened.dispatch({ action: 'handoff', ...latest });
  latest = await opened.dispatch({ action: 'review', ...latest, matched: true, total: '21', minutes: '32', spice: 'none' });
  assert.equal(opened.get(id).status, 'review');
  assert.equal(opened.get(id).cart.delta, 200);
  latest = await opened.dispatch({ action: 'review', ...latest, matched: true, total: '19', minutes: '32', spice: 'none' });
  latest = await opened.dispatch({ action: 'mark-handled', ...latest, done: true });
  now += 65 * 60_000;
  opened.close();
  const reopened = new DinnerService(root, { now: () => now });
  onClose(() => reopened.close());
  await assert.rejects(reopened.dispatch({ action: 'finish', ...latest, rating: 'liked', rememberSpice: true }), /演示任务/);
  latest = await reopened.dispatch({ action: 'finish', ...latest, rating: 'liked', note: '演示结束' });
  assert.equal(reopened.get(id).status, 'completed');
  assert.equal(reopened.get(id).handled.source, 'sample');
  assert.equal(reopened.preferences().savedAt, null);
  assert.equal(latest.revision, reopened.get(id).revision);
});

test('a cart attempt is claimed once and the actual quote needs its own confirmation', async t => {
  let calls = 0;
  let sendResult;
  const browser = { addDinnerItem: async () => { calls++; return new Promise(resolve => { sendResult = resolve; }); } };
  const { opened } = service(t, { browser });
  const item = await withQuote(opened);
  const confirmed = await opened.dispatch({ action: 'confirm', ...item, acknowledged: true });
  const args = { action: 'platform-add', ...confirmed, candidateId: item.candidateId, acknowledged: true };
  await assert.rejects(opened.dispatch(args), /桌面/);
  const first = opened.dispatch(args, { desktop: true });
  assert.equal(opened.get(item.id).action.state, 'running');
  await assert.rejects(opened.dispatch(args, { desktop: true }), /更新|仍在返回/);
  await assert.rejects(opened.dispatch({ action: 'cancel', id: item.id, revision: opened.get(item.id).revision }), /仍在返回/);
  sendResult('submitted');
  let latest = await first;
  assert.equal(calls, 1);
  assert.equal(opened.get(item.id).status, 'review');
  assert.equal(opened.get(item.id).cart, null);
  await assert.rejects(opened.dispatch({ action: 'review', ...latest, matched: false, total: '30', spice: 'none' }), /请确认/);
  latest = await opened.dispatch({ action: 'review', ...latest, matched: true, total: '21.03', minutes: 26, spice: 'none' });
  assert.equal(opened.get(item.id).status, 'checked');
  latest = await opened.dispatch({ action: 'replan', ...latest });
  latest = await opened.dispatch({ action: 'confirm', ...latest, candidateId: item.candidateId, acknowledged: true });
  await assert.rejects(opened.dispatch({ ...args, ...latest }, { desktop: true }), /已有加购尝试/);
  assert.equal(calls, 1);
});

test('ownership of remembered preferences is explicit and linked with independent evidence', async t => {
  const { opened } = service(t);
  async function resolveTask(rememberSpice, rememberFavorite, note) {
    let current = await withQuote(opened);
    current = await opened.dispatch({ action: 'confirm', ...current, acknowledged: true });
    current = await opened.dispatch({ action: 'handoff', ...current });
    current = await opened.dispatch({ action: 'review', ...current, matched: true, total: '21.03', minutes: 24, spice: 'none' });
    current = await opened.dispatch({ action: 'mark-handled', ...current, done: true });
    return opened.dispatch({ action: 'finish', ...current, rating: 'liked', note, rememberSpice, rememberFavorite });
  }
  await resolveTask(false, false, '私下试用');
  assert.equal(opened.preferences().savedAt, null);
  const rememberedSpice = await resolveTask(true, false, '记住辣度');
  const rememberedFavorite = await resolveTask(false, true, '记住喜欢');
  assert.equal(opened.preferences().spiceSource.id, rememberedSpice.id);
  assert.equal(opened.preferences().favoriteSource.id, rememberedFavorite.id);
  await opened.dispatch({ action: 'profile', style: 'playful', address: '同学' });
  const future = await withQuote(opened);
  assert.equal(opened.view(future.id).task.candidates[0].matchesFavorite, true);
  await opened.dispatch({ action: 'remove-task', ...rememberedSpice, confirmed: true });
  assert.equal(opened.preferences().spiceSource, null);
  assert.equal(opened.preferences().favoriteSource.id, rememberedFavorite.id);
  assert.equal(opened.view().profile.style, 'playful');
});

test('a dinner reminder is dismissible, can be paused and reset by a new scheduled time', async t => {
  let now = at;
  const { opened } = service(t, { now: () => now });
  const scheduled = { ...goal, activity: '社团活动', reminderAt: '2026-11-16T17:45' };
  let latest = await opened.dispatch({ action: 'create', goal: scheduled });
  assert.deepEqual(opened.view().dueReminders, []);
  latest = await opened.dispatch({ action: 'reminder-pause', ...latest });
  now += 16 * 60_000;
  assert.deepEqual(opened.view().dueReminders, []);
  latest = await opened.dispatch({ action: 'reminder-resume', ...latest });
  assert.equal(opened.view().dueReminders[0].id, latest.id);
  latest = await opened.dispatch({ action: 'reminder-dismiss', ...latest });
  assert.deepEqual(opened.view().dueReminders, []);
  latest = await opened.dispatch({ action: 'revise', ...latest, goal: { ...scheduled, reminderAt: '2026-11-16T17:50' } });
  now += 5 * 60_000;
  assert.equal(opened.view().dueReminders[0].id, latest.id);
});

test('menu parsing and the optional model surface are bounded and require user review', async t => {
  const calls = [];
  const mock = async (url, options) => {
    const data = JSON.parse(options.body);
    calls.push({ url, maxTokens: data.max_tokens, structured: data.response_format.type });
    const menu = data.messages[0].content.includes('菜单摘录');
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(menu
      ? { rows: [{ ...good, delivery: '' }, { store: '费用未知的条目' }] }
      : { budget: '19.50', spice: 'avoid', activity: '晚间活动' }) } }], usage: { prompt_tokens: 31, completion_tokens: 18 } });
  };
  const { opened } = service(t, { fetchImpl: mock, crypt: value => value });
  const local = await opened.dispatch({ action: 'menu', text: '店铺 | 鸡肉饭 | 小份 | 12.50 | 1 | 3 | 0 | 20 | 不辣\n坏行' });
  assert.equal(local.candidates[0].spice, 'none');
  assert.equal(local.invalid, 1);
  assert.equal(calls.length, 0);
  await assert.rejects(opened.dispatch({ action: 'key-save', key: 'placeholder-local-only' }), /桌面/);
  await opened.dispatch({ action: 'key-save', key: 'placeholder-local-only' }, { desktop: true });
  const intake = await opened.dispatch({ action: 'intent', text: request, model: true });
  assert.equal(intake.method, 'deepseek');
  assert.equal(intake.goal.budget, '19.50');
  const result = await opened.dispatch({ action: 'menu', text: '用户粘贴的餐品信息', model: true });
  assert.equal(result.candidates[0].delivery, '');
  assert.equal(result.invalid, 1);
  assert.equal(result.usage.input, 31);
  assert.equal(opened.view().tasks.length, 0);
  assert.deepEqual(calls, Array(2).fill({ url: 'https://api.deepseek.com/chat/completions', maxTokens: 1700, structured: 'json_object' }));
});

test('real mobile HTTP pairing is single-use and restricts access to the dinner feature', async t => {
  let now = at;
  const { opened, onClose } = service(t, { now: () => now });
  const gateway = new DinnerGateway(opened, assets, { loopback: true, now: () => now });
  onClose(() => gateway.close());
  assert.equal(gateway.status().url, '');
  await assert.rejects(gateway.start('0.0.0.0'), /局域网/);
  const { url, code } = await gateway.start('127.0.0.1');
  const post = (endpoint, body, token, origin = url) => fetch(url + endpoint, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  assert.match(await (await fetch(url)).text(), /与电脑配对/);
  assert.equal((await fetch(url + '/api/dinner')).status, 401);
  assert.equal((await post('/api/dinner/pair', { code: 'invalid' })).status, 403);
  assert.equal((await post('/api/dinner/pair', { code }, '', 'http://example.test')).status, 403);
  const { token } = await (await post('/api/dinner/pair', { code })).json();
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.equal((await post('/api/dinner/pair', { code })).status, 429);
  assert.equal((await fetch(url + '/api/info', { headers: { Authorization: 'Bearer ' + token } })).status, 404);
  const created = await post('/api/dinner', { action: 'create', goal, sample: true }, token);
  assert.equal(created.status, 200);
  const task = await created.json();
  assert.equal(opened.view(task.id).task.sample, true);
  assert.equal((await post('/api/dinner', { action: 'platform-open', ...task }, token)).status, 403);
  const next = await opened.dispatch({ action: 'revise', ...task, goal: { ...goal, budget: '20' } });
  const phone = await (await fetch(url + '/api/dinner?id=' + task.id, { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.equal(phone.task.revision, next.revision);
  assert.equal(phone.task.goal.budget, 2000);
  assert.equal(phone.mobile, undefined);
  assert.equal((await post('/api/dinner/unpair', {}, token)).status, 200);
  assert.equal((await post('/api/dinner', { action: 'cancel', ...next }, token)).status, 401);
  const renewal = gateway.renew(); now += 6 * 60_000;
  assert.equal((await post('/api/dinner/pair', { code: renewal.code })).status, 429);
});

test('real control server exposes the desktop feature with no WeChat state and shares stored tasks', async t => {
  const { root, onClose } = workspace(t);
  const console = createConsole({ root, port: 0 });
  const { port } = await console.start();
  onClose(async () => { const closed = once(console.server, 'close'); console.close(); await closed; });
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(base + '/api/dinner')).status, 401);
  const { token } = await (await fetch(base + '/api/info')).json();
  const headers = { 'X-Console-Token': token, 'Content-Type': 'application/json' };
  assert.equal((await fetch(base + '/dinner-ui.js')).status, 200);
  const saved = await fetch(base + '/api/dinner', { method: 'POST', headers, body: JSON.stringify({ action: 'create', goal, sample: true }) });
  assert.equal(saved.status, 200);
  const { id } = await saved.json();
  const { task, mobile } = await (await fetch(base + '/api/dinner?id=' + id, { headers })).json();
  assert.equal(task.goal.budget, 3000);
  assert.equal(mobile.url, '');
  assert.equal(fs.existsSync(path.join(root, 'state', 'weflow')), false);
});
