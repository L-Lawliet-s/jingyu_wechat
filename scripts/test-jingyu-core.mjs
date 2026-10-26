import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {JingyuStore,actorChat} from '../packages/jingyu/store.mjs';
import {Billing} from '../packages/jingyu/billing.mjs';

function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'jingyu-test-')),store=new JingyuStore(root,'a'.repeat(64));t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});store.saveSettings({ownerWxid:'fixture_owner',sharedMemoryEnabled:true,allowGroupShared:false});return store;}
test('memory scopes enforce owner-to-contact sharing and prevent contact-to-contact disclosure',t=>{
 const store=fixture(t),owner=actorChat('fixture_owner'),a=actorChat('fixture_a'),b=actorChat('fixture_b');
 store.saveMemory({chat:owner,actor:'fixture_owner',scope:'owner_shared',text:'蓝鲸学习计划',desktop:true});
 store.saveMemory({chat:owner,actor:'fixture_owner',scope:'owner_private',text:'主人私有内容'});
 store.saveMemory({chat:a,actor:'fixture_a',text:'A的私有考试'});store.saveMemory({chat:b,actor:'fixture_b',text:'B的私有考试'});
 const texts=(chat,actor)=>store.searchMemory({chat,actor}).map(x=>x.text);
 assert.deepEqual(new Set(texts(a,'fixture_a')),new Set(['蓝鲸学习计划','A的私有考试']));
 assert.deepEqual(new Set(texts(b,'fixture_b')),new Set(['蓝鲸学习计划','B的私有考试']));
 assert.deepEqual(texts(a,''),['蓝鲸学习计划']);assert.deepEqual(texts(a,'fixture_b'),['蓝鲸学习计划']);
 assert.deepEqual(new Set(texts(owner,'fixture_owner')),new Set(['蓝鲸学习计划','主人私有内容','A的私有考试','B的私有考试']));
 assert.equal(store.searchMemory({chat:'wechat:group:123',actor:'fixture_a'}).length,0);
 assert.throws(()=>store.saveMemory({chat:a,actor:'fixture_a',scope:'owner_shared',text:'伪造主人'}));
 assert.throws(()=>store.saveMemory({chat:owner,actor:'fixture_a',scope:'owner_private',text:'伪造来源'}));
});
test('model-proposed shared memories need publication and revocation changes the context epoch',t=>{
 const store=fixture(t),chat=actorChat('fixture_owner'),item=store.saveMemory({chat,actor:'fixture_owner',scope:'owner_shared',text:'候选'});
 assert.equal(store.epoch(),1,'pending proposals do not invalidate the native turn that created them');
 assert.equal(item.status,'pending');assert.equal(store.searchMemory({chat,actor:'fixture_owner'}).length,0);
 store.saveMemory({...item,actor:'fixture_owner',desktop:true,status:'published'});const epoch=store.epoch();assert.equal(store.searchMemory({chat,actor:'fixture_owner'}).length,1);
 store.removeMemory(item.id);assert(store.epoch()>epoch);assert.equal(store.searchMemory({chat,actor:'fixture_owner'}).length,0);
});
test('rebinding owner never exposes the previous owner memory to the new owner or other contacts',t=>{
 const store=fixture(t),chat=actorChat('fixture_owner');store.saveMemory({chat,actor:'fixture_owner',scope:'owner_shared',text:'原主人的共享项',desktop:true});store.saveMemory({chat,actor:'fixture_owner',scope:'owner_private',text:'原主人的私有项'});
 store.saveSettings({ownerWxid:'fixture_new_owner',sharedMemoryEnabled:true,allowGroupShared:false});assert.deepEqual(store.searchMemory({chat:actorChat('fixture_new_owner'),actor:'fixture_new_owner'}),[]);assert.deepEqual(store.searchMemory({chat:actorChat('fixture_a'),actor:'fixture_a'}),[]);assert(store.get('memoryResetAt')>0);
});
test('account databases are isolated and persisted',t=>{
 const store=fixture(t),other=new JingyuStore(path.resolve(store.directory,'../../..'),'b'.repeat(64));try{assert.equal(other.settings().ownerWxid,'');assert.equal(other.listMemories().length,0);}finally{other.close();}
});
test('balance uses fixed authenticated endpoint, caches and never exposes credentials',async t=>{
 const store=fixture(t);let calls=0;const billing=new Billing(store,{crypt:(s,p)=>p?'encrypted': 'fixture-private-api-key',fetchImpl:async(url,opts)=>{calls++;assert.equal(url,'https://api.deepseek.com/user/balance');assert.equal(opts.headers.Authorization,'Bearer fixture-private-api-key');return new Response(JSON.stringify({is_available:true,balance_infos:[{currency:'CNY',total_balance:'12.34',granted_balance:'2.00',topped_up_balance:'10.34'}]}));}});
 billing.setKey('fixture-private-api-key');const first=await billing.balance(),second=await billing.balance();assert.equal(first.balances[0].total,'12.34');assert.equal(second.cached,true);assert.equal(calls,1);assert(!JSON.stringify(first).includes('private-api-key'));assert.equal(fs.readFileSync(billing.file,'utf8'),'encrypted');
});
test('balance failures retain stale data and do not invent zero',async t=>{
 const store=fixture(t),billing=new Billing(store,{crypt:()=> 'encrypted',fetchImpl:async()=>new Response('',{status:401})});billing.setKey('fixture-private-api-key');const result=await billing.balance();assert.equal(result.available,null);assert.equal(result.stale,true);assert.deepEqual(result.balances,[]);assert(!JSON.stringify(result).includes('Bearer'));
});
