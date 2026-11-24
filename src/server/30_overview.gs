const OVERVIEW_SCAN_RANGE_ = Object.freeze({ row: 1, col: 19, numRows: 25, numCols: 8 });
const OVERVIEW_FALLBACK_ORIGIN_ = Object.freeze({ row: 4, col: 19 });

const OVERVIEW_FIELDS_ = Object.freeze([
  { key: 'assetTotal',        labels: ['資產總覽'],               fallback: [0, 0] },
  { key: 'livingIncome',      labels: ['當月生活費總收入'],       fallback: [5, 0] },
  { key: 'savingsIncome',     labels: ['當月存款總收入'],         fallback: [5, 2] },
  { key: 'agencyIncome',      labels: ['當月代收代付總收入'],     fallback: [5, 4] },
  { key: 'totalIncome',       labels: ['當月總收入'],             fallback: [5, 5] },
  { key: 'livingExpense',     labels: ['當月生活費總支出'],       fallback: [9, 0] },
  { key: 'savingsExpense',    labels: ['當月存款總支出'],         fallback: [9, 2] },
  { key: 'agencyExpense',     labels: ['當月代收代付總支出'],     fallback: [9, 4] },
  { key: 'totalExpense',      labels: ['當月總支出'],             fallback: [9, 5] },
  { key: 'livingBalance',     labels: ['累計生活費總收支'],       fallback: [13, 0] },
  { key: 'savingsBalance',    labels: ['累計存款總收支'],         fallback: [13, 2] },
  { key: 'agencyBalance',     labels: ['累計代收代付總收支'],     fallback: [13, 4] },
  { key: 'monthBalance',      labels: ['當月總收支'],             fallback: [13, 5] },
  { key: 'cashExpense',       labels: ['本月現金總支出'],         fallback: [16, 0] },
  { key: 'linePayExpense',    labels: ['本月 Line Pay 總支出'],   fallback: [16, 2] },
  { key: 'creditCardExpense', labels: ['本月信用卡總支出'],       fallback: [16, 4] },
  { key: 'creditCardPaid',    labels: ['本月信用卡支出已繳金額'], fallback: [16, 5] },
  { key: 'creditCardUnpaid',  labels: ['累計信用卡支出未繳金額'], fallback: [16, 6] },
]);

function normalizeOverviewLabel_(text) {
  let s = String(text == null ? '' : text);
  try { s = s.normalize('NFKC'); } catch (e) {}
  return s.replace(/\s+/g, '').replace(/之出/g, '支出').toLowerCase();
}

function columnLetter_(colNumber) {
  let n = Number(colNumber);
  let out = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    out = String.fromCharCode(65 + r) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function readOverviewFields_(data) {
  const scan = OVERVIEW_SCAN_RANGE_;
  const origin = OVERVIEW_FALLBACK_ORIGIN_;

  const labelIndex = {};
  for (let r = 0; r < data.length; r++) {
    const rowVals = data[r] || [];
    for (let c = 0; c < rowVals.length; c++) {
      const norm = normalizeOverviewLabel_(rowVals[c]);
      if (norm && !Object.prototype.hasOwnProperty.call(labelIndex, norm)) {
        labelIndex[norm] = [r, c];
      }
    }
  }

  function cellValue(r, c) {
    const v = data[r] && data[r][c];
    return v !== null && v !== undefined && String(v).trim() !== '' ? v : '0';
  }

  const values = {};
  const warnings = [];
  OVERVIEW_FIELDS_.forEach(function (field) {
    let pos = null;
    for (let i = 0; i < field.labels.length && !pos; i++) {
      const hit = labelIndex[normalizeOverviewLabel_(field.labels[i])];
      if (hit && hit[0] + 1 < data.length) pos = [hit[0] + 1, hit[1]];
    }

    if (pos) {
      values[field.key] = cellValue(pos[0], pos[1]);
      return;
    }

    const absRow = origin.row + field.fallback[0];
    const absCol = origin.col + field.fallback[1];
    values[field.key] = cellValue(absRow - scan.row, absCol - scan.col);
    warnings.push({
      type: 'labelNotFound',
      key: field.key,
      label: field.labels[0],
      fallbackCell: columnLetter_(absCol) + absRow,
    });
  });

  return { values: values, warnings: warnings };
}

/**
 * 總覽（本月）。先查快取（P11）：月份用 budgetToday_() 的固定時區算，本月總覽與月份清單一次 getAll，
 * 命中就直接回傳，不開試算表、不讀時區。沒命中時才拿月份清單決定要讀哪個月份。
 */
function getAssetOverview_(forceRefresh) {
  const isForce = Boolean(forceRefresh);
  const K = CONFIG.CACHE_KEYS;
  const currentMonth = budgetToday_().month;

  let months = null;
  if (!isForce) {
    let got = {};
    try { got = scriptCache_().getAll([K.OVERVIEW_PREFIX + currentMonth, K.MONTHS_LIST]) || {}; } catch (e) { got = {}; }
    const hit = parseOverviewCache_(got[K.OVERVIEW_PREFIX + currentMonth]);
    if (hit) return hit;
    months = parseMonthsListCache_(got[K.MONTHS_LIST]);
  }
  if (!months) months = getMonthsList_(null, isForce);
  if (!months.length) {
    throw new Error('找不到月份工作表。');
  }

  const targetMonth = months.includes(currentMonth) ? currentMonth : months[0];
  if (!isForce && targetMonth !== currentMonth) {
    let cached = null;
    try { cached = scriptCache_().get(K.OVERVIEW_PREFIX + targetMonth); } catch (e) { cached = null; }
    const hit = parseOverviewCache_(cached);
    if (hit) return hit;
  }
  return readAssetOverviewFromSheet_(getSpreadsheet_(), targetMonth, months);
}

function parseOverviewCache_(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && parsed.month ? parsed : null;
  } catch (e) {
    return null;
  }
}

function parseMonthsListCache_(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : null;
  } catch (e) {
    return null;
  }
}

/** 從月份工作表讀出總覽並存進快取（快取沒命中與預熱觸發器用）。 */
function readAssetOverviewFromSheet_(ss, targetMonth, months) {
  const sheet = ss.getSheetByName(targetMonth);
  if (!sheet) {
    throw new Error('找不到「' + targetMonth + '」工作表。');
  }

  const scan = OVERVIEW_SCAN_RANGE_;
  const numRows = Math.max(1, Math.min(scan.numRows, sheet.getMaxRows() - scan.row + 1));
  const numCols = Math.max(1, Math.min(scan.numCols, sheet.getMaxColumns() - scan.col + 1));
  const data = sheet.getRange(scan.row, scan.col, numRows, numCols).getDisplayValues();
  const parsed = readOverviewFields_(data);

  const result = { month: targetMonth, months: months };
  OVERVIEW_FIELDS_.forEach(function (field) {
    result[field.key] = parsed.values[field.key];
  });
  result.warnings = parsed.warnings;

  try {
    scriptCache_().put(CONFIG.CACHE_KEYS.OVERVIEW_PREFIX + targetMonth, JSON.stringify(result), CONFIG.CACHE_TTL);
  } catch (e) {}

  return result;
}
