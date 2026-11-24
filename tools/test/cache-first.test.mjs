// 讀取類 API 先查快取、時間觸發器預熱（P11）：
//   1. 快取命中時 getAssetOverview／getOverviewCharts（以及其他讀取 API）不開試算表（openById 0 次），
//      圖表命中時不解整份 OPTIONS_ALL，預算用同一次 getAll 讀到的明細算
//   2. 全站固定時區：不呼叫 Session.getScriptTimeZone()／getSpreadsheetTimeZone()
//   3. settings metadata：不用 getProperties()，只讀需要的鍵；圖片索引；舊儲存格只清一次
//   4. warmCaches：只接受本專案觸發器的事件或擁有者直接執行；setup() 安裝（不重複）；預熱後早上第一次開啟全部命中
//   5. 偵錯計時：timing: true 時印出 [api-timing]
// 每次呼叫都像 Apps Script 一樣重新載入 code.gs（全域變數、試算表 memo 都是新的），量到的才是一次執行的真實次數。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DIST, createBackend } from './helpers.mjs';

const SETTINGS = '資料選單設定區';
const OPTIONS_ALL_KEY = 'OPTIONS_ALL_V3';

function freshFns(b) {
  return b.runtime.load(fs.readFileSync(path.join(DIST, 'code.gs'), 'utf8'));
}

function freshCall(b, action, ...args) {
  return JSON.parse(JSON.stringify(freshFns(b).api({ action, args }) ?? null));
}

/** fn 執行期間的服務呼叫次數：試算表（SpreadsheetApp／工作表／讀範圍）、指令碼屬性、快取讀取的鍵。 */
function measure(b, fn) {
  const s = b.runtime.stats;
  const before = { app: s.spreadsheetApp, open: s.openById, reads: s.reads };
  const props = b.runtime.globals.PropertiesService.getScriptProperties();
  const cache = b.runtime.globals.CacheService.getScriptCache();
  const out = { propGets: [], propAll: 0, propKeys: 0, cacheKeys: [] };
  const wraps = [
    [props, 'getProperty', (k) => out.propGets.push(k)],
    [props, 'getProperties', () => out.propAll++],
    [props, 'getKeys', () => out.propKeys++],
    [cache, 'get', (k) => out.cacheKeys.push(k)],
    [cache, 'getAll', (keys) => out.cacheKeys.push(...keys)],
  ].map(([obj, name, spy]) => {
    const orig = obj[name];
    obj[name] = function (...args) { spy(...args); return orig.apply(this, args); };
    return () => { obj[name] = orig; };
  });
  try {
    out.result = fn();
  } finally {
    wraps.forEach(r => r());
  }
  out.app = s.spreadsheetApp - before.app;
  out.openById = s.openById - before.open;
  out.reads = s.reads - before.reads;
  return out;
}

/** 已經跑過 setup()（指令碼屬性有 SPREADSHEET_ID、觸發器已安裝、快取已預熱）的後端。 */
function setUpBackend(options) {
  const b = createBackend(options);
  b.fns.setup();
  return b;
}

/* ----------------------------- 1. 快取命中不開試算表 ----------------------------- */

test('getAssetOverview：快取命中時不開試算表（openById 0 次），也不讀時區與指令碼屬性（除了允許名單）', () => {
  const b = setUpBackend();
  const expected = freshCall(b, 'getAssetOverview', true);
  const hit = measure(b, () => freshCall(b, 'getAssetOverview'));
  assert.equal(hit.openById, 0);
  assert.equal(hit.app, 0, '沒有任何 SpreadsheetApp／工作表呼叫');
  assert.deepEqual(hit.propGets, ['ALLOWED_EMAILS'], '只有權限檢查讀了指令碼屬性');
  assert.deepEqual(hit.result, expected);
  assert.equal(hit.result.month, '2026.11', '月份用固定的台北時間');

  // 對照：快取沒命中時才開試算表（確認計數有效）
  b.runtime.cache.delete('OVERVIEW_V3_2026.11');
  const miss = measure(b, () => freshCall(b, 'getAssetOverview'));
  assert.equal(miss.openById, 1);
  assert.deepEqual(miss.result, expected);
});

test('getAssetOverview：本月工作表還沒建立時用最新月份的快取，也不開試算表', () => {
  const b = setUpBackend();
  // 模擬月份清單裡沒有本月（月初還沒建立工作表）：清單快取只有 2026.10
  b.runtime.cache.set('MONTHS_LIST_V2', JSON.stringify(['2026.10', '2024.10']));
  b.runtime.cache.delete('OVERVIEW_V3_2026.11');
  const first = measure(b, () => freshCall(b, 'getAssetOverview'));
  assert.equal(first.result.month, '2026.10');
  assert.equal(first.openById, 1, '第一次：2026.10 的總覽沒有快取，讀工作表');
  const second = measure(b, () => freshCall(b, 'getAssetOverview'));
  assert.equal(second.openById, 0, '之後命中 2026.10 的快取');
  assert.deepEqual(second.result, first.result);
});

test('getOverviewCharts：快取命中時不開試算表、不讀 OPTIONS_ALL，預算用同一次讀到的明細算', () => {
  const b = setUpBackend();
  b.call('saveBudgetSettings', { month: '2026.11', source: 'balance', categories: ['生活費'], reserves: [] });
  const expected = freshCall(b, 'getOverviewCharts', '2026.11', true);
  freshCall(b, 'getOverviewCharts', '2026.11'); // 存好圖表快取

  const hit = measure(b, () => freshCall(b, 'getOverviewCharts', '2026.11'));
  assert.equal(hit.openById, 0);
  assert.equal(hit.app, 0);
  assert.ok(!hit.cacheKeys.includes(OPTIONS_ALL_KEY), '沒有讀整份 OPTIONS_ALL');
  assert.ok(hit.cacheKeys.includes('OPTIONS_SIMPLE_V1'));
  assert.deepEqual(hit.propGets, ['ALLOWED_EMAILS']);
  const strip = r => Object.assign({}, r, { generatedAt: 0 });
  assert.deepEqual(strip(hit.result), strip(expected));
  assert.equal(hit.result.budget.source, 'balance');
  assert.ok(Number.isFinite(hit.result.budget.remaining));

  // 簡易選項不在快取時：沿用圖表快取裡的分類，照樣不開試算表、不解 OPTIONS_ALL
  b.runtime.cache.delete('OPTIONS_SIMPLE_V1');
  const noSimple = measure(b, () => freshCall(b, 'getOverviewCharts', '2026.11'));
  assert.equal(noSimple.app, 0);
  assert.ok(!noSimple.cacheKeys.includes(OPTIONS_ALL_KEY));
  assert.deepEqual(noSimple.result.categories, expected.categories);
});

test('getOverviewCharts：記帳之後預算立即反映（命中圖表快取時也用最新明細）', () => {
  const b = setUpBackend();
  b.call('saveBudgetSettings', { month: '2026.11', source: 'fixed', amount: 30000, categories: ['生活費'], reserves: [] });
  freshCall(b, 'getOverviewCharts', '2026.11');
  const before = freshCall(b, 'getOverviewCharts', '2026.11').budget.spent;
  freshCall(b, 'addExpense', { month: '2026.11', day: 13, item: '午餐', category: '生活費', payment: '現金', paid: '', amount: 500, note: '' });
  const after = freshCall(b, 'getOverviewCharts', '2026.11').budget.spent;
  assert.equal(after - before, 500);
});

test('其他讀取 API：預熱後快取命中時都不開試算表', () => {
  const b = setUpBackend();
  const ledgerId = freshCall(b, 'getFxLedgers').ledgers[0].id;
  freshCall(b, 'getFxLedgerData', ledgerId); // 匯率快取不在預熱範圍：先讀一次
  const calls = {
    getInitialData: () => freshCall(b, 'getInitialData'),
    getRecentRecords: () => freshCall(b, 'getRecentRecords', '2026.11', 8, 8),
    getFullRecords: () => freshCall(b, 'getFullRecords', '2026.11', 'all'),
    getSettingsOptions: () => freshCall(b, 'getSettingsOptions'),
    getBudgetSettings: () => freshCall(b, 'getBudgetSettings'),
    getFxLedgers: () => freshCall(b, 'getFxLedgers'),
    getFxLedgerData: () => freshCall(b, 'getFxLedgerData', ledgerId),
    getFxRates: () => freshCall(b, 'getFxRates', ledgerId),
    getCreditCardRecords: () => freshCall(b, 'getCreditCardRecords', ['2026.11', '2026.10']),
    searchRecords: () => freshCall(b, 'searchRecords', { months: ['2026.11', '2026.10'], keyword: '午餐' }),
  };
  // 信用卡對帳與搜尋會讀很多月份（版面判斷與明細快取不在預熱範圍）：先各呼叫一次，量第二次（命中）
  calls.getCreditCardRecords();
  calls.searchRecords();
  Object.keys(calls).forEach(name => {
    const m = measure(b, calls[name]);
    assert.equal(m.app, 0, name + ' 沒有開試算表');
    assert.deepEqual(m.propGets, ['ALLOWED_EMAILS'], name + ' 只讀了允許名單');
  });
});

test('getBudgetSettings：結果與強制重讀相同；生活費餘額的月初餘額從快取拿', () => {
  const b = setUpBackend();
  b.call('saveBudgetSettings', { month: '2026.11', source: 'balance', categories: ['生活費'], reserves: [] });
  const forced = freshCall(b, 'getBudgetSettings', true);
  const hit = measure(b, () => freshCall(b, 'getBudgetSettings'));
  assert.equal(hit.app, 0);
  assert.deepEqual(hit.result, forced);
  assert.equal(hit.result.status.source, 'balance');
});

/* ------------------------------- 2. 固定時區 ------------------------------- */

test('時區：全站固定 Asia/Taipei，不呼叫 Session.getScriptTimeZone() 與 getSpreadsheetTimeZone()', () => {
  const b = createBackend();
  const session = b.runtime.globals.Session;
  const ss = b.runtime.spreadsheet;
  let calls = 0;
  const origSession = session.getScriptTimeZone;
  const origSheet = ss.getSpreadsheetTimeZone;
  session.getScriptTimeZone = () => { calls++; return 'Asia/Taipei'; };
  ss.getSpreadsheetTimeZone = () => { calls++; return 'Asia/Taipei'; };
  try {
    // 日期格式的儲存格（cellToStr_ 遇到 Date）：國外帳簿的日期欄
    const init = freshCall(b, 'getInitialData', true);
    assert.equal(init.timeZone, 'Asia/Taipei');
    freshCall(b, 'getFullRecords', '2026.11', 'all', true);
    freshCall(b, 'getAssetOverview', true);
    const ledgerId = freshCall(b, 'getFxLedgers', true).ledgers[0].id;
    const fx = freshCall(b, 'getFxLedgerData', ledgerId, true);
    assert.equal(fx.records[0].date, '2025-03-12');
    assert.equal(freshFns(b).cellToStr_(new b.DateCtor(Date.UTC(2026, 10, 12, 16, 0, 0))), '2026-11-13', '台北時間 11/13 00:00');
  } finally {
    session.getScriptTimeZone = origSession;
    ss.getSpreadsheetTimeZone = origSheet;
  }
  assert.equal(calls, 0);
});

test('setup()：試算表時區不是台北時在訊息裡提醒', () => {
  const b = createBackend();
  b.runtime.spreadsheet.getSpreadsheetTimeZone = () => 'Asia/Tokyo';
  assert.match(b.fns.setup().message, /試算表時區是 Asia\/Tokyo/);
  const ok = createBackend();
  assert.doesNotMatch(ok.fns.setup().message, /時區/);
});

/* ----------------------------- 3. settings metadata ----------------------------- */

// 用 svg+xml 型別：後端只認 data:image/*;base64 格式，內容是假的；避開外流掃描對點陣圖（png/webp…）的攔截。
const IMG = 'data:image/svg+xml;base64,' + 'A'.repeat(3000);

test('metadata：不用 getProperties()，只讀本體、圖片索引與用得到的圖片', () => {
  const b = createBackend();
  const fns = freshFns(b);
  const meta = fns.getSettingsMetadata_();
  meta.cards[0].customImage = IMG;
  meta.banks[0].customLogo = IMG.replace('A', 'B');
  assert.equal(fns.saveSettingsMetadata_(meta), true);
  const props = b.runtime.properties;
  const index = JSON.parse(props.get('SETTINGS_IMAGE_INDEX_V1'));
  assert.deepEqual(index, ['IMG_BANK_' + meta.banks[0].id, 'IMG_CARD_' + meta.cards[0].id]);
  props.set('UNRELATED_BIG_PROP', 'x'.repeat(8000));
  props.set('IMG_CARD_card_not_in_meta', IMG);

  const read = measure(b, () => freshFns(b).getSettingsMetadata_());
  assert.equal(read.propAll, 0, '沒有呼叫 getProperties()');
  assert.equal(read.propKeys, 0, '有索引時也不用 getKeys()');
  assert.ok(!read.propGets.includes('UNRELATED_BIG_PROP'));
  assert.ok(!read.propGets.includes('IMG_CARD_card_not_in_meta'), '索引外的圖片不讀');
  assert.equal(read.result.cards[0].customImage, IMG);
  assert.equal(read.result.banks[0].customLogo, IMG.replace('A', 'B'));
  assert.equal(read.app, 0, '已遷移：沒有開試算表檢查舊儲存格');
});

test('metadata：舊版沒有圖片索引時用 getKeys() 建一次；儲存時也不用 getProperties()，並刪掉不用的圖片', () => {
  const b = createBackend();
  const fns = freshFns(b);
  const meta = fns.getSettingsMetadata_();
  fns.saveSettingsMetadata_(meta);
  const cardId = meta.cards[0].id;
  b.runtime.properties.delete('SETTINGS_IMAGE_INDEX_V1');
  b.runtime.properties.set('IMG_CARD_' + cardId, IMG);   // 舊版存的圖片（沒有索引）
  b.runtime.properties.set('IMG_BANK_bank_gone', IMG);   // 已經刪掉的銀行

  const first = measure(b, () => freshFns(b).getSettingsMetadata_());
  assert.equal(first.propKeys, 1);
  assert.equal(first.result.cards[0].customImage, IMG);
  assert.deepEqual(JSON.parse(b.runtime.properties.get('SETTINGS_IMAGE_INDEX_V1')).sort(), ['IMG_BANK_bank_gone', 'IMG_CARD_' + cardId]);
  assert.equal(measure(b, () => freshFns(b).getSettingsMetadata_()).propKeys, 0, '第二次直接用索引');

  const save = measure(b, () => freshFns(b).saveSettingsMetadata_(first.result));
  assert.equal(save.propAll, 0);
  assert.equal(b.runtime.properties.has('IMG_BANK_bank_gone'), false, '不用的圖片刪掉');
  assert.deepEqual(JSON.parse(b.runtime.properties.get('SETTINGS_IMAGE_INDEX_V1')), ['IMG_CARD_' + cardId]);
  // 透過設定頁的 API 走一次完整流程
  const opts = measure(b, () => freshCall(b, 'getSettingsOptions', true));
  assert.equal(opts.propAll, 0);
  assert.equal(opts.result.metadata.cards[0].customImage, IMG);
});

test('cleanLegacySheetMetadataCells_：只清一次，第二次之後不再讀試算表', () => {
  const b = createBackend();
  const settings = b.sheet(SETTINGS);
  settings.getRange('O1').setValue('{"legacy":true,"base64":"xx"}');
  assert.equal(b.runtime.properties.get('LEGACY_META_CLEANED'), undefined);

  const first = measure(b, () => freshFns(b).cleanLegacySheetMetadataCells_());
  assert.ok(first.reads > 0, '第一次讀了 O1:Q1');
  assert.equal(settings.getRange('O1').getValue(), '', '舊資料清掉了');
  assert.equal(b.runtime.properties.get('LEGACY_META_CLEANED'), '1');

  for (let i = 0; i < 2; i++) {
    const again = measure(b, () => freshFns(b).cleanLegacySheetMetadataCells_());
    assert.equal(again.app, 0, '沒有 SpreadsheetApp／工作表呼叫');
    assert.equal(again.reads, 0, '沒有讀範圍');
    assert.equal(again.openById, 0);
  }
  // 已遷移之後即使有人又在 O1 放了東西也不再碰（只做一次）
  settings.getRange('O1').setValue('{"later":true}');
  freshFns(b).cleanLegacySheetMetadataCells_();
  assert.equal(settings.getRange('O1').getValue(), '{"later":true}');
});

test('舊版 metadata 只在試算表 P1:Q1：先存進指令碼屬性再清儲存格，資料不會遺失', () => {
  const b = createBackend();
  const settings = b.sheet(SETTINGS);
  const legacy = { emojis: { 午餐: '🍱' }, cards: [{ id: 'card_old', name: '舊卡', type: 'credit', channels: ['信用卡'] }], banks: [] };
  settings.getRange('P1').setValue(JSON.stringify(legacy));
  settings.getRange('Q1').setValue(JSON.stringify({ card_old: IMG }));

  const meta = freshFns(b).getSettingsMetadata_();
  assert.equal(meta.cards[0].name, '舊卡');
  assert.equal(meta.cards[0].customImage, IMG);
  assert.equal(settings.getRange('P1').getValue(), '', '清掉了');
  assert.equal(b.runtime.properties.get('LEGACY_META_CLEANED'), '1');
  assert.ok(b.runtime.properties.has('SETTINGS_METADATA_V2'), '存進指令碼屬性');

  const again = measure(b, () => freshFns(b).getSettingsMetadata_());
  assert.equal(again.app, 0);
  assert.equal(again.result.cards[0].name, '舊卡');
  assert.equal(again.result.cards[0].customImage, IMG);
  assert.equal(again.result.emojis.午餐, '🍱');
});

test('啟動快照（BOOT_SNAPSHOT）放不下時存不含圖片的精簡版', () => {
  const b = createBackend();
  const fns = freshFns(b);
  const meta = fns.getSettingsMetadata_();
  meta.cards[0].customImage = IMG;
  meta.cards[1].customImage = IMG;
  meta.banks[0].customLogo = IMG;
  fns.saveSettingsMetadata_(meta);
  b.runtime.properties.delete('BOOT_SNAPSHOT_V2');
  const full = freshCall(b, 'getInitialData', true);
  assert.equal(full.settingsMetadata.cards[0].customImage, IMG, '回應本身照樣有圖片');
  const snap = b.runtime.properties.get('BOOT_SNAPSHOT_V2');
  assert.ok(snap, '快照有存進去');
  assert.ok(Buffer.byteLength(snap) <= 9 * 1024);
  const parsed = JSON.parse(snap);
  assert.equal(parsed.settingsMetadata.cards[0].customImage, undefined);
  assert.equal(parsed.settingsMetadata.cards[0].name, full.settingsMetadata.cards[0].name);
  assert.ok(!snap.includes('base64,AAAA'));
});

/* ------------------------------- 4. warmCaches ------------------------------- */

const WARM_KEYS = [
  'BOOT_INIT_JSON_V2', 'MONTH_DATA_V2_2026.11', 'MONTH_DATA_V2_2026.10', 'OVERVIEW_V3_2026.11', 'CHARTS_V2_2026.11',
  'BUDGET_CONFIG_V1', 'BUDGET_OPENING_V1_2026.11', 'FX_LEDGERS_V1', 'DOGET_CONFIG_V1', 'OPTIONS_ALL_V3', 'OPTIONS_SIMPLE_V1',
  'MONTHS_LIST_V2', 'SPREADSHEET_ID_V1',
];

test('setup()：安裝每 2 小時一次的 warmCaches 觸發器，重跑不會重複', () => {
  const b = createBackend();
  const first = b.fns.setup();
  assert.equal(b.runtime.triggers.length, 1);
  const t = b.runtime.triggers[0];
  assert.equal(t.getHandlerFunction(), 'warmCaches');
  assert.equal(t.spec.type, 'CLOCK');
  assert.equal(t.spec.everyHours, 2);
  assert.equal(first.warmTriggerId, t.getUniqueId());
  assert.ok(Number.isFinite(first.warmMs));

  b.fns.setup();
  assert.equal(b.runtime.triggers.length, 1, '先刪掉同名的舊觸發器');
  assert.notEqual(b.runtime.triggers[0].getUniqueId(), t.getUniqueId());
});

test('warmCaches：只接受本專案觸發器的事件或擁有者直接執行', () => {
  const owner = setUpBackend();
  const uid = owner.runtime.triggers[0].getUniqueId();
  const rejected = [
    { triggerUid: '12345' },                // 偽造的觸發器 ID
    { triggerUid: '' },
    { authMode: 'FULL' },                    // 沒有 triggerUid 的物件
    'warm', 1, true,                         // google.script.run 傳了別的參數
  ];
  rejected.forEach(e => {
    owner.runtime.clearCache();
    assert.equal(freshFns(owner).warmCaches(e), undefined, JSON.stringify(e));
    assert.equal(owner.runtime.cache.size, 0, '沒有做任何事：' + JSON.stringify(e));
  });

  // 不是擁有者（網頁上的其他使用者）：沒參數也不行；但本專案觸發器的事件可以（觸發器以擁有者身分執行）
  const stranger = createBackend({ activeUserEmail: 'someone@example.com' });
  stranger.runtime.properties.set('SPREADSHEET_ID', stranger.runtime.spreadsheet.getId());
  assert.equal(freshFns(stranger).warmCaches(), undefined);
  assert.equal(stranger.runtime.cache.size, 0);
  const fakeTrigger = stranger.runtime.globals.ScriptApp.newTrigger('warmCaches').timeBased().everyHours(2).create();
  const otherHandler = stranger.runtime.globals.ScriptApp.newTrigger('somethingElse').timeBased().everyHours(1).create();
  assert.equal(freshFns(stranger).warmCaches({ triggerUid: otherHandler.getUniqueId() }), undefined, '別的處理函式的觸發器 ID 不算');
  assert.ok(freshFns(stranger).warmCaches({ triggerUid: fakeTrigger.getUniqueId() }).steps.length > 0);

  owner.runtime.clearCache();
  const viaTrigger = freshFns(owner).warmCaches({ triggerUid: uid, authMode: 'FULL' });
  assert.ok(viaTrigger && viaTrigger.steps.length);
  owner.runtime.clearCache();
  assert.ok(freshFns(owner).warmCaches().steps.length, '擁有者在編輯器執行（沒有參數）');
});

test('warmCaches：重建所有開頁與總覽用的快取，每一步都成功並印出耗時', () => {
  const b = setUpBackend();
  b.call('saveBudgetSettings', { month: '2026.11', source: 'balance', categories: ['生活費'], reserves: [] });
  b.runtime.clearCache();
  b.runtime.properties.delete('BOOT_SNAPSHOT_V2');
  const uid = b.runtime.triggers[0].getUniqueId();
  const summary = freshFns(b).warmCaches({ triggerUid: uid });
  assert.deepEqual(summary.steps.filter(s => s.error), [], '沒有失敗的步驟');
  assert.deepEqual(summary.steps.map(s => s.step), ['budget', 'boot', 'month:2026.10', 'overview', 'charts', 'fxLedgers', 'config']);
  WARM_KEYS.forEach(k => assert.ok(b.runtime.cache.has(k), '預熱了 ' + k));
  assert.ok(b.runtime.properties.has('BOOT_SNAPSHOT_V2'), '更新了備援快照');
  assert.ok(b.logs.some(l => l.includes('[warmCaches]') && l.includes('totalMs')));
});

test('warmCaches：doGet 設定快取的存活時間撐到下一次預熱', () => {
  const b = setUpBackend();
  const cache = b.runtime.globals.CacheService.getScriptCache();
  const ttls = {};
  const orig = cache.put;
  cache.put = function (k, v, ttl) { ttls[k] = ttl; return orig.call(this, k, v, ttl); };
  try {
    freshFns(b).warmCaches({ triggerUid: b.runtime.triggers[0].getUniqueId() });
  } finally {
    cache.put = orig;
  }
  assert.ok(ttls.DOGET_CONFIG_V1 > 2 * 3600, 'TTL ' + ttls.DOGET_CONFIG_V1);
  assert.ok(ttls.DOGET_CONFIG_V1 <= 6 * 3600);
});

test('預熱後早上第一次開啟：doGet、總覽、圖表都命中快取，不開試算表', () => {
  const b = setUpBackend();
  b.call('saveBudgetSettings', { month: '2026.11', source: 'balance', categories: ['生活費'], reserves: [] });
  // 晚上：快取全部過期，只剩觸發器
  b.runtime.clearCache();
  freshFns(b).warmCaches({ triggerUid: b.runtime.triggers[0].getUniqueId() });

  const page = measure(b, () => freshFns(b).doGet({ parameter: { timing: '1' } }).getContent());
  assert.equal(page.app, 0, 'doGet 沒有開試算表');
  const log = b.logs.filter(l => l.includes('[doGet] ')).pop();
  const t = JSON.parse(log.slice(log.indexOf('{')));
  assert.equal(t.bootHit, true);
  assert.equal(t.monthHit, true);
  assert.equal(t.configHit, true);
  assert.equal(t.budgetPending, false);
  const boot = JSON.parse(page.result.match(/window\.__INITIAL_DATA__ = (.*);/)[1]);
  assert.equal(boot.fromFreshCache, true);
  assert.equal(boot.initialRecent.budget.source, 'balance');

  ['getAssetOverview', 'getOverviewCharts', 'getBudgetSettings', 'getFxLedgers'].forEach(action => {
    const m = measure(b, () => freshCall(b, action, ...(action === 'getOverviewCharts' ? ['2026.11'] : [])));
    assert.equal(m.openById, 0, action);
    assert.equal(m.app, 0, action);
  });
});

/* ------------------------------- 5. 偵錯計時 ------------------------------- */

test('偵錯計時：doGet 開了計時時頁面帶 debugTiming，API 帶 timing 時印出 [api-timing]', () => {
  const b = setUpBackend();
  const html = freshFns(b).doGet({ parameter: { timing: '1' } }).getContent();
  assert.equal(JSON.parse(html.match(/window\.__INITIAL_DATA__ = (.*);/)[1]).debugTiming, true);
  const plain = freshFns(b).doGet().getContent();
  assert.equal(JSON.parse(plain.match(/window\.__INITIAL_DATA__ = (.*);/)[1]).debugTiming, undefined);
  assert.ok(!String(b.runtime.properties.get('BOOT_SNAPSHOT_V2') || '').includes('debugTiming'), '不寫進快照');

  const before = b.logs.length;
  freshFns(b).api({ action: 'getAssetOverview', args: [] });
  assert.ok(!b.logs.slice(before).some(l => l.includes('[api-timing]')), '沒帶 timing 不印');

  freshFns(b).api({ action: 'getAssetOverview', args: [], timing: true });
  const line = b.logs.filter(l => l.includes('[api-timing]')).pop();
  const info = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(info.action, 'getAssetOverview');
  assert.equal(info.spreadsheet, false, '命中快取');
  assert.equal(info.ok, true);
  assert.equal(info.write, false);
  assert.ok(Number.isFinite(info.totalMs) && Number.isFinite(info.handlerMs));

  b.runtime.cache.delete('OVERVIEW_V3_2026.11');
  freshFns(b).api({ action: 'getAssetOverview', args: [], timing: true });
  const miss = b.logs.filter(l => l.includes('[api-timing]')).pop();
  assert.equal(JSON.parse(miss.slice(miss.indexOf('{'))).spreadsheet, true);

  assert.throws(() => freshFns(b).api({ action: 'nope', args: [], timing: true }), /不支援的操作/);
  const failed = b.logs.filter(l => l.includes('[api-timing]')).pop();
  assert.equal(JSON.parse(failed.slice(failed.indexOf('{'))).ok, false);
});

test('前端：doGet 開了計時之後，Api 的每個呼叫都帶 timing', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/client/scripts/core/api.js'), 'utf8');
  assert.match(src, /__INITIAL_DATA__\.debugTiming/);
  assert.match(src, /timing: true/);
});
