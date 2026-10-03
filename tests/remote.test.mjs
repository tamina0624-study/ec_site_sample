import test from 'node:test';
import assert from 'node:assert/strict';
import {openRemoteStore,mysqlSql} from '../server/remote-storage.mjs';
import {withMemoryState} from '../server/memory-state.mjs';
import {readFileSync} from 'node:fs';

test('PHP storage adapter: SQL変換・原子コミット・競合・失敗時に見積もりを消費しない',async()=>{
 const calls=[];let conflict=false;
 const store=withMemoryState(openRemoteStore({url:'https://storage.test/index.php',key:'x'.repeat(32),fetchImpl:async(url,options)=>{
  assert.equal(options.headers.Authorization,'Bearer '+'x'.repeat(32));assert.equal(options.redirect,'error');
  const action=url.searchParams.get('action'),body=JSON.parse(options.body);calls.push({action,body});
  if(action==='revision')return Response.json({revision:7});
  if(conflict&&body.expectedRevision!==undefined)return Response.json({error:'conflict'},{status:409});
  return Response.json({results:body.operations.map(op=>op.mode==='run'?{changes:1}:op.mode==='all'?[]:null)});
 }}));
 try{
  await store.put('quotes','q',{id:'q',expires:Date.now()+100000});
  await store.tx(async()=>{await store.put('orderMeta','order',{status:'paid'});await store.put('quotes','q',{id:'q',orderId:'order'});assert.equal(store.get('quotes','q').orderId,'order');});
  const batch=calls.at(-1).body;assert.equal(batch.expectedRevision,7);assert.equal(batch.operations.length,1);assert.match(batch.operations[0].sql,/ON DUPLICATE KEY UPDATE/);assert.equal(store.get('quotes','q').orderId,'order');
  conflict=true;await assert.rejects(store.tx(async()=>{await store.put('orderMeta','second',{status:'paid'});await store.put('quotes','q',{id:'q',orderId:'second'});}),{code:'STORAGE_CONFLICT'});
  assert.equal(store.get('quotes','q').orderId,'order');
  assert.match(mysqlSql("SELECT * FROM orders o WHERE instr(lower(o.id || ' ' || COALESCE(json_extract(m.value,'$.status'),'') || ' ' || COALESCE(m.value,'')),?)>0"),/CONCAT\(o.id/);
  assert.match(mysqlSql("SELECT value FROM documents WHERE kind=? ORDER BY rowid"),/ORDER BY seq/);
  assert.throws(()=>openRemoteStore({url:'http://storage.test',key:'x'.repeat(32)}));
 }finally{store.db.close();}
});

test('実PHP・MySQL: 注文と明細の原子性・revision競合・ファイル整合性・認証',{
 skip:!process.env.STARSERVER_TEST_URL,
},async()=>{
 const options={url:process.env.STARSERVER_TEST_URL,key:process.env.STARSERVER_TEST_KEY},store=openRemoteStore(options);
 const owner='remote-test-owner',id='REMOTE-TEST-ORDER';
 await store.db.prepare('DELETE FROM orders WHERE id=?').run(id);
 await store.db.prepare('INSERT OR IGNORE INTO sessions VALUES (?)').run(owner);
 try{
  await assert.rejects(store.tx(async()=>{
   await store.db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)').run(id,owner,new Date().toISOString(),1200,'remote-key','{}');
   throw new Error('abort');
  }),/abort/);
  assert.equal(await store.db.prepare('SELECT * FROM orders WHERE id=?').get(id),null);
  await store.tx(async()=>{
   await store.db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)').run(id,owner,new Date().toISOString(),1200,'remote-key','{}');
   await store.db.prepare('INSERT INTO items VALUES (?,?,?,?)').run(id,'proposal','企画',1200);
   await store.put('orderMeta',id,{status:'paid'});
  });
  assert.equal((await store.db.prepare('SELECT * FROM orders WHERE id=?').get(id)).total,1200);
  assert.equal((await store.db.prepare('SELECT * FROM items WHERE order_id=?').all(id)).length,1);
  assert.equal((await store.get('orderMeta',id)).status,'paid');
  // Force SQL failure halfway through the submitted batch: neither write may survive.
  await assert.rejects(store.tx(async()=>{await store.put('rollback','record',{ok:true});await store.db.prepare('INSERT INTO items VALUES (?,?,?,?)').run(id,'proposal','duplicate',1);}),{code:'STORAGE_CONFLICT'});
  assert.equal(await store.get('rollback','record'),null);
  const independent=openRemoteStore(options);
  await assert.rejects(store.tx(async()=>{await store.put('conflict','record',{ok:true});await independent.put('conflict','other',{ok:true});}),{code:'STORAGE_CONFLICT'});
  assert.equal(await store.get('conflict','record'),null);
  const bytes=readFileSync('private/downloads/proposal.pptx'),checksum=await store.snapshot(bytes);
  assert.deepEqual(await store.readVersion(checksum),bytes);
  await assert.rejects(openRemoteStore({...options,key:'wrong'.repeat(10)}).get('orderMeta',id),{code:'STORAGE_UNAVAILABLE'});
 }finally{
  await store.db.prepare('DELETE FROM orders WHERE id=?').run(id);
  await store.remove('orderMeta',id);await store.remove('conflict','other');await store.db.prepare('DELETE FROM sessions WHERE id=?').run(owner);store.db.close();
 }
});
