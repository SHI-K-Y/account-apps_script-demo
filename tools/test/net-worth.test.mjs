// 資產軌跡（F06）：淨資產歷史的讀取與快取、_資產快照 的寫入（每日維護觸發器）、過去月份有異動時的過期處理。
// 合成資料的「今天」是 2026-11-13；historyMonths 在 2026.10 之前加幾個月（見 fixture 的 syntheticHistoryMonths）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DIST, createBackend, expenseForm } from './helpers.mjs';
import { createFixtureWorkbook } from '../gas-mock/fixture.mjs';

const SNAPSHOT = '_資產快照';
const DIRTY = 'NET_WORTH_DIRTY_V1';
const DAY = 24 * 3600 * 1000;

const backend = (historyMonths, opts) => createBackend(Object.assign({ workbook: createFixtureWorkbook({ historyMonths }) }, opts));
/** 每次呼叫都像 Apps Script 一樣重新載入 code.gs（量到的才是一次執行的真實次數）。 */
const freshFns = b => b.runtime.load(fs.readFileSync(path.join(DIST, 'code.gs'), 'utf8'));
const freshCall = (b, action, ...args) => JSON.parse(JSON.stringify(freshFns(b).api({ action, args })));
const runDaily = b => b.fns.dailyMaintenance({ triggerUid: b.runtime.triggers.find(t => t.getHandlerFunction() === 'dailyMaintenance').getUniqueId() });
const snapshotRows = b => {
  const s = b.sheet(SNAPSHOT);
  return s && s.getLastRow() > 1 ? s.getRange(2, 1, s.getLastRow() - 1, 6).getValues() : [];
};
const props = b => b.runtime.globals.PropertiesService.getScriptProperties();
const clearCache = b => b.runtime.globals.CacheService.getScriptCache().remove('NET_WORTH_V1');
const setTotals = (b, month, total, living, savings) => {
  b.sheet(month).getRange('S4').setValue(total);
  b.sheet(month).getRange('S17').setValue(living);
  b.sheet(month).getRange('U17').setValue(savings);
};
const measure = (b, fn) => {
  const s = b.runtime.stats;
  const before = { app: s.spreadsheetApp, open: s.openById, reads: s.reads };
  const result = fn();
  return { result, app: s.spreadsheetApp - before.app, open: s.openById - before.open, reads: s.reads - before.reads };
};

test('淨資產歷史：最近 24 個月（含本月）由舊到新，排除舊版面；讀取不寫試算表', () => {
  const b = backend(30);
  const res = b.call('getNetWorthHistory');
  assert.equal(res.currentMonth, '2026.11');
  assert.equal(res.points.length, 24);
  assert.equal(res.points[0].month, '2024.12', '2024.12～2026.11 共 24 個月');
  assert.equal(res.points[23].month, '2026.11');
  assert.deepEqual(res.points[23], { month: '2026.11', total: 12345, living: 5000, savings: 7000, agency: 345 });
  const months = res.points.map(p => p.month);
  assert.deepEqual(months, months.slice().sort());
  assert.ok(res.points.some(p => p.living < 0), '負的累計餘額照樣讀得到');
  assert.equal(b.sheet(SNAPSHOT), null, '讀取不建立快照工作表');
});

test('淨資產歷史：舊版面的月份（2024.10）不列入', () => {
  const b = backend(0);
  b.DateCtor.advance(-300 * DAY); // 2026-01：2024.10 落在 24 個月內，但是舊版面
  const res = b.call('getNetWorthHistory');
  assert.deepEqual(res.points, []);
});

test('淨資產歷史：第一次載入後走快取，不開試算表；記本月的帳之後過完的月份照樣用快取', () => {
  const b = backend(23);
  b.fns.setup();
  clearCache(b);
  freshCall(b, 'getAssetOverview');
  const first = measure(b, () => freshCall(b, 'getNetWorthHistory'));
  const hit = measure(b, () => freshCall(b, 'getNetWorthHistory'));
  assert.equal(hit.open, 0);
  assert.equal(hit.app, 0, '沒有任何 SpreadsheetApp／工作表呼叫');
  assert.deepEqual(hit.result.points, first.result.points);

  freshCall(b, 'addExpense', expenseForm());
  assert.equal(props(b).getProperty(DIRTY), null, '本月的帳不會讓快照過期');
  freshCall(b, 'getAssetOverview');
  assert.equal(measure(b, () => freshCall(b, 'getNetWorthHistory')).app, 0, '只有本月的點重算，歷史不重讀');
});

test('淨資產歷史：快照建好之後，快取過期也只讀快照，不讀月份工作表', () => {
  const b = backend(23);
  const cold = measure(b, () => freshCall(b, 'getNetWorthHistory'));
  b.fns.setup();
  assert.equal(snapshotRows(b).length, 23, 'setup() 把過完的 23 個月補齊');
  assert.equal(b.sheet(SNAPSHOT).isSheetHidden(), true);
  clearCache(b);
  freshCall(b, 'getAssetOverview');
  const warm = measure(b, () => freshCall(b, 'getNetWorthHistory'));
  assert.ok(warm.reads <= 2, '快照一次讀回（實際 ' + warm.reads + ' 次）');
  assert.ok(cold.reads > 23, '沒有快照時要逐月讀（實際 ' + cold.reads + ' 次）');
  assert.deepEqual(warm.result.points, cold.result.points);
});

test('快照：每月 1 日的每日維護寫入上個月；沒有要做的事就不寫', () => {
  const b = backend(3);
  b.fns.setup();
  assert.deepEqual(snapshotRows(b).map(r => r[0]), ['2026.07', '2026.08', '2026.09', '2026.10']);
  const step = () => runDaily(b).steps.find(s => s.step === 'netWorthSnapshot').result;
  assert.deepEqual(step(), { written: 0, skipped: [] });

  setTotals(b, '2026.11', 20000, 6000, 13000);
  b.DateCtor.advance(18 * DAY); // 2026-12-01
  assert.deepEqual(step(), { written: 1, skipped: [] });
  const last = snapshotRows(b).pop();
  assert.deepEqual(last.slice(0, 5), ['2026.11', 20000, 6000, 13000, 345]);
  assert.ok(last[5] instanceof Date);
  assert.equal(b.call('getNetWorthHistory').points.pop().total, 20000, '換月後快取不沿用，上個月補進歷史');
});

test('快照：改到過去的月份後，那個月起改讀工作表；下一次每日維護重寫並清掉標記', () => {
  const b = backend(5);
  b.fns.setup();
  const before = b.call('getNetWorthHistory').points;
  b.call('addExpense', expenseForm({ month: '2026.09' }));
  assert.equal(props(b).getProperty(DIRTY), '2026.09');
  setTotals(b, '2026.08', 111, 1, 1);      // 比標記早的月份：照樣用快照
  setTotals(b, '2026.09', 90000, 4000, 85655);
  setTotals(b, '2026.10', 91000, 4100, 86555);
  const after = b.call('getNetWorthHistory').points;
  const at = (list, m) => list.find(p => p.month === m);
  assert.equal(at(after, '2026.08').total, at(before, '2026.08').total);
  assert.equal(at(after, '2026.09').total, 90000);
  assert.equal(at(after, '2026.10').total, 91000);

  b.call('addExpense', expenseForm({ month: '2026.10' }));
  assert.equal(props(b).getProperty(DIRTY), '2026.09', '標記只會往前，不會往後');
  runDaily(b);
  assert.equal(props(b).getProperty(DIRTY), null);
  assert.deepEqual(snapshotRows(b).filter(r => r[0] >= '2026.09').map(r => r[1]), [90000, 91000]);
  assert.equal(snapshotRows(b).length, 6);
});

test('快照：超過一批的過期月份分批重寫完，標記也清掉', () => {
  const b = backend(23);
  b.fns.setup();
  b.fns.onEdit({ range: b.sheet('2025.01').getRange('G5') });
  assert.equal(props(b).getProperty(DIRTY), '2025.01', '直接改試算表也會標記');
  assert.equal(runDaily(b).steps.find(s => s.step === 'netWorthSnapshot').result.written, 22);
  assert.equal(props(b).getProperty(DIRTY), null);
});

test('快照：公式錯誤的月份不寫、不畫；修好之後補上', () => {
  const b = backend(2);
  b.sheet('2026.09').getRange('S4').setValue('#REF!');
  b.fns.setup();
  assert.deepEqual(snapshotRows(b).map(r => r[0]), ['2026.08', '2026.10']);
  assert.ok(!b.call('getNetWorthHistory').points.some(p => p.month === '2026.09'));
  b.sheet('2026.09').getRange('S4').setValue(5000);
  runDaily(b);
  assert.deepEqual(snapshotRows(b).map(r => r[0]), ['2026.08', '2026.09', '2026.10']);
});

test('快照：不動到既有的工作表', () => {
  const b = backend(4);
  const others = () => JSON.stringify(b.runtime.snapshot().filter(s => s.name !== SNAPSHOT && s.name !== '_月份彙總'));
  const before = others();
  b.fns.setup();
  runDaily(b);
  b.call('getNetWorthHistory', true);
  assert.equal(others(), before);
});
