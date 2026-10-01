import { DatabaseSync, backup } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createHash } from 'node:crypto';
const dataDir=resolve(process.env.SHOP_DATA_DIR||'data');
const filesDir=resolve(process.env.SHOP_FILE_DIR||'private/downloads');
const backupsDir=resolve(process.env.SHOP_BACKUP_DIR||'backups');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const command=process.argv[2];
async function saveBackup(){
 if(!existsSync(resolve(dataDir,'shop.sqlite')))throw new Error('先にnpm run devでデータベースを作成してください。');
 const name=`backup-${new Date().toISOString().replace(/[:.]/g,'-')}-${process.pid}`;
 const target=resolve(backupsDir,name);mkdirSync(resolve(target,'versions'),{recursive:true,mode:0o700});
 const db=new DatabaseSync(resolve(dataDir,'shop.sqlite'));
 try{await backup(db,resolve(target,'shop.sqlite'));}finally{db.close();}
 chmodSync(resolve(target,'shop.sqlite'),0o600);
 const entries=[];for(const filename of readdirSync(resolve(filesDir,'versions'))){if(!/^[a-f0-9]{64}\.pptx$/.test(filename))continue;const bytes=readFileSync(resolve(filesDir,'versions',filename));if(digest(bytes)!==filename.slice(0,-5))throw new Error('ファイルの整合性を確認できません。');copyFileSync(resolve(filesDir,'versions',filename),resolve(target,'versions',filename));entries.push({name:filename,checksum:digest(bytes)});}
 writeFileSync(resolve(target,'manifest.json'),JSON.stringify({version:1,date:new Date().toISOString(),database:digest(readFileSync(resolve(target,'shop.sqlite'))),files:entries},null,2),{mode:0o600});
 console.log(`バックアップ：${target}`);return target;
}
async function restoreBackup(){
 const supplied=process.argv[3];if(!supplied)throw new Error('npm run restore -- バックアップ名 を指定してください。');
 const target=resolve(backupsDir,basename(supplied));
 const pidFile=resolve(dataDir,'server.pid');if(existsSync(pidFile)){const pid=Number(readFileSync(pidFile,'utf8'));let alive=false;try{process.kill(pid,0);alive=true;}catch{}if(alive)throw new Error('先に開発・プレビューサーバーを停止してください。');}
 const m=JSON.parse(readFileSync(resolve(target,'manifest.json'),'utf8'));if(m.version!==1||!Array.isArray(m.files))throw new Error('バックアップ形式が不正です。');
 const dbBytes=readFileSync(resolve(target,'shop.sqlite'));if(digest(dbBytes)!==m.database)throw new Error('データベースのチェックサムが一致しません。');
 for(const file of m.files){if(!/^[a-f0-9]{64}\.pptx$/.test(file.name)||digest(readFileSync(resolve(target,'versions',file.name)))!==file.checksum||file.checksum!==file.name.slice(0,-5))throw new Error('ファイルのチェックサムが一致しません。');}
 const verify=new DatabaseSync(resolve(target,'shop.sqlite'),{readOnly:true});
 try{if(verify.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('SQLite整合性検査に失敗しました。');if(verify.prepare('PRAGMA foreign_key_check').all().length)throw new Error('外部キーが不正です。');const names=new Set(m.files.map(f=>f.name));for(const row of verify.prepare("SELECT value FROM documents WHERE kind='products'").all()){const p=JSON.parse(row.value);if(p.version&&!names.has(p.version+'.pptx'))throw new Error('商品ファイルが欠落しています。');}for(const row of verify.prepare("SELECT value FROM documents WHERE kind='orderMeta'").all())for(const line of JSON.parse(row.value).lines||[])if(line.version&&!names.has(line.version+'.pptx'))throw new Error('購入済みファイルが欠落しています。');}finally{verify.close();}
 if(existsSync(resolve(dataDir,'shop.sqlite')))await saveBackup();
 mkdirSync(dataDir,{recursive:true,mode:0o700});mkdirSync(resolve(filesDir,'versions'),{recursive:true});
 for(const file of m.files)copyFileSync(resolve(target,'versions',file.name),resolve(filesDir,'versions',file.name));
 const staging=resolve(dataDir,'restore.sqlite');writeFileSync(staging,dbBytes,{mode:0o600});
 rmSync(resolve(dataDir,'shop.sqlite-wal'),{force:true});rmSync(resolve(dataDir,'shop.sqlite-shm'),{force:true});renameSync(staging,resolve(dataDir,'shop.sqlite'));rmSync(pidFile,{force:true});
 // 認証情報はバックアップ時点に戻る。パスワード再設定コマンドで再発行できる。
 console.log('復元完了。必要に応じ npm run admin:reset で管理パスワードを再発行してください。');
}
try{
 if(command==='backup')await saveBackup();
 else if(command==='restore')await restoreBackup();
 else if(command==='admin-reset'){
  const {randomBytes}=await import('node:crypto');const {passwordHash}=await import('../server/storage.mjs');
  const pidFile=resolve(dataDir,'server.pid');if(existsSync(pidFile)){let alive=false;try{process.kill(Number(readFileSync(pidFile,'utf8')),0);alive=true;}catch{}if(alive)throw new Error('サーバーを停止してください。');}
  const db=new DatabaseSync(resolve(dataDir,'shop.sqlite'));try{for(const role of ['admin','editor']){const password=randomBytes(24).toString('base64url'),salt=randomBytes(16).toString('hex');db.prepare("UPDATE documents SET value=? WHERE kind='credentials' AND id=?").run(JSON.stringify({salt,digest:passwordHash(password,salt)}),role);writeFileSync(resolve(dataDir,role+'-password.txt'),password+'\n',{mode:0o600});}db.prepare("UPDATE local_sessions SET role='guest'").run();}finally{db.close();}console.log('管理パスワードをdataディレクトリに再発行しました。');
 }else throw new Error('backup / restore / admin-reset を指定してください。');
}catch(e){console.error(e.message);process.exitCode=1;}
