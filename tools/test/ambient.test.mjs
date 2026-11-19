// 常駐動畫管理（P04）：移除效能分級之後，只剩「背景分頁暫停」與「離屏暫停」兩條規則（core/ambient.js）。
//   1. 全站不再有分級相關的程式（data-perf、Perf、效能模式卡片…）。
//   2. 用假的瀏覽器環境執行 ambient.js：離屏／背景時暫停、回來時繼續；捲動不會讓動畫停住。
//   3. prefs.js 開機時清掉舊版留下的分級紀錄與 perf 欄位。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.mjs';

const CLIENT = path.join(ROOT, 'src', 'client');
const read = rel => fs.readFileSync(path.join(CLIENT, rel), 'utf8');
const LEGACY_PERF_KEY = ['FAST_BOOKKEEPING', 'PERF', 'V1'].join('_');

function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (/\.(js|css|html|json)$/.test(e.name)) out.push(full);
  }
  return out;
}

test('Ambient：全站沒有效能分級的殘留', () => {
  const hits = [];
  const banned = [/data-perf/, /\bPerf\./, /\bPerf\b\s*=/, /PREF_PERF_OPTIONS/, /perfchange/, /prefPerfTitle/, /效能模式/];
  for (const f of walk(CLIENT)) {
    const text = fs.readFileSync(f, 'utf8');
    for (const re of banned) if (re.test(text)) hits.push(path.relative(CLIENT, f) + ' ' + re);
  }
  assert.deepEqual(hits, []);
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(!manifest.scripts.includes('core/perf.js'));
  const i = manifest.scripts.indexOf('core/ambient.js');
  assert.ok(i !== -1 && i < manifest.scripts.indexOf('core/motion.js'), 'ambient.js 要在 motion.js 之前載入');
  assert.ok(!fs.existsSync(path.join(CLIENT, 'scripts', 'core', 'perf.js')));
  assert.doesNotMatch(read('scripts/core/ambient.js'), /steps\(|updateTiming|'scroll'|deviceMemory/, '不可以降幀、捲動暫停或依裝置判斷');
  assert.match(read('scripts/core/motion.js'), /classList\.toggle\('lg-can-refract', ok\)/, 'SVG 折射直接依支援度切換');
});

/* ---------- 假的瀏覽器環境 ---------- */
function fakeEnv() {
  const docListeners = {};
  const winListeners = {};
  const observers = [];
  const anims = [];
  const el = (name) => ({ nodeType: 1, isConnected: true, name });
  const makeAnim = (target, animationName) => {
    const a = {
      animationName, playState: 'running', effect: { target }, _l: {},
      pause() { this.playState = 'paused'; },
      play() { this.playState = 'running'; },
      cancel() { this.playState = 'idle'; (this._l.cancel || []).forEach(f => f()); },
      addEventListener(t, f) { (this._l[t] = this._l[t] || []).push(f); },
    };
    anims.push(a);
    return a;
  };
  const document = {
    hidden: false,
    body: {},
    addEventListener: (t, f) => { (docListeners[t] = docListeners[t] || []).push(f); },
    getAnimations: () => anims.filter(a => a.playState !== 'idle'),
  };
  class IntersectionObserver {
    constructor(cb, opts) { this.cb = cb; this.opts = opts; this.els = new Set(); observers.push(this); }
    observe(e) { this.els.add(e); }
    unobserve(e) { this.els.delete(e); }
  }
  const context = vm.createContext({
    document, IntersectionObserver,
    window: { addEventListener: (t, f) => { (winListeners[t] = winListeners[t] || []).push(f); } },
    requestAnimationFrame: f => { f(0); return 1; },
  });
  const fire = (t, e = {}) => (docListeners[t] || []).forEach(f => f(e));
  const intersect = (target, isIntersecting) => observers[0].cb([{ target, isIntersecting }]);
  return { context, document, observers, docListeners, winListeners, el, makeAnim, fire, intersect };
}

test('Ambient：離屏與背景分頁時暫停，回來繼續；捲動不暫停', () => {
  const env = fakeEnv();
  const card = env.el('card');
  const cssAnim = env.makeAnim(card, 'uv-card-spin');   // 開機前就在跑的 CSS 常駐動畫
  const other = env.makeAnim(card, 'spin-loading');     // 不是常駐動畫，不管
  vm.runInContext(read('scripts/core/ambient.js') + '\nthis.Ambient = Ambient;', env.context);
  const Ambient = env.context.Ambient;

  assert.equal(env.observers.length, 1);
  assert.equal(env.observers[0].opts.rootMargin, '120px 0px');
  assert.ok(env.observers[0].els.has(card));
  assert.equal(Ambient.debug().tracked, 1);
  assert.equal(env.docListeners.scroll, undefined);
  assert.equal(env.winListeners.scroll, undefined, '沒有捲動暫停');

  // 離屏 → 暫停；回到預留範圍 → 繼續
  env.intersect(card, false);
  assert.equal(cssAnim.playState, 'paused');
  assert.equal(other.playState, 'running');
  env.intersect(card, true);
  assert.equal(cssAnim.playState, 'running');

  // 用 JS 建立的常駐動畫：register 之後套用同樣規則
  const btn = env.el('btn');
  const jsAnim = Ambient.register(env.makeAnim(btn, ''));
  assert.ok(env.observers[0].els.has(btn));
  env.document.hidden = true;
  env.fire('visibilitychange');
  assert.equal(cssAnim.playState, 'paused');
  assert.equal(jsAnim.playState, 'paused');
  env.document.hidden = false;
  env.fire('visibilitychange');
  assert.equal(cssAnim.playState, 'running');
  assert.equal(jsAnim.playState, 'running');

  // 別的程式主動 pause() 的動畫，回到前景時不會被擅自播放
  jsAnim.pause();
  env.document.hidden = true; env.fire('visibilitychange');
  env.document.hidden = false; env.fire('visibilitychange');
  assert.equal(jsAnim.playState, 'paused');

  // 新出現的 ambient- 動畫自動接手；cancel 之後放掉、停止觀察
  const star = env.el('star');
  const later = env.makeAnim(star, 'ambient-sparkle');
  star.getAnimations = () => [later];
  env.fire('animationstart', { animationName: 'ambient-sparkle', target: star });
  assert.ok(env.observers[0].els.has(star));
  later.cancel();
  assert.ok(!env.observers[0].els.has(star));
});

test('Prefs：開機時清掉舊的分級紀錄與 perf 欄位', () => {
  const store = new Map([
    [LEGACY_PERF_KEY, '{"tier":"low"}'],
    ['FAST_BOOKKEEPING_PREFS_V1', '{"motion":"lite","autoScroll":false,"perf":"mid"}'],
  ]);
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  const context = vm.createContext({ localStorage });
  vm.runInContext(read('scripts/core/prefs.js') + '\nthis.Prefs = Prefs;', context);
  assert.ok(!store.has(LEGACY_PERF_KEY));
  assert.deepEqual(JSON.parse(store.get('FAST_BOOKKEEPING_PREFS_V1')), { motion: 'lite', autoScroll: false });
  assert.deepEqual({ ...context.Prefs.get() }, { motion: 'lite', autoScroll: false });
});
