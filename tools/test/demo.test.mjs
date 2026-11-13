// 公開 Demo 測試：沙盒後端（真正的後端程式 ＋ 虛構資料 ＋ 公式重算）與靜態網站的建置結果。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { DIST } from './helpers.mjs';
import { createDemoBackend } from '../demo/sandbox.mjs';
import { createDemoWorkbook, DEMO_MONTHS } from '../demo/demo-data.mjs';
import { buildDemoSite } from '../demo/build-demo.mjs';

const serverSource = fs.readFileSync(path.join(DIST, 'code.gs'), 'utf8');
// 固定在 2026-11-13 12:00（台北時間）。
const NOON = Date.UTC(2026, 10, 13, 4, 0, 0);
const backend = over => createDemoBackend(Object.assign({ serverSource, clock: () => NOON, localOffsetMinutes: 480 }, over));
const money = text => Number(String(text).replace(/[^0-9.-]/g, ''));
const expense = (b, over) => Object.assign({
  month: b.initialData().selectedMonth, day: b.today.d, item: '午餐', category: '生活費', payment: '現金', paid: '', amount: '1000', note: '試用',
}, over);

test('Demo：啟動資料涵蓋最近六個月，支付方式是虛構的卡片與銀行', () => {
  const b = backend();
  const boot = b.initialData();
  assert.equal(boot.selectedMonth, '2026.11');
  assert.deepEqual(boot.months, ['2026.11', '2026.10', '2026.09', '2026.08', '2026.07', '2026.06']);
  assert.equal(boot.months.length, DEMO_MONTHS);
  assert.ok(boot.initialRecent.expenses.length > 0, '本月已有範例支出');
  assert.ok(boot.initialRecent.fullExpenses.every(r => r.day <= 13), '本月的範例資料只到今天');
  const meta = boot.settingsMetadata;
  assert.deepEqual(meta.cards.map(c => c.name), ['山嵐現金回饋卡', '海悅 Wave 信用卡', '青禾簽帳卡']);
  assert.ok(meta.cards.every(c => /^data:image\/svg\+xml,/.test(c.customImage)), '卡面是程式產生的 SVG');
  assert.ok(meta.banks.every(bank => /^data:image\/svg\+xml,/.test(bank.customLogo)));
  assert.equal(meta.quickCombos.length, 3);
  boot.options.paymentMethods.forEach(p => assert.match(p, /^(現金|(信用卡|簽帳卡|Line Pay|轉帳)-.+)$/));
});

test('Demo：範例資料固定可重現，換一天會跟著往後推', () => {
  const dump = wb => JSON.stringify(wb.workbook.sheets.map(s => [s.name, Array.from(s.cells.entries())]));
  const today = { y: 2026, m: 11, d: 13 };
  assert.equal(dump(createDemoWorkbook(today)), dump(createDemoWorkbook(today)));
  const january = createDemoWorkbook({ y: 2027, m: 1, d: 2 }).workbook.sheets.map(s => s.name).filter(n => /^\d{4}\.\d{2}$/.test(n));
  assert.deepEqual(january, ['2026.08', '2026.09', '2026.10', '2026.11', '2026.12', '2027.01']);
});

test('Demo：新增、修改、刪除支出後，總覽與對帳數字立即跟著變', () => {
  const b = backend();
  const before = b.call('getAssetOverview', false);
  assert.deepEqual(before.warnings, []);
  assert.equal(money(before.assetTotal), money(before.livingBalance) + money(before.savingsBalance) + money(before.agencyBalance));

  const added = b.call('addExpense', expense(b));
  assert.ok(added.ok);
  let after = b.call('getAssetOverview', true);
  assert.equal(money(after.assetTotal), money(before.assetTotal) - 1000);
  assert.equal(money(after.cashExpense), money(before.cashExpense) + 1000);
  assert.equal(money(after.livingExpense), money(before.livingExpense) + 1000);

  b.call('updateExpense', expense(b, { row: added.row, amount: '400', payment: '信用卡-山嵐現金回饋卡', paid: 'X' }));
  after = b.call('getAssetOverview', true);
  assert.equal(money(after.assetTotal), money(before.assetTotal) - 400);
  assert.equal(money(after.cashExpense), money(before.cashExpense));
  assert.equal(money(after.creditCardUnpaid), money(before.creditCardUnpaid) + 400);

  const settlement = b.call('getSettlementData', '');
  assert.equal(money(settlement.ledger.total), money(after.assetTotal), '對帳頁的帳面總額與總覽一致');
  assert.equal(money(settlement.difference), money(settlement.actual.total) - money(settlement.ledger.total));

  b.call('deleteExpense', { month: added.month, row: added.row });
  after = b.call('getAssetOverview', true);
  assert.equal(money(after.assetTotal), money(before.assetTotal));
  assert.equal(money(after.creditCardUnpaid), money(before.creditCardUnpaid));
});

test('Demo：收入、圖表、搜尋、新增月份與國外帳簿都能運作', () => {
  const b = backend();
  const before = b.call('getAssetOverview', false);
  b.call('addIncome', { month: '2026.11', day: 13, item: '其他', category: '存款', amount: 2500, note: '試用' });
  assert.equal(money(b.call('getAssetOverview', true).savingsBalance), money(before.savingsBalance) + 2500);

  const charts = b.call('getOverviewCharts', '2026.11', false);
  assert.equal(charts.trend.length, 6, '趨勢圖有六個月');
  assert.ok(charts.current.byCategory['生活費'].total > 0);
  assert.ok(b.call('searchRecords', { months: ['2026.11', '2026.10'], keyword: '房租' }).results.length >= 2);

  assert.deepEqual(b.call('createNewMonthSheet', '2026.12').months.slice(0, 2), ['2026.12', '2026.11']);
  assert.equal(b.call('addExpense', expense(b, { month: '2026.12', day: 3 })).row, 5);

  const ledgers = b.call('getFxLedgers', false).ledgers;
  assert.deepEqual(ledgers.map(l => l.name), ['東京五日']);
  assert.ok(ledgers[0].totalTwd > 0);
  const id = ledgers[0].id;
  const count = b.call('getFxLedgerData', id, true).records.length;
  const fx = b.call('addFxRecord', { ledgerId: id, date: '2026-09-02', item: '餐飲', payment: '現金', currency: 'JPY', amount: '1000', rate: '0.21', note: '' });
  assert.equal(fx.record.twd, 210);
  assert.equal(b.call('getFxLedgerData', id, true).records.length, count + 1);
});

test('Demo：每次啟動都是全新的資料（重新整理即還原）', () => {
  const first = backend();
  const original = first.call('getAssetOverview', false).assetTotal;
  first.call('addExpense', expense(first, { amount: '9999' }));
  assert.notEqual(first.call('getAssetOverview', true).assetTotal, original);
  assert.equal(backend().call('getAssetOverview', false).assetTotal, original);
});

test('Demo：訪客在別的時區時，後端的「今天」與瀏覽器當地日期一致', () => {
  // 台北 11/14 04:00 = 洛杉磯 11/13 12:00（UTC-8）。
  const b = backend({ clock: () => Date.UTC(2026, 10, 13, 20, 0, 0), localOffsetMinutes: -480 });
  assert.deepEqual(b.today, { y: 2026, m: 11, d: 13 });
  assert.equal(b.initialData().todayISO, '2026-11-13');
  // 當地已經跨月、台北還沒：奧克蘭 12/1 02:00（UTC+13）= 台北 11/30 21:00。
  const nz = backend({ clock: () => Date.UTC(2026, 10, 30, 13, 0, 0), localOffsetMinutes: 780 });
  assert.equal(nz.initialData().selectedMonth, '2026.12');
});

test('Demo：只有公開的進入點可以被呼叫', () => {
  const b = backend();
  assert.throws(() => b.invoke('getInitialData_', [true]), /找不到指令碼函式/);
  assert.throws(() => b.invoke('__eval', ['1']), /找不到指令碼函式/);
  assert.throws(() => b.call('noSuchAction'), /不支援的操作/);
});

test('Demo 網站：單一靜態檔，範本標記都已展開，沙盒可在瀏覽器環境啟動', async () => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bookkeeping-demo-'));
  try {
    const result = await buildDemoSite({ outDir, minify: false });
    const html = fs.readFileSync(result.file, 'utf8');
    assert.ok(fs.existsSync(path.join(outDir, '.nojekyll')));
    assert.doesNotMatch(html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, ''), /<\?/, '骨架裡沒有殘留的範本標記');
    assert.match(html, /<title>記帳簿 Demo/);
    assert.match(html, /window\.__INITIAL_DATA__ = \(window\.__DEMO_INITIAL_DATA__ \|\| null\);/);
    assert.ok(html.indexOf('id="demoSandbox"') < html.indexOf('</head>'), '沙盒在主程式之前載入');

    // 用最小的瀏覽器替身執行沙盒：確認它會清掉舊快取、提供 google.script.run 與啟動資料。
    const sandboxJs = html.match(/<script id="demoSandbox">\n([\s\S]*?)\n {2}<\/script>/)[1];
    const store = new Map([['FAST_BOOKKEEPING_BOOT_V2', '{"stale":true}'], ['FAST_BOOKKEEPING_PREFS_V1', '{"perf":"high"}'], ['other', '1']]);
    const localStorage = {
      get length() { return store.size; },
      key: i => Array.from(store.keys())[i],
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: k => { store.delete(k); },
    };
    const window = {};
    const context = vm.createContext({
      window, localStorage, console, setTimeout, clearTimeout, TextEncoder, TextDecoder, Intl, atob, btoa,
      location: { hash: '', reload() {} },
      document: { readyState: 'loading', addEventListener() {} },
    });
    new vm.Script(sandboxJs, { filename: 'demo-sandbox.js' }).runInContext(context);

    assert.deepEqual(Array.from(store.keys()).sort(), ['FAST_BOOKKEEPING_PREFS_V1', 'other'], '資料快取被清掉、介面偏好保留');
    assert.ok(window.__DEMO_INITIAL_DATA__.months.length === DEMO_MONTHS);
    const months = await new Promise((resolve, reject) => {
      window.google.script.run.withSuccessHandler(resolve).withFailureHandler(reject).api({ action: 'getAssetOverview', args: [false] });
    });
    assert.equal(months.month, window.__DEMO_INITIAL_DATA__.selectedMonth);
    const error = await new Promise(resolve => {
      window.google.script.run.withSuccessHandler(() => resolve(null)).withFailureHandler(resolve).api({ action: 'addExpense', args: [{}] });
    });
    assert.ok(error && typeof error.message === 'string' && error.message.length > 0, '後端的錯誤會交給失敗處理函式');
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
});
