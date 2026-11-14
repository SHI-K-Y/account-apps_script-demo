/**
 * 預算：讀取「_預算設定」工作表，並依月份明細算出本月剩餘、每日額度與今天還能花。
 *
 * 工作表一列代表「從某個月起生效的一整組設定」：
 *   起始月份｜預算來源｜每月預算｜計入總類｜收入項目｜不計入每日額度的項目｜更新時間｜排除項目
 *   （「排除項目」是後來加的欄位，放在最後面，舊的列沒有這一欄也能正常讀取）
 *
 * 兩種「不算」的項目：
 *   不計入每日額度的項目（預留）  照樣算進本月已花，只是先預留金額、不影響每日額度（房租、電信費）
 *   排除項目                      完全不計入預算：本月已花、每日額度、今天還能花都不看它（旅遊、大件 3C）
 * 某個月份套用「起始月份 ≤ 該月」之中最晚的那一列，所以修改本月的設定不會改到過去的月份。
 *
 * 計算結果不快取：每次回應時用手上的月份明細當場算（掃一遍支出而已），
 * 這樣啟動快取跨日、新增／修改／刪除紀錄後都不需要另外清快取，數字也不會停在昨天。
 */
const BUDGET_HEADERS_ = Object.freeze(['起始月份', '預算來源', '每月預算', '計入總類', '收入項目', '不計入每日額度的項目', '更新時間', '排除項目']);
const BUDGET_SOURCES_ = Object.freeze({ fixed: '固定金額', income: '生活費收入', off: '停用' });
const BUDGET_DEFAULT_CATEGORIES_ = Object.freeze(['生活費']);
const BUDGET_INCOME_CATEGORY_ = '生活費';
const BUDGET_LIST_SEP_ = '、';
const BUDGET_RESERVE_SEP_ = '；';

/* ------------------------------ 設定的讀取（資料存取層） ------------------------------ */

function budgetSourceKey_(value) {
  const text = String(value == null ? '' : value).trim();
  if (Object.prototype.hasOwnProperty.call(BUDGET_SOURCES_, text)) return text;
  const keys = Object.keys(BUDGET_SOURCES_);
  for (let i = 0; i < keys.length; i++) {
    if (BUDGET_SOURCES_[keys[i]] === text) return keys[i];
  }
  return '';
}

function splitBudgetList_(value) {
  const seen = new Set();
  return String(value == null ? '' : value)
    .split(/[、,，\n]/)
    .map(function (s) { return s.trim(); })
    .filter(function (s) {
      if (!s || seen.has(s)) return false;
      seen.add(s);
      return true;
    });
}

/** 「房租=12500；電信費=599」→ [{ item: '房租', amount: 12500 }, …] */
function parseBudgetReserves_(value) {
  const out = [];
  const seen = new Set();
  String(value == null ? '' : value).split(/[；;\n]/).forEach(function (part) {
    const text = part.trim();
    const at = text.lastIndexOf('=');
    if (at <= 0) return;
    const item = text.slice(0, at).trim();
    const amount = cleanAmount_(text.slice(at + 1));
    if (!item || seen.has(item) || !(amount >= 0)) return;
    seen.add(item);
    out.push({ item: item, amount: amount });
  });
  return out;
}

function formatBudgetReserves_(reserves) {
  return (reserves || []).map(function (r) { return r.item + '=' + r.amount; }).join(BUDGET_RESERVE_SEP_);
}

function budgetRowToVersion_(row) {
  const month = normalizeSummaryMonth_(row[0]);
  const source = budgetSourceKey_(row[1]);
  if (!CONFIG.MONTH_PATTERN.test(month) || !source) return null;
  const updated = row[6];
  return {
    month: month,
    source: source,
    amount: source === 'fixed' ? Math.max(0, cleanAmount_(row[2])) : 0,
    categories: source === 'off' ? [] : (splitBudgetList_(row[3]).length ? splitBudgetList_(row[3]) : BUDGET_DEFAULT_CATEGORIES_.slice()),
    incomeItems: source === 'income' ? splitBudgetList_(row[4]) : [],
    reserves: source === 'off' ? [] : parseBudgetReserves_(row[5]),
    excludedItems: source === 'off' ? [] : splitBudgetList_(row[7]),
    updatedAt: updated instanceof Date ? updated.getTime() : null,
  };
}

/** 讀取所有設定版本（依起始月份由舊到新）。工作表不存在時回傳空清單。 */
function readBudgetConfig_(ss, forceRefresh) {
  const cache = scriptCache_();
  if (!forceRefresh) {
    const cached = cache.get(CONFIG.CACHE_KEYS.BUDGET_CONFIG);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
  }

  const spreadsheet = ss || getSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(CONFIG.BUDGET_SHEET);
  const byMonth = {};
  if (sheet && sheet.getLastRow() >= 2) {
    const width = Math.min(BUDGET_HEADERS_.length, sheet.getMaxColumns());
    const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, width).getValues();
    values.forEach(function (row) {
      const version = budgetRowToVersion_(row);
      if (version) byMonth[version.month] = version; // 同一個月份重複時，以下面那一列為準
    });
  }
  const config = {
    versions: Object.keys(byMonth).sort().map(function (m) { return byMonth[m]; }),
  };
  saveBudgetConfigCache_(config);
  return config;
}

function saveBudgetConfigCache_(config) {
  try {
    scriptCache_().put(CONFIG.CACHE_KEYS.BUDGET_CONFIG, JSON.stringify(config), CONFIG.CACHE_TTL);
  } catch (e) {}
}

/** 某個月份適用的設定；沒有設定或已停用時回傳 null。 */
function resolveBudgetVersion_(config, month) {
  const versions = (config && config.versions) || [];
  let found = null;
  for (let i = 0; i < versions.length; i++) {
    if (versions[i].month <= month) found = versions[i];
    else break;
  }
  return found && found.source !== 'off' ? found : null;
}

/* ---------------------------------- 計算 ---------------------------------- */

function budgetRound_(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}

/**
 * 算出某個月份的預算狀態（純計算，方便測試）。
 * @param version    resolveBudgetVersion_ 的結果；null 表示沒設預算
 * @param month      'yyyy.MM'
 * @param monthData  { expenses, incomes }（getMonthData_ 的結果；可為 null，視為沒有紀錄）
 * @param today      budgetToday_() 的結果
 */
function computeBudgetStatus_(version, month, monthData, today) {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const mode = month === today.month ? 'current' : (month < today.month ? 'past' : 'future');
  const status = { month: month, todayISO: today.iso, generatedAt: Date.now(), mode: mode, daysInMonth: daysInMonth, configured: false };
  if (!version) return status;

  const categorySet = new Set(version.categories);
  const excludedSet = new Set(version.excludedItems || []);
  const reserveOf = {};
  version.reserves.forEach(function (r) { reserveOf[r.item] = r.amount; });

  let amount = version.amount;
  let incomeCount = 0;
  if (version.source === 'income') {
    const itemSet = version.incomeItems.length ? new Set(version.incomeItems) : null;
    amount = 0;
    ((monthData && monthData.incomes) || []).forEach(function (rec) {
      if (!rec || String(rec.category).trim() !== BUDGET_INCOME_CATEGORY_) return;
      if (itemSet && !itemSet.has(String(rec.item).trim())) return;
      amount += chartAmount_(rec.amount);
      incomeCount++;
    });
  }

  const isCurrent = mode === 'current';
  const todayDay = Math.min(today.day, daysInMonth);
  let spent = 0;
  let excludedSpent = 0;
  let regularBefore = 0;
  let regularToday = 0;
  const reserved = {}; // 項目 → { before, today }
  Object.keys(reserveOf).forEach(function (item) { reserved[item] = { before: 0, today: 0 }; });

  ((monthData && monthData.expenses) || []).forEach(function (rec) {
    if (!rec || !categorySet.has(String(rec.category).trim())) return;
    const value = chartAmount_(rec.amount);
    if (excludedSet.has(String(rec.item).trim())) {
      excludedSpent += value; // 排除項目：完全不計入預算，只記下金額給畫面說明
      return;
    }
    spent += value;
    if (!isCurrent) return;
    // 日期填錯或預先記下的未來支出，一律當成已經花掉（保守估計）。
    const isToday = parseInt(rec.day, 10) === todayDay;
    const bucket = reserved[String(rec.item).trim()];
    if (bucket) bucket[isToday ? 'today' : 'before'] += value;
    else if (isToday) regularToday += value;
    else regularBefore += value;
  });

  Object.assign(status, {
    configured: true,
    source: version.source,
    effectiveFrom: version.month,
    categories: version.categories.slice(),
    excludedItems: (version.excludedItems || []).slice(),
    excludedSpent: budgetRound_(excludedSpent),
    amount: budgetRound_(amount),
    spent: budgetRound_(spent),
    remaining: budgetRound_(amount - spent),
    overspent: budgetRound_(Math.max(0, spent - amount)),
    awaitingIncome: version.source === 'income' && incomeCount === 0,
  });
  if (!isCurrent) return status;

  // 預留法：不計入每日額度的項目從月初就先扣掉預留金額；付款時從預留裡扣，超出預留的部分才算進當天的花費。
  let reservedTotal = 0;
  let reservedPending = 0;
  let reservedBefore = 0;
  let overflowToday = 0;
  let reservedUsed = 0;
  const reserves = version.reserves.map(function (r) {
    const b = reserved[r.item];
    reservedTotal += r.amount;
    reservedBefore += b.before;
    reservedPending += Math.max(0, r.amount - b.before);
    overflowToday += Math.max(0, b.before + b.today - r.amount) - Math.max(0, b.before - r.amount);
    reservedUsed += Math.min(b.before + b.today, r.amount);
    return { item: r.item, amount: r.amount, spent: budgetRound_(b.before + b.today) };
  });

  const remainingDays = daysInMonth - todayDay + 1;
  const base = amount - (regularBefore + reservedBefore) - reservedPending;
  const daily = base > 0 ? Math.floor(base / remainingDays) : 0;
  const todaySpent = regularToday + overflowToday;
  // 應花到的位置：排除項目付了才算，其餘照天數平均分攤（算到今天結束）。
  const expected = reservedUsed + Math.max(0, amount - reservedTotal) * todayDay / daysInMonth;

  return Object.assign(status, {
    day: todayDay,
    remainingDays: remainingDays,
    reserves: reserves,
    reservedPending: budgetRound_(reservedPending),
    shortfall: budgetRound_(Math.max(0, -base)),
    daily: daily,
    todaySpent: budgetRound_(todaySpent),
    todayLeft: budgetRound_(daily - todaySpent),
    expected: budgetRound_(expected),
    paceDiff: budgetRound_(spent - expected),
  });
}

/** 給各個回應使用：讀設定並計算；任何錯誤都不影響原本的功能（回傳 null，前端就不顯示）。 */
function budgetStatusForMonth_(month, monthData) {
  try {
    if (!CONFIG.MONTH_PATTERN.test(String(month || ''))) return null;
    const config = readBudgetConfig_(null, false);
    return computeBudgetStatus_(resolveBudgetVersion_(config, month), month, monthData, budgetToday_());
  } catch (e) {
    console.warn('[budget] 計算失敗：' + (e && e.message ? e.message : e));
    return null;
  }
}

/**
 * 啟動快取裡的預算狀態可能是前幾天算的：用快取裡的完整支出重新計算。
 * 沒有完整資料可用（精簡過的快照）而且不是今天算的，就拿掉，讓前端等背景同步。
 */
function refreshBootBudget_(boot) {
  const recent = boot && boot.initialRecent;
  if (!recent || !recent.month) return boot;
  const monthData = getCachedMonthData_(recent.month) ||
    (Array.isArray(recent.fullExpenses) ? { expenses: recent.fullExpenses, incomes: recent.fullIncomes || [] } : null);
  if (monthData) {
    recent.budget = budgetStatusForMonth_(recent.month, monthData);
  } else if (recent.budget && recent.budget.todayISO !== budgetToday_().iso) {
    recent.budget = null;
  }
  return boot;
}
