import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import JSZip from 'jszip';
import {assetConfig,prepareAsset,scanFile,toolStatus} from '../server/assets.mjs';
import {hash} from '../server/storage.mjs';

test('実LibreOfficeで初期6商品の各4ページをPNG化する',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'slide-market-real-preview-'));try{
  const config={...assetConfig(),mode:'off'};const status=await toolStatus(config);assert.equal(status.office,'available','LibreOfficeを導入してください');assert.equal(status.raster,'available','pdftoppmを導入してください');
  for(const name of readdirSync('private/downloads').filter(n=>n.endsWith('.pptx'))){const bytes=readFileSync(resolve('private/downloads',name));const result=await prepareAsset(bytes,{dataDir:root,config});assert.equal(result.preview.status,'ready',name);assert.equal(result.preview.pages,4,name);const png=readFileSync(resolve(root,'previews',hash(bytes),'0.png'));assert.ok(png.readUInt32BE(16)>=640);assert.ok(png.readUInt32BE(16)<=1280);}
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('実ClamAVでローカルの検証用定義を読み、PPTX内の無害な検証文字列を検出する',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'slide-market-real-scan-'));try{
  const database=resolve(root,'database');mkdirSync(database);const marker='SLIDE_MARKET_SAFE_TEST_MARKER_2026';writeFileSync(resolve(database,'local-test.ndb'),'SlideMarket.LocalTest:0:*:'+Buffer.from(marker).toString('hex')+'\n');
  const config={...assetConfig(),mode:'required',database};const path=resolve(root,'test.pptx');const bytes=readFileSync('private/downloads/proposal.pptx');writeFileSync(path,bytes);assert.equal((await scanFile(path,config)).status,'clean');
  const zip=await JSZip.loadAsync(bytes);zip.file('ppt/slides/slide1.xml',(await zip.file('ppt/slides/slide1.xml').async('string')).replace('</a:t>',marker+'</a:t>'));writeFileSync(path,await zip.generateAsync({type:'nodebuffer',compression:'DEFLATE'}));await assert.rejects(scanFile(path,config),e=>e.code==='MALWARE_DETECTED');
  await assert.rejects(scanFile(path,{...config,database:resolve(root,'missing-database')}),e=>e.code==='SCAN_UNAVAILABLE');
 }finally{rmSync(root,{recursive:true,force:true});}
});
