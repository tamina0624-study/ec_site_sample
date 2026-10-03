import { defineConfig, loadEnv } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createShop } from './server/shop.mjs';
export default defineConfig(({mode})=>{
 const env=loadEnv(mode,process.cwd(),'');
 for(const [key,value]of Object.entries(env))if(/^(SHOP_|STARSERVER_|GOOGLE_|LOCAL_|SITE_URL$|CLAM|LIBREOFFICE_|PDFTOPPM_)/.test(key)&&process.env[key]===undefined)process.env[key]=value;
 return {server:{fs:{deny:['**/private/**','**/data/**','**/backups/**','**/server/**','**/scripts/local-data.mjs','**/starserver/**','.env','.env.*','*.{crt,pem}','**/.git/**']}},plugins:[{
 name:'local-shop-api',
 configureServer(server){const shop=createShop();server.middlewares.use(shop.handle);server.httpServer?.once('close',shop.close);},
 configurePreviewServer(server){
  const shop=createShop();server.middlewares.use(shop.handle);server.httpServer?.once('close',shop.close);
  // ViteのSPAフォールバックより先に、商品別に事前生成したHTMLを返す。
  server.middlewares.use((req,res,next)=>{
   const match=req.url?.split('?')[0].match(/^\/products\/([a-zA-Z0-9-]+)\/?$/);
   if(!match || !['GET','HEAD'].includes(req.method))return next();
   const file=resolve('dist','products',match[1],'index.html');
   void Promise.resolve(shop.store.get('products',match[1])).then(p=>{
    if(p?.status!=='published'||!existsSync(file))return next();
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache'});res.end(req.method==='HEAD'?undefined:readFileSync(file));
   }).catch(next);
  });
 }}]};});
