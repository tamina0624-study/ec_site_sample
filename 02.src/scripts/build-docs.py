from pathlib import Path
import re
import html
import markdown

ROOT = Path(__file__).resolve().parents[2]
DOC = ROOT / '01.doc'
PAGES = [
 ('local-basic-design','ローカル基本設計','現行仕様','画面・API・SQLite・認証・権限・処理の仕様。'),
 ('demo-requirements','要件・初期設計','要件定義','現在の要件、完成条件、初期版からの設計履歴。'),
 ('local-operations','ローカル運用手順','運用','起動、ファイル検査、プレビュー、バックアップと復元。'),
 ('implementation-status','実装状況と残作業','進捗','実装済み機能、環境設定、検証結果と本番前の残作業。'),
 ('production-basic-design','実運用に向けた基本設計','将来設計','実販売に向けたシステム構成・データ・決済・運用の設計案。'),
 ('ec-site-patterns','ECサイトの設計パターン','比較資料','販売モデル、構築方式、画面と業務処理の選択肢。'),
 ('static-demo-history','初期の静的デモの説明','履歴','ローカルAPI追加以前の構成と仕様を保存した記録。'),
]

def links(text):
    return re.sub(r'(href=[\"\'])([^\"\']+?)\.md(?=([#\"\']))', lambda m: m[1]+m[2]+'.html' if not m[2].startswith(('http:', 'https:', '../README')) else m[0], text)

def current_paths(text):
    return re.sub(r'(?<![\w./-])(src|server|scripts|tests|public)/',r'02.src/\1/',text)

def shell(title, label, body, toc='', slug='index'):
    toc_html = f'<aside class="toc" aria-label="ページ内の目次"><p class="eyebrow">CONTENTS</p>{toc}</aside>' if toc else ''
    nav=''.join(f'<a href="{s}.html"'+(' aria-current="page"' if s==slug else '')+f'>{html.escape(t)}</a>' for s,t,_,_ in PAGES)
    return f'''<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="description" content="Slide Marketの{html.escape(title)}。ローカルで閲覧・印刷できるプロジェクト資料。">
<title>{html.escape(title)} | Slide Market 資料</title><link rel="stylesheet" href="assets/documents.css"></head>
<body><a class="skip" href="#content">本文へ移動</a><header class="masthead"><div class="header-inner"><a class="brand" href="index.html">SLIDE MARKET <span>PROJECT DOCUMENTS</span></a><div class="header-actions"><a href="index.html">資料一覧</a><button type="button" onclick="window.print()">印刷・PDF保存</button></div></div></header>
<div class="page-heading"><p class="eyebrow">{html.escape(label)}</p><h1>{html.escape(title)}</h1><p class="meta">HTML版整備：2026年10月19日 · 対象：ec_site_sample</p></div>
<div class="layout {'overview' if not toc else ''}">{toc_html}<main id="content" tabindex="-1">{body}<footer><p>Slide Market · 学習用ローカルデモ</p><nav aria-label="関連資料">{nav}</nav><p><a href="index.html">資料一覧に戻る</a> · <a href="../README.md">README（Markdown）</a></p></footer></main></div></body></html>\n'''

latest='''<div class="notice"><strong>2026年10月19日の整備・検証状況</strong><p>実装・テストは <code>02.src/</code>、資料は <code>01.doc/</code> に整理済み。サーバー・ファイル処理テスト11件とセキュリティフック検査は成功しています。ビルドは構成整理時に成功しましたが、直近の再実行では変換後にWindows異常終了 <code>0xC0000409</code> が発生し、未解決です。ブラウザ・実Google認証・実外部ツールは今回未検証です。</p><p>以下の本文にある過去の日付・検証記録は当時の結果です。最新の詳細は <a href="implementation-status.html#latest-verification">実装状況と残作業</a> を参照してください。</p></div>'''

for slug,title,label,description in PAGES:
    if slug=='production-basic-design':
        original=(DOC/(slug+'.html')).read_text(encoding='utf-8-sig')
        body=re.search(r'<main[^>]*>(.*?)</main>',original,re.S)[1]
        body=re.sub(r'<div class="notice">.*?</div>','',body,flags=re.S)
        body=re.sub(r'<footer>.*?</footer>','',body,flags=re.S)
        body=body.strip()
        if body.startswith('<article>') and body.endswith('</article>'):
            body=body[len('<article>'):-len('</article>')]
        body=current_paths(links(body))
    else:
        source=(DOC/(slug+'.md')).read_text(encoding='utf-8-sig')
        source=re.sub(r'^# .*\n','',source,count=1)
        if slug!='static-demo-history': source=current_paths(source)
        body=markdown.markdown(source,extensions=['tables','fenced_code','sane_lists','toc'],extension_configs={'toc':{'permalink':False}})
        body=links(body)
        if slug=='static-demo-history':
            body=body.replace('<pre><code class="language-mermaid">','<details class="diagram-source"><summary>構成図の元データ（Mermaid）</summary><pre><code class="language-mermaid">')
            body=re.sub(r'(<details class="diagram-source">.*?</pre>)',r'\1</details>',body,flags=re.S)
            diagram='''<figure class="history-flow"><div class="flow-row"><div><b>ソース・生成処理</b><p>商品JSON → スライド生成</p></div><span aria-hidden="true">→</span><div><b>静的ファイル</b><p>表紙SVG・公開PPTX</p></div></div><div class="flow-arrow" aria-hidden="true">↓</div><div class="flow-row"><div><b>Reactアプリ</b><p>商品一覧・カート・模擬決済</p></div><span aria-hidden="true">↔</span><div><b>ブラウザ内の保存</b><p>localStorageの注文・カート</p></div></div><div class="flow-arrow" aria-hidden="true">↓</div><div class="flow-row"><div><b>注文完了・履歴</b><p>公開URLのリンクからPPTXを取得</p></div></div><figcaption>初期静的デモの構成。サーバーによる購入権限の照合はありません。生成物をアプリが表示し、購入操作の成功・失敗と注文の保存をブラウザ内で処理します。</figcaption></figure>'''
            body=body.replace('<details class="diagram-source">',diagram+'<details class="diagram-source">')
    # IDs make the same navigation work for Markdown and the existing SVG-rich HTML.
    count=[0]; headings=[]
    def heading(m):
        count[0]+=1
        attrs=m[1]; text=m[2]
        match=re.search(r'id="([^"]+)"',attrs)
        anchor=match[1] if match else 'section-'+str(count[0])
        headings.append((anchor,re.sub('<[^>]+>','',text)))
        return '<h2'+attrs+('' if match else f' id="{anchor}"')+'>'+text+'</h2>'
    body=re.sub(r'<h2([^>]*)>(.*?)</h2>',heading,body,flags=re.S)
    if slug=='implementation-status':
        body='<h2 id="latest-verification">最新の検証記録（2026年10月19日）</h2><ul><li>Windows対応後のサーバー・ファイル処理テスト：11件すべて成功。</li><li>GitSecurityTool・gitleaks・基本フック：移動後のファイルを含め全検査成功。</li><li>Python 3.13.7とpre-commitをGit管理外の <code>.tools/</code> に導入し、コミットフックを有効化。</li><li>最新ビルド：型検査・32モジュールの変換後にWindows異常終了。依存関係復元後も再現し、原因は未特定。</li><li>ブラウザ・実Google認証・実外部ツール：今回未検証。下記の2026年10月9日の記録とは区別する。</li></ul>'+body
        headings.insert(0,('latest-verification','最新の検証記録'))
    if slug!='production-basic-design':
        body=re.sub(r'(<table>.*?</table>)',r'<div class="table-scroll" role="region" aria-label="資料の表" tabindex="0">\1</div>',body,flags=re.S)
    note='<div class="notice archive"><strong>設計履歴</strong><p>このページは初期版の記録です。ファイル配置や動作を現在の仕様へ読み替えず、現行仕様は <a href="local-basic-design.html">ローカル基本設計</a> を参照してください。</p></div>' if slug=='static-demo-history' else latest
    toc=''.join(f'<a href="#{html.escape(a)}">{html.escape(html.unescape(t))}</a>' for a,t in headings)
    (DOC/(slug+'.html')).write_text(shell(title,label,note+'<article>'+body+'</article>',toc,slug),encoding='utf-8')

cards=''.join(f'<a class="doc-card" href="{s}.html"><span class="tag">{l}</span><h2>{t}</h2><p>{d}</p><span class="card-link">資料を読む →</span></a>' for s,t,l,d in PAGES)
body='<section class="intro"><h2>プロジェクトを把握する</h2><p>現在の仕様は「ローカル基本設計」、操作と保守は「ローカル運用手順」、確認結果は「実装状況と残作業」から参照できます。実販売に向けた案と、初期版の履歴は別の資料にまとめています。</p></section>'+latest+'<div class="card-grid">'+cards+'</div><section class="intro"><h2>閲覧・更新について</h2><p>このフォルダの <code>index.html</code> をブラウザで開いてください。外部通信は不要です。「印刷・PDF保存」で本文を印刷できます。Markdown版は編集用の原稿として残しています。</p><p>Markdownの編集後はPython環境に <code>Markdown==3.11.1</code> を用意し、ルートで <code>python 02.src/scripts/build-docs.py</code> を実行するとHTMLを再生成できます。既存の実運用向け基本設計書はHTML本文を原稿として扱います。</p></section>'
(DOC/'index.html').write_text(shell('設計・運用ドキュメント','DOCUMENT LIBRARY',body),encoding='utf-8')
print(f'Generated {len(PAGES)} documents and index.html')
