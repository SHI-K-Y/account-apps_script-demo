// 後端測試：透過 API 閘道操作模擬的試算表，確認「寫進試算表的內容」與「回傳給前端的資料」都正確。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, expenseForm, incomeForm } from './helpers.mjs';

test('啟動資料：月份、選項與最近紀錄', () => {
  const b = createBackend();
  const init = b.call('getInitialData', true);
  assert.equal(init.currentMonth, '2026.11');
  assert.equal(init.selectedMonth, '2026.11');
  assert.deepEqual(init.months, ['2026.11', '2026.10', '2024.10']);
  assert.ok(init.options.expenseItems.includes('午餐'));
  assert.equal(init.initialRecent.expenses.length, 8);
  assert.equal(init.initialRecent.expenses[0].row, 12, '最近紀錄由新到舊');
});

test('新增支出：寫入第一個空白列，文字不會被當成公式', () => {
  const b = createBackend();
  const res = b.call('addExpense', expenseForm({ payment: '信用卡-測試一卡', paid: 'x', amount: '1,234', note: '=HYPERLINK("http://x")' }));
  assert.equal(res.row, 13);
  assert.deepEqual(b.rowValues('2026.11', 13, 'B', 7), [13, '午餐', '生活費', '信用卡-測試一卡', 'X', 1234, '=HYPERLINK("http://x")']);
  assert.equal(b.sheet('2026.11').getRange('H13').getFormula(), '', '備註必須是純文字而不是公式');
  assert.equal(res.record.amount, 1234);
  assert.equal(res.recent, undefined, '預設是差量格式（P10）');
  assert.equal(res.op, 'add');
  assert.equal(res.dailyExpenses[13].total, 1234);

  const second = b.call('addExpense', expenseForm({ amount: 50 }));
  assert.equal(second.row, 14, '連續新增會往下一列寫');
  assert.deepEqual(b.call('getFullRecords', '2026.11', 'expense', false), b.call('getFullRecords', '2026.11', 'expense', true), '快取與試算表內容一致');
});

test('新增支出：不合法的輸入會被拒絕，而且不會寫入任何資料', () => {
  const b = createBackend();
  const before = JSON.stringify(b.runtime.snapshot());
  const cases = [
    [expenseForm({ day: 31 }), /日期必須介於 1～30/],
    [expenseForm({ item: '不存在' }), /不在「資料選單設定區」/],
    [expenseForm({ amount: 0 }), /金額必須是大於 0/],
    [expenseForm({ amount: '-5' }), /金額必須是大於 0/],
    [expenseForm({ paid: 'Q' }), /是否已繳/],
    [expenseForm({ month: '2031.01' }), /找不到「2031.01」工作表/],
    [expenseForm({ month: '2026.13' }), /月份錯誤/],
    [null, /資料格式錯誤/],
  ];
  cases.forEach(([form, pattern]) => assert.throws(() => b.call('addExpense', form), pattern));
  assert.equal(JSON.stringify(b.runtime.snapshot()), before);
});

test('新增／修改／刪除收入', () => {
  const b = createBackend();
  const added = b.call('addIncome', incomeForm({ note: '+加班費' }));
  assert.equal(added.row, 7);
  assert.deepEqual(b.rowValues('2026.11', 7, 'K', 5), [12, '薪資', '存款', 5000, '+加班費']);

  const updated = b.call('updateIncome', incomeForm({ row: 7, amount: 6000, day: 10 }));
  assert.equal(updated.record.amount, 6000);
  assert.deepEqual(b.rowValues('2026.11', 7, 'K', 5), [10, '薪資', '存款', 6000, '']);

  b.call('deleteIncome', { month: '2026.11', row: 5 });
  assert.deepEqual(b.rowValues('2026.11', 5, 'K', 5), [5, '薪資', '存款', 52000, '十一月薪資'], '下方紀錄往上遞補');
  assert.deepEqual(b.rowValues('2026.11', 7, 'K', 5), ['', '', '', '', '']);
  assert.equal(b.call('getFullRecords', '2026.11', 'income', true).records.length, 2);
});

test('修改支出：只改指定列，列號不合法會被拒絕', () => {
  const b = createBackend();
  b.call('updateExpense', expenseForm({ row: 6, day: 2, amount: 999, note: '改過' }));
  assert.deepEqual(b.rowValues('2026.11', 6, 'B', 7), [2, '午餐', '生活費', '現金', '', 999, '改過']);
  assert.deepEqual(b.rowValues('2026.11', 5, 'B', 7), [1, '午餐', '生活費', '信用卡-測試一卡', 'X', 85, '']);
  assert.throws(() => b.call('updateExpense', expenseForm({ row: 4 })), /無效的資料列號/);
  assert.throws(() => b.call('updateExpense', expenseForm({ row: 'abc' })), /無效的資料列號/);
});

test('刪除支出：中間列刪除後往上遞補，不影響收入區塊與公式欄', () => {
  const b = createBackend();
  const incomeBefore = b.rowValues('2026.11', 5, 'K', 5);
  const formulaBefore = b.sheet('2026.11').getRange('I6').getFormula();
  b.call('deleteExpense', { month: '2026.11', row: 6 });
  assert.deepEqual(b.rowValues('2026.11', 6, 'B', 7), [2, '午餐', '生活費', '現金', '', 110, '']);
  assert.deepEqual(b.rowValues('2026.11', 12, 'B', 7), ['', '', '', '', '', '', '']);
  assert.deepEqual(b.rowValues('2026.11', 5, 'K', 5), incomeBefore);
  assert.equal(b.sheet('2026.11').getRange('I6').getFormula(), formulaBefore);
  const records = b.call('getFullRecords', '2026.11', 'expense', false).records;
  assert.equal(records.length, 7);
  assert.equal(b.call('addExpense', expenseForm({})).row, 12, '刪除後空出來的列會被重新使用');
});

test('信用卡已繳標記：單筆與批次', () => {
  const b = createBackend();
  assert.equal(b.call('markCreditCardPaid', { month: '2026.11', row: 5 }).paid, 'O');
  assert.equal(b.sheet('2026.11').getRange('F5').getValue(), 'O');
  const batch = b.call('batchMarkCreditCardPaid', { month: '2026.11', rows: [5, 9, 'x', 3], paid: 'X' });
  assert.deepEqual(batch.rows, [5, 9]);
  assert.equal(b.sheet('2026.11').getRange('F9').getValue(), 'X');
  assert.throws(() => b.call('batchMarkCreditCardPaid', { month: '2026.11', rows: [] }), /沒有選擇/);
});

test('新增月份工作表：由範本複製、排在最新月份旁、可立即記帳', () => {
  const b = createBackend();
  const res = b.call('createNewMonthSheet', '2026.12');
  assert.deepEqual(res.months.slice(0, 2), ['2026.12', '2026.11']);
  const created = b.sheet('2026.12');
  assert.ok(created && !created.isSheetHidden());
  assert.equal(created.getRange('C4').getValue(), '支出項目');
  assert.equal(created.getIndex(), b.sheet('2026.11').getIndex() + 1);
  assert.throws(() => b.call('createNewMonthSheet', '2026.12'), /已存在/);
  assert.throws(() => b.call('createNewMonthSheet', '2026-12'), /月份格式錯誤/);
  assert.equal(b.call('addExpense', expenseForm({ month: '2026.12', day: 25 })).row, 5);
});

test('搜尋：關鍵字、篩選與舊格式月份', () => {
  const b = createBackend();
  const res = b.call('searchRecords', { months: ['2026.11', '2026.10', '2024.10'], keyword: '午餐' });
  assert.equal(res.results.length, 3);
  assert.deepEqual(res.skippedMonths, ['2024.10']);
  assert.equal(res.stats.total, 85 + 110 + 150);
  const paid = b.call('searchRecords', { months: ['2026.11'], type: 'expense', paid: 'X', minAmount: 100 });
  assert.deepEqual(paid.results.map(r => r.amount), [2860]);
  assert.throws(() => b.call('searchRecords', { months: [] }), /請指定要搜尋的月份/);
});

test('信用卡對帳：一次讀取多個月份，略過舊版面與不存在的月份', () => {
  const b = createBackend();
  const res = b.call('getCreditCardRecords', ['2026.11', '2026.10', '2024.10', '2020.01'], false);
  assert.deepEqual(Object.keys(res.recordsByMonth).sort(), ['2026.10', '2026.11']);
  assert.deepEqual(res.recordsByMonth['2026.11'], b.call('getFullRecords', '2026.11', 'expense', false).records);
  assert.deepEqual(res.skippedMonths, ['2024.10']);
  assert.deepEqual(res.missingMonths, ['2020.01']);
  assert.deepEqual(res.failedMonths, []);
  assert.deepEqual(b.call('getCreditCardRecords', ['2026.11'], true).recordsByMonth['2026.11'], res.recordsByMonth['2026.11'], '強制重新讀取結果一致');
  assert.throws(() => b.call('getCreditCardRecords', []), /請指定要讀取的月份/);
  assert.throws(() => b.call('getCreditCardRecords', ['2026-11']), /月份格式錯誤/);
  assert.throws(() => b.call('getCreditCardRecords', Array.from({ length: 13 }, (_, i) => '2025.' + String(i % 12 + 1).padStart(2, '0'))), /一次最多讀取/);
});

test('總覽、圖表與月份彙總表', () => {
  const b = createBackend();
  const ov = b.call('getAssetOverview', false);
  assert.equal(ov.month, '2026.11');
  assert.equal(ov.assetTotal, '$12345');
  assert.deepEqual(ov.warnings, [], '所有欄位都靠標題定位到');
  const charts = b.call('getOverviewCharts', '2026.11', false);
  assert.equal(charts.current.byCategory['生活費'].total, 85 + 175 + 110 + 2860 + 140 + 65 + 320);
  assert.equal(charts.current.incomeTotal, 55000);
  assert.equal(charts.previous.byCategory['生活費'].total, 12205);
  b.fns.rebuildAllSummaries();
  const summary = b.sheet('_月份彙總');
  assert.ok(summary && summary.isSheetHidden());
  assert.equal(summary.getRange('A1').getValue(), '月份');
});

test('對帳：讀取、改日期、寫入實際餘額、清除', () => {
  const b = createBackend();
  const data = b.call('getSettlementData', '');
  assert.equal(data.settlementDate, '2026/11/09');
  assert.equal(data.ledger.total, '$12345');
  assert.equal(b.call('updateSettlementDate', '2026-10-31').settlementDate, '2026/10/31');
  b.call('updateSettlementActual', { date: '2026/11/13', cash: '1,200', bankShanlan: 5000, bankBeichen: '', bankQinghe: 'abc' });
  assert.deepEqual(b.sheet('對帳系統').getRange('I5:M5').getValues()[0], [1200, '+', 5000, '+', 0]);
  b.call('clearSettlementActual');
  assert.equal(b.sheet('對帳系統').getRange('I5').getValue(), '');
  assert.equal(b.sheet('對帳系統').getRange('H2').getDisplayValue(), '2026/11/13');
});

test('選項設定：新增、改名、刪除、排序與常用組合', () => {
  const b = createBackend();
  const added = b.call('saveSettingsItemWithEmoji', { category: 'expenseItems', name: '🍜拉麵', emoji: 'ph:bowl-steam', position: 'top' });
  assert.equal(added.value, '拉麵');
  assert.equal(b.sheet('資料選單設定區').getRange('B2').getValue(), '拉麵');
  assert.equal(added.metadata.emojis['拉麵'], 'ph:bowl-steam');
  assert.throws(() => b.call('saveSettingsItemWithEmoji', { category: 'expenseItems', name: '拉麵' }), /已存在/);
  assert.ok(b.call('addExpense', expenseForm({ item: '拉麵' })).ok, '新選項可以立刻用來記帳');

  b.call('reorderSettingsOptions', 'incomeCategories', ['代收代付', '生活費', '存款']);
  assert.equal(b.sheet('資料選單設定區').getRange('E2').getValue(), '代收代付');

  const combos = b.call('saveQuickCombos', [{ type: 'expense', title: '早餐店', item: '早餐', category: '生活費', payment: '現金', paid: '', amount: '65' }]);
  const saved = (combos.metadata || combos).quickCombos || b.call('getSettingsOptions', true).metadata.quickCombos;
  assert.equal(saved[0].title, '早餐店');
  assert.throws(() => b.call('saveQuickCombos', [{ type: 'expense', title: '' }]), /請輸入組合標題/);
});

test('國外交易帳簿：帳簿與紀錄的新增、修改、刪除', () => {
  const b = createBackend();
  const list = b.call('getFxLedgers', false);
  assert.deepEqual(list.ledgers.map(l => l.name), ['韓國']);
  const created = b.call('createFxLedger', { name: '東京', country: '日本', startDate: '2027-01-10', endDate: '2027-01-15' });
  const id = created.ledger.id;
  assert.ok(b.sheet('國外交易記帳簿-東京'));
  assert.throws(() => b.call('createFxLedger', { name: '東京', country: '日本', startDate: '2027-01-10', endDate: '2027-01-15' }), /已經有/);

  const rec = { ledgerId: id, date: '2027-01-11', item: '餐飲', payment: '現金', currency: 'JPY', amount: '1,500', rate: '0.21', note: '=x' };
  const added = b.call('addFxRecord', rec);
  assert.ok(added.ok);
  const data = b.call('getFxLedgerData', id, true);
  assert.equal(data.records.length, 1);
  assert.equal(data.records[0].amount, 1500);
  assert.equal(data.records[0].note, '=x');
  const row = data.records[0].row;
  b.call('updateFxRecord', Object.assign({}, rec, { row, amount: 2000, note: '改' }));
  assert.equal(b.call('getFxLedgerData', id, true).records[0].amount, 2000);
  b.call('deleteFxRecord', { ledgerId: id, row });
  assert.equal(b.call('getFxLedgerData', id, true).records.length, 0);

  assert.throws(() => b.call('deleteFxLedger', { ledgerId: id, confirmName: '不對' }), /未刪除/);
  b.call('deleteFxLedger', { ledgerId: id, confirmName: '東京' });
  assert.equal(b.sheet('國外交易記帳簿-東京'), null);
});

test('有人直接在試算表編輯後（onEdit），網頁讀到的是最新資料', () => {
  const b = createBackend();
  b.call('getFullRecords', '2026.11', 'expense', false);
  const sheet = b.sheet('2026.11');
  sheet.getRange('G5').setValue(777);
  b.fns.onEdit({ range: { getSheet: () => sheet } });
  const records = b.call('getFullRecords', '2026.11', 'expense', false).records;
  assert.equal(records.find(r => r.row === 5).amount, 777);
});
