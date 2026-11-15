import { mountDinner } from './dinner-ui.js';

const app = document.getElementById('dinner-mobile-app');
const pairing = document.getElementById('dinner-pairing');
const form = document.getElementById('dinner-pair-form');
const status = document.getElementById('dinner-pair-status');
const unpair = document.getElementById('dinner-unpair');
const storageKey = 'dinner-mobile-session';
let token = '', dispose;
try { token = sessionStorage.getItem(storageKey) ?? ''; } catch {}

function remember(value) {
  token = value;
  try {
    if (value) sessionStorage.setItem(storageKey, value);
    else sessionStorage.removeItem(storageKey);
  } catch {}
}

async function request(route, data) {
  const headers = {};
  if (token) headers.Authorization = 'Bearer ' + token;
  if (data) headers['Content-Type'] = 'application/json';
  let response;
  try {
    response = await fetch(route, {
      method: data ? 'POST' : 'GET', headers, cache: 'no-store', signal: AbortSignal.timeout(28_000),
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  } catch { throw Error('未连接到电脑。请确认两台设备在同一网络，且桌面入口仍开启。'); }
  const body = await response.json();
  if (!response.ok) throw Object.assign(Error(body.error), { status: response.status });
  return body;
}

function showPairing(message = '') {
  dispose?.();
  remember('');
  form.reset();
  app.replaceChildren(pairing);
  unpair.hidden = true;
  status.textContent = message;
  status.hidden = !message;
}

function showTasks() {
  const view = document.createElement('div');
  app.replaceChildren(view);
  unpair.hidden = false;
  dispose = mountDinner(view, request, { onAuthLost: showPairing });
}

form.addEventListener('submit', async event => {
  event.preventDefault();
  const submit = form.querySelector('button');
  if (submit.disabled) return;
  submit.disabled = true;
  status.hidden = true;
  try {
    const result = await request('/api/dinner/pair', { code: form.elements.code.value });
    remember(result.token);
    showTasks();
  } catch (error) {
    status.textContent = error.message;
    status.hidden = false;
  } finally { submit.disabled = false; }
});

unpair.addEventListener('click', async () => {
  unpair.disabled = true;
  let message = '已退出手机端。如需重新连接，请在电脑生成新配对码。';
  try { await request('/api/dinner/unpair', {}); }
  catch { message = '此页已退出。请在电脑关闭手机入口或生成新配对码，以结束手机会话。'; }
  showPairing(message);
  unpair.disabled = false;
});
if (token) showTasks();
