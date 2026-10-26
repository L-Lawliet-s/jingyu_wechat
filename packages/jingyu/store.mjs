import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';

export const hash=value=>crypto.createHash('sha256').update(String(value)).digest('hex');
export const validChat=value=>typeof value==='string'&&/^wechat:(private|group):[1-9]\d{0,15}$/.test(value);
export const actorChat=actor=>'wechat:private:'+String(Number(crypto.createHash('sha256').update(actor).digest().readBigUInt64BE(0)%2147483647n+1n));
export const validActor=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{1,128}$/.test(value);
export const fault=(message,status=400)=>Object.assign(new Error(message),{status});

export class JingyuStore{
  constructor(root,account){
    if(!/^[a-f0-9]{64}$/.test(account??''))throw fault('请先连接并验证微信账号。',409);
    this.account=account;this.directory=path.resolve(root,'state/jingyu',account);
    // Do not traverse links into another account or an external directory.
    for(let p=this.directory;p!==path.dirname(p);p=path.dirname(p))if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw fault('鲸鱼数据目录不能包含链接。');
    fs.mkdirSync(this.directory,{recursive:true});
    this.db=new DatabaseSync(path.join(this.directory,'jingyu.sqlite'));
    this.db.exec(`PRAGMA busy_timeout=3000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,chat TEXT NOT NULL,author TEXT NOT NULL,scope TEXT NOT NULL,status TEXT NOT NULL,text TEXT NOT NULL,source TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope,status,chat);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,chat TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(kind,chat,id));
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,config TEXT NOT NULL,next_at INTEGER NOT NULL,enabled INTEGER NOT NULL);`);
  }
  get(key,fallback=null){const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  set(key,value){this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));return value;}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  settings(){return {...{ownerWxid:'',sharedMemoryEnabled:true,allowGroupShared:false},...this.get('preferences',{})};}
  validateSettings(value){
    if(!value||Object.keys(value).some(k=>!['ownerWxid','sharedMemoryEnabled','allowGroupShared'].includes(k))||!validActor(value.ownerWxid)||typeof value.sharedMemoryEnabled!=='boolean'||typeof value.allowGroupShared!=='boolean')throw fault('请填写真实主人微信 ID，并检查共享开关。');
    return value;
  }
  saveSettings(value){
    this.validateSettings(value);
    const old=this.settings();this.transaction(()=>{this.set('preferences',value);if(JSON.stringify(old)!==JSON.stringify(value)){this.bumpEpoch();if(old.ownerWxid&&old.ownerWxid!==value.ownerWxid||old.sharedMemoryEnabled&&!value.sharedMemoryEnabled||old.allowGroupShared&&!value.allowGroupShared)this.set('memoryResetAt',Date.now());}});return value;
  }
  owner(key,actor){return validActor(actor)&&this.settings().ownerWxid===actor&&key===actorChat(actor);}
  epoch(){return this.get('memoryEpoch',0);}
  bumpEpoch(){return this.set('memoryEpoch',this.epoch()+1);}
  saveMemory({id,chat,actor,text,scope='contact_private',status='published',source='chat',desktop=false}){
    if(!validChat(chat)||!validActor(actor)||typeof text!=='string'||!text.trim()||text.length>2000||!['owner_shared','owner_private','contact_private'].includes(scope)||!['pending','published'].includes(status))throw fault('记忆格式无效。');
    if(chat!==actorChat(actor))throw fault('初版只允许从本人私聊建立长期记忆。',403);
    if(scope.startsWith('owner_')&&!this.owner(chat,actor))throw fault('只有绑定主人的真实私聊可写主人记忆。',403);
    if(scope==='contact_private'&&this.owner(chat,actor))scope='owner_private';
    // Publishing globally from model text is not allowed. Owner publishes in the desktop UI.
    if(scope==='owner_shared'&&!desktop)status='pending';
    if(!['chat','desktop'].includes(source))throw fault('记忆来源无效。');
    const now=Date.now();id??=crypto.randomUUID();
    this.transaction(()=>{
      const previous=this.db.prepare('SELECT * FROM memories WHERE id=?').get(id);
      if(previous&&(previous.chat!==chat||previous.author!==actor))throw fault('不能改写其他人的记忆。',403);
      this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,status=excluded.status,text=excluded.text,updated=excluded.updated').run(id,chat,actor,scope,status,text.trim(),source,previous?.created??now,now);
      if(scope==='owner_shared'&&status==='published'||previous?.scope==='owner_shared'&&previous.status==='published')this.bumpEpoch();
      if(previous?.scope==='owner_shared'&&previous.status==='published'&&(scope!=='owner_shared'||status!=='published'||previous.text!==text.trim()))this.set('memoryResetAt',now);
    });return this.db.prepare('SELECT * FROM memories WHERE id=?').get(id);
  }
  listMemories(){return this.db.prepare('SELECT * FROM memories ORDER BY updated DESC LIMIT 500').all();}
  removeMemory(id){this.transaction(()=>{const row=this.db.prepare('SELECT scope,status FROM memories WHERE id=?').get(id);this.db.prepare('DELETE FROM memories WHERE id=?').run(id);if(row?.scope==='owner_shared'&&row.status==='published'){this.bumpEpoch();this.set('memoryResetAt',Date.now());}});}
  searchMemory({chat,actor='',query='',limit=6}){
    if(!validChat(chat)||typeof query!=='string'||query.length>300||!Number.isInteger(limit)||limit<1||limit>20)throw fault('记忆查询无效。');
    const prefs=this.settings(),owner=this.owner(chat,actor);
    const shared=prefs.sharedMemoryEnabled&&(!chat.includes(':group:')||prefs.allowGroupShared);
    // Enforce scope in SQL BEFORE scoring or returning candidates.
    const rows=this.db.prepare(`SELECT id,text,scope,updated FROM memories WHERE status='published' AND
      ((scope='owner_shared' AND ?=1 AND author=?) OR (scope='owner_private' AND ?=1 AND author=? AND chat=?) OR (scope='contact_private' AND chat=? AND author=? AND ?=1))
      ORDER BY updated DESC LIMIT 500`).all(shared?1:0,prefs.ownerWxid,owner?1:0,prefs.ownerWxid,chat,chat,actor,validActor(actor)&&actorChat(actor)===chat?1:0);
    const terms=query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
    const grams=[...new Set(terms.flatMap(t=>t.length>2?Array.from({length:t.length-1},(_,i)=>t.slice(i,i+2)):[t]))].slice(0,60);
    return rows.map(row=>({...row,score:grams.filter(term=>row.text.toLocaleLowerCase().includes(term)).length})).filter(row=>!grams.length||row.score>0).sort((a,b)=>b.score-a.score||b.updated-a.updated).slice(0,limit).map(({score,...row})=>row);
  }
  close(){this.db.close();}
}
