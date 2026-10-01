import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,mkdirSync,existsSync,rmSync,readdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {tmpdir} from 'node:os';
import JSZip from 'jszip';
import {prepareAsset,scanFile,assetConfig} from '../server/assets.mjs';
import {hash,inspectPptx} from '../server/storage.mjs';
import {receiptSnapshot,receiptHtml} from '../server/receipts.mjs';

function fakeCommand(root,name,source){const path=resolve(root,name);writeFileSync(path,`#!${process.execPath}\n${source}`,{mode:0o700});return path;}
const absent=resolve(tmpdir(),'slide-market-tool-does-not-exist');

test('変換キャッシュとClamAV検査：正常・未導入・失敗・問題検出',async()=>{
 const root=mkdtempSync(resolve(tmpdir(),'slide-market-assets-test-'));try{
  const scanner=fakeCommand(root,'scanner.mjs',`import {readFileSync} from 'node:fs';const bytes=readFileSync(process.argv.at(-1));process.exit(bytes.includes('TEST_INFECTED_MARKER')?1:0);`);
  const office=fakeCommand(root,'office.mjs',`import {writeFileSync} from 'node:fs';import {resolve} from 'node:path';writeFileSync(resolve(process.argv[process.argv.indexOf('--outdir')+1],'source.pdf'),'mock pdf');`);
  const raster=fakeCommand(root,'raster.mjs',`import {writeFileSync} from 'node:fs';for(let i=1;i<=4;i++)writeFileSync(process.argv.at(-1)+'-'+i+'.png',Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'));`);
  const bytes=readFileSync('private/downloads/proposal.pptx'),config={mode:'required',scanner,database:'',office,raster};
  const meta=await prepareAsset(bytes,{dataDir:root,config});assert.equal(meta.scan.status,'clean');assert.equal(meta.preview.status,'ready');assert.equal(meta.preview.pages,4);assert.ok(existsSync(resolve(root,'previews',hash(bytes),'3.png')));
  await prepareAsset(bytes,{dataDir:root,config});assert.equal(readdirSync(resolve(root,'previews')).length,1);
  const unavailable=await prepareAsset(bytes,{dataDir:root,config:{...config,mode:'auto',scanner:absent,office:absent}});assert.equal(unavailable.scan.status,'unavailable');assert.equal(unavailable.preview.status,'unavailable');
  await assert.rejects(prepareAsset(bytes,{dataDir:root,config:{...config,scanner:absent}}),e=>e.code==='SCAN_UNAVAILABLE');
  const failure=fakeCommand(root,'failure.mjs','process.exit(2)');await assert.rejects(prepareAsset(bytes,{dataDir:root,config:{...config,scanner:failure}}),e=>e.code==='SCAN_UNAVAILABLE');
  const file=resolve(root,'test.bin');writeFileSync(file,'TEST_INFECTED_MARKER');await assert.rejects(scanFile(file,config),e=>e.code==='MALWARE_DETECTED');
  const off=await scanFile(file,{...config,mode:'off'});assert.equal(off.status,'disabled');
 }finally{rmSync(root,{recursive:true,force:true});}
});

test('外部参照とXML実体を変換前に拒否する',async()=>{
 const bytes=readFileSync('private/downloads/proposal.pptx');
 for(const xml of ['<Relationships><Relationship TargetMode="External" Target="https://example.test/file"/></Relationships>','<!DOCTYPE x [<!ENTITY x SYSTEM "file:///private">]><x/>']){const zip=await JSZip.loadAsync(bytes);zip.file('ppt/_rels/presentation.xml.rels',xml);await assert.rejects(inspectPptx(await zip.generateAsync({type:'nodebuffer'})),/外部参照/);}
});

test('模擬領収書はセット価格・割引・端数・購入時名称を保存してHTMLをエスケープする',()=>{
 const r=receiptSnapshot({subtotal:1800,discount:180,total:1620},[{id:'bundle',name:'<script>alert(1)</script>',price:1800}],'2026-10-01T00:00:00Z','DEMO-1');assert.equal(r.tax,147);assert.equal(r.net,1473);assert.equal(r.items.length,1);assert.equal(r.items[0].amount,1800);assert.equal(r.tax+r.net,r.total);
 const html=receiptHtml({id:'DEMO-1',status:'refunded',receiptSnapshot:r});assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes('<script>'));assert.ok(html.includes('全額模擬返金済み'));assert.ok(html.includes('実入金なし'));assert.ok(html.includes('@media print'));
 assert.equal(receiptSnapshot({subtotal:0,discount:0,total:0},[],'2026-10-01T00:00:00Z','FREE').tax,0);
});
