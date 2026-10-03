import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { openStore, TERMS_VERSION, MAX_FILE_SIZE, matchesPassword, hash } from './storage.mjs';
import { generateTotpSecret, verifyTotp, newRecoveryCodes } from './security.mjs';
import { legalSnapshot, legalTexts } from './legal.mjs';
import { saveBackup, pruneAutomaticBackups } from './backups.mjs';
import { pageParameters, encodeCursor } from './pagination.mjs';
import { assetConfig, prepareAsset, toolStatus, AssetError } from './assets.mjs';
import { receiptSnapshot, receiptHtml } from './receipts.mjs';
import {openRemoteStore} from './remote-storage.mjs';
import {withMemoryState} from './memory-state.mjs';
import {createGoogleAuth} from './google-auth.mjs';
class HttpError extends Error {
    constructor(status, message, code, details) { super(message); this.status = status; this.code = code; this.details = details; }
}
const fail = (status, message, code, details) => { throw new HttpError(status, message, code, details); };
const text = (value, max = 200) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const safeId = id => typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id);
const escapeXml = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
export function createShop({ dataDir = resolve(process.env.SHOP_DATA_DIR || 'data'), fileDir = resolve(process.env.SHOP_FILE_DIR || 'private/downloads'), now = () => Date.now(), tokenTtl = 300000, quoteTtl = 600000, backupsDir = resolve(process.env.SHOP_BACKUP_DIR || 'backups'), backupInterval = Number(process.env.SHOP_BACKUP_INTERVAL_MS || 86400000), backupKeep = Number(process.env.SHOP_BACKUP_KEEP || 7), assets = assetConfig(), storageMode = process.env.SHOP_STORAGE || 'local', remote = {}, google = undefined, memorySessions = process.env.SHOP_SESSION_MODE === 'memory', siteUrl = process.env.SITE_URL } = {}) {
    if(!['local','starserver'].includes(storageMode))throw new Error('SHOP_STORAGEはlocalまたはstarserverを指定してください。');
    const oauth=google===undefined?createGoogleAuth({now,origin:siteUrl}):google;
    if(storageMode==='starserver'&&!oauth)throw new Error('StarServer構成ではGoogle認証を設定してください。');
    const useMemory=memorySessions||storageMode==='starserver'||!!oauth;
    const secure=siteUrl?.startsWith('https://')||storageMode==='starserver';
    const cookie=(res,token)=>res.setHeader('Set-Cookie',`slide_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${secure?'; Secure':''}`);
    if (!Number.isSafeInteger(backupInterval) || backupInterval < 0 || !Number.isInteger(backupKeep) || backupKeep < 1 || backupKeep > 365)
        throw new Error('バックアップ設定が不正です。');
    const pidFile = resolve(dataDir, 'server.pid');
    if (storageMode==='local' && existsSync(pidFile)) {
        let alive = false;
        try {
            process.kill(Number(readFileSync(pidFile, 'utf8')), 0);
            alive = true;
        }
        catch { }
        if (alive)
            throw new Error('このデータベースを使うローカルサーバーは既に起動しています。');
    }
    const durable = storageMode==='starserver'?openRemoteStore(remote):openStore(dataDir,fileDir);
    mkdirSync(dataDir,{recursive:true,mode:0o700});
    const store = useMemory?withMemoryState(durable,{now}):durable;
    if(storageMode==='local')writeFileSync(pidFile, String(process.pid), { mode: 0o600 });
    const { db, get, list, put, tx, snapshot } = store;
    const limits = new Map();
    let tools = null;
    let assetBusy = false;
    const json = (res, status, body) => { res.setHeader('X-Request-Id', res.shopRequestId || randomUUID()); if (status >= 400)
        body = { ...body, code: body.code || ({ 400: 'INVALID_INPUT', 401: 'UNAUTHORIZED', 402: 'DEMO_PAYMENT_FAILED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 405: 'METHOD_NOT_ALLOWED', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 429: 'RATE_LIMITED' }[status] || 'INTERNAL_ERROR'), requestId: res.shopRequestId }; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(body)); };
    const audit = async (actor, action, target, reason = '') => { const id = randomUUID(); await put('audit', id, { id, actor, action, target, reason, date: new Date(now()).toISOString() }); };
    const notification = async (id, subject, body) => { if (!await get('notifications', id))
        await put('notifications', id, { id, subject, body, status: 'pending', attempts: 0, date: new Date(now()).toISOString(), nextRun: now() }); };
    async function deliver(simulateFailure = false) {
        for (const n of await list('notifications'))
            if (n.status === 'pending' && n.nextRun <= now()) {
                n.attempts++;
                if (simulateFailure) {
                    n.status = n.attempts >= 8 ? 'failed' : 'pending';
                    n.nextRun = now() + Math.min(3600000, 1000 * 2 ** n.attempts);
                    n.error = 'ローカル通知の失敗を模擬';
                }
                else {
                    n.status = 'saved';
                    n.savedAt = new Date(now()).toISOString();
                    delete n.error;
                }
                await put('notifications', n.id, n);
            }
    }
    let closing = false, backupRunning = null;
    async function maintenance() {
        if (closing || store.remote || !backupInterval)
            return;
        if (backupRunning)
            return backupRunning;
        const state = await get('maintenance', 'backup') || {}, last = state.status === 'running' ? 0 : state.attemptedAt || 0;
        if (last && now() - last < (state.status === 'failed' ? Math.min(backupInterval, 300000) : backupInterval))
            return;
        state.attemptedAt = now();
        state.status = 'running';
        await put('maintenance', 'backup', state);
        backupRunning = (async () => { try {
            const result = await saveBackup({ dataDir, fileDir, backupsDir, automatic: true, now: now() });
            pruneAutomaticBackups(backupsDir, backupKeep);
            state.status = 'ok';
            state.lastBackup = result.name;
            state.savedAt = now();
            delete state.error;
        }
        catch {
            state.status = 'failed';
            state.error = '自動バックアップに失敗しました。保存先とディスク容量を確認してください。';
        }
        finally {
            if (!closing)
                await put('maintenance', 'backup', state);
            backupRunning = null;
        } })();
        return backupRunning;
    }
    const timer = setInterval(async () => { try {
        store.sweep?.();oauth?.sweep();
        await deliver();
        void maintenance().catch(() => { });
    }
    catch { /* DBが復旧した次回に再試行 */ } }, 5000);
    timer.unref();
    const hydrate = async (row) => { const meta = await get('orderMeta', row.id) || { status: 'paid', lines: [] }; return { id: row.id, date: row.date, total: row.total, ...meta, items: meta.lines.map(i => i.product_id) }; };
    const owned = async (session, id) => { const row = await db.prepare('SELECT * FROM orders WHERE id=? AND session_id=?').get(id, session); if (!row)
        fail(404, '注文が見つかりません。'); return await hydrate(row); };
    const expose = async p => {
        const v=await get('versions',p.version||(p.bundle.length?(await get('products',p.bundle[0]))?.version:null));
        const image=v?.preview?.status==='ready'&&(store.remote||existsSync(resolve(dataDir,'previews',v.id,'0.png')));
        return {...p,fileSize:v?.size||0,pageCount:v?.pages||0,previewCount:Math.min(image?v.preview.pages:v?.texts?.length||1,12),previewMode:image?'image':'text',scanStatus:v?.scan?.status||'unscanned'};
    };
    const readVersion=async version=>store.remote?store.readVersion(version):readFileSync(resolve(fileDir,'versions',`${version}.pptx`));
    async function checkPublication(value){
        if(value.status!=='published')return;
        if(!value.version&&!value.bundle.length)fail(409,'公開前にPPTXを登録してください。');
        for(const id of value.bundle.length?value.bundle:[value.id]){
            const product=value.bundle.length?await get('products',id):value;
            if(!product?.version||product.bundle.length)fail(409,'構成商品が変更されています。読み直してください。');
            const version=await get('versions',product.version);
            if(version?.scan?.status==='infected')fail(409,'検査で問題を検出したファイルは公開できません。','FILE_REJECTED');
            if(assets.mode==='required'&&version?.scan?.status!=='clean')fail(409,'公開前にウイルス検査を完了してください。','SCAN_REQUIRED');
        }
    }
    const rate = (key, max) => { if (limits.size > 10000)
        for (const [k, v] of limits)
            if (v.until < now())
                limits.delete(k); const current = limits.get(key); const value = current && current.until > now() ? current : { count: 0, until: now() + 60000 }; value.count++; limits.set(key, value); if (value.count > max)
        fail(429, '操作が多すぎます。1分後に再度お試しください。'); };
    const body = async (req) => { let length = 0; const chunks = []; for await (const chunk of req) {
        length += chunk.length;
        if (length > (/\/products\/[^/]+\/file$/.test(req.url) ? MAX_FILE_SIZE * 1.4 + 8192 : 16384))
            fail(413, 'データが大きすぎます。');
        chunks.push(chunk);
    } try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString());
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
            fail(400, '入力が不正です。');
        return parsed;
    }
    catch {
        fail(400, '入力が不正です。');
    } };
    async function selection(ids) {
        if (!Array.isArray(ids) || !ids.length || ids.length > 30 || ids.some(id => !safeId(id)))
            fail(400, '商品を選んでください。');
        const selected = await Promise.all([...new Set(ids)].sort().map(async (id) => await get('products', id)));
        if (selected.some(p => !p || p.status !== 'published'))
            fail(409, '商品が販売停止または変更されています。');
        const files = new Map();
        for (const p of selected) {
            for (const id of p.bundle.length ? p.bundle : [p.id]) {
                const f = await get('products', id);
                if (!f?.version || f.status !== 'published')
                    fail(409, '構成商品が非公開またはファイル未登録です。');
                if ((await get('versions', f.version))?.scan?.status === 'infected')
                    fail(409, '検査で問題を検出したファイルは購入できません。', 'FILE_REJECTED');
                if (assets.mode === 'required' && (await get('versions', f.version))?.scan?.status !== 'clean')
                    fail(409, 'ウイルス検査完了前の商品は購入できません。', 'SCAN_REQUIRED');
                if (files.has(id))
                    fail(409, 'セットと単品で同じ商品が重複しています。カートを確認してください。');
                files.set(id, { product_id: id, name: f.name, price: f.price, version: f.version });
            }
        }
        return { selected, lines: [...files.values()], subtotal: selected.reduce((sum, p) => sum + p.price, 0) };
    }
    async function price(ids, code) {
        const chosen = await selection(ids);
        let discount = 0;
        if (code) {
            const coupon = await get('coupons', code);
            if (!coupon || !coupon.active || coupon.expires <= now() || coupon.used >= coupon.limit)
                fail(409, 'クーポンが無効または利用上限に達しています。');
            discount = Math.min(chosen.subtotal, Math.floor(chosen.subtotal * coupon.percent / 100));
        }
        return { ...chosen, discount, total: chosen.subtotal - discount };
    }
    async function checkDownload(session, id, pid) { const order = await owned(session, id); const line = order.lines.find(i => i.product_id === pid); if (order.status !== 'paid' || !line || (await get('versions', line.version))?.scan?.status === 'infected')
        fail(404, 'ダウンロード権限がありません。'); return line; }
    async function authenticate(role, data) {
        await tx(async()=>{
        const c = await get('credentials', role);
        if (!c || !matchesPassword(data.password, c))
            fail(401, '管理用パスワードが一致しません。', 'BAD_CREDENTIALS');
        if (c.totpSecret) {
            const step = verifyTotp(c.totpSecret, data.code, now(), c.lastStep ?? -1);
            const recovery = typeof data.code === 'string' ? hash(data.code.trim().toUpperCase()) : '';
            const index = c.recoveryHashes?.indexOf(recovery) ?? -1;
            if (step === null && index < 0)
                fail(401, '新しい認証コードまたは未使用の復旧コードを入力してください。', 'MFA_REQUIRED');
            if (step !== null)
                c.lastStep = step;
            else
                c.recoveryHashes.splice(index, 1);
            await put('credentials', role, c);
        }
        });
    }
    async function purchased(session) {
        const rows = await db.prepare(`SELECT i.product_id,o.id,o.date,i.name,i.price FROM items i JOIN orders o ON o.id=i.order_id JOIN documents m ON m.kind='orderMeta' AND m.id=o.id WHERE o.session_id=? AND json_extract(m.value,'$.status')='paid' ORDER BY o.date DESC,o.id DESC`).all(session);
        const result = {};
        for (const row of rows)
            if (!result[row.product_id])
                result[row.product_id] = { orderId: row.id, name: row.name };
        return result;
    }
    async function rejectPurchased(session, lines) { const all = await purchased(session), overlap = lines.filter(i => all[i.product_id]).map(i => ({ productId: i.product_id, ...all[i.product_id] })); if (overlap.length)
        fail(409, '購入済みの資料が含まれています。注文履歴から再ダウンロードしてください。', 'ALREADY_PURCHASED', { purchases: overlap }); }
    async function orderPage(url, session) {
        let params;
        try {
            params = pageParameters(url);
        }
        catch (e) {
            fail(400, e.message, 'INVALID_CURSOR');
        }
        const { limit, cursor } = params, where = [], args = [];
        if (session) {
            where.push('o.session_id=?');
            args.push(session);
        }
        const query = (url.searchParams.get('q') || '').toLowerCase();
        if (query) {
            where.push("(instr(lower(o.id || ' ' || COALESCE(json_extract(m.value,'$.status'),'') || ' ' || COALESCE(m.value,'')),?)>0)");
            args.push(query);
        }
        if (cursor) {
            where.push('(o.date < ? OR (o.date = ? AND o.id < ?))');
            args.push(cursor.date, cursor.date, cursor.id);
        }
        const rows = await db.prepare(`SELECT o.* FROM orders o LEFT JOIN documents m ON m.kind='orderMeta' AND m.id=o.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY o.date DESC,o.id DESC LIMIT ?`).all(...args, limit + 1), items = rows.slice(0, limit);
        return { items: await Promise.all(items.map(hydrate)), nextCursor: rows.length > limit ? encodeCursor(items[items.length - 1]) : null };
    }
    const close = () => { closing = true; clearInterval(timer); const finish = () => { db.close(); if(storageMode==='local')rmSync(pidFile, { force: true }); }; if (backupRunning)
        return backupRunning.finally(finish); finish(); };
    return { close, store, maintenance, async handle(req, res, next) {
            res.shopRequestId = randomUUID();
            let url;
            try {
                url = new URL(req.url, 'http://localhost');
            }
            catch {
                return json(res, 400, { message: 'URLが不正です。' });
            }
            if (!url.pathname.startsWith('/api/'))
                return next();
            let session, sessionToken, role = 'guest';
            try {
                if (!['GET', 'POST', 'PATCH', 'DELETE'].includes(req.method))
                    fail(405, '許可されていない操作です。');
                if (req.method !== 'GET' && (req.headers['sec-fetch-site'] === 'cross-site' || (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host)))
                    fail(403, 'アクセスを拒否しました。');
                session = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('slide_session='))?.slice(14);
                let auth = session ? await db.prepare('SELECT * FROM local_sessions WHERE id=?').get(session) : null;
                if (!auth || auth.expires <= now()) {
                    // 初期版からの既存ブラウザCookieは、既存のデモ注文を引き継ぐ。
                    const legacy = !useMemory && !auth && typeof session === 'string' && /^[a-f0-9]{64}$/.test(session) && await db.prepare('SELECT id FROM sessions WHERE id=?').get(session);
                    if (!legacy)
                        session = randomBytes(32).toString('hex');
                    const csrf = randomBytes(32).toString('hex');
                    if(!oauth)await db.prepare('INSERT OR IGNORE INTO sessions VALUES (?)').run(session);
                    await db.prepare('INSERT INTO local_sessions VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET role=excluded.role,expires=excluded.expires,csrf=excluded.csrf').run(session, 'guest', now() + 2592000000, csrf);
                    auth = { role: 'guest', csrf };
                    cookie(res,session);
                }
                sessionToken=session;
                const user=store.users?.get(sessionToken)||null;
                session=user?.id||sessionToken;
                role = auth.role;
                // Cookie認証の更新には必ずCSRFトークン。APIクライアントも /api/session で取得する。
                if (req.method !== 'GET' && req.headers['x-csrf-token'] !== auth.csrf)
                    fail(403, 'セッションが失効したか、確認トークンが一致しません。必要なら再ログインして操作をやり直してください。','SESSION_EXPIRED');
                rate(`session:${session}`, 300);
                if (url.pathname.startsWith('/api/admin/') && url.pathname !== '/api/admin/login') {
                    if (!['admin', 'editor'].includes(role))
                        fail(403, '管理者ログインが必要です。');
                    if (role === 'editor' && !url.pathname.startsWith('/api/admin/products') && !['/api/admin/logout', '/api/admin/reauth'].includes(url.pathname) && !url.pathname.startsWith('/api/admin/security/'))
                        fail(403, 'この操作の権限がありません。');
                }
                const method = req.method, path = url.pathname;
                if (method === 'GET' && path === '/api/session')
                    return json(res, 200, { role, csrf: auth.csrf, termsVersion: TERMS_VERSION, user:user?{id:user.id,name:user.name}:null, googleEnabled:!!oauth, loginRequired:!!oauth, storage:storageMode, sessionMode:useMemory?'memory':'persistent' });
                if(method==='GET'&&path==='/api/auth/google/start'){
                    if(!oauth)fail(503,'Google認証は未設定です。','GOOGLE_NOT_CONFIGURED');
                    if(req.headers['sec-fetch-site']==='cross-site')fail(403,'サイト内のログインボタンから開始してください。');
                    rate(`oauth:${req.socket.remoteAddress}`,20);
                    const requested=url.searchParams.get('returnTo')||'/#history';
                    const returnTo=/^\/#(?:home|cart|checkout|history)$/.test(requested)?requested:'/#history';
                    res.writeHead(302,{Location:oauth.start(sessionToken,returnTo),'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();
                }
                if(method==='GET'&&path==='/api/auth/google/callback'){
                    if(!oauth)fail(503,'Google認証は未設定です。','GOOGLE_NOT_CONFIGURED');
                    const identity=await oauth.finish(url.searchParams,sessionToken);
                    await tx(async()=>{
                        await db.prepare('INSERT OR IGNORE INTO sessions VALUES (?)').run(identity.user.id);
                        await put('users',identity.user.id,identity.user);
                    });
                    const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
                    await db.prepare('DELETE FROM local_sessions WHERE id=?').run(sessionToken);
                    await db.prepare('DELETE FROM download_tokens WHERE session_id=?').run(sessionToken);
                    store.users.delete(sessionToken);
                    await db.prepare('INSERT INTO local_sessions VALUES (?,?,?,?)').run(token,'guest',now()+2592000000,csrf);
                    store.users.set(token,identity.user);cookie(res,token);
                    res.writeHead(302,{Location:identity.returnTo,'Cache-Control':'no-store','Referrer-Policy':'no-referrer'});return res.end();
                }
                if(method==='POST'&&path==='/api/auth/logout'){
                    await db.prepare('DELETE FROM local_sessions WHERE id=?').run(sessionToken);
                    await db.prepare('DELETE FROM download_tokens WHERE session_id=?').run(sessionToken);
                    store.users?.delete(sessionToken);
                    await store.remove('reauth',sessionToken);await store.remove('mfaPending',sessionToken);
                    const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
                    await db.prepare('INSERT INTO local_sessions VALUES (?,?,?,?)').run(token,'guest',now()+2592000000,csrf);
                    if(!oauth)await db.prepare('INSERT OR IGNORE INTO sessions VALUES (?)').run(token);
                    cookie(res,token);return json(res,200,{role:'guest',csrf,user:null});
                }
                if(oauth&&!user&&((method==='POST'&&['/api/quotes','/api/orders','/api/favorites'].includes(path))||(method==='DELETE'&&(path==='/api/orders'||path.startsWith('/api/favorites/')))))fail(401,'購入・お気に入りの保存にはGoogleでログインしてください。','LOGIN_REQUIRED');
                if (method === 'POST' && path === '/api/admin/login') {
                    rate(`login:${req.socket.remoteAddress}`, 10);
                    const data = await body(req);
                    const wanted = data.role === 'editor' ? 'editor' : 'admin';
                    await authenticate(wanted, data);
                    const csrf = randomBytes(32).toString('hex');
                    await db.prepare('UPDATE local_sessions SET role=?,csrf=?,expires=? WHERE id=?').run(wanted, csrf, now() + 3600000, sessionToken);
                    await audit(session, 'login', wanted);
                    await store.remove('reauth', sessionToken);
                    return json(res, 200, { role: wanted, csrf });
                }
                if (method === 'POST' && path === '/api/admin/reauth') {
                    rate(`reauth:${session}`, 10);
                    await authenticate(role, await body(req));
                    const expiresAt = now() + 300000;
                    await put('reauth', sessionToken, { role, expiresAt });
                    await audit(session, 'reauth', role);
                    return json(res, 200, { expiresAt });
                }
                if (method === 'GET' && path === '/api/admin/security/status') {
                    const c = await get('credentials', role);
                    return json(res, 200, { enabled: !!c.totpSecret, recoveryCodesRemaining: c.recoveryHashes?.length || 0 });
                }
                if (method === 'POST' && path === '/api/admin/security/mfa/setup') {
                    rate(`mfa:${session}`, 10);
                    if ((await get('credentials', role)).totpSecret)
                        fail(409, 'MFAは既に有効です。', 'MFA_ALREADY_ENABLED');
                    await authenticate(role, await body(req));
                    const secret = generateTotpSecret();
                    await put('mfaPending', sessionToken, { secret, role, expires: now() + 300000 });
                    return json(res, 200, { secret, uri: `otpauth://totp/Slide%20Market:${role}?secret=${secret}&issuer=Slide%20Market&algorithm=SHA1&digits=6&period=30` });
                }
                if (method === 'POST' && path === '/api/admin/security/mfa/confirm') {
                    rate(`mfa:${session}`, 10);
                    const d = await body(req), pending = await get('mfaPending', sessionToken);
                    if (!pending || pending.role !== role || pending.expires <= now())
                        fail(409, '設定が失効しました。やり直してください。');
                    const step = verifyTotp(pending.secret, d.code, now());
                    if (step === null)
                        fail(401, '認証コードを確認してください。', 'MFA_INVALID');
                    const codes = newRecoveryCodes();
                    await tx(async () => { const c = await get('credentials', role); if (c.totpSecret)
                        fail(409, 'MFAは既に有効です。'); c.totpSecret = pending.secret; c.lastStep = step; c.recoveryHashes = codes.map(hash); await put('credentials', role, c); await store.remove('mfaPending', sessionToken); await store.remove('reauth', sessionToken); await db.prepare("UPDATE local_sessions SET role='guest' WHERE role=? AND id<>?").run(role, sessionToken); await audit(session, 'mfa-enabled', role); });
                    return json(res, 200, { recoveryCodes: codes });
                }
                if (method === 'POST' && path === '/api/admin/security/mfa/disable') {
                    rate(`mfa:${session}`, 10);
                    await authenticate(role, await body(req));
                    const c = await get('credentials', role);
                    delete c.totpSecret;
                    delete c.lastStep;
                    delete c.recoveryHashes;
                    await tx(async () => { await put('credentials', role, c); await store.remove('reauth', sessionToken); await audit(session, 'mfa-disabled', role); });
                    return json(res, 200, { ok: true });
                }
                if (method === 'POST' && path === '/api/admin/logout') {
                    const csrf = randomBytes(32).toString('hex');
                    await db.prepare('UPDATE local_sessions SET role=?,csrf=? WHERE id=?').run('guest', csrf, sessionToken);
                    await store.remove('reauth', sessionToken);
                    await store.remove('mfaPending', sessionToken);
                    await audit(session, 'logout', role);
                    return json(res, 200, { role: 'guest', csrf });
                }
                if (method === 'GET' && path === '/api/legal')
                    return json(res, 200, { version: TERMS_VERSION, pages: legalTexts });
                if (method === 'GET' && path === '/api/purchases')
                    return json(res, 200, await purchased(session));
                if (method === 'GET' && path === '/api/products')
                    return json(res, 200, await Promise.all((await list('products')).filter(p => p.status === 'published').map(expose)));
                const preview = path.match(/^\/api\/products\/([a-zA-Z0-9-]+)\/previews\/(\d+)$/);
                if (method === 'GET' && preview) {
                    const p = await get('products', preview[1]);
                    if (!p || p.status !== 'published')
                        fail(404, '商品が見つかりません。');
                    const v = await get('versions', p.version || (p.bundle.length ? (await get('products', p.bundle[0]))?.version : null));
                    const index = Number(preview[2]);
                    if (!v || v.scan?.status === 'infected')
                        fail(404, 'プレビューがありません。');
                    const image = resolve(dataDir, 'previews', v.id, `${index}.png`);
                    if (v.preview?.status === 'ready' && index < v.preview.pages && (store.remote||existsSync(image))) {
                        const imageBytes=store.remote?await store.readPreview(v.id,index):readFileSync(image);
                        res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                        return res.end(imageBytes);
                    }
                    if (index >= v.texts.length)
                        fail(404, 'プレビューがありません。');
                    const lines = (v.texts[index] || p.name).match(/.{1,22}/gu)?.slice(0, 5) || [p.name];
                    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720" viewBox="0 0 1280 720"><rect width="1280" height="720" fill="#${p.color}"/><text x="65" y="80" fill="white" font-family="sans-serif" font-size="22">SLIDE MARKET / TEXT PREVIEW</text>${lines.map((line, i) => `<text x="65" y="${230 + i * 70}" fill="white" font-family="sans-serif" font-size="40">${escapeXml(line)}</text>`).join('')}<text x="65" y="670" fill="white" font-size="20">${index + 1} / ${v.pages} · 内容のテキストプレビュー</text></svg>`;
                    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'X-Content-Type-Options': 'nosniff' });
                    return res.end(svg);
                }
                if (method === 'GET' && path === '/api/favorites')
                    return json(res, 200, (await db.prepare('SELECT product_id FROM favorites WHERE session_id=?').all(session)).map(i => i.product_id));
                if (method === 'POST' && path === '/api/favorites') {
                    const d = await body(req);
                    if (!await get('products', d.productId))
                        fail(404, '商品がありません。');
                    await db.prepare('INSERT OR IGNORE INTO favorites VALUES (?,?)').run(session, d.productId);
                    return json(res, 200, { ok: true });
                }
                if (method === 'DELETE' && path.startsWith('/api/favorites/')) {
                    await db.prepare('DELETE FROM favorites WHERE session_id=? AND product_id=?').run(session, path.split('/').pop());
                    return json(res, 200, { ok: true });
                }
                if (method === 'POST' && path === '/api/metrics') {
                    rate(`metrics:${session}`, 60);
                    const d = await body(req);
                    if (!['view', 'cart', 'checkout'].includes(d.event))
                        fail(400, 'イベントが不正です。');
                    const day = new Date(now()).toISOString().slice(0, 10);
                    await db.prepare('INSERT INTO metrics VALUES (?,?,1) ON CONFLICT(day,event) DO UPDATE SET count=count+1').run(day, d.event);
                    return json(res, 200, { ok: true });
                }
                if (method === 'POST' && path === '/api/quotes') {
                    const d = await body(req);
                    const code = typeof d.coupon === 'string' ? d.coupon.trim().toUpperCase() : '';
                    const p = await price(d.items, code);
                    await rejectPurchased(session, p.lines);
                    const quote = { id: randomUUID(), session, items: [...new Set(d.items)].sort(), coupon: code, total: p.total, subtotal: p.subtotal, discount: p.discount, lines: p.lines, revisions: p.selected.map(i => ({ id: i.id, revision: i.revision })), expires: now() + quoteTtl, terms: TERMS_VERSION };
                    await put('quotes', quote.id, quote);
                    return json(res, 200, { ...quote, session: undefined });
                }
                if (method === 'GET' && path === '/api/orders')
                    return json(res, 200, await orderPage(url, session));
                const receipt = path.match(/^\/api\/orders\/([^/]+)\/receipt$/);
                if (method === 'GET' && receipt) {
                    const o = await owned(session, receipt[1]);
                    if (!o.receiptSnapshot)
                        fail(409, 'この旧注文には購入時の領収書データがありません。', 'RECEIPT_UNAVAILABLE');
                    const html = receiptHtml(o);
                    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', ...(url.searchParams.get('download') === '1' ? { 'Content-Disposition': `attachment; filename="demo-receipt.html"` } : {}) });
                    return res.end(html);
                }
                const detail = path.match(/^\/api\/orders\/([^/]+)$/);
                if (method === 'GET' && detail)
                    return json(res, 200, await owned(session, detail[1]));
                if (method === 'DELETE' && path === '/api/orders') {
                    await tx(async () => { for (const row of await db.prepare('SELECT id FROM orders WHERE session_id=?').all(session)) {
                        const meta = await get('orderMeta', row.id);
                        if (meta) {
                            meta.status = 'reset';
                            await put('orderMeta', row.id, meta);
                        }
                    } await db.prepare('DELETE FROM download_tokens WHERE session_id=?').run(session); await db.prepare('DELETE FROM orders WHERE session_id=?').run(session); });
                    return json(res, 200, { ok: true });
                }
                if (method === 'POST' && path === '/api/orders') {
                    const d = await body(req);
                    const key = req.headers['idempotency-key'];
                    if (!text(key, 100) || !safeId(d.quoteId) || !['success', 'failure'].includes(d.result) || d.termsVersion !== TERMS_VERSION || d.accepted !== true)
                        fail(400, '操作キー・規約への同意・決済結果を確認してください。');
                    const canonical = JSON.stringify({ quoteId: d.quoteId, result: d.result, terms: d.termsVersion });
                    const old = await db.prepare('SELECT * FROM orders WHERE session_id=? AND request_key=?').get(session, key);
                    if (old) {
                        if (old.request_body !== canonical)
                            fail(409, '同じ操作キーで異なる注文は作成できません。');
                        return json(res, 200, await hydrate(old));
                    }
                    const q = await get('quotes', d.quoteId);
                    if (!q || q.session !== session)
                        fail(404, '見積もりがありません。');
                    if (q.expires <= now() || q.orderId)
                        fail(409, '見積もりが失効しています。再確認してください。');
                    const p = await price(q.items, q.coupon);
                    if (p.total !== q.total || (await Promise.all(q.revisions.map(async (r) => (await get('products', r.id))?.revision !== r.revision))).some(Boolean) || JSON.stringify(p.lines) !== JSON.stringify(q.lines))
                        fail(409, '価格または商品が変更されました。再確認してください。');
                    await rejectPurchased(session, q.lines);
                    if (d.result === 'failure')
                        fail(402, 'デモ決済に失敗しました。成功を選択して、もう一度お試しください。');
                    const id = `DEMO-${randomUUID()}`, date = new Date(now()).toISOString();
                    await tx(async () => {
                        const current=await get('quotes',q.id);
                        if(!current||current.orderId||current.expires<=now())fail(409,'見積もりが失効しています。再確認してください。');
                        const checked=await price(q.items,q.coupon);
                        if(checked.total!==q.total||JSON.stringify(checked.lines)!==JSON.stringify(q.lines)||(await Promise.all(q.revisions.map(async r=>(await get('products',r.id))?.revision!==r.revision))).some(Boolean))fail(409,'価格または商品が変更されました。再確認してください。');
                        await rejectPurchased(session,q.lines);
                        await db.prepare('INSERT INTO orders VALUES (?,?,?,?,?,?)').run(id, session, date, q.total, key, canonical);
                        for (const line of q.lines)
                            await db.prepare('INSERT INTO items VALUES (?,?,?,?)').run(id, line.product_id, line.name, line.price);
                        await put('orderMeta', id, { status: 'paid', terms: TERMS_VERSION, licenseSnapshot: legalSnapshot(), receiptSnapshot: receiptSnapshot(q, p.selected, date, id), acceptedAt: date, discount: q.discount, lines: q.lines, purchasedProducts: q.items });
                        q.orderId = id;
                        await put('quotes', q.id, q);
                        if (q.coupon) {
                            const c = await get('coupons', q.coupon);
                            if (c.used >= c.limit)
                                fail(409, 'クーポンの利用上限に達しました。');
                            c.used++;
                            await put('coupons', c.code, c);
                        }
                        await notification(`purchase-${id}`, 'デモ購入完了', `注文番号：${id}\n合計：¥${q.total}\n${q.lines.map(i => i.name).join('\n')}\n注文履歴：/#history\n実際の請求・メール送信はありません。`);
                        const day = date.slice(0, 10);
                        await db.prepare('INSERT INTO metrics VALUES (?,?,1) ON CONFLICT(day,event) DO UPDATE SET count=count+1').run(day, 'purchase');
                    });
                    return json(res, 201, await hydrate(await db.prepare('SELECT * FROM orders WHERE id=?').get(id)));
                }
                const issue = path.match(/^\/api\/orders\/([^/]+)\/download-links\/([^/]+)$/);
                if (method === 'POST' && issue) {
                    rate(`download:${session}`, 30);
                    await checkDownload(session, issue[1], issue[2]);
                    const token = randomBytes(32).toString('hex'), expires = now() + tokenTtl;
                    await db.prepare('INSERT INTO download_tokens VALUES (?,?,?,?,?)').run(hash(token), sessionToken, issue[1], issue[2], expires);
                    return json(res, 200, { url: `/api/downloads/${token}`, expiresAt: expires });
                }
                const download = path.match(/^\/api\/downloads\/([a-f0-9]{64})$/);
                if (method === 'GET' && download) {
                    rate(`download:${session}`, 30);
                    const token = await db.prepare('SELECT * FROM download_tokens WHERE token_hash=? AND session_id=? AND expires>?').get(hash(download[1]), sessionToken, now());
                    if (!token)
                        fail(404, 'リンクが失効しています。注文履歴から再発行してください。');
                    const line = await checkDownload(session, token.order_id, token.product_id);
                    const bytes = await readVersion(line.version);
                    // A remote fetch can take time: honor a refund made during it.
                    if(store.remote)await checkDownload(session,token.order_id,token.product_id);
                    res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'Content-Disposition': `attachment; filename="slide.pptx"; filename*=UTF-8''${encodeURIComponent(line.name + '.pptx')}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
                    return res.end(bytes);
                }
                if (method === 'POST' && path === '/api/inquiries') {
                    rate(`inquiry:${session}`, 5);
                    rate(`inquiry-ip:${req.socket.remoteAddress}`, 30);
                    const d = await body(req);
                    if (typeof d.email !== 'string' || d.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email) || !text(d.body, 4000) || !['download', 'product', 'other'].includes(d.category))
                        fail(400, 'メール・本文・カテゴリを確認してください。');
                    if (d.orderId && (!text(d.orderId, 100) || !await db.prepare('SELECT id FROM orders WHERE id=? AND session_id=?').get(d.orderId, session)))
                        fail(404, '注文番号を確認してください。');
                    const id = randomUUID();
                    await tx(async () => { await put('inquiries', id, { id, email: d.email, body: d.body, category: d.category, orderId: d.orderId || '', status: 'open', date: new Date(now()).toISOString() }); await notification(`inquiry-${id}`, '問い合わせ受付', `受付番号：${id}\nカテゴリ：${d.category}\n${d.body}\n外部メールは送信していません。`); });
                    return json(res, 201, { id });
                }
                if (method === 'GET' && path === '/api/admin/products')
                    return json(res, 200, await Promise.all((await list('products')).map(expose)));
                if (['POST', 'PATCH'].includes(method) && (/^\/api\/admin\/products(?:\/[a-zA-Z0-9-]+)?$/.test(path))) {
                    const d = await body(req), id = method === 'POST' ? d.id : path.split('/').pop(), existing = await get('products', id);
                    if (!safeId(id) || !text(d.name, 100) || !text(d.description, 2000) || !text(d.category, 60) || !Number.isSafeInteger(d.price) || d.price < 0 || d.price > 10000000 || !['draft', 'published', 'stopped'].includes(d.status))
                        fail(400, '商品情報を確認してください。');
                    if (method === 'POST' && existing)
                        fail(409, '商品IDが既に存在します。');
                    if (method === 'PATCH' && (!existing || existing.revision !== d.revision))
                        fail(409, '他の操作で更新されています。読み直してください。');
                    const bundle = Array.isArray(d.bundle) ? [...new Set(d.bundle)] : [];
                    if (bundle.length > 20 || (await Promise.all(bundle.map(async (pid) => pid === id || !(await get('products', pid))?.version || (await get('products', pid))?.bundle.length))).some(Boolean))
                        fail(400, 'セットは単品商品のみ指定できます。');
                    const value = { ...existing, id, name: d.name, description: d.description, category: d.category, price: d.price, status: d.status, bundle, revision: (existing?.revision || 0) + 1, version: existing?.version || null, subtitle: typeof d.subtitle === 'string' ? d.subtitle.slice(0, 200) : d.name, color: /^[a-fA-F0-9]{6}$/.test(d.color) ? d.color : '263F70', sections: existing?.sections || [], compatible: typeof d.compatible === 'string' ? d.compatible.slice(0, 200) : 'PowerPointなどのPPTX対応ソフト', created: existing?.created || new Date(now()).toISOString() };
                    if (value.status === 'published' && (bundle.length ? (await Promise.all(bundle.map(async (pid) => (await get('versions', (await get('products', pid))?.version))?.scan?.status === 'infected'))).some(Boolean) : (await get('versions', value.version))?.scan?.status === 'infected'))
                        fail(409, '検査で問題を検出したファイルは公開できません。', 'FILE_REJECTED');
                    if (value.status === 'published' && assets.mode === 'required' && (bundle.length ? (await Promise.all(bundle.map(async (pid) => (await get('versions', (await get('products', pid))?.version))?.scan?.status !== 'clean'))).some(Boolean) : (await get('versions', value.version))?.scan?.status !== 'clean'))
                        fail(409, '公開前にウイルス検査を完了してください。', 'SCAN_REQUIRED');
                    if (value.status === 'published' && !value.version && !bundle.length)
                        fail(409, '公開前にPPTXを登録してください。');
                    await tx(async () => { const current=await get('products',id);if(method==='POST'?!!current:!current||current.revision!==d.revision)fail(409,'商品が変更されています。読み直してください。');await checkPublication(value);await put('products', id, value); await audit(session, 'product-save', id); });
                    return json(res, 200, await expose(value));
                }
                const upload = path.match(/^\/api\/admin\/products\/([a-zA-Z0-9-]+)\/(file|prepare)$/);
                if (method === 'POST' && upload) {
                    rate(`upload:${session}`, 10);
                    const p = await get('products', upload[1]);
                    if (!p)
                        fail(404, '商品がありません。');
                    const d = await body(req);
                    if (d.revision !== p.revision)
                        fail(409, '商品が変更されています。');
                    if (assetBusy)
                        fail(409, '他のファイルを処理しています。完了後に再試行してください。', 'ASSET_BUSY');
                    let bytes;
                    if (upload[2] === 'file') {
                        if (typeof d.base64 !== 'string' || !d.base64.length || !/^[A-Za-z0-9+/]*={0,2}$/.test(d.base64))
                            fail(400, 'ファイルが不正です。');
                        bytes = Buffer.from(d.base64, 'base64');
                    }
                    else {
                        if (!p.version || p.bundle.length)
                            fail(400, '単品商品とPPTXを選んでください。');
                        bytes = await readVersion(p.version);
                        if (hash(bytes) !== p.version)
                            fail(409, 'ファイルの整合性を確認できません。');
                    }
                    assetBusy = true;
                    let meta;
                    try {
                        meta = await prepareAsset(bytes, { dataDir, config: assets });
                    }
                    catch (e) {
                        if (e instanceof AssetError) {
                            const checksum = hash(bytes), old = await get('versions', checksum);
                            if (old) {
                                old.scan = { status: e.code === 'MALWARE_DETECTED' ? 'infected' : 'failed', engine: 'ClamAV', checkedAt: new Date(now()).toISOString() };
                                await put('versions', checksum, old);
                            }
                            fail(e.status, e.message, e.code);
                        }
                        fail(400, e.message, 'INVALID_PPTX');
                    }
                    finally {
                        assetBusy = false;
                    }
                    const checksum = hash(bytes);
                    if ((await get('versions', checksum))?.scan?.status === 'infected' && meta.scan.status !== 'clean')
                        fail(409, '検出済みファイルは再検査を完了するまで登録できません。', 'SCAN_REQUIRED');
                    await snapshot(bytes);
                    if(store.remote&&meta.preview?.status==='ready')for(let i=0;i<meta.preview.pages;i++)await store.writePreview(checksum,i,readFileSync(resolve(dataDir,'previews',checksum,`${i}.png`)));
                    await tx(async () => { if ((await get('products', p.id)).revision !== p.revision)
                        fail(409, '商品が変更されています。読み直してください。');
                        const previous=await get('versions',checksum);
                        if(previous?.scan?.status==='infected'&&meta.scan.status!=='clean')fail(409,'検出済みファイルは再検査を完了するまで登録できません。','SCAN_REQUIRED');
                        await put('versions', checksum, { ...previous, id: checksum, size: bytes.length, ...meta, created: previous?.created || new Date(now()).toISOString() }); p.version = checksum; p.bundle = []; p.revision++; await put('products', p.id, p); await audit(session, upload[2] === 'file' ? 'file-upload' : 'asset-prepare', p.id); });
                    return json(res, 200, await expose(p));
                }
                if (method === 'GET' && path === '/api/admin/orders')
                    return json(res, 200, await orderPage(url));
                const refund = path.match(/^\/api\/admin\/orders\/([^/]+)\/refund$/);
                if (method === 'POST' && refund) {
                    const d = await body(req);
                    if (!text(d.reason, 500))
                        fail(400, '返金理由を入力してください。');
                    const row = await db.prepare('SELECT * FROM orders WHERE id=?').get(refund[1]);
                    if (!row)
                        fail(404, '注文がありません。');
                    const m = await get('orderMeta', row.id);
                    if (m.status === 'refunded')
                        return json(res, 200, await hydrate(row));
                    const reauth = await get('reauth', sessionToken);
                    if (!reauth || reauth.role !== 'admin' || reauth.expiresAt <= now())
                        fail(403, '返金前にパスワードと認証コードで再確認してください。', 'REAUTH_REQUIRED');
                    await tx(async () => {const current=await get('orderMeta',row.id);if(current?.status==='refunded')return;if(current?.status!=='paid')fail(409,'注文の状態が変更されています。');current.status = 'refunded'; current.refundedAt = new Date(now()).toISOString(); current.refundReason = d.reason; await put('orderMeta', row.id, current); await db.prepare('DELETE FROM download_tokens WHERE order_id=?').run(row.id); await audit(session, 'refund', row.id, d.reason); await notification(`refund-${row.id}`, '模擬返金完了', `注文番号：${row.id}\n返金額：¥${row.total}\n理由：${d.reason}\n購入権限を停止しました。実際の返金・メール送信はありません。`); });
                    return json(res, 200, await hydrate(row));
                }
                if (method === 'GET' && path === '/api/admin/inquiries')
                    return json(res, 200, (await list('inquiries')).reverse());
                const inquiry = path.match(/^\/api\/admin\/inquiries\/([^/]+)$/);
                if (method === 'PATCH' && inquiry) {
                    const d = await body(req), i = await get('inquiries', inquiry[1]);
                    if (!i)
                        fail(404, '問い合わせがありません。');
                    if (!['open', 'handling', 'closed'].includes(d.status))
                        fail(400, '状態が不正です。');
                    i.status = d.status;
                    await tx(async () => { await put('inquiries', i.id, i); await audit(session, 'inquiry-status', i.id); });
                    return json(res, 200, i);
                }
                if (method === 'GET' && path === '/api/admin/coupons')
                    return json(res, 200, await list('coupons'));
                if (method === 'POST' && path === '/api/admin/coupons') {
                    const d = await body(req);
                    if (typeof d.code !== 'string' || !/^[A-Z0-9-]{3,30}$/.test(d.code) || !Number.isInteger(d.percent) || d.percent < 1 || d.percent > 100 || !Number.isInteger(d.limit) || d.limit < 1 || d.limit > 100000 || !Number.isFinite(d.expires) || d.expires <= now())
                        fail(400, 'クーポン情報を確認してください。');
                    if (await get('coupons', d.code))
                        fail(409, 'コードが既に存在します。');
                    await tx(async()=>{if(await get('coupons',d.code))fail(409,'コードが既に存在します。');await put('coupons', d.code, { ...d, used: 0, active: true });await audit(session, 'coupon-create', d.code);});
                    return json(res, 201, { ok: true });
                }
                if (method === 'GET' && path === '/api/admin/notifications')
                    return json(res, 200, (await list('notifications')).reverse());
                if (method === 'POST' && path === '/api/admin/notifications/run') {
                    const d = await body(req);
                    await deliver(d.simulateFailure === true);
                    return json(res, 200, { ok: true });
                }
                const retry = path.match(/^\/api\/admin\/notifications\/([^/]+)\/retry$/);
                if (method === 'POST' && retry) {
                    const n = await get('notifications', retry[1]);
                    if (!n)
                        fail(404, '通知がありません。');
                    n.status = 'pending';
                    n.nextRun = now();
                    n.attempts = 0;
                    await put('notifications', n.id, n);
                    await audit(session, 'notification-retry', n.id);
                    return json(res, 200, { ok: true });
                }
                if (method === 'GET' && path === '/api/admin/audit') {
                    let p;
                    try {
                        p = pageParameters(url);
                    }
                    catch (e) {
                        fail(400, e.message, 'INVALID_CURSOR');
                    }
                    const rows = (await db.prepare(`SELECT value FROM documents WHERE kind='audit' ${p.cursor ? "AND (json_extract(value,'$.date') < ? OR (json_extract(value,'$.date') = ? AND id < ?))" : ''} ORDER BY json_extract(value,'$.date') DESC,id DESC LIMIT ?`).all(...(p.cursor ? [p.cursor.date, p.cursor.date, p.cursor.id] : []), p.limit + 1)).map(r => JSON.parse(r.value));
                    const items = rows.slice(0, p.limit);
                    return json(res, 200, { items, nextCursor: rows.length > p.limit ? encodeCursor(items.at(-1)) : null });
                }
                if (method === 'GET' && path === '/api/admin/health') {
                    tools ??= await toolStatus(assets);
                    return json(res, 200, { database: 'ok', assets: { ...tools, busy: assetBusy }, orders: (await db.prepare('SELECT COUNT(*) AS n FROM orders').get()).n, pendingNotifications: (await list('notifications')).filter(n => n.status === 'pending').length, failedNotifications: (await list('notifications')).filter(n => n.status === 'failed').length, metrics: await db.prepare('SELECT * FROM metrics ORDER BY day DESC,event').all(), backup: store.remote?{intervalMs:0,keep:0,status:'external',error:'MySQLと販売ファイルはStarServer側でバックアップしてください。'}:{ intervalMs: backupInterval, keep: backupKeep, ...await get('maintenance', 'backup') }, mode: store.remote?'starserver-simulation':'local-simulation',sessionMode:useMemory?'memory':'persistent' });
                }
                fail(404, '見つかりません。');
            }
            catch (e) {
                if (!(e instanceof HttpError)) {
                    console.error('Local shop error:', e.name);
                    try {
                        await put('errors', randomUUID(), { date: new Date(now()).toISOString(), requestId: res.shopRequestId, type: e.name, path: url.pathname.replace(/\/api\/downloads\/.*/, '/api/downloads/[redacted]') });
                    }
                    catch { }
                }
                return json(res, e.status || 500, { message: e.status ? e.message : 'サーバーで処理できませんでした。再度お試しください。', code: e.code, details: e.details });
            }
        } };
}
