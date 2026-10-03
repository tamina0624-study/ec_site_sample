import {randomBytes,createHash,createPublicKey,verify} from 'node:crypto';

const b64=bytes=>Buffer.from(bytes).toString('base64url');
const authError=()=>Object.assign(new Error('Google認証を確認できませんでした。再度ログインしてください。'),{status:401,code:'GOOGLE_AUTH_FAILED'});

export function createGoogleAuth({clientId=process.env.GOOGLE_CLIENT_ID,clientSecret=process.env.GOOGLE_CLIENT_SECRET,origin=process.env.SITE_URL,fetchImpl=fetch,now=()=>Date.now()}={}) {
 if(!clientId&&!clientSecret)return null;
 if(!clientId||!clientSecret||!origin)throw new Error('Google認証にはGOOGLE_CLIENT_ID、GOOGLE_CLIENT_SECRET、SITE_URLが必要です。');
 const site=new URL(origin);
 if(site.origin!==origin.replace(/\/$/,'')||!(site.protocol==='https:'||(site.protocol==='http:'&&['localhost','127.0.0.1'].includes(site.hostname))))throw new Error('SITE_URLにはHTTPS origin（ローカル確認はHTTP localhost）を指定してください。');
 const redirectUri=site.origin+'/api/auth/google/callback';
 const pending=new Map();let jwks=null,jwksUntil=0;
 async function keys(force=false){
  if(force||!jwks||jwksUntil<=now()){
   const r=await fetchImpl('https://www.googleapis.com/oauth2/v3/certs',{redirect:'error',signal:AbortSignal.timeout(10000)});
   if(!r.ok)throw authError();jwks=await r.json();jwksUntil=now()+3600000;
  }
  return jwks.keys;
 }
 async function validate(token,nonce){
  if(typeof token!=='string'||token.length>16384)throw authError();
  const parts=token.split('.');if(parts.length!==3)throw authError();
  let header,claims;try{header=JSON.parse(Buffer.from(parts[0],'base64url'));claims=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{throw authError();}
  if(header.alg!=='RS256'||typeof header.kid!=='string')throw authError();
  let key=(await keys()).find(k=>k.kid===header.kid&&k.kty==='RSA');
  if(!key)key=(await keys(true)).find(k=>k.kid===header.kid&&k.kty==='RSA');
  if(!key||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw authError();
  const seconds=Math.floor(now()/1000),aud=Array.isArray(claims.aud)?claims.aud:[claims.aud];
  if(!['https://accounts.google.com','accounts.google.com'].includes(claims.iss)||!aud.includes(clientId)||(claims.azp&&claims.azp!==clientId)||(aud.length>1&&claims.azp!==clientId)||!Number.isFinite(claims.exp)||claims.exp<=seconds||!Number.isFinite(claims.iat)||claims.iat>seconds+60||typeof claims.sub!=='string'||!claims.sub.length||claims.sub.length>255||claims.nonce!==nonce)throw authError();
  return {id:createHash('sha256').update('google:'+claims.sub).digest('hex'),provider:'google',sub:claims.sub,name:typeof claims.name==='string'?claims.name.slice(0,100):'Googleユーザー'};
 }
 function sweep(){for(const [id,p]of pending)if(p.expires<=now())pending.delete(id);}
 return {origin:site.origin,redirectUri,sweep,
  start(sessionToken,returnTo='/#history'){
   sweep();if(pending.size>=10000)throw Object.assign(new Error('認証が混雑しています。後でお試しください。'),{status:429,code:'AUTH_BUSY'});
   const state=b64(randomBytes(32)),nonce=b64(randomBytes(32)),verifier=b64(randomBytes(32));
   pending.set(state,{sessionToken,nonce,verifier,expires:now()+600000,returnTo});
   const url=new URL('https://accounts.google.com/o/oauth2/v2/auth');
   Object.entries({client_id:clientId,redirect_uri:redirectUri,response_type:'code',scope:'openid profile',state,nonce,code_challenge:b64(createHash('sha256').update(verifier).digest()),code_challenge_method:'S256',prompt:'select_account'}).forEach(([k,v])=>url.searchParams.set(k,v));
   return url.href;
  },
  async finish(params,sessionToken){
   const state=params.get('state'),p=pending.get(state);pending.delete(state);
   if(!p||p.expires<=now()||p.sessionToken!==sessionToken||params.has('error')||!params.get('code'))throw authError();
   const r=await fetchImpl('https://oauth2.googleapis.com/token',{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({code:params.get('code'),client_id:clientId,client_secret:clientSecret,redirect_uri:redirectUri,grant_type:'authorization_code',code_verifier:p.verifier})});
   if(!r.ok)throw authError();const result=await r.json();return {user:await validate(result.id_token,p.nonce),returnTo:p.returnTo};
  },
 };
}
