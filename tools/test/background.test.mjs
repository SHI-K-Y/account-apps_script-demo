// 整頁背景光暈（P01）：canvas 繪製的位置、緩動與亮度要和原本的 CSS 動畫公式一致；
// 舊的重繪型動畫不能回來；不支援相對色彩語法時的後備色票要和 --exp／--inc 算出來的結果一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT } from './helpers.mjs';

const CLIENT = path.join(ROOT, 'src', 'client');
const read = rel => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

/** vm 內建立的陣列原型不同，deepStrictEqual 前先轉成本地物件 */
const plain = v => JSON.parse(JSON.stringify(v));

function loadCore() {
  const ctx = {};
  vm.runInNewContext(read('scripts/core/background.js') + '\nthis.BgGlow = BgGlow;', ctx);
  return ctx.BgGlow.core;
}

/** 參考實作：直接用二分法解 cubic-bezier(.42,0,.58,1)，和 core 的牛頓法互相驗證。 */
function refEase(x) {
  const bx = t => 3 * 0.42 * t * (1 - t) ** 2 + 3 * 0.58 * t * t * (1 - t) + t ** 3;
  const by = t => 3 * t * t * (1 - t) + t ** 3;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i++) { const m = (lo + hi) / 2; if (bx(m) < x) lo = m; else hi = m; }
  return by((lo + hi) / 2);
}

test('背景呼吸：與 CSS「6s ease-in-out infinite alternate」相同', () => {
  const core = loadCore();
  for (let x = 0; x <= 1; x += 0.05) assert.ok(Math.abs(core.easeInOut(x) - refEase(x)) < 1e-5, 'ease(' + x + ')');
  assert.equal(core.breathe(0), 0);
  assert.equal(core.breathe(6000), 1);
  assert.equal(core.breathe(12000), 0);
  assert.ok(Math.abs(core.breathe(3000) - 0.5) < 1e-6);
  // alternate：奇數圈反向，緩動套在反向之後
  assert.ok(Math.abs(core.breathe(7500) - refEase(0.75)) < 1e-5);
  assert.ok(Math.abs(core.breathe(13500) - refEase(0.25)) < 1e-5);
  assert.equal(core.breathe(-500), 0);
});

test('漂移光暈：位置公式與原本 background-position 動畫相同', () => {
  const core = loadCore();
  const FROM = [[8, 4], [10, -4], [-12, -6], [-6, 8]];
  assert.deepEqual(plain(core.LAYERS.map(l => l.from)), FROM, '起點與 CSS 的 800% 400%、1000% -400%、-1200% -600%、-600% 800% 相同');
  assert.deepEqual(plain(core.LAYERS.map(l => l.ellipse)), [false, false, false, true]);
  assert.equal(core.DRIFT_MS, 40000);
  assert.equal(core.STOP, 0.6);
  const W = 390;
  const H = 844;
  for (const t of [0, 1234, 10000, 20000, 30000, 39999, 40000, 123456]) {
    core.LAYERS.forEach((layer, i) => {
      // CSS：p 從起點線性變到 0；位移 = (容器 − 2 倍容器) × p = −容器 × p
      const u = (t % 40000) / 40000;
      const px = FROM[i][0] * (1 - u);
      const py = FROM[i][1] * (1 - u);
      const tiles = core.tiles(layer, t, W, H);
      assert.ok(tiles.length >= 1 && tiles.length <= 4);
      for (const [x, y] of tiles) {
        // 每個圖塊都是原本位移加上整數個週期（2W、2H）
        const nx = (x - (-W * px)) / (2 * W);
        const ny = (y - (-H * py)) / (2 * H);
        assert.ok(Math.abs(nx - Math.round(nx)) < 1e-9 && Math.abs(ny - Math.round(ny)) < 1e-9, 't=' + t + ' 第 ' + (i + 1) + ' 層');
      }
      // 圖塊要完整蓋住容器
      for (const [qx, qy] of [[0, 0], [W - 0.01, 0], [0, H - 0.01], [W - 0.01, H - 0.01], [W / 2, H / 2]]) {
        assert.ok(tiles.some(([x, y]) => qx >= x && qx < x + 2 * W && qy >= y && qy < y + 2 * H), '沒有蓋到 (' + qx + ',' + qy + ')');
      }
    });
  }
  // 靜態畫面（減少動態效果）：0% 0%
  core.LAYERS.forEach(layer => assert.deepEqual(plain(core.tiles(layer, null, W, H)), [[0, 0]]));
});

test('原本會重繪整頁的背景動畫已移除，改成只動 opacity', () => {
  const full = read('styles/02-background-header.css');
  const bgCss = full.slice(0, full.indexOf('\nbutton, input, select, textarea'));
  assert.ok(bgCss.length > 100);
  assert.doesNotMatch(bgCss, /@keyframes\s+uv-glow-(breathe|drift)/);
  assert.doesNotMatch(bgCss, /will-change/);
  const kf = bgCss.match(/@keyframes\s+uv-bg-breathe-fade\s*\{([\s\S]*?)\n\}/);
  assert.ok(kf, '缺少 uv-bg-breathe-fade');
  assert.deepEqual([...new Set(kf[1].match(/[a-z-]+(?=\s*:)/g))], ['opacity']);
  assert.match(bgCss, /contain:\s*strict/);
  const ambient = read('scripts/core/ambient.js');
  assert.doesNotMatch(ambient, /'uv-glow-(breathe|drift)'/);
  assert.match(read('partials/boot-loader.html'), /class="uv-glow-bg"[^>]*>\s*<canvas class="uv-glow-canvas"/);
  const manifest = JSON.parse(read('manifest.json'));
  assert.ok(manifest.scripts.includes('core/background.js'));
});

/* ---------- 後備色票：用 oklab 的 color-mix 規則從 --exp／--inc 重新計算 ---------- */
const toLin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const toGam = c => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
function srgbToOklab([r, g, b]) {
  const [R, G, B] = [r, g, b].map(toLin);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return [0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s];
}
function oklabToSrgb([L, a, b]) {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s, -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s, -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map(toGam);
}
const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16) / 255);

/** 迷你求值器：只支援這幾個色標會用到的 #hex、var(--x)、color-mix(in oklab, A p%, B)。 */
function evalColor(expr, vars) {
  expr = expr.trim();
  if (expr.startsWith('#')) return hex(expr);
  const v = expr.match(/^var\((--[\w-]+)\)$/);
  if (v) { assert.ok(vars[v[1]], '找不到 ' + v[1]); return evalColor(vars[v[1]], vars); }
  const mix = expr.match(/^color-mix\(in oklab,\s*(.+?)\s+([\d.]+)%,\s*(.+)\)$/);
  assert.ok(mix, '不支援的色彩運算式：' + expr);
  const p = Number(mix[2]) / 100;
  const A = srgbToOklab(evalColor(mix[1], vars));
  const B = srgbToOklab(evalColor(mix[3], vars));
  return oklabToSrgb(A.map((x, i) => x * p + B[i] * (1 - p)));
}
function declarations(block) {
  const out = {};
  for (const m of block.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

test('後備色票與 --exp／--inc 計算結果一致（改了顏色要重新產生）', () => {
  const css = read('styles/01-tokens-base.css');
  const exps = [...css.matchAll(/^\s*--exp:\s*(#[0-9a-f]{6});/gmi)].map(m => m[1].toLowerCase());
  const incs = [...css.matchAll(/^\s*--inc:\s*(#[0-9a-f]{6});/gmi)].map(m => m[1].toLowerCase());
  assert.ok(exps.length && new Set(exps).size === 1, '--exp 在淺色、深色應相同');
  assert.ok(incs.length && new Set(incs).size === 1, '--inc 在淺色、深色應相同');
  const lightStart = css.indexOf('  --uv-bg-base: var(--bg-base);');
  const darkStart = css.indexOf('  --uv-bg-base: #000;');
  assert.ok(lightStart > 0 && darkStart > lightStart);
  const light = declarations(css.slice(lightStart, css.indexOf('\n}', lightStart)));
  const dark = Object.assign({}, light, declarations(css.slice(darkStart, css.indexOf('\n}', darkStart))));
  for (const [name, vars] of [['淺色', light], ['深色', dark]]) {
    vars['--exp'] = exps[0];
    vars['--inc'] = incs[0];
    const num = n => Number(vars[n].replace(/^var\((--[\w-]+)\)$/, (_, r) => vars[r]));
    const gain = num('--uv-bg-gain');
    const k = { lo: num('--uv-bg-breathe-min') / gain, hi: num('--uv-bg-breathe-max') / gain };
    for (const tag of ['lo', 'hi']) {
      for (let i = 1; i <= 7; i++) {
        const want = evalColor('var(--uv-rad-s' + i + ')', vars).map(c => Math.min(1, c * k[tag]));
        const got = (vars['--uv-rad-' + tag + '-' + i] || '').match(/^color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)\)$/);
        assert.ok(got, name + ' 缺少 --uv-rad-' + tag + '-' + i);
        got.slice(1).map(Number).forEach((c, j) => {
          assert.ok(Math.abs(c - want[j]) < 0.003, name + ' --uv-rad-' + tag + '-' + i + ' 第 ' + (j + 1) + ' 通道：' + c + ' ≠ ' + want[j].toFixed(4));
        });
      }
    }
  }
});
