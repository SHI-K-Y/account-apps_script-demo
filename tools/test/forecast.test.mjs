// 月底預估（F06）：computeMonthForecast_（純函式）的月初、月中、月底、沒有歷史、一次性大額，
// 以及和預算用同一套數字、快取命中不開試算表。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, DIST, createBackend, expenseForm } from './helpers.mjs';
import { createFixtureWorkbook } from '../gas-mock/fixture.mjs';

const fns = createBackend().fns;
const DAY = 24 * 3600 * 1000;
const MONTH = '2026.11'; // 30 天
const todayOf = day => ({ iso: '2026-11-' + String(day).padStart(2, '0'), month: MONTH, day });
const exp = (day, amount, over) => Object.assign({ day, item: '午餐', category: '生活費', amount }, over);
const daily = (from, to, amount) => Array.from({ length: to - from + 1 }, (_, i) => exp(from + i, amount));
/** 一個月每天一筆的歷史（days 筆 amount 元）。 */
const hist = (month, days, amount, extra) => ({ month, expenses: Array.from({ length: days }, () => ['生活費', '午餐', amount]).concat(extra || []) });
// 2026.10 有 31 天、2026.09 有 30 天、2026.08 有 31 天：日均 300／200／100 → (300×3＋200×2＋100)÷6
const HISTORY = [hist('2026.10', 31, 300), hist('2026.09', 30, 200), hist('2026.08', 31, 100)];
const HIST_AVG = (300 * 3 + 200 * 2 + 100) / 6;
const overview = (living, over) => Object.assign({ month: MONTH, livingBalance: '$' + living, savingsBalance: '$50000', agencyBalance: '$0', warnings: [] }, over);
const run = over => JSON.parse(JSON.stringify(fns.computeMonthForecast_(Object.assign({
  month: MONTH, today: todayOf(13), monthData: { expenses: [], incomes: [] }, history: HISTORY, budget: null, overview: overview(10000), scheduled: null,
}, over))));
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 0.02, (msg || '') + ' 預期 ' + b + '，實際 ' + a);
const budgetOf = (version, monthData, day, extras) => fns.computeBudgetStatus_(
  Object.assign({ month: MONTH, source: 'fixed', amount: 30000, categories: ['生活費'], incomeItems: [], reserves: [], excludedItems: [] }, version),
  MONTH, monthData, todayOf(day), extras || null);

test('預估：月初（1 日，還沒有支出）完全看歷史加權日均', () => {
  const f = run({ today: todayOf(1) });
  near(f.historyAvg, HIST_AVG);
  assert.equal(f.currentWeight, 0);
  near(f.dailyAvg, HIST_AVG);
  assert.equal(f.daysLeft, 30);
  assert.equal(f.spent, 0);
  assert.equal(f.expense, Math.round(HIST_AVG * 30));
  assert.equal(f.endBalance, 10000 - Math.round(HIST_AVG * 30));
});

test('預估：月中，本月至今與歷史依已過天數混合；今天已花的從剩餘天數裡扣掉', () => {
  const monthData = { expenses: daily(1, 12, 150).concat([exp(13, 80)]), incomes: [] };
  const f = run({ monthData });
  const w = 12 / 30;
  const avg = 150 * w + HIST_AVG * (1 - w);
  near(f.currentAvg, 150);
  near(f.dailyAvg, avg);
  assert.equal(f.daysLeft, 18);
  assert.equal(f.futureRegular, Math.round(avg * 18 - 80));
  assert.equal(f.expense, 12 * 150 + 80 + f.futureRegular);
  assert.equal(f.endBalance, 10000 - f.futureRegular, '目前餘額已經扣掉已花的，只再扣接下來的');
});

test('預估：日期在今天之後、先記下來的支出不重複預估', () => {
  const base = { expenses: daily(1, 12, 150), incomes: [] };
  const ahead = { expenses: base.expenses.concat([exp(20, 500)]), incomes: [] };
  const a = run({ monthData: base });
  const c = run({ monthData: ahead });
  assert.equal(c.expense, a.expense, '先記的 500 抵掉之後的預估');
  assert.equal(c.futureRegular, a.futureRegular - 500);
});

test('預估：月底最後一天，只剩今天；今天花超過日均就不再預估', () => {
  const monthData = { expenses: daily(1, 29, 200).concat([exp(30, 50)]), incomes: [] };
  const f = run({ today: todayOf(30), monthData });
  assert.equal(f.daysLeft, 1);
  const avg = 200 * 29 / 30 + HIST_AVG / 30;
  assert.equal(f.futureRegular, Math.round(avg - 50));
  const done = run({ today: todayOf(30), monthData: { expenses: daily(1, 29, 200).concat([exp(30, 900)]), incomes: [] } });
  assert.equal(done.futureRegular, 0);
  assert.equal(done.expense, done.spent);
  assert.equal(done.endBalance, 10000);
});

test('預估：沒有歷史資料時只看本月（含今天）；月初第一筆也不會出現 NaN', () => {
  const f = run({ history: [], monthData: { expenses: daily(1, 13, 100), incomes: [] } });
  assert.equal(f.historyAvg, null);
  assert.equal(f.currentWeight, 1);
  near(f.dailyAvg, 100);
  assert.equal(f.expense, 3000, '30 天 × 100');
  const empty = run({ history: [], today: todayOf(1) });
  assert.equal(empty.dailyAvg, 0);
  assert.equal(empty.expense, 0);
  assert.equal(empty.endBalance, 10000);
  const first = run({ history: [], today: todayOf(1), monthData: { expenses: [exp(1, 100)], incomes: [] } });
  assert.equal(first.expense, 3000);
});

test('預估：歷史只有一、兩個月時，比重重新分配', () => {
  near(run({ history: HISTORY.slice(0, 1), today: todayOf(1) }).dailyAvg, 300);
  near(run({ history: HISTORY.slice(0, 2), today: todayOf(1) }).dailyAvg, (300 * 3 + 200 * 2) / 5);
});

test('預估：一次性大額支出只算進已花，不拉高日均（本月與歷史都一樣）', () => {
  const base = daily(1, 12, 150);
  const a = run({ monthData: { expenses: base, incomes: [] } });
  const b = run({
    monthData: { expenses: base.concat([exp(8, 25000, { item: '其他' })]), incomes: [] },
    history: [hist('2026.10', 31, 300, [['生活費', '其他', 48000]]), HISTORY[1], HISTORY[2]],
  });
  assert.equal(b.oneOffCount, 1);
  assert.equal(b.oneOffTotal, 25000);
  near(b.dailyAvg, a.dailyAvg);
  assert.equal(b.futureRegular, a.futureRegular);
  assert.equal(b.expense, a.expense + 25000, '已花照樣包含');
  assert.ok(b.largeThreshold >= 1000);
});

test('預估：大額門檻是中位數的 5 倍、最少 1000；筆數太少只看 1000', () => {
  assert.equal(fns.forecastLargeThreshold_([100, 100, 100, 100, 100]), 1000);
  assert.equal(fns.forecastLargeThreshold_([400, 400, 400, 400, 400, 9000]), 2000);
  assert.equal(fns.forecastLargeThreshold_([5000, 6000]), 1000);
  assert.equal(fns.forecastLargeThreshold_([]), 1000);
});

test('預估：預留項目不進日均，還沒付的整筆加進預估；排除項目與其他總類完全不算', () => {
  const monthData = {
    expenses: daily(1, 12, 150).concat([
      exp(3, 4000, { item: '房租' }), exp(5, 9000, { item: '旅遊' }), exp(6, 10000, { category: '存款' }),
    ]),
    incomes: [],
  };
  const budget = budgetOf({ reserves: [{ item: '房租', amount: 12000 }, { item: '電信費', amount: 599 }], excludedItems: ['旅遊'] }, monthData, 13);
  const history = [hist('2026.10', 31, 300, [['生活費', '房租', 12000], ['生活費', '旅遊', 700], ['存款', '午餐', 900]]), HISTORY[1], HISTORY[2]];
  const f = run({ monthData, budget, history });
  assert.equal(f.spent, 12 * 150 + 4000);
  assert.equal(f.spent, budget.spent, '和預算卡的已花相同');
  near(f.historyAvg, HIST_AVG, '預留、排除、其他總類都不進日均');
  assert.equal(f.reservedPending, 8000 + 599);
  assert.equal(f.expense, f.spent + f.futureRegular + 8599);
});

test('預估：有預算時「每天安全可花」就是預算的每日額度，差距＝預算 − 預估支出', () => {
  const monthData = { expenses: daily(1, 12, 150).concat([exp(13, 80)]), incomes: [] };
  const budget = budgetOf({}, monthData, 13);
  const f = run({ monthData, budget });
  assert.equal(f.safeDaily, budget.daily);
  assert.equal(f.safeFromBudget, true);
  assert.equal(f.budgetAmount, 30000);
  assert.equal(f.budgetGap, 30000 - f.expense);
});

test('預估：生活費餘額型預算，與預算的差距就是月底預估餘額', () => {
  const monthData = { expenses: daily(1, 12, 150), incomes: [{ day: 5, item: '薪資', category: '生活費', amount: 9000 }] };
  const budget = budgetOf({ source: 'balance', amount: 0 }, monthData, 13, { openingBalance: 4000 });
  const f = run({ monthData, budget, overview: overview(4000 + 9000 - 1800) });
  assert.equal(f.budgetAmount, 13000);
  assert.equal(f.budgetGap, f.endBalance);
  assert.equal(f.incomeBooked, 9000);
});

test('預估：沒有預算時，每天安全可花＝今天以前的餘額平均分到剩下的天數', () => {
  const f = run({ monthData: { expenses: [exp(13, 200)], incomes: [] }, overview: overview(8800) });
  assert.equal(f.safeFromBudget, false);
  assert.equal(f.safeDaily, Math.floor((8800 + 200) / 18));
  assert.equal(f.budgetGap, null);
  assert.equal(run({ overview: overview('-500') }).safeDaily, 0, '已經是負的就是 0');
});

test('預估：讀不到餘額（公式錯誤、找不到標籤、沒有總覽）時不猜', () => {
  for (const ov of [null, overview(1, { livingBalance: '#REF!' }), overview(1, { warnings: [{ type: 'labelNotFound', key: 'livingBalance' }] })]) {
    const f = run({ overview: ov });
    assert.equal(f.balance, null);
    assert.equal(f.endBalance, null);
    assert.equal(f.safeDaily, null);
  }
});

test('預估：尚未入帳的週期收支（F01 的接點）加進支出、收入與每日額度，預留項目不重複算', () => {
  const monthData = { expenses: daily(1, 12, 150), incomes: [{ day: 5, item: '薪資', category: '生活費', amount: 9000 }] };
  const scheduled = {
    expenses: [
      { item: '串流訂閱', category: '生活費', amount: 360 }, { item: '房租', category: '生活費', amount: 12000 },
      { item: '定存', category: '存款', amount: 5000 },
    ],
    incomes: [{ item: '租屋補助', category: '生活費', amount: 3000 }, { item: '薪資', category: '存款', amount: 52000 }],
  };
  const version = { reserves: [{ item: '房租', amount: 12000 }] };
  const plain = budgetOf(version, monthData, 13);
  const budget = budgetOf(version, monthData, 13, { scheduled });
  assert.equal(budget.daily, Math.floor((30000 - 1800 - 12000 - 360) / 18));
  assert.ok(budget.daily < plain.daily);
  const f = run({ monthData, budget, scheduled });
  assert.equal(f.scheduledExpense, 360);
  assert.equal(f.reservedPending, 12000);
  assert.equal(f.scheduledIncome, 3000);
  assert.equal(f.income, 12000);
  assert.equal(f.endBalance, 10000 - (f.expense - f.spent) + 3000);
});

/* ------------------------------ 與圖表回應的整合 ------------------------------ */

const freshCall = (b, action, ...args) => JSON.parse(JSON.stringify(b.runtime.load(fs.readFileSync(path.join(DIST, 'code.gs'), 'utf8')).api({ action, args })));

test('圖表回應：只有本月帶月底預估，記帳後立刻更新；和預算用同一套數字', () => {
  const b = createBackend();
  b.call('saveBudgetSettings', { month: MONTH, source: 'fixed', amount: 30000, categories: ['生活費'], reserves: [] });
  const res = b.call('getOverviewCharts', MONTH, false);
  const f = res.forecast;
  assert.equal(f.spent, res.budget.spent);
  assert.equal(f.safeDaily, res.budget.daily);
  assert.equal(f.balance, 5000);
  assert.equal(f.oneOffCount, 1, '11/5 的 2860 是一次性大額');
  assert.deepEqual(f.historyMonths, ['2026.10']);
  assert.equal(b.call('getOverviewCharts', '2026.10', false).forecast, null);

  b.call('addExpense', expenseForm({ amount: 120 }));
  const after = b.call('getOverviewCharts', MONTH, false).forecast;
  assert.equal(after.spent, f.spent + 120);
  b.DateCtor.advance(DAY);
  assert.equal(b.call('getOverviewCharts', MONTH, false).forecast.daysLeft, 17, '跨日當場重算');
});

test('圖表回應：預熱後快取命中不開試算表；上個月有異動時重建歷史明細', () => {
  const b = createBackend({ workbook: createFixtureWorkbook({ historyMonths: 3 }) });
  b.fns.setup();
  const s = b.runtime.stats;
  const before = s.spreadsheetApp;
  const f = freshCall(b, 'getOverviewCharts', MONTH, false).forecast;
  assert.equal(s.spreadsheetApp - before, 0);
  assert.deepEqual(f.historyMonths, ['2026.10', '2026.09', '2026.08']);

  freshCall(b, 'addExpense', expenseForm({ month: '2026.09', day: 3, amount: 900 }));
  const after = freshCall(b, 'getOverviewCharts', MONTH, false).forecast;
  assert.ok(after.historyAvg > f.historyAvg);
});

test('圖表回應：讀不到歷史或餘額時，圖表照樣回傳', () => {
  const b = createBackend();
  b.sheet(MONTH).getRange('S17').setValue('#REF!');
  const res = b.call('getOverviewCharts', MONTH, false);
  assert.equal(res.forecast.endBalance, null);
  assert.ok(res.current);
});

/* ------------------------------ 預算卡片的顯示 ------------------------------ */

function loadBudgetView() {
  const esc = v => String(v);
  const ctx = vm.createContext({
    window: {}, document: { addEventListener() {} }, Date, Number, String, Math, Array, Set, Object,
    FinanceUtils: { format: v => Number(v).toLocaleString('en-US') },
    getClientToday: () => ({ todayISO: '2026-11-13' }), escHtml: esc, escAttr: esc, iconHtml: () => '', UvFx: { cardRing: '' },
    InfoTip: { html: (id, text) => '<tip id="' + id + '">' + text + '</tip>' },
  });
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/client/scripts/budget/budget-view.js'), 'utf8') + ';this.BudgetView = BudgetView;', ctx);
  return ctx.BudgetView;
}

test('預算卡片：有預估時不再顯示「比進度超前／落後」，每個預估數字都有 info-tip；沒有預估時照舊', () => {
  const view = loadBudgetView();
  const monthData = { expenses: daily(1, 12, 1500), incomes: [] };
  const budget = Object.assign(budgetOf({}, monthData, 13), { todayISO: '2026-11-13' });
  const f = run({ monthData, budget });
  const withForecast = view.progressHtml(budget, MONTH, f);
  assert.ok(!/比進度|剛好在進度上/.test(withForecast), '不出現第二套數字');
  ['end', 'safe', 'expense', 'gap'].forEach(id => assert.match(withForecast, new RegExp('id="fcTip-' + id + '"')));
  assert.ok(withForecast.includes('$' + budget.daily.toLocaleString('en-US')), '每天安全可花＝每日額度');
  assert.match(view.progressHtml(budget, MONTH, null), /比進度超前/);
  assert.match(view.progressHtml(budget, MONTH, Object.assign({}, f, { todayISO: '2026-11-12', generatedAt: 0 })), /比進度超前/, '不是今天算的預估不顯示');
});

test('預算卡片：沒設預算、讀不到餘額時照樣有預估，不出現 NaN 或 null', () => {
  const view = loadBudgetView();
  const none = fns.computeBudgetStatus_(null, MONTH, null, todayOf(13), null);
  const html = view.progressHtml(none, MONTH, run({ overview: null }));
  assert.match(html, /無法計算/);
  assert.ok(!/NaN|null|undefined/.test(html));
  const ok = view.progressHtml(none, MONTH, run());
  assert.match(ok, /月底預估餘額/);
  assert.ok(!/fcTip-gap/.test(ok), '沒有預算就沒有差距');
  assert.ok(!/NaN|null|undefined/.test(ok));
});
