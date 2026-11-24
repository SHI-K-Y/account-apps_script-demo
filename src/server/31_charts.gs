const CHARTS_UNCATEGORIZED_ = '未分類';
const CHARTS_UNNAMED_ITEM_ = '未填項目';
const CHARTS_TREND_MONTHS_ = 6;
const CACHE_VALUE_MAX_BYTES_ = 100000;

/**
 * 總覽圖表。先查快取（P11）：圖表、簡易選項、預算設定、月初餘額、這個月的明細一次 getAll 讀回，
 * 命中時分類用 OPTIONS_SIMPLE（不解整份 OPTIONS_ALL）、預算用同一次讀到的明細當場算，不開試算表。
 */
function getOverviewCharts_(month, forceRefresh) {
  validateMonthFormat_(month);
  const isForce = Boolean(forceRefresh);
  const cache = scriptCache_();
  const K = CONFIG.CACHE_KEYS;
  const cacheKey = K.CHARTS_PREFIX + month;
  const monthKey = K.MONTH_DATA_PREFIX + month;
  const openingKey = K.BUDGET_OPENING_PREFIX + month;

  // 預算要用的快取字串；undefined 表示沒有先讀（強制重建），由 budgetStatusForMonth_ 自己讀
  let prefetched = { monthData: null, simpleJson: undefined, configJson: undefined, openingJson: undefined };
  if (!isForce) {
    const got = cacheGetAllMixed_([monthKey], [cacheKey, K.OPTIONS_SIMPLE, K.BUDGET_CONFIG, openingKey]);
    prefetched = {
      monthData: got.large[monthKey],
      simpleJson: got.plain[K.OPTIONS_SIMPLE],
      configJson: got.plain[K.BUDGET_CONFIG],
      openingJson: got.plain[openingKey],
    };
    const cached = got.plain[cacheKey];
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        // 簡易選項不在快取時，沿用圖表快取裡存的分類（產生圖表當時的設定），不為了它解 OPTIONS_ALL 或開試算表
        const simple = parseSimpleOptionsCache_(prefetched.simpleJson);
        if (simple) parsed.categories = chartCategoriesFrom_(simple);
        parsed.budget = chartsBudgetStatus_(month, prefetched);
        return parsed;
      } catch (e) {}
    }
  }

  const ss = getSpreadsheet_();
  let months = getMonthsList_(ss, isForce);
  if (months.indexOf(month) === -1 && !isForce) {
    months = getMonthsList_(ss, true);
  }
  if (months.indexOf(month) === -1) {
    throw new Error(`找不到「${month}」工作表。`);
  }

  const existing = new Set(months);
  const trendMonths = [];
  for (let i = CHARTS_TREND_MONTHS_ - 1; i >= 0; i--) {
    const m = shiftMonth_(month, -i);
    if (existing.has(m)) trendMonths.push(m);
  }

  const prevMonth = shiftMonth_(month, -1);
  const statsByMonth = {};
  const summaryMonths = [];

  function statsFromDetail(m) {
    try {
      if (!isNewLayoutMonth_(ss, m, isForce)) return;
      statsByMonth[m] = buildChartMonthStats_(m, getMonthData_(ss, m, isForce));
    } catch (e) {}
  }

  trendMonths.forEach(function (m) {
    if (m === month) {
      // 這個月的明細：沿用 getAll 已經讀到的那份，預算也用同一份算
      if (!prefetched.monthData) prefetched.monthData = getMonthData_(ss, m, isForce);
      statsByMonth[m] = buildChartMonthStats_(m, prefetched.monthData);
    } else if (m === prevMonth) {
      statsFromDetail(m);
    } else {
      summaryMonths.push(m);
    }
  });

  if (summaryMonths.length) {
    try {
      const summary = getSummary_(ss, summaryMonths, { forceRebuild: isForce });
      summaryMonths.forEach(function (m) {
        const s = summary[m];
        if (s && !s.skipped) statsByMonth[m] = chartMonthStatsFromSummary_(m, s);
      });
    } catch (e) {
      summaryMonths.forEach(statsFromDetail);
    }
  }

  const result = {
    month: month,
    generatedAt: Date.now(),
    categories: getChartExpenseCategories_(ss, prefetched.simpleJson),
    current: statsByMonth[month],
    previous: statsByMonth[prevMonth] || null,
    trend: trendMonths
      .filter(function (m) { return Boolean(statsByMonth[m]); })
      .map(function (m) {
        const stats = statsByMonth[m];
        const expenseByCategory = {};
        Object.keys(stats.byCategory).forEach(function (cat) {
          expenseByCategory[cat] = stats.byCategory[cat].total;
        });
        return { month: m, incomeTotal: stats.incomeTotal, expenseByCategory: expenseByCategory };
      }),
  };

  try {
    const jsonStr = JSON.stringify(result);
    if (fitsCacheValue_(jsonStr)) {
      cache.put(cacheKey, jsonStr, CONFIG.CACHE_TTL);
    }
  } catch (e) {}

  // 預算狀態不放進圖表快取：每次當場算，改預算或跨日都不必清圖表快取。
  result.budget = chartsBudgetStatus_(month, prefetched);
  return result;
}

/**
 * 圖表回應裡的預算狀態：用這次執行已經讀到的明細與快取字串算；缺的才各自去讀（可能開試算表）。
 * @param prefetched  { monthData, configJson, openingJson }（getOverviewCharts_ 一次 getAll 讀回的）
 */
function chartsBudgetStatus_(month, prefetched) {
  try {
    const p = prefetched || {};
    const monthData = p.monthData || getMonthData_(null, month, false);
    if (typeof p.configJson === 'string') {
      const fromCache = budgetStatusFromCache_(month, monthData, p.configJson, p.openingJson, month);
      if (fromCache) return fromCache.status;
    }
    return budgetStatusForMonth_(month, monthData);
  } catch (e) {
    return null;
  }
}

function buildChartMonthStats_(month, monthData) {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  const byCategory = {};

  const expenses = (monthData && monthData.expenses) || [];
  for (let i = 0; i < expenses.length; i++) {
    const rec = expenses[i] || {};
    const amount = chartAmount_(rec.amount);
    const category = String(rec.category == null ? '' : rec.category).trim() || CHARTS_UNCATEGORIZED_;
    const item = String(rec.item == null ? '' : rec.item).trim() || CHARTS_UNNAMED_ITEM_;

    let bucket = byCategory[category];
    if (!bucket) {
      bucket = byCategory[category] = {
        total: 0,
        count: 0,
        byItem: {},
        daily: new Array(daysInMonth).fill(0),
        dailyCount: new Array(daysInMonth).fill(0),
        maxRecord: null,
      };
    }

    bucket.total += amount;
    bucket.count += 1;

    const itemStat = bucket.byItem[item] || (bucket.byItem[item] = { total: 0, count: 0 });
    itemStat.total += amount;
    itemStat.count += 1;

    const day = Number(rec.day);
    const validDay = Number.isInteger(day) && day >= 1 && day <= daysInMonth ? day : null;
    if (validDay) {
      bucket.daily[validDay - 1] += amount;
      bucket.dailyCount[validDay - 1] += 1;
    }

    if (!bucket.maxRecord || amount > bucket.maxRecord.amount) {
      bucket.maxRecord = {
        day: validDay,
        item: item,
        amount: amount,
        note: String(rec.note == null ? '' : rec.note).slice(0, 60),
      };
    }
  }

  Object.keys(byCategory).forEach(function (cat) {
    const bucket = byCategory[cat];
    bucket.total = roundChartNumber_(bucket.total);
    bucket.daily = bucket.daily.map(roundChartNumber_);
    Object.keys(bucket.byItem).forEach(function (name) {
      bucket.byItem[name].total = roundChartNumber_(bucket.byItem[name].total);
    });
  });

  let incomeTotal = 0;
  const incomes = (monthData && monthData.incomes) || [];
  for (let i = 0; i < incomes.length; i++) {
    incomeTotal += chartAmount_(incomes[i] && incomes[i].amount);
  }

  return {
    daysInMonth: daysInMonth,
    byCategory: byCategory,
    incomeTotal: roundChartNumber_(incomeTotal),
  };
}

function chartMonthStatsFromSummary_(month, monthSummary) {
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const byCategory = {};
  const expenseCats = (monthSummary && monthSummary.expense && monthSummary.expense.byCategory) || {};
  Object.keys(expenseCats).forEach(function (cat) {
    const src = expenseCats[cat];
    const byItem = {};
    Object.keys(src.byItem || {}).forEach(function (name) {
      byItem[name] = { total: src.byItem[name].total, count: src.byItem[name].count };
    });
    byCategory[cat] = {
      total: src.total,
      count: src.count,
      byItem: byItem,
      daily: null,
      dailyCount: null,
      maxRecord: null,
    };
  });
  return {
    daysInMonth: new Date(year, monthNumber, 0).getDate(),
    byCategory: byCategory,
    incomeTotal: (monthSummary && monthSummary.income && monthSummary.income.total) || 0,
  };
}

/** @param simpleJson  選用：已經讀回的 OPTIONS_SIMPLE 字串（見 readOptions_）。 */
function getChartExpenseCategories_(ss, simpleJson) {
  try {
    return chartCategoriesFrom_(readOptions_(ss, simpleJson));
  } catch (e) {
    return [];
  }
}

function chartCategoriesFrom_(options) {
  const seen = new Set();
  return ((options && options.expenseCategories) || [])
    .map(function (c) { return String(c == null ? '' : c).trim(); })
    .filter(function (c) {
      if (!c || seen.has(c)) return false;
      seen.add(c);
      return true;
    });
}

function chartAmount_(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : 0;
}

function roundChartNumber_(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}

function shiftMonth_(month, delta) {
  const year = Number(String(month).slice(0, 4));
  const monthNumber = Number(String(month).slice(5, 7));
  const index = year * 12 + (monthNumber - 1) + delta;
  const y = Math.floor(index / 12);
  const m = index - y * 12 + 1;
  return y + '.' + (m < 10 ? '0' + m : String(m));
}

function chartsCacheKeysFrom_(month) {
  if (!CONFIG.MONTH_PATTERN.test(String(month || ''))) return [];
  const keys = [];
  for (let i = 0; i < CHARTS_TREND_MONTHS_; i++) {
    keys.push(CONFIG.CACHE_KEYS.CHARTS_PREFIX + shiftMonth_(month, i));
  }
  return keys;
}

function fitsCacheValue_(str) {
  if (str.length * 3 <= CACHE_VALUE_MAX_BYTES_) return true;
  return Utilities.newBlob(str).getBytes().length <= CACHE_VALUE_MAX_BYTES_;
}
