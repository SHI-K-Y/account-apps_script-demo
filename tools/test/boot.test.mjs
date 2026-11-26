// 開機流程（P08）：先畫出可以記帳的畫面，其他工作往後排。
//   1. 結構：開機程式的第一個模組是 BootPhase、最後一行是 AppBoot.start()；頁面上的順序是
//      啟動資料 → 開機程式（＋延後程式）→ 內嵌圖片；預設選項與圖示對照在開機程式裡，圖片不在。
//   2. 分段：載入畫面移除（__boot.done）的當下只畫好首屏（支出面板、目前月份），收入面板、完整月份選單在那之後；
//      常駐動畫、背景光暈都還沒開始；boot-ready 之後才開始。
//   3. 網路慢的時候：首屏不等頁面下載完（boot-ready 在 DOMContentLoaded 之前），缺的卡面圖片與延後程式到齊後自動補上，
//      在那之前切頁會等延後程式到了再切。
//   4. 有本機快取時不用等伺服器：伺服器完全不回應也能開機、點項目、按數字鍵；總覽頁已用快取預先畫好。
//   5. LocalCache 寫回：見 cache-stale.test.mjs（P12）。
// 2–4 在真的 Chromium 裡跑（本機預覽伺服器＋合成資料），其餘是原始碼與建置產物檢查。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, DIST, browserTests } from './helpers.mjs';
import { createDevApp } from '../dev-server.mjs';

const CLIENT = path.join(ROOT, 'src', 'client');
const read = rel => fs.readFileSync(path.join(CLIENT, rel), 'utf8');
const readDist = name => fs.readFileSync(path.join(DIST, name), 'utf8');
const FIXED_NOW = Date.UTC(2026, 10, 13, 4, 0, 0);   // 2026-11-13 12:00 台北

// 沒有 Chromium 時瀏覽器測試略過（原因會提示安裝方式）；REQUIRE_BROWSER=1 時改為失敗。
const web = await browserTests();
const NO_BROWSER = web.skip;

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

async function newContext(opts) {
  const browser = await web.browser();
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
 * 5. LocalCache：P12 起改存 IndexedDB、寫入合併到閒置時間一次寫回（同一個鍵只寫最後一份），
 *    開機時的寫回不再佔用主執行緒的同步 localStorage。測試在 tools/test/cache-stale.test.mjs。
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * 2. 分段與動畫
 * ------------------------------------------------------------------------- */
test('分段：載入畫面移除時只畫好首屏；收入面板、完整月份選單在之後；常駐動畫與背景光暈 boot-ready 後才開始', { skip: NO_BROWSER }, async () => {
  // 先開瀏覽器頁面再開伺服器：瀏覽器啟動失敗時不會留下沒關的伺服器（檔案程序結束不了）
  const s = await newContext({ holdBoot: true });
  const server = await startServer();
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
  // 先開瀏覽器頁面再開伺服器：瀏覽器啟動失敗時不會留下沒關的伺服器（檔案程序結束不了）
  const s = await newContext();
  const server = await startServer();
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
    // 圖片補上、延後程式執行、排隊的切頁完成（整套測試平行跑時比較慢，用條件等而不是固定時間）
    await s.page.waitForFunction(() => !paymentImagesMissed() && DeferredApp.loaded() &&
      document.querySelector('.page-container.active').id === 'pageOverview', null, { timeout: 10000 }).catch(() => {});
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
  // 先開瀏覽器頁面再開伺服器：瀏覽器啟動失敗時不會留下沒關的伺服器（檔案程序結束不了）
  const s = await newContext();
  const server = await startServer();
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
    await s.page.locator('#expenseKeypad .key[aria-label="1"]').tap();
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
  // 先開瀏覽器頁面再開伺服器：瀏覽器啟動失敗時不會留下沒關的伺服器（檔案程序結束不了）
  const s = await newContext({ background: true });
  const server = await startServer();
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
