// 動畫守門測試（P02）：無限循環的動畫只能動 transform／translate／rotate／scale／opacity（CLAUDE.md「動畫與效能規則」）。
//
// 讀 src/client/manifest.json 列出的所有 CSS：
//   1. 找出所有「搭配 infinite 使用」的 @keyframes 名稱：animation 簡寫裡含 infinite 的那一段，或同一個區塊裡
//      animation-name 搭配 animation-iteration-count: infinite。名稱寫成 var(--x) 時，用整份樣式表裡所有 --x 的值去解。
//   2. 這些 @keyframes（每一個同名定義都算）裡只能出現 transform、translate、rotate、scale、opacity
//      （offset 與 animation-timing-function 除外），否則失敗並印出檔名與行號。
//   3. 例外：在 @keyframes 正上方（或同一行）加註解 /* motion-lint: allow 原因 */，原因不能空白。
//   4. 不論是否無限循環，都不准 will-change: filter 與 will-change: background-position（會讓瀏覽器為了不會發生的合成預留圖層）。
//
// 這裡只看 CSS；用 JS 建立的無限動畫（el.animate(..., { iterations: Infinity })）請照 core/perf.js 的規則自行檢查。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';

const STYLES_DIR = path.join(ROOT, 'src', 'client', 'styles');
const ALLOWED_PROPS = new Set(['transform', 'translate', 'rotate', 'scale', 'opacity', 'offset', 'animation-timing-function']);
const BANNED_WILL_CHANGE = new Set(['filter', 'background-position']);
const ALLOW_RE = /motion-lint:\s*allow\b\s*([^*]*)/;

/** 把註解換成空白（保留換行，行號才對得上），同時記下 motion-lint 例外註解的位置。 */
function stripComments(text) {
  const allows = [];
  const out = text.replace(/\/\*[\s\S]*?\*\//g, (m, offset) => {
    const hit = m.match(ALLOW_RE);
    if (hit) allows.push({ end: offset + m.length, reason: hit[1].trim() });
    return m.replace(/[^\n]/g, ' ');
  });
  return { text: out, allows };
}

const lineAt = (text, index) => text.slice(0, index).split('\n').length;

/** 切出所有 { } 區塊：prelude（選擇器或 at-rule）、內容範圍與巢狀深度。 */
function blocks(text) {
  const list = [];
  const stack = [];
  let preludeStart = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') {
      const prelude = text.slice(preludeStart, i);
      const trimmedStart = preludeStart + prelude.search(/\S|$/);
      stack.push({ prelude: prelude.trim(), start: trimmedStart, bodyStart: i + 1, children: [] });
      preludeStart = i + 1;
    } else if (ch === '}') {
      const b = stack.pop();
      if (!b) continue;
      b.bodyEnd = i;
      if (stack.length) stack[stack.length - 1].children.push(b);
      list.push(b);
      preludeStart = i + 1;
    } else if (ch === ';') {
      preludeStart = i + 1;
    }
  }
  return list;
}

/** 區塊本身（不含巢狀區塊）的宣告：[{ prop, value, index }] */
function declarations(text, block) {
  const out = [];
  let cursor = block.bodyStart;
  const ranges = [];
  block.children.slice().sort((a, b) => a.start - b.start).forEach(c => {
    ranges.push([cursor, c.start]);
    cursor = c.bodyEnd + 1;
  });
  ranges.push([cursor, block.bodyEnd]);
  for (const [s, e] of ranges) {
    let at = s;
    for (const part of text.slice(s, e).split(';')) {
      const m = part.match(/^(\s*)([-\w]+)\s*:([\s\S]*)$/);
      if (m) out.push({ prop: m[2].toLowerCase(), value: m[3].trim().replace(/\s*!important$/i, ''), index: at + m[1].length });
      at += part.length + 1;
    }
  }
  return out;
}

/** 以頂層逗號切開（括號內的逗號不算）。 */
function splitTop(value, sep) {
  const parts = [];
  let depth = 0;
  let cur = '';
  for (const ch of value) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (depth === 0 && (sep === ',' ? ch === ',' : /\s/.test(ch))) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(s => s.trim()).filter(Boolean);
}

const NON_NAME = new Set(['infinite', 'none', 'normal', 'reverse', 'alternate', 'alternate-reverse', 'forwards', 'backwards', 'both',
  'running', 'paused', 'linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out', 'step-start', 'step-end', 'initial', 'inherit', 'unset', 'revert']);

/** 把 var(--x) 換成所有可能的值（樣式表裡每一個 --x 宣告），回傳展開後的 token 清單。 */
function resolveTokens(token, vars, seen = new Set()) {
  const m = token.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*([\s\S]*))?\)$/);
  if (!m) return [token];
  if (seen.has(m[1])) return [];
  const values = vars.get(m[1]) || (m[2] ? [m[2]] : []);
  return values.flatMap(v => splitTop(v, ' ').flatMap(t => resolveTokens(t, vars, new Set(seen).add(m[1]))));
}

function namesIn(tokens, vars) {
  return tokens.flatMap(t => resolveTokens(t, vars))
    .filter(t => /^-?[_a-zA-Z][\w-]*$/.test(t) && !NON_NAME.has(t.toLowerCase()));
}

/**
 * 檢查一組樣式表。files：[{ name, text }]。回傳 { problems: [字串], infinite: Set<名稱> }。
 */
export function lintMotion(files) {
  const parsed = files.map(f => {
    const { text, allows } = stripComments(f.text);
    const list = blocks(text);
    return { name: f.name, raw: f.text, text, allows, list, decls: list.map(b => ({ block: b, decls: declarations(text, b) })) };
  });

  const vars = new Map();
  parsed.forEach(p => p.decls.forEach(({ decls }) => decls.forEach(d => {
    if (!d.prop.startsWith('--')) return;
    if (!vars.has(d.prop)) vars.set(d.prop, []);
    vars.get(d.prop).push(d.value);
  })));

  const infinite = new Set();
  const problems = [];
  parsed.forEach(p => p.decls.forEach(({ block, decls }) => {
    if (block.prelude.startsWith('@keyframes')) return;
    const names = [];
    const counts = [];
    decls.forEach(d => {
      if (d.prop === 'animation' || d.prop === '-webkit-animation') {
        splitTop(d.value, ',').forEach(one => {
          const tokens = splitTop(one, ' ');
          if (tokens.flatMap(t => resolveTokens(t, vars)).includes('infinite')) namesIn(tokens, vars).forEach(n => infinite.add(n));
        });
      } else if (d.prop === 'animation-name') {
        names.push(...splitTop(d.value, ',').map(n => namesIn([n], vars)));
      } else if (d.prop === 'animation-iteration-count') {
        counts.push(...splitTop(d.value, ',').map(c => resolveTokens(c, vars).includes('infinite')));
      } else if (d.prop === 'will-change') {
        splitTop(d.value, ',').forEach(v => {
          if (BANNED_WILL_CHANGE.has(v.toLowerCase())) {
            problems.push(p.name + ':' + lineAt(p.text, d.index) + '  will-change: ' + v + ' 不允許（只預留 transform／opacity）');
          }
        });
      }
    });
    if (counts.length) names.forEach((list, i) => { if (counts[i % counts.length]) list.forEach(n => infinite.add(n)); });
  }));

  parsed.forEach(p => p.list.forEach(block => {
    const m = block.prelude.match(/^@(?:-webkit-)?keyframes\s+([^\s{]+)/);
    if (!m || !infinite.has(m[1])) return;
    const allow = p.allows.find(a => a.end <= block.start && /^\s*$/.test(p.text.slice(a.end, block.start)))
      || p.allows.find(a => a.end > block.start && lineAt(p.text, a.end) === lineAt(p.text, block.start));
    if (allow) {
      if (!allow.reason) problems.push(p.name + ':' + lineAt(p.text, block.start) + '  @keyframes ' + m[1] + ' 的 motion-lint: allow 沒有寫原因');
      return;
    }
    block.children.forEach(frame => declarations(p.text, frame).forEach(d => {
      const prop = d.prop.replace(/^-webkit-/, '');
      if (ALLOWED_PROPS.has(prop)) return;
      problems.push(p.name + ':' + lineAt(p.text, d.index) + '  @keyframes ' + m[1] + '（無限循環）動到 ' + d.prop +
        '；只能動 transform／translate／rotate／scale／opacity，或在 @keyframes 上方註明 /* motion-lint: allow 原因 */');
    }));
  }));

  return { problems, infinite };
}

function manifestStyles() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'client', 'manifest.json'), 'utf8'));
  return manifest.styles.map(name => ({ name: 'src/client/styles/' + name, text: fs.readFileSync(path.join(STYLES_DIR, name), 'utf8') }));
}

test('動畫守門：無限循環的 @keyframes 只動 transform／opacity，沒有 will-change: filter／background-position', () => {
  const { problems, infinite } = lintMotion(manifestStyles());
  assert.ok(infinite.size > 0, '應該找得到無限循環的動畫（解析失敗？）');
  assert.ok(problems.length === 0, '\n' + problems.join('\n'));
});

test('動畫守門：認得出違規的寫法（自我檢查）', () => {
  const css = [
    ':root { --flow: bad-flow; }',
    '.a { animation: bad-pos 4s linear infinite; }',
    '.b { animation: var(--flow) 2s infinite, ok-once 1s; }',
    '.c { animation-name: bad-size, ok-spin; animation-iteration-count: infinite; }',
    '.d { animation: ok-once 1s ease; will-change: transform, filter; }',
    '.e { will-change: background-position; }',
    '@keyframes bad-pos { to { background-position: 24px 0; } }',
    '@keyframes bad-flow { 50% { opacity: .5; filter: blur(2px); } }',
    '@keyframes bad-size { to { background-size: 10px; } }',
    '@keyframes ok-spin { from { transform: rotate(0); animation-timing-function: ease; } to { transform: rotate(1turn); } }',
    '@keyframes ok-once { to { box-shadow: 0 0 0 3px red; } }',
    '/* motion-lint: allow 測試用的例外 */',
    '@keyframes allowed { to { background-position: 1px 0; } }',
    '.f { animation: allowed 1s infinite; }',
    '/* motion-lint: allow */',
    '@keyframes no-reason { to { opacity: 0; } }',
    '.g { animation: no-reason 1s infinite; }',
  ].join('\n');
  const { problems, infinite } = lintMotion([{ name: 'x.css', text: css }]);
  assert.deepEqual([...infinite].sort(), ['allowed', 'bad-flow', 'bad-pos', 'bad-size', 'no-reason', 'ok-spin']);
  const lines = problems.map(p => p.split('  ')[0]);
  assert.deepEqual(lines.sort(), ['x.css:16', 'x.css:5', 'x.css:6', 'x.css:7', 'x.css:8', 'x.css:9'].sort(), problems.join('\n'));
  assert.ok(problems.some(p => p.includes('bad-pos') && p.includes('background-position')));
  assert.ok(problems.some(p => p.includes('bad-flow') && p.includes('filter')));
  assert.ok(problems.some(p => p.includes('沒有寫原因')));
});

test('動畫守門：在真實樣式表裡加一個動 background-position 的無限動畫會被擋下', () => {
  const files = manifestStyles();
  files.push({ name: 'injected.css', text: '.oops { animation: oops-shimmer 2s linear infinite; }\n@keyframes oops-shimmer {\n  to { background-position: 100% 0; }\n}\n' });
  const { problems } = lintMotion(files);
  assert.equal(problems.length, 1, problems.join('\n'));
  assert.match(problems[0], /^injected\.css:3 .*oops-shimmer.*background-position/);
});
