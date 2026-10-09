import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {mkdtempSync,rmSync,readFileSync,mkdirSync,copyFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {createShop} from '../server/shop.mjs';

test('期限・再起動・通知再試行・バックアップ復元・回数制限',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'slide-market-unit-')),dataDir=resolve(root,'data'),fileDir=resolve(root,'files'),backups=resolve(root,'backups');
 mkdirSync(fileDir);for(const name of readdirSync('private/downloads').filter(n=>n.endsWith('.pptx')))copyFileSync(resolve('private/downloads',name),resolve(fileDir,name));
 let clock=Date.now(),shop,server,base,cookie='',csrf='';
 async function start(){shop=createShop({dataDir,fileDir,backupsDir:backups,backupInterval:0,now:()=>clock,tokenTtl:1000,quoteTtl:2000});server=createServer((req,res)=>shop.handle(req,res,()=>{res.statusCode=404;res.end();}));server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function stop(){server.closeAllConnections();await new Promise(ok=>server.close(ok));await shop.close();}
 async function request(path,method='GET',data,key){const r=await fetch(base+path,{method,headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(data?{body:JSON.stringify(data)}:{})});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return r;}
 async function quote(){return (await request('/api/quotes','POST',{items:['proposal']})).json();}
 const order=q=>({quoteId:q.id,result:'success',accepted:true,termsVersion:q.terms});
 try{
  await start();const legacy='a'.repeat(64);shop.store.db.prepare('INSERT INTO sessions VALUES (?)').run(legacy);cookie='slide_session='+legacy;csrf=(await (await request('/api/session')).json()).csrf;assert.equal(cookie,'slide_session='+legacy);
  const expired=await quote();clock+=2001;assert.equal((await request('/api/orders','POST',order(expired),'expired')).status,409);
  const q=await quote();const o=await (await request('/api/orders','POST',order(q),'first')).json();assert.equal(o.total,1200);
  const link=await (await request(`/api/orders/${o.id}/download-links/proposal`,'POST',{})).json();assert.equal((await request(link.url)).status,200);clock+=1001;assert.equal((await request(link.url)).status,404);
  const renewed=await (await request(`/api/orders/${o.id}/download-links/proposal`,'POST',{})).json();assert.equal((await request(renewed.url)).status,200);
  const password=readFileSync(resolve(dataDir,'admin-password.txt'),'utf8').trim();const login=await (await request('/api/admin/login','POST',{password})).json();csrf=login.csrf;
  const notice=(await (await request('/api/admin/notifications')).json())[0];assert.equal(notice.status,'pending');
  for(let attempt=0;attempt<8;attempt++){clock+=300000;assert.equal((await request('/api/admin/notifications/run','POST',{simulateFailure:true})).status,200);}
  assert.equal((await (await request('/api/admin/notifications')).json())[0].status,'failed');
  await request(`/api/admin/notifications/${notice.id}/retry`,'POST',{});await request('/api/admin/notifications/run','POST',{});assert.equal((await (await request('/api/admin/notifications')).json())[0].status,'saved');
  const env={...process.env,SHOP_DATA_DIR:dataDir,SHOP_FILE_DIR:fileDir,SHOP_BACKUP_DIR:backups};
  execFileSync(process.execPath,['scripts/local-data.mjs','backup'],{env});const backupName=readdirSync(backups)[0];
  assert.throws(()=>execFileSync(process.execPath,['scripts/local-data.mjs','restore',backupName],{env,stdio:'pipe'}));
  await stop();await start(); // Cookieと注文が再起動後も保持される。
  csrf=(await (await request('/api/session')).json()).csrf;assert.equal((await (await request('/api/orders')).json()).items[0].id,o.id);
  await request('/api/admin/reauth','POST',{password});await request(`/api/admin/orders/${o.id}/refund`,'POST',{reason:'復元テスト'});assert.equal((await (await request('/api/orders')).json()).items[0].status,'refunded');
  await stop();execFileSync(process.execPath,['scripts/local-data.mjs','restore',backupName],{env});await start();csrf=(await (await request('/api/session')).json()).csrf;
  assert.equal((await (await request('/api/orders')).json()).items[0].status,'paid');
  const lastLink=await (await request(`/api/orders/${o.id}/download-links/proposal`,'POST',{})).json();assert.equal((await request(lastLink.url)).status,200);
  for(let i=0;i<5;i++)assert.equal((await request('/api/inquiries','POST',{email:'test@example.test',category:'other',body:'test'})).status,201);
  assert.equal((await request('/api/inquiries','POST',{email:'test@example.test',category:'other',body:'test'})).status,429);
 }finally{if(server?.listening)await stop();rmSync(root,{recursive:true,force:true});}
});

async function localFixture(options={}){
 const root=mkdtempSync(resolve(tmpdir(),'slide-market-additions-')),dataDir=resolve(root,'data'),fileDir=resolve(root,'files'),backupsDir=resolve(root,'backups');mkdirSync(fileDir);
 for(const name of readdirSync('private/downloads').filter(n=>n.endsWith('.pptx')))copyFileSync(resolve('private/downloads',name),resolve(fileDir,name));
 let clock=Date.now();const shop=createShop({dataDir,fileDir,backupsDir,backupInterval:0,now:()=>clock,...options});
 const server=createServer((req,res)=>shop.handle(req,res,()=>{res.statusCode=404;res.end();}));server.listen(0,'127.0.0.1');await once(server,'listening');const base=`http://127.0.0.1:${server.address().port}`;
 async function client(){let cookie='',csrf='';async function send(path,method='GET',data,key,options={}){const response=await fetch(base+path,{method,redirect:options.redirect||'follow',headers:{Cookie:cookie,'X-CSRF-Token':csrf,'Content-Type':'application/json',...(key?{'Idempotency-Key':key}:{})},...(data?{body:JSON.stringify(data)}:{})});const setCookie=response.headers.get('set-cookie');if(setCookie)cookie=setCookie.split(';')[0];const result=response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text();if(result.csrf)csrf=result.csrf;return {status:response.status,data:result,location:response.headers.get('location'),setCookie,requestId:response.headers.get('x-request-id')};}await send('/api/session');return send;}
 return {root,dataDir,fileDir,backupsDir,shop,client,now:()=>clock,advance:ms=>{clock+=ms;},password:role=>readFileSync(resolve(dataDir,role+'-password.txt'),'utf8').trim(),async close(){server.closeAllConnections();await new Promise(ok=>server.close(ok));await shop.close();rmSync(root,{recursive:true,force:true});}};
}

test('Google OIDC login links anonymous purchases and favorites to the account',async()=>{
 let attempt=0,checked;
 const googleAuth={configured:true,redirectUri:'http://localhost/api/auth/google/callback',async begin(){const state=`google-state-${++attempt}`;return {url:`https://accounts.google.test/authorize?state=${state}`,state,nonce:`nonce-${attempt}`,verifier:`verifier-${attempt}`};},async authenticate(url,checks){checked={url,checks};return {id:'google-subject-1',email:'buyer@example.test',name:'Buyer'};}};
 const f=await localFixture({googleAuth});
 try{
  const first=await f.client(),second=await f.client();
  const favorite=await first('/api/favorites','POST',{productId:'proposal'});assert.equal(favorite.status,200);
  const quote=(await first('/api/quotes','POST',{items:['proposal']})).data;
  const order=(await first('/api/orders','POST',{quoteId:quote.id,result:'success',accepted:true,termsVersion:quote.terms},'anonymous-order')).data;
  const start=await first('/api/auth/google','GET',undefined,undefined,{redirect:'manual'});assert.equal(start.status,302);assert.match(start.setCookie,/SameSite=Lax/);
  const state=new URL(start.location).searchParams.get('state');assert.ok(state);
  const callback=await first(`/api/auth/google/callback?code=authorization-code&state=${state}`,'GET',undefined,undefined,{redirect:'manual'});assert.equal(callback.status,303);
  assert.equal(new URL(callback.location,'http://localhost').hash,'#home');
  assert.equal(checked.url.searchParams.get('code'),'authorization-code');assert.equal(checked.checks.state,state);assert.equal(checked.checks.nonce,'nonce-1');assert.equal(checked.checks.verifier,'verifier-1');
  const session=(await first('/api/session')).data;assert.deepEqual(session.account,{id:'google-subject-1',email:'buyer@example.test',name:'Buyer'});
  assert.equal((await first('/api/orders')).data.items[0].id,order.id);
  assert.deepEqual((await first('/api/favorites')).data,['proposal']);
  const secondStart=await second('/api/auth/google','GET',undefined,undefined,{redirect:'manual'});const secondState=new URL(secondStart.location).searchParams.get('state');
  assert.equal((await second(`/api/auth/google/callback?code=second-code&state=${secondState}`,'GET',undefined,undefined,{redirect:'manual'})).status,303);
  await second('/api/session');
  assert.equal((await second('/api/orders')).data.items[0].id,order.id);
  assert.deepEqual((await second('/api/favorites')).data,['proposal']);
  assert.equal((await second('/api/quotes','POST',{items:['proposal']})).data.code,'ALREADY_PURCHASED');
  const secondQuote=(await second('/api/quotes','POST',{items:['sales']})).data;
  const secondOrder=(await second('/api/orders','POST',{quoteId:secondQuote.id,result:'success',accepted:true,termsVersion:secondQuote.terms},'account-order')).data;
  assert.equal((await first('/api/orders')).data.items.some(item=>item.id===secondOrder.id),true);
  await second('/api/orders','DELETE');
  assert.equal((await second('/api/orders')).data.items.some(item=>item.id===secondOrder.id),true);
  const link=(await second(`/api/orders/${order.id}/download-links/proposal`,'POST',{})).data;
  assert.equal((await second(link.url)).status,200);
  assert.equal((await first('/api/auth/logout','POST',{})).status,200);
  assert.equal((await first(`/api/orders/${order.id}`)).status,404);
  assert.equal((await second(`/api/orders/${order.id}`)).status,200);
  assert.equal((await first('/api/auth/google/callback?code=replay&state='+state,'GET',undefined,undefined,{redirect:'manual'})).location,'/?google=failed#home');
 }finally{await f.close();}
});

test('TOTP・復旧コード・商品管理者ログアウト・再認証期限・復旧',async()=>{
 const {totp,verifyTotp}=await import('../server/security.mjs');
 const secret='GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';assert.equal(totp(secret,1),'287082');assert.equal(verifyTotp(secret,'287082',59000),1);assert.equal(verifyTotp(secret,'287082',59000,1),null);
 const f=await localFixture();
 try{
  const send=await f.client(),other=await f.client();
  assert.equal((await send('/api/admin/login','POST',{password:f.password('admin')})).status,200);
  await other('/api/admin/login','POST',{password:f.password('admin')});
  const enrollment=await send('/api/admin/security/mfa/setup','POST',{password:f.password('admin')});assert.equal(enrollment.status,200);
  assert.equal((await send('/api/admin/security/mfa/confirm','POST',{code:'invalid'})).status,401);
  const first=totp(enrollment.data.secret,Math.floor(f.now()/30000));const confirmed=await send('/api/admin/security/mfa/confirm','POST',{code:first});assert.equal(confirmed.status,200);assert.equal(confirmed.data.recoveryCodes.length,8);
  assert.equal((await other('/api/admin/orders')).status,403);
  await send('/api/admin/logout','POST',{});
  const denied=await send('/api/admin/login','POST',{password:f.password('admin')});assert.equal(denied.status,401);assert.equal(denied.data.code,'MFA_REQUIRED');assert.equal(denied.data.requestId,denied.requestId);
  assert.equal((await send('/api/admin/login','POST',{password:f.password('admin'),code:first})).status,401);
  f.advance(31000);const fresh=totp(enrollment.data.secret,Math.floor(f.now()/30000));assert.equal((await send('/api/admin/login','POST',{password:f.password('admin'),code:fresh})).status,200);
  assert.equal((await send('/api/admin/reauth','POST',{password:f.password('admin'),code:fresh})).status,401);
  f.advance(31000);const again=totp(enrollment.data.secret,Math.floor(f.now()/30000));assert.equal((await send('/api/admin/reauth','POST',{password:f.password('admin'),code:again})).status,200);
  const q=(await send('/api/quotes','POST',{items:['proposal']})).data;const o=(await send('/api/orders','POST',{quoteId:q.id,result:'success',accepted:true,termsVersion:q.terms},'auth-order')).data;
  f.advance(300001);assert.equal((await send(`/api/admin/orders/${o.id}/refund`,'POST',{reason:'期限確認'})).data.code,'REAUTH_REQUIRED');
  const newCode=totp(enrollment.data.secret,Math.floor(f.now()/30000));await send('/api/admin/reauth','POST',{password:f.password('admin'),code:newCode});assert.equal((await send(`/api/admin/orders/${o.id}/refund`,'POST',{reason:'確認済み'})).status,200);
  await send('/api/admin/logout','POST',{});assert.equal((await send('/api/admin/login','POST',{password:f.password('admin'),code:confirmed.data.recoveryCodes[0]})).status,200);await send('/api/admin/logout','POST',{});
  assert.equal((await send('/api/admin/login','POST',{password:f.password('admin'),code:confirmed.data.recoveryCodes[0]})).status,401);
  assert.equal((await send('/api/admin/login','POST',{password:f.password('editor'),role:'editor'})).status,200);assert.equal((await send('/api/admin/orders')).status,403);assert.equal((await send('/api/admin/logout','POST',{})).status,200);assert.equal((await send('/api/admin/products')).status,403);
 }finally{await f.close();}
});

test('購入済み防止・束ねた商品・許諾スナップショット・安定したページング',async()=>{
 const f=await localFixture();
 try{
  const owner=await f.client(),other=await f.client();
  const q=(await owner('/api/quotes','POST',{items:['proposal']})).data;
  const stale=(await owner('/api/quotes','POST',{items:['proposal']})).data;
  const o=(await owner('/api/orders','POST',{quoteId:q.id,result:'success',accepted:true,termsVersion:q.terms},'purchase')).data;
  assert.equal(o.licenseSnapshot.version,q.terms);assert.ok(o.licenseSnapshot.terms.body.some(t=>t.includes('再販売')));
  assert.equal((await owner('/api/quotes','POST',{items:['proposal']})).data.code,'ALREADY_PURCHASED');
  assert.equal((await owner('/api/orders','POST',{quoteId:stale.id,result:'success',accepted:true,termsVersion:stale.terms},'different')).data.code,'ALREADY_PURCHASED');
  assert.equal((await other(`/api/orders/${o.id}`)).status,404);
  const legacySession=f.shop.store.db.prepare('SELECT session_id FROM orders WHERE id=?').get(o.id).session_id;
  for(let i=0;i<45;i++){
    const id='PAGED-'+String(i).padStart(3,'0');f.shop.store.db.prepare('INSERT INTO orders (id,session_id,date,total,request_key,request_body) VALUES (?,?,?,?,?,?)').run(id,legacySession,new Date(f.now()).toISOString(),1000,id,'{}');f.shop.store.put('orderMeta',id,{status:'refunded',lines:[]});
  }
  let cursor=null,ids=[];do{const page=await owner('/api/orders?limit=7'+(cursor?'&cursor='+cursor:''));assert.equal(page.status,200);ids.push(...page.data.items.map(o=>o.id));cursor=page.data.nextCursor;}while(cursor);
  assert.equal(ids.length,46);assert.equal(new Set(ids).size,46);assert.equal((await owner(`/api/orders/${ids.at(-1)}`)).status,200);
  assert.equal((await other('/api/orders')).data.items.length,0);assert.equal((await owner('/api/orders?cursor=bad')).data.code,'INVALID_CURSOR');
  await owner('/api/admin/login','POST',{password:f.password('admin')});await owner('/api/admin/reauth','POST',{password:f.password('admin')});await owner(`/api/admin/orders/${o.id}/refund`,'POST',{reason:'再購入許可'});assert.equal((await owner('/api/quotes','POST',{items:['proposal']})).status,200);
 }finally{await f.close();}
});

test('自動バックアップ・保持数・手動保存の保持・失敗後再試行',async()=>{
 const f=await localFixture({backupInterval:1000,backupKeep:2});
 try{
  await f.shop.maintenance();assert.equal(f.shop.store.get('maintenance','backup').status,'ok');
  const firstCount=readdirSync(f.backupsDir).length;await f.shop.maintenance();assert.equal(readdirSync(f.backupsDir).length,firstCount);
  const env={...process.env,SHOP_DATA_DIR:f.dataDir,SHOP_FILE_DIR:f.fileDir,SHOP_BACKUP_DIR:f.backupsDir};execFileSync(process.execPath,['scripts/local-data.mjs','backup'],{env});
  for(let i=0;i<3;i++){f.advance(1001);await f.shop.maintenance();}
  assert.equal(readdirSync(f.backupsDir).filter(n=>n.startsWith('auto-')).length,2);assert.equal(readdirSync(f.backupsDir).filter(n=>n.startsWith('backup-')).length,1);
  const original=resolve(f.fileDir,'versions',readdirSync(resolve(f.fileDir,'versions'))[0]);const {writeFileSync}=await import('node:fs');const originalBytes=readFileSync(original);writeFileSync(original,'corrupt');f.advance(1001);await f.shop.maintenance();assert.equal(f.shop.store.get('maintenance','backup').status,'failed');writeFileSync(original,originalBytes);f.advance(1001);await f.shop.maintenance();assert.equal(f.shop.store.get('maintenance','backup').status,'ok');
 }finally{await f.close();}
});


test('模擬領収書の所有者限定・返金表示・購入時保存と復元演習',async()=>{
 const f=await localFixture();try{
  const owner=await f.client(),other=await f.client();const q=(await owner('/api/quotes','POST',{items:['proposal']})).data;const o=(await owner('/api/orders','POST',{quoteId:q.id,result:'success',accepted:true,termsVersion:q.terms},'receipt-order')).data;
  assert.equal(o.receiptSnapshot.total,1200);assert.equal(o.receiptSnapshot.tax,109);assert.equal((await other(`/api/orders/${o.id}/receipt`)).status,404);
  const receipt=await owner(`/api/orders/${o.id}/receipt`);assert.equal(receipt.status,200);assert.match(receipt.data,/実入金なし/);assert.equal((await owner(`/api/orders/${o.id}/receipt?download=1`)).status,200);
  const env={...process.env,SHOP_DATA_DIR:f.dataDir,SHOP_FILE_DIR:f.fileDir,SHOP_BACKUP_DIR:f.backupsDir};execFileSync(process.execPath,['scripts/local-data.mjs','backup'],{env});const name=readdirSync(f.backupsDir)[0];
  execFileSync(process.execPath,['scripts/local-data.mjs','backup-check',name],{env});execFileSync(process.execPath,['scripts/local-data.mjs','restore-drill',name],{env});assert.equal((await owner(`/api/orders/${o.id}`)).data.status,'paid');
  await owner('/api/admin/login','POST',{password:f.password('admin')});await owner('/api/admin/reauth','POST',{password:f.password('admin')});await owner(`/api/admin/orders/${o.id}/refund`,'POST',{reason:'領収書検証'});assert.match((await owner(`/api/orders/${o.id}/receipt`)).data,/全額模擬返金済み/);
  const {writeFileSync}=await import('node:fs');writeFileSync(resolve(f.backupsDir,name,'shop.sqlite'),'corrupted');assert.throws(()=>execFileSync(process.execPath,['scripts/local-data.mjs','restore-drill',name],{env,stdio:'pipe'}));assert.equal((await owner(`/api/orders/${o.id}`)).data.status,'refunded');
 }finally{await f.close();}
});

test('検査必須モードでは未検査ファイルを販売せず、既存ファイルの検出結果も記録する',async()=>{
 const assets={mode:'required',scanner:'/missing/clamscan',database:'',office:'/missing/libreoffice',raster:'/missing/pdftoppm'};const f=await localFixture({assets});try{
  const {writeFileSync}=await import('node:fs');assets.scanner=resolve(f.root,'scanner.mjs');writeFileSync(assets.scanner,`#!${process.execPath}\nprocess.exit(1);`,{mode:0o700});
  const send=await f.client();assert.equal((await send('/api/quotes','POST',{items:['proposal']})).data.code,'SCAN_REQUIRED');await send('/api/admin/login','POST',{password:f.password('admin')});
  const p=(await send('/api/admin/products')).data.find(p=>p.id==='proposal');const result=await send('/api/admin/products/proposal/prepare','POST',{revision:p.revision});assert.equal(result.status,400);assert.equal(result.data.code,'MALWARE_DETECTED');assert.equal(f.shop.store.get('versions',p.version).scan.status,'infected');assert.equal(f.shop.store.get('products',p.id).revision,p.revision);assert.equal((await send('/api/quotes','POST',{items:['proposal']})).data.code,'FILE_REJECTED');assert.equal((await send('/api/products/proposal/previews/0')).status,404);assets.mode='off';assert.equal((await send('/api/admin/products/proposal/prepare','POST',{revision:p.revision})).data.code,'SCAN_REQUIRED');assert.equal(f.shop.store.get('versions',p.version).scan.status,'infected');
 }finally{await f.close();}
});

test('ファイル処理中は競合を返し、完了後も古いrevisionの更新を拒否する',async()=>{
 const assets={mode:'required',scanner:'/missing/clamscan',database:'',office:'/missing/libreoffice',raster:'/missing/pdftoppm'};const f=await localFixture({assets});try{
  const {writeFileSync}=await import('node:fs');assets.scanner=resolve(f.root,'scanner.mjs');writeFileSync(assets.scanner,`#!${process.execPath}\nawait new Promise(r=>setTimeout(r,200));process.exit(0);`,{mode:0o700});
  const send=await f.client();await send('/api/admin/login','POST',{password:f.password('admin')});const p=(await send('/api/admin/products')).data.find(p=>p.id==='proposal');
  const first=send('/api/admin/products/proposal/prepare','POST',{revision:p.revision});let busy=false;for(let i=0;i<20;i++){busy=(await send('/api/admin/health')).data.assets.busy;if(busy)break;}assert.equal(busy,true);
  assert.equal((await send('/api/admin/products/proposal/prepare','POST',{revision:p.revision})).data.code,'ASSET_BUSY');assert.equal((await first).status,200);assert.equal((await send('/api/admin/products/proposal/prepare','POST',{revision:p.revision})).status,409);
 }finally{await f.close();}
});
