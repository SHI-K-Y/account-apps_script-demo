// doGet 只讀快取、一次讀齊（P09）：
//   1. 記帳之後啟動快取（BOOT_JSON）仍在，下次開頁 fromFreshCache=true、含新紀錄，前端不用再背景同步
//   2. 大型快取值（gzip＋base64＋切塊）：超過 100 KB 也能存取，任一塊遺失或版本不符視為沒命中
//   3. doGet 絕不開試算表：預算快取全空時不帶 budget、標示 budgetPending；所有快取一次 getAll 讀回
//   4. 對外格式不變：getInitialData（google.script.run／HTTP API）照舊有前 8 筆的 expenses／incomes
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, expenseForm, incomeForm } from './helpers.mjs';

const BOOT_KEY = 'BOOT_INIT_JSON_V2';
const MONTH_KEY = 'MONTH_DATA_V2_2026.11';
const fixed = amount => ({ month: '2026.11', source: 'fixed', amount, categories: ['生活費'], reserves: [] });

function pageBoot(b, e) {
  const html = b.fns.doGet(e).getContent();
  const m = html.match(/window\.__INITIAL_DATA__ = (.*);/);
  return { html, boot: m ? JSON.parse(m[1]) : undefined };
}

/** 呼叫 fn 期間有沒有碰到試算表（工作表層級的存取與讀取範圍都算）。 */
function spreadsheetTouches(b, fn) {
  const s = b.runtime.stats;
  const before = { app: s.spreadsheetApp, reads: s.reads };
  const result = fn();
  return { result, app: s.spreadsheetApp - before.app, reads: s.reads - before.reads };
}

test('記帳之後啟動快取仍在：下次開頁 fromFreshCache=true、含新紀錄、不需要背景同步', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', fixed(30000));
  b.call('getInitialData', true);
  assert.ok(b.runtime.cache.has(BOOT_KEY));

  const added = b.call('addExpense', expenseForm({ item: '午餐', amount: 321, note: 'P09 新紀錄' }));
  assert.ok(b.runtime.cache.has(BOOT_KEY), '新增之後 BOOT_JSON 還在');
  let { boot } = pageBoot(b);
  assert.equal(boot.fromFreshCache, true);
  assert.equal(boot.budgetPending, undefined);
  assert.equal(boot.initialRecent.fullExpenses[0].row, added.row, '新紀錄在最前面');
  assert.equal(boot.initialRecent.fullExpenses[0].note, 'P09 新紀錄');
  assert.equal(boot.initialRecent.budget.todaySpent, 321, '預算也是用新紀錄算的');

  b.call('updateExpense', expenseForm({ row: added.row, amount: 400, note: '改過' }));
  assert.ok(b.runtime.cache.has(BOOT_KEY), '修改之後 BOOT_JSON 還在');
  ({ boot } = pageBoot(b));
  assert.equal(boot.fromFreshCache, true);
  assert.equal(boot.initialRecent.fullExpenses[0].amount, 400);

  b.call('markCreditCardPaid', { month: '2026.11', row: added.row, paid: 'O' });
  assert.ok(b.runtime.cache.has(BOOT_KEY), '標記已繳之後 BOOT_JSON 還在');

  const inc = b.call('addIncome', incomeForm({ amount: 777 }));
  ({ boot } = pageBoot(b));
  assert.equal(boot.initialRecent.fullIncomes[0].row, inc.row);

  b.call('deleteExpense', { month: '2026.11', row: added.row });
  assert.ok(b.runtime.cache.has(BOOT_KEY), '刪除之後 BOOT_JSON 還在');
  ({ boot } = pageBoot(b));
  assert.equal(boot.fromFreshCache, true);
  assert.ok(!boot.initialRecent.fullExpenses.some(r => r.note === '改過'));
  assert.equal(boot.initialRecent.budget.todaySpent, 0);
});

test('記帳仍會清掉受影響的總覽、圖表與之後月份的月初餘額快取', () => {
  const b = createBackend();
  b.call('getInitialData', true);
  b.call('getAssetOverview', false);
  const overviewKeys = () => Array.from(b.runtime.cache.keys()).filter(k => k.startsWith('OVERVIEW_V3_2026.11'));
  assert.ok(overviewKeys().length > 0, '總覽有快取');
  b.runtime.cache.set('BUDGET_OPENING_V1_2026.12', '{"value":1}');
  b.call('addExpense', expenseForm({}));
  assert.deepEqual(overviewKeys(), [], '本月總覽快取清掉');
  assert.ok(!b.runtime.cache.has('BUDGET_OPENING_V1_2026.12'), '之後月份的月初餘額清掉');
});

test('啟動資料精簡：initialRecent 只放整月；對外的 getInitialData 與 HTTP API 照舊有前 8 筆', () => {
  const b = createBackend({ properties: { API_READ_TOKEN: 'r'.repeat(32) } });
  for (let i = 0; i < 10; i++) b.call('addExpense', expenseForm({ amount: 10 + i }));
  const api = b.call('getInitialData', true);
  assert.equal(api.initialRecent.expenses.length, 8);
  assert.deepEqual(api.initialRecent.expenses, api.initialRecent.fullExpenses.slice(0, 8));
  assert.ok(Array.isArray(api.initialRecent.incomes));
  const cachedApi = b.call('getInitialData', false);
  assert.equal(cachedApi.fromFreshCache, true);
  assert.deepEqual(cachedApi.initialRecent.expenses, cachedApi.initialRecent.fullExpenses.slice(0, 8), '快取命中時也補上前 8 筆');

  const http = b.post({ token: 'r'.repeat(32), action: 'getInitialData', args: [false] });
  assert.equal(http.ok, true);
  assert.equal(http.data.initialRecent.expenses.length, 8, 'HTTP API 格式不變');

  const { boot } = pageBoot(b);
  assert.equal(boot.initialRecent.expenses, undefined, '內嵌在頁面的不重複放前 8 筆');
  assert.equal(boot.initialRecent.fullExpenses.length, api.initialRecent.fullExpenses.length);
});

test('大型快取值：超過 100 KB 也能存取；任一塊遺失、版本不符都視為沒命中', () => {
  const b = createBackend();
  // 不容易壓縮的內容（亂數字串），壓縮後仍超過 90 KB，會切成多塊
  let seed = 1;
  const rand = () => { seed = (seed * 48271) % 2147483647; return seed; };
  const rows = Array.from({ length: 6000 }, (_, i) => ({ i, note: rand().toString(36) + rand().toString(36) + rand().toString(36) }));
  const value = { rows };
  assert.ok(JSON.stringify(value).length > 200 * 1024);

  assert.equal(b.fns.cachePutLarge_('BIG_TEST', value, 600), true);
  const manifest = b.runtime.cache.get('BIG_TEST');
  const [, version, count] = manifest.split('|');
  assert.ok(Number(count) >= 2, '切成多塊：' + manifest);
  for (let i = 0; i < Number(count); i++) {
    const part = b.runtime.cache.get('BIG_TEST#' + i);
    assert.ok(part.startsWith(version + '|'));
    assert.ok(part.length <= 90 * 1024 + version.length + 1, '每塊不超過 90 KB');
  }
  assert.deepEqual(b.fns.cacheGetLarge_('BIG_TEST'), value);

  b.runtime.cache.delete('BIG_TEST#1');
  assert.equal(b.fns.cacheGetLarge_('BIG_TEST'), null, '少一塊：沒命中');

  assert.equal(b.fns.cachePutLarge_('BIG_TEST', value, 600), true);
  const ver2 = b.runtime.cache.get('BIG_TEST').split('|')[1];
  b.runtime.cache.set('BIG_TEST#0', 'stale|' + b.runtime.cache.get('BIG_TEST#0').slice(ver2.length + 1));
  assert.equal(b.fns.cacheGetLarge_('BIG_TEST'), null, '版本不符：沒命中');

  b.runtime.cache.set('BIG_TEST', '{"old":"plain json"}');
  assert.equal(b.fns.cacheGetLarge_('BIG_TEST'), null, '舊格式（未切塊的 JSON）視為沒命中');

  assert.equal(b.fns.cachePutLarge_('SMALL_TEST', { a: 1 }, 600), true);
  assert.equal(b.runtime.cache.get('SMALL_TEST').split('|')[2], '1');
  assert.deepEqual(b.fns.cacheGetLarge_('SMALL_TEST'), { a: 1 });
});

test('大量紀錄：月份明細與啟動資料超過 100 KB 時快取仍有效，doGet 仍是 fromFreshCache', () => {
  const b = createBackend();
  for (let i = 0; i < 700; i++) {
    b.call('addExpense', expenseForm({ day: (i % 28) + 1, amount: 10 + i, note: '大量紀錄測試第 ' + i + ' 筆 ' + 'x'.repeat(60) }));
  }
  const api = b.call('getInitialData', true);
  assert.ok(JSON.stringify(api).length > 100 * 1024, '原始 JSON 超過 CacheService 單值上限');
  assert.ok(b.runtime.cache.has(BOOT_KEY));
  assert.ok(b.runtime.cache.has(MONTH_KEY));
  const { boot } = pageBoot(b);
  assert.equal(boot.fromFreshCache, true);
  assert.equal(boot.initialRecent.fullExpenses.length, api.initialRecent.fullExpenses.length);
});

test('doGet 不開試算表：預算快取全空時不帶 budget、標示 budgetPending；背景同步補上', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', fixed(30000));
  b.call('getInitialData', true);
  b.runtime.cache.delete('BUDGET_CONFIG_V1');
  Array.from(b.runtime.cache.keys()).filter(k => k.startsWith('BUDGET_OPENING_')).forEach(k => b.runtime.cache.delete(k));

  const t = spreadsheetTouches(b, () => pageBoot(b));
  assert.equal(t.app, 0, 'doGet 沒有呼叫 SpreadsheetApp／工作表');
  assert.equal(t.reads, 0, 'doGet 沒有讀取任何範圍');
  const boot = t.result.boot;
  assert.equal(boot.budgetPending, true);
  assert.ok(!Object.prototype.hasOwnProperty.call(boot.initialRecent, 'budget'), '沒有 budget（前端保留原本的狀態，等背景同步）');
  assert.equal(boot.fromFreshCache, true, '其他資料照樣是新的');

  // 前端的背景同步（getInitialData）會重讀設定、補上 budget，下次開頁就不再 pending
  const synced = b.call('getInitialData', false);
  assert.equal(synced.initialRecent.budget.amount, 30000);
  const again = pageBoot(b).boot;
  assert.equal(again.budgetPending, undefined);
  assert.equal(again.initialRecent.budget.amount, 30000);
});

test('doGet 不開試算表：生活費餘額的月初餘額沒有快取時也是 budgetPending', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', { month: '2026.11', source: 'balance', categories: ['生活費'] });
  b.call('getInitialData', true);
  assert.equal(pageBoot(b).boot.initialRecent.budget.openingBalance, 5755, '有快取時直接算');
  b.runtime.cache.delete('BUDGET_OPENING_V1_2026.11');
  const t = spreadsheetTouches(b, () => pageBoot(b));
  assert.equal(t.app + t.reads, 0);
  assert.equal(t.result.boot.budgetPending, true);
});

test('doGet 不開試算表：所有快取都沒有時（冷啟動）只用指令碼屬性的快照', () => {
  const b = createBackend();
  b.call('getInitialData', true);
  b.runtime.clearCache();
  const t = spreadsheetTouches(b, () => pageBoot(b));
  assert.equal(t.app + t.reads, 0);
  assert.equal(t.result.boot.fromFreshCache, false, '快照不是最新的：前端要背景同步');
  assert.equal(t.result.boot.selectedMonth, '2026.11');
});

test('doGet 一次讀齊：快取命中時只有一次 getAll，沒有其他快取讀取與指令碼屬性讀取', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', fixed(30000));
  b.call('getInitialData', true);
  pageBoot(b); // 第一次會建立 DOGET_CONFIG
  assert.ok(b.runtime.cache.has('DOGET_CONFIG_V1'));

  const s = b.runtime.stats;
  const before = { getAll: s.cacheGetAll, hits: s.cacheHits, misses: s.cacheMisses };
  const props = b.runtime.globals.PropertiesService.getScriptProperties();
  const origGet = props.getProperty;
  let propReads = 0;
  props.getProperty = k => { propReads++; return origGet(k); };
  try {
    const { boot } = pageBoot(b);
    assert.equal(boot.fromFreshCache, true);
    assert.equal(boot.initialRecent.budget.amount, 30000);
  } finally {
    props.getProperty = origGet;
  }
  assert.equal(s.cacheGetAll - before.getAll, 1, '只有一次 getAll');
  assert.equal(s.cacheHits + s.cacheMisses - before.hits - before.misses, 0, '沒有個別的 cache.get');
  assert.equal(propReads, 0, '不讀指令碼屬性');
});

test('DOGET_CONFIG：允許名單、App 圖示、網址由快取提供；setup() 與 setupAppIcon 之後更新', () => {
  const b = createBackend({ properties: { APP_ICON_URL: 'https://example.com/icon.png' }, serviceUrl: 'https://script.google.com/macros/s/abc/exec' });
  b.call('getInitialData', true);
  const first = b.fns.doGet();
  assert.equal(first.faviconUrl, 'https://example.com/icon.png');
  assert.match(first.getContent(), /id="bootReload" href="https:\/\/script\.google\.com\/macros\/s\/abc\/exec"/);

  // 屬性改了：快取到期前沿用舊值；執行 setup() 立即生效
  b.runtime.properties.set('APP_ICON_URL', 'https://example.com/new.png');
  b.runtime.properties.set('ALLOWED_EMAILS', 'friend@example.com');
  assert.equal(b.fns.doGet().faviconUrl, 'https://example.com/icon.png');
  b.fns.setup();
  assert.equal(b.fns.doGet().faviconUrl, 'https://example.com/new.png');
  const config = JSON.parse(b.runtime.cache.get('DOGET_CONFIG_V1'));
  assert.deepEqual(config.allowedEmails, ['friend@example.com']);
});

test('DOGET_CONFIG：快取裡的允許名單一樣會擋下名單外的人（API 呼叫照舊每次讀屬性）', () => {
  const properties = { ALLOWED_EMAILS: 'friend@example.com' };
  const stranger = createBackend({ properties, activeUserEmail: 'stranger@example.com' });
  stranger.fns.doGet();   // 建立 DOGET_CONFIG
  const html = stranger.fns.doGet().getContent();
  assert.match(html, /沒有存取權限/);
  assert.doesNotMatch(html, /__INITIAL_DATA__/);

  const friend = createBackend({ properties, activeUserEmail: 'friend@example.com' });
  friend.call('getInitialData', true);
  friend.fns.doGet();
  assert.match(friend.fns.doGet().getContent(), /__INITIAL_DATA__/);
});

test('doGet 偵錯計時：?timing=1 或 DEBUG_DOGET_TIMING 才印到執行紀錄', () => {
  const b = createBackend();
  b.call('getInitialData', true);
  b.fns.doGet();
  assert.ok(!b.logs.some(l => l.includes('[doGet]')), '預設不印');
  b.fns.doGet({ parameter: { timing: '1' } });
  const line = b.logs.find(l => l.includes('[doGet]'));
  assert.ok(line, '有計時紀錄');
  const info = JSON.parse(line.slice(line.indexOf('{')));
  ['totalMs', 'cacheMs', 'authMs', 'bootMs', 'templateMs'].forEach(k => assert.equal(typeof info[k], 'number', k));
  assert.equal(info.bootHit, true);
  assert.ok(b.logs.some(l => l.startsWith('[console.time] doGet')), 'console.time／timeEnd');

  const viaProp = createBackend({ properties: { DEBUG_DOGET_TIMING: '1' } });
  viaProp.fns.doGet();
  assert.ok(viaProp.logs.some(l => l.includes('[doGet]')));
});

test('跨月：啟動快取是上個月的，doGet 標示不是最新的（前端會背景同步）', () => {
  const b = createBackend();
  b.call('getInitialData', true);
  b.DateCtor.advance(18 * 24 * 3600 * 1000); // 12/1
  const { boot } = pageBoot(b);
  assert.equal(boot.fromFreshCache, false);
});
