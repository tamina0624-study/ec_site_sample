import {DatabaseSync} from 'node:sqlite';

// Only identity/order records are durable. Cookies, MFA challenges, quotations,
// reauthentication grants and download links disappear when this process stops.
export function withMemoryState(store,{now=()=>Date.now()}={}) {
 const memory=new DatabaseSync(':memory:');
 memory.exec(`CREATE TABLE local_sessions(id TEXT PRIMARY KEY,role TEXT NOT NULL,expires INTEGER NOT NULL,csrf TEXT NOT NULL);
 CREATE TABLE download_tokens(token_hash TEXT PRIMARY KEY,session_id TEXT NOT NULL,order_id TEXT NOT NULL,product_id TEXT NOT NULL,expires INTEGER NOT NULL);`);
 const ephemeral=new Map(),kinds=new Set(['quotes','reauth','mfaPending']);
 const users=new Map();
 const original={...store},db={
  prepare(sql){return /\b(local_sessions|download_tokens)\b/.test(sql)?memory.prepare(sql):original.db.prepare(sql);},
  close(){users.clear();ephemeral.clear();memory.close();original.db.close();},
 };
 const get=(kind,id)=>{
  if(!kinds.has(kind))return original.get(kind,id);
  const key=kind+'\0'+id,state=original.pending?.();
  return structuredClone(state?.volatile?.has(key)?state.volatile.get(key):ephemeral.get(key)||null);
 };
 const put=(kind,id,value)=>{
  if(!kinds.has(kind))return original.put(kind,id,value);
  const key=kind+'\0'+id,state=original.pending?.();
  if(state){state.volatile??=new Map();state.volatile.set(key,structuredClone(value));original.afterCommit(()=>ephemeral.set(key,structuredClone(value)));}
  else ephemeral.set(key,structuredClone(value));
 };
 const remove=(kind,id)=>{
  if(!kinds.has(kind))return original.remove(kind,id);
  const key=kind+'\0'+id,state=original.pending?.();
  if(state){state.volatile??=new Map();state.volatile.set(key,null);original.afterCommit(()=>ephemeral.delete(key));}else ephemeral.delete(key);
 };
 const sweep=()=>{
  for(const row of memory.prepare('SELECT id FROM local_sessions WHERE expires<=?').all(now()))users.delete(row.id);
  memory.prepare('DELETE FROM local_sessions WHERE expires<=?').run(now());
  memory.prepare('DELETE FROM download_tokens WHERE expires<=?').run(now());
  for(const [key,value]of ephemeral)if((value.expires??value.expiresAt??Infinity)<=now())ephemeral.delete(key);
 };
 return {...store,db,get,put,remove,users,sweep,memorySessions:true};
}
