#!/usr/bin/env node
// 效能量測與截圖比對：用 headless Chromium 模擬低效能手機，量開機、閒置、互動延遲、動畫盤點，並截圖做視覺回歸。
// 資料一律用內建合成資料（tools/gas-mock/fixture.mjs），「今天」固定在 2026-11-13 12:00（台北），結果才能互相比較。
//
//   npm run perf                                   預設：CPU 4 倍降速、重複 3 次取中位數、與 tools/perf/baseline.json 比較
//   npm run perf -- --label before                 結果存成 results/<日期時間>-before.json，截圖存到 screens/before/
//   npm run perf -- --label after --baseline <檔名> --compare before
//                                                  印出與指定結果的差值，並用 pixelmatch 比對 screens/before/ 的截圖
//   npm run perf -- --cpu 6 --net fast3g           CPU 6 倍降速＋Fast 3G（latency 150ms、下載 1.6Mbps、上傳 750Kbps）
//   npm run perf -- --save-baseline                把這次結果寫成 tools/perf/baseline.json（截圖同時複製到 screens/baseline/）
//
// 其他參數：--runs <n>（重複次數，預設 3）、--no-baseline（不自動比較 baseline.json）、--skip-screens（不截圖）、
//          --raster-threads <n>（點陣化執行緒數，預設 1；見 main() 的說明）、
//          --dist <資料夾>（量別的建置產物，例如舊版本：git worktree 建置後指過去；預設 dist/）、
//          --full-page（截整頁而不是手機畫面大小；固定元素位置會失真，只在要檢查下半頁時用）。
// 偏好設定一律用 App 的預設值（動畫效果：完整）。P04 移除裝置分級之後所有裝置都是同一套高畫質動畫，
// 不用再預先指定等級；舊結果檔記的 prefs: 'high'（P03 以前強制高畫質）視為同一個量測條件。
//
// P05 新增：「轉場開始」＝按下導覽列到 View Transition 的 ready（動畫真的開始），Event Timing 量不到 update callback；
//          「動畫期間 Layout」＝新增／刪除紀錄、展開／收合區塊時主執行緒的排版次數（FLIP 之後應該只剩開頭或結尾一次）。
// P06 新增：「長清單」＝合成資料加長到 30 筆（記一筆支出時 renderRecent／renderRecentList 的腳本時間，
//          CPU 4 倍降速、記 8 筆取中位數）與 300 筆（載入完整紀錄的腳本時間、在完整紀錄上觸控捲動的幀率）。
//          --lists-only：只跑長清單這一段（快速比較用，結果不寫入 baseline）。
// P08 新增：「開機（有本機快取）」＝先不降速開一次讓 LocalCache 有資料，再降速重新載入量開機；
//          「開機後立刻互動」＝boot-ready 一出現就點支出項目、按數字鍵（不等資料同步），量 Event Timing。
//          結尾印出 P08 的驗收檢查（boot-ready、最長長任務、開機後立刻互動）。
// 注意：headless 是軟體繪圖，絕對數字比真機悲觀，只拿來比較「改之前／改之後」的相對變化。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { createDevApp } from '../dev-server.mjs';

const PERF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PERF_DIR, '..', '..');
const RESULTS_DIR = path.join(PERF_DIR, 'results');
const SCREENS_DIR = path.join(PERF_DIR, 'screens');
const BASELINE_FILE = path.join(PERF_DIR, 'baseline.json');

/* ---------------------------------------------------------------------------
 * 參數
 * ------------------------------------------------------------------------- */
function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    out[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}
const args = parseArgs(process.argv.slice(2));
const OPT = {
  label: typeof args.label === 'string' ? args.label.replace(/[^\w.\-一-鿿]/g, '_') : 'run',
  cpu: Number(args.cpu) || 4,
  net: args.net === 'fast3g' ? 'fast3g' : 'none',
  runs: Math.max(1, Number(args.runs) || 3),
  screens: !args['skip-screens'],
  fullPage: Boolean(args['full-page']),
  rasterThreads: Math.max(1, Number(args['raster-threads']) || 1),
  dist: typeof args.dist === 'string' ? path.resolve(args.dist) : '',
  compare: typeof args.compare === 'string' ? args.compare : '',
  baseline: typeof args.baseline === 'string' ? args.baseline : '',
  autoBaseline: !args['no-baseline'],
  saveBaseline: Boolean(args['save-baseline']),
  listsOnly: Boolean(args['lists-only']),
};
if (args.net && args.net !== 'fast3g') fail('--net 只支援 fast3g');

const VIEWPORT = { width: 390, height: 844 };
const DPR = 2;
const FIXED_NOW = Date.UTC(2026, 10, 13, 4, 0, 0);          // 2026-11-13 12:00 台北（與 tools/test 相同）
const IDLE_MS = 5000;
const ACTION_GAP_MS = 1500;
const INPUT_ROUNDS = 3;
const SETTLE_MS = 2000;
const SLOW_FRAME_MS = 50.5;
// 判定「改善／變差」：差異要超過 10%，而且絕對值超過這個雜訊門檻（超過一個 vsync 16.7ms、或 5 次／幀）
const NOISE_FLOOR = { ms: 17, '幀': 5, '次': 5, '個': 1, fps: 3 };
const FAST3G = { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 };

const PAGES = [
  { key: 'bookkeeping', label: '記帳頁', nav: '#navBookkeeping' },
  { key: 'overview', label: '總覽頁', nav: '#navOverview' },
  { key: 'settings', label: '設定頁', nav: '#navSettings' },
];
const ACTIONS = [
  { key: 'selectItem', label: '點支出項目', sel: '#expenseItemChoices .choice' },
  { key: 'keypadDigit', label: '按數字鍵', sel: '#expenseKeypad .key:text-is("1")', prepare: prepareSubmit },
  { key: 'submit', label: '按送出', sel: '#expenseSubmit' },
  { key: 'toOverview', label: '切到總覽', sel: '#navOverview', vt: true },
  { key: 'toSettings', label: '切到設定', sel: '#navSettings', vt: true },
  { key: 'toBookkeeping', label: '回到記帳', sel: '#navBookkeeping', vt: true },
];

/* ---------------------------------------------------------------------------
 * 指標定義（順序就是表格的順序）；better：數字往哪邊是變好
 * ------------------------------------------------------------------------- */
const METRICS = [];
const metric = (key, label, unit, better) => METRICS.push({ key, label, unit, better });
metric('boot.responseEnd', '開機 responseEnd', 'ms', 'down');
metric('boot.domContentLoaded', '開機 DOMContentLoaded 結束', 'ms', 'down');
metric('boot.bootReady', '開機 boot-ready', 'ms', 'down');
metric('boot.longTaskTotal', '開機長任務總和', 'ms', 'down');
metric('boot.longTaskMax', '開機最長長任務', 'ms', 'down');
metric('bootWarm.bootReady', '開機（有本機快取）boot-ready', 'ms', 'down');
metric('bootWarm.longTaskTotal', '開機（有本機快取）長任務總和', 'ms', 'down');
metric('bootWarm.longTaskMax', '開機（有本機快取）最長長任務', 'ms', 'down');
const BOOT_ACTIONS = [
  { key: 'selectItem', label: '開機後立刻點支出項目', sel: '#expenseItemChoices .choice' },
  { key: 'keypadDigit', label: '開機後立刻按數字鍵', sel: '#expenseKeypad .key:text-is("1")' },
];
BOOT_ACTIONS.forEach(a => metric('bootInput.' + a.key, a.label, 'ms', 'down'));
const IDLE_VARIANTS = PAGES.map(p => ({ key: p.key, label: p.label }))
  .concat([{ key: 'bookkeepingPaused', label: '記帳頁（動畫全暫停）' }]);
IDLE_VARIANTS.forEach(v => {
  const k = 'idle.' + v.key + '.';
  metric(k + 'frames', v.label + ' 閒置 5 秒幀數', '幀', 'up');
  metric(k + 'slowFrames', v.label + ' 超過 50ms 的幀', '幀', 'down');
  metric(k + 'p95FrameMs', v.label + ' p95 幀時間', 'ms', 'down');
  metric(k + 'recalcStyleCount', v.label + ' RecalcStyleCount', '次', 'down');
  metric(k + 'recalcStyleMs', v.label + ' RecalcStyleDuration', 'ms', 'down');
  metric(k + 'layoutCount', v.label + ' LayoutCount', '次', 'down');
  metric(k + 'taskMs', v.label + ' TaskDuration', 'ms', 'down');
  metric(k + 'paintCount', v.label + ' Paint 次數', '次', 'down');
  metric(k + 'paintMs', v.label + ' Paint 總時間', 'ms', 'down');
  metric(k + 'rasterCount', v.label + ' RasterTask 次數', '次', 'down');
  metric(k + 'rasterMs', v.label + ' RasterTask 總時間', 'ms', 'down');
  metric(k + 'drawMs', v.label + ' 合成器繪製總時間', 'ms', 'down');
  metric(k + 'renderPasses', v.label + ' 合成 render pass 數', '次', 'down');
});
// 捲動：觸控捲動手勢往下再往上（P03 起），背後內容在動時毛玻璃、黏頂 header 的成本才看得出來
const SCROLL_PAGES = PAGES.filter(p => p.key !== 'settings');
SCROLL_PAGES.forEach(p => {
  const k = 'scroll.' + p.key + '.';
  metric(k + 'fps', p.label + ' 捲動平均幀率', 'fps', 'up');
  metric(k + 'slowFrames', p.label + ' 捲動超過 50ms 的幀', '幀', 'down');
  metric(k + 'p95FrameMs', p.label + ' 捲動 p95 幀時間', 'ms', 'down');
  metric(k + 'drawMs', p.label + ' 捲動合成器繪製總時間', 'ms', 'down');
});
ACTIONS.forEach(a => metric('input.' + a.key, '互動延遲：' + a.label, 'ms', 'down'));
// 頁面切換（P05 起）：Event Timing 只量到「點擊後的第一次繪製」，View Transitions 的 update callback 在那之後才執行，
// 所以另外量「按下 → transition.ready（轉場動畫開始）」與 update callback 本身花的時間。
ACTIONS.filter(a => a.vt).forEach(a => {
  metric('vt.' + a.key + '.ready', '轉場開始：' + a.label, 'ms', 'down');
  metric('vt.' + a.key + '.update', '轉場 update callback：' + a.label, 'ms', 'down');
});
// 一次性動畫期間主執行緒的 Layout 次數（P05）：高度變化改用 FLIP 之後，動畫期間只剩開頭（或結尾）一次排版，不再逐幀排版
const FLIP_CASES = [
  { key: 'expand', label: '新增紀錄（expandIn）' },
  { key: 'collapse', label: '刪除紀錄（collapseOut）' },
  { key: 'toggleOpen', label: '展開區塊（toggleHidden）' },
  { key: 'toggleClose', label: '收合區塊（toggleHidden）' },
];
FLIP_CASES.forEach(c => {
  metric('flip.' + c.key + '.layouts', c.label + ' 動畫期間 Layout', '次', 'down');
  metric('flip.' + c.key + '.frames', c.label + ' 動畫期間幀數', '幀', 'up');
});
// 長清單（P06）
metric('longlist.submitRenderMs', '記一筆支出：renderRecent 腳本時間（30 筆完整清單）', 'ms', 'down');
metric('longlist.fullRenderMs', '載入 300 筆完整紀錄：renderRecentList 腳本時間', 'ms', 'down');
metric('longlist.scroll.fps', '300 筆完整紀錄 捲動平均幀率', 'fps', 'up');
metric('longlist.scroll.slowFrames', '300 筆完整紀錄 捲動超過 50ms 的幀', '幀', 'down');
metric('longlist.scroll.p95FrameMs', '300 筆完整紀錄 捲動 p95 幀時間', 'ms', 'down');
metric('longlist.scroll.drawMs', '300 筆完整紀錄 捲動合成器繪製總時間', 'ms', 'down');
PAGES.forEach(p => {
  metric('static.' + p.key + '.runningAnimations', p.label + ' 執行中動畫數', '個', 'down');
  metric('static.' + p.key + '.backdropInView', p.label + ' 畫面內 backdrop-filter', '個', 'down');
});
const META = Object.fromEntries(METRICS.map(m => [m.key, m]));

/* ---------------------------------------------------------------------------
 * 注入頁面的量測程式（在頁面任何程式之前執行）
 * ------------------------------------------------------------------------- */
function pageInstrument(cfg) {
  // 1. 固定時鐘：從 cfg.fixedNow 開始、照真實速度往前走（計時器、動畫照常）。
  const RealDate = Date;
  const offset = cfg.fixedNow - RealDate.now();
  class FixedDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  window.Date = new Proxy(FixedDate, { apply: () => new FixedDate().toString() });

  // 2. 偏好設定：不預設，用 App 自己的預設值（每個 context 的 localStorage 都是空的）

  const P = window.__perf = { bootReady: null, longTasks: [], events: [], rpcInflight: 0, rpcLastEnd: 0 };

  // 3. <html> 出現 boot-ready 的時間
  const check = () => {
    const el = document.documentElement;
    if (P.bootReady == null && el && el.classList.contains('boot-ready')) P.bootReady = performance.now();
    return P.bootReady != null;
  };
  const watchHtml = () => {
    const mo = new MutationObserver(() => { if (check()) mo.disconnect(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  };
  if (document.documentElement) watchHtml();
  else {
    const wait = new MutationObserver(() => { if (document.documentElement) { wait.disconnect(); watchHtml(); } });
    wait.observe(document, { childList: true });
  }

  // 4. 長任務與 Event Timing
  try {
    new PerformanceObserver(list => {
      list.getEntries().forEach(e => P.longTasks.push({ start: e.startTime, dur: e.duration }));
    }).observe({ type: 'longtask', buffered: true });
  } catch (e) {}
  try {
    new PerformanceObserver(list => {
      list.getEntries().forEach(e => P.events.push({ name: e.name, start: e.startTime, dur: e.duration }));
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch (e) {}

  // 5. View Transitions：記錄每次 startViewTransition 的 update callback 時間與 ready（動畫開始）的時間，
  //    以及最近一次 pointerdown 的時間戳（和 performance.now() 同一個時間軸）
  P.vts = [];
  P.lastDown = null;
  window.addEventListener('pointerdown', e => { P.lastDown = e.timeStamp; }, { capture: true, passive: true });
  const realVT = Document.prototype.startViewTransition;
  if (typeof realVT === 'function') {
    Document.prototype.startViewTransition = function (arg) {
      const rec = { called: performance.now(), down: P.lastDown, updateStart: null, updateEnd: null, ready: null };
      P.vts.push(rec);
      const cb = typeof arg === 'function' ? arg : (arg && arg.update);
      const wrapped = function () {
        rec.updateStart = performance.now();
        try { return cb ? cb.apply(this, arguments) : undefined; } finally { rec.updateEnd = performance.now(); }
      };
      const t = realVT.call(this, (arg && typeof arg === 'object') ? Object.assign({}, arg, { update: wrapped }) : wrapped);
      t.ready.then(() => { rec.ready = performance.now(); }, () => {});
      return t;
    };
  }

  // 6. 追蹤進行中的 google.script.run（本機替身走 fetch('/__rpc')），用來判斷資料載完了沒
  const realFetch = window.fetch;
  window.fetch = function (input) {
    const isRpc = String(input && input.url || input).indexOf('/__rpc') !== -1;
    if (!isRpc) return realFetch.apply(this, arguments);
    P.rpcInflight++;
    const done = () => { P.rpcInflight--; P.rpcLastEnd = performance.now(); };
    return realFetch.apply(this, arguments).then(r => { done(); return r; }, e => { done(); throw e; });
  };
}

/* ---------------------------------------------------------------------------
 * 小工具
 * ------------------------------------------------------------------------- */
function fail(msg) { console.error('✗ ' + msg); process.exit(1); }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const round = (v, d = 0) => (v == null || Number.isNaN(v) ? null : Math.round(v * 10 ** d) / 10 ** d);
function median(list) {
  const xs = list.filter(v => typeof v === 'number').sort((a, b) => a - b);
  if (!xs.length) return null;
  const m = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[m] : (xs[m - 1] + xs[m]) / 2;
}
function percentile(xs, p) {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil(p / 100 * s.length) - 1)];
}
function shiftedDate(startMs) {
  const offset = startMs - Date.now();
  return class PerfDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(Date.now() + offset); }
    static now() { return Date.now() + offset; }
  };
}
function stamp(d) {
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

async function startApp(fixtureOptions) {
  const app = createDevApp({ fixture: true, quiet: true, DateCtor: shiftedDate(FIXED_NOW), root: OPT.dist || undefined, fixtureOptions });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + app.server.address().port + '/', close: () => new Promise(r => app.server.close(r)) };
}

async function newPage(browser, opts) {
  const o = opts || {};
  const context = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: DPR, isMobile: true, hasTouch: true,
    locale: 'zh-TW', timezoneId: 'Asia/Taipei', colorScheme: o.theme || 'light',
  });
  await context.addInitScript(pageInstrument, { fixedNow: FIXED_NOW });
  const page = await context.newPage();
  page.on('pageerror', e => console.warn('  [頁面錯誤] ' + e.message));
  const cdp = await context.newCDPSession(page);
  if (o.throttle) await applyThrottle(cdp);
  await cdp.send('Performance.enable');
  return { context, page, cdp };
}

async function applyThrottle(cdp) {
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: OPT.cpu });
  if (OPT.net === 'fast3g') {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', FAST3G);
  }
}

async function boot(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await page.waitForFunction(() => window.__perf && window.__perf.bootReady != null, null, { polling: 100, timeout: 120000 });
}

/** 等資料請求都回來、且安靜一段時間，再多等 SETTLE_MS 讓轉場與一次性動畫跑完。 */
async function settle(page, extra = SETTLE_MS) {
  await page.waitForFunction(
    () => window.__perf.rpcInflight === 0 && performance.now() - window.__perf.rpcLastEnd > 800,
    null, { polling: 100, timeout: 60000 });
  await sleep(extra);
}

async function goTo(page, pageKey) {
  const p = PAGES.find(x => x.key === pageKey);
  const isActive = await page.evaluate(k => document.body.dataset.page === k || (!document.body.dataset.page && k === 'bookkeeping'), pageKey);
  if (!isActive) await page.locator(p.nav).tap();
  await settle(page);
}

const inPageNow = page => page.evaluate(() => performance.now());

/* ---------------------------------------------------------------------------
 * a. 開機
 * ------------------------------------------------------------------------- */
async function measureBoot(page) {
  await sleep(SETTLE_MS);   // 讓開機後 2 秒內的長任務也算進來
  return page.evaluate(settleMs => {
    const nav = performance.getEntriesByType('navigation')[0] || {};
    const P = window.__perf;
    const limit = P.bootReady + settleMs;
    const lt = P.longTasks.filter(t => t.start < limit);
    return {
      responseEnd: nav.responseEnd,
      domContentLoaded: nav.domContentLoadedEventEnd,
      bootReady: P.bootReady,
      longTaskTotal: lt.reduce((a, t) => a + t.dur, 0),
      longTaskMax: lt.reduce((a, t) => Math.max(a, t.dur), 0),
      longTaskCount: lt.length,
    };
  }, SETTLE_MS);
}

/** P08：有本機快取時的開機，以及開機後立刻互動。
 *  同一個 context 先不降速開一次（LocalCache 存下開機資料、最近紀錄、設定），再降速重新載入兩次：
 *  第一次只量開機（boot-ready、長任務），第二次 boot-ready 一出現就點支出項目、按數字鍵（不等背景同步）。 */
async function measureWarmBoot(browser) {
  const app = await startApp();
  const { context, page, cdp } = await newPage(browser, { throttle: false });
  try {
    await boot(page, app.url);
    await settle(page, 500);
    await applyThrottle(cdp);
    await boot(page, app.url);
    const warm = await measureBoot(page);

    await boot(page, app.url);
    const windows = [];
    for (const a of BOOT_ACTIONS) {
      const t0 = await inPageNow(page);
      try {
        await page.locator(a.sel).first().tap({ timeout: 15000, noWaitAfter: true });
      } catch (e) {
        console.warn('  [開機後互動] ' + a.label + ' 失敗：' + e.message.split('\n')[0]);
        windows.push({ key: a.key, t0, failed: true });
        continue;
      }
      windows.push({ key: a.key, t0 });
    }
    await sleep(1500);   // Event Timing 在下一次繪製後才送出
    const events = await page.evaluate(() => window.__perf.events.slice());
    const inputs = {};
    windows.forEach((w, i) => {
      const t1 = i + 1 < windows.length ? windows[i + 1].t0 : Infinity;
      const hits = events.filter(e => e.start >= w.t0 && e.start < t1);
      inputs[w.key] = w.failed ? null : hits.reduce((m, e) => Math.max(m, e.dur), 0);
    });
    return { warm, inputs };
  } finally {
    await context.close();
    await app.close();
  }
}

/* ---------------------------------------------------------------------------
 * b. 閒置
 * ------------------------------------------------------------------------- */
async function getMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map(m => [m.name, m.value]));
}

// RasterTask 屬於 disabled-by-default-devtools.timeline（DevTools 效能面板也會一起開），只開 devtools.timeline 會量到 0。
// viz：合成器（Display::DrawAndSwap、每個 render pass）。backdrop-filter 的成本落在這裡（每一層都要讀回背後畫面、
// 多一個 render pass），主執行緒的 Paint／Raster 量不到。headless 是軟體合成，數字只拿來比較前後。
const TRACE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'viz'];

async function startTrace(cdp) {
  const events = [];
  const onData = e => { for (const ev of e.value) events.push(ev); };
  cdp.on('Tracing.dataCollected', onData);
  await cdp.send('Tracing.start', { traceConfig: { includedCategories: TRACE_CATEGORIES }, transferMode: 'ReportEvents' });
  return async () => {
    const done = new Promise(r => cdp.once('Tracing.tracingComplete', r));
    await cdp.send('Tracing.end');
    await done;
    cdp.off('Tracing.dataCollected', onData);
    return events;
  };
}

function summarizeTrace(events) {
  const out = { Paint: { count: 0, us: 0 }, RasterTask: { count: 0, us: 0 }, 'Display::DrawAndSwap': { count: 0, us: 0 }, 'DirectRenderer::DrawRenderPass': { count: 0, us: 0 } };
  const open = new Map();
  for (const ev of events) {
    const bucket = out[ev.name];
    if (!bucket) continue;
    if (ev.ph === 'X') { bucket.count++; bucket.us += ev.dur || 0; }
    else if (ev.ph === 'B') open.set(ev.name + ':' + ev.tid, ev.ts);
    else if (ev.ph === 'E') {
      const k = ev.name + ':' + ev.tid;
      if (open.has(k)) { bucket.count++; bucket.us += ev.ts - open.get(k); open.delete(k); }
    }
  }
  return out;
}

async function measureIdle(page, cdp) {
  const stopTrace = await startTrace(cdp);
  const m0 = await getMetrics(cdp);
  const ts = await page.evaluate(ms => new Promise(resolve => {
    const list = [];
    let t0 = null;
    const tick = t => {
      if (t0 == null) t0 = t;
      list.push(t);
      if (t - t0 < ms) requestAnimationFrame(tick); else resolve(list);
    };
    requestAnimationFrame(tick);
  }), IDLE_MS);
  const m1 = await getMetrics(cdp);
  const trace = summarizeTrace(await stopTrace());
  const deltas = ts.slice(1).map((t, i) => t - ts[i]);
  const d = k => (m1[k] || 0) - (m0[k] || 0);
  return {
    frames: deltas.length,
    // rAF 時間戳對齊 vsync（16.67ms 一格）：剛好 3 格的幀量起來是 50.0±0.1ms，用 50.5 才不會在門檻上隨機跳動。
    slowFrames: deltas.filter(x => x > SLOW_FRAME_MS).length,
    p95FrameMs: percentile(deltas, 95),
    recalcStyleCount: d('RecalcStyleCount'),
    recalcStyleMs: d('RecalcStyleDuration') * 1000,
    layoutCount: d('LayoutCount'),
    taskMs: d('TaskDuration') * 1000,
    paintCount: trace.Paint.count,
    paintMs: trace.Paint.us / 1000,
    rasterCount: trace.RasterTask.count,
    rasterMs: trace.RasterTask.us / 1000,
    drawMs: trace['Display::DrawAndSwap'].us / 1000,
    renderPasses: trace['DirectRenderer::DrawRenderPass'].count,
  };
}

/** 觸控捲動手勢：往下 SCROLL_PX、再往上回到頂端，量這段期間的幀與合成器繪製時間。 */
const SCROLL_PX = 1600;
const SCROLL_SPEED = 1200;   // px/s，接近手指快速滑動
async function measureScroll(page, cdp) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  const stopTrace = await startTrace(cdp);
  const sampler = page.evaluate(() => new Promise(resolve => {
    const list = [];
    window.__perfScrollStop = () => resolve(list);
    const tick = t => { list.push(t); if (window.__perfScrollStop) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }));
  const gesture = { x: VIEWPORT.width / 2, y: VIEWPORT.height * 0.6, speed: SCROLL_SPEED, gestureSourceType: 'touch', preventFling: true };
  await cdp.send('Input.synthesizeScrollGesture', Object.assign({ yDistance: -SCROLL_PX }, gesture));
  await cdp.send('Input.synthesizeScrollGesture', Object.assign({ yDistance: SCROLL_PX }, gesture));
  await page.evaluate(() => { const f = window.__perfScrollStop; window.__perfScrollStop = null; f(); });
  const ts = await sampler;
  const trace = summarizeTrace(await stopTrace());
  const deltas = ts.slice(1).map((t, i) => t - ts[i]);
  const secs = (ts[ts.length - 1] - ts[0]) / 1000;
  return {
    fps: secs > 0 ? deltas.length / secs : null,
    slowFrames: deltas.filter(x => x > SLOW_FRAME_MS).length,
    p95FrameMs: percentile(deltas, 95),
    drawMs: trace['Display::DrawAndSwap'].us / 1000,
  };
}

/* ---------------------------------------------------------------------------
 * c. 互動延遲（Event Timing，取每個動作時間窗內 duration 最大值）
 * ------------------------------------------------------------------------- */
/** 送出前要有總類與支付方式；沒有自動帶入時先點第一個（這兩下不計入任何動作）。 */
async function prepareSubmit(page) {
  for (const box of ['#expenseCategoryChoices', '#paymentChoices']) {
    const selected = await page.locator(box + ' .choice.selected').count();
    if (!selected) { await page.locator(box + ' .choice').first().tap(); await sleep(ACTION_GAP_MS); }
  }
}

async function measureInputs(page) {
  const windows = [];
  for (const action of ACTIONS) {
    if (action.prepare) await action.prepare(page);
    const t0 = await inPageNow(page);
    try {
      await page.locator(action.sel).first().tap({ timeout: 15000 });
    } catch (e) {
      console.warn('  [互動] ' + action.label + ' 失敗：' + e.message.split('\n')[0]);
      windows.push({ key: action.key, t0, t1: t0, failed: true });
      continue;
    }
    await sleep(ACTION_GAP_MS);
    windows.push({ key: action.key, t0, t1: await inPageNow(page) });
  }
  await sleep(1000);   // Event Timing 會在下一次繪製後才送出，多等一下把最後一筆收齊
  const events = await page.evaluate(() => window.__perf.events.slice());
  const vts = await page.evaluate(() => window.__perf.vts.slice());
  const out = {};
  const detail = {};
  for (const w of windows) {
    const action = ACTIONS.find(a => a.key === w.key);
    if (action && action.vt) {
      const vt = vts.find(v => v.called >= w.t0 && v.called < w.t1);
      const ok = vt && !w.failed && vt.ready != null && vt.down != null && vt.down >= w.t0 - 50;
      out['vt.' + w.key + '.ready'] = ok ? vt.ready - vt.down : null;
      out['vt.' + w.key + '.update'] = vt && vt.updateEnd != null ? vt.updateEnd - vt.updateStart : null;
    }
    const hits = events.filter(e => e.start >= w.t0 && e.start < w.t1);
    const top = hits.reduce((a, e) => (!a || e.dur > a.dur ? e : a), null);
    out[w.key] = w.failed ? null : (top ? top.dur : 0);
    detail[w.key] = top ? top.name : (w.failed ? '失敗' : '< 16ms');
  }
  return { values: out, detail };
}

/* ---------------------------------------------------------------------------
 * d. 動畫盤點
 * ------------------------------------------------------------------------- */
function inventoryInPage() {
  const describe = el => {
    if (!el || !el.tagName) return '?';
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).join('.');
    return s;
  };
  const skip = new Set(['offset', 'computedOffset', 'easing', 'composite']);
  // getKeyframes() 不會列出自訂屬性（例如 @property --uv-card-angle），所以另外從樣式表的 @keyframes 補齊。
  const cssKeyframeProps = {};
  const walk = rules => {
    for (const rule of rules) {
      if (rule.type === CSSRule.KEYFRAMES_RULE) {
        const set = cssKeyframeProps[rule.name] || (cssKeyframeProps[rule.name] = new Set());
        for (const kf of rule.cssRules) for (let i = 0; i < kf.style.length; i++) set.add(kf.style[i]);
      } else if (rule.cssRules) walk(rule.cssRules);
    }
  };
  for (const sheet of document.styleSheets) { try { walk(sheet.cssRules); } catch (e) {} }
  const camel = s => (s.startsWith('--') ? s : s.replace(/-([a-z])/g, (_, c) => c.toUpperCase()));
  const animations = document.getAnimations().filter(a => a.playState === 'running').map(a => {
    const eff = a.effect;
    let props = [];
    let iterations = null;
    try { props = eff.getKeyframes().flatMap(k => Object.keys(k)).filter(k => !skip.has(k)); } catch (e) {}
    if (a.animationName && cssKeyframeProps[a.animationName]) props = props.concat(Array.from(cssKeyframeProps[a.animationName], camel));
    props = Array.from(new Set(props));
    try { iterations = eff.getComputedTiming().iterations; } catch (e) {}
    return {
      name: a.animationName || (a.transitionProperty ? 'transition:' + a.transitionProperty : (a.id || '(script)')),
      kind: a.constructor && a.constructor.name,
      props,
      target: describe(eff && eff.target) + ((eff && eff.pseudoElement) || ''),
      iterations: iterations === Infinity ? 'infinite' : iterations,
    };
  });
  const vw = innerWidth;
  const vh = innerHeight;
  const backdrop = [];
  let rendered = 0;
  document.querySelectorAll('*').forEach(el => {
    const r = el.getBoundingClientRect();
    const has = r.width > 0 && r.height > 0;
    const inView = has && r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    [null, '::before', '::after'].forEach(pseudo => {
      const cs = getComputedStyle(el, pseudo);
      const bf = cs.backdropFilter || cs.webkitBackdropFilter;
      if (!bf || bf === 'none') return;
      if (pseudo && (cs.content === 'none' || cs.content === 'normal')) return;
      if (cs.display === 'none' || cs.visibility === 'hidden') return;
      if (has) rendered++;
      if (inView) backdrop.push({ target: describe(el) + (pseudo || ''), filter: bf });
    });
  });
  return { animations, backdropInView: backdrop.length, backdropRendered: rendered, backdrop };
}

/* ---------------------------------------------------------------------------
 * e. 截圖（定格在第 0 幀）與比對
 * ------------------------------------------------------------------------- */
async function freezeAndShoot(page, file) {
  await page.evaluate(() => {
    document.getAnimations().forEach(a => { a.pause(); a.currentTime = 0; });
    // 背景光暈畫在 canvas（P01，core/background.js），不是 CSS 動畫，要另外定格
    if (window.__bgDebug) window.__bgDebug.setTime(0);
  });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  // 預設只截手機畫面大小（390×844）：整頁截圖會把視窗撐成整頁高，100vh 背景會被拉長、固定的底部導覽列會跑到圖中間。
  await page.screenshot({ path: file, fullPage: OPT.fullPage, animations: 'allow', caret: 'hide' });
  // 恢復播放，下一頁的動畫才是正常狀態
  await page.evaluate(() => {
    document.getAnimations().forEach(a => { if (a.playState === 'paused') a.play(); });
    if (window.__bgDebug) window.__bgDebug.setTime(null);
  });
}

function padPng(png, w, h) {
  if (png.width === w && png.height === h) return png.data;
  const out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < png.height; y++) png.data.copy(out, y * w * 4, y * png.width * 4, (y + 1) * png.width * 4);
  return out;
}

function compareScreens(label, base) {
  const curDir = path.join(SCREENS_DIR, label);
  const baseDir = path.join(SCREENS_DIR, base);
  if (!fs.existsSync(baseDir)) { console.warn('  找不到基準截圖資料夾：' + path.relative(ROOT, baseDir)); return null; }
  const diffDir = path.join(curDir, 'diff-vs-' + base);
  fs.mkdirSync(diffDir, { recursive: true });
  const out = {};
  for (const name of fs.readdirSync(curDir).filter(f => f.endsWith('.png')).sort()) {
    const bFile = path.join(baseDir, name);
    if (!fs.existsSync(bFile)) { out[name] = { missing: true }; continue; }
    const a = PNG.sync.read(fs.readFileSync(path.join(curDir, name)));
    const b = PNG.sync.read(fs.readFileSync(bFile));
    const w = Math.max(a.width, b.width);
    const h = Math.max(a.height, b.height);
    const diff = new PNG({ width: w, height: h });
    const pixels = pixelmatch(padPng(a, w, h), padPng(b, w, h), diff.data, w, h, { threshold: 0.1 });
    fs.writeFileSync(path.join(diffDir, name), PNG.sync.write(diff));
    out[name] = {
      diffPixels: pixels,
      percent: round(pixels / (w * h) * 100, 3),
      sizeChanged: a.width !== b.width || a.height !== b.height ? [b.width + '×' + b.height, a.width + '×' + a.height] : null,
    };
  }
  return { base, diffDir: path.relative(ROOT, diffDir), files: out };
}

/* ---------------------------------------------------------------------------
 * 流程
 * ------------------------------------------------------------------------- */
// 頁面狀態會大幅影響幀率（例如輸入金額後送出鈕的 uv-btn-* 動畫開始跑、捲動位置改變畫面內的毛玻璃），
// 所以每一段量測都從固定的狀態開始：
//   1. 開機 → 閒置（記帳、總覽、設定、記帳全暫停）：剛開機、還沒有任何互動
//   2. 互動延遲：每一遍都重新開機（新的合成資料、新的頁面），量的都是「開機後第一次操作」
async function oneRun(browser, index) {
  const flat = {};
  let bootStats;
  let idle;
  {
    const app = await startApp();   // 每次重新載入合成資料，前一次送出的紀錄不會影響這一次
    const { context, page, cdp } = await newPage(browser, { throttle: true });
    try {
      await boot(page, app.url);
      bootStats = await measureBoot(page);
      for (const k of Object.keys(bootStats)) flat['boot.' + k] = bootStats[k];

      idle = {};
      const scroll = {};
      for (const p of PAGES) {
        await goTo(page, p.key);
        idle[p.key] = await measureIdle(page, cdp);
        if (SCROLL_PAGES.includes(p)) {
          scroll[p.key] = await measureScroll(page, cdp);
          for (const k of Object.keys(scroll[p.key])) flat['scroll.' + p.key + '.' + k] = scroll[p.key][k];
        }
      }
      await goTo(page, 'bookkeeping');
      await page.evaluate(() => {
        document.getAnimations().forEach(a => a.pause());
        if (window.__bgDebug) window.__bgDebug.sync();   // 背景 canvas 跟著已暫停的 CSS 呼吸動畫定格
      });
      idle.bookkeepingPaused = await measureIdle(page, cdp);
      for (const v of Object.keys(idle)) for (const k of Object.keys(idle[v])) flat['idle.' + v + '.' + k] = idle[v][k];
    } finally {
      await context.close();
      await app.close();
    }
  }

  // 互動延遲以 8ms 為單位、單次波動大：做 INPUT_ROUNDS 遍（每遍重新開機），取中位數。
  const rounds = [];
  for (let r = 0; r < INPUT_ROUNDS; r++) {
    const app = await startApp();
    const { context, page } = await newPage(browser, { throttle: true });
    try {
      await boot(page, app.url);
      await settle(page);
      rounds.push(await measureInputs(page));
    } finally {
      await context.close();
      await app.close();
    }
  }
  const inputs = { values: {}, samples: {}, detail: rounds.map(x => x.detail) };
  for (const a of ACTIONS) {
    inputs.samples[a.key] = rounds.map(x => x.values[a.key]);
    inputs.values[a.key] = median(inputs.samples[a.key]);
    flat['input.' + a.key] = inputs.values[a.key];
    if (!a.vt) continue;
    for (const part of ['ready', 'update']) {
      const k = 'vt.' + a.key + '.' + part;
      inputs.samples[k] = rounds.map(x => x.values[k]);
      flat[k] = median(inputs.samples[k]);
    }
  }

  const warmBoot = await measureWarmBoot(browser);
  for (const k of Object.keys(warmBoot.warm)) flat['bootWarm.' + k] = warmBoot.warm[k];
  for (const k of Object.keys(warmBoot.inputs)) flat['bootInput.' + k] = warmBoot.inputs[k];

  console.log('  第 ' + index + ' 次：boot-ready ' + round(bootStats.bootReady) + 'ms（有快取 ' + round(warmBoot.warm.bootReady) +
    'ms）、最長長任務 ' + round(bootStats.longTaskMax) + 'ms、記帳頁閒置 ' + idle.bookkeeping.frames +
    ' 幀、送出 ' + round(inputs.values.submit) + 'ms');
  return { metrics: flat, inputEvents: { samples: inputs.samples, topEvent: inputs.detail } };
}

async function warmup(browser) {
  const app = await startApp();
  const { context, page } = await newPage(browser, { throttle: true });
  try { await boot(page, app.url); await settle(page, 500); } finally { await context.close(); await app.close(); }
}

/* ---------------------------------------------------------------------------
 * f. 一次性動畫的排版（P05）：直接對真實的清單列與搜尋頁的「更多篩選」呼叫 Motion，錄 trace 數主執行緒的 Layout
 * ------------------------------------------------------------------------- */
const FLIP_CATS = ['devtools.timeline', 'disabled-by-default-devtools.timeline', 'disabled-by-default-devtools.timeline.frame'];
function countInTrace(buf) {
  const ev = JSON.parse(buf.toString()).traceEvents;
  const main = ev.find(e => e.name === 'thread_name' && e.args && e.args.name === 'CrRendererMain');
  const mark = n => ev.find(e => e.name === 'TimeStamp' && e.args && e.args.data && e.args.data.message === n);
  const a = mark('perf-flip-start');
  const b = mark('perf-flip-end');
  if (!main || !a || !b) return { layouts: null, frames: null };
  const win = e => e.ts >= a.ts && e.ts <= b.ts;
  const layouts = ev.filter(e => win(e) && e.pid === main.pid && e.tid === main.tid && e.name === 'Layout' && (e.ph === 'X' || e.ph === 'B'));
  const frames = ev.filter(e => win(e) && (e.name === 'DrawFrame' || e.name === 'Graphics.Pipeline.DrawAndSwap' || e.name === 'Display::DrawAndSwap'));
  return { layouts: layouts.length, frames: frames.length };
}

async function measureFlip(browser) {
  const app = await startApp();
  const { context, page } = await newPage(browser, { throttle: true });
  const out = {};
  try {
    await boot(page, app.url);
    await settle(page);
    const one = async (key, act, waitMs) => {
      await sleep(400);
      await browser.startTracing(page, { categories: FLIP_CATS });
      await page.evaluate(() => console.timeStamp('perf-flip-start'));
      await page.evaluate(act);
      await sleep(waitMs);
      await page.evaluate(() => console.timeStamp('perf-flip-end'));
      const r = countInTrace(await browser.stopTracing());
      out['flip.' + key + '.layouts'] = r.layouts;
      out['flip.' + key + '.frames'] = r.frames;
    };
    await page.evaluate(() => document.getElementById('recentExpenses').scrollIntoView({ block: 'start' }));
    await one('expand', () => {
      const list = document.getElementById('recentExpenses');
      const row = list.children[0].cloneNode(true);
      list.insertBefore(row, list.firstChild);
      Motion.expandIn(row);
    }, 700);
    await one('collapse', () => { Motion.collapseOut(document.getElementById('recentExpenses').children[1]); }, 700);
    await page.evaluate(() => switchPage('search'));
    await settle(page, 1000);
    await one('toggleOpen', () => { Motion.toggleHidden(document.getElementById('srMorePanel'), true); }, 800);
    await one('toggleClose', () => { Motion.toggleHidden(document.getElementById('srMorePanel'), false); }, 800);
  } finally {
    await context.close();
    await app.close();
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * g. 長清單（P06）
 * ------------------------------------------------------------------------- */
const LIST_SUBMITS = 8;

/** 包住 renderRecent／renderRecentList（頂層函式宣告就是 window 的屬性），只算最外層那一次的同步執行時間。 */
function wrapListRenderers() {
  const P = window.__perf;
  P.listMs = 0;
  P.listCalls = 0;
  let depth = 0;
  ['renderRecent', 'renderRecentList'].forEach(name => {
    const orig = window[name];
    if (typeof orig !== 'function') return;
    window[name] = function () {
      const t0 = depth === 0 ? performance.now() : 0;
      depth++;
      try { return orig.apply(this, arguments); } finally {
        depth--;
        if (depth === 0) { P.listMs += performance.now() - t0; P.listCalls++; }
      }
    };
  });
}

async function measureLists(browser) {
  const out = {};
  // a) 30 筆完整清單，記一筆支出（同步中插入一次、伺服器回來再重繪一次）
  {
    const app = await startApp({ extraExpenses: 22 });
    const { context, page } = await newPage(browser, { throttle: true });
    try {
      await boot(page, app.url);
      await settle(page);
      await page.evaluate(() => toggleFullRecords('expense'));
      await settle(page, 1000);
      await page.evaluate(wrapListRenderers);
      const samples = [];
      for (let i = 0; i < LIST_SUBMITS; i++) {
        await page.locator('#expenseItemChoices .choice').nth(i % 3).tap();
        await sleep(400);
        await prepareSubmit(page);
        await page.locator('#expenseKeypad .key:text-is("1")').tap();
        await sleep(300);
        await page.evaluate(() => { window.__perf.listMs = 0; window.__perf.listCalls = 0; });
        await page.locator('#expenseSubmit').tap();
        await settle(page, 800);
        samples.push(await page.evaluate(() => ({ ms: window.__perf.listMs, calls: window.__perf.listCalls,
          rows: document.querySelectorAll('#recentExpenses .recent-item').length })));
      }
      out['longlist.submitRenderMs'] = median(samples.map(x => x.ms));
      out.submitSamples = samples;
    } finally {
      await context.close();
      await app.close();
    }
  }
  // b) 300 筆完整紀錄：載入的腳本時間與捲動幀率
  {
    const app = await startApp({ extraExpenses: 292 });
    const { context, page, cdp } = await newPage(browser, { throttle: true });
    try {
      await boot(page, app.url);
      await settle(page);
      await page.evaluate(wrapListRenderers);
      await page.evaluate(() => { window.__perf.listMs = 0; });
      await page.evaluate(() => toggleFullRecords('expense'));
      await settle(page, 1500);
      out['longlist.fullRenderMs'] = await page.evaluate(() => window.__perf.listMs);
      out.fullRows = await page.evaluate(() => document.querySelectorAll('#recentExpenses .recent-item').length);
      // 從完整紀錄的開頭往下捲 4000px 再捲回來
      await page.evaluate(() => {
        const list = document.getElementById('recentExpenses');
        window.scrollTo(0, list.getBoundingClientRect().top + window.scrollY - 120);
      });
      await sleep(800);
      const stopTrace = await startTrace(cdp);
      const sampler = page.evaluate(() => new Promise(resolve => {
        const list = [];
        window.__perfScrollStop = () => resolve(list);
        const tick = t => { list.push(t); if (window.__perfScrollStop) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
      }));
      const gesture = { x: VIEWPORT.width / 2, y: VIEWPORT.height * 0.6, speed: SCROLL_SPEED, gestureSourceType: 'touch', preventFling: true };
      await cdp.send('Input.synthesizeScrollGesture', Object.assign({ yDistance: -4000 }, gesture));
      await cdp.send('Input.synthesizeScrollGesture', Object.assign({ yDistance: 4000 }, gesture));
      await page.evaluate(() => { const f = window.__perfScrollStop; window.__perfScrollStop = null; f(); });
      const ts = await sampler;
      const trace = summarizeTrace(await stopTrace());
      const deltas = ts.slice(1).map((t, i) => t - ts[i]);
      const secs = (ts[ts.length - 1] - ts[0]) / 1000;
      out['longlist.scroll.fps'] = secs > 0 ? deltas.length / secs : null;
      out['longlist.scroll.slowFrames'] = deltas.filter(x => x > SLOW_FRAME_MS).length;
      out['longlist.scroll.p95FrameMs'] = percentile(deltas, 95);
      out['longlist.scroll.drawMs'] = trace['Display::DrawAndSwap'].us / 1000;
    } finally {
      await context.close();
      await app.close();
    }
  }
  return out;
}

/** 不降速：盤點動畫與 backdrop-filter，並在淺色、深色各截一張圖。 */
async function staticPass(browser) {
  const app = await startApp();
  const shotDir = path.join(SCREENS_DIR, OPT.label);
  if (OPT.screens) {
    fs.rmSync(shotDir, { recursive: true, force: true });
    fs.mkdirSync(shotDir, { recursive: true });
  }
  const inventory = {};
  const files = [];
  try {
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark' && !OPT.screens) break;
      const { context, page } = await newPage(browser, { theme });
      try {
        await boot(page, app.url);
        await settle(page);
        for (const p of PAGES) {
          await goTo(page, p.key);
          if (theme === 'light') inventory[p.key] = await page.evaluate(inventoryInPage);
          if (OPT.screens) {
            const file = path.join(shotDir, p.key + '-' + theme + '.png');
            await freezeAndShoot(page, file);
            files.push(path.relative(ROOT, file));
          }
        }
      } finally { await context.close(); }
    }
  } finally { await app.close(); }
  return { inventory, files, dir: OPT.screens ? path.relative(ROOT, shotDir) : null };
}

/* ---------------------------------------------------------------------------
 * 輸出
 * ------------------------------------------------------------------------- */
function displayWidth(s) {
  let n = 0;
  for (const ch of String(s)) n += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch) ? 2 : 1;
  return n;
}
const padR = (s, n) => String(s) + ' '.repeat(Math.max(0, n - displayWidth(s)));
const padL = (s, n) => ' '.repeat(Math.max(0, n - displayWidth(s))) + String(s);

function fmt(v, unit) {
  if (v == null) return '—';
  const d = unit === 'ms' && Math.abs(v) < 100 ? 1 : 0;
  return String(round(v, d));
}

function printTable(result, base) {
  const rows = [['項目', '數值', '單位', '離散', base ? '基準' : '', base ? '差值' : '', base ? '差%' : '', '']];
  for (const m of METRICS) {
    const v = result.metrics[m.key];
    const sp = result.spread[m.key];
    const spread = sp && v ? Math.round((sp[1] - sp[0]) / Math.abs(v) * 100) + '%' : '';
    const row = [m.label, fmt(v, m.unit), m.unit, spread, '', '', '', ''];
    if (base) {
      const b = base.metrics[m.key];
      row[4] = fmt(b, m.unit);
      if (typeof b === 'number' && typeof v === 'number') {
        const delta = v - b;
        row[5] = (delta > 0 ? '+' : '') + fmt(delta, m.unit);
        if (b !== 0) {
          const pct = delta / Math.abs(b) * 100;
          row[6] = (pct > 0 ? '+' : '') + round(pct, 1) + '%';
          if (Math.abs(pct) >= 10 && Math.abs(delta) >= (NOISE_FLOOR[m.unit] || 0)) row[7] = (pct > 0) === (m.better === 'up') ? '改善' : '變差';
        }
      }
    }
    rows.push(row);
  }
  const cols = rows[0].map((_, i) => Math.max(...rows.map(r => displayWidth(r[i]))));
  const line = r => r.map((c, i) => (i === 0 || i === 2 || i === 7 ? padR(c, cols[i]) : padL(c, cols[i]))).join('  ').trimEnd();
  console.log('\n' + line(rows[0]));
  console.log(cols.map(n => '─'.repeat(n)).join('  ').trimEnd());
  rows.slice(1).forEach(r => console.log(line(r)));
  console.log('（離散＝' + result.conditions.runs + ' 次之中最大減最小 ÷ 中位數；互動延遲是 Event Timing，8ms 為單位；' +
    '差異超過 10% 且超過雜訊門檻（17ms／5 次）才標改善或變差）');
}

function printInventory(inv) {
  for (const p of PAGES) {
    const x = inv[p.key];
    if (!x) continue;
    console.log('\n' + p.label + '：執行中動畫 ' + x.animations.length + ' 個、畫面內 backdrop-filter ' + x.backdropInView +
      ' 個（整頁有繪製的 ' + x.backdropRendered + ' 個）');
    const groups = new Map();
    x.animations.forEach(a => {
      const k = a.name + '｜' + a.props.join(',') + (a.iterations === 'infinite' ? '｜無限' : '');
      groups.set(k, (groups.get(k) || 0) + 1);
    });
    groups.forEach((n, k) => console.log('  ' + k + (n > 1 ? ' ×' + n : '')));
  }
}

/** --lists-only：只印長清單的數字（中位數），並存一份結果檔，可以用 --baseline 指定另一份 lists-only 結果比較。 */
function printListsOnly(listRuns) {
  const metrics = {};
  for (const m of METRICS.filter(x => x.key.startsWith('longlist.'))) {
    metrics[m.key] = round(median(listRuns.map(r => r[m.key]).filter(v => typeof v === 'number')), 2);
  }
  let base = null;
  if (OPT.baseline) {
    const f = resolveResultFile(OPT.baseline);
    if (!f) fail('找不到 --baseline 指定的結果檔：' + OPT.baseline);
    base = JSON.parse(fs.readFileSync(f, 'utf8'));
  }
  console.log('');
  for (const m of METRICS.filter(x => x.key.startsWith('longlist.'))) {
    const v = metrics[m.key];
    let line = padR(m.label, 52) + padL(fmt(v, m.unit), 8) + ' ' + m.unit;
    const b = base && base.metrics && base.metrics[m.key];
    if (typeof b === 'number' && typeof v === 'number') {
      line += '   基準 ' + fmt(b, m.unit) + (b !== 0 ? '（' + (v - b > 0 ? '+' : '') + round((v - b) / Math.abs(b) * 100, 1) + '%）' : '');
    }
    console.log(line);
  }
  const result = {
    label: OPT.label, createdAt: new Date().toISOString(), listsOnly: true,
    conditions: { cpu: OPT.cpu, net: OPT.net, runs: OPT.runs, rasterThreads: OPT.rasterThreads,
      dist: !OPT.dist ? 'dist' : (path.relative(ROOT, OPT.dist).startsWith('..') ? '(外部) ' + OPT.dist.split(path.sep).slice(-2).join('/') : path.relative(ROOT, OPT.dist)) },
    metrics, longLists: listRuns,
  };
  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, stamp(new Date()) + '-' + OPT.label + '.json');
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');
  console.log('\n結果：' + path.relative(ROOT, outFile));
}

/** P08 驗收：4 倍降速 boot-ready ≤ 0.8 秒、最長長任務 ≤ 100ms；開機後立刻互動 ≤ 200ms；
 *  6 倍＋Fast 3G 時 boot-ready 比基準（--baseline）快 35% 以上。 */
function printBootChecks(result, base) {
  const m = result.metrics;
  const rows = [];
  const check = (label, ok, text) => rows.push((ok == null ? '  ・ ' : ok ? '  ✓ ' : '  ✗ ') + padR(label, 34) + text);
  const ms = v => (typeof v === 'number' ? round(v) + 'ms' : '—');
  if (OPT.cpu === 4 && OPT.net === 'none') {
    check('boot-ready ≤ 800ms', m['boot.bootReady'] <= 800, ms(m['boot.bootReady']) + '（有快取 ' + ms(m['bootWarm.bootReady']) + '）');
    check('開機最長長任務 ≤ 100ms', Math.max(m['boot.longTaskMax'] || 0, m['bootWarm.longTaskMax'] || 0) <= 100,
      ms(m['boot.longTaskMax']) + '（有快取 ' + ms(m['bootWarm.longTaskMax']) + '）');
  }
  BOOT_ACTIONS.forEach(a => check(a.label + ' ≤ 200ms', typeof m['bootInput.' + a.key] === 'number' ? m['bootInput.' + a.key] <= 200 : null, ms(m['bootInput.' + a.key])));
  if (OPT.net === 'fast3g' && base && base.metrics && typeof base.metrics['boot.bootReady'] === 'number') {
    const b = base.metrics['boot.bootReady'];
    const gain = (b - m['boot.bootReady']) / b * 100;
    check('boot-ready 比基準快 ≥ 35%', gain >= 35, ms(b) + ' → ' + ms(m['boot.bootReady']) + '（快 ' + round(gain, 1) + '%）');
  }
  if (rows.length) console.log('\n開機驗收（P08）：\n' + rows.join('\n'));
}

function resolveResultFile(name) {
  const candidates = [name, path.join(RESULTS_DIR, name), path.join(RESULTS_DIR, name + '.json'), path.join(PERF_DIR, name)];
  const hit = candidates.find(f => fs.existsSync(f) && fs.statSync(f).isFile());
  if (hit) return hit;
  // 也可以只給標籤：取最新一份 results/*-<標籤>.json
  if (fs.existsSync(RESULTS_DIR)) {
    const byLabel = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('-' + name + '.json')).sort();
    if (byLabel.length) return path.join(RESULTS_DIR, byLabel[byLabel.length - 1]);
  }
  return null;
}

// 'high'：P03 以前的結果檔（強制高畫質）＝ 現在所有裝置的預設；'none'：P03 以前「交給自動分級」，條件不同
const prefsCondition = p => (p == null || p === 'high' ? 'default' : p);
const sameConditions = (a, b) => a.cpu === b.cpu && a.net === b.net && prefsCondition(a.prefs) === prefsCondition(b.prefs) && (a.rasterThreads || 1) === (b.rasterThreads || 1);

async function main() {
  const started = Date.now();
  // headless 用軟體繪圖：點陣化（RasterTask）在獨立執行緒上跑、不受 CPU 降速影響，Chromium 會依核心數開到 4 條。
  // 多條時幀率取決於作業系統把它們排到哪些核心（大小核、其他程式），連跑兩次可以差到一倍；固定 1 條才穩定，也比較接近手機。
  const browser = await chromium.launch({ args: ['--num-raster-threads=' + OPT.rasterThreads] });
  const version = browser.version();
  console.log('效能量測：Chromium ' + version + '｜手機 ' + VIEWPORT.width + '×' + VIEWPORT.height + ' @' + DPR + 'x｜CPU ' + OPT.cpu +
    ' 倍降速' + (OPT.net === 'fast3g' ? '＋Fast 3G' : '') + '｜點陣化執行緒 ' + OPT.rasterThreads + '｜重複 ' + OPT.runs + ' 次取中位數');

  let runs;
  let stat;
  let flip = {};
  const listRuns = [];
  try {
    console.log('暖機…');
    await warmup(browser);
    if (OPT.listsOnly) {
      for (let i = 1; i <= OPT.runs; i++) {
        listRuns.push(await measureLists(browser));
        console.log('  長清單第 ' + i + ' 次：記一筆 ' + round(listRuns[i - 1]['longlist.submitRenderMs'], 1) + 'ms、300 筆捲動 ' +
          round(listRuns[i - 1]['longlist.scroll.fps'], 1) + ' fps');
      }
      await browser.close();
      return printListsOnly(listRuns);
    }
    runs = [];
    for (let i = 1; i <= OPT.runs; i++) runs.push(await oneRun(browser, i));
    console.log(OPT.screens ? '動畫盤點與截圖（淺色、深色）…' : '動畫盤點…');
    stat = await staticPass(browser);
    console.log('一次性動畫的排版…');
    flip = await measureFlip(browser);
    console.log('長清單（30 筆記帳、300 筆捲動）…');
    for (let i = 0; i < OPT.runs; i++) listRuns.push(await measureLists(browser));
  } finally {
    if (browser.isConnected()) await browser.close();
  }

  const metrics = {};
  const spread = {};
  for (const m of METRICS) {
    if (m.key.startsWith('static.')) continue;
    if (m.key.startsWith('flip.')) { metrics[m.key] = flip[m.key] == null ? null : flip[m.key]; continue; }
    if (m.key.startsWith('longlist.')) {
      const ys = listRuns.map(r => r[m.key]).filter(v => typeof v === 'number');
      metrics[m.key] = round(median(ys), 2);
      if (ys.length > 1) spread[m.key] = [round(Math.min(...ys), 2), round(Math.max(...ys), 2)];
      continue;
    }
    const xs = runs.map(r => r.metrics[m.key]).filter(v => typeof v === 'number');
    metrics[m.key] = round(median(xs), 2);
    if (xs.length > 1) spread[m.key] = [round(Math.min(...xs), 2), round(Math.max(...xs), 2)];
  }
  for (const p of PAGES) {
    const inv = stat.inventory[p.key];
    metrics['static.' + p.key + '.runningAnimations'] = inv ? inv.animations.length : null;
    metrics['static.' + p.key + '.backdropInView'] = inv ? inv.backdropInView : null;
  }

  const result = {
    label: OPT.label,
    createdAt: new Date().toISOString(),
    conditions: {
      cpu: OPT.cpu, net: OPT.net, runs: OPT.runs, prefs: 'default', rasterThreads: OPT.rasterThreads,
      // 專案外的資料夾只記最後兩層，不把本機路徑寫進會進版控的 baseline.json
      dist: !OPT.dist ? 'dist' : (path.relative(ROOT, OPT.dist).startsWith('..') ? '(外部) ' + OPT.dist.split(path.sep).slice(-2).join('/') : path.relative(ROOT, OPT.dist)), viewport: VIEWPORT, deviceScaleFactor: DPR,
      fixedNow: new Date(FIXED_NOW).toISOString(), chromium: version, node: process.version, platform: os.platform() + ' ' + os.arch(),
    },
    metrics,
    spread,
    runs: runs.map(r => r.metrics),
    longLists: listRuns,
    inputEvents: runs.map(r => r.inputEvents),
    animations: stat.inventory,
    screenshots: { dir: stat.dir, files: stat.files },
  };

  // 比較對象
  let base = null;
  let baseFile = null;
  if (OPT.baseline) {
    baseFile = resolveResultFile(OPT.baseline);
    if (!baseFile) fail('找不到 --baseline 指定的結果檔：' + OPT.baseline);
  } else if (OPT.autoBaseline && !OPT.saveBaseline && fs.existsSync(BASELINE_FILE)) {
    baseFile = BASELINE_FILE;
  }
  if (baseFile) {
    base = JSON.parse(fs.readFileSync(baseFile, 'utf8'));
    if (!sameConditions(base.conditions, result.conditions)) {
      const msg = '量測條件不同（基準：CPU ' + base.conditions.cpu + ' 倍、網路 ' + base.conditions.net + '）';
      if (OPT.baseline) console.warn('⚠ ' + msg + '，差值僅供參考');
      else { console.log('（' + msg + '，不自動比較 baseline.json）'); base = null; baseFile = null; }
    }
  }
  if (base) result.baseline = path.relative(ROOT, baseFile);

  if (OPT.compare && OPT.screens) result.screenCompare = compareScreens(OPT.label, OPT.compare);

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const outFile = path.join(RESULTS_DIR, stamp(new Date()) + '-' + OPT.label + '.json');
  fs.writeFileSync(outFile, JSON.stringify(result, null, 2) + '\n');

  const isDefault = OPT.cpu === 4 && OPT.net === 'none' && OPT.rasterThreads === 1 && OPT.runs >= 3;
  let savedBaseline = false;
  if (OPT.saveBaseline || (!fs.existsSync(BASELINE_FILE) && isDefault)) {
    fs.writeFileSync(BASELINE_FILE, JSON.stringify(result, null, 2) + '\n');
    savedBaseline = true;
    if (OPT.screens && OPT.label !== 'baseline') {
      const dest = path.join(SCREENS_DIR, 'baseline');
      fs.rmSync(dest, { recursive: true, force: true });
      fs.cpSync(path.join(SCREENS_DIR, OPT.label), dest, { recursive: true, filter: src => !/diff-vs-/.test(src) });
    }
  }

  printTable(result, base);
  if (base) console.log('基準：' + path.relative(ROOT, baseFile) + '（' + base.label + '，' + base.createdAt + '）');
  printBootChecks(result, base);
  printInventory(stat.inventory);
  if (result.screenCompare) {
    console.log('\n截圖比對（與 screens/' + OPT.compare + '/，pixelmatch threshold 0.1）：');
    for (const [name, r] of Object.entries(result.screenCompare.files)) {
      console.log('  ' + padR(name, 24) + (r.missing ? '基準沒有這張' : r.percent + '%（' + r.diffPixels + ' 像素）' +
        (r.sizeChanged ? '  尺寸 ' + r.sizeChanged[0] + ' → ' + r.sizeChanged[1] : '')));
    }
    console.log('  差異圖：' + result.screenCompare.diffDir + '/');
  }
  console.log('\n結果：' + path.relative(ROOT, outFile));
  if (stat.dir) console.log('截圖：' + stat.dir + '/');
  if (savedBaseline) console.log('已寫入基準：' + path.relative(ROOT, BASELINE_FILE) + (OPT.screens ? '（截圖複製到 tools/perf/screens/baseline/）' : ''));
  console.log('耗時 ' + Math.round((Date.now() - started) / 1000) + ' 秒');
}

main().catch(e => { console.error(e); process.exit(1); });
