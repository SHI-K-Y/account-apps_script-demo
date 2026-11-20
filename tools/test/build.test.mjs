// 建置產物測試：確認 dist/ 的檔案完整、可被瀏覽器與 Apps Script 解析，且模組都有登記。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, DIST, createBackend } from './helpers.mjs';

const read = name => fs.readFileSync(path.join(DIST, name), 'utf8');

test('dist/ 包含部署需要的所有檔案', () => {
  ['code.gs', 'Index.html', 'style.html', 'app.html', 'assets.html', 'appsscript.json'].forEach(name => {
    assert.ok(fs.existsSync(path.join(DIST, name)), '缺少 dist/' + name);
  });
});

test('前端與後端程式語法正確', () => {
  // app.html 有兩段：開機執行的 <script> 與延後執行的 <script type="text/plain" id="deferredApp">（P07）
  const parts = Array.from(read('app.html').matchAll(/<script(?: type="text\/plain" id="deferredApp")?>\n([\s\S]*?)<\/script>\n/g)).map(m => m[1]);
  const assets = read('assets.html').replace(/^<script>\n/, '').replace(/<\/script>\n?$/, '');
  assert.equal(parts.length, 2, 'app.html 應該有開機與延後兩段程式');
  parts.forEach((code, i) => assert.doesNotThrow(() => new vm.Script(code, { filename: i ? 'app-deferred.js' : 'app.js' })));
  assert.doesNotThrow(() => new vm.Script(assets, { filename: 'assets.js' }));
  assert.doesNotThrow(() => new vm.Script(read('code.gs'), { filename: 'code.gs' }));
});

test('頁面骨架：建置標記都已展開，圖示樣式已內嵌', () => {
  const html = read('Index.html');
  assert.doesNotMatch(html, /@include|<!-- @icons -->/);
  assert.match(html, /<style id="phosphorSubset"/);
  assert.match(html, /\.ph\.ph-note-pencil:before/);
  assert.doesNotMatch(html, /rel="stylesheet" href="https:\/\/unpkg\.com/, '不應再有會擋住繪製的外部樣式表');
  assert.doesNotMatch(html, /https:\/\/unpkg\.com\/[^"]*\.(woff2?|ttf)/, '圖示字型內嵌在頁面裡，不從 unpkg 下載');
  assert.match(html, /@font-face\{font-family:"?Phosphor"?;src:url\(data:font\/woff2;base64,/);
  assert.match(html, /@font-face\{font-family:"?Phosphor-Fill"?;src:url\(data:font\/woff2;base64,/, 'fill 字型（選取中的選項、導覽列目前頁面）也內嵌');
  // unicode-range 要含 U+0020，否則圖示所在的行改用後備字型的行高與基線（畫面會位移 1px）
  const ranges = html.match(/unicode-range:\s*([^;}]+)/g) || [];
  assert.equal(ranges.length, 2);
  ranges.forEach(r => assert.match(r, /unicode-range:\s*U\+20\b/, r.slice(0, 40)));
  ['pageBookkeeping', 'pageOverview', 'pageSettlement', 'pageCreditCard', 'pageSearch', 'pageForeign', 'pageSettings', 'editRecordModal', 'fxRecordModal'].forEach(id => {
    assert.equal(html.split('id="' + id + '"').length - 1, 1, 'id="' + id + '" 應該剛好出現一次');
  });
});

test('doGet 產生完整頁面，啟動資料可被解析', () => {
  const b = createBackend();
  b.call('getInitialData', true);
  const out = b.fns.doGet();
  const html = out.getContent();
  assert.equal(out.getTitle(), '我的記帳');
  assert.doesNotMatch(html, /<\?/, '範本標記都已被取代');
  const m = html.match(/window\.__INITIAL_DATA__ = (.*);/);
  assert.equal(JSON.parse(m[1]).selectedMonth, '2026.11');
});

test('前端所有後端呼叫都經過 Api 層', () => {
  const dir = path.join(ROOT, 'src', 'client', 'scripts');
  const offenders = [];
  (function walk(d) {
    fs.readdirSync(d, { withFileTypes: true }).forEach(entry => {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) return walk(full);
      if (!entry.name.endsWith('.js') || full.endsWith(path.join('core', 'api.js'))) return;
      if (/google\.script\.run/.test(fs.readFileSync(full, 'utf8'))) offenders.push(path.relative(ROOT, full));
    });
  })(dir);
  assert.deepEqual(offenders, []);
});

test('manifest.json 列出的模組都存在，且沒有漏列', () => {
  const client = path.join(ROOT, 'src', 'client');
  const manifest = JSON.parse(fs.readFileSync(path.join(client, 'manifest.json'), 'utf8'));
  const check = (sub, listed, ext) => {
    const found = [];
    (function walk(d) {
      fs.readdirSync(d, { withFileTypes: true }).forEach(entry => {
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(ext)) found.push(path.relative(path.join(client, sub), full).split(path.sep).join('/'));
      });
    })(path.join(client, sub));
    assert.deepEqual(found.sort(), listed.slice().sort());
    assert.equal(new Set(listed).size, listed.length, '不可重複列出');
  };
  check('styles', manifest.styles, '.css');
  check('scripts', manifest.scripts.concat(manifest.deferredScripts || []), '.js');
});

test('前端 Api 層標示的唯讀操作，在後端都登記為不寫入', () => {
  const b = createBackend();
  const routes = b.fns.apiRoutes_();
  const apiSource = fs.readFileSync(path.join(ROOT, 'src', 'client', 'scripts', 'core', 'api.js'), 'utf8');
  const block = apiSource.match(/READ_ACTIONS = new Set\(\[([\s\S]*?)\]\)/)[1];
  const readActions = block.match(/'[A-Za-z]+'/g).map(s => s.slice(1, -1));
  assert.ok(readActions.length >= 8);
  readActions.forEach(action => {
    assert.ok(routes[action], '後端沒有這個操作：' + action);
    assert.ok(!routes[action].write, action + ' 會寫入試算表，不能被前端當成可重試的唯讀操作');
  });
});

test('樣式分層：每個 CSS 檔都指定了已宣告的層，頁面第一條 CSS 就是層的順序，主樣式表沒有層外的規則', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'client', 'manifest.json'), 'utf8'));
  const order = manifest.layerOrder;
  assert.deepEqual(order.slice(0, 2), ['boot', 'icons'], '開機畫面與圖示子集排在最前面，主樣式表照舊可以覆寫它們');
  ['tokens', 'base', 'components', 'glass', 'effects', 'overrides'].forEach(name => assert.ok(order.includes(name), '層 ' + name));
  manifest.styles.forEach(f => assert.ok(order.includes(manifest.styleLayers[f]), f + ' 的層'));
  const html = read('Index.html');
  const firstStyle = html.match(/<style[^>]*>([\s\S]*?)<\/style>/)[1].replace(/\/\*[\s\S]*?\*\//g, '').trim();
  assert.ok(firstStyle.startsWith('@layer ' + order.join(', ') + ';'), '第一個 <style> 以層的順序開頭');
  assert.match(html, /<style id="phosphorSubset"[^>]*>\s*(?:@font-face\{[^}]*\}\s*){2}@layer icons\s*\{/, '圖示規則在 icons 層，字型宣告在層外');
  // 主樣式表的頂層只能是 @property 與 @layer 區塊
  const css = read('style.html').replace(/^<style>\n/, '').replace(/<\/style>\n?$/, '');
  let depth = 0;
  let start = 0;
  const top = [];
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (c === '"' || c === "'") { const q = c; i++; while (i < css.length && css[i] !== q) { if (css[i] === '\\') i++; i++; } continue; }
    if (c === '{') { if (depth === 0) top.push(css.slice(start, i).trim()); depth++; }
    else if (c === '}') { depth--; if (depth === 0) start = i + 1; }
  }
  const outside = top.filter(p => !/^@layer [a-z]+$/.test(p) && !/^@property --[\w-]+$/.test(p));
  assert.deepEqual(outside, [], '主樣式表裡沒有層外的規則');
});
