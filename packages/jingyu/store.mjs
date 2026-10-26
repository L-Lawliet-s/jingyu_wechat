import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {searchConversationMemory} from './conversation-memory.mjs';

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
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,chat TEXT NOT NULL,author TEXT NOT NULL,scope TEXT NOT NULL,status TEXT NOT NULL,text TEXT NOT NULL,source TEXT NOT NULL,created INTEGER NOT NULL,updated INTEGER NOT NULL,owner_binding TEXT NOT NULL DEFAULT '');
      CREATE INDEX IF NOT EXISTS memories_scope ON memories(scope,status,chat);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,kind TEXT NOT NULL,chat TEXT NOT NULL,actor TEXT NOT NULL,payload TEXT NOT NULL,state TEXT NOT NULL,result TEXT,created INTEGER NOT NULL,updated INTEGER NOT NULL,UNIQUE(kind,chat,id));
      CREATE TABLE IF NOT EXISTS receipts(id TEXT PRIMARY KEY,at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reminders(id TEXT PRIMARY KEY,config TEXT NOT NULL,next_at INTEGER NOT NULL,enabled INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_memories(id TEXT PRIMARY KEY,binding TEXT NOT NULL,chat TEXT NOT NULL,person TEXT NOT NULL,text TEXT NOT NULL,at REAL NOT NULL,record INTEGER NOT NULL,shareable INTEGER NOT NULL,hidden INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS conversation_memories_access ON conversation_memories(binding,chat,hidden,at DESC);`);
    if(!this.db.prepare('PRAGMA table_info(memories)').all().some(row=>row.name==='owner_binding')){
      this.transaction(()=>{if(!this.db.prepare('PRAGMA table_info(memories)').all().some(row=>row.name==='owner_binding')){this.db.exec("ALTER TABLE memories ADD COLUMN owner_binding TEXT NOT NULL DEFAULT ''");this.db.prepare('UPDATE memories SET owner_binding=?').run(this.settings().ownerWxid);}});
    }
  }
  get(key,fallback=null){const row=this.db.prepare('SELECT value FROM settings WHERE key=?').get(key);return row?JSON.parse(row.value):fallback;}
  set(key,value){this.db.prepare('INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,JSON.stringify(value));return value;}
  transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
  settings(){return {...{ownerWxid:'',sharedMemoryEnabled:true,allowGroupShared:false,conversationMemoryEnabled:true},...this.get('preferences',{})};}
  validateSettings(value){
    if(!value||Object.keys(value).some(k=>!['ownerWxid','sharedMemoryEnabled','allowGroupShared','conversationMemoryEnabled'].includes(k))||!validActor(value.ownerWxid)||typeof value.sharedMemoryEnabled!=='boolean'||typeof value.allowGroupShared!=='boolean'||value.conversationMemoryEnabled!==undefined&&typeof value.conversationMemoryEnabled!=='boolean')throw fault('请填写真实主人微信 ID，并检查共享开关。');
    return {...value,conversationMemoryEnabled:value.conversationMemoryEnabled??this.settings().conversationMemoryEnabled};
  }
  saveSettings(value){
    value=this.validateSettings(value);
    const old=this.settings();this.transaction(()=>{this.set('preferences',value);if(JSON.stringify(old)!==JSON.stringify(value)){this.bumpEpoch();if(old.ownerWxid&&old.ownerWxid!==value.ownerWxid){this.set('conversationMemorySince',Date.now()/1000);this.set('conversationMemoryCursors',{});}if(old.ownerWxid&&old.ownerWxid!==value.ownerWxid||old.sharedMemoryEnabled&&!value.sharedMemoryEnabled||old.allowGroupShared&&!value.allowGroupShared||old.conversationMemoryEnabled&&!value.conversationMemoryEnabled)this.set('memoryResetAt',Date.now());}});return value;
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
      this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET scope=excluded.scope,status=excluded.status,text=excluded.text,updated=excluded.updated').run(id,chat,actor,scope,status,text.trim(),source,previous?.created??now,now,this.settings().ownerWxid);
      const revoked=previous?.status==='published'&&(scope!==previous.scope||status!=='published'||previous.text!==text.trim());
      if(scope==='owner_shared'&&status==='published'||previous?.scope==='owner_shared'&&previous.status==='published'||revoked)this.bumpEpoch();
      if(revoked)this.set('memoryResetAt',now);
    });const {owner_binding,...saved}=this.db.prepare('SELECT * FROM memories WHERE id=?').get(id);return saved;
  }
  listMemories(){return this.db.prepare('SELECT * FROM memories ORDER BY updated DESC LIMIT 500').all();}
  removeMemory(id){this.transaction(()=>{const row=this.db.prepare('SELECT status FROM memories WHERE id=?').get(id);this.db.prepare('DELETE FROM memories WHERE id=?').run(id);if(row?.status==='published'){this.bumpEpoch();this.set('memoryResetAt',Date.now());}});}
  searchMemory({chat,actor='',query='',limit=6,person=''}){
    if(!validChat(chat)||typeof query!=='string'||query.length>300||typeof person!=='string'||person.length>80||!Number.isInteger(limit)||limit<1||limit>20)throw fault('记忆查询无效。');
    const prefs=this.settings(),owner=this.owner(chat,actor);
    const shared=owner||prefs.sharedMemoryEnabled&&(!chat.includes(':group:')||prefs.allowGroupShared);
    // Enforce scope in SQL BEFORE scoring or returning candidates.
    const rows=this.db.prepare(`SELECT id,text,scope,updated,chat FROM memories WHERE status='published' AND
      ((scope='owner_shared' AND ?=1 AND author=?) OR (scope='owner_private' AND ?=1 AND author=? AND chat=?) OR (scope='contact_private' AND ((chat=? AND author=? AND ?=1) OR (?=1 AND owner_binding=?))))
      ORDER BY updated DESC LIMIT 500`).all(shared?1:0,prefs.ownerWxid,owner?1:0,prefs.ownerWxid,chat,chat,actor,validActor(actor)&&actorChat(actor)===chat?1:0,owner?1:0,prefs.ownerWxid);
    const terms=query.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu)??[];
    const grams=[...new Set(terms.flatMap(t=>t.length>2?Array.from({length:t.length-1},(_,i)=>t.slice(i,i+2)):[t]))].slice(0,60);
    const manual=rows.map(row=>({...row,score:grams.filter(term=>row.text.toLocaleLowerCase().includes(term)).length})).filter(row=>!grams.length||row.score>0).sort((a,b)=>b.score-a.score||b.updated-a.updated).map(({score,...row})=>({...row,source:'manual',person:row.scope.startsWith('owner_')?'主人':this.conversationPerson(row.chat)})).filter(row=>!person||row.person.toLowerCase().includes(person.toLowerCase()));
    const automatic=searchConversationMemory(this,{chat,actor,query,limit,person});
    return [...manual.slice(0,Math.min(3,limit)),...automatic,...manual.slice(Math.min(3,limit))].slice(0,limit);
  }
  conversationPerson(chat){return this.db.prepare('SELECT person FROM conversation_memories WHERE binding=? AND chat=? ORDER BY at DESC LIMIT 1').get(this.settings().ownerWxid,chat)?.person??chat;}
  listConversationMemories(){return this.db.prepare('SELECT id,chat,person,text,at,shareable FROM conversation_memories WHERE binding=? AND hidden=0 ORDER BY at DESC,record DESC LIMIT 100').all(this.settings().ownerWxid);}
  conversationMemoryCount(){return this.db.prepare('SELECT count(*) n FROM conversation_memories WHERE binding=? AND hidden=0').get(this.settings().ownerWxid).n;}
  restrictConversationMemory(id,remove=false){
    if(typeof id!=='string'||id.length>150)throw fault('请选择有效聊天记忆。');
    this.transaction(()=>{const row=this.db.prepare('SELECT chat,record FROM conversation_memories WHERE id=? AND binding=? AND hidden=0').get(id,this.settings().ownerWxid);if(!row)throw fault('聊天记忆已不存在，请刷新页面。',404);
      this.db.prepare(remove?'UPDATE conversation_memories SET hidden=1 WHERE binding=? AND chat=? AND record=?':'UPDATE conversation_memories SET shareable=0 WHERE binding=? AND chat=? AND record=?').run(this.settings().ownerWxid,row.chat,row.record);this.bumpEpoch();this.set('memoryResetAt',Date.now());});
  }
  close(){this.db.close();}
}
