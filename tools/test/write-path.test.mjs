// 記帳寫入路徑（P10）：冪等（opId）、批次寫入、差量回應、鎖外工作與前端合併。
//   1. 同一個 opId 送兩次只寫入一列，第二次回傳上次的結果（replayed）
//   2. addRecords 批次寫入的結果與逐筆寫入相同（包含不連續的空白列、混合支出／收入、各筆各自成功或失敗）
//   3. 差量回應：300 筆的月份單筆回應 ≤ 2 KB；full: true 與 HTTP API 仍是舊的完整格式
//   4. 前端把差量合併進整月清單（新增／修改／刪除遞補／標記已繳），結果和後端的整月明細相同
//   5. 快取都熱的時候，寫入不讀寫指令碼屬性；彙總標記、備援快照移出寫入路徑
//   6. core/api.js：帶 opId 的寫入遇到暫時性錯誤會用同一個 opId 自動重試一次
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, DIST, createBackend, expenseForm, incomeForm } from './helpers.mjs';

const WRITE = 'w'.repeat(32);
const ledger = (b, month) => {
  const r = b.call('getFullRecords', month || '2026.11', 'all', true);
  return { expenses: r.expenses, incomes: r.incomes };
};
const bytes = obj => Buffer.byteLength(JSON.stringify(obj), 'utf8');

/** 像 Apps Script 一樣每次執行都重新載入（全域變數、試算表 memo 都是新的），量到的才是一次執行的真實呼叫次數。 */
function freshCall(b, action, ...args) {
  const fns = b.runtime.load(fs.readFileSync(path.join(DIST, 'code.gs'), 'utf8'));
  return JSON.parse(JSON.stringify(fns.api({ action, args }) ?? null));
}

/** 包一層計數：PropertiesService 與 CacheService 每種呼叫各幾次。 */
function countServices(b) {
  const props = b.runtime.globals.PropertiesService.getScriptProperties();
  const cache = b.runtime.globals.CacheService.getScriptCache();
  const counts = { propKeys: [] };
  const wrap = (obj, name, label) => {
    const orig = obj[name];
    obj[name] = function (...args) {
      counts[label] = (counts[label] || 0) + 1;
      if (label === 'propGet') counts.propKeys.push(args[0]);
      return orig.apply(this, args);
    };
    return () => { obj[name] = orig; };
  };
  const restores = [
    wrap(props, 'getProperty', 'propGet'), wrap(props, 'setProperty', 'propSet'), wrap(props, 'deleteProperty', 'propDelete'),
    wrap(cache, 'get', 'cacheGet'), wrap(cache, 'getAll', 'cacheGetAll'), wrap(cache, 'put', 'cachePut'),
    wrap(cache, 'putAll', 'cachePutAll'), wrap(cache, 'remove', 'cacheRemove'), wrap(cache, 'removeAll', 'cacheRemoveAll'),
  ];
  return { counts, restore: () => restores.forEach(r => r()) };
}

/* ---------------------------------- 冪等 ---------------------------------- */

test('冪等：同一個 opId 送兩次只寫入一列，第二次回傳上次的結果', () => {
  const b = createBackend();
  const form = expenseForm({ amount: 321, note: '只寫一次', opId: 'op-test-0001' });
  const first = b.call('addExpense', form);
  const before = ledger(b);
  const second = b.call('addExpense', form);
  assert.equal(first.row, 13);
  assert.equal(second.row, 13, '回傳上次的列號');
  assert.equal(second.replayed, true);
  assert.equal(first.replayed, undefined);
  assert.deepEqual(second.record, first.record);
  assert.deepEqual(ledger(b), before, '沒有寫入第二列');
  assert.deepEqual(b.rowValues('2026.11', 14, 'B', 7), ['', '', '', '', '', '', '']);
  assert.equal(before.expenses.filter(r => r.note === '只寫一次').length, 1);

  // 快取被清掉（明細）時重送也不會重寫：冪等結果另外存
  b.runtime.cache.delete('MONTH_DATA_V2_2026.11');
  assert.equal(b.call('addExpense', form).row, 13);
  assert.equal(ledger(b).expenses.length, before.expenses.length);

  // 不同的 opId、沒有 opId、格式不合法的 opId 都照常寫入
  assert.equal(b.call('addExpense', expenseForm({ opId: 'op-test-0002' })).row, 14);
  assert.equal(b.call('addExpense', expenseForm({})).row, 15);
  assert.equal(b.call('addExpense', expenseForm({ opId: 'bad id!' })).row, 16);
  assert.equal(b.call('addExpense', expenseForm({ opId: 'bad id!' })).row, 17, '不合法的 opId 當作沒有');
});

test('冪等：修改、刪除、標記已繳重送都不會重做', () => {
  const b = createBackend();
  const upd = expenseForm({ row: 6, amount: 999, opId: 'op-update-1' });
  b.call('updateExpense', upd);
  b.call('updateExpense', expenseForm({ row: 6, amount: 500 }));    // 之後又有人改成 500
  assert.equal(b.call('updateExpense', upd).replayed, true);
  assert.equal(b.rowValues('2026.11', 6, 'B', 7)[5], 500, '重送舊的修改不會蓋掉之後的修改');

  const del = { month: '2026.11', row: 6, opId: 'op-delete-1' };
  b.call('deleteExpense', del);
  const afterOne = ledger(b);
  const again = b.call('deleteExpense', del);
  assert.equal(again.replayed, true);
  assert.deepEqual(ledger(b), afterOne, '重送刪除不會再刪掉遞補上來的那一筆');

  const paid = { month: '2026.11', row: 5, paid: 'O', opId: 'op-paid-1' };
  b.call('markCreditCardPaid', paid);
  b.call('markCreditCardPaid', { month: '2026.11', row: 5, paid: 'X' });
  assert.equal(b.call('markCreditCardPaid', paid).replayed, true);
  assert.equal(b.sheet('2026.11').getRange('F5').getValue(), 'X');

  const batch = { month: '2026.11', rows: [5, 9], paid: 'O', opId: 'op-batch-1' };
  assert.deepEqual(b.call('batchMarkCreditCardPaid', batch).rows, [5, 9]);
  b.call('markCreditCardPaid', { month: '2026.11', row: 9, paid: 'X' });
  assert.equal(b.call('batchMarkCreditCardPaid', batch).replayed, true);
  assert.equal(b.sheet('2026.11').getRange('F9').getValue(), 'X');
});

/* ---------------------------------- 批次 ---------------------------------- */

function batchForms() {
  return [
    Object.assign(expenseForm({ amount: 11, note: 'b1' }), { type: 'expense', opId: 'batch-op-01' }),
    Object.assign(incomeForm({ amount: 22, note: 'b2' }), { type: 'income', opId: 'batch-op-02' }),
    Object.assign(expenseForm({ amount: 33, note: 'b3', payment: '信用卡-測試一卡', paid: 'X' }), { type: 'expense', opId: 'batch-op-03' }),
    Object.assign(expenseForm({ amount: 44, note: '=1+1', day: 2 }), { type: 'expense', opId: 'batch-op-04' }),
    Object.assign(incomeForm({ amount: 55, note: 'b5', day: 3 }), { type: 'income', opId: 'batch-op-05' }),
  ];
}

function sequential(b, forms) {
  return forms.map(f => {
    const { type, ...form } = f;
    return b.call(type === 'income' ? 'addIncome' : 'addExpense', form);
  });
}

test('批次寫入：5 筆的結果與逐筆寫入相同（試算表內容、列號、回傳的紀錄）', () => {
  [false, true].forEach(withGap => {
    const one = createBackend();
    const many = createBackend();
    if (withGap) {
      // 先在中間挖一個洞（直接清掉第 7、9 列）：空白列不連續，批次要分段寫
      [one, many].forEach(b => {
        b.sheet('2026.11').getRange('B7:H7').clearContent();
        b.sheet('2026.11').getRange('B9:H9').clearContent();
        b.runtime.clearCache();
      });
    }
    const seq = sequential(one, batchForms());
    const res = many.call('addRecords', batchForms());
    assert.equal(res.ok, true);
    assert.deepEqual(res.results.map(r => r.ok), [true, true, true, true, true]);
    assert.deepEqual(res.results.map(r => r.row), seq.map(r => r.row), '列號相同' + (withGap ? '（有空洞）' : ''));
    assert.deepEqual(res.results.map(r => r.record), seq.map(r => r.record));
    assert.deepEqual(res.results.map(r => r.opId), batchForms().map(f => f.opId));
    assert.deepEqual(many.runtime.snapshot(), one.runtime.snapshot(), '整本試算表相同');
    assert.deepEqual(ledger(many), ledger(one));
    // 快取裡的明細也和試算表一致（下一筆會寫到同一列）
    assert.equal(many.call('addExpense', expenseForm({})).row, one.call('addExpense', expenseForm({})).row);
    assert.deepEqual(res.months['2026.11'].counts, { expenses: ledger(one).expenses.length - 1, incomes: ledger(one).incomes.length });
  });
});

test('批次寫入：各筆各自成功或失敗、重送不重寫、可跨月份', () => {
  const b = createBackend();
  const forms = [
    Object.assign(expenseForm({ amount: 10 }), { type: 'expense', opId: 'mix-op-001' }),
    Object.assign(expenseForm({ item: '不存在' }), { type: 'expense', opId: 'mix-op-002' }),
    Object.assign(expenseForm({ month: '2026.10', day: 31, amount: 20 }), { type: 'expense', opId: 'mix-op-003' }),
    Object.assign(expenseForm({}), { type: 'transfer', opId: 'mix-op-004' }),
    Object.assign(expenseForm({ amount: 30 }), { type: 'expense', opId: 'mix-op-001' }), // 同一批重複的 opId
    'not a form',
  ];
  const res = b.call('addRecords', forms);
  assert.deepEqual(res.results.map(r => r.ok), [true, false, true, false, true, false]);
  assert.match(res.results[1].error, /不在「資料選單設定區」/);
  assert.match(res.results[3].error, /expense 或 income/);
  assert.equal(res.results[4].replayed, true);
  assert.equal(res.results[4].row, res.results[0].row, '重複的 opId 拿第一筆的結果');
  assert.equal(res.results[2].month, '2026.10');
  assert.deepEqual(Object.keys(res.months).sort(), ['2026.10', '2026.11']);
  const count11 = ledger(b).expenses.length;

  const again = b.call('addRecords', forms);
  assert.ok(again.results.filter(r => r.ok).every(r => r.replayed), '整批重送：成功過的都直接回傳');
  assert.equal(ledger(b).expenses.length, count11);

  assert.throws(() => b.call('addRecords', []), /沒有要寫入的紀錄/);
  assert.throws(() => b.call('addRecords', Array.from({ length: 51 }, () => ({}))), /最多寫入 50 筆/);
  assert.equal(b.call('addRecords', forms, { full: true }).months['2026.11'].recent.fullExpenses.length, count11);
});

/* -------------------------------- 回應格式 -------------------------------- */

function backendWith300() {
  const b = createBackend({ properties: { API_TOKEN: WRITE } });
  // 預算設定成最大的格式（有預留項目），回應裡的 budget 也是最大的樣子
  b.call('saveBudgetSettings', { month: '2026.11', source: 'fixed', amount: 30000, categories: ['生活費'], reserves: [{ item: '房租', amount: 12000 }] });
  const forms = Array.from({ length: 300 }, (_, i) => Object.assign(expenseForm({
    day: (i % 30) + 1, amount: 100 + i, note: '第 ' + i + ' 筆的備註文字',
  }), { type: 'expense' }));
  for (let i = 0; i < forms.length; i += 50) b.call('addRecords', forms.slice(i, i + 50));
  assert.ok(ledger(b).expenses.length >= 300);
  return b;
}

test('差量回應：300 筆的月份單筆回應 ≤ 2 KB，含新紀錄、每日合計與預算', () => {
  const b = backendWith300();
  const results = { add: b.call('addExpense', expenseForm({ amount: 77, note: '一筆普通的午餐', opId: 'size-op-001' })) };
  const afterAdd = ledger(b);
  assert.deepEqual(results.add.counts, { expenses: afterAdd.expenses.length, incomes: afterAdd.incomes.length });
  results.addIncome = b.call('addIncome', incomeForm({}));
  results.update = b.call('updateExpense', expenseForm({ row: results.add.row, amount: 88, note: '改過的備註' }));
  results.paid = b.call('markCreditCardPaid', { month: '2026.11', row: 5, paid: 'O' });
  results.batchPaid = b.call('batchMarkCreditCardPaid', { month: '2026.11', rows: [5, 6, 7, 8, 9, 10], paid: 'O' });
  results.del = b.call('deleteExpense', { month: '2026.11', row: results.add.row });
  results.replay = b.call('addExpense', expenseForm({ amount: 77, note: '一筆普通的午餐', opId: 'size-op-001' }));

  Object.entries(results).forEach(([name, res]) => {
    assert.ok(bytes(res) <= 2048, name + ' 回應 ' + bytes(res) + ' bytes');
    assert.equal(res.recent, undefined, name + ' 沒有整月清單');
    assert.equal(res.ok, true);
  });
  const add = results.add;
  assert.equal(add.op, 'add');
  assert.equal(add.record.note, '一筆普通的午餐');
  assert.ok(add.dailyExpenses[13].count >= 10);
  assert.equal(add.budget.amount, 30000);
  assert.ok(Array.isArray(add.budget.reserves));

  // 舊的完整格式：full: true、或 HTTP API（iOS 捷徑）沒指定時
  const full = b.call('addExpense', expenseForm({ full: true }));
  assert.ok(bytes(full) > 20 * 1024, '完整格式含整月清單');
  assert.equal(full.op, undefined);
  assert.equal(full.recent.expenses.length, 8);
  assert.equal(full.recent.fullExpenses[0].row, full.row);
  assert.equal(full.recent.budget.amount, 30000);

  const http = b.post({ token: WRITE, action: 'addExpense', args: [expenseForm({ amount: 66 })] });
  assert.equal(http.ok, true);
  // opId（F05）：沒送 opId 的 HTTP 呼叫端也拿得到伺服器產生的 opId，可以用 undoRecordOp 復原
  assert.deepEqual(Object.keys(http.data).sort(), ['month', 'ok', 'opId', 'recent', 'record', 'row', 'type']);
  assert.equal(http.data.recent.fullExpenses[0].row, http.data.row);
  const httpDelta = b.post({ token: WRITE, action: 'deleteExpense', args: [{ month: '2026.11', row: http.data.row, full: false }] });
  assert.equal(httpDelta.data.recent, undefined, 'HTTP API 帶 full: false 時是差量格式');
  assert.ok(bytes(httpDelta) <= 2048);
  // HTTP API 之後的一般呼叫照舊是差量（旗標只在那一次執行有效）
  assert.equal(b.call('addExpense', expenseForm({})).recent, undefined);
});

/* ------------------------------ 前端合併差量 ------------------------------ */

function loadClientMerge() {
  const src = fs.readFileSync(path.join(ROOT, 'src/client/scripts/bookkeeping/submit.js'), 'utf8');
  const ctx = { console, LocalCache: { getRecent: () => null }, state: {}, getMonth: () => '2026.11' };
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  return ctx;
}

test('前端合併差量：新增、修改、刪除（下方遞補）、標記已繳後，和後端的整月明細相同', () => {
  const client = loadClientMerge();
  const b = createBackend();
  const init = b.call('getInitialData', true).initialRecent;
  let local = { month: '2026.11', fullExpenses: init.fullExpenses, fullIncomes: init.fullIncomes, budget: init.budget };
  client.LocalCache.getRecent = () => local;
  const apply = res => {
    const out = client.resolveMutationRecent(res, '2026.11');
    assert.ok(out.recent, res.op + ' 可以合併');
    assert.equal(out.stale, false, res.op + ' 筆數和後端一致');
    local = out.recent;
    const server = ledger(b);
    assert.deepEqual(JSON.parse(JSON.stringify(local.fullExpenses)), server.expenses, res.op + ' 支出相同');
    assert.deepEqual(JSON.parse(JSON.stringify(local.fullIncomes)), server.incomes, res.op + ' 收入相同');
    assert.deepEqual(JSON.parse(JSON.stringify(local.expenses)), server.expenses.slice(0, 8));
    assert.deepEqual(local.dailyExpenses, res.dailyExpenses);
    assert.deepEqual(local.budget, res.budget);
  };

  apply(b.call('addExpense', expenseForm({ amount: 10 })));
  apply(b.call('addIncome', incomeForm({ amount: 20 })));
  apply(b.call('updateExpense', expenseForm({ row: 7, amount: 30, note: '改' })));
  apply(b.call('deleteExpense', { month: '2026.11', row: 6 }));
  apply(b.call('deleteIncome', { month: '2026.11', row: 5 }));
  apply(b.call('markCreditCardPaid', { month: '2026.11', row: 5, paid: 'O' }));
  apply(b.call('batchMarkCreditCardPaid', { month: '2026.11', rows: [5, 6, 8], paid: 'X' }));
  apply(b.call('deleteExpense', { month: '2026.11', row: 5 }));
  apply(b.call('addExpense', expenseForm({ amount: 40 })));

  // 本機清單比後端舊（例如另一台裝置記過帳）：筆數對不上，標示要重新讀取
  b.call('addExpense', expenseForm({ amount: 50 }));
  const out = client.resolveMutationRecent(b.call('addExpense', expenseForm({ amount: 60 })), '2026.11');
  assert.equal(out.stale, true);

  // 舊格式照樣接受；沒有可合併的清單時回傳 null（呼叫端會重新讀取）
  const full = b.call('addExpense', expenseForm({ full: true }));
  assert.equal(client.resolveMutationRecent(full, '2026.11').recent, full.recent);
  client.LocalCache.getRecent = () => null;
  assert.equal(client.resolveMutationRecent(b.call('addExpense', expenseForm({})), '2026.11').recent, null);
});

/* ------------------------------ 鎖外與指令碼屬性 ------------------------------ */

test('快取都熱的時候：記帳不寫指令碼屬性、只讀存取名單，快取只有 2 次 getAll、1 次 putAll', () => {
  const b = createBackend({ properties: { SPREADSHEET_ID: 'mock-spreadsheet-id' } });
  freshCall(b, 'getInitialData', true);
  freshCall(b, 'addExpense', expenseForm({}));     // 第一次：標記彙總、建立各種快取
  const ops = {
    addExpense: () => freshCall(b, 'addExpense', expenseForm({ opId: 'warm-op-0001' })),
    addIncome: () => freshCall(b, 'addIncome', incomeForm({})),
    updateExpense: () => freshCall(b, 'updateExpense', expenseForm({ row: 6, amount: 1 })),
    markCreditCardPaid: () => freshCall(b, 'markCreditCardPaid', { month: '2026.11', row: 5, paid: 'O' }),
    batchMarkCreditCardPaid: () => freshCall(b, 'batchMarkCreditCardPaid', { month: '2026.11', rows: [5, 6], paid: 'O' }),
    deleteExpense: () => freshCall(b, 'deleteExpense', { month: '2026.11', row: 6 }),
    replay: () => freshCall(b, 'addExpense', expenseForm({ opId: 'warm-op-0001' })),
  };
  Object.entries(ops).forEach(([name, run]) => {
    const spy = countServices(b);
    const s = b.runtime.stats;
    const logRows = () => { const sh = b.sheet('_操作紀錄'); return sh ? sh.getLastRow() : 0; };
    const before = { reads: s.reads, writes: s.writes, logRows: logRows() };
    try { run(); } finally { spy.restore(); }
    const c = spy.counts;
    // 唯一的屬性讀取是 API 閘道的存取檢查（ALLOWED_EMAILS 刻意每次現讀，名單改了立即生效）
    assert.deepEqual(c.propKeys, ['ALLOWED_EMAILS'], name + ' 只讀存取名單（試算表 ID 從快取來）');
    assert.equal((c.propSet || 0) + (c.propDelete || 0), 0, name + ' 不寫指令碼屬性');
    assert.equal(c.cacheGet || 0, 0, name + ' 沒有個別的 cache.get');
    assert.equal(c.cacheGetAll, 2, name + ' 鎖外 1 次＋鎖內 1 次 getAll');
    assert.equal(c.cachePutAll || 0, name === 'replay' ? 0 : 1, name + ' 只有 1 次 putAll');
    assert.ok(s.reads - before.reads <= 2, name + ' 試算表讀取 ' + (s.reads - before.reads) + ' 次');
    // 批次標記是一次 getRangeList(['F5','F6']).setValue()（模擬環境每個範圍各算一次）；
    // 另外每次寫入都有 1 次操作紀錄的 appendRow（F05：同一個鎖內、一次寫完），重送不再記
    const maxWrites = name === 'replay' ? 0 : (name === 'batchMarkCreditCardPaid' ? 2 : 1) + 1;
    assert.ok(s.writes - before.writes <= maxWrites, name + ' 試算表寫入 ' + (s.writes - before.writes) + ' 次');
    assert.equal(logRows() - before.logRows, name === 'replay' ? 0 : 1, name + ' 操作紀錄多 1 列');
  });
});

test('彙總標記：已標記的月份不碰指令碼屬性；重建（取消標記）之後下一筆會再標記', () => {
  const b = createBackend();
  const dirty = () => JSON.parse(b.runtime.properties.get('SUMMARY_DIRTY_V1') || '[]');
  b.call('addExpense', expenseForm({}));
  assert.ok(dirty().includes('2026.11'));
  b.fns.unmarkSummaryDirty_(['2026.11']);
  assert.ok(!dirty().includes('2026.11'));
  b.call('addExpense', expenseForm({}));
  assert.ok(dirty().includes('2026.11'), '鏡像跟著取消，下一筆照樣標記');

  // 快取被清掉（鏡像不見）時退回讀屬性
  b.runtime.clearCache();
  b.call('addExpense', expenseForm({ month: '2026.10', day: 3 }));
  assert.deepEqual(dirty().sort(), ['2026.10', '2026.11']);
});

test('備援快照：記帳不寫指令碼屬性的 BOOT_SNAPSHOT，doGet 命中時最多 30 分鐘更新一次', () => {
  const b = createBackend();
  b.call('getInitialData', true);
  const snapshot = () => JSON.parse(b.runtime.properties.get('BOOT_SNAPSHOT_V2'));
  const first = b.runtime.properties.get('BOOT_SNAPSHOT_V2');
  const added = b.call('addExpense', expenseForm({ amount: 4321, note: '快照測試' }));
  assert.equal(b.runtime.properties.get('BOOT_SNAPSHOT_V2'), first, '寫入路徑不更新快照');

  b.fns.doGet();                                    // 命中、還沒有更新紀錄 → 更新
  assert.equal(snapshot().initialRecent.fullExpenses[0].row, added.row);
  b.call('addExpense', expenseForm({ amount: 1, note: '第二筆' }));
  b.fns.doGet();
  assert.notEqual(snapshot().initialRecent.fullExpenses[0].note, '第二筆', '30 分鐘內不再更新');
  b.DateCtor.advance(31 * 60 * 1000);
  b.fns.doGet();
  assert.equal(snapshot().initialRecent.fullExpenses[0].note, '第二筆', '超過 30 分鐘再更新');
});

test('啟動資料：記帳不更新 BOOT_JSON，但 getInitialData 與 doGet 都拿到最新清單；明細快取沒有時 doGet 標成要同步', () => {
  const b = createBackend();
  b.call('getInitialData', true);
  const added = b.call('addExpense', expenseForm({ amount: 999, note: '最新' }));
  const cached = b.call('getInitialData', false);
  assert.equal(cached.fromFreshCache, true);
  assert.equal(cached.initialRecent.fullExpenses[0].row, added.row);
  assert.equal(cached.initialRecent.expenses[0].note, '最新');

  b.runtime.cache.delete('MONTH_DATA_V2_2026.11');
  const html = b.fns.doGet().getContent();
  const boot = JSON.parse(html.match(/window\.__INITIAL_DATA__ = (.*);/)[1]);
  assert.equal(boot.fromFreshCache, false, '清單可能比較舊：前端要背景同步');
  const synced = b.call('getInitialData', false);
  assert.equal(synced.initialRecent.fullExpenses[0].note, '最新', '背景同步從工作表重讀');
});

test('試算表 ID：從快取讀，setup() 之後更新', () => {
  const b = createBackend({ properties: { SPREADSHEET_ID: 'mock-spreadsheet-id' } });
  freshCall(b, 'getRecentRecords', '2026.11', 8, 8, true);
  assert.equal(b.runtime.cache.get('SPREADSHEET_ID_V1'), 'mock-spreadsheet-id', '第一次從屬性讀、存進快取');
  const spy = countServices(b);
  try { freshCall(b, 'getRecentRecords', '2026.11', 8, 8, true); } finally { spy.restore(); }
  assert.ok(!spy.counts.propKeys.includes('SPREADSHEET_ID'), '之後從快取讀');
  b.runtime.cache.set('SPREADSHEET_ID_V1', 'stale-id');
  b.fns.setup();
  assert.equal(b.runtime.cache.get('SPREADSHEET_ID_V1'), 'mock-spreadsheet-id', 'setup() 之後快取是新的 ID');
});

test('選項：記帳驗證讀小的 OPTIONS_SIMPLE；選項改了之後一起失效', () => {
  const b = createBackend();
  b.call('getInitialData', true);
  assert.ok(b.runtime.cache.has('OPTIONS_SIMPLE_V1'));
  b.runtime.cache.delete('OPTIONS_ALL_V3');           // 只剩簡易選項也能驗證
  assert.equal(b.call('addExpense', expenseForm({})).ok, true);
  assert.ok(!b.runtime.cache.has('OPTIONS_ALL_V3'), '驗證沒有去讀（重建）整份選項');
  b.fns.invalidateOptionsCache_();
  assert.ok(!b.runtime.cache.has('OPTIONS_SIMPLE_V1'));
  assert.equal(b.call('addExpense', expenseForm({})).ok, true);
  assert.ok(b.runtime.cache.has('OPTIONS_SIMPLE_V1'), '沒命中時重建並存回');
});

/* ------------------------------ 前端自動重試 ------------------------------ */

function loadApi(script) {
  const src = fs.readFileSync(path.join(ROOT, 'src/client/scripts/core/api.js'), 'utf8');
  const sent = [];
  const timers = [];
  const ctx = {
    console, navigator: { onLine: true }, crypto: globalThis.crypto,
    document: { dispatchEvent() {} }, CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o && o.detail; } },
    setTimeout: (fn) => { timers.push(fn); return timers.length; }, clearTimeout() {},
  };
  ctx.google = { script: { run: null } };
  const runner = (handlers) => new Proxy({}, {
    get(_, prop) {
      if (prop === 'withSuccessHandler') return fn => runner(Object.assign({}, handlers, { ok: fn }));
      if (prop === 'withFailureHandler') return fn => runner(Object.assign({}, handlers, { fail: fn }));
      return req => { sent.push(JSON.parse(JSON.stringify(req))); script(sent.length, req, handlers); };
    },
  });
  ctx.google.script.run = runner({});
  vm.createContext(ctx);
  vm.runInContext(src + '\nthis.Api = Api;', ctx);
  return { Api: ctx.Api, sent, flush: () => { while (timers.length) timers.shift()(); } };
}

test('core/api.js：帶 opId 的寫入遇到暫時性錯誤，用同一個 opId 自動重試一次', async () => {
  const h = loadApi((n, req, handlers) => {
    if (n === 1) handlers.fail(new Error('NetworkError: Connection failure due to HTTP 0'));
    else handlers.ok({ ok: true, row: 13 });
  });
  const form = expenseForm({});
  const p = h.Api.call('addExpense', form);
  h.flush();
  assert.deepEqual(await p, { ok: true, row: 13 });
  assert.equal(h.sent.length, 2, '重試一次');
  assert.match(h.sent[0].args[0].opId, /^[0-9a-f-]{32,36}$/);
  assert.equal(h.sent[1].args[0].opId, h.sent[0].args[0].opId, '重試沿用同一個 opId');
  assert.equal(form.opId, undefined, '不改呼叫端的表單');

  // 批次：每筆各自有 opId
  const hb = loadApi((n, req, handlers) => handlers.ok({ ok: true }));
  await hb.Api.call('addRecords', [expenseForm({}), incomeForm({ opId: 'keep-this-id' })]);
  const forms = hb.sent[0].args[0];
  assert.ok(forms[0].opId && forms[0].opId !== forms[1].opId);
  assert.equal(forms[1].opId, 'keep-this-id', '已經有 opId 的不換');

  // 不是暫時性錯誤、或是不支援 opId 的寫入：不重試
  const hv = loadApi((n, req, handlers) => handlers.fail(new Error('金額必須是大於 0 的數字。')));
  await assert.rejects(hv.Api.call('addExpense', expenseForm({})), /金額必須是大於 0/);
  hv.flush();
  assert.equal(hv.sent.length, 1);
  const hs = loadApi((n, req, handlers) => handlers.fail(new Error('NetworkError: HTTP 0')));
  const ps = hs.Api.call('saveQuickCombos', []);
  hs.flush();
  await assert.rejects(ps);
  assert.equal(hs.sent.length, 1, '其他寫入照舊不重試');
  assert.equal(hs.sent[0].args[0].opId, undefined);
});
