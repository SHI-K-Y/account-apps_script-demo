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
//          --full-page（截整頁而不是手機畫面大小；固定元素位置會失真，只在要檢查下半頁時用）、
//          --prefs none（不預設偏好設定，改用 App 自己的判斷；P04 之後用）。
//
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
  prefs: args.prefs === 'none' ? 'none' : 'high',
  screens: !args['skip-screens'],
  fullPage: Boolean(args['full-page']),
  compare: typeof args.compare === 'string' ? args.compare : '',
  baseline: typeof args.baseline === 'string' ? args.baseline : '',
  autoBaseline: !args['no-baseline'],
  saveBaseline: Boolean(args['save-baseline']),
};
if (args.net && args.net !== 'fast3g') fail('--net 只支援 fast3g');

const VIEWPORT = { width: 390, height: 844 };
const DPR = 2;
const FIXED_NOW = Date.UTC(2026, 10, 13, 4, 0, 0);          // 2026-11-13 12:00 台北（與 tools/test 相同）
const IDLE_MS = 5000;
const ACTION_GAP_MS = 1500;
const INPUT_ROUNDS = 2;
const SETTLE_MS = 2000;
const SLOW_FRAME_MS = 50.5;
// 判定「改善／變差」：差異要超過 10%，而且絕對值超過這個雜訊門檻（一幀 16ms、或 5 次／幀）
const NOISE_FLOOR = { ms: 16, '幀': 5, '次': 5, '個': 1 };
const FAST3G = { offline: false, latency: 150, downloadThroughput: 1.6e6 / 8, uploadThroughput: 750e3 / 8 };
// P04（移除裝置分級）完成以前，先把偏好設成「高畫質」量測現況；否則 headless 會被自動判成 low。
const PREFS = { motion: 'full', autoScroll: true, perf: 'high' };

const PAGES = [
  { key: 'bookkeeping', label: '記帳頁', nav: '#navBookkeeping' },
  { key: 'overview', label: '總覽頁', nav: '#navOverview' },
  { key: 'settings', label: '設定頁', nav: '#navSettings' },
];
const ACTIONS = [
  { key: 'selectItem', label: '點支出項目', sel: '#expenseItemChoices .choice' },
  { key: 'keypadDigit', label: '按數字鍵', sel: '#expenseKeypad .key:text-is("1")', prepare: prepareSubmit },
  { key: 'submit', label: '按送出', sel: '#expenseSubmit' },
  { key: 'toOverview', label: '切到總覽', sel: '#navOverview' },
  { key: 'toSettings', label: '切到設定', sel: '#navSettings' },
  { key: 'toBookkeeping', label: '回到記帳', sel: '#navBookkeeping' },
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
});
ACTIONS.forEach(a => metric('input.' + a.key, '互動延遲：' + a.label, 'ms', 'down'));
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

  // 2. 偏好設定
  if (cfg.prefs) {
    try { localStorage.setItem('FAST_BOOKKEEPING_PREFS_V1', JSON.stringify(cfg.prefs)); } catch (e) {}
  }

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

  // 5. 追蹤進行中的 google.script.run（本機替身走 fetch('/__rpc')），用來判斷資料載完了沒
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

async function startApp() {
  const app = createDevApp({ fixture: true, quiet: true, DateCtor: shiftedDate(FIXED_NOW) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + app.server.address().port + '/', close: () => new Promise(r => app.server.close(r)) };
}

async function newPage(browser, opts) {
  const o = opts || {};
  const context = await browser.newContext({
    viewport: VIEWPORT, deviceScaleFactor: DPR, isMobile: true, hasTouch: true,
    locale: 'zh-TW', timezoneId: 'Asia/Taipei', colorScheme: o.theme || 'light',
  });
  await context.addInitScript(pageInstrument, { fixedNow: FIXED_NOW, prefs: OPT.prefs === 'high' ? PREFS : null });
  const page = await context.newPage();
  page.on('pageerror', e => console.warn('  [頁面錯誤] ' + e.message));
  const cdp = await context.newCDPSession(page);
  if (o.throttle) {
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: OPT.cpu });
    if (OPT.net === 'fast3g') {
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', FAST3G);
    }
  }
  await cdp.send('Performance.enable');
  return { context, page, cdp };
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

/* ---------------------------------------------------------------------------
 * b. 閒置
 * ------------------------------------------------------------------------- */
async function getMetrics(cdp) {
  const { metrics } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(metrics.map(m => [m.name, m.value]));
}

// RasterTask 屬於 disabled-by-default-devtools.timeline（DevTools 效能面板也會一起開），只開 devtools.timeline 會量到 0。
const TRACE_CATEGORIES = ['devtools.timeline', 'disabled-by-default-devtools.timeline'];

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
  const out = { Paint: { count: 0, us: 0 }, RasterTask: { count: 0, us: 0 } };
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
  const out = {};
  const detail = {};
  for (const w of windows) {
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
  await page.evaluate(() => document.getAnimations().forEach(a => { a.pause(); a.currentTime = 0; }));
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  // 預設只截手機畫面大小（390×844）：整頁截圖會把視窗撐成整頁高，100vh 背景會被拉長、固定的底部導覽列會跑到圖中間。
  await page.screenshot({ path: file, fullPage: OPT.fullPage, animations: 'allow', caret: 'hide' });
  // 恢復播放，下一頁的動畫才是正常狀態
  await page.evaluate(() => document.getAnimations().forEach(a => { if (a.playState === 'paused') a.play(); }));
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
async function oneRun(browser, index) {
  const app = await startApp();   // 每次重新載入合成資料，前一次送出的紀錄不會影響這一次
  const { context, page, cdp } = await newPage(browser, { throttle: true });
  try {
    await boot(page, app.url);
    const flat = {};
    const bootStats = await measureBoot(page);
    for (const k of Object.keys(bootStats)) flat['boot.' + k] = bootStats[k];

    await settle(page, 0);
    // 互動延遲以 8ms 為單位、單次波動大：同一輪開機裡把整串動作做 INPUT_ROUNDS 遍，取中位數。
    const rounds = [];
    for (let r = 0; r < INPUT_ROUNDS; r++) {
      if (r) await settle(page);
      rounds.push(await measureInputs(page));
    }
    const inputs = { values: {}, samples: {}, detail: rounds.map(x => x.detail) };
    for (const a of ACTIONS) {
      inputs.samples[a.key] = rounds.map(x => x.values[a.key]);
      inputs.values[a.key] = median(inputs.samples[a.key]);
      flat['input.' + a.key] = inputs.values[a.key];
    }

    const idle = {};
    for (const p of PAGES) {
      await goTo(page, p.key);
      idle[p.key] = await measureIdle(page, cdp);
    }
    await goTo(page, 'bookkeeping');
    await page.evaluate(() => document.getAnimations().forEach(a => a.pause()));
    idle.bookkeepingPaused = await measureIdle(page, cdp);
    for (const v of Object.keys(idle)) for (const k of Object.keys(idle[v])) flat['idle.' + v + '.' + k] = idle[v][k];

    console.log('  第 ' + index + ' 次：boot-ready ' + round(bootStats.bootReady) + 'ms、記帳頁閒置 ' + idle.bookkeeping.frames +
      ' 幀、送出 ' + round(inputs.values.submit) + 'ms');
    return { metrics: flat, inputEvents: { samples: inputs.samples, topEvent: inputs.detail } };
  } finally {
    await context.close();
    await app.close();
  }
}

async function warmup(browser) {
  const app = await startApp();
  const { context, page } = await newPage(browser, { throttle: true });
  try { await boot(page, app.url); await settle(page, 500); } finally { await context.close(); await app.close(); }
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
    '差異超過 10% 且超過雜訊門檻（16ms／5 次）才標改善或變差）');
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

const sameConditions = (a, b) => a.cpu === b.cpu && a.net === b.net && a.prefs === b.prefs;

async function main() {
  const started = Date.now();
  const browser = await chromium.launch();
  const version = browser.version();
  console.log('效能量測：Chromium ' + version + '｜手機 ' + VIEWPORT.width + '×' + VIEWPORT.height + ' @' + DPR + 'x｜CPU ' + OPT.cpu +
    ' 倍降速' + (OPT.net === 'fast3g' ? '＋Fast 3G' : '') + '｜重複 ' + OPT.runs + ' 次取中位數｜偏好設定：' +
    (OPT.prefs === 'high' ? '高畫質（量測用預設）' : '不預設'));

  let runs;
  let stat;
  try {
    console.log('暖機…');
    await warmup(browser);
    runs = [];
    for (let i = 1; i <= OPT.runs; i++) runs.push(await oneRun(browser, i));
    console.log(OPT.screens ? '動畫盤點與截圖（淺色、深色）…' : '動畫盤點…');
    stat = await staticPass(browser);
  } finally {
    await browser.close();
  }

  const metrics = {};
  const spread = {};
  for (const m of METRICS) {
    if (m.key.startsWith('static.')) continue;
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
      cpu: OPT.cpu, net: OPT.net, runs: OPT.runs, prefs: OPT.prefs, viewport: VIEWPORT, deviceScaleFactor: DPR,
      fixedNow: new Date(FIXED_NOW).toISOString(), chromium: version, node: process.version, platform: os.platform() + ' ' + os.arch(),
    },
    metrics,
    spread,
    runs: runs.map(r => r.metrics),
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

  const isDefault = OPT.cpu === 4 && OPT.net === 'none' && OPT.prefs === 'high' && OPT.runs >= 3;
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
