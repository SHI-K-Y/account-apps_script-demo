const SEARCH_MAX_MONTHS_PER_BATCH_ = 6;
const SEARCH_MAX_RESULTS_PER_BATCH_ = 300;
const SEARCH_MAX_KEYWORD_LENGTH_ = 50;
const SEARCH_MAX_FILTER_VALUES_ = 200;

function normalizeSearchText_(text) {
  const str = String(text == null ? '' : text);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    let ch = str.charAt(i);
    const code = ch.charCodeAt(0);
    if (code >= 0xFF01 && code <= 0xFF5E) {
      ch = String.fromCharCode(code - 0xFEE0);
    } else if (code === 0x3000) {
      ch = ' ';
    }
    const lower = ch.toLowerCase();
    out += lower.length === 1 ? lower : ch;
  }
  return out;
}

function isNewLayoutSheet_(sheet) {
  if (!sheet) return false;
  if (sheet.getMaxRows() < 4 || sheet.getMaxColumns() < 15) return false;
  const h = sheet.getRange(4, 2, 1, 14).getValues()[0];
  const clean = function (v) { return String(v == null ? '' : v).replace(/\s+/g, ''); };
  return clean(h[0]) === '日期' &&
    clean(h[1]) === '支出項目' &&
    clean(h[2]) === '支出總類' &&
    clean(h[3]) === '支出方式' &&
    clean(h[9]) === '日期' &&
    clean(h[10]) === '收入項目';
}

function classifyMonthLayouts_(getSs, months, forceRefresh) {
  const result = { current: [], legacy: [], missing: [], unknown: [] };
  if (!months || !months.length) return result;

  const cache = scriptCache_();
  const prefix = CONFIG.CACHE_KEYS.SHEET_LAYOUT_PREFIX;
  let cached = {};
  if (!forceRefresh) {
    try { cached = cache.getAll(months.map(function (m) { return prefix + m; })) || {}; } catch (e) { cached = {}; }
  }

  const toStore = {};
  months.forEach(function (m) {
    const hit = cached[prefix + m];
    if (hit === '1') { result.current.push(m); return; }
    if (hit === '0') { result.legacy.push(m); return; }

    const sheet = getSs().getSheetByName(m);
    if (!sheet) { result.missing.push(m); return; }
    let isNew;
    try {
      isNew = isNewLayoutSheet_(sheet);
    } catch (e) {
      result.unknown.push(m);
      return;
    }
    toStore[prefix + m] = isNew ? '1' : '0';
    (isNew ? result.current : result.legacy).push(m);
  });

  if (Object.keys(toStore).length) {
    try { cache.putAll(toStore, CONFIG.CACHE_TTL); } catch (e) {}
  }
  return result;
}

function isNewLayoutMonth_(ss, month, forceRefresh) {
  const r = classifyMonthLayouts_(function () { return ss || getSpreadsheet_(); }, [month], forceRefresh);
  return r.current.length === 1;
}

function parseSearchStringList_(value, label) {
  if (value == null || value === '') return [];
  if (!Array.isArray(value)) throw new Error(label + '格式錯誤。');
  if (value.length > SEARCH_MAX_FILTER_VALUES_) throw new Error(label + '數量過多。');
  const out = [];
  value.forEach(function (v) {
    const s = String(v == null ? '' : v).trim();
    if (s && out.indexOf(s) === -1) out.push(s);
  });
  return out;
}

function parseSearchAmount_(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const num = Number(value);
  if (!Number.isFinite(num) || num < 0) throw new Error(label + '必須是大於或等於 0 的數字。');
  return num;
}

function parseSearchQuery_(query) {
  if (!query || typeof query !== 'object') throw new Error('搜尋條件格式錯誤。');

  if (!Array.isArray(query.months) || !query.months.length) throw new Error('請指定要搜尋的月份。');
  if (query.months.length > SEARCH_MAX_MONTHS_PER_BATCH_) {
    throw new Error('一次最多搜尋 ' + SEARCH_MAX_MONTHS_PER_BATCH_ + ' 個月份。');
  }
  const months = [];
  query.months.forEach(function (m) {
    validateMonthFormat_(m);
    if (months.indexOf(m) === -1) months.push(m);
  });

  const rawKeyword = String(query.keyword == null ? '' : query.keyword).trim();
  if (rawKeyword.length > SEARCH_MAX_KEYWORD_LENGTH_) {
    throw new Error('關鍵字最多 ' + SEARCH_MAX_KEYWORD_LENGTH_ + ' 個字。');
  }
  const terms = [];
  normalizeSearchText_(rawKeyword).split(/\s+/).forEach(function (t) {
    if (t && terms.indexOf(t) === -1) terms.push(t);
  });

  const type = query.type == null || query.type === '' ? 'all' : String(query.type);
  if (['expense', 'income', 'all'].indexOf(type) === -1) throw new Error('類型必須是 expense、income 或 all。');

  const paidRaw = query.paid == null ? '' : String(query.paid).trim();
  const paid = paidRaw.toLowerCase() === 'any' ? 'any' : paidRaw.toUpperCase();
  if (['', 'O', 'X', 'ANY', 'any'].indexOf(paid) === -1) throw new Error('是否已繳的條件錯誤。');

  const minAmount = parseSearchAmount_(query.minAmount, '最小金額');
  const maxAmount = parseSearchAmount_(query.maxAmount, '最大金額');
  if (minAmount !== null && maxAmount !== null && minAmount > maxAmount) {
    throw new Error('最小金額不能大於最大金額。');
  }

  return {
    months: months,
    terms: terms,
    type: type,
    items: parseSearchStringList_(query.items, '項目'),
    categories: parseSearchStringList_(query.categories, '總類'),
    payments: parseSearchStringList_(query.payments, '支付方式'),
    paid: paid === 'ANY' ? 'any' : paid,
    minAmount: minAmount,
    maxAmount: maxAmount,
  };
}

function matchSearchRecord_(rec, kind, q) {
  const isExpense = kind === 'expense';

  if (!isExpense && (q.payments.length || q.paid)) return false;

  if (q.items.length && q.items.indexOf(rec.item) === -1) return false;
  if (q.categories.length && q.categories.indexOf(rec.category) === -1) return false;
  if (isExpense && q.payments.length && q.payments.indexOf(rec.payment) === -1) return false;

  if (isExpense && q.paid) {
    const paid = String(rec.paid || '').toUpperCase();
    if (q.paid === 'any') {
      if (paid !== 'O' && paid !== 'X') return false;
    } else if (paid !== q.paid) {
      return false;
    }
  }

  if (q.minAmount !== null || q.maxAmount !== null) {
    const amt = Math.abs(Number(rec.amount) || 0);
    if (q.minAmount !== null && amt < q.minAmount) return false;
    if (q.maxAmount !== null && amt > q.maxAmount) return false;
  }

  if (q.terms.length) {
    const hay = normalizeSearchText_([rec.note, rec.item, rec.category, isExpense ? rec.payment : ''].join('\n'));
    for (let i = 0; i < q.terms.length; i++) {
      if (hay.indexOf(q.terms[i]) === -1) return false;
    }
  }
  return true;
}

function compareSearchRecords_(a, b) {
  const da = parseInt(a.day, 10);
  const db = parseInt(b.day, 10);
  const na = isNaN(da) ? -1 : da;
  const nb = isNaN(db) ? -1 : db;
  if (na !== nb) return nb - na;
  if (a.row !== b.row) return b.row - a.row;
  if (a.type !== b.type) return a.type === 'expense' ? -1 : 1;
  return 0;
}

function newSearchTypeStats_() {
  return { count: 0, total: 0, byMonth: {} };
}

function addSearchStat_(stats, rec) {
  const amount = Number(rec.amount) || 0;
  const itemKey = rec.item || '（無項目）';

  stats.count += 1;
  stats.total += amount;
  if (!stats.byMonth[rec.month]) stats.byMonth[rec.month] = { count: 0, total: 0 };
  stats.byMonth[rec.month].count += 1;
  stats.byMonth[rec.month].total += amount;
  if (!stats.byItem[itemKey]) stats.byItem[itemKey] = { count: 0, total: 0 };
  stats.byItem[itemKey].count += 1;
  stats.byItem[itemKey].total += amount;

  const t = stats.byType[rec.type];
  t.count += 1;
  t.total += amount;
  if (!t.byMonth[rec.month]) t.byMonth[rec.month] = { count: 0, total: 0, byItem: {} };
  const tm = t.byMonth[rec.month];
  tm.count += 1;
  tm.total += amount;
  if (!tm.byItem[itemKey]) tm.byItem[itemKey] = { count: 0, total: 0 };
  tm.byItem[itemKey].count += 1;
  tm.byItem[itemKey].total += amount;
}

function roundSearchStats_(stats) {
  const r2 = function (n) { return Math.round(n * 100) / 100; };
  const roundMap = function (map) {
    Object.keys(map).forEach(function (k) {
      map[k].total = r2(map[k].total);
      if (map[k].byItem) roundMap(map[k].byItem);
    });
  };
  stats.total = r2(stats.total);
  roundMap(stats.byMonth);
  roundMap(stats.byItem);
  ['expense', 'income'].forEach(function (k) {
    const t = stats.byType[k];
    t.total = r2(t.total);
    roundMap(t.byMonth);
  });
}

function searchRecords_(query) {
  const q = parseSearchQuery_(query);

  let ss = null;
  const getSs = function () { return ss || (ss = getSpreadsheet_()); };

  const layouts = classifyMonthLayouts_(getSs, q.months, false);
  const skippedMonths = layouts.legacy.concat(layouts.unknown);
  const currentSet = {};
  layouts.current.forEach(function (m) { currentSet[m] = true; });

  const stats = {
    count: 0, total: 0, byMonth: {}, byItem: {},
    byType: { expense: newSearchTypeStats_(), income: newSearchTypeStats_() },
  };
  const results = [];
  let truncated = false;
  const searchedMonths = [];
  const failedMonths = [];

  q.months.forEach(function (month) {
    if (!currentSet[month]) return;

    let monthData;
    try {
      monthData = getCachedMonthData_(month) || getMonthData_(getSs(), month, false);
    } catch (e) {
      failedMonths.push(month);
      return;
    }
    searchedMonths.push(month);

    const hits = [];
    const collect = function (list, kind) {
      for (let i = 0; i < list.length; i++) {
        const rec = list[i];
        if (!matchSearchRecord_(rec, kind, q)) continue;
        hits.push({
          month: month,
          type: kind,
          row: rec.row,
          day: rec.day,
          item: rec.item,
          category: rec.category,
          payment: kind === 'expense' ? rec.payment : '',
          paid: kind === 'expense' ? rec.paid : '',
          amount: rec.amount,
          note: rec.note,
        });
      }
    };
    if (q.type !== 'income') collect((monthData && monthData.expenses) || [], 'expense');
    if (q.type !== 'expense') collect((monthData && monthData.incomes) || [], 'income');

    hits.sort(compareSearchRecords_);
    hits.forEach(function (rec) {
      addSearchStat_(stats, rec);
      if (results.length < SEARCH_MAX_RESULTS_PER_BATCH_) {
        results.push(rec);
      } else {
        truncated = true;
      }
    });
  });

  roundSearchStats_(stats);

  return {
    results: results,
    truncated: truncated,
    stats: stats,
    searchedMonths: searchedMonths,
    skippedMonths: skippedMonths,
    missingMonths: layouts.missing,
    failedMonths: failedMonths,
  };
}
