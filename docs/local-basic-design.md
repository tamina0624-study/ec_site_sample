# Slide Market ローカル基本設計

更新日：2026年10月1日。現在のコードを確認して記載した実装仕様です。[README](../README.md) は操作手順、[基本設計書（HTML）](production-basic-design.html) は実装状況と将来の実販売設計を扱います。外部サービスの登録・課金・実返金・外部メール送信はありません。

## 構成と責務

| ファイル | 責務 |
| --- | --- |
| `src/main.tsx` | 店舗、カート、見積もり、同意、模擬購入、注文履歴、ダウンロード |
| `src/LocalPages.tsx` | 管理者ログイン、商品・注文・返金・問い合わせ・通知・運用画面、販売条件 |
| `src/api.ts` | APIの型、セッション初期化、CSRFヘッダー、ローカル分析イベント |
| `server/shop.mjs` | APIルーティング、所有者・役割・状態の照合、価格・クーポン計算、通知の周期処理 |
| `server/storage.mjs` | SQLiteの初期化、JSON文書の保存、商品取り込み、パスワードのハッシュ、PPTX検証・版固定 |
| `vite.config.mjs` | 開発・プレビューへAPIを接続。私有ファイルの直接配信を禁止。プレビューで商品別HTMLを返す |
| `scripts/local-data.mjs` | 手動バックアップ、検査付き復元、管理パスワード再発行 |
| `scripts/generate-seo.mjs` | ビルド時の商品別HTML、メタ情報、構造化データ、サイトマップ、robots.txt |

Node.js 24を使用します。商品はAPIから取得し、JSONは初期取り込みに使用します。PPTXは `private/downloads/versions/` に保存し、注文にはSHA-256のファイル版を記録します。プレビューはPPTX内の文字を最大12ページ分抜粋するSVGです。実際のスライドレイアウトの画像化は未実装です。

## 画面と権限

| パス・ハッシュ | 画面 | 条件 |
| --- | --- | --- |
| `/`・`#home` | 一覧・検索・並び替え・お気に入り | 公開 |
| `/products/商品ID`・`#product/商品ID` | 詳細・テキストプレビュー | 公開商品 |
| `#cart`・`#checkout` | カート・見積もり・規約同意・模擬購入 | ブラウザセッション |
| `#order/注文ID`・`#history` | 注文完了・履歴・取得リンク | 同じブラウザの注文 |
| `#guide`・`#contact` | ガイド・問い合わせ | 公開 |
| `#legal/terms`・`#legal/privacy`・`#legal/refund`・`#legal/commerce` | 規約・個人情報・返金・特商法の準備用ページ | 公開、実販売者情報は未設定 |
| `#admin` | 管理者ログイン・各管理タブ | adminは全機能、editorは商品操作のみ |

購入者はメール本人確認済みの会員ではなく、Cookieで識別するブラウザです。購入者セッションは30日、管理ログインは1時間で失効します。パスワードは初回にローカルファイルへ生成し、DBにはsalt付きscryptのハッシュを保存します。更新APIには `X-CSRF-Token` が必要です。管理者MFA・返金時の再認証は未実装です。

## SQLiteの実テーブル

`data/shop.sqlite` をWAL・外部キー有効で利用します。以下は本番設計のPostgreSQLテーブル案とは別の、現行スキーマです。

| テーブル | 主な項目・役割 |
| --- | --- |
| sessions | id。ブラウザセッションの識別子 |
| local_sessions | id、role、expires、csrf。セッションの権限と期限 |
| orders | id、session_id、date、total、request_key、request_body。session_idとrequest_keyの組合せ一意 |
| items | order_id、product_id、name、price。注文削除時に連動削除、order_idとproduct_idの組合せ一意 |
| documents | kind、id、value（JSON）。kindとidの組合せ一意 |
| favorites | session_id、product_id。組合せ一意 |
| download_tokens | token_hash、session_id、order_id、product_id、expires。取得時にも照合 |
| metrics | day、event、count。UTC日付とイベントの組合せ一意 |

`documents.kind` は `products`、`versions`、`quotes`、`orderMeta`、`credentials`、`coupons`、`inquiries`、`notifications`、`audit`、`errors` です。商品、状態、通知をそれぞれ独立した専用テーブルへ正規化する設計は本番向けの拡張案です。

`orderMeta` にはstatus、terms、acceptedAt、discount、購入時のlines（商品ID・名称・価格・ファイル版）、購入商品IDを保存します。明細のpriceは単品価格で、セット・割引後の支払総額はorders.totalが正本です。税額の計算・税区分・利用許諾本文の購入時保存・領収書は未実装です。

## 現行API

GETもブラウザセッションを利用します。更新処理はセッションAPIのCSRFトークンを付けます。エラー形式は `{ message }`。400入力不正、401管理パスワード不一致、403権限・CSRF、404不存在・所有者不一致・権限停止、409失効・変更・競合、413サイズ超過、429回数制限、500処理障害を返します。購入履歴は直近100件、管理注文検索と監査表示は最大500件で、カーソルページングは未実装です。

| メソッド・パス | 入出力・役割 |
| --- | --- |
| GET /api/session | role、csrf、termsVersion |
| GET /api/products | 公開商品の情報。検索と並び替えは画面側 |
| GET /api/products/:id/previews/:index | 0から始まるページのテキストプレビューSVG |
| GET・POST /api/favorites、DELETE /api/favorites/:id | お気に入り取得・登録・削除 |
| POST /api/metrics | view、cart、checkout。購入件数は注文確定時にサーバーで記録 |
| POST /api/quotes | items、coupon → id、価格内訳、lines、期限、terms |
| GET /api/orders | 自分の注文、購入時明細、状態 |
| POST /api/orders | quoteId、result、accepted、termsVersion。Idempotency-Key必須 |
| DELETE /api/orders | 自分のデモ注文と取得トークンを削除 |
| POST /api/orders/:id/download-links/:productId | 同じブラウザのpaid注文から5分有効のurl・expiresAtを発行 |
| GET /api/downloads/:token | 期限、ブラウザ、注文状態を照合して購入時のPPTXを配信 |
| POST /api/inquiries | email、category、body、任意の自分のorderId → 受付id |
| POST /api/admin/login、POST /api/admin/logout | パスワード・任意のroleで管理ログイン、CSRF更新、ログアウト |
| GET・POST /api/admin/products、PATCH /api/admin/products/:id | 商品一覧・新規登録・revision付き編集 |
| POST /api/admin/products/:id/file | revision、base64のPPTX。検証して商品版を更新 |
| GET /api/admin/orders?q=検索語 | 注文番号・商品名・状態の検索 |
| POST /api/admin/orders/:id/refund | reason必須。注文単位で重複しない全額模擬返金 |
| GET /api/admin/inquiries、PATCH /api/admin/inquiries/:id | 問い合わせ一覧、status更新 |
| GET・POST /api/admin/coupons | クーポン一覧・code、percent、limit、expiresで登録 |
| GET /api/admin/notifications | 通知の本文と処理状況 |
| POST /api/admin/notifications/run | ローカル保存処理。simulateFailureで失敗を模擬 |
| POST /api/admin/notifications/:id/retry | 試行回数を戻し、再処理を予約 |
| GET /api/admin/audit、GET /api/admin/health | 管理操作履歴、DB・通知の状況と日別集計 |

`/api/products/:id`、`/api/orders/:id`、Checkout・WebhookのAPI、外部ストレージのアップロードAPIは未実装です。個別の注文画面は履歴APIのデータから表示します。editorは商品管理APIだけを利用でき、返金・問い合わせ・通知・集計はadmin専用です。editorのログアウトAPIは現行の権限判定で拒否されるため、役割別ログアウトの修正は未対応です。

## 状態と業務処理

1. カートの商品IDとクーポンから10分有効の見積もりを作成する。数量1、セットと単品の重複は拒否する。
2. 利用規約・返金条件への同意後に模擬決済を要求する。規約版は `local-2026-10-01`。
3. 商品の公開状態・revision・ファイル版・価格・クーポン上限を再照合する。変更・失効時は409で再確認を要求する。
4. failureは402を返し注文を作らない。successはpaid注文・明細・規約同意・予定通知を同じトランザクションで保存する。実際の入金は照合しない。
5. 同じ操作キー・本文の再送は同じ注文を返す。キーが同じでも本文が異なる場合は409。同じ見積もりの別キー消費も拒否する。
6. ダウンロード発行時と取得時に同じブラウザのpaid注文を確認する。APIトークン方式であり、外部ストレージの署名付きURLではない。
7. 管理者の模擬返金はpaid → refunded。理由・時刻・監査・予定通知を保存し、発行済みトークンを削除する。返金済みの再要求は返金を繰り返さない。実決済の返金要求中・失敗・異議申し立ては未実装。

商品はdraft／published／stopped。問い合わせはopen／handling／closed。通知はpending → savedで、5秒周期に期限の到来した予定通知を処理します。失敗の模擬では指数バックオフ、最大8回でfailed。手動retryでpendingへ戻します。savedは「ローカル保存完了」であり「外部メール送信成功」ではありません。通知IDは購入・返金・問い合わせごとに固定して重複作成を防ぎます。

クーポンは期限・割引率・利用上限をサーバーで判定し、注文と同じトランザクションで消費します。返金しても利用回数は戻しません。購入済み商品の再購入防止・再ダウンロードへの自動案内は未実装です。

## 保護・運用・移行

- CookieはHttpOnly・SameSite=Strict。ローカルHTTPのためSecure属性は未設定。本番HTTPS対応は今後の実装。
- 回数制限はメモリ上の1分窓。セッション全体300回、ログインは接続元IPで10回、問い合わせはセッション5回・IP30回、ダウンロードは発行と取得合算で30回、アップロード10回、分析60回。再起動でカウンタはリセットされる。
- PPTXは50MB、ZIP展開合計100MB、1500エントリ、1〜200ページまで。マクロ・埋め込みファイル・危険なパスを拒否し、未検証のSVGはアップロードしない。マルウェア検査は未実装。
- 初期SQLite版の注文には現在のファイルで版を固定する。過去時点の版は復元できない。既存Cookieを引き継ぐが、localStorageだけのデモ注文は移行しない。
- リセットは自分のorders・items・取得トークンを削除し、orderMetaをresetにする。通知・問い合わせ・監査・お気に入りは残す。
- `npm run backup` は稼働中もSQLiteのバックアップAPIを利用できる。`npm run restore -- バックアップ名` と `npm run admin:reset` はサーバー停止後に実行する。復元前に現在のデータも退避する。
- 復元はDBとファイルのSHA-256、SQLite整合性・外部キー、商品と購入時ファイルの存在を検証する。バックアップにはDB内の管理資格情報も含むが、パスワードの平文ファイルは含まない。復元後に平文ファイルとDBの資格情報が異なる場合はadmin:resetで再発行する。
- `SHOP_DATA_DIR`、`SHOP_FILE_DIR`、`SHOP_BACKUP_DIR` で保存先を指定できる。`LOCAL_ADMIN_PASSWORD` と `LOCAL_EDITOR_PASSWORD` は資格情報の初回作成時のみ参照する。機密値をGitへ保存しない。
- 商品別SEOはビルド時点の公開商品から生成する。DBが未初期化ならJSONを使う。既定のrobots.txtは全体のクロールを禁止。SITE_URLを指定したビルドでは通常のサイトマップを生成するが、これだけで本番運用の準備が完了するわけではない。

## 検証と今後の拡張

`npm run build`、`npm run test:server`、`CHROMIUM_PATH=/usr/bin/chromium npm test` を使用します。2026年10月1日にPC／モバイル計12件、サーバーテスト1件、ビルド後プレビューを確認済み。ブラウザテストは一時DBとテスト用資格情報を使うため、普段の開発サーバーを停止してから実行します。

今後はメール本人確認・端末間共有・MFA・実決済と入金照合・外部配信・本番ストレージ・税と領収書・販売者情報・マルウェア検査・外部監視・自動バックアップと保持期間を整備します。将来の専用テーブル、カーソルページング、codeとrequestId付きエラー、利用許諾本文のスナップショットは基本設計書の目標であり、現行実装との対応を確認して追加します。
