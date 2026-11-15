import { fault } from '../store.mjs';

export const PLATFORMS = Object.freeze({
  meituan: { name: '美团外卖', url: 'https://h5.waimai.meituan.com/waimai/mindex/home' },
  taobao: { name: '淘宝闪购', url: 'https://h5.ele.me/' },
});
export const STYLES = ['gentle', 'playful', 'brief'];
export const SPICE = ['unknown', 'none', 'spicy'];
export const QUOTE_LIFETIME = 30 * 60_000;
const SHANGHAI_OFFSET = 8 * 3600_000;

export function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function text(value, max, label, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value)) {
    throw fault(`${label}需要有效文字，最多 ${max} 字。`);
  }
  return value.trim();
}

export function cents(value, label, { required = false, max = 100_000 } = {}) {
  if (!required && (value === '' || value === null || value === undefined)) return null;
  const match = /^(\d{1,4})(?:\.(\d{1,2}))?$/.exec(typeof value === 'string' ? value.trim() : '');
  if (!match) throw fault(`${label}请用人民币金额填写，最多两位小数。`);
  const amount = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'));
  if (amount > max) throw fault(`${label}超出允许范围。`);
  return amount;
}

export function boundedInteger(value, label, min, max, optional = true) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  if (typeof value === 'string' && /^\d{1,4}$/.test(value)) value = Number(value);
  if (!Number.isInteger(value) || value < min || value > max) throw fault(`${label}应为 ${min}–${max} 之间的整数。`);
  return value;
}

export function localTime(value) {
  if (!value) return '';
  return new Date(value + SHANGHAI_OFFSET).toISOString().slice(0, 16);
}

function timestamp(value, label) {
  if (value === '' || value === undefined || value === null) return null;
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw fault(`${label}请用北京时间填写。`);
  const parsed = Date.parse(value + ':00+08:00');
  if (!Number.isFinite(parsed) || localTime(parsed) !== value) throw fault(`${label}不是有效的日期时间。`);
  return parsed;
}

export function validateGoal(value) {
  if (!plainObject(value) || !Object.hasOwn(PLATFORMS, value.platform)) throw fault('请选择外卖平台。');
  if (!['any', 'avoid'].includes(value.spice)) throw fault('请选择口味要求。');
  const readyAt = timestamp(value.readyAt, '开始点餐时间');
  const latestAt = timestamp(value.latestAt, '最晚送达时间');
  if (readyAt !== null && latestAt !== null && readyAt >= latestAt) throw fault('最晚送达要晚于开始点餐。');
  const reminderAt = timestamp(value.reminderAt, '提醒时间');
  if (reminderAt !== null && latestAt !== null && reminderAt > latestAt) throw fault('提醒时间要在最晚送达之前或与其相同。');
  return {
    goal: text(value.goal, 500, '晚饭需求', true),
    platform: value.platform,
    budget: cents(value.budget, '总预算'),
    spice: value.spice,
    readyAt, latestAt, reminderAt,
    activity: text(value.activity ?? '', 80, '后续安排'),
  };
}

export function validateCandidate(value) {
  if (!plainObject(value) || !SPICE.includes(value.spice)) throw fault('请核对餐品与辣度。');
  const row = {
    store: text(value.store, 80, '店铺', true),
    item: text(value.item, 100, '餐品', true),
    spec: text(value.spec ?? '', 80, '餐品规格'),
    quantity: boundedInteger(value.quantity ?? 1, '份数', 1, 9, false),
    unitPrice: cents(value.unitPrice, '单价', { required: true }),
    packing: cents(value.packing, '包装费'),
    delivery: cents(value.delivery, '配送费'),
    discount: cents(value.discount, '优惠'),
    minutes: boundedInteger(value.minutes, '预计送达分钟', 0, 300),
    spice: value.spice,
  };
  const { unitPrice, quantity, packing, delivery, discount } = row;
  if (discount !== null && discount > unitPrice * quantity + (packing ?? 0) + (delivery ?? 0) && packing !== null && delivery !== null) {
    throw fault('优惠不能大于餐费、包装和配送之和。');
  }
  return row;
}

export function assessCandidate(row, goal, now, preference) {
  const subtotal = row.unitPrice * row.quantity;
  const allFees = [row.packing, row.delivery, row.discount].every(amount => amount !== null);
  const total = allFees ? subtotal + row.packing + row.delivery - row.discount : null;
  const { decision, issues, arrivalAt } = assessQuote({ total, minutes: row.minutes, spice: row.spice }, goal, now);
  const expired = row.source !== 'sample' && now - row.observedAt >= QUOTE_LIFETIME;
  return {
    total, arrivalAt, expired, decision: expired ? 'stale' : decision,
    issues: expired ? ['报价已超过 30 分钟，请重新查看并保存。', ...issues] : issues,
    matchesFavorite: preference?.favorite?.store === row.store && preference.favorite.item === row.item,
  };
}

export function assessQuote({ total, minutes, spice }, goal, now) {
  const conflicts = [], missing = [];
  const arrivalAt = minutes === null ? null : Math.max(now, goal.readyAt ?? now) + minutes * 60_000;
  if (goal.budget === null) missing.push('预算未填写。');
  if (total === null) missing.push('费用有缺项，实际总额待核对。');
  if (goal.budget !== null && total !== null && total > goal.budget) conflicts.push('总额超出预算。');
  if (goal.spice === 'avoid') {
    if (spice === 'spicy') conflicts.push('餐品为辣味。');
    if (spice === 'unknown') missing.push('辣度待核对。');
  }
  if (goal.latestAt !== null) {
    if (now >= goal.latestAt) conflicts.push('已超过最晚送达时间。');
    else if (arrivalAt === null) missing.push('预计送达待核对。');
    else if (arrivalAt > goal.latestAt) conflicts.push('预计送达晚于计划。');
  }
  return { arrivalAt, decision: conflicts.length ? 'conflict' : missing.length ? 'check' : 'fit', issues: [...conflicts, ...missing] };
}

export function orderedCandidates(rows, goal, now, preference) {
  const order = { fit: 0, check: 1, conflict: 2, stale: 3 };
  return rows.map(row => ({ ...row, ...assessCandidate(row, goal, now, preference) })).sort((a, b) =>
    order[a.decision] - order[b.decision] || Number(b.matchesFavorite) - Number(a.matchesFavorite) ||
    (a.total ?? Infinity) - (b.total ?? Infinity) || (a.minutes ?? Infinity) - (b.minutes ?? Infinity) || a.store.localeCompare(b.store, 'zh-CN'));
}

const digits = '零一二三四五六七八九';
const cnNumber = '[零一二两三四五六七八九十百〇0-9]';
function chineseNumber(value) {
  value = value.replace(/两/g, '二').replace(/〇/g, '零');
  if (/^\d+$/.test(value)) return Number(value);
  let sum = 0, digit = 0;
  for (const ch of value) {
    if (digits.includes(ch)) digit = digits.indexOf(ch);
    else if (ch === '十' || ch === '百') { sum += (digit || 1) * (ch === '十' ? 10 : 100); digit = 0; }
    else return NaN;
  }
  return sum + digit;
}

function wordTime(input, now, context = '') {
  const absolute = input.match(/(20\d\d)[年/-](\d{1,2})[月/-](\d{1,2})日?\s*[T ]?(\d{1,2}):(\d{2})/);
  const clock = /(\d{1,2}):(\d{2})/.exec(input);
  const words = new RegExp(`(${cnNumber}{1,3})(?:点|时)(半|一刻|三刻|${cnNumber}{1,3}分?)?`).exec(input);
  if (!absolute && !clock && !words) return '';
  let hours = absolute ? Number(absolute[4]) : clock ? Number(clock[1]) : chineseNumber(words[1]);
  let minutes = absolute ? Number(absolute[5]) : clock ? Number(clock[2]) : ({ 半: 30, 一刻: 15, 三刻: 45 })[words[2]] ?? chineseNumber((words[2] ?? '').replace(/分$/, ''));
  const combined = context + input;
  if (!absolute && !/早上|上午|清晨/.test(input) && /下午|晚上|傍晚|晚饭|晚餐|下课|晚间/.test(combined) && hours > 0 && hours < 12) hours += 12;
  if (!Number.isInteger(hours) || hours > 23 || !Number.isInteger(minutes) || minutes > 59) return '';
  const pad = value => String(value).padStart(2, '0');
  const day = absolute
    ? `${absolute[1]}-${pad(absolute[2])}-${pad(absolute[3])}`
    : localTime(now + (combined.includes('后天') ? 2 : combined.includes('明天') ? 1 : 0) * 86400_000).slice(0, 10);
  const result = `${day}T${pad(hours)}:${pad(minutes)}`;
  try { timestamp(result, '时间'); } catch { return ''; }
  return result;
}

export function localIntent(input, now, preference) {
  const original = text(input, 500, '晚饭需求', true);
  const goal = original.normalize('NFKC');
  const amountPattern = String.raw`${cnNumber}{1,6}(?:\.\d{1,2})?`;
  const amount = goal.match(new RegExp(String.raw`(?:总?预算[为是：:\s]*|最多|不超过|控制在)(${amountPattern})(?![.\d])(?:元|块)?`)) ??
    goal.match(new RegExp(String.raw`(?<![.\d])(${amountPattern})(?:元|块)以?[内下]`));
  const asNumber = amount?.[1].includes('.') ? Number(amount[1]) : amount ? chineseNumber(amount[1]) : NaN;
  const budget = asNumber > 0 && asNumber <= 1000 ? String(asNumber) : '';
  const ready = goal.match(/(?:^|[，。；,;])([^，。；,;]{1,38}?)(?:下课|下班|才能点餐|才能下单|开始点餐|开始点外卖|开始下单)/u);
  const deadline = goal.match(/(?:最晚|必须在|需要在|要在)([^，。；,;]{1,30}?)(?:前|送达|吃到|吃完)/u) ??
    goal.match(/(?:^|[，。；,;])([^，。；,;]{1,38}?)(?:有|要去|参加|开始)([^，。；,;]{1,26})/u);
  let readyAt = ready ? wordTime(ready[1], now, goal) : '';
  const latestAt = deadline ? wordTime(deadline[1], now, goal) : '';
  if (readyAt && latestAt && readyAt >= latestAt) readyAt = '';
  const spice = /不忌辣|辣也行|能吃辣|可以辣/u.test(goal) ? 'any' : /不吃辣|不要辣|不辣|忌辣|无辣/u.test(goal) || preference?.avoidSpicy ? 'avoid' : 'any';
  return {
    goal: original, budget, readyAt, latestAt, reminderAt: '', activity: latestAt ? (deadline?.[2] ?? '').trim() : '', spice,
    platform: /淘宝|饿了么|闪购/u.test(goal) ? 'taobao' : 'meituan',
  };
}

export const SAMPLE_MENU = Object.freeze([
  { store: '海风小饭堂', item: '菌菇鸡肉饭', spec: '标准份', quantity: 1, unitPrice: '20.00', packing: '1.00', delivery: '2.00', discount: '2.00', minutes: 24, spice: 'none' },
  { store: '蓝湾面馆', item: '番茄蛋面', spec: '标准份', quantity: 1, unitPrice: '16.00', packing: '1.00', delivery: '2.00', discount: '0.00', minutes: 32, spice: 'none' },
  { store: '潮汐食堂', item: '川香鸡丁盖饭', spec: '标准份', quantity: 1, unitPrice: '24.00', packing: '1.00', delivery: '3.00', discount: '1.00', minutes: 21, spice: 'spicy' },
]);
