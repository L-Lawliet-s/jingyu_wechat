import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { Billing } from '../billing.mjs';
import { fault, hash } from '../store.mjs';
import { DinnerPlanner } from './planner.mjs';
import { companionDefaults, quietNow, updateCompanion } from '../companion.mjs';
import { LifeService } from '../life.mjs';
import { CommuteService } from '../commute.mjs';
import {
  assessQuote, boundedInteger, cents, localTime, orderedCandidates, plainObject,
  PLATFORMS, SAMPLE_MENU, SPICE, STYLES, text, validateCandidate, validateGoal,
} from './rules.mjs';

const terminal = new Set(['completed', 'cancelled']);
const editable = ['planning', 'confirmed', 'review', 'checked'];
const pendingSeconds = 30_000;
const maxCandidates = 12;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const defaultProfile = { style: 'gentle', address: '' };
const defaultPreferences = { avoidSpicy: false, favorite: null, spiceSource: null, favoriteSource: null, savedAt: null };

function describeChanges(before, goal) {
  const currency = cents => cents === null ? '待定' : `¥${(cents / 100).toFixed(2)}`;
  const pairs = [
    ['预算', currency(before.budget), currency(goal.budget)],
    ['开始点餐', localTime(before.readyAt), localTime(goal.readyAt)],
    ['最晚送达', localTime(before.latestAt), localTime(goal.latestAt)],
    ['口味', before.spice === 'avoid' ? '不辣' : '不限', goal.spice === 'avoid' ? '不辣' : '不限'],
    ['平台', PLATFORMS[before.platform].name, PLATFORMS[goal.platform].name],
    ['晚间安排', before.activity, goal.activity],
    ['提醒时间', localTime(before.reminderAt), localTime(goal.reminderAt)],
  ];
  return pairs.filter(([, a, b]) => a !== b).map(([name, a, b]) => `${name} ${a || '未设置'} → ${b || '未设置'}`).join('，');
}

export class DinnerService {
  constructor(root, { browser, now = Date.now, fetchImpl, crypt } = {}) {
    const directory = path.resolve(root, 'state', 'dinner');
    const file = path.join(directory, 'dinner.sqlite');
    for (let current = file; current !== path.dirname(current); current = path.dirname(current)) {
      if (fs.lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw fault('晚饭数据目录不能包含链接。', 409);
    }
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA busy_timeout=3000;
      PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS dinner_tasks (
        id TEXT PRIMARY KEY, revision INTEGER NOT NULL, updated INTEGER NOT NULL, payload TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dinner_updated ON dinner_tasks(updated DESC);
      CREATE TABLE IF NOT EXISTS dinner_settings (name TEXT PRIMARY KEY, payload TEXT NOT NULL);`);
    this.browser = browser;
    this.scope = hash('jingyu-dinner:' + path.resolve(root));
    this.now = now;
    this.billing = new Billing({ directory }, { crypt });
    this.planner = new DinnerPlanner(this.billing, { fetchImpl, now });
    this.life = new LifeService(this, { fetchImpl });
    this.commute = new CommuteService(this, { fetchImpl });
  }

  setting(name, fallback) {
    const row = this.db.prepare('SELECT payload FROM dinner_settings WHERE name=?').get(name);
    return row ? JSON.parse(row.payload) : structuredClone(fallback);
  }

  saveSetting(name, value) {
    this.db.prepare('INSERT INTO dinner_settings VALUES (?,?) ON CONFLICT(name) DO UPDATE SET payload=excluded.payload').run(name, JSON.stringify(value));
  }

  preferences() { return this.setting('preferences', defaultPreferences); }

  companion() { return this.setting('companion', companionDefaults(this.setting('profile', defaultProfile))); }

  changeCompanion(body) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.companion();
      let next;
      if (body.action === 'profile') {
        // Keep clients from phase one working. Update the selected built-in card.
        const card = current.cards.find(row => row.id === body.style);
        if (!STYLES.includes(body.style) || !card) throw fault('请选择个性卡。');
        next = updateCompanion(current, { ...card, action: 'card-save', address: body.address ?? '', revision: current.revision });
        next.task = body.style;
      } else {
        next = updateCompanion(current, body);
      }
      this.saveSetting('companion', next);
      this.db.exec('COMMIT');
      return { companion: next };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  recap(recent, companion, now) {
    const day = localTime(now).slice(0, 10), current = this.setting('recap', {});
    if (companion.mode !== 'daily' || companion.paused || quietNow(companion, now) ||
        (current.day === day && (current.dismissed || current.until > now))) return null;
    const today = recent.filter(task => !task.sample && localTime(task.updated).slice(0, 10) === day);
    return today.length ? { day, completed: today.filter(task => task.status === 'completed').length,
      pending: today.filter(task => !terminal.has(task.status)).length } : null;
  }

  get(id) {
    if (!uuid.test(id ?? '')) throw fault('请选择一个晚饭任务。');
    const row = this.db.prepare('SELECT payload FROM dinner_tasks WHERE id=?').get(id);
    if (!row) throw fault('未找到这个晚饭任务。', 404);
    const task = JSON.parse(row.payload);
    if (task.action?.state === 'running' && this.now() - task.action.at >= pendingSeconds) {
      task.action.state = 'unknown';
      this.persist(task, '上次加购回执未保存，请先查看真实购物车。');
    }
    return task;
  }

  view(id) {
    const recent = this.db.prepare('SELECT payload FROM dinner_tasks ORDER BY updated DESC,rowid DESC LIMIT 60').all().map(({ payload }) => JSON.parse(payload));
    const tasks = recent.map(({ id, goal, status, sample, updated }) => ({ id, goal: goal.goal, status, sample, updated }));
    const now = this.now();
    const companion = this.companion(), profile = companion.cards.find(card => card.id === companion.task);
    const dueReminders = (companion.paused || companion.mode === 'ask' || quietNow(companion, now) ? [] : recent).filter(task => !terminal.has(task.status) && task.goal.reminderAt && task.goal.reminderAt <= now &&
      !task.reminder?.paused && !task.reminder?.dismissedAt).slice(0, 5).map(task => ({
        id: task.id, revision: task.revision, sample: task.sample, at: task.goal.reminderAt, label: task.goal.activity,
      }));
    const task = id ? this.get(id) : null;
    if (task) task.candidates = orderedCandidates(task.candidates, task.goal, now, task.sample ? null : this.preferences());
    return {
      tasks, task, dueReminders, platforms: PLATFORMS,
      profile, companion, recap: this.recap(recent, companion, now),
      preferences: this.preferences(),
      modelReady: this.billing.configured(),
      platformWindow: Boolean(this.browser),
    };
  }

  persist(task, note) {
    const previous = task.revision;
    task.revision++;
    task.updated = this.now();
    task.events = [...task.events.slice(-39), { at: task.updated, note }];
    const result = this.db.prepare('UPDATE dinner_tasks SET revision=?,updated=?,payload=? WHERE id=? AND revision=?')
      .run(task.revision, task.updated, JSON.stringify(task), task.id, previous);
    if (!result.changes) throw fault('任务在另一台设备上已更新，请同步后再操作。', 409);
    return { id: task.id, revision: task.revision };
  }

  requireVersion(body, states) {
    const task = this.get(body.id);
    if (!Number.isInteger(body.revision) || task.revision !== body.revision) throw fault('任务在另一台设备上已更新，请同步后再操作。', 409);
    if (task.action?.state === 'running') throw fault('加购动作仍在返回，请稍候查看结果。', 409);
    if (terminal.has(task.status) || (states && !states.includes(task.status))) throw fault('当前任务状态不能执行这一步。', 409);
    return task;
  }

  create(body) {
    const goal = validateGoal(body.goal);
    const now = this.now(), id = randomUUID();
    const sample = body.sample === true;
    const task = {
      id, revision: 1, updated: now, sample, goal, status: 'planning',
      candidates: sample ? SAMPLE_MENU.map(row => ({ ...validateCandidate(row), id: randomUUID(), observedAt: now, source: 'sample' })) : [],
      selected: null, cart: null, action: null, handled: null, feedback: null,
      reminder: { paused: false, dismissedAt: null },
      events: [{ at: now, note: sample ? '建立演示任务，载入三条虚构报价。' : '建立真实任务，等待收集餐品报价。' }],
    };
    this.db.prepare('INSERT INTO dinner_tasks VALUES(?,?,?,?)').run(id, task.revision, now, JSON.stringify(task));
    return { id, revision: task.revision };
  }

  revise(body) {
    const task = this.requireVersion(body, editable);
    const goal = validateGoal(body.goal);
    if (JSON.stringify(goal) === JSON.stringify(task.goal)) return { id: task.id, revision: task.revision };
    let changed = describeChanges(task.goal, goal);
    if (goal.platform !== task.goal.platform && !task.sample) {
      task.candidates = [];
      changed += '。新平台需要录入该平台报价';
    }
    if (goal.reminderAt !== task.goal.reminderAt) task.reminder = { paused: false, dismissedAt: null };
    task.goal = goal;
    this.resetPlan(task);
    return this.persist(task, `已更新需求${changed ? '。' + changed : ''}。旧选择与购物车核对已失效，已发生的加购需要在平台处理。`);
  }

  resetPlan(task) {
    task.status = 'planning';
    task.selected = null;
    task.cart = null;
  }

  replan(body) {
    const task = this.requireVersion(body, ['confirmed', 'review', 'checked']);
    this.resetPlan(task);
    return this.persist(task, '回到选餐，旧确认与核对已失效。若已加购，请在平台核对原商品。');
  }

  saveCandidate(body) {
    const task = this.requireVersion(body, editable);
    if (task.sample) throw fault('演示任务使用预设报价。请建立真实任务来录入新餐品。');
    const row = validateCandidate(body.candidate);
    const original = body.candidateId ? task.candidates.find(item => item.id === body.candidateId) : null;
    if (body.candidateId && !original) throw fault('餐品已变化，请重新查看。', 404);
    if (!original && task.candidates.length >= maxCandidates) throw fault(`最多比较 ${maxCandidates} 个餐品。请先移除一项。`);
    const duplicate = task.candidates.some(item => item.id !== original?.id && item.store === row.store && item.item === row.item && item.spec === row.spec);
    if (duplicate) throw fault('已有相同店铺与规格的餐品，请更新已有报价。', 409);
    const candidate = { ...row, id: original?.id ?? randomUUID(), observedAt: this.now(), source: 'manual' };
    task.candidates = [...task.candidates.filter(item => item.id !== candidate.id), candidate];
    this.resetPlan(task);
    return this.persist(task, `${original ? '更新' : '录入'}报价「${row.item}」。`);
  }

  removeCandidate(body) {
    const task = this.requireVersion(body, editable);
    if (task.sample) throw fault('演示任务使用预设报价。');
    const candidate = task.candidates.find(item => item.id === body.candidateId);
    if (!candidate) throw fault('餐品已移除。', 404);
    task.candidates = task.candidates.filter(item => item.id !== candidate.id);
    this.resetPlan(task);
    return this.persist(task, `移除报价「${candidate.item}」。`);
  }

  confirm(body) {
    const task = this.requireVersion(body, ['planning', 'confirmed']);
    const rows = orderedCandidates(task.candidates, task.goal, this.now(), task.sample ? null : this.preferences());
    const chosen = rows.find(row => row.id === body.candidateId);
    if (!chosen || ['stale', 'conflict'].includes(chosen.decision)) throw fault('这个报价已过期或和需求冲突，请更新报价或改选。', 409);
    if (body.acknowledged !== true || (chosen.decision === 'check' && body.acknowledgedMissing !== true)) {
      throw fault('请确认所选餐品，并确认会核对缺失的费用、口味或时间。');
    }
    task.selected = { id: chosen.id, at: this.now(), revision: task.revision + 1 };
    task.status = 'confirmed';
    return this.persist(task, `已确认「${chosen.item}」${chosen.quantity} 份${chosen.decision === 'check' ? '，仍有待核对项' : ''}。`);
  }

  handoff(body) {
    const task = this.requireVersion(body, ['confirmed']);
    task.status = 'review';
    return this.persist(task, task.sample ? '进入演示核对。' : '交给用户在官方平台选规格和加购，等待手工核对。');
  }

  async addToCart(body) {
    const task = this.requireVersion(body, ['confirmed']);
    if (task.sample || !this.browser?.addDinnerItem) throw fault('请使用桌面平台窗口处理真实购物车。', 409);
    if (body.acknowledged !== true || body.candidateId !== task.selected?.id) throw fault('请先核对本次加购的餐品和数量。');
    if (task.action) throw fault('此任务已有加购尝试，请先核对页面并手工处理。', 409);
    const row = orderedCandidates(task.candidates, task.goal, this.now()).find(item => item.id === task.selected.id);
    if (!row || ['stale', 'conflict'].includes(row.decision) || row.quantity !== 1) throw fault('受控加购只支持可核对、未冲突的一份餐品。', 409);
    task.status = 'review';
    task.action = { id: randomUUID(), state: 'running', at: this.now() };
    this.persist(task, `已登记「${row.item}」的一次加购尝试。`);
    let outcome = 'unknown', note = '加购结果未确认，请查看真实购物车后手工处理。', timer;
    try {
      const signal = new AbortController();
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => { signal.abort(); reject(Error('timeout')); }, 15_000);
      });
      const result = await Promise.race([this.browser.addDinnerItem(this.scope, task.goal.platform, row, signal.signal), timeout]);
      if (result === 'submitted') {
        outcome = 'submitted';
        note = '已点击唯一匹配的加购按钮，请核对购物车中的实际餐品和费用。';
      } else if (result === 'no-match') {
        outcome = 'manual';
        note = '当前页面未找到唯一可核对的店铺与加购按钮，请在平台窗口手工加购。';
      }
    } catch {
      // A page action could have completed before navigation or IPC returned.
    } finally { clearTimeout(timer); }
    if (this.closed) return { id: task.id, revision: task.revision };
    const latest = this.get(task.id);
    if (latest.action?.id !== task.action.id || latest.action.state !== 'running') return { id: latest.id, revision: latest.revision };
    latest.action.state = outcome;
    return this.persist(latest, note);
  }

  reviewCart(body) {
    const task = this.requireVersion(body, ['review', 'checked']);
    if (body.matched !== true || !SPICE.includes(body.spice)) throw fault('请确认店铺、餐品、规格和份数，并核对口味。');
    const selected = task.candidates.find(item => item.id === task.selected?.id);
    if (!selected) throw fault('请重新确认一个餐品。', 409);
    const total = cents(body.total, '购物车实际应付', { required: true, max: 900_000 });
    const minutes = boundedInteger(body.minutes, '实际预计送达分钟', 0, 300);
    const now = this.now();
    const assessment = assessQuote({ total, minutes, spice: body.spice }, { ...task.goal, readyAt: null }, now);
    const quoted = orderedCandidates([selected], task.goal, now)[0].total;
    task.cart = {
      total, minutes, spice: body.spice, observedAt: now, source: task.sample ? 'sample' : 'user-check',
      delta: quoted === null ? null : total - quoted,
      ...assessment,
    };
    task.status = task.cart.decision === 'fit' ? 'checked' : 'review';
    return this.persist(task, task.status === 'checked' ? '费用和条件已核对，等待用户确认处理结果。' : `已核对购物车：${task.cart.issues.join(' ')}`);
  }

  markHandled(body) {
    const task = this.requireVersion(body, ['checked']);
    if (this.now() - task.cart.observedAt >= 30 * 60_000) throw fault('购物车核对已超过 30 分钟，请更新实际结果。', 409);
    if (body.done !== true) throw fault('请确认已自行处理好这次点餐。');
    task.handled = { at: this.now(), source: task.sample ? 'sample' : 'user-report' };
    task.status = 'handled';
    return this.persist(task, task.sample ? '已标记演示中的点餐处理结果。' : '用户确认已自行处理晚饭，暂存待反馈。');
  }

  finish(body) {
    const task = this.requireVersion(body, ['handled']);
    const selected = task.candidates.find(item => item.id === task.selected.id);
    if (!['liked', 'okay', 'avoid'].includes(body.rating)) throw fault('请选择用餐反馈。');
    if ((body.rememberSpice === true || body.rememberFavorite === true) && task.sample) throw fault('演示任务不能写入个人偏好。');
    if (body.rememberFavorite === true && body.rating !== 'liked') throw fault('选择“喜欢”后才能将此餐品加入偏好。');
    task.feedback = { rating: body.rating, note: text(body.note ?? '', 300, '反馈备注'), at: this.now() };
    task.status = 'completed';
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (body.rememberSpice === true || body.rememberFavorite === true) {
        const preferences = this.preferences();
        if (body.rememberSpice === true) {
          preferences.avoidSpicy = task.goal.spice === 'avoid';
          preferences.spiceSource = { id: task.id, at: task.feedback.at };
        }
        if (body.rememberFavorite === true) {
          preferences.favorite = { store: selected.store, item: selected.item };
          preferences.favoriteSource = { id: task.id, at: task.feedback.at };
        }
        this.saveSetting('preferences', { ...preferences, savedAt: task.feedback.at });
      }
      const result = this.persist(task, task.sample ? '完成演示并记录演示反馈。' : '用户确认晚饭已处理，已记录本次反馈。');
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  cancel(body) {
    const task = this.requireVersion(body);
    task.status = 'cancelled';
    return this.persist(task, '用户结束此任务。若已加购，请在平台自行调整购物车。');
  }

  changeReminder(body) {
    const task = this.requireVersion(body);
    if (!task.goal.reminderAt) throw fault('请先为这个任务填写提醒时间。', 409);
    task.reminder ??= { paused: false, dismissedAt: null };
    if (body.action === 'reminder-dismiss') {
      if (task.reminder.paused || this.now() < task.goal.reminderAt) throw fault('提醒状态已变化，请同步。', 409);
      task.reminder.dismissedAt = this.now();
      return this.persist(task, '已读晚饭提醒。');
    }
    task.reminder.paused = body.action === 'reminder-pause';
    if (!task.reminder.paused) task.reminder.dismissedAt = null;
    return this.persist(task, task.reminder.paused ? '已暂停晚饭提醒。' : '已恢复晚饭提醒。');
  }

  removeTask(body) {
    const task = this.get(body.id);
    if (task.revision !== body.revision || !terminal.has(task.status) || body.confirmed !== true) {
      throw fault('请先结束任务，再确认删除。', 409);
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.db.prepare('DELETE FROM dinner_tasks WHERE id=? AND revision=?').run(task.id, task.revision).changes) {
        throw fault('任务在另一台设备上已更新，请同步。', 409);
      }
      const prefs = this.preferences();
      let updated = false;
      if (prefs.spiceSource?.id === task.id) { prefs.avoidSpicy = false; prefs.spiceSource = null; updated = true; }
      if (prefs.favoriteSource?.id === task.id) { prefs.favorite = null; prefs.favoriteSource = null; updated = true; }
      if (updated) {
        prefs.savedAt = Math.max(prefs.spiceSource?.at ?? 0, prefs.favoriteSource?.at ?? 0) || null;
        this.saveSetting('preferences', prefs);
      }
      this.db.exec('COMMIT');
      return { ok: true };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  platformTask(body) {
    const task = this.get(body.id);
    if (!editable.includes(task.status) || task.revision !== body.revision) throw fault('任务已变化，请同步后再打开平台。', 409);
    if (task.sample) throw fault('演示任务使用虚构报价。需要真实平台时请新建真实任务。', 409);
    if (!this.browser) throw fault('请在小鲸鱼桌面应用中打开平台。', 409);
    return task;
  }

  async dispatch(body, { desktop = false, signal } = {}) {
    if (typeof body?.action === 'string') {
      if (body.action.startsWith('life-')) return this.life.dispatch(body, signal);
      if (body.action.startsWith('commute-')) return this.commute.dispatch(body, signal);
    }
    if (!plainObject(body)) throw fault('晚饭任务表单无效。');
    switch (body.action) {
      case 'intent': return this.planner.intent(body.text, body.sample === true ? null : this.preferences(), body.model === true && body.sample !== true, signal);
      case 'menu': return this.planner.menu(body.text, body.model === true, signal);
      case 'create': return this.create(body);
      case 'revise': return this.revise(body);
      case 'replan': return this.replan(body);
      case 'save-candidate': return this.saveCandidate(body);
      case 'remove-candidate': return this.removeCandidate(body);
      case 'confirm': return this.confirm(body);
      case 'handoff': return this.handoff(body);
      case 'review': return this.reviewCart(body);
      case 'mark-handled': return this.markHandled(body);
      case 'finish': return this.finish(body);
      case 'cancel': return this.cancel(body);
      case 'reminder-pause':
      case 'reminder-resume':
      case 'reminder-dismiss': return this.changeReminder(body);
      case 'remove-task': return this.removeTask(body);
      case 'profile':
      case 'card-save':
      case 'card-delete':
      case 'companion-settings': return this.changeCompanion(body);
      case 'recap-dismiss':
      case 'recap-snooze': {
        const now = this.now(), day = localTime(now).slice(0, 10);
        if (body.day !== day) throw fault('日期已变化，请同步。', 409);
        const before = this.setting('recap', {});
        if (before.day !== day || !before.dismissed) this.saveSetting('recap', {
          day, dismissed: body.action === 'recap-dismiss', until: now + 30 * 60_000,
        });
        return { ok: true };
      }
      case 'clear-preferences':
        this.saveSetting('preferences', defaultPreferences);
        return { ok: true };
    }
    if (!desktop) throw fault('此操作需要在小鲸鱼桌面应用中进行。', 403);
    switch (body.action) {
      case 'key-save': this.billing.setKey(body.key); return { modelReady: true };
      case 'key-clear': this.billing.clear(); return { modelReady: false };
      case 'platform-open': {
        const task = this.platformTask(body);
        return this.browser.showDinnerPlatform(this.scope, task.goal.platform);
      }
      case 'platform-selection': {
        const task = this.platformTask(body);
        return this.browser.readDinnerSelection(this.scope, task.goal.platform);
      }
      case 'platform-add': return this.addToCart(body);
      default: throw fault('找不到这个晚饭任务操作。', 404);
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
