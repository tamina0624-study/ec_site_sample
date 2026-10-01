import {readFileSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {assetConfig,prepareAsset,toolStatus,AssetError} from '../server/assets.mjs';
import {hash} from '../server/storage.mjs';
const dataDir=resolve(process.env.SHOP_DATA_DIR||'data'),fileDir=resolve(process.env.SHOP_FILE_DIR||'private/downloads');
try{
 const config=assetConfig();if(process.argv.includes('--check'))console.log(JSON.stringify(await toolStatus(config),null,2));
 else{
  if(!existsSync(resolve(dataDir,'shop.sqlite')))throw new Error('先にnpm run devでデータベースを作成してください。');
  const pidFile=resolve(dataDir,'server.pid');if(existsSync(pidFile)){let alive=false;try{process.kill(Number(readFileSync(pidFile,'utf8')),0);alive=true;}catch{}if(alive)throw new Error('先に開発・プレビューサーバーを停止してください。');}
  const db=new DatabaseSync(resolve(dataDir,'shop.sqlite'));let failed=false;
  try{for(const row of db.prepare("SELECT id,value FROM documents WHERE kind='versions'").all()){
   try{if(!/^[a-f0-9]{64}$/.test(row.id))throw new Error('版が不正です。');const bytes=readFileSync(resolve(fileDir,'versions',row.id+'.pptx'));if(hash(bytes)!==row.id)throw new Error('ファイルの整合性が不正です。');const meta=await prepareAsset(bytes,{dataDir,config});if(JSON.parse(row.value).scan?.status==='infected'&&meta.scan.status!=='clean')throw new Error('検出済みファイルは再検査が必要です。');const v={...JSON.parse(row.value),...meta};db.prepare("UPDATE documents SET value=? WHERE kind='versions' AND id=?").run(JSON.stringify(v),row.id);console.log(`${row.id.slice(0,8)}：検査 ${meta.scan.status} ／ 画像 ${meta.preview.status}`);if(meta.preview.status!=='ready'||meta.scan.status!=='clean')failed=true;
   }catch(e){if(e instanceof AssetError){const v=JSON.parse(row.value);v.scan={status:e.code==='MALWARE_DETECTED'?'infected':'failed',engine:'ClamAV',checkedAt:new Date().toISOString()};db.prepare("UPDATE documents SET value=? WHERE kind='versions' AND id=?").run(JSON.stringify(v),row.id);}failed=true;console.error(`${row.id.slice(0,8)}：${e.message}`);}
  }}finally{db.close();}if(failed){console.error('未完了の処理があります。無料ツールと定義ファイルの設定を確認してください。');process.exitCode=1;}
 }
}catch(e){console.error(e.message);process.exitCode=1;}
