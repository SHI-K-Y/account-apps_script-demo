/**
 * 月底預估（F06）：照這樣花，本月會花多少、月底會剩多少、每天安全可花多少、和預算差多少。
 *
 * 計算範圍（總類）和預算相同：有設定預算用預算的「計入總類」，沒有就用生活費；排除項目完全不算。
 *
 *   日均        只看「一般支出」：扣掉預留項目與一次性大額支出（單筆超過門檻，見 forecastLargeThreshold_）。
 *               過去 3 個月各自的日均以 3：2：1 加權（越近越重），再和本月至今的日均混合：
 *               本月的比重＝已過完的天數 ÷ 當月天數（月初看歷史、月底看本月）。沒有歷史時只看本月（含今天）。
 *   接下來的一般支出  ＝ 日均 × 剩餘天數（含今天）− 今天與之後日期已經記下的一般支出（最少 0）
 *   本月預估支出 ＝ 已花 ＋ 接下來的一般支出 ＋ 還沒付的預留 ＋ 尚未入帳的週期支出
 *   本月預估收入 ＝ 已入帳 ＋ 尚未入帳的週期收入
 *   月底預估餘額 ＝ 目前餘額（總覽的累計餘額）−（本月預估支出 − 已花）＋ 尚未入帳的週期收入
 *   每天安全可花 ＝ 預算的「每日額度」（33_budget.gs 的 daily，同一個數字）；沒有預算時＝今天以前的餘額平均分到剩下的天數
 *   與預算的差距 ＝ 預算 − 本月預估支出（正＝月底還剩，負＝會超出）
 *
 * 週期收支（F01）還沒有：scheduledForMonth_ 回傳空清單，數字當作 0；F01 完成時只要改那個函式。
 * 到期卡費（F04）刻意不加：這本帳在刷卡當天就從餘額扣掉，繳卡費不是新的支出，加進來會重複計算。
 *
 * 計算結果不快取（和預算一樣，每次回應當場算）；前三個月的明細精簡後存快取（FORECAST_HISTORY_<本月>）。
 */
const FORECAST_HISTORY_MONTHS_ = 3;
const FORECAST_HISTORY_WEIGHTS_ = Object.freeze([3, 2, 1]);
const FORECAST_LARGE_MIN_ = 1000;       // 單筆至少超過這個金額才可能算「一次性大額」
const FORECAST_LARGE_RATIO_ = 5;        // 而且超過一般單筆中位數的幾倍
const FORECAST_LARGE_MIN_SAMPLES_ = 5;  // 筆數太少時中位數不可靠，只看金額門檻
const FORECAST_BALANCE_FIELDS_ = Object.freeze({ 生活費: 'livingBalance', 存款: 'savingsBalance', 代收代付: 'agencyBalance' });

/**
 * 本月尚未入帳的週期收支（F01）：{ expenses: [{ item, category, amount }], incomes: [同上] }，只列還沒記進帳的。
 * 預算的每日額度與月底預估都用它。F01 完成時在這裡接上；doGet 與記帳寫入都會經過，必須只讀快取、不開試算表。
 */
function scheduledForMonth_(month) {
  return { expenses: [], incomes: [] };
}

/** 週期支出裡會算進預算的部分：在計入的總類裡、不是排除項目；預留項目已經先扣預留，不重複算。 */
function scheduledExpenseTotal_(scheduled, categories, excludedItems, reserveItems) {
  const cats = new Set(categories);
  const skip = new Set((excludedItems || []).concat(reserveItems || []));
  return ((scheduled && scheduled.expenses) || []).reduce(function (sum, r) {
    if (!r || !cats.has(String(r.category).trim()) || skip.has(String(r.item).trim())) return sum;
    return sum + chartAmount_(r.amount);
  }, 0);
}

/** 一次性大額支出的門檻：超過這個金額的單筆不列入日均。amounts 是所有一般支出的單筆金額。 */
function forecastLargeThreshold_(amounts) {
  if (amounts.length < FORECAST_LARGE_MIN_SAMPLES_) return FORECAST_LARGE_MIN_;
  const sorted = amounts.slice().sort(function (a, b) { return a - b; });
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return Math.max(FORECAST_LARGE_MIN_, budgetRound_(median * FORECAST_LARGE_RATIO_));
}

/**
 * 算出本月的月底預估（純計算，方便測試）。
 * @param input.month      本月 'yyyy.MM'
 * @param input.today      budgetToday_() 的結果（月份要等於 month）
 * @param input.monthData  本月明細 { expenses, incomes }（null 視為沒有紀錄）
 * @param input.history    過去月份 [{ month, expenses: [[總類, 項目, 金額], …] }]，由近到遠，最多 3 個月
 * @param input.budget     computeBudgetStatus_ 的結果（null 或沒設定時用生活費、沒有預算）
 * @param input.overview   本月總覽（getAssetOverview_ 的結果；null 時沒有餘額）
 * @param input.scheduled  scheduledForMonth_ 的結果
 */
function computeMonthForecast_(input) {
  const month = input.month;
  const today = input.today;
  const daysInMonth = new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate();
  const day = Math.min(today.day, daysInMonth);
  const daysLeft = daysInMonth - day + 1;
  const scheduled = input.scheduled || { expenses: [], incomes: [] };

  const b = input.budget && input.budget.configured ? input.budget : null;
  const budgetUsable = Boolean(b) && !b.awaitingIncome && !b.awaitingBalance;
  const categories = b ? b.categories.slice() : BUDGET_DEFAULT_CATEGORIES_.slice();
  const excludedItems = (b && b.excludedItems) || [];
  const reserves = (b && b.reserves) || [];
  const reserveItems = reserves.map(function (r) { return r.item; });
  const catSet = new Set(categories);
  const excludedSet = new Set(excludedItems);
  const reserveSet = new Set(reserveItems);
  const inScope = function (category, item) { return catSet.has(category) && !excludedSet.has(item); };

  // 本月：已花、今天的支出、一般支出（還沒扣大額）
  let spent = 0;
  let todaySpent = 0;
  const regular = [];
  ((input.monthData && input.monthData.expenses) || []).forEach(function (rec) {
    if (!rec) return;
    const item = String(rec.item).trim();
    if (!inScope(String(rec.category).trim(), item)) return;
    const value = chartAmount_(rec.amount);
    const recDay = parseInt(rec.day, 10);
    spent += value;
    if (recDay === day) todaySpent += value;
    if (!reserveSet.has(item)) regular.push({ day: recDay, amount: value });
  });

  // 過去月份的一般支出
  const history = (input.history || []).slice(0, FORECAST_HISTORY_MONTHS_).map(function (h, i) {
    const amounts = [];
    (h.expenses || []).forEach(function (e) {
      const item = String(e[1]).trim();
      if (!inScope(String(e[0]).trim(), item) || reserveSet.has(item)) return;
      amounts.push(chartAmount_(e[2]));
    });
    return {
      month: h.month,
      days: new Date(Number(h.month.slice(0, 4)), Number(h.month.slice(5, 7)), 0).getDate(),
      weight: FORECAST_HISTORY_WEIGHTS_[i],
      amounts: amounts,
    };
  }).filter(function (h) { return h.amounts.length > 0; });

  const threshold = forecastLargeThreshold_(history.reduce(function (all, h) { return all.concat(h.amounts); }, [])
    .concat(regular.map(function (r) { return r.amount; })));
  const isLarge = function (amount) { return amount > threshold; };

  let oneOffTotal = 0;
  let oneOffCount = 0;
  let regularBefore = 0;  // 今天以前（日期填錯的也算在這裡，和預算一樣保守）
  let regularToday = 0;
  let regularAhead = 0;   // 日期在今天之後、先記下來的
  regular.forEach(function (r) {
    if (isLarge(r.amount)) {
      oneOffTotal += r.amount;
      oneOffCount++;
    } else if (r.day === day) regularToday += r.amount;
    else if (r.day > day && r.day <= daysInMonth) regularAhead += r.amount;
    else regularBefore += r.amount;
  });

  // 日均：歷史（3：2：1 加權）與本月（已過完的天數）混合
  let weightSum = 0;
  let weighted = 0;
  history.forEach(function (h) {
    const total = h.amounts.reduce(function (sum, v) { return isLarge(v) ? sum : sum + v; }, 0);
    weighted += total / h.days * h.weight;
    weightSum += h.weight;
  });
  const historyAvg = weightSum > 0 ? weighted / weightSum : null;
  const elapsed = day - 1;
  let currentAvg = elapsed > 0 ? regularBefore / elapsed : null;
  let currentWeight = elapsed / daysInMonth;
  if (historyAvg === null) {
    currentAvg = (regularBefore + regularToday) / day;
    currentWeight = 1;
  }
  const dailyAvg = (currentAvg || 0) * currentWeight + (historyAvg || 0) * (1 - currentWeight);

  const futureRegular = Math.round(Math.max(0, dailyAvg * daysLeft - regularToday - regularAhead));
  const reservedPending = reserves.reduce(function (sum, r) { return sum + Math.max(0, r.amount - r.spent); }, 0);
  const scheduledExpense = scheduledExpenseTotal_(scheduled, categories, excludedItems, reserveItems);
  const sumIncome = function (list) {
    return (list || []).reduce(function (sum, r) {
      return r && catSet.has(String(r.category).trim()) ? sum + chartAmount_(r.amount) : sum;
    }, 0);
  };
  const incomeBooked = sumIncome(input.monthData && input.monthData.incomes);
  const scheduledIncome = sumIncome(scheduled.incomes);
  const remainingExpense = futureRegular + reservedPending + scheduledExpense;
  const expense = spent + remainingExpense;

  // 目前餘額：計算範圍內有累計餘額的總類加總；讀不到（公式錯誤、找不到標籤）時不猜
  const overview = input.overview;
  const missing = new Set(((overview && overview.warnings) || []).map(function (w) { return w && w.key; }));
  const balanceCats = categories.filter(function (c) { return Object.prototype.hasOwnProperty.call(FORECAST_BALANCE_FIELDS_, c); });
  let balance = overview && balanceCats.length ? 0 : null;
  balanceCats.forEach(function (c) {
    const field = FORECAST_BALANCE_FIELDS_[c];
    const value = overview && !missing.has(field) ? overviewNumber_(overview[field]) : null;
    balance = balance === null || value === null ? null : balance + value;
  });
  const endBalance = balance === null ? null : balance - remainingExpense + scheduledIncome;

  let safeDaily = null;
  if (budgetUsable) safeDaily = b.daily;
  else if (balance !== null) safeDaily = Math.max(0, Math.floor((balance + todaySpent - reservedPending - scheduledExpense) / daysLeft));

  // 生活費餘額型的預算會跟著收入變多，尚未入帳的週期收入也要算進月底的預算
  const budgetAmount = budgetUsable ? b.amount + (b.source === 'balance' ? scheduledIncome : 0) : null;
  const orNull = function (v) { return v === null ? null : budgetRound_(v); };
  return {
    month: month,
    todayISO: today.iso,
    generatedAt: Date.now(),
    day: day,
    daysInMonth: daysInMonth,
    daysLeft: daysLeft,
    categories: categories,
    spent: budgetRound_(spent),
    dailyAvg: budgetRound_(dailyAvg),
    currentAvg: orNull(currentAvg),
    historyAvg: orNull(historyAvg),
    currentWeight: Math.round(currentWeight * 100) / 100,
    historyMonths: history.map(function (h) { return h.month; }),
    largeThreshold: threshold,
    oneOffTotal: budgetRound_(oneOffTotal),
    oneOffCount: oneOffCount,
    futureRegular: futureRegular,
    reservedPending: budgetRound_(reservedPending),
    scheduledExpense: budgetRound_(scheduledExpense),
    expense: budgetRound_(expense),
    incomeBooked: budgetRound_(incomeBooked),
    scheduledIncome: budgetRound_(scheduledIncome),
    income: budgetRound_(incomeBooked + scheduledIncome),
    balance: orNull(balance),
    balanceCategories: balanceCats,
    endBalance: orNull(endBalance),
    safeDaily: safeDaily,
    safeFromBudget: budgetUsable,
    budgetAmount: orNull(budgetAmount),
    budgetGap: budgetAmount === null ? null : budgetRound_(budgetAmount - expense),
  };
}

/* ------------------------------ 資料來源 ------------------------------ */

/** 某個月份有異動時，把它當歷史的月份（之後 3 個月）要重建。 */
function forecastHistoryCacheKeysAfter_(month) {
  if (!CONFIG.MONTH_PATTERN.test(String(month || ''))) return [];
  const keys = [];
  for (let i = 1; i <= FORECAST_HISTORY_MONTHS_; i++) keys.push(CONFIG.CACHE_KEYS.FORECAST_HISTORY_PREFIX + shiftMonth_(month, i));
  return keys;
}

/** 前三個月（由近到遠，舊版面與不存在的略過）的精簡支出明細；建好存進快取。 */
function loadForecastHistory_(month) {
  const ss = getSpreadsheet_();
  const existing = new Set(getMonthsList_(ss, false));
  const wanted = [];
  for (let i = 1; i <= FORECAST_HISTORY_MONTHS_; i++) {
    const m = shiftMonth_(month, -i);
    if (existing.has(m)) wanted.push(m);
  }
  const current = new Set(classifyMonthLayouts_(function () { return ss; }, wanted, false).current);
  let complete = true;
  const history = wanted.filter(function (m) { return current.has(m); }).map(function (m) {
    try {
      const data = getMonthData_(ss, m, false);
      return {
        month: m,
        expenses: (data.expenses || []).map(function (r) { return [String(r.category).trim(), String(r.item).trim(), chartAmount_(r.amount)]; }),
      };
    } catch (e) {
      complete = false;
      return null;
    }
  }).filter(Boolean);
  if (complete) cachePutLarge_(CONFIG.CACHE_KEYS.FORECAST_HISTORY_PREFIX + month, history, CONFIG.CACHE_TTL);
  return history;
}

/**
 * 圖表回應裡的月底預估（只有本月有，其他月份回傳 null）；任何錯誤都不影響圖表（回傳 null，前端就不顯示）。
 * @param prefetched  { monthData, forecastHistory, overview }（getOverviewCharts_ 一次 getAll 讀回的；缺的才自己讀）
 * @param budget      這次回應的預算狀態
 */
function monthForecast_(month, prefetched, budget) {
  try {
    const today = budgetToday_();
    if (month !== today.month) return null;
    const p = prefetched || {};
    return computeMonthForecast_({
      month: month,
      today: today,
      monthData: p.monthData || getMonthData_(null, month, false),
      history: Array.isArray(p.forecastHistory) ? p.forecastHistory : loadForecastHistory_(month),
      budget: budget,
      overview: p.overview || getAssetOverview_(false),
      scheduled: scheduledForMonth_(month),
    });
  } catch (e) {
    console.warn('[forecast] 計算失敗：' + (e && e.message ? e.message : e));
    return null;
  }
}
