import test from 'node:test';
import assert from 'node:assert/strict';
import {createGoogleAuth} from '../server/google-auth.mjs';
import {googleFixture} from './support/google-fixture.mjs';

test('Google OAuth: 署名・state・nonce・PKCE・固定IDと一度だけ使えるcallback',async()=>{
 const f=googleFixture(),start=f.start();
 assert.equal(start.searchParams.get('code_challenge_method'),'S256');assert.equal(start.searchParams.get('scope'),'openid profile');
 const params=new URLSearchParams({state:start.searchParams.get('state'),code:'authorization-code'});
 const result=await f.auth.finish(params,'session-one');assert.equal(result.user.name,'テスト購入者');assert.match(result.user.id,/^[a-f0-9]{64}$/);assert.equal(result.returnTo,'/#history');
 assert.equal(f.exchangeBody.get('code'),'authorization-code');assert.equal(f.exchangeBody.get('redirect_uri'),'http://localhost:5173/api/auth/google/callback');assert.ok(f.exchangeBody.get('code_verifier'));
 await assert.rejects(f.auth.finish(params,'session-one'),{code:'GOOGLE_AUTH_FAILED'});
 const second=f.start('new-session');assert.equal((await f.auth.finish(new URLSearchParams({state:second.searchParams.get('state'),code:'other-code'}),'new-session')).user.id,result.user.id);
});

test('Google OAuth: 別ブラウザ・不正署名・発行元・audience・期限・nonceを拒否',async()=>{
 const f=googleFixture();
 const start=f.start();await assert.rejects(f.auth.finish(new URLSearchParams({state:start.searchParams.get('state'),code:'code'}),'different-session'),{code:'GOOGLE_AUTH_FAILED'});
 for(const claims of [{iss:'https://attacker.test'},{aud:'other-client'},{exp:0},{iat:Math.floor(Date.now()/1000)+3600},{nonce:'wrong'},{sub:''},{azp:'other-client'},{aud:['test-client','other-client']}]){
  f.setClaims(claims);const url=f.start();await assert.rejects(f.auth.finish(new URLSearchParams({state:url.searchParams.get('state'),code:'code'}),'session-one'),{code:'GOOGLE_AUTH_FAILED'});
 }
 f.setClaims({});f.setToken('e30.e30.forged');const forged=f.start();await assert.rejects(f.auth.finish(new URLSearchParams({state:forged.searchParams.get('state'),code:'code'}),'session-one'),{code:'GOOGLE_AUTH_FAILED'});
});

test('Google OAuth: 10分期限と安全な設定',async()=>{
 let clock=Date.now();const f=googleFixture({now:()=>clock}),url=f.start();clock+=600001;
 await assert.rejects(f.auth.finish(new URLSearchParams({state:url.searchParams.get('state'),code:'code'}),'session-one'),{code:'GOOGLE_AUTH_FAILED'});
 assert.throws(()=>createGoogleAuth({clientId:'id',clientSecret:'secret',origin:'http://public.test'}));
 assert.throws(()=>createGoogleAuth({clientId:'id',clientSecret:'secret',origin:'https://public.test/path'}));
});
