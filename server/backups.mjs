import {DatabaseSync,backup} from 'node:sqlite';
import {mkdirSync,readFileSync,writeFileSync,existsSync,readdirSync,copyFileSync,chmodSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
export async function saveBackup({dataDir,fileDir,backupsDir,automatic=false,now=Date.now()}){
 if(!existsSync(resolve(dataDir,'shop.sqlite')))throw new Error('先にnpm run devでデータベースを作成してください。');
 const name=`${automatic?'auto-':''}backup-${new Date(now).toISOString().replace(/[:.]/g,'-')}-${randomUUID().slice(0,8)}`;
 const target=resolve(backupsDir,name);mkdirSync(resolve(target,'versions'),{recursive:true,mode:0o700});
 try{
  const db=new DatabaseSync(resolve(dataDir,'shop.sqlite'));try{await backup(db,resolve(target,'shop.sqlite'));}finally{db.close();}chmodSync(resolve(target,'shop.sqlite'),0o600);
  const entries=[];for(const filename of readdirSync(resolve(fileDir,'versions'))){if(!/^[a-f0-9]{64}\.pptx$/.test(filename))continue;const bytes=readFileSync(resolve(fileDir,'versions',filename));if(digest(bytes)!==filename.slice(0,-5))throw new Error('ファイルの整合性を確認できません。');copyFileSync(resolve(fileDir,'versions',filename),resolve(target,'versions',filename));entries.push({name:filename,checksum:digest(bytes)});}
  writeFileSync(resolve(target,'manifest.json'),JSON.stringify({version:1,automatic,date:new Date(now).toISOString(),database:digest(readFileSync(resolve(target,'shop.sqlite'))),files:entries},null,2),{mode:0o600});return {name,path:target,date:new Date(now).toISOString()};
 }catch(e){rmSync(target,{recursive:true,force:true});throw e;}
}
export function pruneAutomaticBackups(backupsDir,keep){
 const candidates=readdirSync(backupsDir).filter(name=>/^auto-backup-[\dTZ-]+-[a-f0-9]{8}$/.test(name)).filter(name=>{try{return JSON.parse(readFileSync(resolve(backupsDir,name,'manifest.json'))).automatic===true;}catch{return false;}}).sort().reverse();
 for(const name of candidates.slice(keep))rmSync(resolve(backupsDir,name),{recursive:true,force:true});
}

export function verifyBackup(target){
 const manifest=JSON.parse(readFileSync(resolve(target,'manifest.json'),'utf8'));
 if(manifest.version!==1||!Array.isArray(manifest.files)||typeof manifest.database!=='string')throw new Error('バックアップ形式が不正です。');
 if(digest(readFileSync(resolve(target,'shop.sqlite')))!==manifest.database)throw new Error('データベースのチェックサムが一致しません。');
 const names=new Set();for(const file of manifest.files){if(!/^[a-f0-9]{64}\.pptx$/.test(file.name)||names.has(file.name)||digest(readFileSync(resolve(target,'versions',file.name)))!==file.checksum||file.checksum!==file.name.slice(0,-5))throw new Error('ファイルのチェックサムが一致しません。');names.add(file.name);}
 const db=new DatabaseSync(resolve(target,'shop.sqlite'),{readOnly:true});
 try{
  if(db.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('SQLite整合性検査に失敗しました。');if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('外部キーが不正です。');
  for(const row of db.prepare("SELECT value FROM documents WHERE kind='products'").all()){const p=JSON.parse(row.value);if(p.version&&!names.has(p.version+'.pptx'))throw new Error('商品ファイルが欠落しています。');}
  for(const row of db.prepare("SELECT value FROM documents WHERE kind='orderMeta'").all())for(const line of JSON.parse(row.value).lines||[])if(line.version&&!names.has(line.version+'.pptx'))throw new Error('購入済みファイルが欠落しています。');
  return {manifest,orders:db.prepare('SELECT COUNT(*) AS n FROM orders').get().n,files:names.size};
 }finally{db.close();}
}
