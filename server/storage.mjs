import { DatabaseSync } from 'node:sqlite';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import JSZip from 'jszip';

export {TERMS_VERSION} from './legal.mjs';
export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const hash = value => createHash('sha256').update(value).digest('hex');
export function passwordHash(password, salt) {return scryptSync(password, salt, 64).toString('hex');}
export function matchesPassword(password, record) {
 if(typeof password !== 'string' || password.length > 200) return false;
 return timingSafeEqual(Buffer.from(passwordHash(password,record.salt),'hex'), Buffer.from(record.digest,'hex'));
}
export async function inspectPptx(bytes) {
 if(bytes.length<4 || bytes.length > MAX_FILE_SIZE || bytes.readUInt16LE(0)!==0x4b50) throw new Error('50MB以下のPPTXを選んでください。');
 const zip=await JSZip.loadAsync(bytes);
 const files=Object.values(zip.files);
 if(files.length>1500 || files.reduce((sum,f)=>sum+(f._data?.uncompressedSize || 0),0)>100*1024*1024) throw new Error('展開サイズまたはファイル数の上限を超えています。');
 if(files.some(f=>(f.unsafeOriginalName||f.name).split('/').includes('..') || f.name.startsWith('/') || (!f.dir && /vbaProject|embeddings\//i.test(f.name)))) throw new Error('マクロ・埋め込みファイルは登録できません。');
 if(!zip.file('[Content_Types].xml') || !zip.file('ppt/presentation.xml')) throw new Error('PowerPoint形式ではありません。');
 const presentation=await zip.file('ppt/presentation.xml').async('string');
 if(!presentation.includes('presentationml')) throw new Error('PowerPoint形式ではありません。');
 const pages=files.filter(f=>/^ppt\/slides\/slide\d+\.xml$/.test(f.name)).sort((a,b)=>Number(a.name.match(/\d+/)[0])-Number(b.name.match(/\d+/)[0]));
 if(!pages.length || pages.length>200) throw new Error('1〜200ページのPPTXを選んでください。');
 const texts=[];
 for(const f of pages.slice(0,12)) {
  const xml=await f.async('string');
  texts.push([...xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g)].map(m=>m[1].replace(/<[^>]*>/g,'')).join(' ').slice(0,180));
 }
 return {pages:pages.length,texts};
}
export function openStore(dataDir, fileDir) {
 mkdirSync(dataDir,{recursive:true,mode:0o700});mkdirSync(resolve(fileDir,'versions'),{recursive:true});
 const db=new DatabaseSync(resolve(dataDir,'shop.sqlite'));
 db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS sessions(id TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES sessions(id),date TEXT NOT NULL,total INTEGER NOT NULL,request_key TEXT NOT NULL,request_body TEXT NOT NULL,UNIQUE(session_id,request_key));
 CREATE TABLE IF NOT EXISTS items(order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,product_id TEXT NOT NULL,name TEXT NOT NULL,price INTEGER NOT NULL,PRIMARY KEY(order_id,product_id));
 CREATE TABLE IF NOT EXISTS documents(kind TEXT NOT NULL,id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(kind,id));
 CREATE TABLE IF NOT EXISTS local_sessions(id TEXT PRIMARY KEY REFERENCES sessions(id),role TEXT NOT NULL,expires INTEGER NOT NULL,csrf TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS favorites(session_id TEXT NOT NULL REFERENCES sessions(id),product_id TEXT NOT NULL,PRIMARY KEY(session_id,product_id));
 CREATE TABLE IF NOT EXISTS download_tokens(token_hash TEXT PRIMARY KEY,session_id TEXT NOT NULL,order_id TEXT NOT NULL,product_id TEXT NOT NULL,expires INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS metrics(day TEXT NOT NULL,event TEXT NOT NULL,count INTEGER NOT NULL,PRIMARY KEY(day,event));`);
 const get=(kind,id)=>{const row=db.prepare('SELECT value FROM documents WHERE kind=? AND id=?').get(kind,id);return row?JSON.parse(row.value):null;};
 const list=kind=>db.prepare('SELECT value FROM documents WHERE kind=? ORDER BY rowid').all(kind).map(r=>JSON.parse(r.value));
 const put=(kind,id,value)=>db.prepare('INSERT INTO documents VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET value=excluded.value').run(kind,id,JSON.stringify(value));
 const remove=(kind,id)=>db.prepare('DELETE FROM documents WHERE kind=? AND id=?').run(kind,id);
 const tx=fn=>{db.exec('BEGIN IMMEDIATE');try{const result=fn();db.exec('COMMIT');return result;}catch(e){db.exec('ROLLBACK');throw e;}};
 const snapshot=(bytes)=>{const checksum=hash(bytes);const path=resolve(fileDir,'versions',`${checksum}.pptx`);if(!existsSync(path))writeFileSync(path,bytes,{flag:'wx',mode:0o600});return checksum;};
 const initial=JSON.parse(readFileSync(new URL('../src/products.json',import.meta.url)));
 for(const p of initial)if(!get('products',p.id)){
  const bytes=readFileSync(resolve(fileDir,`${p.id}.pptx`));const checksum=snapshot(bytes);
  put('versions',checksum,{id:checksum,size:bytes.length,pages:4,texts:[p.name,...p.sections],created:new Date().toISOString()});
  put('products',p.id,{...p,status:'published',revision:1,version:checksum,created:new Date().toISOString(),compatible:'PowerPointなどのPPTX対応ソフト',bundle:[]});
 }
 // 既存ローカル注文のファイルも現在のファイルで固定する。実入金の証明にはしない。
 for(const row of db.prepare('SELECT * FROM orders').all())if(!get('orderMeta',row.id)){
  const lines=db.prepare('SELECT * FROM items WHERE order_id=?').all(row.id).map(i=>({...i,version:get('products',i.product_id)?.version}));
  put('orderMeta',row.id,{status:'paid',terms:'legacy-demo',lines,discount:0});
 }
 for(const role of ['admin','editor'])if(!get('credentials',role)){
  const password=process.env[role==='admin'?'LOCAL_ADMIN_PASSWORD':'LOCAL_EDITOR_PASSWORD'] || randomBytes(24).toString('base64url');
  const salt=randomBytes(16).toString('hex');put('credentials',role,{salt,digest:passwordHash(password,salt)});
  if(!process.env[role==='admin'?'LOCAL_ADMIN_PASSWORD':'LOCAL_EDITOR_PASSWORD'])writeFileSync(resolve(dataDir,`${role}-password.txt`),password+'\n',{mode:0o600});
 }
 return {db,get,list,put,remove,tx,snapshot};
}
