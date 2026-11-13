#!/usr/bin/env node
// 公開 Demo 網站的建置腳本：把記帳簿打包成一個不需要任何後端的靜態網頁（可直接放上 GitHub Pages）。
//
//   node tools/demo/build-demo.mjs               產生 docs/index.html（壓縮）
//   node tools/demo/build-demo.mjs --no-minify   不壓縮（除錯用）
//   node tools/demo/build-demo.mjs --out 目錄     輸出到指定目錄（預設 docs/）
//
// 作法：
//   1. 先跑一次正常的建置（tools/build.mjs，只取結果、不寫入 dist/），取得要部署到 Apps Script 的那幾個檔案。
//   2. 把 Index.html 裡的範本標記（<?!= include('style') ?> 等）直接展開成檔案內容。
//   3. 在 <head> 內嵌「沙盒」：模擬的 Apps Script 環境 ＋ 後端程式（code.gs）＋ 虛構的範例資料，
//      並提供 google.script.run 的替身。前端程式一行都不用改，所有讀寫都發生在訪客的瀏覽器記憶體裡。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from '../build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DEMO_TITLE = '記帳簿 Demo｜線上試用';
const DEMO_DESCRIPTION = '記帳簿的線上試用版：範例資料只存在你的瀏覽器分頁，可以自由新增、修改、刪除，重新整理就會還原。';
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#c93a2c"/>' +
  '<text x="32" y="33" font-family="system-ui,sans-serif" font-size="34" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="#fffcf7">$</text></svg>');

async function bundleSandbox(serverSource, minify) {
  let esbuild;
  try {
    esbuild = await import('esbuild');
  } catch (e) {
    throw new Error('找不到 esbuild，請先在專案根目錄執行 npm install。');
  }
  const result = await esbuild.build({
    entryPoints: [path.join(HERE, 'sandbox-entry.mjs')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2020',
    minify,
    write: false,
    charset: 'utf8',
    legalComments: 'none',
    logLevel: 'silent',
    plugins: [{
      name: 'demo-server-source',
      setup(b) {
        b.onResolve({ filter: /^demo:server-source$/ }, () => ({ path: 'server-source', namespace: 'demo' }));
        b.onLoad({ filter: /.*/, namespace: 'demo' }, () => ({ contents: 'export default ' + JSON.stringify(serverSource) + ';', loader: 'js' }));
      },
    }],
  });
  result.warnings.forEach(w => console.warn('⚠ esbuild：' + w.text));
  // 內嵌在 <script> 裡的程式不能出現會提前結束標籤的字串。
  return result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
}

/** 把 Apps Script 範本（Index.html）變成可以直接開啟的靜態頁面。 */
function renderStaticPage(outputs, sandboxJs) {
  let html = outputs['Index.html'];

  // 逐一處理範本標記；遇到不認得的就讓建置失敗（寧可停下來，也不要產生壞掉的頁面）。
  // 取代值一律用函式回傳，避免檔案內容裡的 $ 被當成特殊符號。
  const seen = { include: 0, boot: 0 };
  html = html.replace(/<\?(!=|=)?([\s\S]*?)\?>/g, (tag, kind, code) => {
    const source = code.trim();
    const include = source.match(/^include\('([A-Za-z]+)'\)$/);
    if (kind === '!=' && include) {
      const content = outputs[include[1] + '.html'];
      if (content == null) throw new Error('Index.html 引用了不存在的檔案：' + include[1]);
      seen.include++;
      return content.replace(/\n$/, '');
    }
    // 啟動資料：原本由 doGet 填入，Demo 改由沙盒在頁面載入時算好。
    if (kind === '!=' && /\binitialDataJson\b/.test(source)) {
      seen.boot++;
      return '(window.__DEMO_INITIAL_DATA__ || null)';
    }
    // 「重新載入」連結：原本指向網頁應用程式網址，Demo 就是目前這一頁。
    if (kind === '!=' && /ScriptApp\.getService\(\)\.getUrl\(\)/.test(source)) return './';
    throw new Error('Index.html 有 Demo 建置不認得的範本標記，請更新 tools/demo/build-demo.mjs 的 renderStaticPage()：' + tag.slice(0, 120));
  });
  if (seen.include < 3 || seen.boot !== 1) {
    throw new Error('Index.html 的範本標記與 Demo 建置預期的不同（include ' + seen.include + ' 個、啟動資料 ' + seen.boot + ' 個）。');
  }

  if (!/<title>[^<]*<\/title>/.test(html)) throw new Error('Index.html 缺少 <title>。');
  html = html.replace(/<title>[^<]*<\/title>/, () => '<title>' + DEMO_TITLE + '</title>');
  html = html.replace(/(<meta name="description" content=")[^"]*(">)/, (_, a, b) => a + DEMO_DESCRIPTION + b);

  const inject = '  <link rel="icon" href="' + FAVICON + '">\n' +
    '  <script id="demoSandbox">\n' + sandboxJs.replace(/\n$/, '') + '\n  </script>\n';
  if (!/<\/head>/i.test(html)) throw new Error('Index.html 缺少 </head>。');
  return html.replace(/<\/head>/i, m => inject + m);
}

/**
 * 建置 Demo 網站。
 * @param {object} [opts]  outDir（輸出目錄，預設 docs/）、minify（預設 true）
 * @returns {Promise<{ outDir: string, file: string, bytes: number }>}
 */
export async function buildDemoSite(opts) {
  const options = opts || {};
  const outDir = path.resolve(options.outDir || path.join(ROOT, 'docs'));
  const minify = options.minify !== false;

  // 只取建置結果、不寫入 dist/：Demo 不應該動到要部署到 Apps Script 的檔案。
  const { outputs } = await build({ minify, write: false, quiet: true });
  const sandboxJs = await bundleSandbox(outputs['code.gs'], minify);
  const html = renderStaticPage(outputs, sandboxJs);

  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, 'index.html');
  fs.writeFileSync(file, html);
  // 告訴 GitHub Pages 不要用 Jekyll 處理（否則底線開頭的檔案會被略過，也比較慢）。
  fs.writeFileSync(path.join(outDir, '.nojekyll'), '');
  return { outDir, file, bytes: Buffer.byteLength(html, 'utf8') };
}

async function main() {
  const argv = process.argv.slice(2);
  // 私有的主專案含有個人化的預設值，直接從那裡建置出來的 Demo 不能公開；請走同步流程（會先去敏、再掃描）。
  if (fs.existsSync(path.join(ROOT, 'tools', 'demo-sync')) && !argv.includes('--allow-private-source')) {
    throw new Error('這裡是私有的主專案，請改用 npm run sync:demo 產生公開 Demo（會先把程式碼去敏再建置）。');
  }
  const outIndex = argv.indexOf('--out');
  const result = await buildDemoSite({
    outDir: outIndex > -1 ? argv[outIndex + 1] : undefined,
    minify: !argv.includes('--no-minify'),
  });
  if (!argv.includes('--quiet')) {
    console.log('Demo 網站建置完成：' + path.relative(process.cwd(), result.file) + '（' + (result.bytes / 1024).toFixed(0) + ' KB）');
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(e => { console.error('Demo 建置失敗：' + e.message); process.exit(1); });
}
