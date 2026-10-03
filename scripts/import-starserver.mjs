import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {openStore} from '../server/storage.mjs';
import {openRemoteStore} from '../server/remote-storage.mjs';

const dataDir=resolve(process.env.SHOP_DATA_DIR||'data'),fileDir=resolve(process.env.SHOP_FILE_DIR||'private/downloads');
if(existsSync(resolve(dataDir,'server.pid')))throw new Error('ローカルサーバーを停止し、server.pidがない状態で実行してください。');
// Initialize the local sample only when requested with administrator credentials.
if(!existsSync(resolve(dataDir,'shop.sqlite'))&&(!process.env.LOCAL_ADMIN_PASSWORD||!process.env.LOCAL_EDITOR_PASSWORD))throw new Error('初期登録にはLOCAL_ADMIN_PASSWORDとLOCAL_EDITOR_PASSWORDを指定してください。既存DBがあればその認証設定を引き継ぎます。');
const local=openStore(dataDir,fileDir),remote=openRemoteStore();
const volatile=new Set(['quotes','reauth','mfaPending','maintenance']);
try{
 if((await remote.db.prepare('SELECT COUNT(*) AS n FROM documents').get()).n||(await remote.db.prepare('SELECT COUNT(*) AS n FROM orders').get()).n)throw new Error('移行先は空のDBを指定してください。既存データを上書きしません。');
 const docs=local.db.prepare('SELECT kind,id,value FROM documents').all().filter(d=>!volatile.has(d.kind));
 for(const version of local.list('versions')){
  const checksum=await remote.snapshot(readFileSync(resolve(fileDir,'versions',version.id+'.pptx')));
  if(checksum!==version.id)throw new Error('ファイル版の整合性を確認できません。');
  if(version.preview?.status==='ready')for(let i=0;i<version.preview.pages;i++){
   const path=resolve(dataDir,'previews',version.id,i+'.png');if(!existsSync(path))throw new Error('画像プレビューがありません。ローカルで再生成してから移行してください。');
   await remote.writePreview(version.id,i,readFileSync(path));
  }
 }
 const tables={sessions:['id'],orders:['id','session_id','date','total','request_key','request_body'],items:['order_id','product_id','name','price'],favorites:['session_id','product_id'],metrics:['day','event','count']};
 await remote.tx(async()=>{
  if((await remote.db.prepare('SELECT COUNT(*) AS n FROM documents').get()).n||(await remote.db.prepare('SELECT COUNT(*) AS n FROM orders').get()).n)throw new Error('移行先が変更されました。');
  for(const [table,columns]of Object.entries(tables))for(const row of local.db.prepare(`SELECT * FROM ${table}`).all())await remote.db.prepare(`INSERT INTO ${table}(${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(c=>row[c]));
  for(const d of docs)await remote.put(d.kind,d.id,JSON.parse(d.value));
 });
 console.log('StarServerへ商品・注文・認証設定・ファイル版を登録しました。ブラウザセッションと取得リンクは移行していません。');
}finally{local.db.close();remote.db.close();}
