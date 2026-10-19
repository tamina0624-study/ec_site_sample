import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, renameSync, rmSync, mkdtempSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import {tmpdir} from 'node:os';
import {saveBackup as writeBackup,verifyBackup} from '../server/backups.mjs';
const dataDir=resolve(process.env.SHOP_DATA_DIR||'data');
const filesDir=resolve(process.env.SHOP_FILE_DIR||'private/downloads');
const backupsDir=resolve(process.env.SHOP_BACKUP_DIR||'backups');
const command=process.argv[2];
async function saveBackup(){const result=await writeBackup({dataDir,fileDir:filesDir,backupsDir});console.log(`バックアップ：${result.path}`);return result.path;}
async function restoreBackup(){
 const supplied=process.argv[3];if(!supplied)throw new Error('npm run restore -- バックアップ名 を指定してください。');
 const target=resolve(backupsDir,basename(supplied));
 const pidFile=resolve(dataDir,'server.pid');if(existsSync(pidFile)){const pid=Number(readFileSync(pidFile,'utf8'));let alive=false;try{process.kill(pid,0);alive=true;}catch{}if(alive)throw new Error('先に開発・プレビューサーバーを停止してください。');}
 const {manifest:m}=verifyBackup(target);const dbBytes=readFileSync(resolve(target,'shop.sqlite'));
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
 else if(command==='backup-list'){
  if(!existsSync(backupsDir))console.log('バックアップはありません。');else for(const name of readdirSync(backupsDir).filter(n=>/^(?:auto-)?backup-[a-zA-Z0-9-]+$/.test(n)).sort().reverse()){try{const m=JSON.parse(readFileSync(resolve(backupsDir,name,'manifest.json')));console.log(`${name} ${m.date} ${m.automatic?'自動':'手動'}（未検証）`);}catch{console.log(`${name} 読み取り不可`);}}
 }else if(['backup-check','restore-drill'].includes(command)){
  const supplied=process.argv[3];if(!supplied)throw new Error('バックアップ名を指定してください。');const target=resolve(backupsDir,basename(supplied));const verified=verifyBackup(target);
  if(command==='restore-drill'){
   const work=mkdtempSync(resolve(tmpdir(),'slide-market-restore-drill-'));try{mkdirSync(resolve(work,'versions'));copyFileSync(resolve(target,'shop.sqlite'),resolve(work,'shop.sqlite'));copyFileSync(resolve(target,'manifest.json'),resolve(work,'manifest.json'));for(const f of verified.manifest.files)copyFileSync(resolve(target,'versions',f.name),resolve(work,'versions',f.name));verifyBackup(work);}finally{rmSync(work,{recursive:true,force:true});}
   console.log(`一時領域への復元と整合性検査が成功しました。注文${verified.orders}件・ファイル${verified.files}件。稼働中のデータは変更していません。`);
  }else console.log(`検証成功：注文${verified.orders}件・ファイル${verified.files}件。`);
 }
 else if(command==='restore')await restoreBackup();
 else if(command==='admin-reset'){
  const {randomBytes}=await import('node:crypto');const {passwordHash}=await import('../server/storage.mjs');
  const pidFile=resolve(dataDir,'server.pid');if(existsSync(pidFile)){let alive=false;try{process.kill(Number(readFileSync(pidFile,'utf8')),0);alive=true;}catch{}if(alive)throw new Error('サーバーを停止してください。');}
  const db=new DatabaseSync(resolve(dataDir,'shop.sqlite'));try{for(const role of ['admin','editor']){const password=randomBytes(24).toString('base64url'),salt=randomBytes(16).toString('hex');db.prepare("UPDATE documents SET value=? WHERE kind='credentials' AND id=?").run(JSON.stringify({salt,digest:passwordHash(password,salt)}),role);writeFileSync(resolve(dataDir,role+'-password.txt'),password+'\n',{mode:0o600});}db.prepare("UPDATE local_sessions SET role='guest'").run();db.prepare("DELETE FROM documents WHERE kind IN ('mfaPending','reauth')").run();}finally{db.close();}console.log('管理パスワードを保存先ディレクトリに再発行しました。MFA設定も解除しました。');
 }else if(command==='admin-code'){
  const {totp}=await import('../server/security.mjs');const role=process.argv[3]==='editor'?'editor':'admin';
  const db=new DatabaseSync(resolve(dataDir,'shop.sqlite'),{readOnly:true});try{const row=db.prepare("SELECT value FROM documents WHERE kind='credentials' AND id=?").get(role);const c=row?JSON.parse(row.value):null;const pending=db.prepare("SELECT value FROM documents WHERE kind='mfaPending' AND json_extract(value,'$.role')=? AND json_extract(value,'$.expires')>? ORDER BY json_extract(value,'$.expires') DESC LIMIT 1").get(role,Date.now());const secret=c?.totpSecret||(pending?JSON.parse(pending.value).secret:null);if(!secret)throw new Error('先に管理画面でMFA設定を開始してください。');console.log(totp(secret,Math.floor(Date.now()/30000)));console.log('ローカル確認用のコードです。一度使用したコードは次の更新まで再使用できません。');}finally{db.close();}
 }else throw new Error('backup / backup-list / backup-check / restore-drill / restore / admin-reset / admin-code を指定してください。');
}catch(e){console.error(e.message);process.exitCode=1;}
