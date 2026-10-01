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
 async function start(){shop=createShop({dataDir,fileDir,now:()=>clock,tokenTtl:1000,quoteTtl:2000});server=createServer((req,res)=>shop.handle(req,res,()=>{res.statusCode=404;res.end();}));server.listen(0,'127.0.0.1');await once(server,'listening');base=`http://127.0.0.1:${server.address().port}`;}
 async function stop(){server.closeAllConnections();await new Promise(ok=>server.close(ok));shop.close();}
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
  csrf=(await (await request('/api/session')).json()).csrf;assert.equal((await (await request('/api/orders')).json())[0].id,o.id);
  await request(`/api/admin/orders/${o.id}/refund`,'POST',{reason:'復元テスト'});assert.equal((await (await request('/api/orders')).json())[0].status,'refunded');
  await stop();execFileSync(process.execPath,['scripts/local-data.mjs','restore',backupName],{env});await start();csrf=(await (await request('/api/session')).json()).csrf;
  assert.equal((await (await request('/api/orders')).json())[0].status,'paid');
  const lastLink=await (await request(`/api/orders/${o.id}/download-links/proposal`,'POST',{})).json();assert.equal((await request(lastLink.url)).status,200);
  for(let i=0;i<5;i++)assert.equal((await request('/api/inquiries','POST',{email:'test@example.test',category:'other',body:'test'})).status,201);
  assert.equal((await request('/api/inquiries','POST',{email:'test@example.test',category:'other',body:'test'})).status,429);
 }finally{if(server?.listening)await stop();rmSync(root,{recursive:true,force:true});}
});
