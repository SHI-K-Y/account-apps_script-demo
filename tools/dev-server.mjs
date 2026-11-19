#!/usr/bin/env node
// 本機預覽伺服器：用模擬的 Apps Script 環境執行 dist/ 裡「真正要部署的檔案」，
// 資料來自專案根目錄的 Excel 匯出檔（只存在記憶體，重新啟動就還原，不會動到真實試算表）。
//
//   npm run dev                       → http://localhost:8080
//   node tools/dev-server.mjs --port 9000 --latency 400 --root dist --xlsx "記帳簿 v9.0.xlsx"
//   node tools/dev-server.mjs --fixture     改用內建的合成測試資料（不含個人帳務）
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { readXlsx } from './gas-mock/xlsx.mjs';
import { createGasRuntime } from './gas-mock/runtime.mjs';
import { createFixtureWorkbook } from './gas-mock/fixture.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

export function findXlsx(root) {
  const hit = fs.readdirSync(root).filter(f => f.toLowerCase().endsWith('.xlsx') && !f.startsWith('~$')).sort();
  return hit.length ? path.join(root, hit[hit.length - 1]) : null;
}

/** google.script.run 的瀏覽器端替身：把呼叫轉成對本機伺服器的 POST。 */
const CLIENT_SHIM = `<script>
(function () {
  function runner(state) {
    return new Proxy({}, {
      get: function (_, prop) {
        if (prop === 'withSuccessHandler') return function (fn) { return runner(Object.assign({}, state, { ok: fn })); };
        if (prop === 'withFailureHandler') return function (fn) { return runner(Object.assign({}, state, { fail: fn })); };
        if (prop === 'withUserObject') return function (obj) { return runner(Object.assign({}, state, { user: obj })); };
        return function () {
          var args = Array.prototype.slice.call(arguments);
          fetch('/__rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fn: prop, args: args }) })
            .then(function (r) { return r.json(); })
            .then(function (res) {
              if (res.ok) { if (state.ok) state.ok(res.result, state.user); return; }
              var err = new Error(res.error); err.name = res.name || 'Error';
              if (state.fail) state.fail(err, state.user); else console.error('[google.script.run]', err);
            })
            .catch(function (e) {
              var err = new Error('NetworkError: 連線失敗（' + e.message + '）');
              if (state.fail) state.fail(err, state.user);
            });
        };
      }
    });
  }
  window.google = { script: { run: runner({}), host: { close: function () {} }, url: { getLocation: function (cb) { cb({ hash: location.hash, parameter: {}, parameters: {} }); } } } };
})();
</script>`;

export function createDevApp(options) {
  const root = path.resolve(options.root || path.join(ROOT, 'dist'));
  const xlsxPath = options.xlsx ? path.resolve(options.xlsx) : findXlsx(ROOT);
  // 沒有 Excel 匯出檔時，改用內建的合成測試資料（版面相同、內容是假資料）。
  const useFixture = Boolean(options.fixture) || !xlsxPath || !fs.existsSync(xlsxPath);
  // fixtureOptions：傳給 createFixtureWorkbook（例如 { extraExpenses: 300 }，P06 的長清單量測用）
  const loadWorkbook = () => (useFixture ? createFixtureWorkbook(options.fixtureOptions) : readXlsx(xlsxPath));
  const latency = Number(options.latency) || 0;
  const quiet = Boolean(options.quiet);

  const htmlFiles = new Proxy({}, {
    has: (_, name) => fs.existsSync(path.join(root, name + '.html')),
    getOwnPropertyDescriptor: (_, name) => (fs.existsSync(path.join(root, name + '.html'))
      ? { configurable: true, enumerable: true, value: () => fs.readFileSync(path.join(root, name + '.html'), 'utf8') }
      : undefined),
    get: (_, name) => () => fs.readFileSync(path.join(root, String(name) + '.html'), 'utf8'),
  });

  let runtime = null;
  let api = null;
  let codeStamp = '';

  function serverSource() {
    return fs.readdirSync(root).filter(f => f.endsWith('.gs')).sort()
      .map(f => fs.readFileSync(path.join(root, f), 'utf8')).join('\n');
  }
  function stampOf() {
    return fs.readdirSync(root).filter(f => f.endsWith('.gs')).sort()
      .map(f => f + ':' + fs.statSync(path.join(root, f)).mtimeMs).join('|');
  }
  function boot(resetData) {
    if (!runtime || resetData) {
      runtime = createGasRuntime({
        workbook: loadWorkbook(),
        files: htmlFiles,
        log: quiet ? () => {} : (...a) => console.log(...a),
        properties: options.properties || {},
        activeUserEmail: options.activeUserEmail,
        DateCtor: options.DateCtor,   // 效能量測固定「今天」用（tools/perf）；沒給就是真實時間
      });
    }
    api = runtime.load(serverSource());
    codeStamp = stampOf();
  }
  function ensureFresh() {
    if (!api || stampOf() !== codeStamp) boot(false);
  }

  function handleRpc(body) {
    ensureFresh();
    const fn = api[body.fn];
    if (typeof fn !== 'function' || /_$/.test(body.fn) || body.fn === '__eval') {
      return { ok: false, name: 'ScriptError', error: '找不到指令碼函式：' + body.fn };
    }
    try {
      const result = fn.apply(null, body.args || []);
      return { ok: true, result: result === undefined ? null : JSON.parse(JSON.stringify(result)) };
    } catch (e) {
      return { ok: false, name: e && e.name, error: e && e.message ? e.message : String(e) };
    }
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, type, body) => {
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-store' };
      // 與 Apps Script 實際提供頁面的方式一致（gzip 壓縮），本機量到的載入時間才有參考價值。
      if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || '')) && body.length > 1024) {
        headers['Content-Encoding'] = 'gzip';
        body = zlib.gzipSync(body);
      }
      res.writeHead(status, headers);
      res.end(body);
    };
    try {
      if (req.method === 'POST' && url.pathname === '/__rpc') {
        let raw = '';
        req.on('data', chunk => { raw += chunk; });
        req.on('end', () => {
          let out;
          try { out = handleRpc(JSON.parse(raw || '{}')); } catch (e) { out = { ok: false, error: String(e && e.message || e) }; }
          if (!quiet) console.log('[rpc]', JSON.parse(raw || '{}').fn, out.ok ? 'ok' : 'ERR ' + out.error);
          setTimeout(() => send(200, 'application/json; charset=utf-8', JSON.stringify(out)), latency);
        });
        return;
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
      if (url.pathname === '/__reset') {
        boot(true);
        return send(200, 'text/plain; charset=utf-8', '已還原成 Excel 內的原始資料');
      }
      if (url.pathname === '/') {
        ensureFresh();
        const output = api.doGet({ parameter: Object.fromEntries(url.searchParams), queryString: url.search.slice(1) });
        let html = output.getContent();
        const meta = Object.keys(output.metaTags || {})
          .map(name => '<meta name="' + name + '" content="' + output.metaTags[name] + '">').join('');
        const inject = meta + (output.getTitle() ? '<title>' + output.getTitle() + '</title>' : '') + CLIENT_SHIM;
        html = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, m => m + inject) : inject + html;
        return send(200, 'text/html; charset=utf-8', html);
      }
      return send(404, 'text/plain; charset=utf-8', 'Not found');
    } catch (e) {
      console.error(e);
      return send(500, 'text/plain; charset=utf-8', String(e && e.stack || e));
    }
  });

  boot(true);
  try { api.setup && api.setup(); } catch (e) { if (!quiet) console.warn('setup() 失敗：' + e.message); }

  const dataLabel = useFixture ? '內建的合成測試資料' : path.basename(xlsxPath);
  return { server, getRuntime: () => runtime, getApi: () => { ensureFresh(); return api; }, dataLabel, root };
}

if (import.meta.url === 'file://' + process.argv[1] || fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = parseArgs(process.argv.slice(2));
  const port = Number(args.port) || 8080;
  const app = createDevApp(args);
  app.server.listen(port, () => {
    console.log('記帳簿本機預覽：http://localhost:' + port);
    console.log('  部署檔來源：' + path.relative(ROOT, app.root) + '/');
    console.log('  範例資料：  ' + app.dataLabel + '（只在記憶體中修改；開啟 /__reset 可還原）');
  });
}
