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
 * 預算來源：
 *   固定金額    每月固定一個金額
 *   生活費收入  當月「生活費」總類的收入合計（可限定收入項目）
 *   生活費餘額  總覽「生活費・目前餘額」（月份工作表的「累計生活費總收支」）：
 *               預算 = 月初餘額（上個月累計）＋ 當月生活費收入，
 *               − 已排除的生活費支出（排除項目不算已花，但錢已經從餘額扣掉），
 *               所以只計入生活費總類時，本月剩餘就等於目前餘額，再平均分配到剩下的天數。
 *               月初餘額由該月份工作表算回來（累計 − 當月收入 + 當月支出），只跟之前的月份有關，另外快取。
 *
 * 計算結果不快取：每次回應時用手上的月份明細當場算（掃一遍支出而已），
 * 這樣啟動快取跨日、新增／修改／刪除紀錄後都不需要另外清快取，數字也不會停在昨天。
 */
const BUDGET_HEADERS_ = Object.freeze(['起始月份', '預算來源', '每月預算', '計入總類', '收入項目', '不計入每日額度的項目', '更新時間', '排除項目']);
const BUDGET_SOURCES_ = Object.freeze({ fixed: '固定金額', income: '生活費收入', balance: '生活費餘額', off: '停用' });
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

/* ------------------------- 生活費餘額（月初餘額） ------------------------- */

/**
 * 某個月份的生活費月初餘額 = 該月工作表的「累計生活費總收支 − 當月生活費總收入 + 當月生活費總支出」，
 * 也就是上個月底的累計餘額。讀不到（工作表不存在、公式錯誤）時回傳 null。
 * 這個數字只跟之前的月份有關，記帳時不必重算；之前的月份有異動時由 budgetOpeningCacheKeysAfter_ 清掉。
 */
function budgetOpeningBalance_(ss, month, forceRefresh) {
  const key = CONFIG.CACHE_KEYS.BUDGET_OPENING_PREFIX + month;
  const cache = scriptCache_();
  if (!forceRefresh) {
    let cached = null;
    try { cached = cache.get(key); } catch (e) { cached = null; }
    const value = parseBudgetOpeningCache_(cached);
    if (value !== undefined) return value;
  }

  const spreadsheet = ss || getSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(month);
  if (!sheet) return null; // 還沒建立的月份不快取：建立後就讀得到
  const scan = OVERVIEW_SCAN_RANGE_;
  const numRows = Math.max(1, Math.min(scan.numRows, sheet.getMaxRows() - scan.row + 1));
  const numCols = Math.max(1, Math.min(scan.numCols, sheet.getMaxColumns() - scan.col + 1));
  const values = readOverviewFields_(sheet.getRange(scan.row, scan.col, numRows, numCols).getDisplayValues()).values;
  const nums = ['livingBalance', 'livingIncome', 'livingExpense'].map(function (k) {
    const text = String(values[k] == null ? '' : values[k]).trim();
    return text.charAt(0) === '#' ? NaN : cleanAmount_(text);
  });
  const value = nums.every(Number.isFinite) ? budgetRound_(nums[0] - nums[1] + nums[2]) : null;
  try { cache.put(key, JSON.stringify({ value: value }), CONFIG.CACHE_TTL); } catch (e) {}
  return value;
}

/** 月初餘額快取字串 → 數字或 null；沒有快取或格式不對時回傳 undefined（當作沒命中）。 */
function parseBudgetOpeningCache_(text) {
  if (typeof text !== 'string' || !text) return undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed && (parsed.value === null || typeof parsed.value === 'number')) return parsed.value;
  } catch (e) {}
  return undefined;
}

/** 某個月份有異動時，之後月份的月初餘額都要重算（往後一年）。 */
function budgetOpeningCacheKeysAfter_(month) {
  if (!CONFIG.MONTH_PATTERN.test(String(month || ''))) return [];
  const keys = [];
  for (let i = 1; i <= 12; i++) keys.push(CONFIG.CACHE_KEYS.BUDGET_OPENING_PREFIX + shiftMonth_(month, i));
  return keys;
}

/** computeBudgetStatus_ 需要的額外資料：尚未入帳的週期收支（F01），生活費餘額型另外要月初餘額。 */
function budgetExtras_(ss, version, month, forceRefresh) {
  if (!version) return null;
  const extras = { scheduled: scheduledForMonth_(month) };
  if (version.source === 'balance') extras.openingBalance = budgetOpeningBalance_(ss, month, forceRefresh);
  return extras;
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
 * @param extras     budgetExtras_ 的結果：{ scheduled, openingBalance }（月初餘額只有生活費餘額型需要；null 表示讀不到）
 */
function computeBudgetStatus_(version, month, monthData, today, extras) {
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
  let openingBalance = null;
  if (version.source === 'income' || version.source === 'balance') {
    // 生活費餘額：當月所有生活費收入都會進到餘額，不看收入項目。
    const itemSet = version.source === 'income' && version.incomeItems.length ? new Set(version.incomeItems) : null;
    amount = 0;
    ((monthData && monthData.incomes) || []).forEach(function (rec) {
      if (!rec || String(rec.category).trim() !== BUDGET_INCOME_CATEGORY_) return;
      if (itemSet && !itemSet.has(String(rec.item).trim())) return;
      amount += chartAmount_(rec.amount);
      incomeCount++;
    });
  }
  if (version.source === 'balance') {
    const opening = extras && extras.openingBalance;
    openingBalance = typeof opening === 'number' && Number.isFinite(opening) ? opening : null;
    amount = openingBalance === null ? 0 : openingBalance + amount;
  }

  const isCurrent = mode === 'current';
  const todayDay = Math.min(today.day, daysInMonth);
  let spent = 0;
  let excludedSpent = 0;
  let excludedLiving = 0; // 排除項目中屬於生活費總類的部分（生活費餘額要扣掉）
  let regularBefore = 0;
  let regularToday = 0;
  const reserved = {}; // 項目 → { before, today }
  Object.keys(reserveOf).forEach(function (item) { reserved[item] = { before: 0, today: 0 }; });

  ((monthData && monthData.expenses) || []).forEach(function (rec) {
    if (!rec || !categorySet.has(String(rec.category).trim())) return;
    const value = chartAmount_(rec.amount);
    if (excludedSet.has(String(rec.item).trim())) {
      excludedSpent += value; // 排除項目：不算已花，只記下金額給畫面說明
      if (String(rec.category).trim() === BUDGET_INCOME_CATEGORY_) excludedLiving += value;
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

  // 生活費餘額：排除項目雖然不算已花，但錢已經從餘額扣掉，預算要跟著少，剩餘才會等於目前餘額。
  if (version.source === 'balance' && openingBalance !== null) amount -= excludedLiving;

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
    awaitingBalance: version.source === 'balance' && openingBalance === null,
  });
  if (version.source === 'balance') status.openingBalance = openingBalance === null ? null : budgetRound_(openingBalance);
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

  // 尚未入帳的週期支出（F01）先扣下來，每日額度與總覽的「每天安全可花」是同一個數字（35_forecast.gs）
  const scheduledPending = scheduledExpenseTotal_(extras && extras.scheduled, version.categories, version.excludedItems,
    version.reserves.map(function (r) { return r.item; }));

  const remainingDays = daysInMonth - todayDay + 1;
  const base = amount - (regularBefore + reservedBefore) - reservedPending - scheduledPending;
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
    const version = resolveBudgetVersion_(config, month);
    return computeBudgetStatus_(version, month, monthData, budgetToday_(), budgetExtras_(null, version, month, false));
  } catch (e) {
    console.warn('[budget] 計算失敗：' + (e && e.message ? e.message : e));
    return null;
  }
}

/**
 * 啟動快取裡的預算狀態可能是前幾天算的、清單也可能比較舊（記帳寫入不更新 BOOT_JSON，P10）：
 * 有月份明細時用它蓋過清單並重新計算；沒有完整資料可用（精簡過的快照）而且不是今天算的，就拿掉，讓前端等背景同步。
 * @param monthData    選用：呼叫端已經讀好的月份明細
 * @param budgetCache  選用：{ configJson, openingJson, openingMonth }，已經讀回的預算快取字串
 */
function refreshBootBudget_(boot, monthData, budgetCache) {
  const recent = boot && boot.initialRecent;
  if (!recent || !recent.month) return boot;
  const md = monthData || getCachedMonthData_(recent.month);
  if (md) overlayBootRecent_(boot, md);
  const lists = md ||
    (Array.isArray(recent.fullExpenses) ? { expenses: recent.fullExpenses, incomes: recent.fullIncomes || [] } : null);
  if (lists) {
    // 呼叫端已經一次 getAll 讀回預算設定與月初餘額時直接用（P11），缺的才由 budgetStatusForMonth_ 自己讀
    const fromCache = budgetCache
      ? budgetStatusFromCache_(recent.month, lists, budgetCache.configJson, budgetCache.openingJson, budgetCache.openingMonth)
      : null;
    recent.budget = fromCache ? fromCache.status : budgetStatusForMonth_(recent.month, lists);
  } else if (recent.budget && recent.budget.todayISO !== budgetToday_().iso) {
    recent.budget = null;
  }
  return boot;
}

/**
 * doGet 用（P09）：只用已經從快取一次讀回來的預算設定與月初餘額計算，絕不開試算表。
 * 回傳 { status }；設定或月初餘額不在快取裡時回傳 null，呼叫端改成不帶 budget、標示需要背景同步。
 * @param configJson   BUDGET_CONFIG 的快取字串
 * @param openingJson  BUDGET_OPENING_<openingMonth> 的快取字串
 */
function budgetStatusFromCache_(month, monthData, configJson, openingJson, openingMonth) {
  try {
    if (!CONFIG.MONTH_PATTERN.test(String(month || '')) || !configJson) return null;
    const config = JSON.parse(configJson);
    if (!config || !Array.isArray(config.versions)) return null;
    const version = resolveBudgetVersion_(config, month);
    let extras = version ? { scheduled: scheduledForMonth_(month) } : null;
    if (version && version.source === 'balance') {
      if (month !== openingMonth || !openingJson) return null;
      const opening = JSON.parse(openingJson);
      if (!opening || !(opening.value === null || typeof opening.value === 'number')) return null;
      extras.openingBalance = opening.value;
    }
    return { status: computeBudgetStatus_(version, month, monthData, budgetToday_(), extras) };
  } catch (e) {
    return null;
  }
}
