import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {actorChat,validActor,validChat} from './store.mjs';

const hash=value=>crypto.createHash('sha256').update(value).digest('hex');
const privateText=text=>/【私密】|\[私密\]|(?:不要|别|不许|不能)\s*(?:向|跟|对)?(?:其他人|别人|外人)(?:说|分享|透露)|(?:不要|别|不许)告诉(?:其他人|别人|外人)|仅(?:你|我们)知道|只告诉你|保密|密码|验证码|身份证|银行卡|家庭地址|住址|手机号|电话号码|api[ _-]?key|sk-[a-z0-9_-]{12,}|\b1[3-9]\d{9}\b/i.test(text);
const validPrivate=chat=>validChat(chat)&&chat.startsWith('wechat:private:');

// Only original incoming private messages from the account's own archive are
// indexed. AI replies may contain other people's facts and must never be
// exported back through the owner's conversation (a transitive privacy leak).
export function syncConversationMemory(store,history,{root,allowedChats}={}){
  const prefs=store.settings();
  if(!prefs.ownerWxid||!prefs.conversationMemoryEnabled||history.accountScope!==store.account)return 0;
  if(!allowedChats){
    const config=JSON.parse(fs.readFileSync(path.join(root,'config/wechatagent.json'),'utf8').replace(/^\uFEFF/,''));
    allowedChats=(config.wechat?.whitelist?.private??[]).map(id=>'wechat:private:'+id);
  }
  const cursors=store.get('conversationMemoryCursors',{}),since=store.get('conversationMemorySince',0);
  let imported=0;
  for(const chat of new Set(allowedChats.filter(validPrivate))){
    const cursor=cursors[chat];
    // First activation imports the latest 200 records per allowed conversation.
    // Later batches advance from a durable cursor; a backlog is caught up on
    // subsequent requests without loading every chat's entire archive.
    const records=cursor===undefined
      ?history.db.prepare('SELECT seq,body,at,source FROM records WHERE chat=? AND at>=? ORDER BY seq DESC LIMIT 200').all(chat,since).reverse()
      :history.db.prepare('SELECT seq,body,at,source FROM records WHERE chat=? AND seq>? AND at>=? ORDER BY seq LIMIT 200').all(chat,cursor,since);
    if(!records.length)continue;
    store.transaction(()=>{
      const insert=store.db.prepare('INSERT OR IGNORE INTO conversation_memories(id,binding,chat,person,text,at,record,shareable) VALUES(?,?,?,?,?,?,?,?)');
      for(const record of records){
        const row=JSON.parse(record.body);
        if(!['bridge','buffer-backfill'].includes(record.source)||row.platform!=='wechat'||row.kind!=='private'||row.outgoing!==false||String(row.conversation_id)!==chat.split(':')[2]||String(row.sender_id)!==chat.split(':')[2]||row.quoteReply||row.forwardedRecord||row.interaction||!Number.isFinite(record.at)||typeof row.text!=='string'||!row.text.trim())continue;
        const person=String(row.conversation_name||row.sender_name||chat).replace(/[\r\n\0]/g,' ').slice(0,80);
        const shareable=privateText(row.text)?0:1,text=row.text.trim().slice(0,12000);
        for(let start=0;start<text.length;start+=1200){
          const id='conversation:'+hash(prefs.ownerWxid+'\0'+chat+'\0'+record.seq+'\0'+start);
          const result=insert.run(id,prefs.ownerWxid,chat,person,text.slice(start,start+1200),record.at,record.seq,shareable);
          imported+=Number(result.changes);
        }
      }
      cursors[chat]=records.at(-1).seq;store.set('conversationMemoryCursors',cursors);
    });
  }
  return imported;
}

function queryTerms(query){
  const words=query.normalize('NFKC').toLowerCase().match(/[a-z0-9_]{2,}|[\p{Script=Han}]+/gu)??[];
  return [...new Set(words.flatMap(word=>/^[\p{Script=Han}]+$/u.test(word)?Array.from(word).flatMap((c,i,a)=>i<a.length-1?[c+a[i+1]]:[]):[word]))].slice(0,60);
}

export function searchConversationMemory(store,{chat,actor,query='',limit=6,person=''}={}){
  const prefs=store.settings();
  // Group sharing of manually published notes remains separate. A group or a
  // claimed nickname never grants access to private conversation records.
  if(!prefs.conversationMemoryEnabled||!prefs.ownerWxid||!validPrivate(chat)||!validActor(actor)||actorChat(actor)!==chat)return [];
  const owner=store.owner(chat,actor),ownerChat=actorChat(prefs.ownerWxid);
  // Scope filtering happens in SQL before ranking and bounded projection.
  const terms=queryTerms(query),normalized=query.normalize('NFKC').toLowerCase();
  const named=person.trim().normalize('NFKC').toLowerCase();
  const where=`binding=? AND hidden=0 AND (?=1 OR chat=? OR (chat=? AND shareable=1 AND ?=1))
    AND (?='' OR instr(lower(person),?)>0 OR (?='主人' AND chat=?))`;
  const access=[prefs.ownerWxid,owner?1:0,chat,ownerChat,prefs.sharedMemoryEnabled?1:0,named,named,named,ownerChat];
  const relevance=terms.map(()=>'(CASE WHEN instr(lower(text),?)>0 THEN 1 ELSE 0 END)').concat("(CASE WHEN length(person)>=2 AND instr(?,lower(CASE WHEN chat=? THEN '主人' ELSE person END))>0 THEN 8 ELSE 0 END)").join('+');
  let selected=store.db.prepare(`SELECT id,chat,person,text,at,record,${relevance} score FROM conversation_memories WHERE ${where} ORDER BY score DESC,at DESC,record DESC LIMIT ?`).all(...terms,normalized,ownerChat,...access,limit).filter(row=>row.score>0);
  // Everyday questions such as "主人最近忙什么" need the owner's recent
  // self-reports even when they share no keywords with "我在写论文".
  const targetOwner=!owner&&prefs.sharedMemoryEnabled||/主人|最近|近况/.test(query)&&!named;
  if(selected.length<limit){
    const chosen=new Set(selected.map(row=>row.id));
    const fallback=store.db.prepare(`SELECT id,chat,person,text,at,record FROM conversation_memories WHERE ${where} ORDER BY (CASE WHEN chat=? THEN ? ELSE 0 END) DESC,at DESC,record DESC LIMIT ?`).all(...access,ownerChat,targetOwner?1:0,limit+3).filter(row=>!chosen.has(row.id));
    selected=[...selected,...fallback.slice(0,Math.min(limit-selected.length,3))];
  }
  return selected.map(({score,record,...row})=>({...row,person:row.chat===ownerChat?'主人':row.person,owner:row.chat===ownerChat,scope:row.chat===ownerChat?(owner?'owner_private':'owner_shared'):'contact_private',source:'conversation',match:score>0?'keyword':'recent',updated:row.at*1000}));
}

export function conversationQuery(history,chat,ids,fallback=''){
  if(!Array.isArray(ids)||!ids.length)return fallback.slice(-300);
  const rows=history.db.prepare("SELECT text FROM records WHERE chat=? AND json_extract(body,'$.id') IN ("+ids.map(()=>'?').join(',')+") ORDER BY seq").all(chat,...ids);
  return (rows.map(row=>row.text).join('\n')||fallback).slice(-300);
}
