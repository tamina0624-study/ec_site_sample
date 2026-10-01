import pptxgen from 'pptxgenjs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const products = JSON.parse(await readFile(new URL('../src/products.json', import.meta.url)));
await mkdir('private/downloads', {recursive:true});
await mkdir('public/previews', {recursive:true});
for (const product of products) {
  const pptx = new pptxgen();
  pptx.layout = 'LAYOUT_WIDE'; pptx.author = 'Slide Market'; pptx.subject = '学習用の自作サンプル資料'; pptx.title = product.name; pptx.lang = 'ja-JP';
  const slides = [product.name, ...product.sections];
  for (const [index, title] of slides.entries()) {
    const slide = pptx.addSlide(); slide.background = {color: product.color};
    slide.addText('SLIDE MARKET / SAMPLE', {x:0.7,y:0.55,w:10,h:0.3,fontSize:12,color:'FFFFFF',fontFace:'Yu Gothic'});
    slide.addText(title,{x:0.7,y:2.0,w:12,h:1,fontSize:32,bold:true,color:'FFFFFF',fontFace:'Yu Gothic'});
    slide.addText(index === 0 ? product.subtitle : 'ここに目的、要点、具体例を記入してください。\n学習用サンプルとして自由に編集できます。',{x:0.7,y:3.3,w:11,h:1,fontSize:18,color:'FFFFFF',fontFace:'Yu Gothic'});
    slide.addText(`${String(index+1).padStart(2,'0')} / 04 · 学習用デモ`,{x:0.7,y:6.7,w:10,h:0.3,fontSize:11,color:'FFFFFF',fontFace:'Yu Gothic'});
  }
  await pptx.writeFile({fileName:`private/downloads/${product.id}.pptx`});
  await writeFile(`public/previews/${product.id}.svg`, `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#${product.color}"/><path d="M1000 0H1280V720H1120L830 0Z" fill="white" opacity=".035"/><text x="68" y="80" fill="white" font-size="20" font-family="sans-serif" letter-spacing="4">SLIDE MARKET / SAMPLE</text><text x="68" y="310" fill="white" font-size="54" font-weight="bold" font-family="sans-serif">${product.name}</text><text x="68" y="400" fill="white" font-size="28" font-family="sans-serif">${product.subtitle}</text><rect x="68" y="460" width="80" height="4" fill="white" opacity=".65"/><text x="68" y="660" fill="white" font-size="18" font-family="sans-serif">01 / 04 · 学習用デモ</text></svg>`);
}
console.log('6商品 × 4スライドのPPTXとプレビューを生成しました。');
