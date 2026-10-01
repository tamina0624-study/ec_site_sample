# Slide Market ローカル基本設計

更新日：2026年10月1日。現在のコードを確認して記載した実装仕様です。[README](../README.md) は操作手順、[基本設計書（HTML）](production-basic-design.html) は実装状況と将来の実販売設計を扱います。外部サービスの登録・課金・実返金・外部メール送信はありません。

## 構成と責務

| ファイル | 責務 |
| --- | --- |
| `src/main.tsx` | 店舗、カート、見積もり、同意、模擬購入、注文履歴、ダウンロード |
| `src/LocalPages.tsx` | 管理者ログイン、商品・注文・返金・問い合わせ・通知・運用画面、販売条件 |
| `src/AdminSecurity.tsx` | MFA設定・解除・復旧コードの表示 |
| `src/api.ts` | APIの型、セッション初期化、CSRFヘッダー、ローカル分析イベント |
| `server/shop.mjs` | APIルーティング、所有者・役割・状態の照合、価格・クーポン計算、通知の周期処理 |
| `server/assets.mjs` | ClamAV検査、外部変換ツール実行、画像キャッシュ |
| `server/receipts.mjs` | 購入時の模擬領収書保存と印刷用HTML |
| `scripts/prepare-assets.mjs` | 実行ファイル確認・既存ファイル版の準備 |
| `server/security.mjs` | TOTP・コードの再利用防止・復旧コード生成 |
| `server/legal.mjs` | 販売条件本文と購入時の本文保存 |
| `server/pagination.mjs` | 日時・IDによるカーソルの検証 |
| `server/backups.mjs` | DB・ファイルのバックアップ、自動分の保持 |
| `server/storage.mjs` | SQLiteの初期化、JSON文書の保存、商品取り込み、パスワードのハッシュ、PPTX検証・版固定 |
| `vite.config.mjs` | 開発・プレビューへAPIを接続。私有ファイルの直接配信を禁止。プレビューで商品別HTMLを返す |
| `scripts/local-data.mjs` | 手動バックアップ、検査付き復元、管理パスワード再発行 |
| `scripts/generate-seo.mjs` | ビルド時の商品別HTML、メタ情報、構造化データ、サイトマップ、robots.txt |

Node.js 24を使用します。商品はAPIから取得し、JSONは初期取り込みに使用します。PPTXは `private/downloads/versions/` に保存し、注文にはSHA-256のファイル版を記録します。LibreOfficeでPDF化し、pdftoppmで最大12ページのPNGを生成します。data/previewsにSHA-256単位で保存し、公開商品のAPIから取得します。未導入・失敗・キャッシュ欠落時は文字抜粋SVGへ戻します。セットは先頭商品を表示します。プレビューのYu GothicはNoto Sans CJK JPへ置換します。元のPPTXは変更せず、フォントや描画はPowerPointと異なる場合があります。

## 画面と権限

| パス・ハッシュ | 画面 | 条件 |
| --- | --- | --- |
| `/`・`#home` | 一覧・検索・並び替え・お気に入り | 公開 |
| `/products/商品ID`・`#product/商品ID` | 詳細・テキストプレビュー | 公開商品 |
| `#cart`・`#checkout` | カート・見積もり・規約同意・模擬購入 | ブラウザセッション |
| `#order/注文ID`・`#history` | 注文完了・履歴・取得リンク | 同じブラウザの注文 |
| `#guide`・`#contact` | ガイド・問い合わせ | 公開 |
| `#legal/terms`・`#legal/privacy`・`#legal/refund`・`#legal/commerce` | 規約・個人情報・返金・特商法の準備用ページ | 公開、実販売者情報は未設定 |
| `#admin` | 管理者ログイン・各管理タブ | adminは全機能、editorは商品操作・自身の認証設定 |

購入者はメール本人確認済みの会員ではなく、Cookieで識別するブラウザです。購入者セッションは30日、管理ログインは1時間で失効します。パスワードは初回にローカルファイルへ生成し、DBにはsalt付きscryptのハッシュを保存します。更新APIには `X-CSRF-Token` が必要です。役割ごとに任意のTOTP MFAを設定できます。30秒・6桁・前後1ステップを許容し、使用済みステップを拒否します。復旧コード8個はハッシュ保存し、各1回のみ使用できます。設定待ちは5分有効。設定確定時に同じ役割の他セッションを解除します。返金はパスワードと設定済みMFAで再認証し、5分有効です。editorもログアウト・自身の認証設定が可能です。

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

`documents.kind` は `products`、`versions`、`quotes`、`orderMeta`、`credentials`、`coupons`、`inquiries`、`notifications`、`audit`、`errors`、`mfaPending`、`reauth`、`maintenance` です。商品、状態、通知をそれぞれ独立した専用テーブルへ正規化する設計は本番向けの拡張案です。

`orderMeta` にはstatus、terms、acceptedAt、discount、購入時のlines（商品ID・名称・価格・ファイル版）、購入商品IDを保存します。明細のpriceは単品価格で、セット・割引後の支払総額はorders.totalが正本です。`licenseSnapshot` に規約版と利用規約・返金条件の本文を保存します。旧注文に本文がなければ後から当時の本文を捏造しません。`receiptSnapshot` に購入時の単品／セット販売価格・小計・割引・合計・仮の10%税額を保存します。税額はfloor(total / 11)、税抜はtotalとの差額。実販売の税区分・適格請求書は未実装です。旧注文に領収書データがなければ生成しません。

## 現行API

GETもブラウザセッションを利用します。更新処理はセッションAPIのCSRFトークンを付けます。エラー形式は `{ code, message, requestId, details? }`、ヘッダーは `X-Request-Id`。確認番号を画面とerrors文書へ記録します。取得トークンをエラー記録へ残しません。400入力不正、401管理パスワード不一致、403権限・CSRF、404不存在・所有者不一致・権限停止、409失効・変更・競合、413サイズ超過、429回数制限、500処理障害を返します。購入履歴・管理注文・監査は `{ items, nextCursor }`。limitは既定20・最大100。日時降順とID降順によるSQLのキーセット方式で、同時刻の行も欠落・重複しません。cursorは日時とIDのBase64url JSONで、不正な値は400です。

| メソッド・パス | 入出力・役割 |
| --- | --- |
| GET /api/session | role、csrf、termsVersion |
| GET /api/products | 公開商品の情報。検索と並び替えは画面側 |
| GET /api/products/:id/previews/:index | 0から始まるページのテキストプレビューSVG |
| GET・POST /api/favorites、DELETE /api/favorites/:id | お気に入り取得・登録・削除 |
| POST /api/metrics | view、cart、checkout。購入件数は注文確定時にサーバーで記録 |
| POST /api/quotes | items、coupon → id、価格内訳、lines、期限、terms |
| GET /api/orders/:id/receipt | 所有者限定の模擬領収書HTML。download=1で保存、返金後は状態を明示 |
| GET /api/orders、GET /api/orders/:id | ページ化した自分の注文、所有者限定の個別取得 |
| GET /api/purchases | 全paid注文から購入済み商品と再取得先を取得 |
| GET /api/legal | 規約版と販売条件本文 |
| POST /api/orders | quoteId、result、accepted、termsVersion。Idempotency-Key必須 |
| DELETE /api/orders | 自分のデモ注文と取得トークンを削除 |
| POST /api/orders/:id/download-links/:productId | 同じブラウザのpaid注文から5分有効のurl・expiresAtを発行 |
| GET /api/downloads/:token | 期限、ブラウザ、注文状態を照合して購入時のPPTXを配信 |
| POST /api/inquiries | email、category、body、任意の自分のorderId → 受付id |
| POST /api/admin/login、POST /api/admin/logout | パスワード・任意のrole・設定済みMFAのcodeで管理ログイン、CSRF更新、ログアウト |
| POST /api/admin/reauth | パスワード・設定済みMFAで5分の返金再認証 |
| GET /api/admin/security/status | 自分の役割のMFA状態・復旧コード残数 |
| POST /api/admin/security/mfa/setup、confirm、disable | パスワードで準備、コードで確定、再認証して解除 |
| GET・POST /api/admin/products、PATCH /api/admin/products/:id | 商品一覧・新規登録・revision付き編集 |
| POST /api/admin/products/:id/file | revision、base64のPPTX。検証して商品版を更新 |
| POST /api/admin/products/:id/prepare | revision指定で既存版を検査・PNG化。商品管理者も利用可能 |
| GET /api/admin/orders?q=検索語 | 注文番号・商品名・状態の検索 |
| POST /api/admin/orders/:id/refund | reason必須。注文単位で重複しない全額模擬返金 |
| GET /api/admin/inquiries、PATCH /api/admin/inquiries/:id | 問い合わせ一覧、status更新 |
| GET・POST /api/admin/coupons | クーポン一覧・code、percent、limit、expiresで登録 |
| GET /api/admin/notifications | 通知の本文と処理状況 |
| POST /api/admin/notifications/run | ローカル保存処理。simulateFailureで失敗を模擬 |
| POST /api/admin/notifications/:id/retry | 試行回数を戻し、再処理を予約 |
| GET /api/admin/audit、GET /api/admin/health | 管理操作履歴、DB・通知の状況と日別集計 |

`/api/products/:id`、Checkout・WebhookのAPI、外部ストレージのアップロードAPIは未実装です。個別の注文画面は所有者限定の詳細APIから表示します。editorの業務操作は商品管理に限定し、返金・問い合わせ・通知・集計はadmin専用です。editorもログアウト・認証設定・再認証を利用できますが、返金等のadmin専用操作は拒否します。

## 状態と業務処理

1. カートの商品IDとクーポンから10分有効の見積もりを作成する。数量1、セットと単品の重複は拒否する。
2. 利用規約・返金条件への同意後に模擬決済を要求する。規約版は `local-2026-10-01`。
3. 商品の公開状態・revision・ファイル版・価格・クーポン上限を再照合する。変更・失効時は409で再確認を要求する。
4. failureは402を返し注文を作らない。successはpaid注文・明細・規約同意・予定通知を同じトランザクションで保存する。実際の入金は照合しない。
5. 同じ操作キー・本文の再送は同じ注文を返す。キーが同じでも本文が異なる場合は409。同じ見積もりの別キー消費も拒否する。
6. ダウンロード発行時と取得時に同じブラウザのpaid注文を確認する。APIトークン方式であり、外部ストレージの署名付きURLではない。
7. 管理者の模擬返金はpaid → refunded。理由・時刻・監査・予定通知を保存し、発行済みトークンを削除する。返金済みの再要求は返金を繰り返さない。実決済の返金要求中・失敗・異議申し立ては未実装。

商品はdraft／published／stopped。問い合わせはopen／handling／closed。通知はpending → savedで、5秒周期に期限の到来した予定通知を処理します。失敗の模擬では指数バックオフ、最大8回でfailed。手動retryでpendingへ戻します。savedは「ローカル保存完了」であり「外部メール送信成功」ではありません。通知IDは購入・返金・問い合わせごとに固定して重複作成を防ぎます。

クーポンは期限・割引率・利用上限をサーバーで判定し、注文と同じトランザクションで消費します。返金しても利用回数は戻しません。全paid注文を対象に購入済みを判定し、商品画面から元の注文へ案内します。セット内の一部でも購入済みなら重複購入を拒否します。見積もり時と注文確定時の両方で確認し、古い見積もりによる再購入も防ぎます。返金・リセット後は対象から外れます。

## 保護・運用・移行

- CookieはHttpOnly・SameSite=Strict。ローカルHTTPのためSecure属性は未設定。本番HTTPS対応は今後の実装。
- 回数制限はメモリ上の1分窓。セッション全体300回、ログインは接続元IPで10回、問い合わせはセッション5回・IP30回、ダウンロードは発行と取得合算で30回、アップロード10回、分析60回。再起動でカウンタはリセットされる。
- PPTXは50MB、ZIP展開合計100MB、1500エントリ、1〜200ページまで。マクロ・埋め込みファイル・危険なパスを拒否し、未検証のSVGはアップロードしない。ClamAV接続を実装。autoは実行ファイル不在なら未検査、requiredは未完了を拒否、offはdisabledとして記録する。定義不足・実行失敗は503、問題検出は400で登録を拒否する。既存の同じ版の検出結果も記録し、infectedは購入・公開・ダウンロード・プレビューを拒否する。
- 初期SQLite版の注文には現在のファイルで版を固定する。過去時点の版は復元できない。既存Cookieを引き継ぐが、localStorageだけのデモ注文は移行しない。
- リセットは自分のorders・items・取得トークンを削除し、orderMetaをresetにする。通知・問い合わせ・監査・お気に入りは残す。
- `npm run backup` は稼働中もSQLiteのバックアップAPIを利用できる。`npm run restore -- バックアップ名` と `npm run admin:reset` はサーバー停止後に実行する。復元前に現在のデータも退避する。
- 復元はDBとファイルのSHA-256、SQLite整合性・外部キー、商品と購入時ファイルの存在を検証する。バックアップにはDB内の管理資格情報も含むが、パスワードの平文ファイルは含まない。復元後に平文ファイルとDBの資格情報が異なる場合はadmin:resetで再発行する。
- `SHOP_DATA_DIR`、`SHOP_FILE_DIR`、`SHOP_BACKUP_DIR` で保存先を指定できる。`LOCAL_ADMIN_PASSWORD` と `LOCAL_EDITOR_PASSWORD` は資格情報の初回作成時のみ参照する。機密値をGitへ保存しない。
- 商品別SEOはビルド時点の公開商品から生成する。DBが未初期化ならJSONを使う。既定のrobots.txtは全体のクロールを禁止。SITE_URLを指定したビルドでは通常のサイトマップを生成するが、これだけで本番運用の準備が完了するわけではない。

- 自動バックアップは5秒周期の確認で初回と以後24時間ごと、直近7件を保持。停止中は実行しない。`SHOP_BACKUP_INTERVAL_MS=0` で無効、`SHOP_BACKUP_KEEP` は1〜365。自動分のみ削除し、手動分は保持する。失敗時は最大5分後に再試行し、maintenance文書と運用画面で状態を確認する。
- バックアップはMFA秘密情報も含む。TOTPのローカル確認は `npm run admin:otp`（editorは `-- editor`）。同じ端末の生成は独立した第二要素ではない。紛失時のadmin:resetはMFA・復旧コードと管理セッションも解除する。

- 外部参照・XML実体を変換前に拒否する。変換はシェルを使わず実行し、各ツール90秒で打ち切る。管理APIの処理は同時に1件、競合はASSET_BUSY。変換は一時プロファイルでマクロを無効化するが、OS隔離は未実装。
- `npm run backup:list` で一覧、`backup:check -- 名前` で検証、`restore:drill -- 名前` で一時領域へコピーして再検証する。稼働中のデータは変更しない。画像キャッシュはバックアップ対象外、必要なら復元後に再生成する。
- ツール設定・検査モード・定義準備・復元確認は [ローカル運用手順](local-operations.md) を参照する。

## 検証と今後の拡張

`npm run build`、`npm run test:server`、`CHROMIUM_PATH=/usr/bin/chromium npm test` を使用します。2026年10月1日にPC／モバイル計14件、サーバー・ファイル処理テスト10件、実無料ツール確認2件（24ページのPNG生成・ClamAVの無害な検証定義による検出）を確認済み。公式ウイルス定義の取得・更新はこの環境では未確認。ブラウザテストは一時DBとテスト用資格情報を使うため、普段の開発サーバーを停止してから実行します。

今後はメール本人確認・端末間共有・実決済と入金照合・外部配信・本番ストレージ・実販売の税と領収書・販売者情報・ウイルス定義の更新と変換プロセスのOS隔離・外部監視・別媒体へのバックアップ保管を整備します。カーソルページング、codeとrequestId付きエラー、利用許諾本文のスナップショットはローカル実装済みです。専用テーブルへの正規化は本番拡張案です。

## 本番決済の採用方針（2026年10月1日）

実販売向けの決済代行サービスは **KOMOJU** を採用する方針とし、支払方法は **PayPay・クレジットカードのみ** とします。KOMOJUのホスト型決済画面を利用し、サーバーで検証済みWebhookと決済照会により入金を確認してから購入権限を付与します。詳細と導入前の確認事項は[本番向け基本設計書](production-basic-design.html#scope)に記載しています。契約・審査・実決済連携は未実施で、現在のローカル模擬決済の動作は変更していません。
