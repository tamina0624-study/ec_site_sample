export type Product={id:string;name:string;category:string;price:number;subtitle:string;description:string;color:string;sections:string[];status:string;revision:number;version:string|null;fileSize:number;pageCount:number;previewCount:number;previewMode?:string;scanStatus?:string;compatible:string;bundle:string[];created:string};
export type Line={product_id:string;name:string;price:number;version:string};
export type Order={id:string;date:string;items:string[];lines:Line[];total:number;status:string;discount:number;receiptSnapshot?:{number:string;total:number;tax:number;net:number;taxRate:number};licenseSnapshot?:{version:string;terms:{title:string;body:string[]};refund:{title:string;body:string[]}}};
export type Quote={id:string;items:string[];total:number;subtotal:number;discount:number;expires:number;terms:string;lines:Line[]};
export type Page<T>={items:T[];nextCursor:string|null};
export type Purchases=Record<string,{orderId:string;name:string}>;
export class ApiError extends Error {constructor(message:string,public code:string,public requestId:string,public details?:unknown){super(`${message}${requestId?'（確認番号：'+requestId+'）':''}`);}}
export type Session={role:string;csrf:string;termsVersion:string;user?:{id:string;name:string}|null;googleEnabled?:boolean;loginRequired?:boolean;storage?:'local'|'starserver';sessionMode?:'memory'|'persistent'};
let session:Session|null=null;
let loading:Promise<Session>|null=null;
export async function initialize(){
 if(!loading)loading=fetch('/api/session').then(async r=>{if(!r.ok)throw new Error('APIに接続できません。npm run devで起動してください。');session=await r.json();return session!;}).catch(e=>{loading=null;throw e;});
 return loading;
}
export async function api<T>(path:string,method='GET',data?:unknown,key?:string):Promise<T>{
 const s=await initialize();
 const r=await fetch(path,{method,headers:{'Content-Type':'application/json','X-CSRF-Token':session?.csrf||s.csrf,...(key?{'Idempotency-Key':key}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
 const result=await r.json();
 if(!r.ok){
  if(result.code==='SESSION_EXPIRED'){
   session=null;loading=null;await initialize();window.dispatchEvent(new Event('slide-session-expired'));
  }
  throw new ApiError(result.message||'処理に失敗しました。',result.code||'UNKNOWN_ERROR',result.requestId||'',result.details);
 }
 if(result.csrf){session={...session!,...result};loading=Promise.resolve(session!);}
 return result;
}
export function metric(event:string){void api('/api/metrics','POST',{event}).catch(()=>{});}
