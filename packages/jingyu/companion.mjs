import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { fault, validChat } from './store.mjs';

export const tones = { gentle: '温柔陪伴', playful: '俏皮小鲸鱼', brief: '简洁助手' };
const clock = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const modes = ['ask', 'tasks', 'daily'];
const lengths = ['short', 'normal', 'detailed'];
const validAccount = account => /^[a-f0-9]{64}$/.test(account ?? '');

export function companionDefaults(legacy = {}) {
  const cards = Object.entries(tones).map(([id, title]) => ({
    id, title, style: id, address: legacy.style === id ? (legacy.address ?? '') : '', length: 'normal',
  }));
  const task = Object.hasOwn(tones, legacy.style) ? legacy.style : 'gentle';
  return { revision: 0, cards, task, reminder: 'task', mode: 'tasks', paused: false, quietStart: '', quietEnd: '' };
}

function clean(value, limit, label, required = false) {
  if (typeof value !== 'string' || value.length > limit || /[<>\x00-\x1f]/u.test(value) || (required && !value.trim())) {
    throw fault(`请填写有效的${label}。`);
  }
  return value.trim();
}

export function updateCompanion(current, body) {
  if (body.revision !== current.revision) throw fault('个性卡已在另一台设备更新，请先同步。', 409);
  const next = structuredClone(current);
  if (body.action === 'card-save') {
    const id = body.id || randomUUID(), index = next.cards.findIndex(row => row.id === id);
    if ((body.id && index < 0) || (index < 0 && next.cards.length >= 24) ||
        !Object.hasOwn(tones, body.style) || !lengths.includes(body.length)) throw fault('请检查个性卡和回复长度。');
    const card = { id, title: clean(body.title, 24, '卡片名称', true), style: body.style,
      address: clean(body.address ?? '', 16, '称呼'), length: body.length };
    if (index < 0) next.cards.push(card);
    else next.cards[index] = card;
  } else if (body.action === 'card-delete') {
    if (Object.hasOwn(tones, body.id)) throw fault('内置卡片可编辑。自定义卡片可删除。');
    next.cards = next.cards.filter(row => row.id !== body.id);
    if (next.task === body.id) next.task = 'gentle';
    if (next.reminder === body.id) next.reminder = 'task';
  } else {
    if (!next.cards.some(card => card.id === body.task) ||
        (body.reminder !== 'task' && !next.cards.some(card => card.id === body.reminder)) ||
        !modes.includes(body.mode) || typeof body.paused !== 'boolean') throw fault('请检查卡片、陪伴模式与暂停状态。');
    const { quietStart = '', quietEnd = '' } = body;
    if ((quietStart || quietEnd) && (!clock.test(quietStart) || !clock.test(quietEnd) || quietStart === quietEnd)) {
      throw fault('请填写不同的安静时段起止时间，或者同时留空。');
    }
    Object.assign(next, { task: body.task, reminder: body.reminder, mode: body.mode, paused: body.paused, quietStart, quietEnd });
  }
  next.revision++;
  return next;
}

export function quietNow(settings, at) {
  if (!settings.quietStart || !settings.quietEnd) return false;
  const clockNow = new Date(at + 8 * 3600_000).toISOString().slice(11, 16);
  const { quietStart: start, quietEnd: end } = settings;
  return start < end ? clockNow >= start && clockNow < end : clockNow >= start || clockNow < end;
}

function readDinnerSettings(root, names) {
  const file = path.resolve(root, 'state/dinner/dinner.sqlite');
  if (!fs.existsSync(file)) return {};
  for (let current = file; current !== path.dirname(current); current = path.dirname(current)) {
    if (fs.lstatSync(current).isSymbolicLink()) return {};
  }
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const query = db.prepare('SELECT payload FROM dinner_settings WHERE name=?');
    return Object.fromEntries(names.map(name => [name, JSON.parse(query.get(name)?.payload ?? 'null')]));
  } finally { db.close(); }
}

export function companionLibrary(root) {
  const data = readDinnerSettings(root, ['profile', 'companion']);
  return data.companion ?? companionDefaults(data.profile ?? {});
}

export function boundCompanion(root, account, chat, binding) {
  if (!validAccount(account) || !validChat(chat) || !binding) return null;
  try {
    const settings = companionLibrary(root);
    const card = settings.cards.find(row => row.id === binding.card);
    return card ? { settings, card } : null;
  } catch { return null; }
}

export function withCompanionPersona(persona, companion, chat) {
  if (!companion) return persona;
  const { card } = companion;
  const length = { short: '优先一两句', normal: '按问题自然组织', detailed: '用户需要时分点说明' }[card.length];
  const address = chat.startsWith('wechat:private:') && card.address ? `。对这位联系人的称呼为 ${JSON.stringify(card.address)}` : '';
  return `${persona}\n\n本次会话的表达设置优先用于语气、称呼和长度。语气为${tones[card.style]}，回复${length}${address}。此设置只调整表达，沿用原权限与事实范围。`;
}
