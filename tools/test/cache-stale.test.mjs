// 先顯示、再更新（P12）：
//   1. LocalCache：大型資料存 IndexedDB（KvStore），寫入合併到閒置時間（同一個鍵只寫最後一份）、
//      開機資料與各月紀錄不存兩份、記帳後標成過期而不是刪除、舊 localStorage 資料搬家後刪除
//   2. core/api.js：相同的讀取進行中時合併；Api.batch 一次 batchRead、沿用進行中的讀取、後端沒有 batchRead 時逐項送出
//   3. 後端 batchRead：只接受唯讀操作、每項各自回傳 { ok, data }／{ ok: false, error }、同一次執行共用快取讀取
//   4. 瀏覽器：記一筆後立刻切到總覽，畫面立即顯示舊數字（沒有骨架、沒有忙碌條），寫入回來後一次 batchRead 更新；
//      開機後閒置預取；舊版 localStorage 資料搬進 IndexedDB
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, DIST, createBackend } from './helpers.mjs';
import { createDevApp } from '../dev-server.mjs';

const CLIENT = path.join(ROOT, 'src', 'client');
// vm 裡建立的物件原型不同，比較前先轉成一般的 JSON 值
const plain = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const read = rel => fs.readFileSync(path.join(CLIENT, rel), 'utf8');
const FIXED_NOW = Date.UTC(2026, 10, 13, 4, 0, 0);   // 2026-11-13 12:00 台北

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch (e) { chromium = null; }
const NO_BROWSER = chromium ? false : '沒有安裝 playwright';

/* ---------------------------------------------------------------------------
 * 1. LocalCache（在 vm 裡執行，KvStore 換成記憶體替身）
 * ------------------------------------------------------------------------- */
function loadLocalCache(opts) {
  const o = opts || {};
  const store = new Map(Object.entries(o.legacy || {}));
  const lsWrites = [];
  const localStorage = {
    get length() { return store.size; },
    key: i => Array.from(store.keys())[i],
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { lsWrites.push(k); store.set(k, String(v)); },
    removeItem: k => { store.delete(k); },
  };
  const db = new Map(Object.entries(o.db || {}));
  const writes = [];
  let releaseRead = null;
  const readGate = o.holdRead ? new Promise(r => { releaseRead = r; }) : Promise.resolve();
  const KvStore = {
    readAll: () => readGate.then(() => (o.noIdb ? null : new Map(db))),
    write: entries => {
      writes.push(entries.map(([k, v]) => [k, v === undefined ? undefined : JSON.parse(JSON.stringify(v))]));
      if (o.writeFails || o.noIdb) return Promise.resolve(false);
      entries.forEach(([k, v]) => { if (v === undefined) db.delete(k); else db.set(k, v); });
      return Promise.resolve(true);
    },
  };
  const idle = [];
  const ctx = vm.createContext({
    localStorage, KvStore, indexedDB: {}, JSON, Date, Object, Array, Map, Set, Promise, structuredClone, setTimeout, clearTimeout,
    requestIdleCallback: fn => { idle.push(fn); return idle.length; },
    document: { addEventListener() {}, visibilityState: 'visible' },
  });
  vm.runInContext(read('scripts/core/local-cache.js') + '\nthis.LocalCache = LocalCache;', ctx);
  return {
    LC: ctx.LocalCache, db, writes, store, lsWrites, releaseRead: () => releaseRead && releaseRead(),
    /** 執行排進閒置時間的寫回，並等 KvStore 寫完 */
    idle: async () => { while (idle.length) idle.shift()({ timeRemaining: () => 50 }); await new Promise(r => setTimeout(r, 0)); },
  };
}

test('LocalCache：開機資料不重複存最近紀錄；getBoot() 時補回 initialRecent；回傳與存入的都是複本', async () => {
  const h = loadLocalCache();
  await h.LC.whenReady();
  const recent = { month: '2026.11', fullExpenses: [{ row: 5, amount: 120 }], fullIncomes: [] };
  const data = { selectedMonth: '2026.11', months: ['2026.10', '2026.11'], options: { a: 1 }, cachedAt: 100, initialRecent: recent };
  h.LC.saveBoot(data);
  await h.idle();
  assert.equal(h.writes.length, 1, '一次閒置只寫一次');
  const boot = h.db.get('boot').v;
  assert.equal(boot.initialRecent, undefined, '開機資料裡沒有最近紀錄');
  assert.equal(boot.recentMonth, '2026.11');
  assert.ok(boot.cachedAt > 100, '目前月份的最近紀錄：cachedAt 改成現在');
  assert.deepEqual(h.db.get('recent:2026.11').v, recent, '最近紀錄只存在 recent:<月份>');
  assert.deepEqual(h.lsWrites, ['FAST_BOOKKEEPING_IDB_V1'], '大型資料不寫 localStorage（只記一個「IndexedDB 有資料」的記號）');

  const got = h.LC.getBoot();
  assert.deepEqual(got.initialRecent, recent);
  got.initialRecent.fullExpenses.push({ row: 6 });
  data.initialRecent.fullExpenses.push({ row: 7 });
  assert.equal(h.LC.getRecent('2026.11').fullExpenses.length, 1, '呼叫端修改回傳值或原物件都不影響快取');

  // 記一筆：只換最近紀錄；開機資料淺複製改 cachedAt，最近紀錄仍然只有一份
  h.LC.saveRecent('2026.11', Object.assign({}, recent, { fullExpenses: [{ row: 6, amount: 50 }, { row: 5, amount: 120 }] }));
  assert.equal(h.LC.getBoot().initialRecent.fullExpenses.length, 2, 'getBoot 補回的是最新的最近紀錄');
});

test('LocalCache：寫入合併到閒置時間，同一個鍵在一次閒置內只寫最後一份', async () => {
  const h = loadLocalCache();
  await h.LC.whenReady();
  for (let i = 1; i <= 5; i++) h.LC.saveRecent('2026.11', { month: '2026.11', fullExpenses: new Array(i).fill({ amount: 1 }), fullIncomes: [] });
  h.LC.saveOverview({ month: '2026.11', assetTotal: 1 });
  h.LC.saveOverview({ month: '2026.11', assetTotal: 2 });
  assert.equal(h.writes.length, 0, '還沒閒置：一次都沒寫');
  await h.idle();
  assert.equal(h.writes.length, 1, '一次交易寫完');
  const keys = h.writes[0].map(e => e[0]).sort();
  assert.deepEqual(keys, ['overview', 'recent:2026.11']);
  assert.equal(h.db.get('recent:2026.11').v.fullExpenses.length, 5, '寫的是最後一份');
  assert.equal(h.db.get('overview').v.assetTotal, 2);
});

test('LocalCache：淨資產歷史只有改到過去的月份才過期（本月的帳、設定變更不會）', async () => {
  const h = loadLocalCache();
  await h.LC.whenReady();
  assert.equal(h.LC.getNetWorth(), null);
  h.LC.saveNetWorth({ currentMonth: '2026.11', points: [{ month: '2026.10', total: 1 }] });
  h.LC.markStale('2026.11');
  h.LC.markStale();
  assert.equal(h.LC.status('netWorth').stale, false);
  h.LC.markStale('2026.10');
  assert.equal(h.LC.status('netWorth').stale, true);
  assert.equal(h.LC.getNetWorth().points.length, 1, '過期的照樣讀得到（先顯示）');
});

test('LocalCache：記帳後總覽、對帳、預算、之後月份的圖表標成過期（不刪除），拿到新資料時清掉；圖表最多 3 個月', async () => {
  const h = loadLocalCache();
  await h.LC.whenReady();
  h.LC.saveOverview({ month: '2026.11', assetTotal: 1000 });
  h.LC.saveSettlement({ settlementDate: '2026-11-13' });
  h.LC.saveBudgetSettings({ currentMonth: '2026.11', versions: [] });
  h.LC.saveCharts('2026.10', { month: '2026.10' });
  h.LC.saveCharts('2026.11', { month: '2026.11' });
  assert.equal(h.LC.status('overview').stale, false);

  h.LC.markStale('2026.11');
  assert.deepEqual(h.LC.getOverview(), { month: '2026.11', assetTotal: 1000 }, '過期的資料照樣讀得到（先顯示）');
  assert.equal(h.LC.status('overview').stale, true);
  assert.equal(h.LC.status('settlement').stale, true);
  assert.equal(h.LC.status('budget').stale, true);
  assert.equal(h.LC.status('charts', '2026.11').stale, true);
  assert.equal(h.LC.status('charts', '2026.10').stale, false, '之前月份的圖表不受影響');
  await h.idle();
  assert.equal(h.db.get('overview').s, true, '過期標記也寫回（重新開啟後照樣知道要更新）');

  h.LC.saveOverview({ month: '2026.11', assetTotal: 1100 });
  assert.equal(h.LC.status('overview').stale, false, '新資料清掉過期標記');

  h.LC.saveCharts('2026.09', { month: '2026.09' });
  h.LC.saveCharts('2026.08', { month: '2026.08' });
  await h.idle();
  const charts = Array.from(h.db.keys()).filter(k => k.startsWith('charts:'));
  assert.equal(charts.length, 3, '只留最近存的 3 個月');
  assert.ok(charts.includes('charts:2026.08'), '剛存的一定留著');
});

test('LocalCache：開機時讀回 IndexedDB；讀完之前寫入的不會被舊值蓋掉', async () => {
  const h = loadLocalCache({
    holdRead: true,
    db: { overview: { v: { month: '2026.11', assetTotal: 1 }, t: 1, s: true }, 'recent:2026.11': { v: { month: '2026.11', fullExpenses: [] }, t: 1, s: false } },
  });
  assert.equal(h.LC.isReady(), false);
  assert.equal(await h.LC.whenReady(5), false, '逾時：照樣開機');
  h.LC.saveOverview({ month: '2026.11', assetTotal: 2 });
  h.releaseRead();
  assert.equal(await h.LC.whenReady(), true);
  assert.equal(h.LC.getOverview().assetTotal, 2, '讀完之前就存的新值優先');
  assert.deepEqual(h.LC.getRecent('2026.11'), { month: '2026.11', fullExpenses: [] }, '其他鍵從 IndexedDB 讀回');
});

const LEGACY_BOOT = JSON.stringify({
  selectedMonth: '2026.11', months: ['2026.11'], options: { a: 1 }, cachedAt: 50,
  initialRecent: { month: '2026.11', fullExpenses: [{ row: 5 }], fullIncomes: [] },
});
const LEGACY = {
  FAST_BOOKKEEPING_BOOT_V2: LEGACY_BOOT,
  'FAST_BOOKKEEPING_RECENT_V2_2026.10': JSON.stringify({ month: '2026.10', fullExpenses: [], fullIncomes: [] }),
  FAST_BOOKKEEPING_OVERVIEW_V2: JSON.stringify({ month: '2026.11', assetTotal: 9 }),
  'FAST_BOOKKEEPING_CHARTS_V1_2026.11': JSON.stringify({ savedAt: 40, data: { month: '2026.11' } }),
  FAST_BOOKKEEPING_FX_LIST_V1: JSON.stringify({ ledgers: [{ id: 1 }], savedAt: 30 }),
  FAST_BOOKKEEPING_ITEM_PREFS_V1: JSON.stringify({ 午餐: { payment: '現金' } }),
  FAST_BOOKKEEPING_PREFS_V1: JSON.stringify({ motion: 'lite' }),
};

test('LocalCache：第一次啟動把舊的 localStorage 資料搬進 IndexedDB（開機資料拆出最近紀錄），寫入成功後刪除；小型偏好留在 localStorage', async () => {
  const h = loadLocalCache({ legacy: LEGACY });
  await h.LC.whenReady();
  const boot = h.LC.getBoot();
  assert.equal(boot.selectedMonth, '2026.11');
  assert.deepEqual(boot.initialRecent.fullExpenses, [{ row: 5 }], '搬家後照樣讀得到（同一次開機就能用）');
  assert.deepEqual(h.LC.getRecent('2026.10').fullExpenses, []);
  assert.equal(h.LC.getOverview().assetTotal, 9);
  assert.deepEqual(h.LC.getCharts('2026.11'), { month: '2026.11' }, '圖表拆掉舊的 { savedAt, data } 外層');
  assert.equal(h.LC.getFxList().ledgers.length, 1);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.db.get('boot').v.initialRecent, undefined);
  assert.deepEqual(h.db.get('recent:2026.11').v.fullExpenses, [{ row: 5 }]);
  assert.deepEqual(Array.from(h.store.keys()).sort(), ['FAST_BOOKKEEPING_IDB_V1', 'FAST_BOOKKEEPING_ITEM_PREFS_V1', 'FAST_BOOKKEEPING_PREFS_V1'], '舊資料刪除、偏好保留');
});

test('LocalCache：IndexedDB 不能用或寫入失敗時，舊資料照樣讀得到而且不刪除', async () => {
  for (const opt of [{ noIdb: true }, { writeFails: true }]) {
    const h = loadLocalCache(Object.assign({ legacy: LEGACY }, opt));
    await h.LC.whenReady();
    await new Promise(r => setTimeout(r, 0));
    assert.equal(h.LC.getOverview().assetTotal, 9, JSON.stringify(opt));
    assert.ok(h.store.has('FAST_BOOKKEEPING_BOOT_V2'), '沒有成功寫進 IndexedDB 就不刪：' + JSON.stringify(opt));
  }
});

test('LocalCache：IndexedDB 還沒有資料時開機不用等它（mayHaveData）；寫入成功之後才記下來；有舊資料要搬時要等', async () => {
  const h = loadLocalCache();
  assert.equal(h.LC.mayHaveData(), false, '第一次開啟：不等');
  await h.LC.whenReady();
  h.LC.saveOverview({ month: '2026.11' });
  assert.equal(h.LC.mayHaveData(), false, '還沒寫進去');
  await h.idle();
  assert.equal(h.LC.mayHaveData(), true, '寫入成功：下次開機要等它讀完');
  assert.equal(loadLocalCache({ writeFails: true, legacy: { FAST_BOOKKEEPING_PREFS_V1: '{}' } }).LC.mayHaveData(), false);
  assert.equal(loadLocalCache({ legacy: LEGACY }).LC.mayHaveData(), true, '有舊版資料：要等搬家');
});

test('LocalCache：項目偏好沒變就不寫 localStorage（每記一筆都會呼叫）', async () => {
  const h = loadLocalCache();
  h.LC.saveItemPref('午餐', { payment: '現金', category: '生活費' });
  h.LC.saveItemPref('午餐', { payment: '現金', category: '生活費' });
  assert.equal(h.lsWrites.length, 1);
  h.LC.saveItemPref('午餐', { payment: 'Line Pay', category: '生活費' });
  assert.equal(h.lsWrites.length, 2);
});

/* ---------------------------------------------------------------------------
 * 2. core/api.js：合併進行中的讀取、Api.batch
 * ------------------------------------------------------------------------- */
function loadApi(respond) {
  const src = read('scripts/core/api.js');
  const sent = [];
  const ctx = {
    console, navigator: { onLine: true }, crypto: globalThis.crypto, structuredClone,
    document: { dispatchEvent() {} }, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    setTimeout, clearTimeout,
  };
  const runner = handlers => new Proxy({}, {
    get(_, prop) {
      if (prop === 'withSuccessHandler') return fn => runner(Object.assign({}, handlers, { ok: fn }));
      if (prop === 'withFailureHandler') return fn => runner(Object.assign({}, handlers, { fail: fn }));
      return req => { sent.push(JSON.parse(JSON.stringify(req))); respond(req, handlers); };
    },
  });
  ctx.google = { script: { run: runner({}) } };
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.Api = Api;', ctx);
  return { Api: ctx.Api, sent };
}

/** 模擬後端：每個 action 回傳 { action, args }；batchRead 逐項回傳。回應延到下一輪，讓呼叫有機會重疊。 */
function fakeBackend(opts) {
  const o = opts || {};
  return (req, h) => setTimeout(() => {
    if (req.action === 'batchRead') {
      if (o.noBatch) { h.fail(new Error('不支援的操作：batchRead')); return; }
      h.ok(req.args[0].map(r => (r.action === 'getFxRates' ? { ok: false, error: '匯率服務暫時無法使用' } : { ok: true, data: { action: r.action, args: r.args, n: 1 } })));
      return;
    }
    h.ok({ action: req.action, args: req.args, n: 1 });
  }, 0);
}

test('Api：相同的讀取在進行中時只送一次，大家拿到各自的複本；參數不同、寫入不合併', async () => {
  const h = loadApi(fakeBackend());
  const a = h.Api.call('getAssetOverview', false);
  const b = h.Api.call('getAssetOverview', false);
  let chained = null;
  h.Api.server.withSuccessHandler(r => { chained = r; }).getAssetOverview(false);
  const c = h.Api.call('getAssetOverview', true);
  const [ra, rb, rc] = await Promise.all([a, b, c]);
  await new Promise(r => setTimeout(r, 0));
  assert.equal(h.sent.filter(s => s.action === 'getAssetOverview').length, 2, 'false 合併成一次，true 另外一次');
  assert.deepEqual(plain(ra), plain(rb));
  assert.notEqual(ra, rb, '各自一份，修改不會互相影響');
  assert.deepEqual(plain(chained), plain(ra), '鏈式寫法也合併');
  assert.deepEqual(plain(rc.args), [true]);

  await h.Api.call('getAssetOverview', false);
  assert.equal(h.sent.filter(s => s.action === 'getAssetOverview').length, 3, '回來之後再呼叫就重新送');

  await Promise.all([h.Api.call('addExpense', { amount: 1 }), h.Api.call('addExpense', { amount: 1 })]);
  assert.equal(h.sent.filter(s => s.action === 'addExpense').length, 2, '寫入不合併');
});

test('Api.batch：一次 batchRead；每項各自成功或失敗；已在進行中的讀取直接沿用；只剩一項時用一般呼叫', async () => {
  const h = loadApi(fakeBackend());
  const pending = h.Api.call('getBudgetSettings', false);
  const out = await h.Api.batch([
    { action: 'getAssetOverview', args: [false] },
    { action: 'getOverviewCharts', args: ['2026.11', false] },
    { action: 'getBudgetSettings', args: [false] },
    { action: 'getFxRates', args: [] },
  ]);
  await pending;
  const batches = h.sent.filter(s => s.action === 'batchRead');
  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].args[0].map(r => r.action), ['getAssetOverview', 'getOverviewCharts', 'getFxRates'], '進行中的 getBudgetSettings 不重送');
  assert.equal(out.length, 4);
  assert.deepEqual(plain(out.map(r => r.ok)), [true, true, true, false]);
  assert.deepEqual(plain(out[1].data.args), ['2026.11', false]);
  assert.match(out[3].error.message, /匯率服務暫時無法使用/);

  // batch 進行中，單獨的相同讀取會合併進去
  const b2 = h.Api.batch([{ action: 'getAssetOverview', args: [false] }, { action: 'getOverviewCharts', args: ['2026.10', false] }]);
  const single = h.Api.call('getOverviewCharts', '2026.10', false);
  await Promise.all([b2, single]);
  assert.equal(h.sent.filter(s => s.action === 'getOverviewCharts').length, 0, '沒有單獨送出 getOverviewCharts');

  const one = await h.Api.batch([{ action: 'getFxLedgers', args: [false] }]);
  assert.equal(h.sent[h.sent.length - 1].action, 'getFxLedgers', '只有一項：一般呼叫');
  assert.equal(one[0].ok, true);

  const bad = await h.Api.batch([{ action: 'addExpense', args: [{}] }, { action: 'getFxLedgers', args: [true] }]);
  assert.equal(bad[0].ok, false, '寫入不能放進批次');
  assert.equal(h.sent.filter(s => s.action === 'addExpense').length, 0);
});

test('Api.batch：後端還沒有 batchRead（版本不一致）時逐項送出', async () => {
  const h = loadApi(fakeBackend({ noBatch: true }));
  const out = await h.Api.batch([{ action: 'getAssetOverview', args: [false] }, { action: 'getBudgetSettings', args: [false] }]);
  assert.deepEqual(plain(out.map(r => r.ok)), [true, true]);
  assert.deepEqual(h.sent.map(s => s.action), ['batchRead', 'getAssetOverview', 'getBudgetSettings']);
});

/* ---------------------------------------------------------------------------
 * 3. 後端 batchRead
 * ------------------------------------------------------------------------- */
function freshFns(b) {
  return b.runtime.load(fs.readFileSync(path.join(DIST, 'code.gs'), 'utf8'));
}

/** 一次執行（重新載入 code.gs，像 Apps Script 一樣）裡 CacheService 的讀取次數與開試算表的次數。 */
function oneExecution(b, request) {
  const cache = b.runtime.globals.CacheService.getScriptCache();
  const counts = { get: 0, getAll: 0 };
  const origGet = cache.get;
  const origGetAll = cache.getAll;
  cache.get = function (...a) { counts.get++; return origGet.apply(this, a); };
  cache.getAll = function (...a) { counts.getAll++; return origGetAll.apply(this, a); };
  const open0 = b.runtime.stats.openById;
  try {
    const out = JSON.parse(JSON.stringify(freshFns(b).api(request) ?? null));
    return { out, cacheCalls: counts.get + counts.getAll, openById: b.runtime.stats.openById - open0 };
  } finally {
    cache.get = origGet;
    cache.getAll = origGetAll;
  }
}

const OVERVIEW_BATCH = [
  { action: 'getAssetOverview', args: [false] },
  { action: 'getOverviewCharts', args: ['2026.11', false] },
  { action: 'getBudgetSettings', args: [false] },
];

test('batchRead：結果與分開呼叫相同；快取熱的時候整批只呼叫一次 CacheService、不開試算表', () => {
  const b = createBackend();
  b.fns.setup();
  const separate = OVERVIEW_BATCH.map(r => oneExecution(b, r));
  const batch = oneExecution(b, { action: 'batchRead', args: [OVERVIEW_BATCH] });
  assert.deepEqual(batch.out, separate.map(s => ({ ok: true, data: s.out })));
  assert.equal(batch.openById, 0, '快取命中：不開試算表');
  const separateCalls = separate.reduce((a, s) => a + s.cacheCalls, 0);
  assert.ok(separateCalls >= 3, '分開呼叫：每次至少一次 getAll（' + separateCalls + '）');
  assert.equal(batch.cacheCalls, 1, '批次：已知的鍵合成一次 getAll，各操作的讀取都命中記住的值');
});

test('batchRead：快取沒命中時三項共用同一次開啟的試算表', () => {
  const b = createBackend();
  b.fns.setup();
  b.runtime.cache.clear();
  const batch = oneExecution(b, { action: 'batchRead', args: [OVERVIEW_BATCH] });
  assert.deepEqual(batch.out.map(r => r.ok), [true, true, true]);
  assert.ok(batch.openById <= 1, '同一次執行只開一次試算表（' + batch.openById + '）');
});

test('batchRead：只接受唯讀操作，每一項各自回傳成功或失敗；格式不對整批拒絕', () => {
  const b = createBackend();
  const out = b.call('batchRead', [
    { action: 'getAssetOverview', args: [false] },
    { action: 'addExpense', args: [{ month: '2026.11', day: 1, item: 'x', category: '生活費', payment: '現金', amount: 1 }] },
    { action: 'getOverviewCharts', args: ['2026/11'] },
    { action: 'batchRead', args: [[]] },
    'nope',
  ]);
  assert.equal(out.length, 5);
  assert.equal(out[0].ok, true);
  assert.equal(out[0].data.month, '2026.11');
  assert.deepEqual(out.slice(1).map(r => r.ok), [false, false, false, false]);
  assert.match(out[1].error, /批次讀取不支援的操作/);
  assert.equal(b.call('getRecentRecords', '2026.11').expenses.filter(r => r.item === 'x').length, 0, '寫入沒有被執行');
  assert.throws(() => b.call('batchRead', []), /批次讀取的參數格式錯誤/);
  assert.throws(() => b.call('batchRead', new Array(9).fill({ action: 'getFxLedgers' })), /批次讀取的參數格式錯誤/);
  assert.equal(b.fns.apiRoutes_().batchRead.write, undefined, '唯讀權杖也能用');
});

test('前端 READ_ACTIONS 與後端 BATCH_READ_ACTIONS_ 一致（batchRead 本身除外）', () => {
  const b = createBackend();
  const block = read('scripts/core/api.js').match(/READ_ACTIONS = new Set\(\[([\s\S]*?)\]\)/)[1];
  const client = block.match(/'[A-Za-z]+'/g).map(s => s.slice(1, -1)).filter(a => a !== 'batchRead').sort();
  const server = fs.readFileSync(path.join(DIST, 'code.gs'), 'utf8').match(/BATCH_READ_ACTIONS_ = Object\.freeze\(\[([\s\S]*?)\]\)/)[1]
    .match(/'[A-Za-z]+'/g).map(s => s.slice(1, -1)).sort();
  assert.deepEqual(server, client);
  server.forEach(a => assert.ok(b.fns.apiRoutes_()[a] && !b.fns.apiRoutes_()[a].write, a));
});

/* ---------------------------------------------------------------------------
 * 4. 瀏覽器
 * ------------------------------------------------------------------------- */
function shiftedDate(startMs) {
  const offset = startMs - Date.now();
  return class TestDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(Date.now() + offset); }
    static now() { return Date.now() + offset; }
  };
}

function pageInit(cfg) {
  const RealDate = Date;
  const offset = cfg.now - RealDate.now();
  class FixedDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  window.Date = new Proxy(FixedDate, { apply: () => new FixedDate().toString() });
  Object.entries(cfg.legacy || {}).forEach(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} });
  // 記下每一次 api 呼叫（本機替身走 fetch('/__rpc')）
  window.__rpcLog = [];
  const realFetch = window.fetch;
  window.fetch = function (input, init) {
    if (String(input && input.url || input).indexOf('/__rpc') !== -1) {
      try {
        const body = JSON.parse(init && init.body);
        const req = body.args && body.args[0];
        window.__rpcLog.push({ t: performance.now(), action: req && req.action, items: req && req.action === 'batchRead' ? req.args[0].map(r => r.action) : null });
      } catch (e) {}
    }
    return realFetch.apply(this, arguments);
  };
}

async function openApp(browser, opts) {
  const o = opts || {};
  const app = createDevApp({ fixture: true, quiet: true, DateCtor: shiftedDate(FIXED_NOW), latency: o.latency || 0 });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + app.server.address().port + '/';
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  await context.addInitScript(pageInit, { now: FIXED_NOW, legacy: o.legacy || null });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  const boot = async () => {
    await page.goto(url);
    await page.waitForFunction(() => document.documentElement.classList.contains('boot-ready'), null, { timeout: 60000 });
  };
  return { page, context, errors, boot, close: async () => { await context.close(); await new Promise(r => app.server.close(r)); } };
}

let browser = null;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

test('開機後閒置預取：一次 batchRead 讀總覽＋本月圖表＋預算，存進 IndexedDB；切到總覽時已是最新，不再問伺服器', { skip: NO_BROWSER }, async () => {
  const s = await openApp(browser);
  try {
    await s.boot();
    await s.page.waitForFunction(() => window.__rpcLog.some(r => r.action === 'batchRead') && LocalCache.getOverview() && Api.pending() === 0, null, { timeout: 15000 });
    const log = await s.page.evaluate(() => window.__rpcLog.slice());
    const batches = log.filter(r => r.action === 'batchRead');
    assert.equal(batches.length, 1);
    assert.deepEqual(batches[0].items, ['getAssetOverview', 'getOverviewCharts', 'getBudgetSettings', 'getFxLedgers'],
      '開機那一次順便帶上國外帳簿列表（旅行提示用）');
    assert.ok(!log.some(r => ['getAssetOverview', 'getOverviewCharts', 'getBudgetSettings', 'getFxLedgers'].includes(r.action)), '沒有單獨的請求');

    // IndexedDB 裡有資料（閒置時寫回）
    const stored = await s.page.evaluate(async () => {
      await LocalCache.flush();
      const all = await KvStore.readAll();
      return { keys: Array.from(all.keys()).sort(), ls: Object.keys(localStorage).filter(k => /BOOT|RECENT|OVERVIEW|CHARTS/.test(k)) };
    });
    ['boot', 'overview', 'budget', 'charts:2026.11', 'recent:2026.11'].forEach(k => assert.ok(stored.keys.includes(k), 'IndexedDB 有 ' + k));
    assert.deepEqual(stored.ls, [], '大型資料不在 localStorage');

    const before = log.length;
    await s.page.evaluate(() => switchPage('overview'));
    await s.page.waitForTimeout(800);
    const after = await s.page.evaluate(() => ({
      rpc: window.__rpcLog.length,
      hero: Boolean(document.querySelector('#overviewContent .ov-hero')),
      skeleton: Boolean(document.querySelector('#pageOverview .overview-skeleton')),
      charts: Boolean(document.querySelector('#overviewChartsSection .oc-grid')),
    }));
    assert.equal(after.rpc, before, '剛預取過：切到總覽不送任何請求');
    assert.deepEqual([after.hero, after.skeleton, after.charts], [true, false, true]);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('記一筆後立刻切到總覽：立即顯示舊數字（沒有骨架、沒有忙碌條、有「更新中」），寫入回來後只發一個 batchRead，數字更新', { skip: NO_BROWSER }, async () => {
  const s = await openApp(browser, { latency: 600 });
  try {
    await s.boot();
    await s.page.waitForFunction(() => LocalCache.getOverview() && Api.pending() === 0 && DeferredApp.loaded(), null, { timeout: 20000 });
    const oldTotal = await s.page.evaluate(() => LocalCache.getOverview().totalExpense);
    // 本機替身不會重算試算表公式（總覽的數字讀自公式儲存格）：寫入之後的 batchRead 回應裡，
    // 把當月總支出加上這一筆，模擬真實試算表重算後的結果
    let wrote = false;
    await s.context.route(/\/__rpc$/, async route => {
      const req = route.request().postDataJSON();
      const action = req.args && req.args[0] && req.args[0].action;
      if (action === 'addExpense') wrote = true;
      if (!(wrote && action === 'batchRead')) return route.continue();
      const resp = await route.fetch();
      const json = await resp.json();
      const ov = json.result && json.result[0] && json.result[0].data;
      if (ov) ov.totalExpense = '$' + (Number(String(ov.totalExpense).replace(/[^\d.-]/g, '')) + 50);
      return route.fulfill({ response: resp, body: JSON.stringify(json) });
    });

    // 監看總覽頁在切過去之後的每一幀：有沒有出現骨架、忙碌條
    await s.page.evaluate(() => {
      window.__seen = { skeleton: false, busy: false, pill: false };
      const tick = () => {
        if (document.querySelector('#pageOverview .overview-skeleton, #overviewChartsSection .oc-skeleton')) window.__seen.skeleton = true;
        if (document.body.classList.contains('busy')) window.__seen.busy = true;
        if (document.querySelector('#pageOverview .sync-pill.is-on')) window.__seen.pill = true;
        if (!window.__stopWatch) requestAnimationFrame(tick);
      };
      window.__watch = () => requestAnimationFrame(tick);
    });

    await s.page.locator('#expenseItemChoices .choice').first().tap();
    for (const box of ['#expenseCategoryChoices', '#paymentChoices']) {
      if (!(await s.page.locator(box + ' .choice.selected').count())) await s.page.locator(box + ' .choice').first().tap();
    }
    await s.page.locator('#expenseKeypad .key:text-is("5")').tap();
    await s.page.locator('#expenseKeypad .key:text-is("0")').tap();
    const t0 = await s.page.evaluate(() => { window.__rpcLog.length = 0; return performance.now(); });
    await s.page.locator('#expenseSubmit').tap();
    await s.page.evaluate(() => { window.__watch(); switchPage('overview'); });
    await s.page.waitForTimeout(100);
    const immediate = await s.page.evaluate(() => ({
      page: document.body.dataset.page,
      hero: document.querySelector('#overviewContent .ov-hero') ? document.querySelector('#overviewContent .ov-mini-val.negative').textContent : null,
    }));
    assert.equal(immediate.page, 'overview');
    assert.ok(immediate.hero, '立即顯示總覽（舊數字）');

    // 寫入（600ms）＋ batchRead（600ms）之後更新成新數字
    await s.page.waitForFunction(old => {
      const ov = LocalCache.getOverview();
      return ov && ov.totalExpense !== old && Api.pending() === 0;
    }, oldTotal, { timeout: 5000 });
    await s.page.waitForTimeout(900);   // countUp 700ms
    const done = await s.page.evaluate(() => {
      window.__stopWatch = true;
      return {
        log: window.__rpcLog.slice(),
        shown: document.querySelector('#overviewContent .ov-mini-val.negative').textContent.replace(/[^\d]/g, ''),
        expect: String(Math.round(ovParseNum(LocalCache.getOverview().totalExpense))),
        stale: LocalCache.status('overview').stale,
        seen: window.__seen,
        pillOn: Boolean(document.querySelector('#pageOverview .sync-pill.is-on')),
        updatedAt: performance.now(),
      };
    });
    const actions = done.log.map(r => r.action);
    assert.deepEqual(actions, ['addExpense', 'batchRead'], '寫入之後只有一個 batchRead：' + JSON.stringify(actions));
    assert.deepEqual(done.log[1].items, ['getAssetOverview', 'getOverviewCharts', 'getBudgetSettings']);
    assert.ok(done.log[1].t > done.log[0].t, 'batchRead 在寫入之後才送');
    assert.equal(done.shown, done.expect, '畫面上的數字更新成新的');
    assert.equal(done.stale, false);
    assert.equal(done.seen.skeleton, false, '期間沒有骨架');
    assert.equal(done.seen.busy, false, '期間沒有忙碌條');
    assert.equal(done.seen.pill, true, '期間有「更新中」');
    assert.equal(done.pillOn, false, '更新完就收起');
    assert.ok(done.updatedAt - t0 < 2000 + 1200, '寫入回來後 1–2 秒內更新');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('舊版 localStorage 快取：第一次開啟就用得到，搬進 IndexedDB 後刪除；介面偏好留著', { skip: NO_BROWSER }, async () => {
  const overview = { month: '2026.11', assetTotal: '123456', totalIncome: '0', totalExpense: '0', monthBalance: '0' };
  const s = await openApp(browser, { legacy: { FAST_BOOKKEEPING_OVERVIEW_V2: JSON.stringify(overview), FAST_BOOKKEEPING_PREFS_V1: '{"motion":"full"}' } });
  try {
    await s.boot();
    const r = await s.page.evaluate(async () => {
      const first = LocalCache.getOverview();
      await new Promise(res => setTimeout(res, 300));
      const all = await KvStore.readAll();
      return { first, idb: all.has('overview'), ls: Object.keys(localStorage).filter(k => k.startsWith('FAST_BOOKKEEPING_')).sort() };
    });
    assert.ok(r.first && r.first.month === '2026.11', '第一次開機就讀得到舊快取');
    assert.equal(r.idb, true);
    assert.ok(!r.ls.includes('FAST_BOOKKEEPING_OVERVIEW_V2'), '舊鍵已刪除');
    assert.ok(r.ls.includes('FAST_BOOKKEEPING_PREFS_V1'), '偏好留著');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});
