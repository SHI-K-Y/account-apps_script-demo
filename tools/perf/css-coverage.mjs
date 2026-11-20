#!/usr/bin/env node
// CSS 覆蓋率（P07）：走過 tools/perf/ui-states.mjs 的每一頁、每個彈窗與彈出層（淺色、深色、桌機、動畫偏好、
// 各種 media 條件、強制 :hover／:active／:focus-visible），列出從來沒有命中過的樣式規則，對回 src/client/styles/ 的檔名與行號。
//
//   node tools/perf/css-coverage.mjs                       印出摘要，報告寫到 tools/perf/results/css-coverage.json
//   node tools/perf/css-coverage.mjs --quick               只跑幾個代表狀態
//
// 「從未命中」不等於可以刪：載入中、錯誤、空資料、拖曳中這類狀態這裡走不到。報告另外標出「疑似死碼」：
// 選擇器裡至少有一個 class／id 在 src/ 的 HTML、JS、GS 裡完全找不到（也找不到用字串組出它的前綴）。
// 刪除前一律人工確認。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { build } from '../build.mjs';
import { STATES, startFixtureApp, openBootedPage, prepare } from './ui-states.mjs';

const PERF_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(PERF_DIR, '..', '..');
const STYLES = path.join(ROOT, 'src', 'client', 'styles');
const QUICK = process.argv.includes('--quick');
const REPRESENTATIVE = ['page-bookkeeping', 'page-overview', 'page-settlement', 'page-creditcard', 'page-search', 'page-foreign',
  'page-settings', 'settings-paymentMethods', 'modal-editRecordModal', 'modal-cardEditModal', 'pop-calendar'];

async function main() {
  // 不壓縮的建置：樣式表內容就是各檔案依序串接，位移可以對回原始檔
  const { outputs } = await build({ minify: false, write: false, quiet: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'css-coverage-'));
  Object.entries(outputs).forEach(([name, text]) => fs.writeFileSync(path.join(tmp, name), text));
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'client', 'manifest.json'), 'utf8'));
  const app = await startFixtureApp(tmp);
  const browser = await chromium.launch();
  const usedRanges = [];      // [start, end]（主樣式表內）
  let sheetText = null;
  const states = QUICK ? STATES.filter(s => REPRESENTATIVE.slice(0, 5).includes(s.key)) : STATES;
  try {
    const configs = [
      { theme: 'light', extras: true, states },
      { theme: 'dark', extras: true, states },
      { theme: 'light', viewport: { width: 1280, height: 900 }, mobile: false, states: states.filter(s => REPRESENTATIVE.includes(s.key)) },
      { theme: 'dark', viewport: { width: 1280, height: 900 }, mobile: false, states: states.filter(s => REPRESENTATIVE.includes(s.key)) },
      { theme: 'light', viewport: { width: 768, height: 1024 }, states: states.filter(s => REPRESENTATIVE.includes(s.key)) },
      { theme: 'light', viewport: { width: 320, height: 640 }, states: states.filter(s => REPRESENTATIVE.includes(s.key)) },
    ];
    for (const cfg of configs) {
      const { context, page } = await openBootedPage(browser, app.url, { theme: cfg.theme, viewport: cfg.viewport, isMobile: cfg.mobile, settleMs: 0 });
      const cdp = await context.newCDPSession(page);
      const sheets = [];
      cdp.on('CSS.styleSheetAdded', e => sheets.push(e.header));
      await cdp.send('DOM.enable');
      await cdp.send('CSS.enable');
      await cdp.send('CSS.startRuleUsageTracking');
      sheets.length = 0;   // 重新整理之前的樣式表 id 之後就失效了
      // 開機到現在的規則已經套用過，重新整理一次讓追蹤從頭開始
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => document.documentElement.classList.contains('boot-ready'), null, { timeout: 60000 });
      await new Promise(r => setTimeout(r, 2500));
      const collect = async () => {
        const { coverage } = await cdp.send('CSS.takeCoverageDelta');
        coverage.filter(c => c.used).forEach(c => usedRanges.push({ ctx: cfg, id: c.styleSheetId, s: c.startOffset, e: c.endOffset }));
      };
      // 主樣式表＝最長的那一個（用 styleSheetAdded 的 header 判斷，頁面當掉也拿得到 id）
      const mainId = () => sheets.slice().sort((a, b) => b.length - a.length)[0].styleSheetId;
      try {
      for (const st of cfg.states) {
        await prepare(page, st);
        await collect();
        if (!cfg.extras || !REPRESENTATIVE.includes(st.key)) continue;
        for (const motion of ['lite', 'off']) {
          await page.evaluate(m => document.documentElement.setAttribute('data-motion', m), motion);
          await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
          await collect();
        }
        await page.evaluate(() => document.documentElement.setAttribute('data-motion', 'full'));
        for (const f of ['prefers-reduced-motion:reduce', 'forced-colors:active', 'prefers-contrast:more', 'prefers-reduced-transparency:reduce']) {
          const [name, value] = f.split(':');
          await cdp.send('Emulation.setEmulatedMedia', { media: '', features: [{ name, value }, { name: 'prefers-color-scheme', value: cfg.theme }] });
          await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
          await collect();
        }
        await cdp.send('Emulation.setEmulatedMedia', { media: '', features: [{ name: 'prefers-color-scheme', value: cfg.theme }] });
        const { root } = await cdp.send('DOM.getDocument', { depth: -1 });
        const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: 'body, body *' });
        for (const classes of [['hover'], ['active', 'hover'], ['focus', 'focus-visible', 'focus-within']]) {
          await Promise.all(nodeIds.map(nodeId => cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: classes }).catch(() => {})));
          await page.evaluate(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))));
          await collect();
        }
        await Promise.all(nodeIds.map(nodeId => cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: [] }).catch(() => {})));
      }
      } catch (e) {
        // 頁面偶爾會在強制偽類＋規則追蹤下當掉：保留已經收集到的部分，換下一組條件
        console.warn('\n  ⚠ ' + (cfg.viewport ? cfg.viewport.width + 'px ' : '') + cfg.theme + ' 中途失敗（' + String(e.message).split('\n')[0] + '），保留已收集的部分');
      }
      const id = mainId();
      usedRanges.forEach(r => { if (r.ctx === cfg && r.id === id) r.main = true; });
      if (sheetText == null) {
        try { sheetText = (await cdp.send('CSS.getStyleSheetText', { styleSheetId: id })).text; } catch (e) {}
      }
      await context.close().catch(() => {});
      process.stdout.write('.');
    }
  } finally {
    await browser.close();
    await app.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  console.log('');

  // 所有規則（含沒用到的）的範圍：用最後一次 stopRuleUsageTracking 拿不到全部，改成自己掃描主樣式表
  // 規則的起點落在任何一段「用過」的範圍內就算命中（CDP 的範圍起點是選擇器開頭，結尾是 }）
  const intervals = usedRanges.filter(r => r.main).map(r => [r.s, r.e]).sort((a, b) => a[0] - b[0]);
  const isUsed = pos => {
    let lo = 0, hi = intervals.length - 1, best = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (intervals[mid][0] <= pos) { best = mid; lo = mid + 1; } else hi = mid - 1; }
    for (let k = best; k >= 0 && k > best - 50; k--) if (intervals[k][0] <= pos && pos < intervals[k][1]) return true;
    return false;
  };
  const used = { has: isUsed };
  const files = manifest.styles.map(name => ({ name, text: fs.readFileSync(path.join(STYLES, name), 'utf8').replace(/\n+$/, '') }));
  let cursor = 0;
  // 建置時 @property 會被搬到 @layer 外面（tools/build.mjs 的 layered()），比對時也拿掉
  files.forEach(f => { f.text = f.text.replace(/@property\s+--[\w-]+\s*\{[^{}]*\}/g, ''); });
  files.forEach(f => { f.start = sheetText.indexOf(f.text, cursor); if (f.start < 0) throw new Error('對不回原始檔：' + f.name); cursor = f.start + f.text.length; });
  const rules = scanRules(sheetText);
  const sources = walk(path.join(ROOT, 'src'), ['.html', '.js', '.gs']).filter(f => !f.includes(path.sep + 'styles' + path.sep)).map(f => fs.readFileSync(f, 'utf8')).join('\n');
  const report = [];
  rules.forEach(r => {
    if (used.has(r.start)) return;
    const f = files.slice().reverse().find(x => x.start <= r.start);
    const line = f.text.slice(0, r.start - f.start).split('\n').length;
    const missing = missingTokens(r.selector, sources);
    report.push({ file: f.name, line, selector: r.selector, context: r.context, deadTokens: missing });
  });
  const dead = report.filter(r => r.deadTokens.length);
  const byFile = {};
  report.forEach(r => { byFile[r.file] = byFile[r.file] || { unused: 0, dead: 0 }; byFile[r.file].unused++; if (r.deadTokens.length) byFile[r.file].dead++; });
  console.log('樣式規則 ' + rules.length + ' 條；從未命中 ' + report.length + ' 條；其中疑似死碼（選擇器含原始碼裡找不到的 class／id）' + dead.length + ' 條');
  Object.entries(byFile).forEach(([f, c]) => console.log('  ' + f.padEnd(28) + '未命中 ' + String(c.unused).padStart(4) + '   疑似死碼 ' + String(c.dead).padStart(4)));
  fs.mkdirSync(path.join(PERF_DIR, 'results'), { recursive: true });
  const out = path.join(PERF_DIR, 'results', 'css-coverage.json');
  fs.writeFileSync(out, JSON.stringify({ totalRules: rules.length, unused: report }, null, 2));
  console.log('報告：' + path.relative(ROOT, out));
}

/** 簡單的 CSS 掃描：找出每條樣式規則（不含 @keyframes 的影格、@font-face 等）的開頭位移、選擇器與所在的 at-rule。 */
function scanRules(css) {
  const out = [];
  const stack = [];
  let i = 0;
  let start = 0;
  const n = css.length;
  while (i < n) {
    const c = css[i];
    if (c === '/' && css[i + 1] === '*') { const e = css.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; if (!stack.length || stack[stack.length - 1].block) start = i; continue; }
    if (c === '"' || c === "'") { const q = c; i++; while (i < n && css[i] !== q) { if (css[i] === '\\') i++; i++; } i++; continue; }
    if (c === '{') {
      const prelude = css.slice(start, i).trim();
      const parent = stack[stack.length - 1];
      const inKeyframes = parent && /^@(-webkit-)?keyframes/.test(parent.prelude);
      if (prelude.startsWith('@')) stack.push({ prelude, block: true });
      else {
        if (!inKeyframes && !(parent && /^@(font-face|property|page)/.test(parent.prelude))) {
          let s = start; while (/\s/.test(css[s])) s++;
          out.push({ start: s, selector: prelude.replace(/\s+/g, ' '), context: stack.filter(x => x.block).map(x => x.prelude).join(' » ') });
        }
        stack.push({ prelude, block: false });
      }
      i++; start = i; continue;
    }
    if (c === '}') { stack.pop(); i++; start = i; continue; }
    if (c === ';' && (!stack.length || stack[stack.length - 1].block)) { i++; start = i; continue; }
    i++;
  }
  return out;
}

function walk(dir, exts, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, exts, out);
    else if (exts.some(x => e.name.endsWith(x))) out.push(full);
  });
  return out;
}

/** 選擇器裡在原始碼找不到的 class／id（連「前綴-」也找不到，才算找不到：避免 'is-' + state 這種組字串）。 */
function missingTokens(selector, sources) {
  const tokens = new Set((selector.replace(/\[[^\]]*\]/g, '').match(/[.#]-?[A-Za-z_][\w-]*/g) || []).map(t => t.slice(1)));
  const missing = [];
  tokens.forEach(t => {
    if (sources.includes(t)) return;
    const parts = t.split('-');
    for (let k = parts.length - 1; k >= 1; k--) {
      const prefix = parts.slice(0, k).join('-') + '-';
      if (new RegExp('[\'"`]' + prefix.replace(/[-]/g, '\\-') + '[\'"`]?\\s*[+$]|' + prefix.replace(/[-]/g, '\\-') + '\\$\\{').test(sources) ||
          new RegExp('[\'"`][^\'"`]*' + prefix.replace(/[-]/g, '\\-') + '[\'"`]\\s*\\+').test(sources)) return;
    }
    missing.push(t);
  });
  return missing;
}

main().catch(e => { console.error(e); process.exit(1); });
