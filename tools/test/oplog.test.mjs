// 操作紀錄與復原（F05）：src/server/24_oplog.gs、13_daily.gs，以及 21_records.gs 寫入時記下的紀錄。
//   1. 刪除中間一筆再復原：所有列回到原位，公式欄、收入區塊不受影響（整張工作表與刪除前完全相同）
//   2. 修改後被另一台裝置再改過：復原提示衝突、不覆蓋；沒被改過就寫回修改前的值
//   3. 標記已繳（單筆／整批）的復原與衝突；同一筆不能復原兩次；復原請求本身冪等
//   4. 操作紀錄：欄位、來源（web／api／trigger）、批次一次寫入、寫紀錄失敗不影響記帳
//   5. getOpLog 清單與依舊紀錄還原（列號之後變了也找得到；新增的還原＝刪除）
//   6. 每日維護觸發器：只保留最近 2,000 筆；setup() 安裝一次、重跑不重複；只接受觸發器或擁有者
//   7. 前端合併 restore／paid 復原的差量，和後端的整月明細相同
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, DIST, createBackend, expenseForm, incomeForm } from './helpers.mjs';

const MONTH = '2026.11';
const LOG = '_操作紀錄';

const ledger = b => {
  const r = b.call('getFullRecords', MONTH, 'all', true);
  return { expenses: r.expenses, incomes: r.incomes };
};
/** 整張工作表的內容（值＋公式＋格式），用來確認復原之後一格都沒變。 */
const snapshot = (b, name) => JSON.stringify(Array.from(b.sheet(name || MONTH).cells.entries())
  .filter(([, c]) => c.v !== '' || c.f)
  .sort(([a], [b2]) => (a < b2 ? -1 : a > b2 ? 1 : 0)));
const logRows = b => {
  const sh = b.sheet(LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  return sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
};
const lastLog = b => logRows(b).slice(-1)[0];
const undo = (b, undoOf, extra) => b.call('undoRecordOp', Object.assign({ undoOf, month: MONTH }, extra));

/* ----------------------------- 1. 刪除與復原 ----------------------------- */

test('刪除中間某一筆再復原：所有列回到原位，公式欄與收入區塊不受影響', () => {
  const b = createBackend();
  const before = snapshot(b);
  const listBefore = ledger(b);
  const formulas = [];
  for (let r = 5; r <= 20; r++) formulas.push(b.sheet(MONTH).getRange('I' + r).getFormula());

  const del = b.call('deleteExpense', { month: MONTH, row: 7, opId: 'op-del-mid-01' });
  assert.equal(del.opId, 'op-del-mid-01', '回應帶 opId');
  assert.deepEqual(b.rowValues(MONTH, 7, 'B', 7), [2, '其他', '存款', '轉帳-測試銀行', '', 10000, '筆電分期'], '下方往上遞補');

  const res = undo(b, 'op-del-mid-01', { opId: 'op-undo-mid-01' });
  assert.equal(res.ok, true);
  assert.equal(res.op, 'restore');
  assert.equal(res.row, 7);
  assert.equal(res.undoOf, 'op-del-mid-01');
  assert.deepEqual(res.record, listBefore.expenses.find(r => r.row === 7));
  assert.deepEqual(res.counts, { expenses: 8, incomes: 2 });

  assert.equal(snapshot(b), before, '整張工作表（含 I 欄公式、收入、總覽區）和刪除前完全相同');
  for (let r = 5; r <= 20; r++) assert.equal(b.sheet(MONTH).getRange('I' + r).getFormula(), formulas[r - 5], 'I' + r + ' 公式');
  assert.deepEqual(ledger(b), listBefore, '整月明細相同');
  // 鎖內就地更新的明細快取和重讀工作表的結果相同
  assert.deepEqual(b.call('getFullRecords', MONTH, 'all', false).expenses, listBefore.expenses);
});

test('復原刪除：插回原位而不是附加到最後；最後一筆、收入、期間又有新增的情況', () => {
  // 最後一筆：刪除是清空，復原寫回同一列
  const a = createBackend();
  const snapA = snapshot(a);
  a.call('deleteExpense', { month: MONTH, row: 12, opId: 'op-del-last-1' });
  assert.equal(undo(a, 'op-del-last-1').row, 12);
  assert.equal(snapshot(a), snapA);

  // 收入區塊
  const c = createBackend();
  const snapC = snapshot(c);
  c.call('deleteIncome', { month: MONTH, row: 5, opId: 'op-del-inc-1' });
  assert.deepEqual(c.rowValues(MONTH, 5, 'K', 5)[1], '薪資');
  undo(c, 'op-del-inc-1');
  assert.equal(snapshot(c), snapC);

  // 刪除之後又記了一筆（寫進空出來的最後一列）：復原插回原位，新的那筆跟著往下移、不會被蓋掉
  const d = createBackend();
  d.call('deleteExpense', { month: MONTH, row: 6, opId: 'op-del-then-add' });
  const added = d.call('addExpense', expenseForm({ amount: 77, note: '之後新增' }));
  assert.equal(added.row, 12);
  const res = undo(d, 'op-del-then-add');
  assert.equal(res.row, 6);
  assert.deepEqual(d.rowValues(MONTH, 6, 'B', 7), [1, '晚餐', '生活費', '現金', '', 175, '']);
  assert.deepEqual(d.rowValues(MONTH, 13, 'B', 7), [13, '午餐', '生活費', '現金', '', 77, '之後新增']);
  assert.equal(ledger(d).expenses.length, 9);
});

/* ------------------------------ 2. 修改與衝突 ------------------------------ */

test('復原修改：寫回修改前的值；另一台裝置又改過時提示衝突、不覆蓋', () => {
  const b = createBackend();
  const original = b.rowValues(MONTH, 8, 'B', 7);
  const before = snapshot(b);
  b.call('updateExpense', expenseForm({ row: 8, amount: 999, note: '改過', opId: 'op-upd-ok-01' }));
  const res = undo(b, 'op-upd-ok-01');
  assert.equal(res.op, 'update');
  assert.equal(res.row, 8);
  assert.equal(res.record.amount, 10000);
  assert.deepEqual(b.rowValues(MONTH, 8, 'B', 7), original);
  assert.equal(snapshot(b), before);

  // 衝突：修改之後另一台裝置把同一列改成別的內容
  b.call('updateExpense', expenseForm({ row: 8, amount: 300, opId: 'op-upd-cf-01' }));
  b.call('updateExpense', expenseForm({ row: 8, amount: 555, note: '另一台裝置' }));
  const other = b.rowValues(MONTH, 8, 'B', 7);
  assert.throws(() => undo(b, 'op-upd-cf-01'), /^Error: 衝突：/);
  assert.deepEqual(b.rowValues(MONTH, 8, 'B', 7), other, '另一台裝置的修改還在');
  assert.equal(lastLog(b)[2], 'update', '衝突時不記復原');
});

test('復原：同一筆不能復原兩次；復原請求重送（同一個 opId）只做一次', () => {
  const b = createBackend();
  b.call('deleteExpense', { month: MONTH, row: 6, opId: 'op-del-twice' });
  const first = undo(b, 'op-del-twice', { opId: 'op-undo-twice' });
  const snap = snapshot(b);
  const again = undo(b, 'op-del-twice', { opId: 'op-undo-twice' });
  assert.equal(again.replayed, true);
  assert.equal(again.row, first.row);
  assert.equal(snapshot(b), snap, '重送不會再插一次');
  assert.throws(() => undo(b, 'op-del-twice', { opId: 'op-undo-other' }), /已經還原過了/);
  assert.throws(() => undo(b, 'op-not-exist-1'), /找不到這筆操作/);
  assert.throws(() => b.call('undoRecordOp', { month: MONTH }), /缺少要還原的操作/);
  assert.equal(snapshot(b), snap);

  // 復原本身也能再被還原（重做刪除）
  const redo = undo(b, 'op-undo-twice');
  assert.equal(redo.op, 'delete');
  assert.equal(ledger(b).expenses.length, 7);
});

/* ------------------------------ 3. 標記已繳 ------------------------------ */

test('復原標記已繳：單筆與整批都寫回各列原本的值；有一列被改過就整批不動', () => {
  const b = createBackend();
  const col = () => [5, 6, 9, 10].map(r => b.sheet(MONTH).getRange('F' + r).getValue());
  const original = col();
  b.call('markCreditCardPaid', { month: MONTH, row: 5, paid: 'O', opId: 'op-paid-one-1' });
  const one = undo(b, 'op-paid-one-1');
  assert.equal(one.op, 'paid');
  assert.deepEqual(one.paidByRow, { 5: 'X' });
  assert.deepEqual(col(), original);

  const before = snapshot(b);
  b.call('batchMarkCreditCardPaid', { month: MONTH, rows: [5, 9, 12], paid: 'O', opId: 'op-paid-many' });
  const many = undo(b, 'op-paid-many');
  assert.deepEqual(many.rows, [5, 9, 12]);
  assert.deepEqual(many.paidByRow, { 5: 'X', 9: 'X', 12: 'O' });
  assert.equal(snapshot(b), before, '只寫回 F 欄，其他格不變');

  b.call('batchMarkCreditCardPaid', { month: MONTH, rows: [5, 9], paid: 'O', opId: 'op-paid-cf' });
  b.call('markCreditCardPaid', { month: MONTH, row: 9, paid: 'X' });
  const mid = snapshot(b);
  assert.throws(() => undo(b, 'op-paid-cf'), /^Error: 衝突：/);
  assert.equal(snapshot(b), mid, '衝突時一格都不改');
});

/* ------------------------------ 4. 操作紀錄 ------------------------------ */

test('操作紀錄：隱藏工作表、欄位、修改前／後 JSON、opId；沒送 opId 時由伺服器產生', () => {
  const b = createBackend();
  assert.equal(b.sheet(LOG), null, '第一次寫入前不存在');
  const add = b.call('addExpense', expenseForm({ amount: 66, note: '=1+1' }));
  const sheet = b.sheet(LOG);
  assert.ok(sheet && sheet.isSheetHidden(), '隱藏工作表');
  assert.deepEqual(sheet.getRange(1, 1, 1, 10).getValues()[0],
    ['時間', '來源', '動作', '月份', '類型', '列號', '修改前 JSON', '修改後 JSON', 'opId', '復原對象']);
  const row = lastLog(b);
  assert.ok(row[0] instanceof Date, '時間是日期');
  assert.deepEqual(row.slice(1, 6), ['web', 'add', MONTH, 'expense', 13]);
  assert.equal(row[6], '');
  assert.deepEqual(JSON.parse(row[7]), add.record);
  assert.match(add.opId, /^srv-[a-z0-9]+-[a-z0-9]+$/);
  assert.equal(row[8], add.opId);
  assert.equal(typeof row[3], 'string', '月份存成文字（不會變成數字 2026.11）');

  b.call('updateExpense', expenseForm({ row: 13, amount: 67, opId: 'op-log-upd-1' }));
  const upd = lastLog(b);
  assert.equal(JSON.parse(upd[6]).amount, 66);
  assert.equal(JSON.parse(upd[7]).amount, 67);
  b.call('deleteExpense', { month: MONTH, row: 13, opId: 'op-log-del-1' });
  const del = lastLog(b);
  assert.equal(JSON.parse(del[6]).amount, 67);
  assert.equal(del[7], '');
  b.call('batchMarkCreditCardPaid', { month: MONTH, rows: [5, 9], paid: 'O', opId: 'op-log-paid' });
  const paid = lastLog(b);
  assert.equal(paid[5], '5,9');
  assert.deepEqual(JSON.parse(paid[6]).map(r => r.paid), ['X', 'X']);
  assert.deepEqual(JSON.parse(paid[7]).map(r => r.paid), ['O', 'O']);
  undo(b, 'op-log-del-1', { opId: 'op-log-undo-1' });
  const u = lastLog(b);
  assert.deepEqual([u[2], u[8], u[9]], ['undo', 'op-log-undo-1', 'op-log-del-1']);
  assert.equal(logRows(b).length, 5);

  // 重送（同一個 opId）不重記
  b.call('updateExpense', expenseForm({ row: 13, amount: 67, opId: 'op-log-upd-1' }));
  assert.equal(logRows(b).length, 5);
});

test('操作紀錄：來源分成 web、api、trigger', () => {
  const b = createBackend({ properties: { API_TOKEN: 'w'.repeat(32) } });
  b.call('addExpense', expenseForm({}));
  assert.equal(lastLog(b)[1], 'web');
  const http = b.post({ token: 'w'.repeat(32), action: 'deleteExpense', args: [{ month: MONTH, row: 5 }] });
  assert.equal(http.ok, true);
  assert.equal(lastLog(b)[1], 'api');
  assert.ok(http.data.opId, 'HTTP 呼叫端拿得到 opId，可以復原');
  b.fns.withOpLogSource_('trigger', () => b.fns.addRecords_([Object.assign(expenseForm({ note: '自動入帳' }), { type: 'expense' })]));
  assert.equal(lastLog(b)[1], 'trigger');
  b.call('addExpense', expenseForm({}));
  assert.equal(lastLog(b)[1], 'web', '離開之後恢復成 web');
  // HTTP API 也能復原（完整格式沒有 op 欄位）
  const back = b.post({ token: 'w'.repeat(32), action: 'undoRecordOp', args: [{ undoOf: http.data.opId }] });
  assert.equal(back.ok, true);
  assert.equal(back.data.row, 5);
  assert.deepEqual(b.rowValues(MONTH, 5, 'B', 7), [1, '午餐', '生活費', '信用卡-測試一卡', 'X', 85, '']);
});

test('操作紀錄：批次新增一次 setValues、照送來的順序；寫紀錄失敗不影響記帳', () => {
  const b = createBackend();
  b.call('addExpense', expenseForm({}));                       // 先建立工作表
  const s = b.runtime.stats;
  const writes = s.writes;
  const forms = [
    Object.assign(expenseForm({ note: 'b1' }), { type: 'expense', opId: 'batch-log-01' }),
    Object.assign(incomeForm({ note: 'b2' }), { type: 'income', opId: 'batch-log-02' }),
    Object.assign(expenseForm({ note: 'b3' }), { type: 'expense', opId: 'batch-log-03' }),
  ];
  b.call('addRecords', forms);
  assert.deepEqual(logRows(b).slice(-3).map(r => r[8]), ['batch-log-01', 'batch-log-02', 'batch-log-03']);
  // 支出 2 筆連續列 1 次、收入 1 次、操作紀錄 1 次
  assert.equal(s.writes - writes, 3, '操作紀錄只多 1 次寫入');

  // 操作紀錄寫不進去（例如工作表被保護）：記帳照樣成功
  const broken = createBackend();
  broken.runtime.spreadsheet.insertSheet = () => { throw new Error('模擬：無法建立工作表'); };
  const res = broken.call('addExpense', expenseForm({ amount: 12 }));
  assert.equal(res.ok, true);
  assert.equal(broken.rowValues(MONTH, 13, 'B', 7)[5], 12);
  assert.ok(broken.logs.some(l => /\[oplog\] 寫入操作紀錄失敗/.test(l)));
});

/* -------------------------- 5. getOpLog 與依舊紀錄還原 -------------------------- */

test('getOpLog：新的在前、最多 50 筆、標出已還原與不能還原的原因', () => {
  const b = createBackend();
  assert.deepEqual(b.call('getOpLog', 50).entries, [], '還沒有紀錄');
  for (let i = 0; i < 55; i++) b.call('addIncome', incomeForm({ amount: 100 + i, opId: 'op-list-' + String(i).padStart(3, '0') }));
  b.call('batchMarkCreditCardPaid', { month: MONTH, rows: [5, 6, 7, 8, 9], paid: 'O', opId: 'op-list-paid' });
  undo(b, 'op-list-054', { opId: 'op-list-undo' });

  const out = b.call('getOpLog', 999);
  assert.equal(out.entries.length, 50);
  assert.equal(out.total, 57);
  assert.equal(out.keep, 2000);
  const [u, paid, last] = out.entries;
  assert.equal(u.action, 'undo');
  assert.equal(u.undoOf, 'op-list-054');
  assert.equal(paid.count, 5);
  assert.equal(paid.after.length, 3, '整批只帶前幾筆給畫面顯示');
  assert.deepEqual(paid.row, [5, 6, 7, 8, 9]);
  assert.equal(last.opId, 'op-list-054');
  assert.equal(last.undone, true);
  assert.equal(last.revertible, false);
  assert.equal(last.reason, '已經還原過了');
  assert.equal(out.entries[3].revertible, true);
  assert.equal(b.call('getOpLog').entries.length, 50, '預設 50 筆');
  assert.equal(b.call('getOpLog', 3).entries.length, 3);
});

test('依舊紀錄還原：之後上方刪掉一筆、列號變了，照樣找到那筆；新增的還原就是刪除', () => {
  const b = createBackend();
  b.call('updateExpense', expenseForm({ row: 9, amount: 888, note: '要還原', opId: 'op-old-upd-1' }));
  b.call('deleteExpense', { month: MONTH, row: 6 });          // 第 9 列往上移到第 8 列
  const res = undo(b, 'op-old-upd-1');
  assert.equal(res.row, 8, '依內容找到移動後的列');
  assert.deepEqual(b.rowValues(MONTH, 8, 'B', 7), [5, '娛樂', '生活費', '信用卡-測試二卡', 'X', 2860, 'KTV'], '寫回修改前的內容');

  const add = b.call('addExpense', expenseForm({ amount: 41, opId: 'op-old-add-1' }));
  b.call('addExpense', expenseForm({ amount: 42 }));
  const before = ledger(b).expenses.length;
  const removed = undo(b, 'op-old-add-1');
  assert.equal(removed.op, 'delete');
  assert.equal(removed.row, add.row);
  assert.equal(ledger(b).expenses.length, before - 1);
  assert.equal(b.rowValues(MONTH, add.row, 'B', 7)[5], 42, '下方往上遞補');

  // 新增的那筆之後被改過：衝突，不刪
  b.call('addExpense', expenseForm({ amount: 43, opId: 'op-old-add-2' }));
  b.call('updateExpense', expenseForm({ row: 13, amount: 44 }));
  assert.throws(() => undo(b, 'op-old-add-2'), /^Error: 衝突：/);
  assert.equal(b.rowValues(MONTH, 13, 'B', 7)[5], 44);
});

/* ------------------------------ 6. 每日維護 ------------------------------ */

test('每日維護：只保留最近 2,000 筆，刪掉最舊的；只接受觸發器或擁有者', () => {
  const b = createBackend();
  b.fns.setup();
  const daily = b.runtime.triggers.filter(t => t.getHandlerFunction() === 'dailyMaintenance');
  assert.equal(daily.length, 1);
  assert.equal(daily[0].spec.everyDays, 1);
  assert.equal(daily[0].spec.atHour, 4);
  assert.equal(daily[0].spec.timeZone, 'Asia/Taipei');
  b.fns.setup();
  assert.equal(b.runtime.triggers.filter(t => t.getHandlerFunction() === 'dailyMaintenance').length, 1, '重跑 setup 不重複');
  assert.equal(b.runtime.triggers.length, 2, '預熱＋每日維護');

  const entries = [];
  for (let i = 0; i < 2015; i++) {
    entries.push({ action: 'add', month: MONTH, type: 'expense', row: 5, before: null, after: { n: i }, opId: 'op-trim-' + String(i).padStart(5, '0') });
  }
  b.fns.withDocumentLock_(() => b.fns.appendOpLog_(null, entries));
  assert.equal(logRows(b).length, 2015);

  // 網頁呼叫（帶假的事件）與非擁有者都直接 return
  assert.equal(b.fns.dailyMaintenance({ triggerUid: 'fake' }), undefined);
  const stranger = createBackend({ activeUserEmail: 'someone@example.com' });
  assert.equal(stranger.fns.dailyMaintenance(), undefined);
  assert.equal(logRows(b).length, 2015);

  const uid = b.runtime.triggers.find(t => t.getHandlerFunction() === 'dailyMaintenance').getUniqueId();
  const summary = b.fns.dailyMaintenance({ triggerUid: uid });
  assert.deepEqual(summary.steps[0].result, { removed: 15, kept: 2000 });
  const rows = logRows(b);
  assert.equal(rows.length, 2000);
  assert.equal(rows[0][8], 'op-trim-00015', '最舊的 15 筆被刪掉');
  assert.equal(rows[1999][8], 'op-trim-02014');
  assert.equal(b.sheet(LOG).getRange(1, 1).getValue(), '時間', '標題列保留');
  assert.ok(b.logs.some(l => l.includes('[dailyMaintenance]')));

  // 清理後照樣能寫、能復原
  b.call('deleteExpense', { month: MONTH, row: 6, opId: 'op-after-trim' });
  assert.equal(undo(b, 'op-after-trim').op, 'restore');
});

test('偵錯計時：[api-timing] 帶寫操作紀錄的毫秒數 opLogMs', () => {
  const b = createBackend();
  b.fns.api({ action: 'addExpense', args: [expenseForm({})], timing: true });
  const line = b.logs.filter(l => l.includes('[api-timing]')).pop();
  const info = JSON.parse(line.slice(line.indexOf('{')));
  assert.equal(typeof info.opLogMs, 'number');
});

/* ------------------------------ 7. 前端合併 ------------------------------ */

test('前端合併差量：復原刪除（插回、下方往下移）、復原修改、復原已繳，和後端的整月明細相同', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/client/scripts/bookkeeping/submit.js'), 'utf8');
  const client = { console, LocalCache: { getRecent: () => null }, state: {}, getMonth: () => MONTH };
  vm.createContext(client);
  vm.runInContext(src, client);

  const b = createBackend();
  const init = b.call('getInitialData', true).initialRecent;
  let local = { month: MONTH, fullExpenses: init.fullExpenses, fullIncomes: init.fullIncomes, budget: init.budget };
  client.LocalCache.getRecent = () => local;
  const apply = res => {
    const out = client.resolveMutationRecent(res, MONTH);
    assert.ok(out.recent, res.op + ' 可以合併');
    assert.equal(out.stale, false, res.op + ' 筆數和後端一致');
    local = out.recent;
    const server = ledger(b);
    assert.deepEqual(JSON.parse(JSON.stringify(local.fullExpenses)), server.expenses, res.op + ' 支出相同');
    assert.deepEqual(JSON.parse(JSON.stringify(local.fullIncomes)), server.incomes, res.op + ' 收入相同');
  };
  apply(b.call('deleteExpense', { month: MONTH, row: 6, opId: 'fe-del-1' }));
  apply(undo(b, 'fe-del-1'));
  apply(b.call('deleteExpense', { month: MONTH, row: 12, opId: 'fe-del-2' }));
  apply(undo(b, 'fe-del-2'));
  apply(b.call('deleteIncome', { month: MONTH, row: 5, opId: 'fe-del-3' }));
  apply(undo(b, 'fe-del-3'));
  apply(b.call('updateExpense', expenseForm({ row: 7, amount: 1, opId: 'fe-upd-1' })));
  apply(undo(b, 'fe-upd-1'));
  apply(b.call('batchMarkCreditCardPaid', { month: MONTH, rows: [5, 6, 9], paid: 'O', opId: 'fe-paid-1' }));
  apply(undo(b, 'fe-paid-1'));
  apply(b.call('addExpense', expenseForm({ amount: 5, opId: 'fe-add-1' })));
  apply(undo(b, 'fe-add-1'));
});

test('前端：復原與最近操作走 Api 層（undoRecordOp 帶 opId 可重試、getOpLog 是唯讀）', () => {
  const api = fs.readFileSync(path.join(ROOT, 'src/client/scripts/core/api.js'), 'utf8');
  assert.match(api.match(/OP_ACTIONS = new Set\(\[([\s\S]*?)\]\)/)[1], /'undoRecordOp'/);
  assert.match(api.match(/READ_ACTIONS = new Set\(\[([\s\S]*?)\]\)/)[1], /'getOpLog'/);
  const feedback = fs.readFileSync(path.join(ROOT, 'src/client/scripts/core/feedback.js'), 'utf8');
  assert.match(feedback, /const UNDO_TOAST_MS = 5000;/, '復原按鈕顯示 5 秒');
  assert.match(feedback, /setProperty\('--toast-ms', duration \+ 'ms'\)/, '進度條沿用 toastProgress、跟著顯示時間跑');
  const code = fs.readFileSync(path.join(DIST, 'code.gs'), 'utf8');
  assert.match(code, /undoRecordOp:\s*\{ handler: undoRecordOp_, form: true, write: true \}/);
});
