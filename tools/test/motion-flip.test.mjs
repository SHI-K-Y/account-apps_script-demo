// 一次性動畫與互動回饋（P05）：
//   1. expandIn／collapseOut／toggleHidden 不再動 height、padding、border（FLIP：只動 transform／translate／opacity）。
//   2. burst 的顏色有快取，不是每次送出都讀 getComputedStyle(documentElement)。
//   3. 數字格式統一走 core/fmt.js 的 Fmt（快取 Intl.NumberFormat），輸出和原本的 toLocaleString('zh-TW') 完全相同。
//   4. 頁面切換：View Transition 的 update callback 只做輕量渲染，圖表與長清單交給 PageWork 在 transition.ready 之後一幀做一件。
//   5. 互動熱路徑不再用 void el.offsetWidth 強制排版（這個頁面有 size container，連 getComputedStyle 都會排版）。
// 真實瀏覽器裡的排版次數由 npm run perf 的「動畫期間 Layout」量測。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.mjs';

const CLIENT = path.join(ROOT, 'src', 'client');
const read = rel => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

/** 取出 `function name(...) { ... }` 的完整原始碼（大括號配對）。 */
function fnSource(src, name) {
  const start = src.indexOf('function ' + name + '(');
  assert.ok(start !== -1, '找不到 function ' + name);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('大括號不成對：' + name);
}

const LAYOUT_PROPS = /\b(height|width|paddingTop|paddingBottom|marginTop|marginBottom|borderTopWidth|borderBottomWidth|top|left)\s*:/;

test('FLIP：expandIn、collapseOut、toggleHidden 的 keyframes 不含會觸發排版的屬性', () => {
  const src = read('scripts/core/motion.js');
  for (const name of ['expandIn', 'collapseOut', 'toggleHidden', 'shiftNodes']) {
    const body = fnSource(src, name);
    assert.doesNotMatch(body, LAYOUT_PROPS, name + ' 不可以動高度／寬度／padding／border／位置');
  }
  // 時長、曲線、延遲沿用原本的數值
  assert.match(fnSource(src, 'expandIn'), /duration: dur\('slow'\), easing: ease\('out'\)/);
  const collapse = fnSource(src, 'collapseOut');
  assert.match(collapse, /translateX\(-56px\)/);
  assert.match(collapse, /duration: dur\('base'\), easing: ease\('in-out'\)/);
  assert.match(collapse, /duration: dur\('base'\), delay: dur\('fast'\), easing: ease\('out'\)/);
  assert.match(fnSource(src, 'toggleHidden'), /spring\('tap'\)/);
});

test('burst：顏色有快取，主題切換時才重新讀', () => {
  const src = read('scripts/core/motion.js');
  assert.doesNotMatch(fnSource(src, 'burstNow'), /getComputedStyle/);
  assert.match(fnSource(src, 'bindColorCacheReset'), /data-theme/);
  assert.match(fnSource(src, 'bindColorCacheReset'), /prefers-color-scheme/);
});

function loadFmt() {
  const ctx = vm.createContext({ Intl, Number, Math, Map, Object, String });
  vm.runInContext(read('scripts/core/fmt.js') + '\n;globalThis.Fmt = Fmt;', ctx);
  return ctx.Fmt;
}

test('Fmt：輸出和原本的 toLocaleString／Intl.NumberFormat 完全相同，而且格式器會重複使用', () => {
  const Fmt = loadFmt();
  const values = [0, 1, 12, 999, 1000, 12345, 1234567.891, 0.5, 2.345, -80, -1234.5, NaN];
  for (const v of values) {
    assert.equal(Fmt.num(v), v.toLocaleString('zh-TW'), 'num ' + v);
    assert.equal(Fmt.num(Math.abs(v), { maximumFractionDigits: 2 }), Math.abs(v).toLocaleString('zh-TW', { maximumFractionDigits: 2 }));
    assert.equal(Fmt.num(v, { maximumSignificantDigits: 4 }), new Intl.NumberFormat('zh-TW', { maximumSignificantDigits: 4 }).format(v));
  }
  assert.equal(Fmt.money(1234), '$1,234');
  assert.equal(Fmt.money(-80), '-$80');
  assert.equal(Fmt.money(5, { plus: true }), '+$5');
  assert.equal(Fmt.money(1.234, { digits: 2 }), '$1.23');
  assert.equal(Fmt.nf(), Fmt.nf(), '預設格式器只建立一次');
  assert.equal(Fmt.nf({ minimumFractionDigits: 0, maximumFractionDigits: 2 }), Fmt.nf({ maximumFractionDigits: 2, minimumFractionDigits: 0 }), '選項順序不同也共用');
});

test('Fmt：前端其他地方不再自己呼叫 toLocaleString 或 new Intl.NumberFormat', () => {
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.scripts.indexOf('core/fmt.js') !== -1 && manifest.scripts.indexOf('core/fmt.js') < manifest.scripts.indexOf('bookkeeping/amount.js'));
  const hits = [];
  for (const rel of manifest.scripts) {
    if (rel === 'core/fmt.js') continue;
    const text = read('scripts/' + rel);
    if (/\.toLocaleString\(|new Intl\.NumberFormat\(/.test(text)) hits.push(rel);
  }
  assert.deepEqual(hits, []);
});

function loadPageWork() {
  const src = read('scripts/app/router.js');
  const start = src.indexOf('var PageWork = (function() {');
  const end = src.indexOf('})();', start) + 5;
  assert.ok(start !== -1 && end > start, '找不到 PageWork');
  const frames = [];
  const ctx = vm.createContext({ console, requestAnimationFrame: fn => { frames.push(fn); return frames.length; } });
  vm.runInContext(src.slice(start, end) + '\n;globalThis.PageWork = PageWork;', ctx);
  const tick = () => { const list = frames.splice(0); list.forEach(fn => fn()); };
  return { PageWork: ctx.PageWork, tick, frames };
}

test('PageWork：轉場進行中先排隊，ready 之後一幀做一件；沒有轉場時立刻執行', () => {
  const { PageWork, tick, frames } = loadPageWork();
  const log = [];
  PageWork.defer(() => log.push('now'));
  assert.deepEqual(log, ['now'], '沒有轉場時立刻執行');

  const release = PageWork.hold();
  PageWork.defer(() => log.push('a'));
  PageWork.defer(() => log.push('b'));
  tick();
  assert.deepEqual(log, ['now'], 'ready 之前不執行');
  assert.equal(frames.length, 0);
  release();
  tick();
  assert.deepEqual(log, ['now', 'a'], '一幀只做一件');
  tick();
  assert.deepEqual(log, ['now', 'a', 'b']);
  assert.equal(PageWork.pending(), 0);

  // 連續切換：舊的 release 不會提早放行新的轉場
  const r1 = PageWork.hold();
  const r2 = PageWork.hold();
  PageWork.defer(() => log.push('c'));
  r1();
  tick();
  assert.deepEqual(log, ['now', 'a', 'b'], '被取代的轉場放行無效');
  r2();
  tick();
  assert.deepEqual(log, ['now', 'a', 'b', 'c']);
});

test('頁面切換：update callback 先寫後讀，圖表延到轉場開始後、設定清單預先畫好', () => {
  const router = read('scripts/app/router.js');
  const apply = fnSource(router, 'applyPageSwitch');
  assert.match(apply, /loadOverview\(false, \{ defer: PageWork\.defer \}\)/);
  assert.match(apply, /loadSettings\(false, \{ defer: PageWork\.defer \}\)/);
  // 讀排版的兩件事放在最後
  const lastWrite = Math.max(apply.indexOf('loadSettings('), apply.indexOf('SearchPage.onLeave'));
  assert.ok(apply.indexOf('updateNavPill()') > lastWrite, 'updateNavPill 要在所有寫入之後');
  assert.ok(apply.indexOf('window.scrollTo') > lastWrite, 'scrollTo 要在所有寫入之後');
  assert.match(fnSource(router, 'switchPage'), /transition\.ready\.then\(release/);

  const overview = fnSource(read('scripts/pages/overview.js'), 'loadOverview');
  assert.match(overview, /if \(defer\) defer\(fn\)/, '圖表的渲染延到轉場開始後');
  assert.match(overview, /runLater\(function\(\) \{ OverviewCharts\.loadForOverview\(month, forceRefresh, \{ result: chartsResult \}\)/,
    '延後的圖表用同一個 batchRead 的結果，不另外送請求（P12）');
  // 設定清單：開機閒置時預先畫好（P12：有資料就不放骨架），切頁時只確認還能用
  const settings = fnSource(read('scripts/pages/settings/core.js'), 'loadSettings');
  assert.match(settings, /if \(!settingsPrerendered\(\)\) renderSettingsList\(\)/);
  assert.match(read('scripts/app/bootstrap.js'), /prerenderSettings\(\)/);
});

test('互動熱路徑：不用 void el.offsetWidth／getAnimations() 強制排版', () => {
  const feedback = fnSource(read('scripts/core/feedback.js'), 'showToast');
  assert.doesNotMatch(feedback, /offsetWidth|getBoundingClientRect/);
  assert.match(feedback, /requestAnimationFrame/);
  const recent = read('scripts/bookkeeping/recent.js');
  assert.doesNotMatch(fnSource(recent, 'flashSyncedRecentRow'), /offsetWidth|flushStyle/);
  const motion = read('scripts/core/motion.js');
  assert.match(fnSource(motion, 'expandIn'), /beforePaint\(/, 'expandIn 在繪製前的 rAF 量測');
  assert.match(fnSource(motion, 'collapseOut'), /beforePaint\(/, 'collapseOut 在繪製前的 rAF 量測');
  assert.match(fnSource(motion, 'burst'), /requestAnimationFrame/, 'burst 在繪製前的 rAF 量測');
  const css = read('styles/16-motion-prefs.css');
  for (const name of ['syncFlashAlt', 'toastProgressAlt', 'toastProgressLiteAlt']) assert.match(css, new RegExp('@keyframes ' + name + '\\b'));
});

test('countUp：數字容器等寬、跑動時鎖寬度，並加上 contain: layout paint', () => {
  const motion = read('scripts/core/motion.js');
  assert.match(fnSource(motion, 'countUp'), /lockCountWidth\(el/);
  assert.match(fnSource(motion, 'countUp'), /unlockCountWidth\(el\)/);
  const css = read('styles/16-motion-prefs.css');
  assert.match(css, /\.today-expense-amount-wrap,\s*\.ov-hero-amount,\s*\.ov-mini-val,\s*\.fx-summary-val\s*\{\s*contain: layout paint;/);
  // 今日金額和「NT$」用 baseline 對齊：layout containment 不能加在金額本身（會失去 baseline）
  assert.doesNotMatch(css, /\.today-expense-amount\s*\{[^}]*contain:/);
});
