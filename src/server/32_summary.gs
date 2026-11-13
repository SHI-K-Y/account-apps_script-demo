const SUMMARY_HEADERS_ = Object.freeze(['月份', '類型', '總類', '項目', '支付方式', '金額', '筆數', '更新時間']);
const SUMMARY_TYPE_EXPENSE_ = '支出';
const SUMMARY_TYPE_INCOME_ = '收入';
const SUMMARY_UNNAMED_PAYMENT_ = '未填支付方式';

function readSummaryDirty_(props) {
  try {
    const raw = (props || scriptProps_()).getProperty(CONFIG.PROP_KEYS.SUMMARY_DIRTY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr.filter(function (m) { return CONFIG.MONTH_PATTERN.test(String(m)); }) : [];
  } catch (e) {
    return [];
  }
}

function markSummaryDirty_(months) {
  const list = (Array.isArray(months) ? months : [months])
    .map(function (m) { return String(m == null ? '' : m).trim(); })
    .filter(function (m) { return CONFIG.MONTH_PATTERN.test(m); });
  if (!list.length) return;
  try {
    const props = scriptProps_();
    const current = readSummaryDirty_(props);
    let changed = false;
    list.forEach(function (m) {
      if (current.indexOf(m) === -1) {
        current.push(m);
        changed = true;
      }
    });
    if (changed) props.setProperty(CONFIG.PROP_KEYS.SUMMARY_DIRTY, JSON.stringify(current));
  } catch (e) {}
}

function markSummaryDirtyWithLock_(months) {
  withDocumentLockIfAvailable_(function () {
    markSummaryDirty_(months);
  }, 5000);
}

function unmarkSummaryDirty_(months) {
  if (!months || !months.length) return;
  try {
    const props = scriptProps_();
    const removeSet = new Set(months);
    const current = readSummaryDirty_(props);
    const next = current.filter(function (m) { return !removeSet.has(m); });
    if (next.length === current.length) return;
    if (next.length) {
      props.setProperty(CONFIG.PROP_KEYS.SUMMARY_DIRTY, JSON.stringify(next));
    } else {
      props.deleteProperty(CONFIG.PROP_KEYS.SUMMARY_DIRTY);
    }
  } catch (e) {}
}

function normalizeSummaryMonth_(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value.toFixed(2);
  return String(value == null ? '' : value).trim().replace(/^'/, '');
}

function createSummarySheet_(ss) {
  const sheet = ss.insertSheet(CONFIG.SUMMARY_SHEET, ss.getNumSheets());
  sheet.getRange(1, 1, 1, SUMMARY_HEADERS_.length)
    .setValues([SUMMARY_HEADERS_.slice()])
    .setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('H2:H').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.hideSheet();
  return sheet;
}

function readSummaryTable_(sheet) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  const values = sheet.getRange(2, 1, lastRow - 1, SUMMARY_HEADERS_.length).getValues();
  const rows = [];
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    row[0] = normalizeSummaryMonth_(row[0]);
    if (CONFIG.MONTH_PATTERN.test(row[0])) rows.push(row);
  }
  return rows;
}

function readSummaryRowsForMonths_(sheet, months) {
  const result = { rows: [], present: new Set() };
  const wanted = new Set(months);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || !wanted.size) return result;

  const monthCol = sheet.getRange(2, 1, lastRow - 1, 1).getValues();
  let first = -1;
  let last = -1;
  for (let i = 0; i < monthCol.length; i++) {
    if (wanted.has(normalizeSummaryMonth_(monthCol[i][0]))) {
      if (first < 0) first = i;
      last = i;
    }
  }
  if (first < 0) return result;

  const block = sheet.getRange(2 + first, 1, last - first + 1, SUMMARY_HEADERS_.length).getValues();
  block.forEach(function (row) {
    const m = normalizeSummaryMonth_(row[0]);
    if (!wanted.has(m)) return;
    row[0] = m;
    result.rows.push(row);
    result.present.add(m);
  });
  return result;
}

function buildSummaryRows_(month, monthData, stamp) {
  const groups = new Map();
  function add(type, category, item, payment, amount) {
    const key = [type, category, item, payment].join('\u0001');
    let row = groups.get(key);
    if (!row) {
      row = [month, type, category, item, payment, 0, 0, stamp];
      groups.set(key, row);
    }
    row[5] += amount;
    row[6] += 1;
  }
  function text(v) {
    return String(v == null ? '' : v).trim();
  }

  ((monthData && monthData.expenses) || []).forEach(function (rec) {
    if (!rec) return;
    add(
      SUMMARY_TYPE_EXPENSE_,
      text(rec.category) || CHARTS_UNCATEGORIZED_,
      text(rec.item) || CHARTS_UNNAMED_ITEM_,
      text(rec.payment),
      chartAmount_(rec.amount)
    );
  });
  ((monthData && monthData.incomes) || []).forEach(function (rec) {
    if (!rec) return;
    add(
      SUMMARY_TYPE_INCOME_,
      text(rec.category) || CHARTS_UNCATEGORIZED_,
      text(rec.item) || CHARTS_UNNAMED_ITEM_,
      '',
      chartAmount_(rec.amount)
    );
  });

  const rows = Array.from(groups.values());
  rows.forEach(function (row) { row[5] = roundChartNumber_(row[5]); });
  return rows;
}

function compareSummaryRows_(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0] ? 1 : -1;
  if (a[1] !== b[1]) return a[1] === SUMMARY_TYPE_EXPENSE_ ? -1 : 1;
  const catA = String(a[2]);
  const catB = String(b[2]);
  if (catA !== catB) return catA < catB ? -1 : 1;
  return (Number(b[5]) || 0) - (Number(a[5]) || 0);
}

function writeSummaryTable_(sheet, rows, oldCount) {
  const width = SUMMARY_HEADERS_.length;
  const n = rows.length;
  if (n > 0) {
    const neededRows = n + 1;
    if (sheet.getMaxRows() < neededRows) {
      sheet.insertRowsAfter(sheet.getMaxRows(), neededRows - sheet.getMaxRows());
    }
    sheet.getRange(2, 1, n, 1).setNumberFormat('@');
    sheet.getRange(2, 1, n, width).setValues(rows.map(function (r) {
      return [
        String(r[0]),
        literalText_(r[1]),
        literalText_(r[2]),
        literalText_(r[3]),
        literalText_(r[4]),
        Number(r[5]) || 0,
        Number(r[6]) || 0,
        r[7] instanceof Date ? r[7] : (r[7] || ''),
      ];
    }));
  }
  if (oldCount > n) {
    sheet.getRange(n + 2, 1, oldCount - n, width).clearContent();
  }
}

function summaryRowsToResult_(rows, months) {
  function bucket() { return { total: 0, count: 0 }; }
  function addTo(target, amount, count) {
    target.total += amount;
    target.count += count;
  }
  function roundBucket(target) {
    target.total = roundChartNumber_(target.total);
  }

  const out = {};
  months.forEach(function (m) {
    out[m] = {
      expense: { total: 0, count: 0, byCategory: {}, byPayment: {} },
      income: { total: 0, count: 0, byCategory: {} },
    };
  });

  rows.forEach(function (row) {
    const target = out[row[0]];
    if (!target) return;
    const type = String(row[1] == null ? '' : row[1]).trim();
    const category = String(row[2] == null ? '' : row[2]).trim() || CHARTS_UNCATEGORIZED_;
    const item = String(row[3] == null ? '' : row[3]).trim() || CHARTS_UNNAMED_ITEM_;
    const payment = String(row[4] == null ? '' : row[4]).trim();
    const amount = chartAmount_(row[5]);
    const count = Number(row[6]) || 0;

    const side = type === SUMMARY_TYPE_EXPENSE_ ? target.expense : (type === SUMMARY_TYPE_INCOME_ ? target.income : null);
    if (!side) return;

    addTo(side, amount, count);
    const cat = side.byCategory[category] || (side.byCategory[category] = { total: 0, count: 0, byItem: {} });
    addTo(cat, amount, count);
    addTo(cat.byItem[item] || (cat.byItem[item] = bucket()), amount, count);
    if (side === target.expense) {
      const payKey = payment || SUMMARY_UNNAMED_PAYMENT_;
      addTo(side.byPayment[payKey] || (side.byPayment[payKey] = bucket()), amount, count);
    }
  });

  Object.keys(out).forEach(function (m) {
    ['expense', 'income'].forEach(function (key) {
      const side = out[m][key];
      roundBucket(side);
      Object.keys(side.byCategory).forEach(function (cat) {
        const c = side.byCategory[cat];
        roundBucket(c);
        Object.keys(c.byItem).forEach(function (name) { roundBucket(c.byItem[name]); });
      });
      if (side.byPayment) {
        Object.keys(side.byPayment).forEach(function (p) { roundBucket(side.byPayment[p]); });
      }
    });
  });
  return out;
}

function rebuildSummaryLocked_(ss, wanted, opts) {
  const options = opts || {};
  let sheet = ss.getSheetByName(CONFIG.SUMMARY_SHEET);
  if (!sheet) {
    sheet = createSummarySheet_(ss);
    try {
      const allMonths = getMonthsList_(ss, false);
      markSummaryDirty_(classifyMonthLayouts_(function () { return ss; }, allMonths, false).current);
    } catch (e) {}
  }

  const wantedSet = new Set(wanted);
  const dirtySet = new Set(readSummaryDirty_());
  const table = readSummaryTable_(sheet);
  const present = new Set(table.map(function (r) { return r[0]; }));

  const toRebuild = wanted.filter(function (m) {
    return options.forceRebuild || dirtySet.has(m) || !present.has(m);
  });

  const stamp = new Date();
  const built = {};
  const failed = [];
  toRebuild.forEach(function (m) {
    try {
      built[m] = buildSummaryRows_(m, getMonthData_(ss, m, true), stamp);
    } catch (e) {
      failed.push(m);
    }
  });

  const replaced = new Set(Object.keys(built));
  let changed = Object.keys(built).some(function (m) { return built[m].length > 0 || present.has(m); });
  let rows = table.filter(function (r) {
    if (replaced.has(r[0])) return false;
    if (options.prune && !wantedSet.has(r[0])) {
      changed = true;
      return false;
    }
    return true;
  });
  Object.keys(built).forEach(function (m) {
    rows = rows.concat(built[m]);
  });

  if (changed) {
    rows.sort(compareSummaryRows_);
    writeSummaryTable_(sheet, rows, table.length);
  }

  unmarkSummaryDirty_(Object.keys(built).concat(options.unmark || []));

  return {
    rows: rows.filter(function (r) { return wantedSet.has(r[0]); }),
    failed: failed,
  };
}

function getSummary_(ss, months, options) {
  const opts = options || {};
  const spreadsheet = ss || getSpreadsheet_();
  const requested = [];
  (Array.isArray(months) ? months : [months]).forEach(function (m) {
    const s = String(m == null ? '' : m).trim();
    if (CONFIG.MONTH_PATTERN.test(s) && requested.indexOf(s) === -1) requested.push(s);
  });
  if (!requested.length) return {};

  const layouts = classifyMonthLayouts_(function () { return spreadsheet; }, requested, Boolean(opts.forceRebuild));
  const skipped = {};
  layouts.legacy.forEach(function (m) { skipped[m] = 'legacy'; });
  layouts.missing.forEach(function (m) { skipped[m] = 'missing'; });
  layouts.unknown.forEach(function (m) { skipped[m] = 'unknown'; });
  const wanted = requested.filter(function (m) { return !skipped[m]; });

  let rows = null;
  let failed = [];

  if (wanted.length && !opts.forceRebuild && !opts.prune) {
    const sheet = spreadsheet.getSheetByName(CONFIG.SUMMARY_SHEET);
    if (sheet) {
      const dirtySet = new Set(readSummaryDirty_());
      if (!wanted.some(function (m) { return dirtySet.has(m); })) {
        const block = readSummaryRowsForMonths_(sheet, wanted);
        if (wanted.every(function (m) { return block.present.has(m); })) rows = block.rows;
      }
    }
  }

  if (!rows && (wanted.length || opts.prune)) {
    const rebuilt = withDocumentLock_(function () {
      return rebuildSummaryLocked_(spreadsheet, wanted, {
        forceRebuild: Boolean(opts.forceRebuild),
        prune: Boolean(opts.prune),
        unmark: layouts.legacy.concat(layouts.missing),
      });
    });
    rows = rebuilt.rows;
    failed = rebuilt.failed;
  }

  const aggregated = summaryRowsToResult_(rows || [], wanted);
  const result = {};
  requested.forEach(function (m) {
    if (skipped[m]) {
      result[m] = { skipped: true, reason: skipped[m] };
    } else if (failed.indexOf(m) !== -1) {
      result[m] = { skipped: true, reason: 'error' };
    } else {
      result[m] = aggregated[m];
    }
  });
  return result;
}

function rebuildAllSummaries() {
  assertOwner_();
  const startedAt = Date.now();
  const ss = getSpreadsheet_();
  const months = getMonthsList_(ss, true);
  const result = getSummary_(ss, months, { forceRebuild: true, prune: true });

  const reasonLabels = { legacy: '舊格式', missing: '工作表不存在', unknown: '無法判斷版面', error: '讀取失敗' };
  const built = [];
  const skipped = [];
  months.forEach(function (m) {
    const r = result[m];
    if (!r) return;
    if (r.skipped) {
      skipped.push(m + '（' + (reasonLabels[r.reason] || r.reason) + '）');
    } else {
      built.push(m);
    }
  });

  try {
    scriptCache_().removeAll(months.map(function (m) { return CONFIG.CACHE_KEYS.CHARTS_PREFIX + m; }));
  } catch (e) {}

  const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
  Logger.log('月份彙總重建完成：處理 ' + built.length + ' 個月，略過 ' + skipped.length + ' 個月，耗時 ' + seconds + ' 秒');
  Logger.log('已處理：' + (built.length ? built.join('、') : '（無）'));
  Logger.log('已略過：' + (skipped.length ? skipped.join('、') : '（無）'));
  return { builtCount: built.length, built: built, skipped: skipped, seconds: seconds };
}

function debugCompareChartsSummary_(month) {
  validateMonthFormat_(month);
  const ss = getSpreadsheet_();
  if (!isNewLayoutMonth_(ss, month, true)) {
    Logger.log(month + '：舊格式月份或工作表不存在，略過比較');
    return { month: month, skipped: true };
  }

  function toTrend(stats) {
    const expenseByCategory = {};
    Object.keys(stats.byCategory).forEach(function (cat) {
      expenseByCategory[cat] = stats.byCategory[cat].total;
    });
    return { incomeTotal: stats.incomeTotal, expenseByCategory: expenseByCategory };
  }

  const detail = toTrend(buildChartMonthStats_(month, getMonthData_(ss, month, true)));
  const summaryResult = getSummary_(ss, [month])[month];
  if (!summaryResult || summaryResult.skipped) {
    Logger.log(month + '：彙總表無法取得（' + (summaryResult ? summaryResult.reason : '無資料') + '）');
    return { month: month, skipped: true };
  }
  const summary = toTrend(chartMonthStatsFromSummary_(month, summaryResult));

  const diffs = [];
  function same(a, b) { return Math.abs((Number(a) || 0) - (Number(b) || 0)) < 0.005; }
  if (!same(detail.incomeTotal, summary.incomeTotal)) {
    diffs.push('收入總額：明細 ' + detail.incomeTotal + ' / 彙總 ' + summary.incomeTotal);
  }
  const cats = new Set(Object.keys(detail.expenseByCategory).concat(Object.keys(summary.expenseByCategory)));
  cats.forEach(function (cat) {
    const a = detail.expenseByCategory[cat];
    const b = summary.expenseByCategory[cat];
    if (a === undefined || b === undefined || !same(a, b)) {
      diffs.push('支出「' + cat + '」：明細 ' + (a === undefined ? '（無）' : a) + ' / 彙總 ' + (b === undefined ? '（無）' : b));
    }
  });

  if (diffs.length) {
    Logger.log(month + '：發現 ' + diffs.length + ' 項差異\n  ' + diffs.join('\n  '));
  } else {
    Logger.log(month + '：一致（收入 ' + detail.incomeTotal + '，支出總類 ' + cats.size + ' 個）');
  }
  return { month: month, same: diffs.length === 0, diffs: diffs, detail: detail, summary: summary };
}

function runDebugCompareChartsSummary() {
  assertOwner_();
  const ss = getSpreadsheet_();
  const months = getMonthsList_(ss, true);
  const current = classifyMonthLayouts_(function () { return ss; }, months, true).current.sort().reverse();
  return current.slice(0, 3).map(function (m) { return debugCompareChartsSummary_(m); });
}
