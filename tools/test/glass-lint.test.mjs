// 毛玻璃守門測試（P03）：backdrop-filter 只留在浮在捲動內容上方的層（見 18-glass-chrome.css「毛玻璃只留在浮動層」）。
//
//   1. 全站 CSS 只有 18-glass-chrome.css 可以宣告 backdrop-filter／-webkit-backdrop-filter，
//      而且值只能是 var(--glass-live)、var(--glass-live-thick)、var(--glass-live-sheet)：
//      不准寫死濾鏡值，也不准「先設定再覆寫成 none」。
//   2. 兩組 token 都定義在 01-tokens-base.css；折射只透過重新定義 --glass-live／--glass-live-thick 加上。
//   3. 已移除的舊 token（--blur-sm/md/lg、--lg-content-blur、--bg-gradient）與 body::before 全螢幕層不能再出現。
//   4. 關閉中的彈窗與 toast 停放成 display: none；openModal 在加 .show 之前先算一次樣式（開啟轉場才有起點）。
//
// 執行時的盤點（每頁、每個彈窗實際有幾個 backdrop-filter、會不會被捲動內容穿過）用 node tools/perf/glass-audit.mjs。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const CLIENT = path.join(ROOT, 'src', 'client');
const STYLES_DIR = path.join(CLIENT, 'styles');
const manifest = JSON.parse(fs.readFileSync(path.join(CLIENT, 'manifest.json'), 'utf8'));
const stripComments = text => text.replace(/\/\*[\s\S]*?\*\//g, m => m.replace(/[^\n]/g, ' '));
const sheets = manifest.styles.map(name => ({ name, text: stripComments(fs.readFileSync(path.join(STYLES_DIR, name), 'utf8')) }));
const lineAt = (text, index) => text.slice(0, index).split('\n').length;
const LIVE_VALUES = new Set(['var(--glass-live)', 'var(--glass-live-thick)', 'var(--glass-live-sheet)']);

test('backdrop-filter 只在 18-glass-chrome.css 宣告，而且只用 --glass-live* token', () => {
  const problems = [];
  let count = 0;
  for (const { name, text } of sheets) {
    const re = /(?:^|[;{\s])(-webkit-)?backdrop-filter\s*:\s*([^;}]*)/g;
    let m;
    while ((m = re.exec(text))) {
      count++;
      const value = m[2].trim().replace(/\s*!important$/, '');
      const where = name + ':' + lineAt(text, m.index);
      if (name !== '18-glass-chrome.css') problems.push(where + ' 不應宣告 backdrop-filter（第二類請用 --glass-static-* 靜態底色）');
      else if (!LIVE_VALUES.has(value)) problems.push(where + ' 的值是「' + value + '」，只能用 var(--glass-live*)');
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
  assert.ok(count >= 6 && count <= 8, '預期 3 組 × 2（含 -webkit-）個宣告，實際 ' + count + ' 個');
});

test('兩組 token 定義在 01-tokens-base.css，折射只改 --glass-live*', () => {
  const tokens = sheets.find(s => s.name === '01-tokens-base.css').text;
  for (const t of ['--glass-live', '--glass-live-thick', '--glass-live-sheet', '--glass-static-content', '--glass-static-content-lift', '--glass-static-chip-lift', '--glass-static-chip-a']) {
    assert.match(tokens, new RegExp('\\s' + t + '\\s*:'), '01-tokens-base.css 缺少 ' + t);
  }
  const chrome = sheets.find(s => s.name === '18-glass-chrome.css').text;
  const refract = chrome.match(/:root\.lg-can-refract\s*\{([^}]*)\}/);
  assert.ok(refract, '18-glass-chrome.css 應該在 :root.lg-can-refract 重新定義 --glass-live*');
  assert.match(refract[1], /--glass-live:\s*url\(#lg-refract\)\s*var\(--lg-blur\)/);
  assert.match(refract[1], /--glass-live-thick:\s*url\(#lg-refract\)\s*var\(--lg-blur-thick\)/);
  // @supports (backdrop-filter: url(#lg-refract)) 是條件判斷，不算使用
  const all = sheets.map(s => s.text).join('\n').replace(/@supports\s*\(backdrop-filter:\s*url\(#lg-refract\)\)/g, '');
  assert.equal((all.match(/url\(#lg-refract\)/g) || []).length, 2, '折射只能出現在 --glass-live／--glass-live-thick 的重新定義');
});

test('舊的模糊 token 與 body::before 全螢幕層已移除', () => {
  for (const { name, text } of sheets) {
    for (const re of [/--blur-(?:sm|md|lg)\b/, /--lg-content-blur\b/, /--(?:fx-)?bg-gradient\b/, /body::before/]) {
      const m = re.exec(text);
      assert.ok(!m, name + ':' + (m ? lineAt(text, m.index) : '') + ' 還有 ' + re);
    }
  }
});

test('關閉中的彈窗與 toast 停放成 display: none', () => {
  const all = sheets.map(s => s.text).join('\n');
  assert.match(all, /\.modal-backdrop:not\(\.show\):not\(\.is-animating\)\s*\{\s*display:\s*none;?\s*\}/);
  assert.match(all, /\.toast:not\(\.show\):not\(\.is-animating\)\s*\{\s*display:\s*none;?\s*\}/);
  assert.doesNotMatch(all, /content-visibility:\s*hidden/, '彈窗停放改用 display: none');

  const press = fs.readFileSync(path.join(CLIENT, 'scripts', 'core', 'press-feedback.js'), 'utf8');
  const open = press.match(/function openModal\(el\) \{([\s\S]*?)\n\}/);
  assert.ok(open, '找不到 openModal');
  const body = open[1];
  const flush = body.indexOf('void el.offsetWidth');
  assert.ok(flush !== -1, 'openModal 要在加 .show 之前先算一次樣式');
  assert.ok(body.indexOf('markModalAnimating(el)') < flush && flush < body.indexOf("classList.add('show')"),
    '順序必須是：加 .is-animating → 算樣式 → 加 .show');

  const feedback = fs.readFileSync(path.join(CLIENT, 'scripts', 'core', 'feedback.js'), 'utf8');
  assert.match(feedback, /toast\.classList\.add\('is-animating'\);\s*toast\.classList\.remove\('show'\)/, 'toast 淡出期間要保留 .is-animating');
});
