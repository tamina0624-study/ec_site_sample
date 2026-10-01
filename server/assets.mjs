import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,renameSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {hash,inspectPptx} from './storage.mjs';
const execute=promisify(execFile);
export class AssetError extends Error {constructor(message,code,status=503){super(message);this.code=code;this.status=status;}}
export function assetConfig(env=process.env){
 const mode=env.SHOP_SCAN_MODE||'auto';if(!['auto','required','off'].includes(mode))throw new Error('SHOP_SCAN_MODEはauto / required / offを指定してください。');
 const localDatabase=resolve(env.SHOP_DATA_DIR||'data','clamav');return {mode,scanner:env.CLAMSCAN_PATH||'clamscan',database:env.CLAMAV_DATABASE_DIR||(existsSync(localDatabase)?localDatabase:''),office:env.LIBREOFFICE_PATH||'libreoffice',raster:env.PDFTOPPM_PATH||'pdftoppm'};
}
async function run(command,args,timeout=90000){return execute(command,args,{timeout,maxBuffer:1024*1024,windowsHide:true});}
const missing=e=>e.code==='ENOENT';
export async function scanFile(path,config=assetConfig()){
 if(config.mode==='off')return {status:'disabled',engine:'ClamAV'};
 try{
  await run(config.scanner,['--no-summary','--max-filesize=50M','--max-scansize=100M','--max-files=1500','--alert-exceeds-max=yes',...(config.database?['--database',resolve(config.database)]:[]),path]);
  // clamscan exit 0だけを検査完了として扱う。標準出力はパス等を含むため保存しない。
  return {status:'clean',engine:'ClamAV',checkedAt:new Date().toISOString()};
 }catch(e){
  if(missing(e)&&config.mode==='auto')return {status:'unavailable',engine:'ClamAV'};
  if(e.code===1)throw new AssetError('ウイルス検査で問題を検出したため、ファイルを登録できません。','MALWARE_DETECTED',400);
  throw new AssetError('ウイルス検査を完了できません。ClamAVと定義ファイル、保存先を確認してください。','SCAN_UNAVAILABLE');
 }
}
export async function renderSlides(path,{dataDir,checksum,config=assetConfig()}){
 const base=resolve(dataDir,'previews');mkdirSync(base,{recursive:true,mode:0o700});
 const work=mkdtempSync(resolve(base,'.render-'));const out=resolve(work,'output');mkdirSync(out);
 try{
  const profile=resolve(work,'profile');mkdirSync(resolve(profile,'user'),{recursive:true});
  const fontFallback='<item oor:path="/org.openoffice.Office.Common/Font/Substitution"><prop oor:name="Replacement"><value>true</value></prop></item><item oor:path="/org.openoffice.Office.Common/Font/Substitution/FontPairs"><node oor:name="0" oor:op="replace"><prop oor:name="ReplaceFont"><value>Yu Gothic</value></prop><prop oor:name="SubstituteFont"><value>Noto Sans CJK JP</value></prop><prop oor:name="Always"><value>true</value></prop><prop oor:name="OnScreenOnly"><value>false</value></prop></node></item>';
  writeFileSync(resolve(profile,'user','registrymodifications.xcu'),'<oor:items xmlns:oor="http://openoffice.org/2001/registry"><item oor:path="/org.openoffice.Office.Common/Security/Scripting"><prop oor:name="MacroSecurityLevel" oor:op="fuse"><value>3</value></prop></item>'+fontFallback+'</oor:items>');
  await run(config.office,[`-env:UserInstallation=${pathToFileURL(profile).href}`,'--headless','--nologo','--nodefault','--nolockcheck','--norestore','--convert-to','pdf:impress_pdf_Export','--outdir',out,path]);
  const pdf=readdirSync(out).find(n=>n.endsWith('.pdf'));if(!pdf)throw new Error('PDFが生成されませんでした。');
  const images=resolve(work,'images');mkdirSync(images);await run(config.raster,['-png','-f','1','-l','12','-scale-to','1280',resolve(out,pdf),resolve(images,'slide')]);
  const names=readdirSync(images).filter(n=>/^slide-\d+\.png$/.test(n)).sort((a,b)=>Number(a.match(/\d+/)[0])-Number(b.match(/\d+/)[0]));
  if(!names.length||names.length>12)throw new Error('画像が生成されませんでした。');
  for(let i=0;i<names.length;i++){const bytes=readFileSync(resolve(images,names[i]));if(bytes.length>10*1024*1024||!bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))throw new Error('プレビュー形式が不正です。');renameSync(resolve(images,names[i]),resolve(images,`${i}.png`));}
  // 完成した画像だけを入れ替える。再実行でフォント等の変更も反映する。
  const target=resolve(base,checksum),previous=resolve(work,'previous');if(existsSync(target))renameSync(target,previous);try{renameSync(images,target);}catch(e){if(existsSync(previous))renameSync(previous,target);throw e;}
  return {status:'ready',pages:names.length,engine:'LibreOffice + pdftoppm',createdAt:new Date().toISOString()};
 }catch(e){return {status:missing(e)?'unavailable':'failed',pages:0,engine:'LibreOffice + pdftoppm'};}
 finally{rmSync(work,{recursive:true,force:true});}
}
let queue=Promise.resolve();
export function prepareAsset(bytes,{dataDir,config=assetConfig()}){
 const task=queue.then(async()=>{
  const meta=await inspectPptx(bytes),checksum=hash(bytes);const work=mkdtempSync(resolve(tmpdir(),'slide-market-asset-'));const path=resolve(work,'source.pptx');
  try{writeFileSync(path,bytes,{mode:0o600});const scan=await scanFile(path,config);const preview=await renderSlides(path,{dataDir,checksum,config});return {...meta,scan,preview};}
  finally{rmSync(work,{recursive:true,force:true});}
 });queue=task.catch(()=>{});return task;
}
export async function toolStatus(config=assetConfig()){
 async function check(command,args=['--version']){try{await run(command,args,5000);return 'available';}catch(e){return missing(e)?'unavailable':'failed';}}
 const [scanner,office,raster]=await Promise.all([check(config.scanner),check(config.office),check(config.raster,['-v'])]);return {scanMode:config.mode,scanner,office,raster};
}
