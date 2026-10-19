import {test,expect} from '@playwright/test';
test('お気に入り・並び替え・問い合わせ・管理画面・ローカル通知',async({page})=>{
 await page.goto('/');await expect(page.locator('.card')).toHaveCount(6);
 await page.getByLabel('並び替え').selectOption('low');await expect(page.locator('.card').first()).toContainText('プロジェクト進捗報告');
 await page.getByRole('button',{name:'企画提案スライドをお気に入りに追加',exact:true}).click();
 await page.getByRole('checkbox',{name:'お気に入りだけ'}).check();await expect(page.locator('.card')).toHaveCount(1);
 await page.reload();await page.getByRole('checkbox',{name:'お気に入りだけ'}).check();await expect(page.locator('.card')).toHaveCount(1);
 await page.getByRole('link',{name:'お問い合わせ',exact:true}).click();
 const note='画面テスト-'+crypto.randomUUID().slice(0,8);
 await page.getByLabel('メール',{exact:true}).fill('ui@example.test');await page.getByLabel('お問い合わせ内容').fill(note);await page.getByRole('button',{name:'問い合わせを保存する'}).click();await expect(page.getByRole('status').filter({hasText:'受付番号'})).toBeVisible();
 await page.getByRole('link',{name:'ローカル管理',exact:true}).click();
 await page.getByLabel('管理用パスワード').fill('local-test-admin-only');await page.getByRole('button',{name:'管理者ログイン'}).click();await expect(page.getByRole('button',{name:'ログアウト'})).toBeVisible();
 await page.getByRole('button',{name:'問い合わせ',exact:true}).click();const inquiry=page.locator('.panel').filter({hasText:note});await expect(inquiry).toBeVisible();await inquiry.getByLabel('対応状況').selectOption('closed');await expect(inquiry.getByLabel('対応状況')).toHaveValue('closed');
 await page.getByRole('button',{name:'通知',exact:true}).click();await page.getByRole('button',{name:'予定通知をローカル保存'}).click();const notification=page.locator('.panel').filter({hasText:note});await expect(notification).toContainText('saved');
 await page.getByRole('button',{name:'商品',exact:true}).click();await page.getByRole('button',{name:'商品を新規登録'}).click();
 await page.getByLabel('商品ID',{exact:true}).fill('ui-'+crypto.randomUUID().slice(0,8));await page.getByLabel('商品名',{exact:true}).fill('UI検証用下書き');await page.getByLabel('説明',{exact:true}).fill('非公開の商品を登録するテスト');await page.getByLabel('税込デモ価格（円）').fill('900');await page.getByRole('button',{name:'商品を保存',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'商品を保存'})).toBeVisible();
 await page.locator('input[type=file]').setInputFiles('private/downloads/proposal.pptx');await expect(page.getByRole('status').filter({hasText:'PPTXを検証して登録'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.getByRole('button',{name:'画像プレビュー生成・ウイルス検査',exact:true}).click();await expect(page.getByRole('status').filter({hasText:'ファイル処理が完了'})).toBeVisible();
 await page.getByRole('button',{name:'運用・分析',exact:true}).click();await expect(page.getByRole('heading',{name:'運用状況'})).toBeVisible();
 await page.getByRole('button',{name:'ログアウト'}).click();await expect(page.getByRole('button',{name:'管理者ログイン'})).toBeVisible();
 await page.locator('select[name=role]').selectOption('editor');await page.getByLabel('管理用パスワード').fill('local-test-editor-only');await page.getByRole('button',{name:'管理者ログイン'}).click();
 await expect(page.getByRole('button',{name:'認証設定',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'注文・返金',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'ログアウト'}).click();await expect(page.getByRole('button',{name:'管理者ログイン'})).toBeVisible();
});

test('模擬返金は再認証し、返金後に再購入できる',async({page})=>{
 await page.goto('/');await page.getByRole('button',{name:'営業提案スライドをカートに追加',exact:true}).click();await page.goto('/#checkout');
 await page.getByRole('checkbox',{name:'利用規約・利用許諾'}).check();await page.getByRole('button',{name:'デモ購入を確定する'}).click();await expect(page.getByRole('heading',{name:'デモ購入が完了しました。'})).toBeVisible();
 const order=(await page.locator('.order-id').innerText()).split('\n')[0].replace('注文番号：','');
 await page.goto('/#admin');await page.getByLabel('管理用パスワード').fill('local-test-admin-only');await page.getByRole('button',{name:'管理者ログイン'}).click();await page.getByRole('button',{name:'注文・返金',exact:true}).click();
 await page.getByLabel('注文検索').fill(order);await page.getByRole('button',{name:'検索',exact:true}).click();const panel=page.locator('article.panel').filter({hasText:order});await expect(panel).toHaveCount(1);
 await panel.getByLabel('返金理由').fill('ローカル再認証の検証');await panel.getByLabel('返金確認用パスワード').fill('incorrect-test-password');page.once('dialog',d=>d.accept());await panel.getByRole('button',{name:'全額模擬返金'}).click();await expect(page.getByRole('alert')).toContainText('確認番号');await expect(panel).toContainText('paid');
 await panel.getByLabel('返金確認用パスワード').fill('local-test-admin-only');page.once('dialog',d=>d.accept());await panel.getByRole('button',{name:'全額模擬返金'}).click();await expect(page.getByRole('status').filter({hasText:'模擬返金しました'})).toBeVisible();await expect(panel).toContainText('refunded');
 await page.goto('/#order/'+order);await expect(page.getByRole('heading',{name:'デモ注文は返金済みです。'})).toBeVisible();await expect(page.getByRole('link',{name:'ダウンロード ↓'})).toHaveCount(0);
 await page.goto('/');await expect(page.getByRole('button',{name:'営業提案スライドをカートに追加',exact:true})).toBeEnabled();
});
