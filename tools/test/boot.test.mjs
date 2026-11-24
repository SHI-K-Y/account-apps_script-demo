// 開機流程（P08）：先畫出可以記帳的畫面，其他工作往後排。
//   1. 結構：開機程式的第一個模組是 BootPhase、最後一行是 AppBoot.start()；頁面上的順序是
//      啟動資料 → 開機程式（＋延後程式）→ 內嵌圖片；預設選項與圖示對照在開機程式裡，圖片不在。
//   2. 分段：載入畫面移除（__boot.done）的當下只畫好首屏（支出面板、目前月份），收入面板、完整月份選單在那之後；
//      常駐動畫、背景光暈都還沒開始；boot-ready 之後才開始。
//   3. 網路慢的時候：首屏不等頁面下載完（boot-ready 在 DOMContentLoaded 之前），缺的卡面圖片與延後程式到齊後自動補上，
//      在那之前切頁會等延後程式到了再切。
//   4. 有本機快取時不用等伺服器：伺服器完全不回應也能開機、點項目、按數字鍵；總覽頁已用快取預先畫好。
//   5. LocalCache 寫回：內容沒變就不寫。
// 2–4 在真的 Chromium 裡跑（本機預覽伺服器＋合成資料），其餘是原始碼與建置產物檢查。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, DIST } from './helpers.mjs';
import { createDevApp } from '../dev-server.mjs';

const CLIENT = path.join(ROOT, 'src', 'client');
const read = rel => fs.readFileSync(path.join(CLIENT, rel), 'utf8');
const readDist = name => fs.readFileSync(path.join(DIST, name), 'utf8');
const FIXED_NOW = Date.UTC(2026, 10, 13, 4, 0, 0);   // 2026-11-13 12:00 台北

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch (e) { chromium = null; }
const NO_BROWSER = chromium ? false : '沒有安裝 playwright';

function shiftedDate(startMs) {
  const offset = startMs - Date.now();
  return class TestDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(Date.now() + offset); }
    static now() { return Date.now() + offset; }
  };
}

/** 頁面端：固定時鐘；攔下 __boot.done()，記下載入畫面移除當下的畫面狀態；holdBoot 時先不移除（之後呼叫 __releaseBoot()）。 */
function pageInit(cfg) {
  const RealDate = Date;
  const offset = cfg.now - RealDate.now();
  class FixedDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  window.Date = new Proxy(FixedDate, { apply: () => new FixedDate().toString() });

  const count = sel => document.querySelectorAll(sel).length;
  const snapshot = () => ({
    readyState: document.readyState,
    expenseKeys: count('#expenseKeypad .key'),
    incomeKeys: count('#incomeKeypad .key'),
    expenseItems: count('#expenseItemChoices .choice'),
    incomeItems: count('#incomeItemChoices .choice'),
    recentExpenses: count('#recentExpenses .recent-item'),
    recentIncomes: count('#recentIncomes .recent-item'),
    months: count('#monthSelect option'),
    todayAmount: (document.getElementById('todayExpenseAmount') || {}).textContent || '',
    bgMode: window.__bgDebug ? window.__bgDebug.mode() : null,
    ambientTracked: typeof Ambient === 'object' ? Ambient.debug().tracked : null,
    deferredLoaded: typeof DeferredApp === 'object' ? DeferredApp.loaded() : null,
  });
  window.__bootLog = { snapshot: null };
  let real = null;
  Object.defineProperty(window, '__boot', {
    configurable: true,
    get() { return real; },
    set(v) {
      const done = v.done;
      v.done = function () {
        if (!window.__bootLog.snapshot) window.__bootLog.snapshot = snapshot();
        if (cfg.holdBoot) { window.__releaseBoot = () => done(); return; }
        return done();
      };
      real = v;
    },
  });
  window.__bootSnapshot = snapshot;
  if (cfg.background) {
    // 背景分頁：沒有下一幀（rAF 永遠不會執行）
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    window.requestAnimationFrame = () => 0;
  }
}

async function startServer() {
  const app = createDevApp({ fixture: true, quiet: true, DateCtor: shiftedDate(FIXED_NOW) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + app.server.address().port + '/', close: () => new Promise(r => app.server.close(r)) };
}

async function newContext(browser, opts) {
  const o = opts || {};
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  });
  await context.addInitScript(pageInit, { now: FIXED_NOW, holdBoot: Boolean(o.holdBoot), background: Boolean(o.background) });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  return { context, page, errors };
}

const bootReady = page => page.waitForFunction(() => Boolean(document.documentElement) && document.documentElement.classList.contains('boot-ready'), null, { timeout: 60000 });

let browser = null;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

/* ---------------------------------------------------------------------------
 * 1. 結構
 * ------------------------------------------------------------------------- */
test('結構：BootPhase 最先、AppBoot.start() 最後；啟動資料 → 開機程式 → 內嵌圖片；不再等 DOMContentLoaded', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(manifest.scripts[0], 'core/boot-phase.js');
  assert.equal(manifest.scripts[manifest.scripts.length - 1], 'app/start.js');
  assert.ok(manifest.scripts.indexOf('core/item-defaults.js') < manifest.scripts.indexOf('core/icons.js'));
  assert.match(read('scripts/app/start.js'), /^AppBoot\.start\(\);$/m);
  assert.doesNotMatch(read('scripts/app/bootstrap.js'), /addEventListener\('DOMContentLoaded', init\)/);
  assert.ok(!fs.existsSync(path.join(CLIENT, 'partials', 'boot-finish.html')), '載入畫面的收尾併進 AppBoot');

  const index = read('index.html');
  const at = s => index.indexOf(s);
  assert.ok(at('__INITIAL_DATA__') > 0 && at('__INITIAL_DATA__') < at("include('app')"), '啟動資料在開機程式之前');
  assert.ok(at("include('app')") < at("include('assets')"), '內嵌圖片在開機程式之後');

  const app = readDist('app.html');
  const boot = app.match(/^<script>\n([\s\S]*?)<\/script>\n/)[1];
  assert.match(boot, /AppBoot\.start\(\);?\s*$/, '開機程式的最後一行開始開機');
  assert.match(boot, /DEFAULT_OPTIONS_FALLBACK\s*=/, '預設選項在開機程式裡');
  assert.match(boot, /ITEM_ICON_MAP\s*=/, '項目圖示對照在開機程式裡');
  const assets = readDist('assets.html');
  assert.match(assets, /PAYMENT_CARD_IMAGES\s*=/);
  assert.match(assets, /const APP_ICON_BASE64\s*=\s*'/, '後端 setupAppIcon 讀的格式不變');
  assert.doesNotMatch(assets, /DEFAULT_OPTIONS_FALLBACK|ITEM_ICON_MAP/);
});

test('結構：載入畫面的旋轉光弧只動 transform，進度用 requestAnimationFrame（不再用 setInterval）', () => {
  const loader = read('partials/boot-loader.html');
  const head = read('partials/head.html');
  assert.match(loader, /class="boot-sweep"/);
  assert.doesNotMatch(loader, /setInterval/);
  assert.match(loader, /requestAnimationFrame\(frame\)/);
  assert.match(loader, /cancelAnimationFrame/);
  const kf = head.match(/@keyframes boot-sweep-spin\s*\{([^{}]*\{[^{}]*\})*[^{}]*\}/);
  assert.ok(kf, '有 boot-sweep-spin');
  const props = Array.from(kf[0].matchAll(/([\w-]+)\s*:/g)).map(m => m[1]);
  assert.deepEqual(Array.from(new Set(props)), ['transform'], '只動 transform（合成器執行）');
  assert.match(head, /html\.boot-ready \.boot-sweep\s*\{\s*animation:\s*none/, 'boot-ready 時立刻停止');
  assert.match(head, /prefers-reduced-motion: reduce\)[\s\S]*\.boot-sweep \{ display: none; \}/, '減少動態效果時不顯示');
});

test('結構：每個無限循環的裝飾動畫在開機期間都被 26-motion-overrides.css 暫停', () => {
  const css = read('styles/26-motion-overrides.css');
  const block = css.slice(css.indexOf('html:not(.boot-ready)'));
  const gated = ['.uv-btn-ring', '.uv-ring', '.uv-tab-stars', '.uv-tab-glow', '.submit-btn::before', '.submit-btn::after', '.uv-glow-bg::before'];
  gated.forEach(sel => assert.ok(block.includes(sel), sel + ' 開機期間暫停'));
  assert.match(block, /animation-play-state:\s*paused/);
  // 樣式表裡所有無限循環、名稱屬於常駐裝飾的動畫，都要在上面那一組裡
  const ambientNames = ['uv-btn-ring', 'uv-btn-stars', 'uv-btn-pulse', 'uv-card-spin', 'uv-tab-glow', 'uv-bg-breathe-fade'];
  const all = JSON.parse(read('manifest.json')).styles.map(f => read('styles/' + f)).join('\n');
  const used = Array.from(all.matchAll(/animation:\s*([\w-]+|var\(--uv-flow\))[^;]*infinite/g)).map(m => m[1]);
  used.filter(n => /^(uv-|ambient-|var\(--uv-flow\))/.test(n) && n !== 'uv-paid-spin').forEach(n => {
    assert.ok(n === 'var(--uv-flow)' || ambientNames.includes(n) || n.startsWith('ambient-'), '新的常駐動畫 ' + n + ' 要加進開機暫停的選擇器');
  });
});

/* ---------------------------------------------------------------------------
 * 5. LocalCache：內容沒變就不寫
 * ------------------------------------------------------------------------- */
test('LocalCache：saveBoot／saveSettingsMetadata 內容沒變就不寫；結果與以前相同', () => {
  const store = new Map();
  const writes = [];
  const localStorage = {
    get length() { return store.size; },
    key: i => Array.from(store.keys())[i],
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { writes.push(k); store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  const ctx = vm.createContext({ localStorage, JSON, Date, Object, Array });
  vm.runInContext(read('scripts/core/local-cache.js') + '\nthis.LocalCache = LocalCache;', ctx);
  const LC = ctx.LocalCache;
  const recent = { month: '2026.11', expenses: [{ row: 5, amount: 120 }], incomes: [] };
  const data = { selectedMonth: '2026.11', months: ['2026.10', '2026.11'], options: { a: 1 }, cachedAt: 100, initialRecent: recent };

  LC.saveBoot(data);
  assert.deepEqual(writes.sort(), [LC.KEY_BOOT, LC.KEY_RECENT_PREFIX + '2026.11'].sort(), '第一次：開機資料與最近紀錄都寫入');
  const saved = JSON.parse(store.get(LC.KEY_BOOT));
  assert.ok(saved.cachedAt > 100, 'initialRecent 是目前月份：cachedAt 改成現在（與以前經由 saveRecent 相同）');
  assert.deepEqual(JSON.parse(store.get(LC.KEY_RECENT_PREFIX + '2026.11')), recent);

  writes.length = 0;
  LC.saveBoot(Object.assign({}, data, { cachedAt: 999 }));
  assert.deepEqual(writes, [], '內容相同（只有 cachedAt 不同）時不寫');

  LC.saveBoot(Object.assign({}, data, { months: ['2026.11'] }));
  assert.deepEqual(writes, [LC.KEY_BOOT], '開機資料變了才寫；最近紀錄沒變不寫');

  writes.length = 0;
  const meta = { cards: [{ id: 'c1', name: '卡', customImage: "data:image/svg+xml,%3Csvg%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%20viewBox%3D%220%200%20428%20270%22%20role%3D%22img%22%20aria-label%3D%22customImage%22%3E%3Cdefs%3E%3ClinearGradient%20id%3D%22g1oxu5wj%22%20x1%3D%220%22%20y1%3D%220%22%20x2%3D%221%22%20y2%3D%221%22%3E%3Cstop%20offset%3D%220%22%20stop-color%3D%22%235b4bb3%22%2F%3E%3Cstop%20offset%3D%221%22%20stop-color%3D%22%232c2466%22%2F%3E%3C%2FlinearGradient%3E%3C%2Fdefs%3E%3Crect%20width%3D%22428%22%20height%3D%22270%22%20rx%3D%2222%22%20fill%3D%22url%28%23g1oxu5wj%29%22%2F%3E%3Ccircle%20cx%3D%22372%22%20cy%3D%2256%22%20r%3D%22120%22%20fill%3D%22%23fff%22%20opacity%3D%22.07%22%2F%3E%3Ccircle%20cx%3D%22300%22%20cy%3D%22290%22%20r%3D%22150%22%20fill%3D%22%23fff%22%20opacity%3D%22.05%22%2F%3E%3Crect%20x%3D%2234%22%20y%3D%2292%22%20width%3D%2252%22%20height%3D%2240%22%20rx%3D%227%22%20fill%3D%22%23f3d58a%22%2F%3E%3Cpath%20d%3D%22M34%20106h52M34%20118h52M54%2092v40M68%2092v40%22%20stroke%3D%22%23b8923a%22%20stroke-width%3D%221.5%22%20fill%3D%22none%22%2F%3E%3Ctext%20x%3D%2234%22%20y%3D%2254%22%20font-family%3D%22system-ui%2C%27PingFang%20TC%27%2C%27Noto%20Sans%20TC%27%2C%27Microsoft%20JhengHei%27%2Csans-serif%22%20font-size%3D%2222%22%20font-weight%3D%22700%22%20fill%3D%22%23fff%22%3EDEMO%20BANK%3C%2Ftext%3E%3Ctext%20x%3D%2234%22%20y%3D%22186%22%20font-family%3D%22system-ui%2C%27PingFang%20TC%27%2C%27Noto%20Sans%20TC%27%2C%27Microsoft%20JhengHei%27%2Csans-serif%22%20font-size%3D%2226%22%20font-weight%3D%22700%22%20fill%3D%22%23fff%22%3EcustomImage%3C%2Ftext%3E%3Ctext%20x%3D%2234%22%20y%3D%22232%22%20font-family%3D%22system-ui%2C%27PingFang%20TC%27%2C%27Noto%20Sans%20TC%27%2C%27Microsoft%20JhengHei%27%2Csans-serif%22%20font-size%3D%2217%22%20letter-spacing%3D%223%22%20fill%3D%22%23fff%22%20opacity%3D%22.8%22%3E%E2%80%A2%E2%80%A2%E2%80%A2%E2%80%A2%20DEMO%3C%2Ftext%3E%3Ctext%20x%3D%22394%22%20y%3D%22232%22%20font-family%3D%22system-ui%2C%27PingFang%20TC%27%2C%27Noto%20Sans%20TC%27%2C%27Microsoft%20JhengHei%27%2Csans-serif%22%20font-size%3D%2215%22%20font-weight%3D%22700%22%20text-anchor%3D%22end%22%20fill%3D%22%23fff%22%20opacity%3D%22.85%22%3ECREDIT%3C%2Ftext%3E%3C%2Fsvg%3E" }] };
  LC.saveSettingsMetadata(meta);
  assert.deepEqual(writes, [LC.KEY_SETTINGS_METADATA, LC.KEY_CUSTOM_IMAGES]);
  writes.length = 0;
  LC.saveSettingsMetadata(JSON.parse(JSON.stringify(meta)));
  assert.deepEqual(writes, [], 'metadata 沒變：不寫（卡面也已經存過）');
});

/* ---------------------------------------------------------------------------
 * 2. 分段與動畫
 * ------------------------------------------------------------------------- */
test('分段：載入畫面移除時只畫好首屏；收入面板、完整月份選單在之後；常駐動畫與背景光暈 boot-ready 後才開始', { skip: NO_BROWSER }, async () => {
  const server = await startServer();
  const s = await newContext(browser, { holdBoot: true });
  try {
    await s.page.goto(server.url);
    await s.page.waitForFunction(() => window.__bootLog.snapshot && typeof window.__releaseBoot === 'function', null, { timeout: 60000 });
    const first = await s.page.evaluate(() => window.__bootLog.snapshot);
    assert.equal(first.expenseKeys, 13, '支出鍵盤（12 鍵＋清除）');
    assert.ok(first.expenseItems > 3, '支出項目');
    assert.ok(first.recentExpenses > 0 && first.recentExpenses <= 8, '最近支出前 8 筆');
    assert.match(first.todayAmount, /\d/, '今日總花費');
    assert.equal(first.months, 1, '月份選單先只有目前月份');
    assert.equal(first.incomeKeys, 0, '收入鍵盤在第二段');
    assert.equal(first.incomeItems, 0, '收入選項在第二段');
    assert.equal(first.recentIncomes, 0, '最近收入在第二段');
    assert.equal(first.bgMode, 'none', '背景光暈還沒啟動');
    assert.equal(first.ambientTracked, 0, 'Ambient 還沒開始管理');
    assert.equal(first.deferredLoaded, false, '延後程式在第三段');

    // 第二、三段照常進行（不用等載入畫面消失）；延後程式由第三段執行，不是靠 load 之後 3 秒的保險
    await s.page.waitForFunction(() => document.querySelectorAll('#incomeKeypad .key').length === 13 && DeferredApp.loaded(), null, { timeout: 2500 });
    const held = await s.page.evaluate(() => {
      const infinite = document.getAnimations().filter(a => {
        try { return a.effect.getComputedTiming().iterations === Infinity; } catch (e) { return false; }
      });
      return {
        months: document.querySelectorAll('#monthSelect option').length,
        allMonths: state.data.months.length,
        incomeItems: document.querySelectorAll('#incomeItemChoices .choice').length,
        runningDecor: infinite.filter(a => a.playState === 'running' && a.animationName !== 'boot-sweep-spin').map(a => a.animationName),
        sweepRunning: infinite.some(a => a.animationName === 'boot-sweep-spin' && a.playState === 'running'),
        bgMode: __bgDebug.mode(),
        tracked: Ambient.debug().tracked,
      };
    });
    assert.equal(held.months, held.allMonths, '第二段補上完整月份選單');
    assert.ok(held.incomeItems > 0);
    assert.deepEqual(held.runningDecor, [], '開機期間沒有在跑的常駐動畫');
    assert.ok(held.sweepRunning, '載入畫面的旋轉光弧在轉');
    assert.equal(held.bgMode, 'none');
    assert.equal(held.tracked, 0);

    await s.page.evaluate(() => window.__releaseBoot());
    await bootReady(s.page);
    await s.page.waitForTimeout(400);
    const after = await s.page.evaluate(() => ({
      running: document.getAnimations().filter(a => a.playState === 'running' && /^uv-/.test(a.animationName || '')).length,
      bgMode: __bgDebug.mode(),
      tracked: Ambient.debug().tracked,
      sweep: document.getAnimations().some(a => a.animationName === 'boot-sweep-spin' && a.playState === 'running'),
    }));
    assert.ok(after.running > 0, 'boot-ready 之後常駐動畫開始播放');
    assert.notEqual(after.bgMode, 'none', '背景光暈啟動');
    assert.ok(after.tracked > 0, 'Ambient 接手');
    assert.equal(after.sweep, false, '旋轉光弧停止');
    assert.deepEqual(s.errors, []);
  } finally { await s.context.close(); await server.close(); }
});

/* ---------------------------------------------------------------------------
 * 3. 網路慢：首屏不等頁面下載完
 * ------------------------------------------------------------------------- */
test('網路慢：boot-ready 在頁面下載完之前；卡面圖片、延後程式到齊後自動補上，在那之前的切頁會等它', { skip: NO_BROWSER }, async () => {
  const server = await startServer();
  const s = await newContext(browser);
  try {
    const cdp = await s.context.newCDPSession(s.page);
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 });
    await s.page.goto(server.url, { waitUntil: 'commit' });
    await bootReady(s.page);
    const early = await s.page.evaluate(() => {
      // 首屏時預設卡面還沒下載：加一個對得到預設卡面的支付方式，應該先畫成沒有圖片
      state.data.options.paymentMethods = state.data.options.paymentMethods.concat(['信用卡-海悅 wave 卡']);
      renderExpensePaymentChoices();
      switchPage('overview');
      return {
        readyState: document.readyState,
        snapshotReadyState: window.__bootLog.snapshot.readyState,
        imagesLoaded: paymentImagesLoaded(),
        missed: paymentImagesMissed(),
        cubeImg: Boolean(document.querySelector('#paymentChoices .choice[data-value="信用卡-海悅 wave 卡"] .choice-card-img')),
        available: DeferredApp.available(),
        page: document.body.dataset.page,
      };
    });
    assert.equal(early.snapshotReadyState, 'loading', '首屏畫好時頁面還在下載');
    assert.equal(early.readyState, 'loading');
    assert.equal(early.imagesLoaded, false);
    assert.equal(early.missed, true);
    assert.equal(early.cubeImg, false);
    assert.equal(early.available, false);
    assert.equal(early.page, 'bookkeeping', '延後程式還沒到：先不切頁');

    await s.page.waitForFunction(() => document.readyState !== 'loading', null, { timeout: 30000 });
    await s.page.waitForTimeout(300);
    const late = await s.page.evaluate(() => ({
      cubeImg: Boolean(document.querySelector('#paymentChoices .choice[data-value="信用卡-海悅 wave 卡"] .choice-card-img')),
      missed: paymentImagesMissed(),
      loaded: DeferredApp.loaded(),
      page: document.body.dataset.page,
      active: document.querySelector('.page-container.active').id,
      icon: Boolean(document.querySelector('link[rel="icon"]')) || typeof APP_ICON_BASE64 === 'string',
    }));
    assert.deepEqual(late, { cubeImg: true, missed: false, loaded: true, page: 'overview', active: 'pageOverview', icon: true });
    assert.deepEqual(s.errors, []);
  } finally { await s.context.close(); await server.close(); }
});

/* ---------------------------------------------------------------------------
 * 4. 有本機快取：不等伺服器
 * ------------------------------------------------------------------------- */
test('有本機快取：伺服器完全不回應也能開機、點項目、按數字鍵；總覽已用快取預先畫好，切過去不用重畫', { skip: NO_BROWSER }, async () => {
  const server = await startServer();
  const s = await newContext(browser);
  try {
    // 第一次開啟：讓 LocalCache 存下開機資料、總覽、對帳
    await s.page.goto(server.url);
    await bootReady(s.page);
    await s.page.waitForFunction(() => DeferredApp.loaded(), null, { timeout: 10000 });
    for (const pg of ['overview', 'settlement', 'bookkeeping']) {
      await s.page.evaluate(p => switchPage(p), pg);
      await s.page.waitForTimeout(1200);
    }
    await s.page.waitForFunction(() => Boolean(LocalCache.getBoot() && LocalCache.getOverview() && LocalCache.getSettlement()), null, { timeout: 10000 });

    // 第二次：伺服器沒有內嵌啟動資料，所有 google.script.run 都不回應
    const rpc = [];
    await s.context.route(/\/__rpc$/, route => { rpc.push(route.request().postDataJSON().fn); /* 不回應 */ });
    await s.context.route(server.url, async route => {
      const resp = await route.fetch();
      const body = (await resp.text()).replace(/window\.__INITIAL_DATA__ = .*;/, 'window.__INITIAL_DATA__ = null;');
      await route.fulfill({ response: resp, body });
    });
    await s.page.goto(server.url);
    await bootReady(s.page);
    await s.page.locator('#expenseItemChoices .choice').nth(1).tap();
    await s.page.locator('#expenseKeypad .key:text-is("1")').tap();
    const r = await s.page.evaluate(() => ({
      item: state.expense.item,
      selected: document.querySelector('#expenseItemChoices .choice.selected') && document.querySelector('#expenseItemChoices .choice.selected').dataset.value,
      amount: document.getElementById('expenseLiveAmount').textContent.trim(),
      recent: document.querySelectorAll('#recentExpenses .recent-item').length,
      busy: document.body.classList.contains('busy'),
    }));
    assert.ok(r.item && r.item === r.selected, '點選項目有反應');
    assert.equal(r.amount, '1', '數字鍵有反應');
    assert.ok(r.recent > 0, '最近紀錄來自快取');
    assert.equal(r.busy, false, '沒有進入等待伺服器的忙碌狀態');
    assert.ok(rpc.includes('api'), '背景同步已送出（但沒有回應）');

    // 閒置時預先渲染總覽、對帳
    await s.page.waitForFunction(() => DeferredApp.loaded() && Boolean(document.querySelector('#overviewContent .ov-hero')) &&
      Boolean(document.querySelector('#settlementContent .st-date-section')), null, { timeout: 10000 });
    const switched = await s.page.evaluate(async () => {
      let renders = 0;
      const orig = window.renderOverview;
      window.renderOverview = function () { renders++; return orig.apply(this, arguments); };
      const hero = document.querySelector('#overviewContent .ov-hero');
      switchPage('overview');
      await new Promise(res => setTimeout(res, 900));
      return { renders, samehero: document.querySelector('#overviewContent .ov-hero') === hero, page: document.body.dataset.page,
        amount: document.querySelector('#overviewContent .ov-hero-amount').textContent };
    });
    assert.equal(switched.page, 'overview');
    assert.equal(switched.renders, 0, '切到總覽不用重畫整頁');
    assert.ok(switched.samehero, '沿用預先畫好的節點');
    assert.match(switched.amount, /\d/);
    assert.deepEqual(s.errors, []);
  } finally { await s.context.close(); await server.close(); }
});

test('背景分頁：沒有下一幀（rAF 停住）也照常開機，不等使用者切回來', { skip: NO_BROWSER }, async () => {
  const server = await startServer();
  const s = await newContext(browser, { background: true });
  try {
    await s.page.goto(server.url);
    await bootReady(s.page);
    await s.page.waitForFunction(() => document.querySelectorAll('#incomeKeypad .key').length === 13, null, { timeout: 5000 });
    const r = await s.page.evaluate(() => ({
      items: document.querySelectorAll('#expenseItemChoices .choice').length,
      months: document.querySelectorAll('#monthSelect option').length === state.data.months.length,
    }));
    assert.ok(r.items > 3);
    assert.ok(r.months);
    assert.deepEqual(s.errors, []);
  } finally { await s.context.close(); await server.close(); }
});
