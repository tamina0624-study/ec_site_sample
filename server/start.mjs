import {createServer} from 'node:http';
import {readFileSync,existsSync,statSync} from 'node:fs';
import {resolve,extname,sep} from 'node:path';
import {createShop} from './shop.mjs';

const root=resolve('dist'),port=Number(process.env.PORT||3000);
if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORTが不正です。');
if(!existsSync(resolve(root,'index.html')))throw new Error('先にnpm run buildを実行してください。');
const shop=createShop();
const mime={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.png':'image/png','.ico':'image/x-icon','.xml':'application/xml','.txt':'text/plain; charset=utf-8'};
const escape=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function serve(req,res){
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405);return res.end();}
 let path;try{path=decodeURIComponent(new URL(req.url,'http://localhost').pathname);}catch{res.writeHead(400);return res.end();}
 if(path.includes('\\')||path.split('/').some(part=>part.startsWith('.'))){res.writeHead(404);return res.end();}
 if(/^\/(?:private|data|backups|server|scripts|starserver)(?:\/|$)/.test(path)){res.writeHead(404);return res.end();}
 const product=path.match(/^\/products\/([a-zA-Z0-9-]{1,100})\/?$/);
 if(product){
  const p=await shop.store.get('products',product[1]);
  if(!p||p.status!=='published'){res.writeHead(404);return res.end();}
  let html=readFileSync(resolve(root,'index.html'),'utf8');
  html=html.replace(/<title>.*?<\/title>/s,`<title>${escape(p.name)} | Slide Market</title>`).replace(/<meta name="description"[^>]*>/g,'').replace('</head>',`<meta name="description" content="${escape(p.description)}"></head>`);
  res.writeHead(200,{'Content-Type':mime['.html'],'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff'});return res.end(req.method==='HEAD'?undefined:html);
 }
 const candidate=resolve(root,'.'+path);
 const file=candidate.startsWith(root+sep)&&existsSync(candidate)&&statSync(candidate).isFile()?candidate:resolve(root,'index.html');
 res.writeHead(200,{'Content-Type':mime[extname(file)]||'application/octet-stream','Cache-Control':path.startsWith('/assets/')?'public, max-age=31536000, immutable':'no-cache','X-Content-Type-Options':'nosniff'});
 res.end(req.method==='HEAD'?undefined:readFileSync(file));
}
const server=createServer((req,res)=>{
 if(req.method==='GET'&&req.url==='/healthz'){res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});return res.end('{"status":"ok"}');}
 void shop.handle(req,res,()=>{void serve(req,res).catch(()=>{if(!res.headersSent)res.writeHead(503);res.end();});});
});
server.listen(port,'0.0.0.0',()=>console.log(`Slide Market server listening on port ${port}`));
let stopping=false;
function shutdown(){if(stopping)return;stopping=true;server.close(()=>{void Promise.resolve(shop.close()).then(()=>process.exit(0));});server.closeIdleConnections();setTimeout(()=>process.exit(1),10000).unref();}
process.once('SIGTERM',shutdown);process.once('SIGINT',shutdown);
