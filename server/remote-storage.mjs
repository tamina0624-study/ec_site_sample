import {AsyncLocalStorage} from 'node:async_hooks';
import {hash} from './storage.mjs';

export function mysqlSql(sql) {
 return sql.replace(/INSERT OR IGNORE INTO/g,'INSERT IGNORE INTO')
  .replace(/ORDER BY rowid/g,'ORDER BY seq')
  .replace(/json_extract\(([^,]+),\s*('[^']+')\)/gi,'JSON_UNQUOTE(JSON_EXTRACT($1,$2))')
  .replace(/o\.id \|\| ' ' \|\| COALESCE\(JSON_UNQUOTE\(JSON_EXTRACT\(m\.value,'\$\.status'\)\),''\) \|\| ' ' \|\| COALESCE\(m\.value,''\)/g,"CONCAT(o.id,' ',COALESCE(JSON_UNQUOTE(JSON_EXTRACT(m.value,'$.status')),''),' ',COALESCE(m.value,''))")
  .replace(/ON CONFLICT\(kind,id\) DO UPDATE SET value=excluded.value/g,'ON DUPLICATE KEY UPDATE value=VALUES(value)')
  .replace(/ON CONFLICT\(day,event\) DO UPDATE SET count=count\+1/g,'ON DUPLICATE KEY UPDATE count=count+1');
}

// Each transaction buffers writes and commits them in one PHP/MySQL transaction.
// A global revision prevents a commit if anything changed during its reads.
export function openRemoteStore({url=process.env.STARSERVER_API_URL,key=process.env.STARSERVER_API_KEY,fetchImpl=fetch}={}) {
 const endpoint=new URL(url);
 if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw new Error('STARSERVER_API_URLには認証情報・クエリなしのHTTPS URLを指定してください。');
 if(typeof key!=='string'||key.length<32)throw new Error('STARSERVER_API_KEYは32文字以上必要です。');
 const context=new AsyncLocalStorage();
 async function request(action,body,raw=false) {
  const target=new URL(endpoint);target.searchParams.set('action',action);
  const response=await fetchImpl(target,{method:'POST',redirect:'error',signal:AbortSignal.timeout(raw?120000:30000),headers:{Authorization:`Bearer ${key}`,'Content-Type':raw?'application/octet-stream':'application/json'},body:raw?body:JSON.stringify(body)});
  if(!response.ok){const e=new Error('StarServerで処理できませんでした。');e.status=response.status===409?409:503;e.code=response.status===409?'STORAGE_CONFLICT':'STORAGE_UNAVAILABLE';throw e;}
  return raw&&action.startsWith('read-')?Buffer.from(await response.arrayBuffer()):response.json();
 }
 async function execute(sql,params,mode) {
  const operation={sql:mysqlSql(sql),params,mode},state=context.getStore();
  if(mode==='run'&&state){state.operations.push(operation);return {changes:1};}
  const result=(await request('sql',{operations:[operation]})).results[0];
  if(mode==='get'&&result)for(const field of ['total','price','count','n'])if(field in result)result[field]=Number(result[field]);
  if(mode==='all')for(const row of result)for(const field of ['total','price','count','n'])if(field in row)row[field]=Number(row[field]);
  return result;
 }
 const db={prepare:sql=>Object.fromEntries(['get','all','run'].map(mode=>[mode,(...params)=>execute(sql,params,mode)])),close(){}};
 const get=async(kind,id)=>{
  const state=context.getStore(),entry=kind+'\0'+id;
  if(state?.documents.has(entry))return structuredClone(state.documents.get(entry));
  const row=await db.prepare('SELECT value FROM documents WHERE kind=? AND id=?').get(kind,id);return row?JSON.parse(row.value):null;
 };
 const list=async kind=>(await db.prepare('SELECT value FROM documents WHERE kind=? ORDER BY rowid').all(kind)).map(row=>JSON.parse(row.value));
 const put=async(kind,id,value)=>{
  const state=context.getStore();if(state)state.documents.set(kind+'\0'+id,structuredClone(value));
  return db.prepare('INSERT INTO documents(kind,id,value) VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind,id,JSON.stringify(value));
 };
 const remove=async(kind,id)=>{const state=context.getStore();if(state)state.documents.set(kind+'\0'+id,null);return db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind,id);};
 const tx=async fn=>{
  if(context.getStore())throw new Error('Nested transactions are not supported');
  const {revision}=await request('revision',{});
  return context.run({operations:[],documents:new Map(),afterCommit:[]},async()=>{
   const state=context.getStore(),result=await fn();
   await request('sql',{operations:state.operations,expectedRevision:revision});
   for(const commit of state.afterCommit)commit();return result;
  });
 };
 const snapshot=async bytes=>{const checksum=hash(bytes);await request('write-file',Buffer.concat([Buffer.from(checksum+'\n'),bytes]),true);return checksum;};
 const readVersion=async checksum=>{
  if(!/^[a-f0-9]{64}$/.test(checksum))throw new Error('Invalid file version');
  const bytes=await request('read-file',Buffer.from(checksum),true);if(hash(bytes)!==checksum)throw new Error('File checksum mismatch');return bytes;
 };
 const readPreview=async(checksum,index)=>request('read-preview',Buffer.from(checksum+'\n'+index),true);
 const writePreview=async(checksum,index,bytes)=>request('write-preview',Buffer.concat([Buffer.from(checksum+'\n'+index+'\n'),bytes]),true);
 return {remote:true,db,get,list,put,remove,tx,snapshot,readVersion,readPreview,writePreview,request,
  afterCommit(fn){const state=context.getStore();if(state)state.afterCommit.push(fn);else fn();},
  pending:()=>context.getStore(),
 };
}
