// 延後執行的頁面程式與內嵌圖示字型（P07）：
//   1. app.html 有兩段：開機執行的 <script> 與瀏覽器不解析的 <script type="text/plain" id="deferredApp">
//   2. 開機完成後在閒置時執行；切頁、第一次點擊、快取裡有進行中的旅行時會提早同步執行，行為和以前一樣
//   3. 圖示字型內嵌在頁面裡：封鎖 unpkg.com 之後圖示仍然正常顯示，而且根本不會連到 unpkg
// 在真的 Chromium 裡跑（本機預覽伺服器＋合成資料）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, DIST, browserTests } from './helpers.mjs';
import { createDevApp } from '../dev-server.mjs';

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

/** 頁面端：固定時鐘；holdIdle＝讓 requestIdleCallback／setTimeout 排程的延後執行不會自己發生（只能靠提早執行的路徑）。 */
function pageInit(cfg) {
  const RealDate = Date;
  const offset = cfg.now - RealDate.now();
  class FixedDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  window.Date = new Proxy(FixedDate, { apply: () => new FixedDate().toString() });
  if (cfg.holdIdle) {
    window.requestIdleCallback = function () { return 0; };
    // 不支援 requestIdleCallback 時的 setTimeout 後備、以及 load 之後的保險也一起擋下來
    window.addEventListener('bootready', e => e.stopImmediatePropagation(), true);
    window.addEventListener('load', e => e.stopImmediatePropagation(), true);
  }
  Object.entries(cfg.storage || {}).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} });
}

async function openApp(opts) {
  const browser = await web.browser();
  const o = opts || {};
  const app = createDevApp({ fixture: true, quiet: true, DateCtor: shiftedDate(FIXED_NOW) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  });
  const external = [];
  if (o.blockUnpkg) await context.route(/unpkg\.com/, route => { external.push(route.request().url()); return route.abort(); });
  await context.addInitScript(pageInit, { now: FIXED_NOW, holdIdle: Boolean(o.holdIdle), storage: o.storage });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', req => { if (/unpkg\.com/.test(req.url())) external.push(req.url()); });
  await page.goto('http://127.0.0.1:' + app.server.address().port + '/');
  await page.waitForFunction(() => document.documentElement.classList.contains('boot-ready'), null, { timeout: 60000 });
  return {
    page, errors, external,
    close: async () => { await context.close(); await new Promise(r => app.server.close(r)); },
  };
}

const read = name => fs.readFileSync(path.join(DIST, name), 'utf8');

test('app.html：開機程式與延後程式兩段都在，延後的那段是瀏覽器不解析的 text/plain', () => {
  const html = read('app.html');
  const boot = html.match(/^<script>\n([\s\S]*?)<\/script>\n/);
  const deferred = html.match(/<script type="text\/plain" id="deferredApp">\n([\s\S]*?)<\/script>\n$/);
  assert.ok(boot, '開機程式的 <script>');
  assert.ok(deferred, '延後程式的 <script type="text/plain" id="deferredApp">');
  assert.doesNotThrow(() => new vm.Script(boot[1], { filename: 'app-boot.js' }));
  assert.doesNotThrow(() => new vm.Script(deferred[1], { filename: 'app-deferred.js' }));
  // 開機程式：DeferredApp 與 router 在，頁面模組不在；延後程式：各頁面模組在
  assert.match(boot[1], /DeferredApp/);
  assert.match(boot[1], /function switchPage/);
  ['ForeignPage', 'SearchPage', 'OverviewCharts', 'MiniCharts', 'BudgetSettings'].forEach(name => {
    assert.doesNotMatch(boot[1], new RegExp('(const|var|let)\\s+' + name + '\\s*='), name + ' 不在開機程式裡');
    assert.match(deferred[1], new RegExp('(const|var|let)\\s+' + name + '\\s*='), name + ' 在延後程式裡');
  });
  ['loadOverview', 'loadSettlement', 'openCreditCardReconciliation', 'loadSettings'].forEach(name => {
    assert.match(deferred[1], new RegExp('function ' + name + '\\b'));
  });
  const bytes = s => Buffer.byteLength(s, 'utf8');
  assert.ok(bytes(boot[1]) <= 0.5 * (bytes(boot[1]) + bytes(deferred[1])), '開機前要解析的程式不超過全部的一半');
});

test('manifest：deferredScripts 只放首頁用不到的模組，開機必要的模組都在 scripts', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'client', 'manifest.json'), 'utf8'));
  assert.ok(Array.isArray(manifest.deferredScripts) && manifest.deferredScripts.length > 0);
  manifest.deferredScripts.forEach(f => assert.match(f, /^(pages|charts)\//, f + ' 不該延後'));
  manifest.scripts.forEach(f => assert.doesNotMatch(f, /^(pages|charts)\//, f + ' 應該延後'));
  ['core/deferred.js', 'app/bootstrap.js', 'app/router.js', 'bookkeeping/submit.js', 'budget/budget-view.js', 'app/reminder-prompt.js', 'core/reminders.js']
    .forEach(f => assert.ok(manifest.scripts.includes(f), f + ' 是開機必要的模組'));
});

test('延後程式：開機完成後在閒置時自動執行，執行後各頁面模組都在、沒有錯誤', { skip: NO_BROWSER }, async () => {
  const s = await openApp();
  try {
    await s.page.waitForFunction(() => DeferredApp.loaded(), null, { timeout: 5000 });
    const r = await s.page.evaluate(() => ({
      modules: [typeof ForeignPage, typeof SearchPage, typeof loadOverview, typeof BudgetSettings, typeof OverviewCharts],
      sourceGone: !document.getElementById('deferredApp'),
      appSwitchPage: typeof window.appSwitchPage,
    }));
    assert.deepEqual(r.modules, ['object', 'object', 'function', 'object', 'object']);
    assert.ok(r.sourceGone, '原始文字換成已執行的 <script>');
    assert.equal(r.appSwitchPage, 'function');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('延後程式：還沒執行時切頁，會先同步執行再切過去（總覽、設定、國外帳簿都正常）', { skip: NO_BROWSER }, async () => {
  const s = await openApp({ holdIdle: true });
  try {
    await s.page.waitForTimeout(800);
    assert.equal(await s.page.evaluate(() => DeferredApp.loaded()), false, '擋住閒置排程時還沒執行');
    await s.page.evaluate(() => switchPage('overview'));
    await s.page.waitForTimeout(600);
    const r = await s.page.evaluate(() => ({ loaded: DeferredApp.loaded(), page: document.body.dataset.page, active: document.querySelector('.page-container.active').id }));
    assert.deepEqual(r, { loaded: true, page: 'overview', active: 'pageOverview' });
    await s.page.evaluate(() => switchPage('settings'));
    await s.page.waitForTimeout(600);
    await s.page.evaluate(() => switchPage('foreign'));
    await s.page.waitForTimeout(600);
    assert.equal(await s.page.evaluate(() => document.querySelector('.page-container.active').id), 'pageForeign');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('延後程式：還沒執行時就點記帳頁的搜尋鈕，第一次點擊就會打開搜尋頁', { skip: NO_BROWSER }, async () => {
  const s = await openApp({ holdIdle: true });
  try {
    await s.page.waitForTimeout(800);
    assert.equal(await s.page.evaluate(() => DeferredApp.loaded()), false);
    await s.page.locator('#searchOpenBtn').tap();
    await s.page.waitForFunction(() => document.body.dataset.page === 'search', null, { timeout: 5000 });
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('延後程式：快取裡有進行中的旅行帳簿時，一開機就顯示旅行提示（不用等閒置）', { skip: NO_BROWSER }, async () => {
  const ledger = { id: 'trip1', name: '東京', country: '日本', currency: 'JPY', startDate: '2026-11-10', endDate: '2026-11-18', archived: false };
  const s = await openApp({
    holdIdle: true,
    storage: { FAST_BOOKKEEPING_FX_LIST_V1: JSON.stringify({ ledgers: [ledger], savedAt: FIXED_NOW }) },
  });
  try {
    const r = await s.page.evaluate(() => ({ loaded: DeferredApp.loaded(), hidden: document.getElementById('fxTripHint').hidden, text: document.getElementById('fxTripHintText').textContent }));
    assert.equal(r.loaded, true, '有旅行提示時開機就執行');
    assert.equal(r.hidden, false);
    assert.match(r.text, /東京旅行中，第 4 天/);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('圖示字型內嵌在頁面裡：封鎖 unpkg.com 之後圖示照常顯示，也不會連到 unpkg', { skip: NO_BROWSER }, async () => {
  const s = await openApp({ blockUnpkg: true });
  try {
    await s.page.waitForTimeout(500);
    const r = await s.page.evaluate(async () => {
      await document.fonts.ready;
      const faces = Array.from(document.fonts).filter(f => /^Phosphor(-Fill)?$/.test(f.family.replace(/"/g, '')));
      // 選取中的選項、導覽列目前頁面的圖示改用 fill 字型（CSS 的 --font-icon-fill），也要是內嵌的
      const active = document.querySelector('.nav-item.active i.ph');
      const activeFont = active ? getComputedStyle(active).fontFamily.replace(/"/g, '') : '';
      const activeGlyph = active ? JSON.parse(getComputedStyle(active, '::before').content) : '';
      const icons = Array.from(document.querySelectorAll('#pageBookkeeping i.ph, #bottomNav i.ph')).filter(i => i.getBoundingClientRect().width > 0);
      // 子集字型裡有字形 → 圖示的寬度是 1em 左右；字型沒載入時（font-display: block）會是看不見的後備字
      const glyph = icons[0] && getComputedStyle(icons[0], '::before').content;
      return {
        faces: faces.map(f => f.status),
        visibleIcons: icons.length,
        check: document.fonts.check('16px Phosphor', glyph ? JSON.parse(glyph) : ''),
        activeFont,
        fillCheck: document.fonts.check('16px "Phosphor-Fill"', activeGlyph),
        families: Array.from(new Set(faces.map(f => f.family.replace(/"/g, '')))).sort(),
        src: faces.length ? /data:font\/woff2/.test(Array.from(document.styleSheets).map(sh => { try { return Array.from(sh.cssRules).map(x => x.cssText).join(''); } catch (e) { return ''; } }).join('')) : false,
      };
    });
    assert.ok(r.faces.length >= 1 && r.faces.every(x => x === 'loaded'), '內嵌的 Phosphor 字型已載入：' + r.faces.join(','));
    assert.ok(r.visibleIcons > 5, '記帳頁與導覽列有圖示');
    assert.ok(r.check, '畫面上的圖示字元由已載入的字型提供');
    assert.deepEqual(r.families, ['Phosphor', 'Phosphor-Fill'], '兩種粗細都內嵌');
    assert.equal(r.activeFont, 'Phosphor-Fill', '導覽列目前頁面的圖示用 fill 字型');
    assert.ok(r.fillCheck, 'fill 字型也已載入');
    assert.ok(r.src, '字型是 data URI');
    assert.deepEqual(s.external, [], '沒有任何連到 unpkg 的請求');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('圖示：子集以外的圖示仍會補載完整樣式表（匯入 icons 層），而且插在子集前面（子集內的圖示不受影響）', { skip: NO_BROWSER }, async () => {
  const s = await openApp({ blockUnpkg: true });
  try {
    const r = await s.page.evaluate(() => {
      const count = () => document.querySelectorAll('style[data-icon-fallback]').length;
      const before = count();
      iconHtml('tag');                       // 子集內：不補載
      const mid = count();
      iconHtml('acorn');                     // 子集外：補載
      iconHtml('tag', 'fill');               // fill 沒有內嵌：也要補載（同一次）
      const el = document.querySelector('style[data-icon-fallback]');
      const subset = document.getElementById('phosphorSubset');
      const imports = Array.from(el.sheet.cssRules).map(r => r.href + ' ' + (r.layerName || ''));
      return { before, mid, after: count(), beforeSubset: Boolean(el.compareDocumentPosition(subset) & Node.DOCUMENT_POSITION_FOLLOWING), imports };
    });
    assert.deepEqual(r.imports, ['https://unpkg.com/@phosphor-icons/web@2.1.1/src/regular/style.css icons', 'https://unpkg.com/@phosphor-icons/web@2.1.1/src/fill/style.css icons'], '完整樣式表匯入到 icons 層');
    assert.deepEqual({ before: r.before, mid: r.mid, after: r.after, beforeSubset: r.beforeSubset }, { before: 0, mid: 0, after: 1, beforeSubset: true });
  } finally { await s.close(); }
});
