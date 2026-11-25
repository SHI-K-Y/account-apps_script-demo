/**
 * 資產軌跡（F06）：最近 24 個月的淨資產、生活費餘額、存款餘額、代收代付餘額。
 *
 * 數字都來自月份工作表的總覽區（OVERVIEW_SCAN_RANGE_，與總覽頁同一組標籤）：
 *   淨資產＝「資產總覽」；生活費／存款／代收代付＝各類「累計…總收支」。舊版面的月份由 classifyMonthLayouts_ 排除。
 *
 * 已經過完的月份存在隱藏工作表「_資產快照」，一列一個月：
 *   月份｜淨資產｜生活費餘額｜存款餘額｜代收代付餘額｜更新時間
 * - 寫入只由 refreshNetWorthSnapshots_ 做：每日維護觸發器（13_daily.gs）每天檢查一次，所以每月 1 日就會寫入上個月；
 *   setup() 也會呼叫一次，把過去 24 個月補齊。沒有缺、沒有過期時只讀快照，不讀任何月份工作表。
 * - 讀取（getNetWorthHistory_）不寫試算表：快取 → 快照；快照沒有或已過期的月份才去讀那張月份工作表。
 * - 累計餘額一路接續上個月，所以改了某個過去的月份，那個月與之後每個月的快照都不準：
 *   markNetWorthDirty_ 把「最早被改到的月份」記在指令碼屬性，之後讀取時那個月起改讀工作表，
 *   下一次每日維護重寫快照後清掉。本月還沒有快照，記本月的帳不會走到這裡（不多花任何服務呼叫）。
 * - 本月的數字不放進這份快取：每次都用本月總覽的快取（OVERVIEW_<本月>），記帳後不必清掉歷史。
 */
const NET_WORTH_HEADERS_ = Object.freeze(['月份', '淨資產', '生活費餘額', '存款餘額', '代收代付餘額', '更新時間']);
const NET_WORTH_FIELDS_ = Object.freeze([
  Object.freeze({ key: 'total', field: 'assetTotal' }),
  Object.freeze({ key: 'living', field: 'livingBalance' }),
  Object.freeze({ key: 'savings', field: 'savingsBalance' }),
  Object.freeze({ key: 'agency', field: 'agencyBalance' }),
]);
const NET_WORTH_MONTHS_ = 24;
// 補快照時一次鎖內最多讀幾張月份工作表：分批放開鎖，不會讓同時記帳的人等太久
const NET_WORTH_BATCH_ = 6;

/** 總覽區的顯示文字 → 數字；空白或公式錯誤（#REF! 等）回傳 null。 */
function overviewNumber_(text) {
  const s = String(text == null ? '' : text).trim();
  if (!s || s.charAt(0) === '#') return null;
  return cleanAmount_(s);
}

/**
 * 總覽欄位 → 一個月的點；找不到標籤的欄位不猜（null），淨資產讀不到時整個月不要（回傳 null）。
 * @param values    readOverviewFields_ 的 values，或 getAssetOverview_ 的結果
 * @param warnings  同上的 warnings
 */
function netWorthPoint_(month, values, warnings) {
  if (!values) return null;
  const missing = new Set((warnings || []).map(function (w) { return w && w.key; }));
  const point = { month: month };
  NET_WORTH_FIELDS_.forEach(function (f) {
    point[f.key] = missing.has(f.field) ? null : overviewNumber_(values[f.field]);
  });
  return point.total === null ? null : point;
}

/** 從月份工作表讀一個月（不存快取）；讀不到回傳 null。 */
function readNetWorthPoint_(ss, month) {
  const sheet = ss.getSheetByName(month);
  if (!sheet) return null;
  const scan = OVERVIEW_SCAN_RANGE_;
  const numRows = Math.max(1, Math.min(scan.numRows, sheet.getMaxRows() - scan.row + 1));
  const numCols = Math.max(1, Math.min(scan.numCols, sheet.getMaxColumns() - scan.col + 1));
  const parsed = readOverviewFields_(sheet.getRange(scan.row, scan.col, numRows, numCols).getDisplayValues());
  return netWorthPoint_(month, parsed.values, parsed.warnings);
}

/* ------------------------------ 快照工作表 ------------------------------ */

function createNetWorthSheet_(ss) {
  const sheet = ss.insertSheet(CONFIG.NET_WORTH_SHEET, ss.getNumSheets());
  sheet.getRange(1, 1, 1, NET_WORTH_HEADERS_.length)
    .setValues([NET_WORTH_HEADERS_.slice()])
    .setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('F2:F').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.hideSheet();
  return sheet;
}

/** 讀回所有快照：{ 月份: 點（含 updatedAt） }；工作表不存在時是空的。 */
function readNetWorthSnapshots_(ss) {
  const out = {};
  const sheet = ss.getSheetByName(CONFIG.NET_WORTH_SHEET);
  const lastRow = sheet ? sheet.getLastRow() : 0;
  if (lastRow < 2) return out;
  const cell = function (v) { return typeof v === 'number' && Number.isFinite(v) ? v : overviewNumber_(v); };
  sheet.getRange(2, 1, lastRow - 1, NET_WORTH_HEADERS_.length).getValues().forEach(function (row) {
    const month = normalizeSummaryMonth_(row[0]);
    if (!CONFIG.MONTH_PATTERN.test(month)) return;
    const point = { month: month, updatedAt: row[5] };
    NET_WORTH_FIELDS_.forEach(function (f, i) { point[f.key] = cell(row[i + 1]); });
    if (point.total !== null) out[month] = point;
  });
  return out;
}

/** 整張表依月份重寫（一個月一列，列數很少），多出來的舊列清掉。 */
function writeNetWorthSnapshots_(ss, snapshots) {
  const sheet = ss.getSheetByName(CONFIG.NET_WORTH_SHEET) || createNetWorthSheet_(ss);
  const oldCount = Math.max(0, sheet.getLastRow() - 1);
  const width = NET_WORTH_HEADERS_.length;
  const rows = Object.keys(snapshots).sort().map(function (m) {
    const p = snapshots[m];
    return [m].concat(NET_WORTH_FIELDS_.map(function (f) { return p[f.key] === null ? '' : p[f.key]; }), [p.updatedAt || '']);
  });
  if (rows.length) {
    if (sheet.getMaxRows() < rows.length + 1) {
      sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
    }
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, width).setValues(rows);
  }
  if (oldCount > rows.length) sheet.getRange(rows.length + 2, 1, oldCount - rows.length, width).clearContent();
}

/* ------------------------------ 過期標記 ------------------------------ */

function readNetWorthDirty_() {
  try {
    const month = scriptProps_().getProperty(CONFIG.PROP_KEYS.NET_WORTH_DIRTY);
    return CONFIG.MONTH_PATTERN.test(String(month || '')) ? month : '';
  } catch (e) {
    return '';
  }
}

/**
 * 過去的月份有異動（記帳、直接改試算表、補建月份）：那個月起的快照不能再用。本月與之後的月份直接略過。
 * 快取裡的鏡像已經涵蓋這個月份時不碰指令碼屬性（例如連續標記上個月的卡費已繳）。在文件鎖外呼叫。
 */
function markNetWorthDirty_(month) {
  if (!CONFIG.MONTH_PATTERN.test(String(month || '')) || month >= budgetToday_().month) return;
  const K = CONFIG.CACHE_KEYS;
  try {
    const cache = scriptCache_();
    cache.remove(K.NET_WORTH);
    const mark = cache.get(K.NET_WORTH_DIRTY_MARK);
    if (mark && mark <= month) return;
    withDocumentLockIfAvailable_(function () {
      const current = readNetWorthDirty_();
      const next = current && current <= month ? current : month;
      if (next !== current) scriptProps_().setProperty(CONFIG.PROP_KEYS.NET_WORTH_DIRTY, next);
      cache.put(K.NET_WORTH_DIRTY_MARK, next, CONFIG.CACHE_TTL);
    }, 5000);
  } catch (e) {}
}

/** 文件鎖內呼叫：把過期標記改成 month（空字串＝清掉）。先清鏡像再改屬性，中途失敗只會多讀一次屬性。 */
function setNetWorthDirty_(month) {
  try { scriptCache_().remove(CONFIG.CACHE_KEYS.NET_WORTH_DIRTY_MARK); } catch (e) {}
  const props = scriptProps_();
  if (month) props.setProperty(CONFIG.PROP_KEYS.NET_WORTH_DIRTY, month);
  else props.deleteProperty(CONFIG.PROP_KEYS.NET_WORTH_DIRTY);
}

/* ------------------------------ 讀取 ------------------------------ */

function netWorthWindowStart_(today) {
  return shiftMonth_(today.month, -(NET_WORTH_MONTHS_ - 1));
}

/** 已經過完的月份（由舊到新）：有效的快照直接用，其餘讀月份工作表（舊版面略過）。結果存進快取。 */
function loadNetWorthClosed_(ss, months, today) {
  const start = netWorthWindowStart_(today);
  const closed = months.filter(function (m) { return m >= start && m < today.month; }).sort();
  const snapshots = readNetWorthSnapshots_(ss);
  const dirty = readNetWorthDirty_();
  const usable = function (m) { return snapshots[m] && !(dirty && m >= dirty); };
  const toRead = closed.filter(function (m) { return !usable(m); });
  const readable = new Set(classifyMonthLayouts_(function () { return ss; }, toRead, false).current);
  const points = closed.map(function (m) {
    if (usable(m)) return { month: m, total: snapshots[m].total, living: snapshots[m].living, savings: snapshots[m].savings, agency: snapshots[m].agency };
    return readable.has(m) ? readNetWorthPoint_(ss, m) : null;
  }).filter(Boolean);
  try {
    scriptCache_().put(CONFIG.CACHE_KEYS.NET_WORTH, JSON.stringify({ asOf: today.month, points: points }), CONFIG.CACHE_TTL);
  } catch (e) {}
  return points;
}

/** 快取字串 → 已過完月份的點；換了月份（上個月要補進來）或格式不對時回傳 null。 */
function parseNetWorthCache_(text, today) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && parsed.asOf === today.month && Array.isArray(parsed.points) ? parsed.points : null;
  } catch (e) {
    return null;
  }
}

/**
 * 淨資產歷史（唯讀 API）：最近 24 個月（含本月），由舊到新。
 * 快取命中時（歷史＋本月總覽一次 getAll）不開試算表。forceRefresh 只略過快取，過完的月份照樣用快照。
 */
function getNetWorthHistory_(forceRefresh) {
  const isForce = Boolean(forceRefresh);
  const today = budgetToday_();
  const K = CONFIG.CACHE_KEYS;
  let closed = null;
  let overview = null;
  let months = null;
  if (!isForce) {
    let got = {};
    try { got = scriptCache_().getAll([K.NET_WORTH, K.OVERVIEW_PREFIX + today.month, K.MONTHS_LIST]) || {}; } catch (e) { got = {}; }
    closed = parseNetWorthCache_(got[K.NET_WORTH], today);
    overview = parseOverviewCache_(got[K.OVERVIEW_PREFIX + today.month]);
    months = parseMonthsListCache_(got[K.MONTHS_LIST]);
  }
  if (!months) months = getMonthsList_(null, isForce);
  if (!closed) closed = loadNetWorthClosed_(getSpreadsheet_(), months, today);
  if (!overview && months.indexOf(today.month) !== -1 && isNewLayoutMonth_(null, today.month, false)) {
    overview = readAssetOverviewFromSheet_(getSpreadsheet_(), today.month, months);
  }
  const current = overview ? netWorthPoint_(today.month, overview, overview.warnings) : null;
  return {
    currentMonth: today.month,
    months: NET_WORTH_MONTHS_,
    generatedAt: Date.now(),
    points: current ? closed.concat([current]) : closed.slice(),
  };
}

/* ------------------------------ 寫入快照（觸發器） ------------------------------ */

/**
 * 補上缺的快照、重寫過期的快照（已經過完的月份；每月 1 日就是寫入上個月）。每日維護與 setup() 呼叫。
 * 分批在文件鎖內做（一批最多 NET_WORTH_BATCH_ 個月）；讀不到的月份（公式錯誤）這次先跳過，也不留舊的快照。
 * 沒有要做的事時只讀一次快照與月份清單。回傳 { written, skipped }。
 */
function refreshNetWorthSnapshots_() {
  const ss = getSpreadsheet_();
  const today = budgetToday_();
  const months = getMonthsList_(ss, true);
  const start = netWorthWindowStart_(today);
  const failed = new Set();
  let written = 0;

  for (let round = 0; round < 60; round++) {
    const more = withDocumentLock_(function () {
      const snapshots = readNetWorthSnapshots_(ss);
      const dirty = readNetWorthDirty_();
      const isDirty = function (m) { return Boolean(dirty) && m >= dirty; };
      const candidates = months.filter(function (m) {
        if (m >= today.month || failed.has(m)) return false;
        return snapshots[m] ? isDirty(m) : m >= start;
      });
      const todo = classifyMonthLayouts_(function () { return ss; }, candidates, false).current.sort();
      // 快照還在、但工作表已經變成舊版面或讀不到版面的月份：不留過期的數字
      const stale = candidates.filter(function (m) { return snapshots[m] && todo.indexOf(m) === -1; });
      const batch = todo.slice(0, NET_WORTH_BATCH_);
      if (!batch.length && !stale.length) {
        if (dirty) setNetWorthDirty_('');
        return false;
      }
      stale.forEach(function (m) { delete snapshots[m]; });
      const stamp = new Date();
      batch.forEach(function (m) {
        const point = readNetWorthPoint_(ss, m);
        if (!point) {
          failed.add(m);
          delete snapshots[m];
          return;
        }
        point.updatedAt = stamp;
        snapshots[m] = point;
        written++;
      });
      writeNetWorthSnapshots_(ss, snapshots);
      const rest = todo.slice(batch.length);
      if (dirty) setNetWorthDirty_(rest.filter(isDirty)[0] || '');
      return rest.length > 0;
    });
    if (!more) break;
  }

  if (written) {
    try { scriptCache_().remove(CONFIG.CACHE_KEYS.NET_WORTH); } catch (e) {}
  }
  return { written: written, skipped: Array.from(failed).sort() };
}
