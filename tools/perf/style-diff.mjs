#!/usr/bin/env node
// CSS 重構的把關工具（P07）：同一個頁面、同一份 DOM，先套「舊」樣式、再套「新」樣式，逐元素比對 computed style。
// 比截圖嚴格：畫面外、彈窗裡、display: none 的子樹也都比得到；差異會列出元素、偽元素、屬性與前後的值。
//
//   node tools/perf/style-diff.mjs --base <舊的 dist 資料夾>               與舊版比較（頁面跑目前的 dist/）
//   node tools/perf/style-diff.mjs --base <舊> --dist <新>                 指定新版
//   node tools/perf/style-diff.mjs --base <舊> --quick                     只跑幾個代表狀態（改 CSS 時邊改邊看）
//   node tools/perf/style-diff.mjs --base <舊> --only page-overview,toast  只跑指定狀態
//   node tools/perf/style-diff.mjs --base <舊> --max 40                    每個狀態最多列幾筆差異（預設 25）
//   node tools/perf/style-diff.mjs --base <舊> --icons                     連 #phosphorSubset（圖示子集與字型）也一起比
//
// 比較的內容：<head> 的 #bootLoaderStyle、#phosphorSubset 與主樣式表（style.html，沒有 id 的那個 <style>）。
// 有 id 的照 id 對應，其餘照順序對應；只存在一邊的就當成空的樣式表。
//
// 走過的條件：
//   手機 390×844（淺色、深色）× tools/perf/ui-states.mjs 的全部狀態
//   代表狀態另外再比：data-motion=lite／off、prefers-reduced-motion、forced-colors、prefers-contrast: more、
//   prefers-reduced-transparency，以及「所有元素強制 :hover」「:active」「:focus＋:focus-visible＋:focus-within」
//   桌機 1280×900（hover: hover、pointer: fine）與平板 768×1024 的代表狀態
//
// 只比對該狀態下有畫出來的元素（getClientRects 不是空的）；每一頁、每個彈窗都有自己的狀態，所以都會比到。
// 動畫：比對前把所有動畫暫停在第 0 幀；換樣式表觸發的 transition 一律直接 finish()（否則 computed style 會停在舊值）。
// 自訂屬性（--xxx）不比：它們只要影響到真正的屬性就會在那裡出現差異。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { STATES, startFixtureApp, openBootedPage, prepare, sleep } from './ui-states.mjs';

const PERF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PERF_DIR, '..', '..');
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}
if (typeof args.base !== 'string') {
  console.error('用法：node tools/perf/style-diff.mjs --base <舊的 dist 資料夾> [--dist <新的>] [--quick] [--only a,b] [--max n]');
  process.exit(2);
}
const BASE = path.resolve(args.base);
const DIST = typeof args.dist === 'string' ? path.resolve(args.dist) : path.join(ROOT, 'dist');
const MAX = Number(args.max) || 25;
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const QUICK = Boolean(args.quick);

const REPRESENTATIVE = ['state-flash', 'page-bookkeeping', 'page-overview', 'page-settlement', 'page-creditcard', 'page-search', 'page-foreign',
  'page-settings', 'settings-paymentMethods', 'settings-budget', 'modal-editRecordModal', 'modal-cardEditModal', 'pop-calendar'];
const QUICK_STATES = ['state-flash', 'page-bookkeeping', 'page-overview', 'page-settings', 'settings-paymentMethods', 'modal-editRecordModal', 'page-foreign'];

/** 從建置產物取出頁面上的靜態 <style>（依文件順序）：Index.html 的 <style> 與 include('style') 的位置。 */
function readStyles(dir) {
  const index = fs.readFileSync(path.join(dir, 'Index.html'), 'utf8');
  const styleHtml = fs.readFileSync(path.join(dir, 'style.html'), 'utf8');
  const expanded = index.replace(/<\?!=\s*include\('style'\)\s*\?>/, () => styleHtml);
  const out = [];
  const re = /<style([^>]*)>([\s\S]*?)<\/style>/g;
  let m;
  let anon = 0;
  while ((m = re.exec(expanded))) {
    const id = (/\bid="([^"]+)"/.exec(m[1]) || [])[1];
    out.push({ key: id ? '#' + id : 'anon' + (anon++), text: m[2] });
  }
  return out;
}

/* ---------------------------------------------------------------------------
 * 頁面內的程式
 * ------------------------------------------------------------------------- */
function installHelpers() {
  const keyed = {};
  let anon = 0;
  document.querySelectorAll('style').forEach(el => {
    if (el.closest('svg')) return;
    keyed[el.id ? '#' + el.id : 'anon' + (anon++)] = el;
  });
  const props = Array.from(getComputedStyle(document.documentElement)).filter(p => !p.startsWith('--'));
  const describe = el => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList && el.classList.length) s += '.' + Array.from(el.classList).slice(0, 3).join('.');
    const host = el.parentElement && el.parentElement.closest('[id]');
    if (!el.id && host && host !== el) s = host.tagName.toLowerCase() + '#' + host.id + ' … ' + s;
    return s;
  };
  const freeze = () => {
    document.getAnimations().forEach(a => {
      try {
        if (typeof CSSTransition !== 'undefined' && a instanceof CSSTransition) a.finish();
        else { a.pause(); a.currentTime = 0; }
      } catch (e) {}
    });
  };
  const PSEUDOS = [null, '::before', '::after', '::marker', '::placeholder'];
  window.__styleDiff = {
    apply(texts) {
      Object.keys(keyed).forEach(k => { const t = Object.prototype.hasOwnProperty.call(texts, k) ? texts[k] : ''; if (keyed[k].textContent !== t) keyed[k].textContent = t; });
      Object.keys(texts).forEach(k => {
        if (keyed[k]) return;
        const el = document.createElement('style');
        el.dataset.styleDiff = k;
        el.textContent = texts[k];
        document.head.appendChild(el);
        keyed[k] = el;
      });
      void getComputedStyle(document.body).color;
      freeze();
      void document.body.offsetHeight;
      freeze();
    },
    snap() {
      // 只比「這個狀態下有畫出來」的元素（有方框）；沒畫出來的頁面、彈窗在它們自己的狀態裡比。
      // 元素清單在套舊樣式時決定，新舊兩次用同一份清單（某個元素只在一邊有方框，也會在它的祖先或它自己的屬性上出現差異）。
      const els = this.els || (this.els = [document.documentElement].concat(Array.from(document.querySelectorAll('body, body *')).filter(el => el.getClientRects().length > 0)));
      const rows = new Array(els.length * PSEUDOS.length);
      els.forEach((el, i) => {
        PSEUDOS.forEach((pseudo, j) => {
          if (pseudo === '::placeholder' && !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return;
          if (pseudo === '::marker' && !/^(LI|SUMMARY)$/.test(el.tagName)) return;
          const cs = getComputedStyle(el, pseudo);
          if ((pseudo === '::before' || pseudo === '::after') && (cs.content === 'none' || cs.content === 'normal')) {
            rows[i * PSEUDOS.length + j] = 'content:' + cs.content;
            return;
          }
          let s = '';
          for (let k = 0; k < props.length; k++) s += cs.getPropertyValue(props[k]) + '\u0001';
          rows[i * PSEUDOS.length + j] = s;
        });
      });
      return { els, rows };
    },
    compare(a, b, max) {
      const diffs = [];
      let count = 0;
      for (let i = 0; i < a.rows.length; i++) {
        if (a.rows[i] === b.rows[i]) continue;
        count++;
        if (diffs.length >= max) continue;
        const el = a.els[Math.floor(i / PSEUDOS.length)];
        const pseudo = PSEUDOS[i % PSEUDOS.length] || '';
        const va = (a.rows[i] || '').split('\u0001');
        const vb = (b.rows[i] || '').split('\u0001');
        const changed = [];
        if (va.length !== vb.length) changed.push('content: ' + a.rows[i].slice(0, 60) + ' → ' + (b.rows[i] || '').slice(0, 60));
        else for (let k = 0; k < props.length; k++) if (va[k] !== vb[k]) changed.push(props[k] + ': ' + va[k] + ' → ' + vb[k]);
        diffs.push(describe(el) + pseudo + '  ' + changed.slice(0, 6).join('；') + (changed.length > 6 ? '…（共 ' + changed.length + ' 個屬性）' : ''));
      }
      return { count, diffs };
    },
  };
}

async function diffHere(page, oldTexts, newTexts, label, report) {
  const res = await page.evaluate(({ o, n, max }) => {
    const H = window.__styleDiff;
    document.getAnimations().forEach(a => { try { a.pause(); a.currentTime = 0; } catch (e) {} });
    H.els = null;
    H.apply(o);
    const a = H.snap();
    H.apply(n);
    const b = H.snap();
    const r = H.compare(a, b, max);
    r.nodes = a.rows.length;
    document.getAnimations().forEach(x => { try { if (x.playState === 'paused') x.play(); } catch (e) {} });
    return r;
  }, { o: oldTexts, n: newTexts, max: MAX });
  report.push({ label, ...res });
  const mark = res.count ? '✗' : '✓';
  console.log('  ' + mark + ' ' + label.padEnd(48) + (res.count ? res.count + ' 個節點不同' : '相同'));
  res.diffs.forEach(d => console.log('      ' + d));
  return res.count;
}

/** 透過 CDP 對 body 內所有元素強制偽類（:hover 等），比對互動狀態的規則。 */
async function forceAll(cdp, classes) {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'body, body *' });
  await Promise.all(nodeIds.map(nodeId => cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes }).catch(() => {})));
  return nodeIds;
}

async function emulate(cdp, features) {
  await cdp.send('Emulation.setEmulatedMedia', { media: '', features });
}

async function run() {
  const oldList = readStyles(BASE);
  const newList = readStyles(DIST);
  const toMap = list => Object.fromEntries(list.map(s => [s.key, s.text]));
  const oldTexts = toMap(oldList);
  const newTexts = toMap(newList);
  // 圖示子集預設兩邊都用新的：舊版的 @font-face 指向 unpkg，換回去時字型還沒載入，含圖示的行會用後備字型的行高，
  // 量到的是字型載入的差異而不是樣式規則的差異。要連圖示子集一起比就加 --icons。
  if (!args.icons && newTexts['#phosphorSubset'] != null) oldTexts['#phosphorSubset'] = newTexts['#phosphorSubset'];
  console.log('舊：' + path.relative(ROOT, BASE) + '（' + oldList.map(s => s.key + ' ' + (s.text.length / 1024).toFixed(0) + 'KB').join('、') + '）');
  console.log('新：' + path.relative(ROOT, DIST) + '（' + newList.map(s => s.key + ' ' + (s.text.length / 1024).toFixed(0) + 'KB').join('、') + '）');

  const app = await startFixtureApp(DIST);
  const browser = await chromium.launch();
  const report = [];
  let total = 0;
  const wanted = st => (ONLY ? ONLY.has(st.key) : QUICK ? QUICK_STATES.includes(st.key) : true);
  try {
    const configs = [
      { name: '手機', theme: 'light', viewport: null, mobile: true, states: STATES.filter(wanted), extras: true },
      { name: '手機', theme: 'dark', viewport: null, mobile: true, states: STATES.filter(wanted), extras: !QUICK },
      { name: '桌機', theme: 'light', viewport: { width: 1280, height: 900 }, mobile: false, states: STATES.filter(s => REPRESENTATIVE.includes(s.key) && wanted(s)) },
      { name: '桌機', theme: 'dark', viewport: { width: 1280, height: 900 }, mobile: false, states: STATES.filter(s => REPRESENTATIVE.includes(s.key) && wanted(s)) },
      { name: '平板', theme: 'light', viewport: { width: 768, height: 1024 }, mobile: true, states: STATES.filter(s => REPRESENTATIVE.includes(s.key) && wanted(s)) },
    ];
    for (const cfg of configs) {
      if (!cfg.states.length) continue;
      console.log('\n■ ' + cfg.name + (cfg.viewport ? ' ' + cfg.viewport.width + '×' + cfg.viewport.height : ' 390×844') + '｜' + (cfg.theme === 'dark' ? '深色' : '淺色'));
      const { context, page } = await openBootedPage(browser, app.url, { theme: cfg.theme, viewport: cfg.viewport, isMobile: cfg.mobile });
      const cdp = await context.newCDPSession(page);
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      await page.evaluate(installHelpers);
      try {
        for (const st of cfg.states) {
          await prepare(page, st);
          const tag = st.key;
          total += await diffHere(page, oldTexts, newTexts, tag, report);
          if (!cfg.extras || !REPRESENTATIVE.includes(st.key) || (QUICK && st.key !== 'page-bookkeeping' && st.key !== 'modal-editRecordModal')) continue;
          for (const motion of ['lite', 'off']) {
            await page.evaluate(m => document.documentElement.setAttribute('data-motion', m), motion);
            total += await diffHere(page, oldTexts, newTexts, tag + ' ＋data-motion=' + motion, report);
          }
          await page.evaluate(() => document.documentElement.setAttribute('data-motion', 'full'));
          const mediaVariants = [
            ['prefers-reduced-motion: reduce', [{ name: 'prefers-reduced-motion', value: 'reduce' }]],
            ['forced-colors: active', [{ name: 'forced-colors', value: 'active' }]],
            ['prefers-contrast: more', [{ name: 'prefers-contrast', value: 'more' }]],
            ['prefers-reduced-transparency', [{ name: 'prefers-reduced-transparency', value: 'reduce' }]],
          ];
          for (const [name, features] of mediaVariants) {
            await emulate(cdp, features.concat([{ name: 'prefers-color-scheme', value: cfg.theme }]));
            total += await diffHere(page, oldTexts, newTexts, tag + ' ＋' + name, report);
          }
          await emulate(cdp, [{ name: 'prefers-color-scheme', value: cfg.theme }]);
          for (const classes of [['hover'], ['active', 'hover'], ['focus', 'focus-visible', 'focus-within']]) {
            const ids = await forceAll(cdp, classes);
            total += await diffHere(page, oldTexts, newTexts, tag + ' ＋強制 :' + classes.join(' :'), report);
            await Promise.all(ids.map(nodeId => cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {})));
          }
        }
      } finally { await context.close(); }
    }
  } finally {
    await browser.close();
    await app.close();
  }
  const bad = report.filter(r => r.count);
  console.log('\n結果：比對 ' + report.length + ' 個條件，' + (bad.length ? bad.length + ' 個有差異（合計 ' + total + ' 個節點）' : '全部相同'));
  if (typeof args.json === 'string') fs.writeFileSync(path.resolve(args.json), JSON.stringify(report, null, 2));
  process.exitCode = bad.length ? 1 : 0;
}

run().catch(e => { console.error(e); process.exit(1); });
