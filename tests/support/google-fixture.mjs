import assert from 'node:assert/strict';
import {generateKeyPairSync,sign} from 'node:crypto';
import {createGoogleAuth} from '../../server/google-auth.mjs';

export function googleFixture({now=()=>Date.now(),origin='http://localhost:5173'}={}){
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
 const jwk={...publicKey.export({format:'jwk'}),kid:'test-key',alg:'RS256',use:'sig'};
 let claims={},nonce='',tokenOverride=null,exchangeBody=null;
 const jwt=payload=>{
  const head=Buffer.from(JSON.stringify({alg:'RS256',kid:'test-key'})).toString('base64url');
  const body=Buffer.from(JSON.stringify(payload)).toString('base64url');
  return head+'.'+body+'.'+sign('RSA-SHA256',Buffer.from(head+'.'+body),privateKey).toString('base64url');
 };
 const fetchImpl=async(url,options)=>{
  if(url==='https://www.googleapis.com/oauth2/v3/certs')return Response.json({keys:[jwk]});
  assert.equal(url,'https://oauth2.googleapis.com/token');exchangeBody=options.body;
  const seconds=Math.floor(now()/1000);
  return Response.json({id_token:tokenOverride??jwt({iss:'https://accounts.google.com',aud:'test-client',sub:'buyer-one',name:'テスト購入者',iat:seconds,exp:seconds+3600,nonce,...claims})});
 };
 const auth=createGoogleAuth({clientId:'test-client',clientSecret:'test-secret',origin,now,fetchImpl});
 return {auth,jwt,start(session='session-one',returnTo='/#history'){
  const url=new URL(auth.start(session,returnTo));nonce=url.searchParams.get('nonce');return url;
 },setClaims(value){claims=value;},setToken(value){tokenOverride=value;},get exchangeBody(){return exchangeBody;}};
}
