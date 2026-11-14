// 預算測試：設定的儲存與版本、每日額度的計算、各種邊界情況，以及與既有流程（啟動、記帳、圖表、快取）的整合。
//
// 測試資料（tools/gas-mock/fixture.mjs）的 2026.11 共 30 天，「今天」固定是 11/13（台北時間）：
//   生活費支出 85 + 175 + 110 + 2860（娛樂，11/5）+ 140 + 65 + 320 = 3755，全部在今天之前
//   存款支出 10000；生活費收入 3000（其他）；存款收入 52000（薪資）
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, expenseForm, incomeForm } from './helpers.mjs';

const DAY = 24 * 3600 * 1000;
const LIVING = 3755;
const fixed = (amount, over) => Object.assign({ month: '2026.11', source: 'fixed', amount, categories: ['生活費'], reserves: [] }, over);
const recentBudget = (b, month) => b.call('getRecentRecords', month || '2026.11', 8, 8, false).budget;
const otherSheets = b => JSON.stringify(b.runtime.snapshot().filter(s => s.name !== '_預算設定'));

test('預算：沒有設定時回傳「未設定」，記帳頁、啟動資料與支出分析都帶著這個狀態', () => {
  const b = createBackend();
  const init = b.call('getInitialData', true);
  assert.equal(init.initialRecent.budget.configured, false);
  assert.equal(init.initialRecent.budget.mode, 'current');
  assert.equal(b.call('getOverviewCharts', '2026.11', false).budget.configured, false);
  const settings = b.call('getBudgetSettings', false);
  assert.deepEqual(settings.versions, []);
  assert.equal(settings.currentMonth, '2026.11');
  assert.equal(b.sheet('_預算設定'), null, '還沒儲存過就不建立工作表');
});

test('預算：月中才設定，月初到現在的支出照樣計入；每日額度與今天還能花', () => {
  const b = createBackend();
  const res = b.call('saveBudgetSettings', fixed('30,000'));
  const s = res.status;
  assert.equal(s.configured, true);
  assert.equal(s.amount, 30000);
  assert.equal(s.spent, LIVING, '只算生活費，存款的 10000 不計入');
  assert.equal(s.remaining, 30000 - LIVING);
  assert.equal(s.remainingDays, 18, '11/13～11/30 含今天共 18 天');
  assert.equal(s.daily, Math.floor((30000 - LIVING) / 18));
  assert.equal(s.todaySpent, 0);
  assert.equal(s.todayLeft, s.daily);
  assert.equal(s.expected, 13000, '30000 × 13/30');
  assert.equal(s.paceDiff, LIVING - 13000, '負數表示比應花的位置少');
  assert.deepEqual(recentBudget(b), s, '記帳頁讀到的數字相同');
});

test('預算：記帳後的回應立刻帶著新的今天還能花；不計入的總類不影響', () => {
  const b = createBackend();
  const daily = b.call('saveBudgetSettings', fixed(30000)).status.daily;
  const added = b.call('addExpense', expenseForm({ amount: 120 }));
  assert.equal(added.recent.budget.todaySpent, 120);
  assert.equal(added.recent.budget.todayLeft, daily - 120);
  assert.equal(added.recent.budget.daily, daily, '今天的支出不改變今天的每日額度');

  const savings = b.call('addExpense', expenseForm({ item: '其他', category: '存款', amount: 500 }));
  assert.equal(savings.recent.budget.todayLeft, daily - 120);

  const updated = b.call('updateExpense', expenseForm({ row: added.row, amount: 300 }));
  assert.equal(updated.recent.budget.todayLeft, daily - 300);
  const deleted = b.call('deleteExpense', { month: '2026.11', row: added.row });
  assert.equal(deleted.recent.budget.todayLeft, daily);
  assert.equal(b.call('getOverviewCharts', '2026.11', false).budget.spent, LIVING);
});

test('預算：可選擇計入的總類', () => {
  const b = createBackend();
  const s = b.call('saveBudgetSettings', fixed(30000, { categories: ['生活費', '存款'] })).status;
  assert.equal(s.spent, LIVING + 10000);
  assert.deepEqual(s.categories, ['生活費', '存款']);
});

test('預算：不計入每日額度的項目用預留法（先扣預留、今天付款不算進今天、超出預留才算）', () => {
  const b = createBackend();
  // 娛樂已在 11/5 花了 2860，超出預留 2000 的 860 算進之前的花費；房租 12000 還沒付，整筆預留。
  const s = b.call('saveBudgetSettings', fixed(30000, { reserves: [{ item: '房租', amount: 12000 }, { item: '娛樂', amount: '2,000' }] })).status;
  assert.equal(s.reservedPending, 12000);
  const base = 30000 - LIVING - 12000;
  assert.equal(s.daily, Math.floor(base / 18));
  assert.deepEqual(s.reserves, [{ item: '房租', amount: 12000, spent: 0 }, { item: '娛樂', amount: 2000, spent: 2860 }]);

  const rent = b.call('addExpense', expenseForm({ item: '房租', amount: 12000, payment: '轉帳-測試銀行' })).recent.budget;
  assert.equal(rent.spent, LIVING + 12000, '本月已花照樣包含房租');
  assert.equal(rent.daily, s.daily, '今天付房租不影響今天的每日額度');
  assert.equal(rent.todaySpent, 0, '預留範圍內的付款不算進今天已花');
  assert.equal(rent.todayLeft, s.daily);

  const row = b.call('getFullRecords', '2026.11', 'expense', false).records.find(r => r.item === '房租').row;
  const over = b.call('updateExpense', expenseForm({ row, item: '房租', amount: 12500, payment: '轉帳-測試銀行' })).recent.budget;
  assert.equal(over.todaySpent, 500, '超出預留的 500 算進今天');
  assert.equal(over.todayLeft, s.daily - 500);
  // 應花到的位置：已付的預留（房租 12000 ＋ 娛樂 2000）＋ 其餘 16000 照天數分攤
  assert.equal(over.expected, Math.round((14000 + 16000 * 13 / 30) * 100) / 100);

  b.DateCtor.advance(DAY);
  const tomorrow = recentBudget(b);
  assert.equal(tomorrow.reservedPending, 0, '隔天：房租已經付了，不再預留');
  assert.equal(tomorrow.daily, Math.floor((30000 - (LIVING + 12500)) / 17));
});

test('預算：月份最後一天，剩餘天數是 1，額度就是剩下的全部', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', fixed(30000));
  b.DateCtor.advance(17 * DAY);
  const s = recentBudget(b);
  assert.equal(s.day, 30);
  assert.equal(s.remainingDays, 1);
  assert.equal(s.daily, 30000 - LIVING);
  assert.equal(s.expected, 30000);
});

test('預算：已超支時每日額度為 0，並回報本月超支金額', () => {
  const b = createBackend();
  const s = b.call('saveBudgetSettings', fixed(3000)).status;
  assert.equal(s.remaining, 3000 - LIVING);
  assert.equal(s.overspent, LIVING - 3000);
  assert.equal(s.daily, 0, '每日額度最低到 0');
  assert.equal(s.shortfall, LIVING - 3000);
  assert.equal(s.todayLeft, 0);
  assert.equal(b.call('addExpense', expenseForm({ amount: 100 })).recent.budget.todayLeft, -100);
});

test('預算：扣除預留後不足（還沒超支）時，每日額度為 0 並回報不足金額', () => {
  const b = createBackend();
  const s = b.call('saveBudgetSettings', fixed(10000, { reserves: [{ item: '房租', amount: 8000 }] })).status;
  assert.equal(s.overspent, 0);
  assert.equal(s.daily, 0);
  assert.equal(s.shortfall, LIVING + 8000 - 10000);
});

test('預算：預算為 0 是有效設定，任何支出都是超支', () => {
  const b = createBackend();
  const s = b.call('saveBudgetSettings', fixed(0)).status;
  assert.equal(s.configured, true);
  assert.equal(s.amount, 0);
  assert.equal(s.daily, 0);
  assert.equal(s.overspent, LIVING);
  assert.equal(s.expected, 0);
  assert.equal(b.call('addExpense', expenseForm({ amount: 50 })).recent.budget.todayLeft, -50);
});

test('預算：當月還沒有任何紀錄；上個月變成「過去月份」只回報預算與實際', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', fixed(31000));
  b.DateCtor.advance(18 * DAY); // 12/1
  b.call('createNewMonthSheet', '2026.12');
  const dec = recentBudget(b, '2026.12');
  assert.equal(dec.mode, 'current');
  assert.equal(dec.amount, 31000, '沒有單獨設定的月份沿用之前的設定');
  assert.equal(dec.spent, 0);
  assert.equal(dec.remainingDays, 31);
  assert.equal(dec.daily, 1000);
  assert.equal(dec.todayLeft, 1000);

  const nov = b.call('getOverviewCharts', '2026.11', false).budget;
  assert.equal(nov.mode, 'past');
  assert.equal(nov.spent, LIVING);
  assert.equal(nov.remaining, 31000 - LIVING);
  assert.equal(nov.daily, undefined, '過去月份沒有每日額度');
  assert.equal(nov.todayLeft, undefined);
});

test('預算：修改只影響當月與之後，不回溯過去月份', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', fixed(30000));
  assert.throws(() => b.call('saveBudgetSettings', fixed(1, { month: '2026.10' })), /只能設定本月/);
  assert.equal(b.call('getOverviewCharts', '2026.10', false).budget.configured, false, '十月不受十一月的設定影響');

  b.DateCtor.advance(18 * DAY); // 12/1
  b.call('createNewMonthSheet', '2026.12');
  const saved = b.call('saveBudgetSettings', fixed(25000, { month: '2026.12', categories: ['生活費', '存款'] }));
  assert.deepEqual(saved.versions.map(v => [v.month, v.amount]), [['2026.11', 30000], ['2026.12', 25000]]);
  const nov = b.call('getOverviewCharts', '2026.11', false).budget;
  assert.equal(nov.amount, 30000);
  assert.deepEqual(nov.categories, ['生活費'], '總類設定也跟著版本走');
  assert.equal(recentBudget(b, '2026.12').amount, 25000);
  assert.throws(() => b.call('saveBudgetSettings', fixed(1)), /只能設定本月/);
  assert.throws(() => b.call('deleteBudgetSettings', '2026.11'), /只能設定本月/);
});

test('預算：可預先設定之後的月份；移除後改回沿用前一個設定；停用', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', fixed(30000));
  b.call('saveBudgetSettings', fixed(20000, { month: '2027.01' }));
  assert.equal(recentBudget(b).amount, 30000);
  const removed = b.call('deleteBudgetSettings', '2027.01');
  assert.deepEqual(removed.versions.map(v => v.month), ['2026.11']);
  assert.throws(() => b.call('deleteBudgetSettings', '2027.01'), /沒有單獨的預算設定/);

  const off = b.call('saveBudgetSettings', { month: '2026.11', source: 'off' });
  assert.equal(off.status.configured, false);
  assert.equal(recentBudget(b).configured, false);
});

test('預算：以當月生活費收入作為預算（可限定收入項目，還沒入帳時回報等待中）', () => {
  const b = createBackend();
  const all = b.call('saveBudgetSettings', { month: '2026.11', source: 'income', categories: ['生活費'], incomeItems: [] }).status;
  assert.equal(all.amount, 3000, '只算生活費總類的收入，存款薪資不算');
  assert.equal(all.awaitingIncome, false);

  const salary = b.call('saveBudgetSettings', { month: '2026.11', source: 'income', categories: ['生活費'], incomeItems: ['薪資'] }).status;
  assert.equal(salary.amount, 0);
  assert.equal(salary.awaitingIncome, true);

  const after = b.call('addIncome', incomeForm({ category: '生活費', amount: 20000, day: 13 })).recent.budget;
  assert.equal(after.amount, 20000);
  assert.equal(after.awaitingIncome, false);
  assert.equal(after.daily, Math.floor((20000 - LIVING) / 18));
});

test('預算：「今天」以台北時間為準', () => {
  // UTC 11/13 16:30 = 台北 11/14 00:30
  const b = createBackend();
  b.DateCtor.advance(12.5 * 3600 * 1000);
  const s = b.call('saveBudgetSettings', fixed(30000)).status;
  assert.equal(s.todayISO, '2026-11-14');
  assert.equal(s.day, 14);
  assert.equal(s.remainingDays, 17);
});

test('預算：輸入驗證', () => {
  const b = createBackend();
  const before = JSON.stringify(b.runtime.snapshot());
  const cases = [
    [fixed('-1'), /0 以上的數字/],
    [fixed(''), /請輸入每月預算/],
    [fixed('abc'), /0 以上的數字/],
    [fixed(1e12), /過大/],
    [fixed(100, { categories: [] }), /至少選擇一個/],
    [fixed(100, { categories: ['不存在'] }), /不在「資料選單設定區」/],
    [fixed(100, { reserves: [{ item: '不存在', amount: 1 }] }), /不在「資料選單設定區」/],
    [fixed(100, { reserves: [{ item: '房租', amount: -5 }] }), /預留金額必須是 0 以上/],
    [fixed(100, { reserves: 'x' }), /格式錯誤/],
    [fixed(100, { source: 'magic' }), /預算來源/],
    [fixed(100, { month: '2026-11' }), /月份格式錯誤/],
    [{ month: '2026.11', source: 'income', categories: ['生活費'], incomeItems: ['不存在'] }, /不在「資料選單設定區」/],
    [null, /資料格式錯誤/],
  ];
  cases.forEach(([form, pattern]) => assert.throws(() => b.call('saveBudgetSettings', form), pattern));
  assert.equal(JSON.stringify(b.runtime.snapshot()), before, '驗證失敗不會寫入任何東西');
});

test('預算：存在隱藏的「_預算設定」工作表，其他工作表的內容完全不變', () => {
  const b = createBackend();
  const before = otherSheets(b);
  b.call('saveBudgetSettings', fixed(30000, { reserves: [{ item: '房租', amount: 12000 }, { item: '娛樂', amount: 600 }] }));
  b.call('saveBudgetSettings', fixed(18000, { month: '2027.02', categories: ['生活費', '代收代付'] }));
  assert.equal(otherSheets(b), before);

  const sheet = b.sheet('_預算設定');
  assert.ok(sheet.isSheetHidden());
  assert.deepEqual(b.rowValues('_預算設定', 1, 'A', 6), ['起始月份', '預算來源', '每月預算', '計入總類', '收入項目', '不計入每日額度的項目']);
  assert.deepEqual(b.rowValues('_預算設定', 2, 'A', 6), ['2026.11', '固定金額', 30000, '生活費', '', '房租=12000；娛樂=600']);
  assert.deepEqual(b.rowValues('_預算設定', 3, 'A', 6), ['2027.02', '固定金額', 18000, '生活費、代收代付', '', '']);
  assert.ok(sheet.getRange('G2').getValue() instanceof Date, '記下更新時間');
  assert.equal(sheet.getIndex(), b.runtime.spreadsheet.getNumSheets(), '新工作表排在最後');

  b.call('deleteBudgetSettings', '2027.02');
  assert.deepEqual(b.rowValues('_預算設定', 3, 'A', 6), ['', '', '', '', '', ''], '移除後多出來的列被清空');
  assert.ok(!b.call('getInitialData', false).months.includes('_預算設定'));
});

test('預算：直接在試算表上修改設定（onEdit）後，網頁讀到的是新數字', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', fixed(30000));
  assert.equal(recentBudget(b).amount, 30000);
  const sheet = b.sheet('_預算設定');
  sheet.getRange('C2').setValue(40000);
  sheet.getRange('F2').setValue('房租=1000');
  b.fns.onEdit({ range: { getSheet: () => sheet } });
  const s = recentBudget(b);
  assert.equal(s.amount, 40000);
  assert.equal(s.reservedPending, 1000);
});

test('預算：啟動快取隔天仍會重新計算，不會停在昨天的額度', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', fixed(30000));
  const first = b.call('getInitialData', true).initialRecent.budget;
  assert.equal(first.todayISO, '2026-11-13');
  assert.equal(b.call('getInitialData', false).initialRecent.budget.daily, first.daily, '儲存預算後，快取的啟動資料就帶著新設定');

  b.DateCtor.advance(DAY);
  const cached = b.call('getInitialData', false);
  assert.equal(cached.fromFreshCache, true);
  assert.equal(cached.initialRecent.budget.todayISO, '2026-11-14');
  assert.equal(cached.initialRecent.budget.remainingDays, 17);

  const html = b.fns.doGet().getContent();
  const boot = JSON.parse(html.match(/window\.__INITIAL_DATA__ = (.*);/)[1]);
  assert.equal(boot.initialRecent.budget.todayISO, '2026-11-14', '網頁內嵌的啟動資料也重新計算');
});

test('預算：排除項目完全不計入預算（本月已花、每日額度、今天還能花都不算）', () => {
  const b = createBackend();
  // 娛樂 2860（11/5）整筆排除
  const s = b.call('saveBudgetSettings', fixed(30000, { excludedItems: ['娛樂'] })).status;
  assert.deepEqual(s.excludedItems, ['娛樂']);
  assert.equal(s.excludedSpent, 2860);
  assert.equal(s.spent, LIVING - 2860);
  assert.equal(s.remaining, 30000 - (LIVING - 2860));
  assert.equal(s.daily, Math.floor((30000 - (LIVING - 2860)) / 18));
  assert.equal(s.expected, 13000, '排除項目不影響應花到的位置');

  const big = b.call('addExpense', expenseForm({ item: '娛樂', amount: 8000, note: '演唱會' })).recent.budget;
  assert.equal(big.todaySpent, 0, '今天的排除項目不算進今天已花');
  assert.equal(big.todayLeft, s.daily);
  assert.equal(big.spent, s.spent);
  assert.equal(big.excludedSpent, 2860 + 8000);
  const normal = b.call('addExpense', expenseForm({ amount: 120 })).recent.budget;
  assert.equal(normal.todayLeft, s.daily - 120, '其他項目照常計算');

  // 只排除計入總類裡的支出；存款的「其他」本來就不計入，不會出現在排除金額
  const other = b.call('saveBudgetSettings', fixed(30000, { excludedItems: ['其他'] })).status;
  assert.equal(other.excludedSpent, 0);
  assert.equal(other.spent, LIVING + 8000 + 120);
});

test('預算：排除項目跟著設定版本走，不回溯過去月份', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', fixed(30000));
  b.DateCtor.advance(18 * DAY); // 12/1
  b.call('createNewMonthSheet', '2026.12');
  b.call('saveBudgetSettings', fixed(30000, { month: '2026.12', excludedItems: ['娛樂'] }));
  const nov = b.call('getOverviewCharts', '2026.11', false).budget;
  assert.equal(nov.spent, LIVING, '十一月沒有排除，娛樂照算');
  assert.deepEqual(nov.excludedItems, []);
  assert.deepEqual(recentBudget(b, '2026.12').excludedItems, ['娛樂']);
});

test('預算：排除項目的驗證與寫入；舊版沒有「排除項目」欄的工作表也能讀', () => {
  const b = createBackend();
  assert.throws(() => b.call('saveBudgetSettings', fixed(100, { excludedItems: ['不存在'] })), /不在「資料選單設定區」/);
  assert.throws(() => b.call('saveBudgetSettings', fixed(100, { excludedItems: 'x' })), /格式錯誤/);
  assert.throws(
    () => b.call('saveBudgetSettings', fixed(100, { reserves: [{ item: '房租', amount: 1 }], excludedItems: ['房租'] })),
    /不能同時是「不計入每日額度」和「排除」的項目/
  );

  b.call('saveBudgetSettings', fixed(30000, { excludedItems: ['娛樂', '交通費'] }));
  assert.equal(b.sheet('_預算設定').getRange('H1').getValue(), '排除項目');
  assert.equal(b.sheet('_預算設定').getRange('H2').getValue(), '娛樂、交通費');

  // 模擬舊版建立的工作表：清掉 H 欄（標題與資料），讀起來就是沒有排除項目
  const sheet = b.sheet('_預算設定');
  sheet.getRange('H1:H2').clearContent();
  b.fns.onEdit({ range: { getSheet: () => sheet } });
  const s = recentBudget(b);
  assert.deepEqual(s.excludedItems, []);
  assert.equal(s.spent, LIVING);

  // 再儲存一次會自動補上標題
  b.call('saveBudgetSettings', fixed(30000, { excludedItems: ['娛樂'] }));
  assert.equal(sheet.getRange('H1').getValue(), '排除項目');
  assert.equal(recentBudget(b).excludedSpent, 2860);
});
