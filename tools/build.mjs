#!/usr/bin/env node
// 建置腳本：把 src/ 的模組組合成 dist/ 內可直接部署到 Apps Script 的檔案。
//
//   node tools/build.mjs               正式建置（壓縮 CSS / JS）
//   node tools/build.mjs --no-minify   不壓縮（除錯用，dist 內容可直接閱讀）
//   node tools/build.mjs --watch       監看 src/，有變更就重新建置
//   node tools/build.mjs --serve       建置後啟動本機預覽（等同 npm run dev）
//
// 產出（dist/）：
//   code.gs          後端：src/server/*.gs 依檔名順序串接
//   Index.html       頁面骨架：src/client/index.html + 各 partial
//   style.html       樣式：manifest.json 的 styles 依序串接
//   app.html         前端程式：manifest.json 的 scripts 依序串接
//   assets.html      圖示對照表與內嵌圖片
//   appsscript.json  Apps Script 專案設定
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const CLIENT = path.join(SRC, 'client');
const SERVER = path.join(SRC, 'server');

const args = new Set(process.argv.slice(2));
const MINIFY = !args.has('--no-minify');
const QUIET = args.has('--quiet');
const log = (...a) => { if (!QUIET) console.log(...a); };

const read = file => fs.readFileSync(file, 'utf8');
const stripTrailingNewlines = text => text.replace(/\n+$/, '');

async function loadEsbuild() {
  try {
    return await import('esbuild');
  } catch (e) {
    throw new Error('找不到 esbuild，請先在專案根目錄執行 npm install（或改用 --no-minify 建置）。');
  }
}

/** 把 <!-- @include 相對路徑 --> 換成檔案內容（可巢狀），保留原本的縮排層級。 */
function resolveIncludes(file, seen = []) {
  if (seen.includes(file)) throw new Error('@include 循環引用：' + seen.concat(file).join(' → '));
  const dir = path.dirname(file);
  return read(file).replace(/^[ \t]*<!-- @include ([^\s]+) -->[ \t]*$/gm, (_, rel) => {
    const target = path.join(dir, rel);
    if (!fs.existsSync(target)) throw new Error(path.relative(ROOT, file) + ' 引用了不存在的檔案：' + rel);
    return stripTrailingNewlines(resolveIncludes(target, seen.concat(file)));
  });
}

function concat(dir, names, label) {
  return names.map(name => {
    const file = path.join(dir, name);
    if (!fs.existsSync(file)) throw new Error('manifest.json 的 ' + label + ' 列了不存在的檔案：' + name);
    return stripTrailingNewlines(read(file));
  }).join('\n\n') + '\n';
}

/** manifest 沒列到的檔案不會被打包；提早警告，避免新增模組後忘了登記。 */
function warnUnlisted(dir, listed, ext) {
  const found = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(entry => {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(ext)) found.push(path.relative(dir, full).split(path.sep).join('/'));
    });
  })(dir);
  const missing = found.filter(f => !listed.includes(f));
  if (missing.length) console.warn('⚠ 以下檔案沒有列在 src/client/manifest.json，不會被打包：\n  ' + missing.join('\n  '));
}

const PHOSPHOR_VERSION = '2.1.1';
const PHOSPHOR_DIR = path.join(ROOT, 'tools', 'vendor', 'phosphor-icons-web-' + PHOSPHOR_VERSION);
const PHOSPHOR_CDN = 'https://unpkg.com/@phosphor-icons/web@' + PHOSPHOR_VERSION + '/src/';
const PHOSPHOR_WEIGHTS = [
  { dir: 'regular', file: 'regular.css', font: 'Phosphor', family: 'Phosphor', baseClass: 'ph' },
  { dir: 'fill', file: 'fill.css', font: 'Phosphor-Fill', family: 'Phosphor-Fill', baseClass: 'ph-fill' },
];

function walkFiles(dir, exts, out = []) {
  fs.readdirSync(dir, { withFileTypes: true }).forEach(entry => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, exts, out);
    else if (exts.some(ext => entry.name.endsWith(ext))) out.push(full);
  });
  return out;
}

/**
 * 圖示子集：完整的 Phosphor 樣式表有 1500 多個圖示、兩種粗細共 160 KB，而且會擋住首次繪製。
 * 這裡掃描原始碼裡出現過的圖示名稱（寧可多抓也不漏抓），只輸出用得到的規則並直接內嵌到 <head>。
 * 萬一執行時遇到子集以外的圖示（例如舊資料存了已不在清單內的圖示），
 * 前端的 IconFont.ensure() 會自動補載完整樣式表，不會出現空白圖示。
 */
function buildIconSubset() {
  const haystack = walkFiles(SRC, ['.html', '.js', '.gs']).map(read).join('\n');
  const words = new Set(haystack.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g) || []);
  let css = '';
  let count = 0;
  PHOSPHOR_WEIGHTS.forEach(weight => {
    const file = path.join(PHOSPHOR_DIR, weight.file);
    if (!fs.existsSync(file)) throw new Error('找不到圖示樣式表：' + path.relative(ROOT, file));
    const source = read(file);
    const base = source.match(new RegExp('\\.' + weight.baseClass + '\\s*\\{[^}]*\\}'));
    if (!base) throw new Error('無法解析圖示樣式表：' + weight.file);
    const fontUrl = PHOSPHOR_CDN + weight.dir + '/' + weight.font;
    css += '@font-face{font-family:"' + weight.family + '";src:url("' + fontUrl + '.woff2") format("woff2"),url("' + fontUrl +
      '.woff") format("woff"),url("' + fontUrl + '.ttf") format("truetype");font-weight:normal;font-style:normal;font-display:block}\n';
    css += base[0].replace(/\/\*[\s\S]*?\*\//g, '') + '\n';
    const ruleRe = new RegExp('\\.' + weight.baseClass + '\\.ph-([a-z0-9-]+):before\\s*\\{\\s*content:\\s*("[^"]*");?\\s*\\}', 'g');
    let m;
    let total = 0;
    while ((m = ruleRe.exec(source))) {
      total++;
      if (!words.has(m[1])) continue;
      css += '.' + weight.baseClass + '.ph-' + m[1] + ':before{content:' + m[2] + '}\n';
      count++;
    }
    if (total < 1000) throw new Error('圖示樣式表內容不完整：' + weight.file + '（只解析到 ' + total + ' 個圖示）');
  });
  return { css, count };
}

function size(text) {
  const bytes = Buffer.byteLength(text, 'utf8');
  const gz = zlib.gzipSync(text, { level: 9 }).length;
  return { bytes, gz };
}
const kb = n => (n / 1024).toFixed(1).padStart(7) + ' KB';

/**
 * 建置一次。
 * @param {object} [opts]
 *   minify  是否壓縮（預設依命令列的 --no-minify）
 *   write   false 表示只回傳內容、不寫入 dist/（Demo 建置用，避免動到部署用的檔案）
 *   quiet   true 表示不輸出建置摘要
 */
export async function build(opts) {
  const options = opts || {};
  const minify = options.minify === undefined ? MINIFY : Boolean(options.minify);
  const write = options.write !== false;
  const say = options.quiet ? () => {} : log;
  const started = Date.now();
  const manifest = JSON.parse(read(path.join(CLIENT, 'manifest.json')));
  warnUnlisted(path.join(CLIENT, 'styles'), manifest.styles, '.css');
  warnUnlisted(path.join(CLIENT, 'scripts'), manifest.scripts, '.js');

  let css = concat(path.join(CLIENT, 'styles'), manifest.styles, 'styles');
  let js = concat(path.join(CLIENT, 'scripts'), manifest.scripts, 'scripts');
  const assets = stripTrailingNewlines(read(path.join(CLIENT, 'assets', 'assets.js'))) + '\n';
  let html = resolveIncludes(path.join(CLIENT, 'index.html'));

  const icons = buildIconSubset();
  let iconCss = icons.css;

  if (minify) {
    const esbuild = await loadEsbuild();
    iconCss = (await esbuild.transform(iconCss, { loader: 'css', minify: true, charset: 'utf8', legalComments: 'none' })).code;
    // 不改寫語法（target: esnext）、不改頂層名稱（未指定 format 時 esbuild 會保留全域宣告），
    // 只移除空白與註解、縮短區域變數名稱。
    const jsOut = await esbuild.transform(js, { loader: 'js', minify: true, target: 'esnext', charset: 'utf8', legalComments: 'none' });
    const cssOut = await esbuild.transform(css, { loader: 'css', minify: true, target: 'esnext', charset: 'utf8', legalComments: 'none' });
    jsOut.warnings.concat(cssOut.warnings).forEach(w => console.warn('⚠ esbuild：' + w.text));
    js = jsOut.code;
    css = cssOut.code;
  }

  if (!/<!-- @icons -->/.test(html)) throw new Error('index.html（或其 partial）缺少 <!-- @icons --> 標記，無法內嵌圖示樣式。');
  html = html.replace(/^([ \t]*)<!-- @icons -->/m, (_, indent) =>
    indent + '<style id="phosphorSubset" data-cdn="' + PHOSPHOR_CDN + '">\n' + stripTrailingNewlines(iconCss) + '\n' + indent + '</style>');

  // 內嵌在 HTML 裡的 CSS / JS 不能含有會提前結束標籤的字串。
  if (/<\/style/i.test(css)) throw new Error('樣式內容含有 </style，會破壞頁面結構。');
  if (/<\/script/i.test(js)) throw new Error('前端程式含有 </script（請改寫成 "<\\/script"）。');
  if (/<\/script/i.test(assets)) throw new Error('assets.js 含有 </script。');

  const serverFiles = fs.readdirSync(SERVER).filter(f => f.endsWith('.gs')).sort();
  const server = serverFiles.map(f => '// ───── ' + f + ' ─────\n' + stripTrailingNewlines(read(path.join(SERVER, f)))).join('\n\n') + '\n';

  const outputs = {
    'code.gs': server,
    'Index.html': html,
    'style.html': '<style>\n' + css + '</style>\n',
    'app.html': '<script>\n' + js + '</script>\n',
    'assets.html': '<script>\n' + assets + '</script>\n',
    'appsscript.json': read(path.join(SRC, 'appsscript.json')),
  };

  if (write) {
    fs.mkdirSync(DIST, { recursive: true });
    // 清掉舊的產出，避免殘留已不存在的檔案被推送到 Apps Script。
    fs.readdirSync(DIST).forEach(name => {
      if (!Object.prototype.hasOwnProperty.call(outputs, name) && /\.(gs|html|json)$/.test(name)) fs.unlinkSync(path.join(DIST, name));
    });
  }
  let total = { bytes: 0, gz: 0 };
  const rows = [];
  Object.keys(outputs).forEach(name => {
    const file = path.join(DIST, name);
    if (write && (!fs.existsSync(file) || read(file) !== outputs[name])) fs.writeFileSync(file, outputs[name]);
    const s = size(outputs[name]);
    if (name.endsWith('.html')) { total.bytes += s.bytes; total.gz += s.gz; }
    rows.push('  ' + name.padEnd(16) + kb(s.bytes) + '   gzip ' + kb(s.gz));
  });

  say((write ? 'dist/ 建置完成' : '建置完成（未寫入 dist/）') + '（' + (minify ? '已壓縮' : '未壓縮') + '，' + (Date.now() - started) + ' ms）');
  rows.forEach(r => say(r));
  say('  內嵌圖示 ' + (icons.count / PHOSPHOR_WEIGHTS.length) + ' 個（每種粗細）');
  say('  ' + '頁面合計'.padEnd(12) + kb(total.bytes) + '   gzip ' + kb(total.gz));
  return { outputs, total };
}

async function main() {
  await build();

  if (args.has('--watch')) {
    let timer = null;
    let running = false;
    const trigger = () => {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        if (running) return trigger();
        running = true;
        try { await build(); } catch (e) { console.error('建置失敗：' + e.message); }
        running = false;
      }, 120);
    };
    fs.watch(SRC, { recursive: true }, trigger);
    log('監看 src/ 中，存檔後會自動重新建置…');
  }

  if (args.has('--serve')) {
    const { createDevApp } = await import('./dev-server.mjs');
    const portArg = process.argv.indexOf('--port');
    const port = portArg > -1 ? Number(process.argv[portArg + 1]) : 8080;
    const app = createDevApp({ root: DIST });
    app.server.listen(port, () => {
      log('記帳簿本機預覽：http://localhost:' + port + '（資料來自 ' + app.dataLabel + '，只在記憶體中修改）');
    });
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error('建置失敗：' + e.message); process.exit(1); });
}
