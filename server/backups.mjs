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
