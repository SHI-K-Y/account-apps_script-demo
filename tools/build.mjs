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
//   app.html         前端程式：manifest.json 的 scripts（開機必要）依序串接成 <script>；
//                    deferredScripts（首頁用不到的頁面、圖表）串接成 <script type="text/plain" id="deferredApp">，
//                    瀏覽器不會解析，開機完成後由 core/deferred.js 執行（見該檔說明）。
//                    開機程式的最後一行（app/start.js）就開始畫首屏，不等後面的延後程式與 assets.html 下載完（P08）
//   assets.html      內嵌圖片（預設卡面、銀行 logo、App 圖示），排在頁面最後；預設選項與圖示對照在 scripts/core/item-defaults.js
//   appsscript.json  Apps Script 專案設定
//
// 範本模式（P09 的 A/B 量測）：
//   --template include（預設，A）  Index.html 用 <?!= include('style') ?> 等在 doGet 時讀入其他三個檔案
//   --template inline（B）         建置時就把 style／app／assets 展開進 Index.html，範本只剩啟動資料與網址兩個 scriptlet
//   兩種模式都照樣產出 style／app／assets.html（setupAppIcon 讀 assets、include() 也還能用）。
//   部署後網址加 ?timing=1 開頁，到 Apps Script「執行項目」看 [doGet] 紀錄的 templateMs／totalMs 比較。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src');
const DIST = path.join(ROOT, 'dist');
const CLIENT = path.join(SRC, 'client');
const SERVER = path.join(SRC, 'server');

const args = new Set(process.argv.slice(2));
const MINIFY = !args.has('--no-minify');
const TEMPLATE_MODES = ['include', 'inline'];
const templateArg = process.argv.indexOf('--template');
const TEMPLATE_MODE = templateArg > -1 ? process.argv[templateArg + 1] : (process.env.BUILD_TEMPLATE || 'include');
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

/**
 * 樣式分層（P07）：manifest.json 的 styleLayers 指定每個 CSS 檔放進哪一個 @layer，建置時整個檔案包進 @layer 名稱 { … }。
 * 層的先後（layerOrder）在 partials/head.html 第一個 <style> 開頭宣告；排在後面的層一律蓋過前面的層，跟選擇器權重無關，
 * 所以不用再靠 :root:root:root 或 !important 疊權重。@property 是全域規則，搬到層外面。
 */
function layered(dir, names, layers, order) {
  return names.map(name => {
    const layer = layers[name];
    if (!layer) throw new Error('manifest.json 的 styleLayers 沒有指定 ' + name + ' 的層');
    if (!order.includes(layer)) throw new Error('manifest.json 的 styleLayers 用了沒有宣告的層：' + layer + '（' + name + '）');
    let text = stripTrailingNewlines(read(path.join(dir, name)));
    const hoisted = [];
    text = text.replace(/@property\s+--[\w-]+\s*\{[^{}]*\}/g, m => { hoisted.push(m); return ''; });
    return (hoisted.length ? hoisted.join('\n') + '\n' : '') + '@layer ' + layer + ' {\n' + text + '\n}';
  }).join('\n\n') + '\n';
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
 * 圖示子集：完整的 Phosphor 樣式表有 1500 多個圖示、兩種粗細共 160 KB，字型檔各 130–150 KB。
 * 這裡掃描原始碼裡出現過的圖示名稱（寧可多抓也不漏抓），只輸出用得到的規則，
 * 並用 subset-font 把字型裁成只含這些字元的 woff2，以 data URI 內嵌（不再依賴 unpkg，也不會因為網路慢而空白）。
 * 粗細：只有原始碼裡真的用到 fill（ph-fill class、iconHtml(…, 'fill')、或 CSS 用 "Phosphor-Fill" 字型）時才輸出 fill。
 * 萬一執行時遇到子集以外的圖示（例如舊資料存了已不在清單內的圖示），
 * 前端的 IconFont.ensure() 會自動補載完整樣式表（unpkg），不會出現空白圖示。
 * @font-face 帶 unicode-range：補載的完整字型只會用在子集以外的字元，子集內的圖示不會因為補載而重新等待字型。
 */
const fontSubsetCache = new Map();

async function subsetFontFile(weight, codepoints) {
  // 用 Node 的模組解析找字型檔（Demo 同步的暫存資料夾沒有自己的 node_modules，會往上層找）
  let file;
  try {
    file = createRequire(import.meta.url).resolve('@phosphor-icons/web/' + weight.dir + '/' + weight.font + '.woff2');
  } catch (e) {
    throw new Error('找不到圖示字型 @phosphor-icons/web/' + weight.dir + '/' + weight.font + '.woff2（請先執行 npm install）');
  }
  const pkg = JSON.parse(read(path.resolve(path.dirname(file), '..', '..', 'package.json')));
  if (pkg.version !== PHOSPHOR_VERSION) {
    throw new Error('@phosphor-icons/web 版本是 ' + pkg.version + '，與 tools/vendor 的樣式表（' + PHOSPHOR_VERSION + '）不同，字元編號會對不上');
  }
  const key = weight.dir + ':' + codepoints.join(',');
  if (fontSubsetCache.has(key)) return fontSubsetCache.get(key);
  let subsetFont;
  try {
    subsetFont = (await import('subset-font')).default;
  } catch (e) {
    throw new Error('找不到 subset-font，請先在專案根目錄執行 npm install。');
  }
  const out = await subsetFont(fs.readFileSync(file), codepoints.map(cp => String.fromCodePoint(cp)).join(''), { targetFormat: 'woff2' });
  fontSubsetCache.set(key, out);
  return out;
}

/** 把一串 codepoint 壓成 unicode-range（連續的合併成區間）。 */
function unicodeRange(codepoints) {
  const sorted = Array.from(new Set(codepoints)).sort((a, b) => a - b);
  const parts = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const hex = n => n.toString(16).toUpperCase();
    parts.push('U+' + hex(sorted[i]) + (j > i ? '-' + hex(sorted[j]) : ''));
    i = j;
  }
  return parts.join(',');
}

async function buildIconSubset() {
  const sources = walkFiles(SRC, ['.html', '.js', '.gs']).map(file => ({ file, text: read(file) }));
  const haystack = sources.map(s => s.text).join('\n');
  const words = new Set(haystack.match(/[a-z][a-z0-9]*(?:-[a-z0-9]+)*/g) || []);
  // fill 粗細：除了 core/icons.js（產生 class 的地方）之外，有沒有任何地方用到——包括 CSS 直接把 font-family
  // 換成 "Phosphor-Fill"（選取中的選項、導覽列目前頁面的圖示等，見 19-glass-components.css 的 --font-icon-fill）
  const iconsJs = path.join(CLIENT, 'scripts', 'core', 'icons.js');
  const styleText = walkFiles(path.join(CLIENT, 'styles'), ['.css']).map(read).join('\n');
  const usesFill = /Phosphor-Fill/.test(styleText) ||
    sources.some(s => s.file !== iconsJs && /\bph-fill\b|['"]fill['"]/.test(s.text));
  let faces = '';
  let css = '';
  let count = 0;
  const weights = [];
  for (const weight of PHOSPHOR_WEIGHTS) {
    if (weight.baseClass === 'ph-fill' && !usesFill) continue;
    const file = path.join(PHOSPHOR_DIR, weight.file);
    if (!fs.existsSync(file)) throw new Error('找不到圖示樣式表：' + path.relative(ROOT, file));
    const source = read(file);
    const base = source.match(new RegExp('\\.' + weight.baseClass + '\\s*\\{[^}]*\\}'));
    if (!base) throw new Error('無法解析圖示樣式表：' + weight.file);
    const ruleRe = new RegExp('\\.' + weight.baseClass + '\\.ph-([a-z0-9-]+):before\\s*\\{\\s*content:\\s*"\\\\([0-9a-f]+)";?\\s*\\}', 'g');
    let m;
    let total = 0;
    const rules = [];
    const codepoints = [];
    while ((m = ruleRe.exec(source))) {
      total++;
      if (!words.has(m[1])) continue;
      rules.push('.' + weight.baseClass + '.ph-' + m[1] + ':before{content:"\\' + m[2] + '"}');
      codepoints.push(parseInt(m[2], 16));
    }
    if (total < 1000) throw new Error('圖示樣式表內容不完整：' + weight.file + '（只解析到 ' + total + ' 個圖示）');
    // unicode-range 一定要包含 U+0020（空白）：CSS 用「range 含空白的第一個字型」當行高與基線的依據（first available font），
    // 少了它，圖示所在的行會改用後備字型的行高，基線位移 1px。
    codepoints.unshift(0x20);
    const font = await subsetFontFile(weight, codepoints);
    faces += '@font-face{font-family:"' + weight.family + '";src:url(data:font/woff2;base64,' + font.toString('base64') +
      ') format("woff2");font-weight:normal;font-style:normal;font-display:block;unicode-range:' + unicodeRange(codepoints) + '}\n';
    // 原始樣式表的 font-family 帶 !important（防止瀏覽器擴充套件換字型）。放進前面的層之後，
    // 前面層的 !important 反而會贏過主樣式表自己的 !important（例如選取中改用 fill 字型），所以拿掉。
    css += base[0].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s*!important/g, '') + '\n' + rules.join('\n') + '\n';
    count += rules.length;
    weights.push({ name: weight.dir, icons: rules.length, fontBytes: font.length });
  }
  // 字型宣告是全域的，放在層外；規則放進 icons 層（排在開機畫面之後、主樣式表之前）
  return { css: faces + '@layer icons {\n' + css + '}\n', count, weights };
}

/**
 * 範本模式 B：把 Index.html 裡的 <?!= include('名稱') ?> 換成檔案內容。展開的內容不能含有 <? 或 ?>，
 * 否則 Apps Script 會把它當成 scriptlet 執行。取代值用函式回傳，避免內容裡的 $ 被當成特殊符號。
 */
function inlineIncludes(html, outputs) {
  let count = 0;
  const out = html.replace(/<\?!=\s*include\('([A-Za-z]+)'\)\s*\?>/g, (_, name) => {
    const content = outputs[name + '.html'];
    if (content == null) throw new Error('Index.html 引用了不存在的檔案：' + name);
    if (/<\?|\?>/.test(content)) throw new Error(name + '.html 含有 <? 或 ?>，不能展開進範本（會被當成 scriptlet）');
    count++;
    return content;   // 與 include() 回傳的內容完全相同（含結尾換行），兩種模式產生的頁面一模一樣
  });
  if (count !== 3) throw new Error('範本模式 inline：預期展開 3 個 include，實際 ' + count + ' 個');
  const left = (out.match(/<\?[\s\S]*?\?>/g) || []).length;
  if (left !== 2) throw new Error('範本模式 inline：應該只剩啟動資料與網址兩個 scriptlet，實際 ' + left + ' 個');
  return out;
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
  const templateMode = options.template || TEMPLATE_MODE;
  if (!TEMPLATE_MODES.includes(templateMode)) throw new Error('不認得的範本模式：' + templateMode + '（可用 ' + TEMPLATE_MODES.join('、') + '）');
  const say = options.quiet ? () => {} : log;
  const started = Date.now();
  const manifest = JSON.parse(read(path.join(CLIENT, 'manifest.json')));
  warnUnlisted(path.join(CLIENT, 'styles'), manifest.styles, '.css');
  const deferredNames = manifest.deferredScripts || [];
  warnUnlisted(path.join(CLIENT, 'scripts'), manifest.scripts.concat(deferredNames), '.js');
  const dup = manifest.scripts.filter(n => deferredNames.includes(n));
  if (dup.length) throw new Error('manifest.json 的 scripts 與 deferredScripts 重複列出：' + dup.join('、'));

  manifest.styles.forEach(name => { if (!fs.existsSync(path.join(CLIENT, 'styles', name))) throw new Error('manifest.json 的 styles 列了不存在的檔案：' + name); });
  const layerOrder = manifest.layerOrder || [];
  let css = layered(path.join(CLIENT, 'styles'), manifest.styles, manifest.styleLayers || {}, layerOrder);
  let js = concat(path.join(CLIENT, 'scripts'), manifest.scripts, 'scripts');
  let deferredJs = deferredNames.length ? concat(path.join(CLIENT, 'scripts'), deferredNames, 'deferredScripts') : '';
  const assets = stripTrailingNewlines(read(path.join(CLIENT, 'assets', 'assets.js'))) + '\n';
  let html = resolveIncludes(path.join(CLIENT, 'index.html'));
  const declared = (html.match(/<style[^>]*>(?:\s|\/\*[\s\S]*?\*\/)*@layer\s+([\w\s,-]+);/) || [])[1];
  if (!declared || declared.split(',').map(x => x.trim()).join(',') !== layerOrder.join(',')) {
    throw new Error('partials/head.html 第一個 <style> 開頭的 @layer 順序必須與 manifest.json 的 layerOrder 相同（' + layerOrder.join(', ') + '）');
  }

  const icons = await buildIconSubset();
  let iconCss = icons.css;

  if (minify) {
    const esbuild = await loadEsbuild();
    iconCss = (await esbuild.transform(iconCss, { loader: 'css', minify: true, charset: 'utf8', legalComments: 'none' })).code;
    // 不改寫語法（target: esnext）、不改頂層名稱（未指定 format 時 esbuild 會保留全域宣告），
    // 只移除空白與註解、縮短區域變數名稱。
    // 開機必要與延後的兩段分開壓縮：兩段是不同的 <script>，頂層名稱照樣是共用的全域名稱。
    const jsOpts = { loader: 'js', minify: true, target: 'esnext', charset: 'utf8', legalComments: 'none' };
    const jsOut = await esbuild.transform(js, jsOpts);
    const deferredOut = deferredJs ? await esbuild.transform(deferredJs, jsOpts) : { code: '', warnings: [] };
    const cssOut = await esbuild.transform(css, { loader: 'css', minify: true, target: 'esnext', charset: 'utf8', legalComments: 'none' });
    jsOut.warnings.concat(deferredOut.warnings, cssOut.warnings).forEach(w => console.warn('⚠ esbuild：' + w.text));
    js = jsOut.code;
    deferredJs = deferredOut.code;
    css = cssOut.code;
  }

  if (!/<!-- @icons -->/.test(html)) throw new Error('index.html（或其 partial）缺少 <!-- @icons --> 標記，無法內嵌圖示樣式。');
  html = html.replace(/^([ \t]*)<!-- @icons -->/m, (_, indent) =>
    indent + '<style id="phosphorSubset" data-cdn="' + PHOSPHOR_CDN + '">\n' + stripTrailingNewlines(iconCss) + '\n' + indent + '</style>');

  // 內嵌在 HTML 裡的 CSS / JS 不能含有會提前結束標籤的字串。
  if (/<\/style/i.test(css)) throw new Error('樣式內容含有 </style，會破壞頁面結構。');
  if (/<\/script/i.test(js + deferredJs)) throw new Error('前端程式含有 </script（請改寫成 "<\\/script"）。');
  // type="text/plain" 的內容一樣由 HTML 解析器切出來：「<!--」接「<script」會讓解析器進入 escaped 狀態而吃掉後面的內容
  if (/<!--/.test(js + deferredJs)) throw new Error('前端程式含有 <!--（請拆開字串，例如 "<!" + "--"）。');
  if (/<\/script/i.test(assets)) throw new Error('assets.js 含有 </script。');

  const serverFiles = fs.readdirSync(SERVER).filter(f => f.endsWith('.gs')).sort();
  const server = serverFiles.map(f => '// ───── ' + f + ' ─────\n' + stripTrailingNewlines(read(path.join(SERVER, f)))).join('\n\n') + '\n' +
    '\n// ───── 建置資訊（tools/build.mjs 產生）─────\nconst BUILD_TEMPLATE_MODE_ = ' + JSON.stringify(templateMode) + ';\n';

  const outputs = {
    'code.gs': server,
    'Index.html': html,
    'style.html': '<style>\n' + css + '</style>\n',
    // 延後的部分緊接在開機程式後面：開機程式可以在它還在下載時就先編譯、執行；它本身不會被解析，
    // 開機完成後由 DeferredApp（core/deferred.js）執行。
    'app.html': '<script>\n' + js + '</script>\n' +
      (deferredJs ? '<script type="text/plain" id="deferredApp">\n' + deferredJs + '</script>\n' : ''),
    'assets.html': '<script>\n' + assets + '</script>\n',
    'appsscript.json': read(path.join(SRC, 'appsscript.json')),
  };
  if (templateMode === 'inline') outputs['Index.html'] = inlineIncludes(html, outputs);

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
  say('  內嵌圖示 ' + icons.weights.map(w => w.name + ' ' + w.icons + ' 個（字型 ' + (w.fontBytes / 1024).toFixed(1) + ' KB）').join('、'));
  const jsSize = size(js);
  const deferredSize = size(deferredJs);
  say('  前端程式：開機執行 ' + kb(jsSize.bytes).trim() + '（gzip ' + kb(jsSize.gz).trim() + '）＋延後 ' + kb(deferredSize.bytes).trim() + '（gzip ' + kb(deferredSize.gz).trim() + '）');
  say('  ' + '頁面合計'.padEnd(12) + kb(total.bytes) + '   gzip ' + kb(total.gz));
  say('  範本模式：' + templateMode + (templateMode === 'inline' ? '（style／app／assets 已展開進 Index.html）' : '（doGet 時 include）'));
  return { outputs, total, js: { boot: jsSize, deferred: deferredSize }, templateMode };
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
