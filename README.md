# Slide Market

PowerPoint資料のダウンロード販売を体験する学習用デモ。React / TypeScript / Viteで実装しています。実際の販売・請求は行いません。

## 起動

Node.js 22.12以上（この環境では24を使用）で実行します。

```sh
npm ci --cache /tmp/slide-market-npm-cache
npm run dev
```

開発サーバーの既定ポートは5173です。

## 機能

- 6商品の一覧、検索、カテゴリ絞り込み、詳細・表紙プレビュー
- 重複しないカート、合計、削除、ブラウザへの保存
- 成功・失敗を切り替えられる模擬決済
- 注文完了、PPTXダウンロード、直近100件のデモ注文履歴
- ご利用ガイド、保存データのリセット、モバイル対応

商品情報は `src/products.json` で更新します。ファイルと表紙は次のコマンドで再生成します。

```sh
npm run generate
```

各商品は表紙と3枚の内容ページを含む自作サンプルです。編集・学習・商用利用を許可します。元ファイルの再販売・再配布は禁止します。

## 検証

```sh
npm run build
PLAYWRIGHT_BROWSERS_PATH=/tmp/slide-market-browsers npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH=/tmp/slide-market-browsers npm test
```

このクラウド環境では既存のChromiumを使い、`CHROMIUM_PATH=/usr/bin/chromium npm test` でも実行できます。

ブラウザテストはデスクトップとモバイルの画面幅で、検索、購入、失敗時の再試行、ダウンロード、保存、削除、リセットなどを確認します。Linux環境によってはPlaywrightのOS依存ライブラリが別途必要です。

## 制約

決済はブラウザ内のシミュレーションです。個人情報・カード情報は入力しません。注文・カートはローカルストレージに保存され、購入証明には使えません。PPTXファイルは公開パスにあるため、購入操作なしでも取得できます。本番販売にはサーバーでの価格計算、決済連携、Webhook検証、注文管理、非公開ファイルのアクセス制御が必要です。

設計資料：`docs/ec-site-patterns.md`、`docs/demo-requirements.md`。
