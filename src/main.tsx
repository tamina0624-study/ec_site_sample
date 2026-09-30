import React, {useEffect, useRef, useState} from 'react';
import {createRoot} from 'react-dom/client';
import products from './products.json';
import './style.css';
type Order = {id:string; date:string; items:string[]};
type Store = {cart:string[]; orders:Order[]};
const KEY = 'slide-market-demo-v1';
const validId = (id:unknown): id is string => typeof id === 'string' && products.some(p=>p.id===id);
function load():Store {
  try {
    const data = JSON.parse(localStorage.getItem(KEY) || '{}');
    return {cart:Array.isArray(data.cart)? [...new Set<string>(data.cart.filter(validId))]:[],orders:Array.isArray(data.orders)?data.orders.filter((o:Order)=>o && typeof o.id==='string' && typeof o.date==='string' && Array.isArray(o.items) && o.items.length>0 && o.items.every(validId)).slice(0,100):[]};
  } catch {return {cart:[],orders:[]};}
}
const yen = (n:number)=>`¥${n.toLocaleString('ja-JP')}`;
function App(){
 const [store,setStore]=useState<Store>(load);
 const [route,setRoute]=useState(location.hash.slice(1)||'home');
 const [query,setQuery]=useState(''); const [category,setCategory]=useState('すべて');
 const [notice,setNotice]=useState(''); const [failure,setFailure]=useState(false); const [error,setError]=useState('');
 const [storageError,setStorageError]=useState(false);
 const heading=useRef<HTMLElement>(null); const previousRoute=useRef(route); const paymentLock=useRef(false);
 useEffect(()=>{try {localStorage.setItem(KEY,JSON.stringify(store));setStorageError(false);}catch{setStorageError(true);}},[store]);
 useEffect(()=>{const handle=()=>{setRoute(location.hash.slice(1)||'home');setError('');setNotice('');setFailure(false);paymentLock.current=false;};window.addEventListener('hashchange',handle);return()=>window.removeEventListener('hashchange',handle);},[]);
 useEffect(()=>{if(previousRoute.current===route)return;previousRoute.current=route;heading.current?.focus();window.scrollTo(0,0);},[route]);
 const cart=products.filter(p=>store.cart.includes(p.id)); const total=cart.reduce((s,p)=>s+p.price,0);
 const add=(id:string)=>{setStore(s=>({...s,cart:[...new Set([...s.cart,id])]}));setNotice('カートに追加しました。');};
 const remove=(id:string)=>setStore(s=>({...s,cart:s.cart.filter(x=>x!==id)}));
 const pay=()=>{
  if(!cart.length||paymentLock.current)return;
  if(failure){setError('デモ決済に失敗しました。成功を選択して、もう一度お試しください。');return;}
  paymentLock.current=true;
  const order:Order={id:`DEMO-${crypto.randomUUID()}`,date:new Date().toISOString(),items:[...store.cart]};
  setStore(s=>({cart:[],orders:[order,...s.orders].slice(0,100)}));location.hash=`order/${order.id}`;
 };
 const [page,id]=route.split('/');const product=products.find(p=>p.id===id);const order=store.orders.find(o=>o.id===id);
 const visible=products.filter(p=>(category==='すべて'||p.category===category)&&`${p.name} ${p.description} ${p.category}`.includes(query.trim()));
 const title=page==='home'?'資料を探す':page==='product'?product?.name:page==='cart'?'カート':page==='checkout'?'デモ決済':page==='order'?'注文完了':page==='history'?'デモ注文履歴':page==='guide'?'ご利用ガイド':'ページが見つかりません';
 const preview=(p:typeof products[number])=><img src={`/previews/${p.id}.svg`} alt={`${p.name}の表紙プレビュー`} width="1280" height="720"/>;
 const downloads=(o:Order)=><div className="downloads">{o.items.map(pid=>{const p=products.find(p=>p.id===pid)!;return <div className="download-row" key={pid}><div><strong>{p.name}</strong><span>PowerPoint · 4ページ</span></div><a className="button" href={`/downloads/${pid}.pptx`} download={`${p.name}.pptx`}>ダウンロード ↓</a></div>;})}</div>;
 return <><a className="skip" href="#content" onClick={e=>{e.preventDefault();heading.current?.focus();}}>本文へ移動</a>
 <div className="demo-bar">学習用デモ <span>実際の請求はありません。表示価格はサンプルです。</span></div>
 <header><a className="brand" href="#home"><span className="brand-icon">S<span>↗</span></span>Slide Market<span className="brand-dot">.</span></a><nav aria-label="メインナビゲーション"><a href="#home" aria-current={page==='home'?'page':undefined}>資料を探す</a><a href="#guide">ガイド</a><a className="cart-link" href="#cart">カート <span>{cart.length}</span></a></nav></header>
 <main id="content" ref={heading} tabIndex={-1}>
 {storageError&&<p role="alert" className="alert">ブラウザに保存できません。この画面を閉じるとデータが失われる場合があります。</p>}
 <div role="status" className={notice?'toast':'sr-only'}>{notice}</div>
 {page==='home'?<>
 <section className="hero"><div className="hero-copy"><p className="eyebrow">MAKE YOUR IDEAS SHINE</p><h1>アイデアを、<br/>伝わる資料に<span>。</span></h1><p>企画も、報告も、学びも。<br/>あなたの次の一歩を支える、スライドを見つけよう。</p><a className="button" href="#catalog" onClick={e=>{e.preventDefault();document.getElementById('catalog')?.scrollIntoView({behavior:'smooth'});}}>資料を見つける <span>↗</span></a><div className="hero-tags"><span>編集できるPPTX</span><span>ダウンロード体験</span><span>登録不要</span></div></div><div className="hero-art" aria-hidden="true"><div className="art-grid"/><div className="mini-slide back"><span>YOUR NEXT IDEA</span><div className="bars"><i/><i/><i/></div></div><div className="mini-slide front"><span>SLIDE MARKET</span><strong>伝える、<br/>その先へ。</strong><div className="slide-line"/><small>Presentation collection — 01</small></div><div className="art-note">小さなアイデアから、大きな一歩へ。</div></div></section>
 <section className="catalog" id="catalog"><div className="section-head"><div><p className="eyebrow">THE COLLECTION</p><h2>あなたに合う資料を。</h2></div><span>{visible.length} 件のサンプル資料</span></div><div className="filters"><div className="categories" aria-label="カテゴリ">{['すべて',...new Set(products.map(p=>p.category))].map(c=><button key={c} aria-pressed={c===category} className={c===category?'selected':''} onClick={()=>setCategory(c)}>{c}</button>)}</div><label className="search"><span className="sr-only">資料を検索</span><span aria-hidden="true">⌕</span><input type="search" placeholder="資料を検索" value={query} onChange={e=>setQuery(e.target.value)}/></label></div>
 {visible.length?<div className="product-grid">{visible.map(p=><article className="card" key={p.id}><a href={`#product/${p.id}`} className="image-link">{preview(p)}<span className="image-label">PPTX · 4 PAGES</span></a><div className="card-body"><span className="category">{p.category}</span><h3><a href={`#product/${p.id}`}>{p.name}</a></h3><p>{p.description}</p><div className="card-bottom"><strong>{yen(p.price)}<small> デモ価格</small></strong><button className="add-button" onClick={()=>add(p.id)} disabled={store.cart.includes(p.id)} aria-label={`${p.name}をカートに追加`}>{store.cart.includes(p.id)?'追加済み':'＋'}</button></div></div></article>)}</div>:<div className="empty"><h3>該当する資料がありません</h3><p>検索キーワードやカテゴリを変更してください。</p><button onClick={()=>{setQuery('');setCategory('すべて');}}>条件をリセット</button></div>}</section>
 <section className="how"><div><p className="eyebrow">HOW IT WORKS</p><h2>見つけて、試して、<br/>ダウンロード。</h2></div><ol><li><b>01</b><strong>資料を選ぶ</strong><p>用途に合う資料をカートへ。</p></li><li><b>02</b><strong>デモ購入を体験</strong><p>カード情報の入力は不要です。</p></li><li><b>03</b><strong>資料をダウンロード</strong><p>サンプルを自由に編集してみよう。</p></li></ol></section></>:
 <section className="inner"><a className="back-link" href="#home">← 資料一覧へ</a><p className="eyebrow">SLIDE MARKET / DEMO</p><h1>{title||'ページが見つかりません'}</h1>
 {page==='product'&&product?<div className="detail"><div>{preview(product)}<h2>収録内容</h2><ol className="contents"><li>表紙：{product.name}</li>{product.sections.map(s=><li key={s}>{s}</li>)}</ol><p>プレビューは実際のサンプル資料の表紙です。</p></div><div className="detail-info"><span className="category">{product.category}</span><h2>{product.subtitle}</h2><p>{product.description}</p><dl><div><dt>形式</dt><dd>PowerPoint（.pptx）</dd></div><div><dt>ページ数</dt><dd>4ページ・16:9</dd></div><div><dt>必要ソフト</dt><dd>PPTX対応のPowerPointなど</dd></div></dl><p className="price">{yen(product.price)}<small> デモ価格・請求なし</small></p><button className="button full" disabled={store.cart.includes(product.id)} onClick={()=>add(product.id)}>{store.cart.includes(product.id)?'カートに追加済み':'カートに追加する'}</button><a className="text-link" href="#cart">カートを見る →</a><h3>利用条件</h3><p>自作サンプルです。学習・編集・商用利用ができます。元ファイルの再販売・再配布は禁止します。実販売用の完成資料ではありません。</p></div></div>:
 page==='cart'||page==='checkout'?<><p className="demo-note">模擬決済です。実際の請求はなく、カード情報や個人情報の入力も不要です。</p>{cart.length?<div className="checkout-layout"><div className="cart-items">{cart.map(p=><div className="cart-row" key={p.id}>{preview(p)}<div><a href={`#product/${p.id}`}><strong>{p.name}</strong></a><p>PPTX · 4ページ · 数量1</p><button className="text-button" onClick={()=>remove(p.id)} aria-label={`${p.name}を削除`}>削除</button></div><strong>{yen(p.price)}</strong></div>)}</div><aside className="summary"><h2>注文内容</h2><div><span>商品数</span><strong>{cart.length}点</strong></div><div className="total"><span>合計（デモ価格）</span><strong>{yen(total)}</strong></div><p>デジタル資料のため配送はありません。実際の請求はありません。</p>{page==='cart'?<a className="button full" href="#checkout">デモ購入へ進む →</a>:<><fieldset><legend>模擬決済の結果</legend><label><input type="radio" name="result" checked={!failure} onChange={()=>{setFailure(false);setError('');}}/> 成功</label><label><input type="radio" name="result" checked={failure} onChange={()=>setFailure(true)}/> 失敗を試す</label></fieldset>{error&&<p role="alert" className="alert">{error}</p>}<button className="button full" onClick={pay}>デモ購入を確定する</button><a href="#cart" className="text-link">カートに戻る</a></>}</aside></div>:<div className="empty"><h2>カートは空です</h2><p>気になる資料を追加して、デモ購入を体験してください。</p><a className="button" href="#home">資料を探す</a></div>}</>:
 page==='order'&&order?<><div className="success"><span>✓</span><h2>デモ購入が完了しました。</h2><p>実際の請求はありません。サンプル資料をダウンロードしてみましょう。</p></div><p className="order-id">注文番号：{order.id}<br/>注文日時：{new Date(order.date).toLocaleString('ja-JP')}</p>{downloads(order)}<p className="demo-note">デモのファイルは公開されています。購入権限を保護する仕組みではありません。</p><a href="#history" className="text-link">デモ注文履歴を見る →</a></>:
 page==='history'?<>{store.orders.length?store.orders.map(o=><article className="history" key={o.id}><p className="order-id">{new Date(o.date).toLocaleString('ja-JP')} · {o.id}</p>{downloads(o)}</article>):<div className="empty"><h2>デモ注文はまだありません</h2><a className="button" href="#home">資料を探す</a></div>}</>:
 page==='guide'?<div className="guide"><h2>購入とダウンロード</h2><p>資料をカートに追加し、デモ決済で「成功」を選んで確定すると、注文完了画面からPPTXファイルを取得できます。「失敗を試す」で再試行の流れも確認できます。</p><h2>資料について</h2><p>各資料は表紙と3ページの、自作の短い学習用サンプルです。PPTX対応のPowerPointなどで開いて編集できます。表示価格は架空で、実際の請求はありません。</p><h2>利用条件</h2><p>サンプルの学習・編集・商用利用を許可します。元ファイルの再販売・再配布は禁止します。第三者の素材は使用していません。</p><h2>保存とデモの制約</h2><p>カートと直近100件の注文はこのブラウザに保存されます。別の端末には引き継がれません。個人情報やカード情報は収集しません。ファイルは公開URLで取得できるため、本番販売のアクセス制御には使えません。</p><a className="text-link" href="#history">デモ注文履歴を見る →</a><h2>データのリセット</h2><p>このブラウザのカートとデモ注文履歴を削除します。</p><button className="reset" onClick={()=>{if(window.confirm('カートとデモ注文履歴を削除しますか？')){setStore({cart:[],orders:[]});setNotice('デモデータをリセットしました。');}}}>デモデータをリセット</button></div>:<div className="empty"><p>指定された商品や注文は見つかりません。</p><a className="button" href="#home">資料を探す</a></div>}
 </section>}
 </main><footer><div><a className="brand" href="#home">Slide Market.</a><p>アイデアを、伝わる資料に。</p></div><div><a href="#guide">ご利用ガイド</a><a href="#history">デモ注文履歴</a><small>学習用デモ / 実際の販売・請求は行いません。</small></div></footer></>;
}
createRoot(document.getElementById('root')!).render(<React.StrictMode><App/></React.StrictMode>);
