#!/usr/bin/env node
// 毛玻璃盤點與全狀態截圖比對（P03）：逐頁、逐個彈窗／彈出層，列出 computed backdrop-filter 不是 none 的元素（含 ::before／::after），
// 並判斷它會不會被捲動內容穿過（自己或祖先是 position: fixed／sticky ＝ 浮在捲動內容上方）。
//
//   node tools/perf/glass-audit.mjs                              盤點 dist/，印出表格（淺色）
//   node tools/perf/glass-audit.mjs --shots after                另外在淺色、深色各截一張圖到 tools/perf/screens/glass-after/
//   node tools/perf/glass-audit.mjs --shots after --compare before
//                                                               並用 pixelmatch 比對 screens/glass-before/ 的同名截圖
//   node tools/perf/glass-audit.mjs --dist <資料夾>               量別的建置產物（例如改之前的 dist）
//   node tools/perf/glass-audit.mjs --json <檔案>                 盤點結果另存 JSON
//   node tools/perf/glass-audit.mjs --only page-overview,toast    只跑指定的狀態（逗號分隔）
//   node tools/perf/glass-audit.mjs --css ':root{--glass-static-content-lift:.1}'
//                                                               每頁額外注入一段 CSS（調 --glass-static-* 數值時用）
//
// 判斷規則：
//   浮動（第一類）：元素或祖先是 fixed／sticky，或位在開啟中的彈窗裡 → 背後的內容會移動，需要真正的 backdrop-filter。
//   靜態（第二類）：只疊在頁面背景上 → 應改成靜態底色。
//   巢狀：祖先已經有 backdrop-filter → 由外層處理即可。
// 「靜止」計數 = 有方框、display 不是 none 的元素（visibility: hidden 也算：瀏覽器仍要保留它的圖層與樣式）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import { STATES, VIEWPORT, FIXED_NOW, sleep, prepare, startFixtureApp } from './ui-states.mjs';

const PERF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PERF_DIR, '..', '..');
const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (!argv[i].startsWith('--')) continue;
  args[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
}
const DIST = typeof args.dist === 'string' ? path.resolve(args.dist) : undefined;
const SHOTS = typeof args.shots === 'string' ? path.join(PERF_DIR, 'screens', 'glass-' + args.shots) : '';
const COMPARE = typeof args.compare === 'string' ? path.join(PERF_DIR, 'screens', 'glass-' + args.compare) : '';
const ONLY = typeof args.only === 'string' ? new Set(args.only.split(',')) : null;
const EXTRA_CSS = typeof args.css === 'string' ? args.css : '';
const PREFS = { motion: 'full', autoScroll: true };
// 狀態清單、開機與 prepare() 與 style-diff.mjs、css-coverage.mjs 共用（tools/perf/ui-states.mjs）
function inventory() {
  const describe = el => {
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    else if (el.classList.length) s += '.' + Array.from(el.classList).slice(0, 2).join('.');
    return s;
  };
  const openModal = document.querySelector('.modal-backdrop.show');
  const hasBf = (el, pseudo) => {
    const cs = getComputedStyle(el, pseudo);
    const bf = cs.backdropFilter || cs.webkitBackdropFilter;
    if (!bf || bf === 'none') return null;
    if (pseudo && (cs.content === 'none' || cs.content === 'normal')) return null;
    return { bf, cs };
  };
  const out = [];
  document.querySelectorAll('body *').forEach(el => {
    if (el.closest('svg')) return;
    const r = el.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;        // display: none 或 0 大小（含祖先 display: none）
    [null, '::before', '::after'].forEach(pseudo => {
      const hit = hasBf(el, pseudo);
      if (!hit) return;
      let floating = '';
      for (let a = el; a && a !== document.body; a = a.parentElement) {
        const p = getComputedStyle(a).position;
        if (p === 'fixed' || p === 'sticky') { floating = p + '@' + describe(a); break; }
      }
      let nested = '';
      for (let a = pseudo ? el : el.parentElement; a && a !== document.body; a = a.parentElement) {
        if (hasBf(a, null)) { nested = describe(a); break; }
      }
      let hidden = '';
      for (let a = el; a && a !== document.documentElement; a = a.parentElement) {
        const cs = getComputedStyle(a);
        if (cs.visibility === 'hidden') { hidden = 'visibility'; break; }
        if (cs.opacity === '0') { hidden = 'opacity@' + describe(a); break; }
        if (cs.contentVisibility === 'hidden' && a !== el) { hidden = 'content-visibility@' + describe(a); break; }
      }
      out.push({
        target: describe(el) + (pseudo || ''),
        filter: hit.bf,
        floating,
        nested,
        hidden,
        inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth,
        inModal: Boolean(openModal && openModal.contains(el)),
      });
    });
  });
  const closedModals = Array.from(document.querySelectorAll('.modal-backdrop:not(.show)')).map(m => ({ id: m.id, display: getComputedStyle(m).display }));
  return { items: out, closedModals };
}

async function shoot(page, file) {
  await page.evaluate(() => {
    document.getAnimations().forEach(a => { try { a.pause(); a.currentTime = 0; } catch (e) {} });
    if (window.__bgDebug) window.__bgDebug.setTime(0);
  });
  await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.screenshot({ path: file, animations: 'allow', caret: 'hide' });
  await page.evaluate(() => {
    document.getAnimations().forEach(a => { if (a.playState === 'paused') a.play(); });
    if (window.__bgDebug) window.__bgDebug.setTime(null);
  });
}

async function run() {
  const app = await startFixtureApp(DIST);
  const url = app.url;
  const browser = await chromium.launch();
  const result = {};
  if (SHOTS) { fs.rmSync(SHOTS, { recursive: true, force: true }); fs.mkdirSync(SHOTS, { recursive: true }); }
  try {
    for (const theme of ['light', 'dark']) {
      if (theme === 'dark' && !SHOTS) break;
      const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: 'zh-TW', timezoneId: 'Asia/Taipei', colorScheme: theme });
      await context.addInitScript(cfg => {
        const RealDate = Date; const off = cfg.now - RealDate.now();
        class D extends RealDate { constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + off); } static now() { return RealDate.now() + off; } }
        window.Date = D;
        try { localStorage.setItem('FAST_BOOKKEEPING_PREFS_V1', JSON.stringify(cfg.prefs)); } catch (e) {}
      }, { now: FIXED_NOW, prefs: PREFS });
      const page = await context.newPage();
      page.on('pageerror', e => console.warn('  [頁面錯誤] ' + e.message));
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.classList.contains('boot-ready'), null, { timeout: 60000 });
      await sleep(2500);
      if (EXTRA_CSS) await page.addStyleTag({ content: EXTRA_CSS });
      for (const st of STATES) {
        if (ONLY && !ONLY.has(st.key)) continue;
        await prepare(page, st);
        if (theme === 'light') result[st.key] = await page.evaluate(inventory);
        if (SHOTS) await shoot(page, path.join(SHOTS, st.key + '-' + theme + '.png'));
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await app.close();
  }
  return result;
}

function compare() {
  const out = [];
  for (const name of fs.readdirSync(SHOTS).filter(f => f.endsWith('.png')).sort()) {
    const b = path.join(COMPARE, name);
    if (!fs.existsSync(b)) { out.push([name, '基準沒有這張']); continue; }
    const A = PNG.sync.read(fs.readFileSync(path.join(SHOTS, name)));
    const B = PNG.sync.read(fs.readFileSync(b));
    if (A.width !== B.width || A.height !== B.height) { out.push([name, '尺寸不同']); continue; }
    const diff = new PNG({ width: A.width, height: A.height });
    const px = pixelmatch(A.data, B.data, diff.data, A.width, A.height, { threshold: 0.1 });
    fs.mkdirSync(path.join(SHOTS, 'diff'), { recursive: true });
    fs.writeFileSync(path.join(SHOTS, 'diff', name), PNG.sync.write(diff));
    out.push([name, (Math.round(px / (A.width * A.height) * 100000) / 1000) + '%（' + px + ' 像素）']);
  }
  return out;
}

const result = await run();
for (const [key, inv] of Object.entries(result)) {
  const items = inv.items;
  const kind = it => (it.floating || it.inModal ? '浮動' : '靜態') + (it.nested ? '／巢狀' : '');
  console.log('\n■ ' + key + '：backdrop-filter ' + items.length + ' 個（可見 ' + items.filter(i => !i.hidden).length + '、畫面內 ' + items.filter(i => i.inView && !i.hidden).length + '）');
  for (const it of items) {
    console.log('  ' + [kind(it), it.target, it.filter, it.floating || '-', it.nested ? '外層 ' + it.nested : '-', it.hidden ? '隱藏(' + it.hidden + ')' : '可見', it.inView ? '畫面內' : '畫面外'].join(' | '));
  }
  const parked = inv.closedModals.filter(m => m.display !== 'none').map(m => m.id);
  if (parked.length) console.log('  關閉中但不是 display: none 的彈窗：' + parked.join('、'));
}
if (typeof args.json === 'string') fs.writeFileSync(path.resolve(args.json), JSON.stringify(result, null, 2));
if (SHOTS && COMPARE) {
  console.log('\n截圖比對（與 ' + path.relative(ROOT, COMPARE) + '/，pixelmatch threshold 0.1）：');
  compare().forEach(([n, r]) => console.log('  ' + n.padEnd(44) + r));
}
