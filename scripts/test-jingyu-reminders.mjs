import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {JingyuStore} from '../packages/jingyu/store.mjs';
import {StudyReminders,nextReminderAt,reminderWindow} from '../packages/jingyu/reminders.mjs';
const config={chat:'wechat:private:123',start:'09:00',end:'18:00',interval:120,jitter:15,weekdays:[1,2,3,4,5],text:'小鱼来报时，给学习留十分钟吧',consented:true};
test('workday reminders use China time, bounded jitter and skip nights/weekends',()=>{
 const monday=Date.parse('2026-10-26T09:00:00+08:00');assert.equal(nextReminderAt(monday,config,()=>1),monday+135*60000);
 assert(!reminderWindow(Date.parse('2026-10-31T11:00:00+08:00'),config));assert.equal(new Date(nextReminderAt(Date.parse('2026-10-30T17:00:00+08:00'),config,()=>0)).toISOString(),'2026-11-02T03:00:00.000Z');
});
test('persistent reminder claims prevent duplicate sends and preserve unconfirmed outcomes',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'jingyu-reminder-')),store=new JingyuStore(root,'a'.repeat(64));t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});let now=Date.parse('2026-10-26T09:00:00+08:00'),sends=0;const scheduler=new StudyReminders(store,{now:()=>now,random:()=>0});const saved=scheduler.save(config);now=saved.nextAt;
 await scheduler.tick({allowed:()=>true,send:async()=>{sends++;return {confirmed:true};}});await scheduler.tick({allowed:()=>true,send:async()=>{sends++;}});assert.equal(sends,1);
 const restored=new StudyReminders(store,{now:()=>now,random:()=>0});assert.equal(restored.list().length,1);restored.pause(config.chat);now+=3*3600000;await restored.tick({allowed:()=>true,send:async()=>{sends++;}});assert.equal(sends,1);
});
