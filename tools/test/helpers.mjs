// 測試共用工具：用模擬的 Apps Script 環境載入 dist/code.gs，資料是合成的測試試算表。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGasRuntime } from '../gas-mock/runtime.mjs';
import { createFixtureWorkbook } from '../gas-mock/fixture.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// TEST_DIST：改用別的建置目錄（例如另一個量測正在使用 dist/ 時，先建置到暫存目錄測試）
export const DIST = process.env.TEST_DIST ? path.resolve(process.env.TEST_DIST) : path.join(ROOT, 'dist');

/** 固定在 2026-11-13 12:00（台北時間）的 Date，讓「今天」「本月」在測試中不會變。 */
function fixedDateClass(startMs) {
  let nowMs = startMs;
  class FixedDate extends Date {
    constructor(...args) { if (args.length === 0) super(nowMs); else super(...args); }
    static now() { return nowMs; }
  }
  FixedDate.advance = ms => { nowMs += ms; };
  return FixedDate;
}

export function createBackend(options) {
  const opts = options || {};
  const files = {};
  ['Index', 'style', 'app', 'assets'].forEach(name => {
    files[name] = () => fs.readFileSync(path.join(DIST, name + '.html'), 'utf8');
  });
  const DateCtor = fixedDateClass(Date.UTC(2026, 10, 13, 4, 0, 0));
  const logs = [];
  const runtime = createGasRuntime(Object.assign({
    workbook: createFixtureWorkbook(),
    files,
    DateCtor,
    log: (...args) => logs.push(args.join(' ')),
  }, opts));
  const fns = runtime.load(fs.readFileSync(path.join(DIST, 'code.gs'), 'utf8'));
  const sheet = name => runtime.spreadsheet.getSheetByName(name);
  return {
    runtime, fns, logs, sheet, DateCtor,
    /** 經由 API 閘道呼叫（與前端相同的路徑）。 */
    call: (action, ...args) => JSON.parse(JSON.stringify(fns.api({ action, args }) ?? null)),
    /** 讀取工作表上一列的值，例如 rowValues('2026.11', 13, 'B', 7)。 */
    rowValues(sheetName, row, startCol, width) {
      const col = startCol.charCodeAt(0) - 64;
      return sheet(sheetName).getRange(row, col, 1, width).getValues()[0];
    },
    post(body) {
      const out = fns.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
      return JSON.parse(out.getContent());
    },
  };
}

export const expenseForm = over => Object.assign({
  month: '2026.11', day: 13, item: '午餐', category: '生活費', payment: '現金', paid: '', amount: '120', note: '測試',
}, over);

export const incomeForm = over => Object.assign({
  month: '2026.11', day: 12, item: '薪資', category: '存款', amount: 5000, note: '',
}, over);

// ── 瀏覽器測試（Playwright Chromium）────────────────────────────────────────
// 套件有裝不代表瀏覽器執行檔有裝（剛 clone、CI、升級 Playwright 之後都會缺），兩個都要檢查。
// REQUIRE_BROWSER=1：沒有瀏覽器時不略過而是失敗（npm run sync:demo 會帶，確保公開版是完整測試過的）。
export const BROWSER_INSTALL_HINT = '第一次跑測試前先執行 npx playwright install chromium';
export const browserRequired = () => process.env.REQUIRE_BROWSER === '1';

let chromiumStatusPromise = null;
/** 回傳 { chromium, reason }：可用時 reason 是 null；不能用時 chromium 是 null、reason 說明原因與安裝方式。 */
export function chromiumStatus() {
  if (!chromiumStatusPromise) chromiumStatusPromise = (async () => {
    let chromium;
    try { ({ chromium } = await import('playwright')); } catch (e) {
      return { chromium: null, reason: '沒有安裝 playwright 套件（先執行 npm install，再執行 npx playwright install chromium）' };
    }
    let exe = '';
    try { exe = chromium.executablePath(); } catch (e) { exe = ''; }
    if (!exe || !fs.existsSync(exe)) {
      return { chromium: null, reason: '找不到 Playwright 的 Chromium 執行檔' + (exe ? '（' + exe + '）' : '') + '：' + BROWSER_INSTALL_HINT };
    }
    return { chromium, reason: null };
  })();
  return chromiumStatusPromise;
}

/**
 * 瀏覽器測試共用的設定：
 *   const web = await browserTests();
 *   test('…', { skip: web.skip }, async () => { const browser = await web.browser(); … });
 * 瀏覽器在第一個用到的測試裡才啟動（不放 before hook），啟動失敗只影響瀏覽器測試，
 * 同一檔案裡只測後端或原始碼的測試照常執行。檔案結束時自動關閉（沒啟動過就什麼都不做）。
 * 要在檔案最上面（import 之後、任何 test() 之前）呼叫：先登記的測試會在這裡的 await 期間開始跑，
 * 之後啟動瀏覽器時 node:test 會把它當成「事件迴圈已空、Promise 永遠等不到」而取消那項測試。
 */
export async function browserTests() {
  const { after } = await import('node:test');
  const { chromium, reason } = await chromiumStatus();
  const required = browserRequired();
  let launching = null;
  after(async () => {
    if (!launching) return;
    const browser = await launching.catch(() => null);
    if (browser) await browser.close();
  }, { timeout: 30000 });
  return {
    chromium,
    reason,
    /** 給 test() 的 skip：沒有瀏覽器時是略過原因；REQUIRE_BROWSER=1 時不略過（改在 browser() 失敗）。 */
    skip: chromium || required ? false : reason,
    browser() {
      if (!chromium) return Promise.reject(new Error('REQUIRE_BROWSER=1，但' + reason));
      if (!launching) launching = chromium.launch();
      return launching;
    },
  };
}
