import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,mkdirSync,copyFileSync,readdirSync,rmSync,readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createShop} from '../server/shop.mjs';
import {googleFixture} from './support/google-fixture.mjs';
import {openStore} from '../server/storage.mjs';
import {openRemoteStore} from '../server/remote-storage.mjs';
import {execFileSync} from 'node:child_process';

for(const external of [false,true])test(`Google購入者（${external?'実PHP・MySQL':'ローカル'}）: セッション失効後の再認証・別端末・所有者分離・ログアウト`,{skip:external&&!process.env.STARSERVER_TEST_URL},async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'slide-google-')),dataDir=resolve(root,'data'),fileDir=resolve(root,'files');mkdirSync(fileDir);
 for(const name of readdirSync('private/downloads').filter(n=>n.endsWith('.pptx')))copyFileSync(resolve('private/downloads',name),resolve(fileDir,name));
 let shop,server,base;const google=googleFixture();
 if(external){
  const seed=openStore(dataDir,fileDir);seed.db.close();
  execFileSync(process.execPath,['scripts/import-starserver.mjs'],{env:{...process.env,SHOP_DATA_DIR:dataDir,SHOP_FILE_DIR:fileDir,STARSERVER_API_URL:process.env.STARSERVER_TEST_URL,STARSERVER_API_KEY:process.env.STARSERVER_TEST_KEY},stdio:'pipe'});
 }
 async function start(){shop=createShop({dataDir,fileDir,google:google.auth,backupInterval:0,...(external?{storageMode:'starserver',remote:{url:process.env.STARSERVER_TEST_URL,key:process.env.STARSERVER_TEST_KEY}}:{})});server=createServer((req,res)=>shop.handle(req,res,()=>{res.writeHead(404);res.end();}));server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function stop(){server.closeAllConnections();await new Promise(ok=>server.close(ok));await shop.close();}
 async function client(){let cookie='',csrf='';const c={async send(path,method='GET',data,key){const r=await fetch(base+path,{method,redirect:'manual',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(data?{body:JSON.stringify(data)}:{})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];const body=r.headers.get('content-type')?.includes('application/json')?await r.json():null;if(body?.csrf)csrf=body.csrf;return {status:r.status,body,location:r.headers.get('location')};},async login(sub='buyer-one'){
  google.setClaims({sub});const began=await c.send('/api/auth/google/start?returnTo=%2F%23history');const url=new URL(began.location);
  // Real signatures and claim validation; only Google's HTTP responses are replaced.
  // Record the nonce from the actual app start (the fixture sees it through token claims).
  google.setClaims({sub,nonce:url.searchParams.get('nonce')});
  return c.send('/api/auth/google/callback?'+new URLSearchParams({state:url.searchParams.get('state'),code:'code'}));
 }};await c.send('/api/session');return c;}
 try{
  await start();const owner=await client();assert.equal((await owner.send('/api/quotes','POST',{items:['proposal']})).status,401);
  assert.equal((await owner.login()).status,302);assert.equal((await owner.send('/api/admin/orders')).status,403);
  const first=(await owner.send('/api/session')).body;assert.equal(first.sessionMode,'memory');assert.ok(first.user);
  const q=(await owner.send('/api/quotes','POST',{items:['proposal']})).body;
  const o=(await owner.send('/api/orders','POST',{quoteId:q.id,result:'success',accepted:true,termsVersion:q.terms},'google-order')).body;assert.equal(o.total,1200);
  const link=(await owner.send(`/api/orders/${o.id}/download-links/proposal`,'POST',{})).body;
  const other=await client();await other.login('buyer-two');await other.send('/api/session');assert.equal((await other.send(`/api/orders/${o.id}`)).status,404);
  const same=await client();await same.login();await same.send('/api/session');assert.equal((await same.send(`/api/orders/${o.id}`)).status,200);assert.equal((await same.send(link.url)).status,404);
  assert.equal(shop.store.db.prepare('SELECT COUNT(*) AS n FROM local_sessions').get().n,3);
  // Persistent SQLite contains no newly created security sessions or quotes.
  const {DatabaseSync}=await import('node:sqlite');const disk=new DatabaseSync(resolve(dataDir,'shop.sqlite'));assert.equal(disk.prepare('SELECT COUNT(*) AS n FROM local_sessions').get().n,0);assert.equal(disk.prepare("SELECT COUNT(*) AS n FROM documents WHERE kind='quotes'").get().n,0);disk.close();
  await stop();await start();assert.equal((await owner.send('/api/session')).body.user,null);assert.equal((await owner.send(link.url)).status,404);
  await owner.login();await owner.send('/api/session');assert.equal((await owner.send('/api/orders')).body.items[0].id,o.id);
  assert.equal((await owner.send('/api/quotes','POST',{items:['proposal']})).body.code,'ALREADY_PURCHASED');
  const fresh=(await owner.send(`/api/orders/${o.id}/download-links/proposal`,'POST',{})).body;assert.equal((await owner.send(fresh.url)).status,200);
  await owner.send('/api/auth/logout','POST',{});assert.equal((await owner.send(fresh.url)).status,404);assert.equal((await owner.send('/api/orders')).body.items.length,0);
  if(external){
   const admin=await client(),password=readFileSync(resolve(dataDir,'admin-password.txt'),'utf8').trim();
   assert.equal((await admin.send('/api/admin/login','POST',{password})).status,200);
   assert.equal((await admin.send('/api/admin/orders?q=DEMO')).body.items.length,1);
   assert.equal((await admin.send('/api/admin/health')).body.backup.status,'external');
   assert.equal((await admin.send('/api/admin/coupons','POST',{code:'REMOTE-COUPON',percent:20,limit:1,expires:Date.now()+3600000})).status,201);
   const product=(await admin.send('/api/admin/products')).body.find(p=>p.id==='sales');
   assert.equal((await admin.send('/api/admin/products/sales/prepare','POST',{revision:product.revision})).status,200);
   assert.equal((await admin.send('/api/admin/products/test-bundle','PATCH',{...product,id:'test-bundle'})).status,409);
   assert.equal((await admin.send('/api/admin/products','POST',{id:'test-bundle',name:'テストセット',category:'テスト',description:'セット販売の結合確認',price:2000,status:'published',bundle:['proposal','sales']})).status,200);
   const buyer=await client();await buyer.login('bundle-buyer');await buyer.send('/api/session');
   const quote=(await buyer.send('/api/quotes','POST',{items:['test-bundle'],coupon:'REMOTE-COUPON'})).body;assert.equal(quote.total,1600);
   const bundle=(await buyer.send('/api/orders','POST',{quoteId:quote.id,result:'success',accepted:true,termsVersion:quote.terms},'bundle-key')).body;assert.equal(bundle.lines.length,2);assert.equal(bundle.total,1600);
   assert.equal((await admin.send('/api/admin/coupons')).body[0].used,1);
   assert.equal((await buyer.send('/api/inquiries','POST',{email:'buyer@example.test',body:'問い合わせ',category:'download',orderId:bundle.id})).status,201);
   assert.equal((await admin.send('/api/admin/inquiries')).body.length,1);
   await admin.send('/api/admin/notifications/run','POST',{});assert.ok((await admin.send('/api/admin/notifications')).body.every(n=>n.status==='saved'));
   assert.ok((await admin.send('/api/admin/audit')).body.items.length>0);
   await admin.send('/api/admin/reauth','POST',{password});assert.equal((await admin.send(`/api/admin/orders/${bundle.id}/refund`,'POST',{reason:'結合テスト'})).status,200);
   assert.equal((await buyer.send(`/api/orders/${bundle.id}`)).body.status,'refunded');
   assert.equal((await buyer.send(`/api/orders/${bundle.id}/download-links/sales`,'POST',{})).status,404);
  }
 }finally{
  if(server?.listening)await stop();
  if(external){
   // Only a dedicated empty database is accepted by the seed script above.
   const remote=openRemoteStore({url:process.env.STARSERVER_TEST_URL,key:process.env.STARSERVER_TEST_KEY});
   await remote.tx(async()=>{for(const table of ['orders','favorites','sessions','documents','metrics'])await remote.db.prepare(`DELETE FROM ${table}`).run();});remote.db.close();
  }
  rmSync(root,{recursive:true,force:true});
 }
});
