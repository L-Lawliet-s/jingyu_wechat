import crypto from 'node:crypto';
import {validChat,fault,hash} from './store.mjs';

const clock=/^(?:[01]\d|2[0-3]):[0-5]\d$/;
const minutes=value=>Number(value.slice(0,2))*60+Number(value.slice(3));
export function localParts(at){const d=new Date(at+8*3600000);return {day:d.getUTCDay(),minute:d.getUTCHours()*60+d.getUTCMinutes(),midnight:Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())-8*3600000};}
export function validateReminder(value){
 if(!value||!validChat(value.chat)||value.chat.includes(':group:')||!clock.test(value.start??'')||!clock.test(value.end??'')||minutes(value.end)-minutes(value.start)<=value.interval+value.jitter||!Number.isInteger(value.interval)||value.interval<30||value.interval>480||!Number.isInteger(value.jitter)||value.jitter<0||value.jitter>30||!Array.isArray(value.weekdays)||!value.weekdays.length||value.weekdays.some(d=>!Number.isInteger(d)||d<0||d>6)||typeof value.text!=='string'||!value.text.trim()||value.text.length>300||value.consented!==true)throw fault('提醒设置无效：请核对联系人、时段、间隔及对方同意。');
 return {chat:value.chat,start:value.start,end:value.end,interval:value.interval,jitter:value.jitter,weekdays:[...new Set(value.weekdays)],text:value.text.trim(),consented:true};
}
export function reminderWindow(at,config){const p=localParts(at);return config.weekdays.includes(p.day)&&p.minute>=minutes(config.start)&&p.minute<minutes(config.end);}
export function nextReminderAt(now,config,random=Math.random){
 const delay=(config.interval+random()*config.jitter)*60000,proposed=now+delay;if(reminderWindow(proposed,config))return Math.floor(proposed);
 const local=localParts(now);
 for(let n=0;n<9;n++){const start=local.midnight+n*86400000+minutes(config.start)*60000;if(start<now)continue;const due=start+delay;if(reminderWindow(due,config))return Math.floor(due);}
 throw fault('工作时段不足以安排下一次提醒。');
}
export class StudyReminders{
 constructor(store,{now=Date.now,random=Math.random}={}){Object.assign(this,{store,now,random});this.busy=false;}
 list(){return this.store.db.prepare('SELECT * FROM reminders ORDER BY id').all().map(row=>({id:row.id,...JSON.parse(row.config),nextAt:row.next_at,enabled:!!row.enabled}));}
 save(value){const config=validateReminder(value),id=value.id??crypto.randomUUID();if(typeof id!=='string'||id.length>60)throw fault('提醒编号无效。');this.store.db.prepare('INSERT INTO reminders VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET config=excluded.config,next_at=excluded.next_at,enabled=excluded.enabled').run(id,JSON.stringify(config),nextReminderAt(this.now(),config,this.random),value.enabled===false?0:1);return this.list().find(item=>item.id===id);}
 pause(chat){if(!validChat(chat))throw fault('聊天无效。');for(const item of this.list())if(item.chat===chat)this.store.db.prepare('UPDATE reminders SET enabled=0 WHERE id=?').run(item.id);return {paused:true};}
 remove(id){if(typeof id!=='string'||id.length>60)throw fault('提醒编号无效。');this.store.db.prepare('DELETE FROM reminders WHERE id=?').run(id);}
 async tick({allowed,send}){
  if(this.busy)return;this.busy=true;
  try{for(const item of this.list()){
   const now=this.now();if(!item.enabled||item.nextAt>now||!allowed(item.chat))continue;
   if(!reminderWindow(now,item)||now-item.nextAt>15*60000){this.store.db.prepare('UPDATE reminders SET next_at=? WHERE id=?').run(nextReminderAt(now,item,this.random),item.id);continue;}
   const id=hash('study:'+item.id+':'+item.nextAt),claimed=this.store.transaction(()=>{
    const current=this.store.db.prepare('SELECT * FROM reminders WHERE id=?').get(item.id);
    if(!current?.enabled||current.next_at!==item.nextAt)return false;
    const claim=this.store.db.prepare('INSERT OR IGNORE INTO receipts VALUES(?,?)').run(id,now);if(!claim.changes)return false;
    // Claim, next schedule and job commit together before the external send.
    this.store.db.prepare('UPDATE reminders SET next_at=? WHERE id=?').run(nextReminderAt(now,item,this.random),item.id);
    this.store.db.prepare('INSERT OR IGNORE INTO jobs VALUES(?,?,?,?,?,?,?,?,?)').run(id,'study',item.chat,'scheduler',JSON.stringify({text:item.text}),'dispatching',null,now,now);return true;
   });if(!claimed)continue;
   try{const result=await send(item.chat,item.text,id),state=result?.confirmed===true?'confirmed':'unconfirmed';this.store.db.prepare('UPDATE jobs SET state=?,result=?,updated=? WHERE id=?').run(state,JSON.stringify({confirmed:result?.confirmed===true}),this.now(),id);}
   catch{this.store.db.prepare('UPDATE jobs SET state=?,updated=? WHERE id=?').run('unconfirmed',this.now(),id);}
  }}finally{this.busy=false;}
 }
}
