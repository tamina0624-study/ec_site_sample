import {test,expect,type APIRequestContext,type Playwright} from '@playwright/test';
async function client(playwright:Playwright){const context=await playwright.request.newContext({baseURL:'http://127.0.0.1:5173'});let csrf=(await (await context.get('/api/session')).json()).csrf;
 return {context,async send(path:string,data:unknown={},method='POST',key?:string){const response=await context.fetch(path,{method,headers:{'X-CSRF-Token':csrf,...(key?{'Idempotency-Key':key}:{})},data});if(path.endsWith('/login')&&response.ok())csrf=(await response.json()).csrf;return response;}};
}
async function quote(c:Awaited<ReturnType<typeof client>>,items=['proposal'],coupon=''){const r=await c.send('/api/quotes',{items,coupon});expect(r.status()).toBe(200);return r.json();}
const orderData=(q:{id:string;terms:string},result='success')=>({quoteId:q.id,termsVersion:q.terms,accepted:true,result});
async function download(c:Awaited<ReturnType<typeof client>>,id:string,pid='proposal'){return c.send(`/api/orders/${id}/download-links/${pid}`);}

test('サーバー価格・同意・CSRF・重複防止・所有者・リセット',async({playwright})=>{
 const owner=await client(playwright),other=await client(playwright);
 try{
  const q=await quote(owner,['proposal','proposal']);expect(q.total).toBe(1200);const key=crypto.randomUUID(),data={...orderData(q),total:1};
  expect((await owner.context.post('/api/orders',{data,headers:{'Idempotency-Key':key}})).status()).toBe(403);
  expect((await owner.send('/api/orders',{...data,accepted:false},'POST',key)).status()).toBe(400);
  const first=await owner.send('/api/orders',data,'POST',key);expect(first.status()).toBe(201);const order=await first.json();expect(order.total).toBe(1200);expect(order.items).toEqual(['proposal']);
  expect((await (await owner.send('/api/orders',data,'POST',key)).json()).id).toBe(order.id);
  expect((await owner.send('/api/orders',{...data,result:'failure'},'POST',key)).status()).toBe(409);
  expect((await download(other,order.id)).status()).toBe(404);
  const link=await (await download(owner,order.id)).json();expect((await other.context.get(link.url)).status()).toBe(404);expect((await owner.context.get(link.url)).status()).toBe(200);
  expect((await owner.context.get('/private/downloads/proposal.pptx')).status()).toBe(403);
  expect((await owner.context.get('/downloads/proposal.pptx')).headers()['content-type']).not.toContain('presentationml');
  const failureQuote=await quote(owner);expect((await owner.send('/api/orders',orderData(failureQuote,'failure'),'POST',crypto.randomUUID())).status()).toBe(402);
  expect((await owner.send('/api/quotes',{items:['../secret']})).status()).toBe(400);
  await owner.send('/api/orders',{},'DELETE');expect((await owner.context.get(link.url)).status()).toBe(404);
 }finally{await owner.context.dispose();await other.context.dispose();}
});

test('管理権限・価格変更・クーポン・セット・版固定・模擬返金・通知・問い合わせ',async({playwright})=>{
 const owner=await client(playwright),admin=await client(playwright),editor=await client(playwright);
 const suffix=crypto.randomUUID().slice(0,8),productId='test-'+suffix,bundleId='bundle-'+suffix;
 try{
  expect((await owner.context.get('/api/admin/orders')).status()).toBe(403);
  expect((await admin.send('/api/admin/login',{password:'local-test-admin-only'})).status()).toBe(200);
  expect((await editor.send('/api/admin/login',{role:'editor',password:'local-test-editor-only'})).status()).toBe(200);
  expect((await editor.context.get('/api/admin/orders')).status()).toBe(403);
  const product={id:productId,name:'検証商品',category:'テスト',description:'ローカル検証',price:1000,status:'draft',bundle:[]};
  const created=await admin.send('/api/admin/products',product);expect(created.status()).toBe(200);let p=await created.json();
  expect((await admin.send(`/api/admin/products/${productId}/file`,{revision:p.revision,base64:Buffer.from('bad').toString('base64')})).status()).toBe(400);
  const {readFileSync}=await import('node:fs');const original=readFileSync('private/downloads/proposal.pptx');
  const uploaded=await admin.send(`/api/admin/products/${productId}/file`,{revision:p.revision,base64:original.toString('base64')});expect(uploaded.status()).toBe(200);p=await uploaded.json();
  p=await (await admin.send(`/api/admin/products/${productId}`,{...p,status:'published'},'PATCH')).json();
  const stale=await quote(owner,[productId]);p=await (await admin.send(`/api/admin/products/${productId}`,{...p,price:1500},'PATCH')).json();
  expect((await owner.send('/api/orders',orderData(stale),'POST',crypto.randomUUID())).status()).toBe(409);
  const code='TEST-'+suffix.toUpperCase();expect((await admin.send('/api/admin/coupons',{code,percent:20,limit:1,expires:Date.now()+3600000})).status()).toBe(201);
  const q=await quote(owner,[productId],code);expect(q.total).toBe(1200);const ordered=await owner.send('/api/orders',orderData(q),'POST',crypto.randomUUID());expect(ordered.status()).toBe(201);const o=await ordered.json();
  expect((await owner.send('/api/quotes',{items:[productId],coupon:code})).status()).toBe(409);
  const savedLink=await (await download(owner,o.id,productId)).json();
  const replacement=readFileSync('private/downloads/sales.pptx');p=await (await admin.send(`/api/admin/products/${productId}/file`,{revision:p.revision,base64:replacement.toString('base64')})).json();
  expect(await (await owner.context.get(savedLink.url)).body()).toEqual(original);
  const bundle=await admin.send('/api/admin/products',{...product,id:bundleId,name:'検証セット',price:800,status:'published',bundle:[productId,'research']});expect(bundle.status()).toBe(200);
  const bq=await quote(owner,[bundleId]);expect(bq.total).toBe(800);expect(bq.lines.map((i:{product_id:string})=>i.product_id)).toEqual([productId,'research']);
  expect((await admin.send(`/api/admin/orders/${o.id}/refund`,{reason:'動作確認'})).status()).toBe(200);
  expect((await admin.send(`/api/admin/orders/${o.id}/refund`,{reason:'再送'})).status()).toBe(200);
  expect((await owner.context.get(savedLink.url)).status()).toBe(404);expect((await download(owner,o.id,productId)).status()).toBe(404);
  const inquiry=await owner.send('/api/inquiries',{email:'demo@example.test',category:'download',body:'取得できません',orderId:o.id});expect(inquiry.status()).toBe(201);const inquiryId=(await inquiry.json()).id;
  expect((await admin.send(`/api/admin/inquiries/${inquiryId}`,{status:'closed'},'PATCH')).status()).toBe(200);
  await admin.send('/api/admin/notifications/run',{});
  const notices=await (await admin.context.get('/api/admin/notifications')).json();expect(notices.filter((n:{id:string})=>n.id.includes(o.id))).toHaveLength(2);expect(notices.some((n:{body:string;status:string})=>n.body.includes(o.id)&&n.status==='saved')).toBe(true);
  const audits=await (await admin.context.get('/api/admin/audit')).json();expect(audits.filter((a:{action:string;target:string})=>a.action==='refund'&&a.target===o.id)).toHaveLength(1);
  await owner.send('/api/favorites',{productId});expect(await (await owner.context.get('/api/favorites')).json()).toContain(productId);
  await owner.send('/api/favorites/'+productId,{},'DELETE');expect(await (await owner.context.get('/api/favorites')).json()).not.toContain(productId);
  // 他のブラウザテストの商品件数に影響させない。
  await admin.send(`/api/admin/products/${productId}`,{...p,status:'stopped'},'PATCH');const b=await bundle.json();await admin.send(`/api/admin/products/${bundleId}`,{...b,status:'stopped'},'PATCH');
 }finally{await owner.context.dispose();await admin.context.dispose();await editor.context.dispose();}
});
