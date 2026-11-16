import { fault } from './store.mjs';
import { localTime } from './dinner/rules.mjs';

const minute = 60_000;
const day = 1440 * minute;

export function beijingTime(value, label = '时间') {
  if (value === '' || value === null || value === undefined) return null;
  if (typeof value !== 'string' || !/^20\d\d-\d\d-\d\dT\d\d:\d\d$/.test(value)) throw fault(`请填写有效的${label}（北京时间）。`);
  const at = Date.parse(value + ':00+08:00');
  if (!Number.isFinite(at) || localTime(at) !== value) throw fault(`请填写有效的${label}。`);
  return at;
}

function calendarTime(value, params) {
  const match = /^(20\d{2})(\d\d)(\d\d)(?:T(\d\d)(\d\d)(\d\d)(Z)?)?$/.exec(value);
  if (!match || Number(match[6]) > 59) return null;
  const zone = /;TZID="?([^;"]+)"?/i.exec(params)?.[1];
  if (zone && !['Asia/Shanghai','Asia/Chongqing','UTC','Etc/UTC'].includes(zone)) return null;
  const utc = Boolean(match[7]) || ['UTC','Etc/UTC'].includes(zone);
  const local = `${match[1]}-${match[2]}-${match[3]}T${match[4] ?? '00'}:${match[5] ?? '00'}`;
  try { return { at: beijingTime(local) + (utc ? 8 * 3600_000 : 0) + Number(match[6] ?? 0) * 1000, allDay: !match[4] }; }
  catch { return null; }
}

export function parseCalendar(source) {
  if (typeof source !== 'string' || Buffer.byteLength(source) > 12000 || !/^BEGIN:VCALENDAR\s*$/im.test(source) || !/^END:VCALENDAR\s*$/im.test(source)) {
    throw fault('请选择不超过 12 KB 的有效 .ics 日历文件。');
  }
  const events = [];
  let fields, skipped = 0, nested = 0;
  for (const row of source.replace(/\r?\n[ \t]/g,'').split(/\r?\n/)) {
    if (row.toUpperCase() === 'BEGIN:VEVENT') { fields = {}; nested = 0; continue; }
    if (!fields) continue;
    if (row.toUpperCase() === 'END:VEVENT') {
      const start = fields.DTSTART && calendarTime(fields.DTSTART.value,fields.DTSTART.params);
      const end = fields.DTEND && calendarTime(fields.DTEND.value,fields.DTEND.params);
      const repeat = ['RRULE','RDATE','EXDATE','RECURRENCE-ID','DURATION'].some(key => fields[key]);
      if (fields.STATUS?.value.toUpperCase() !== 'CANCELLED' && fields.TRANSP?.value.toUpperCase() !== 'TRANSPARENT') {
        const until = end?.at ?? (start?.at + (start?.allDay ? day : 0));
        if (repeat || !start || (fields.DTEND && !end) || until <= start.at || events.length >= 100) skipped++;
        else events.push({ start: start.at, end: until, title: (fields.SUMMARY?.value ?? '日历占用').replace(/\\([,;\\])/g,'$1').replace(/[\u0000-\u001f]/g,' ').slice(0,120) });
      }
      fields = null; continue;
    }
    if (/^BEGIN:/i.test(row)) { nested++; continue; }
    if (/^END:/i.test(row)) { nested = Math.max(0,nested-1); continue; }
    if (nested) continue;
    const match = /^([A-Z-]+)([^:]*):(.*)$/i.exec(row);
    if (match) fields[match[1].toUpperCase()] = { params:match[2], value:match[3] };
  }
  return { events, skipped };
}

const format = value => new Date(value).toISOString().replace(/[-:]|\.\d{3}/g,'');
const escapeText = value => value.replace(/[\\;,]/g, char=>'\\'+char).replace(/\r?\n/g,'\\n');

export function lifeCalendar(task, now) {
  if (!task.start || task.status !== 'open') throw fault('请先为进行中的事项填写开始时间。',409);
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Jingyu//Life//ZH','BEGIN:VEVENT',
    `UID:${task.id}@jingyu.local`, `DTSTAMP:${format(now)}`,`SEQUENCE:${task.revision}`,`DTSTART:${format(task.start)}`,
    `DTEND:${format(task.start+task.duration*minute)}`, `SUMMARY:${escapeText(task.title)}`];
  if (task.place) lines.push(`LOCATION:${escapeText(task.place)}`);
  if (task.reminder !== null && !task.reminderPaused && !task.reminderRead) {
    const ahead = Math.floor((task.start-task.reminder)/minute);
    lines.push('BEGIN:VALARM','ACTION:DISPLAY',`TRIGGER:${ahead>0?'-':''}PT${Math.abs(ahead)}M`,`DESCRIPTION:${escapeText(task.title)}`,'END:VALARM');
  }
  lines.push('END:VEVENT','END:VCALENDAR','');
  return lines.map(line=>{
    let out='', used=0;
    for(const ch of line){
      const bytes=Buffer.byteLength(ch);
      if(used+bytes>75){out+='\r\n ';used=1;}
      out+=ch;used+=bytes;
    }
    return out;
  }).join('\r\n');
}
