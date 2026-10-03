import {test,expect} from '@playwright/test';

test('Googleログイン案内と、ログアウト時の購入履歴の消去',async({page})=>{
 let loggedIn=true;
 await page.route('**/api/**',async route=>{
  const path=new URL(route.request().url()).pathname;
  const session={role:'guest',csrf:'test-csrf',termsVersion:'test',googleEnabled:true,loginRequired:true,storage:'starserver',sessionMode:'memory',user:loggedIn?{id:'buyer',name:'購入者テスト'}:null};
  let body:unknown;
  if(path==='/api/auth/logout'){loggedIn=false;body={...session,user:null};}
  else if(path==='/api/session')body=session;
  else if(path==='/api/orders')body={items:loggedIn?[{id:'TEST-ORDER',date:new Date().toISOString(),total:1200,status:'paid',lines:[],items:[]}]:[],nextCursor:null};
  else if(path==='/api/products')body=[];
  else if(path==='/api/favorites')body=[];
  else body={};
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(body)});
 });
 await page.goto('/#history');
 await expect(page.getByText('購入者テスト',{exact:true})).toBeVisible();
 await expect(page.getByText('TEST-ORDER',{exact:false})).toBeVisible();
 await page.getByRole('button',{name:'ログアウト',exact:true}).click();
 await expect(page.getByText('TEST-ORDER',{exact:false})).toHaveCount(0);
 await expect(page.getByText('購入・注文履歴の確認にはGoogleでログインしてください。')).toBeVisible();
 await expect(page.getByRole('link',{name:'Googleでログイン'}).last()).toHaveAttribute('href','/api/auth/google/start?returnTo=%2F%23history');
});
