import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {resolve} from 'node:path';
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let products=JSON.parse(readFileSync('src/products.json','utf8'));
const dbPath=resolve(process.env.SHOP_DATA_DIR||'data','shop.sqlite');
if(existsSync(dbPath)){const db=new DatabaseSync(dbPath,{readOnly:true});try{const rows=db.prepare("SELECT name FROM sqlite_master WHERE name='documents'").get()?db.prepare("SELECT value FROM documents WHERE kind='products'").all():[];if(rows.length)products=rows.map(r=>JSON.parse(r.value)).filter(p=>p.status==='published');}finally{db.close();}}
const template=readFileSync('dist/index.html','utf8');
// SITE_URLが未設定のローカル版は検索エンジンの登録対象にしない。
const origin=process.env.SITE_URL?new URL(process.env.SITE_URL).origin:'http://localhost:5173';
for(const p of products){
 const path=`/products/${encodeURIComponent(p.id)}`;const structured=JSON.stringify({'@context':'https://schema.org','@type':'Product',name:p.name,description:p.description,url:origin+path}).replace(/</g,'\\u003c');
 const head=`<meta name="description" content="${escape(p.description)}"><meta property="og:title" content="${escape(p.name)}"><meta property="og:description" content="${escape(p.description)}"><meta property="og:type" content="product"><meta property="og:url" content="${escape(origin+path)}"><link rel="canonical" href="${escape(origin+path)}"><script type="application/ld+json">${structured}</script>`;
 const page=template.replace(/<meta name="description"[^>]*>/g,'').replace(/<title>.*?<\/title>/s,`<title>${escape(p.name)} | Slide Market</title>`).replace('</head>',head+'</head>').replace('<div id="root"></div>',`<div id="root"></div><noscript><h1>${escape(p.name)}</h1><p>${escape(p.description)}</p><p>デモ価格：¥${p.price}。購入操作にはJavaScriptが必要です。</p></noscript>`);
 mkdirSync(resolve('dist','products',p.id),{recursive:true});writeFileSync(resolve('dist','products',p.id,'index.html'),page);
}
writeFileSync('dist/sitemap.xml',`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/',...products.map(p=>'/products/'+p.id)].map(path=>`<url><loc>${escape(origin+path)}</loc></url>`).join('')}</urlset>`);
writeFileSync('dist/robots.txt',process.env.SITE_URL?`User-agent: *\nDisallow: /api/\nSitemap: ${origin}/sitemap.xml\n`:'User-agent: *\nDisallow: /\n');
console.log(`${products.length}商品分のメタ情報・構造化データ・サイトマップを生成しました。`);
