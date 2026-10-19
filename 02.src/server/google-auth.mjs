import * as oidc from 'openid-client';

const ISSUER = new URL('https://accounts.google.com');

export function createGoogleAuth(env=process.env) {
 const clientId=env.GOOGLE_CLIENT_ID?.trim()||'';
 const clientSecret=env.GOOGLE_CLIENT_SECRET?.trim()||'';
 const redirectUri=env.GOOGLE_REDIRECT_URI?.trim()||'';
 const configured=Boolean(clientId&&clientSecret&&redirectUri);
 let configuration;
 const discover=()=>configuration??=oidc.discovery(ISSUER,clientId,clientSecret);
 return {
  configured,
  redirectUri,
  async begin(){
   if(!configured)throw new Error('Googleログインが設定されていません。');
   const verifier=oidc.randomPKCECodeVerifier();
   const state=oidc.randomState();
   const nonce=oidc.randomNonce();
   const challenge=await oidc.calculatePKCECodeChallenge(verifier);
   const config=await discover();
   const url=oidc.buildAuthorizationUrl(config,{redirect_uri:redirectUri,scope:'openid email profile',response_type:'code',code_challenge:challenge,code_challenge_method:'S256',state,nonce});
   return {url:url.href,state,nonce,verifier};
  },
  async authenticate(callbackUrl,checks){
   if(!configured)throw new Error('Googleログインが設定されていません。');
   const tokens=await oidc.authorizationCodeGrant(await discover(),callbackUrl,{expectedState:checks.state,expectedNonce:checks.nonce,pkceCodeVerifier:checks.verifier});
   const claims=tokens.claims();
   if(typeof claims?.sub!=='string'||!claims.sub||typeof claims.email!=='string'||claims.email_verified!==true)throw new Error('Googleアカウントの確認済みメールアドレスを取得できませんでした。');
   return {id:claims.sub,email:claims.email,name:typeof claims.name==='string'?claims.name.slice(0,200):claims.email};
  }
 };
}
