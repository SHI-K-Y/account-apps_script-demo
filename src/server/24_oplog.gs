/**
 * 操作紀錄與復原（F05）
 *
 * 操作紀錄：隱藏工作表「_操作紀錄」，一列一筆記帳寫入（新增／修改／刪除／標記已繳／復原）：
 *   時間｜來源（web／api／trigger）｜動作｜月份｜類型｜列號｜修改前 JSON｜修改後 JSON｜opId｜復原對象（undo 才有：被復原的 opId）
 * - 由 21_records.gs 的寫入在同一個文件鎖內、寫完試算表之後呼叫 appendOpLog_：單筆用一次 appendRow，
 *   批次（addRecords、整批標記已繳）一次 setValues。寫紀錄失敗只記錯誤、不讓記帳失敗（帳已經寫進去了）。
 * - 來源：網頁（api()）預設 web；HTTP API（doPost）是 api；時間觸發器（F01、F04 的自動入帳）用
 *   withOpLogSource_('trigger', fn) 包起來執行，裡面呼叫的 addRecords_ 等函式就會記成 trigger。
 * - 每筆一定有 opId：前端送來的（冪等用），沒有時由伺服器產生（serverOpId_），寫入的回應裡也會帶 opId。
 * - 只保留最近 OPLOG_KEEP_ 筆：每日觸發器（13_daily.gs）刪掉較舊的列。
 * - 列號是「當時」的列號：之後刪除上方的紀錄時不回頭改（改一次就要重寫整欄）。還原時先比對內容，
 *   原本的列對不上就在同一區塊找內容完全相同、而且只有一筆的列（見 locateLedgerRow_）。
 *
 * 復原（undoRecordOp）：依 opId 找到那一筆紀錄，在同一個文件鎖裡把該區塊讀一次、寫一次：
 *   刪除 → restoreRecord_：插回原本的列，下方往下移（removeLedgerRow_ 的反向），不是附加到最後
 *   修改 → 確認該列仍是修改後的內容才寫回修改前的值，否則丟出「衝突」錯誤
 *   新增 → 確認內容後刪除（下方往上遞補）
 *   已繳 → 每一列都仍是標記後的狀態才把 F 欄寫回原值
 * 復原本身也記一筆（動作 undo、復原對象＝原 opId），同一筆不能復原兩次；復原的紀錄也可以再被復原（重做）。
 * 只動記帳區塊的欄位（支出 B–H、收入 K–O），「當日支出總金額」等公式欄不受影響。
 */
const OPLOG_SHEET_ = '_操作紀錄';
const OPLOG_HEADERS_ = Object.freeze(['時間', '來源', '動作', '月份', '類型', '列號', '修改前 JSON', '修改後 JSON', 'opId', '復原對象']);
const OPLOG_COL_ = Object.freeze({ time: 0, source: 1, action: 2, month: 3, type: 4, row: 5, before: 6, after: 7, opId: 8, undoOf: 9 });
const OPLOG_KEEP_ = 2000;
const OPLOG_RECENT_MAX_ = 50;
// 復原時先只讀最後這麼多列找 opId（剛做的操作一定在最後面），找不到才讀全部
const OPLOG_TAIL_SCAN_ = 100;
// 試算表單一儲存格最多 50,000 字元；超過時只記「內容過長」，這筆就不能還原
const OPLOG_JSON_MAX_ = 45000;
// getOpLog 清單裡，整批標記已繳只帶前幾筆（還原由伺服器依 opId 讀完整內容）
const OPLOG_LIST_SAMPLE_ = 3;
const OPLOG_CONFLICT_PREFIX_ = '衝突：';

let opLogSource_ = 'web';
// 這次執行花在寫操作紀錄的毫秒數（API 偵錯計時 [api-timing] 的 opLogMs）
let opLogMs_ = 0;

/** 在 fn 執行期間把操作紀錄的來源設成 source（web／api／trigger）。 */
function withOpLogSource_(source, fn) {
  const prev = opLogSource_;
  opLogSource_ = source;
  try { return fn(); } finally { opLogSource_ = prev; }
}

/** 沒有 opId 的寫入（HTTP API、觸發器）由伺服器產生一個，格式符合 OP_ID_PATTERN_。 */
function serverOpId_() {
  return 'srv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

/* ------------------------------ 工作表 ------------------------------ */

function opLogSheet_(ss, create) {
  const spreadsheet = ss || getSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(OPLOG_SHEET_);
  if (sheet || !create) return sheet;
  return createOpLogSheet_(spreadsheet);
}

function createOpLogSheet_(ss) {
  const sheet = ss.insertSheet(OPLOG_SHEET_, ss.getNumSheets());
  sheet.getRange(1, 1, 1, OPLOG_HEADERS_.length)
    .setValues([OPLOG_HEADERS_.slice()])
    .setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange('A2:A').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.hideSheet();
  return sheet;
}

/** 文字一律加 ' 前綴寫入：月份 2026.11、列號 5,9、opId 才不會被試算表轉成數字或日期。 */
function opLogText_(value) {
  const text = value == null ? '' : String(value);
  return text ? "'" + text : '';
}

function opLogJson_(value) {
  if (value === undefined || value === null) return '';
  let text = JSON.stringify(value);
  if (text.length > OPLOG_JSON_MAX_) text = JSON.stringify({ truncated: true, length: text.length });
  return "'" + text;
}

function opLogRowValues_(entry, now) {
  const row = Array.isArray(entry.row) ? opLogText_(entry.row.join(',')) : (entry.row || '');
  return [
    now,
    opLogSource_,
    String(entry.action || ''),
    opLogText_(entry.month),
    String(entry.type || ''),
    row,
    opLogJson_(entry.before),
    opLogJson_(entry.after),
    opLogText_(entry.opId),
    opLogText_(entry.undoOf),
  ];
}

/**
 * 寫入操作紀錄（呼叫端已經在文件鎖內）。entries：[{ action, month, type, row, before, after, opId, undoOf }]。
 * 回傳是否寫入成功；失敗不丟錯（記帳本身已經完成）。
 */
function appendOpLog_(ss, entries) {
  const list = (entries || []).filter(function (e) { return e && e.action; });
  if (!list.length) return true;
  const t0 = Date.now();
  try {
    const sheet = opLogSheet_(ss, true);
    const now = new Date();
    const rows = list.map(function (e) { return opLogRowValues_(e, now); });
    if (rows.length === 1) {
      sheet.appendRow(rows[0]);
    } else {
      const start = Math.max(sheet.getLastRow(), 1) + 1;
      const maxRows = sheet.getMaxRows();
      const end = start + rows.length - 1;
      if (end > maxRows) sheet.insertRowsAfter(maxRows, end - maxRows);
      sheet.getRange(start, 1, rows.length, OPLOG_HEADERS_.length).setValues(rows);
    }
    return true;
  } catch (err) {
    console.error('[oplog] 寫入操作紀錄失敗：' + (err && err.stack ? err.stack : err));
    return false;
  } finally {
    opLogMs_ += Date.now() - t0;
  }
}

/* ------------------------------ 讀取 ------------------------------ */

function readOpLogTail_(sheet, lastRow, count) {
  const start = Math.max(2, lastRow - count + 1);
  if (lastRow < start) return { start: start, values: [] };
  return { start: start, values: sheet.getRange(start, 1, lastRow - start + 1, OPLOG_HEADERS_.length).getValues() };
}

function parseOpLogJson_(value) {
  const text = cellToStr_(value);
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return { invalid: true }; }
}

function parseOpLogRowNumber_(value) {
  if (typeof value === 'number') return value;
  const text = cellToStr_(value);
  if (!text) return null;
  if (text.indexOf(',') !== -1) {
    return text.split(',').map(function (s) { return Number(s); }).filter(function (n) { return Number.isInteger(n); });
  }
  const n = Number(text);
  return Number.isInteger(n) ? n : null;
}

function formatOpLogTime_(value) {
  if (value instanceof Date) return Utilities.formatDate(value, DEFAULT_TIME_ZONE_, 'yyyy-MM-dd HH:mm:ss');
  return cellToStr_(value);
}

function parseOpLogRow_(values, logRow) {
  const C = OPLOG_COL_;
  return {
    logRow: logRow,
    time: formatOpLogTime_(values[C.time]),
    source: cellToStr_(values[C.source]),
    action: cellToStr_(values[C.action]),
    month: cellToStr_(values[C.month]),
    type: cellToStr_(values[C.type]),
    row: parseOpLogRowNumber_(values[C.row]),
    before: parseOpLogJson_(values[C.before]),
    after: parseOpLogJson_(values[C.after]),
    opId: cellToStr_(values[C.opId]),
    undoOf: cellToStr_(values[C.undoOf]),
  };
}

/** 依 opId 找一筆紀錄，並標出它是否已經被復原過（復原紀錄一定排在它後面）。 */
function findOpLogEntry_(sheet, opId) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return null;
  const total = lastRow - 1;
  let count = Math.min(OPLOG_TAIL_SCAN_, total);
  for (;;) {
    const tail = readOpLogTail_(sheet, lastRow, count);
    for (let i = tail.values.length - 1; i >= 0; i--) {
      if (cellToStr_(tail.values[i][OPLOG_COL_.opId]) !== opId) continue;
      const entry = parseOpLogRow_(tail.values[i], tail.start + i);
      entry.undone = tail.values.slice(i + 1).some(function (r) { return cellToStr_(r[OPLOG_COL_.undoOf]) === opId; });
      return entry;
    }
    if (count >= total) return null;
    count = total;
  }
}

/** 這筆紀錄是哪一種還原：restore（插回刪掉的）、remove（刪掉新增的）、update、paid；不能還原時回傳 { error }。 */
function opLogRevertPlan_(entry) {
  if (!entry) return { error: '找不到這筆操作的紀錄（可能已超過保留期限）。' };
  if (!LEDGER_BLOCKS_[entry.type]) return { error: '這筆操作不是記帳紀錄，無法還原。' };
  if (!CONFIG.MONTH_PATTERN.test(entry.month || '')) return { error: '這筆操作的月份不正確，無法還原。' };
  const bad = function (v) { return v && !Array.isArray(v) && (v.truncated || v.invalid); };
  if (bad(entry.before) || bad(entry.after)) return { error: '這筆操作的內容過長或已損毀，無法還原。' };
  if (Array.isArray(entry.before) || Array.isArray(entry.after)) {
    if (entry.type !== 'expense' || !Array.isArray(entry.before) || !Array.isArray(entry.after) ||
        !entry.before.length || entry.before.length !== entry.after.length) {
      return { error: '這筆操作的內容不完整，無法還原。' };
    }
    return { kind: 'paid' };
  }
  const row = entry.row;
  if (!Number.isInteger(row) || row < CONFIG.MIN_DATA_ROW || row > CONFIG.MAX_DATA_ROW) {
    return { error: '這筆操作的列號不正確，無法還原。' };
  }
  if (entry.before && entry.after) return { kind: 'update' };
  if (entry.before) return { kind: 'restore' };
  if (entry.after) return { kind: 'remove' };
  return { error: '這筆操作沒有可以還原的內容。' };
}

function compactOpLogRecords_(value) {
  if (!Array.isArray(value)) return value;
  return value.slice(0, OPLOG_LIST_SAMPLE_);
}

/**
 * 讀最近的操作紀錄（唯讀；網頁目前沒有使用，留給 HTTP API 與除錯）：最近 limit 筆（最多 OPLOG_RECENT_MAX_），新的在前。
 * 每筆 { time, source, action, month, type, row, before, after, count, opId, undoOf, undone, revertible, reason }；
 * 整批標記已繳的 before／after 只帶前幾筆（count 是總筆數）。
 * 不放快取：每筆寫入都會改變這份清單，要清快取就得在寫入路徑多一次服務呼叫；這個清單只在打開設定分頁時讀。
 */
function getOpLog_(limit) {
  const n = Math.max(1, Math.min(OPLOG_RECENT_MAX_, Math.floor(Number(limit)) || OPLOG_RECENT_MAX_));
  const sheet = opLogSheet_(null, false);
  if (!sheet) return { entries: [], total: 0, keep: OPLOG_KEEP_ };
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return { entries: [], total: 0, keep: OPLOG_KEEP_ };
  const tail = readOpLogTail_(sheet, lastRow, Math.min(n, lastRow - 1));
  const undone = new Set();
  tail.values.forEach(function (r) {
    const ref = cellToStr_(r[OPLOG_COL_.undoOf]);
    if (ref) undone.add(ref);
  });
  const entries = tail.values.map(function (r, i) {
    const e = parseOpLogRow_(r, tail.start + i);
    const plan = opLogRevertPlan_(e);
    const isUndone = Boolean(e.opId) && undone.has(e.opId);
    return {
      time: e.time,
      source: e.source,
      action: e.action,
      month: e.month,
      type: e.type,
      row: e.row,
      before: compactOpLogRecords_(e.before),
      after: compactOpLogRecords_(e.after),
      count: Array.isArray(e.after) ? e.after.length : 1,
      opId: e.opId,
      undoOf: e.undoOf,
      undone: isUndone,
      revertible: !plan.error && !isUndone && Boolean(e.opId),
      reason: plan.error || (isUndone ? '已經還原過了' : ''),
    };
  }).reverse();
  return { entries: entries, total: lastRow - 1, keep: OPLOG_KEEP_ };
}

/* ------------------------------ 每日清理 ------------------------------ */

/** 只保留最近 keep 筆（預設 OPLOG_KEEP_），刪掉最舊的列。由每日觸發器呼叫（13_daily.gs）。 */
function trimOpLog_(keep) {
  const max = Math.max(1, Math.floor(Number(keep)) || OPLOG_KEEP_);
  return withDocumentLock_(function () {
    const sheet = opLogSheet_(null, false);
    if (!sheet) return { removed: 0, kept: 0 };
    const count = Math.max(0, sheet.getLastRow() - 1);
    const excess = count - max;
    if (excess > 0) sheet.deleteRows(2, excess);
    return { removed: Math.max(0, excess), kept: Math.min(count, max) };
  });
}

/* --------------------------- 記帳區塊的比對與還原 --------------------------- */

/** 區塊裡一列的值 → 紀錄（解析方式和 readMonthSheetDataFromSheet_ 相同）；整列空白時 filled 為 false。 */
function ledgerValuesToRecord_(block, values, row) {
  const filled = !values.every(isBlankCell_);
  const day = parseInt(values[0], 10);
  const rec = { row: row, day: !isNaN(day) ? day : cellToStr_(values[0]), item: cellToStr_(values[1]), category: cellToStr_(values[2]) };
  if (block.type === 'expense') {
    rec.payment = cellToStr_(values[3]);
    rec.paid = cellToStr_(values[4]);
    rec.amount = cleanAmount_(values[5]);
    rec.note = cellToStr_(values[6]);
  } else {
    rec.amount = cleanAmount_(values[3]);
    rec.note = cellToStr_(values[4]);
  }
  return { record: rec, filled: filled };
}

function filledRecordAt_(block, values, row) {
  const idx = row - CONFIG.MIN_DATA_ROW;
  if (idx < 0 || idx >= values.length) return null;
  const parsed = ledgerValuesToRecord_(block, values[idx], row);
  return parsed.filled ? parsed.record : null;
}

/** 兩筆紀錄的內容是否相同（不比列號）。 */
function ledgerRecordsMatch_(block, a, b) {
  if (!a || !b) return false;
  const keys = block.type === 'expense'
    ? ['item', 'category', 'payment', 'paid', 'note']
    : ['item', 'category', 'note'];
  if (String(a.day) !== String(b.day)) return false;
  if (Number(a.amount) !== Number(b.amount)) return false;
  return keys.every(function (k) { return String(a[k] == null ? '' : a[k]) === String(b[k] == null ? '' : b[k]); });
}

/**
 * 找出內容等於 expected 的列：先看原本的列號，對不上時在整個區塊找，只有一筆相同才算數（避免改到別筆）。
 * 找不到回傳 0。
 */
function locateLedgerRow_(block, values, row, expected) {
  if (ledgerRecordsMatch_(block, filledRecordAt_(block, values, row), expected)) return row;
  let found = 0;
  for (let i = 0; i < values.length; i++) {
    const r = CONFIG.MIN_DATA_ROW + i;
    if (r === row) continue;
    if (!ledgerRecordsMatch_(block, filledRecordAt_(block, values, r), expected)) continue;
    if (found) return 0;
    found = r;
  }
  return found;
}

function lastFilledLedgerIndex_(values) {
  for (let i = values.length - 1; i >= 0; i--) {
    if (!values[i].every(isBlankCell_)) return i;
  }
  return -1;
}

function literalLedgerRow_(r) {
  return r.map(function (cell) { return typeof cell === 'string' ? literalText_(cell) : cell; });
}

/**
 * 把刪掉的紀錄插回原本的列（removeLedgerRow_ 的反向）：row 到最後一筆資料往下移一列，紀錄寫在 row。
 * values 是同一個文件鎖內剛讀的區塊內容（從 MIN_DATA_ROW 起）；整個操作只有這一次 setValues。
 * 回傳 { row, lastDataRow: 往下移之前最後一筆資料的列（沒有往下移時為 0） }。
 */
function restoreRecord_(sheet, block, row, record, values) {
  const idx = row - CONFIG.MIN_DATA_ROW;
  if (idx < 0 || idx >= values.length) throw new Error('無法復原：第 ' + row + ' 列超出可用範圍。');
  const last = lastFilledLedgerIndex_(values);
  const rowValues = recordToRowValues_(block, record);
  if (idx > last) {
    ledgerRowRange_(sheet, block, row).setValues([rowValues]);
    return { row: row, lastDataRow: 0 };
  }
  if (last + 1 >= values.length) throw new Error('可用輸入列已滿，無法把這筆紀錄插回原位。');
  const out = [rowValues].concat(values.slice(idx, last + 1).map(literalLedgerRow_));
  ledgerRowRange_(sheet, block, row, out.length).setValues(out);
  return { row: row, lastDataRow: CONFIG.MIN_DATA_ROW + last };
}

/**
 * 插回一筆之後就地更新月份明細快取（不重讀工作表）。先用插回前的區塊內容核對快取，對不上就回傳 false。
 */
function applyRestoreToMonthData_(block, monthData, record, values, restored) {
  const list = monthData && monthData[block.listKey];
  if (!Array.isArray(list)) return false;
  let filled = 0;
  values.forEach(function (r) { if (!r.every(isBlankCell_)) filled++; });
  if (filled !== list.length) return false;
  const row = restored.row;
  const rowFilled = !values[row - CONFIG.MIN_DATA_ROW].every(isBlankCell_);
  if (rowFilled !== list.some(function (r) { return r.row === row; })) return false;

  const last = restored.lastDataRow;
  const shifted = list.map(function (r) {
    return last && r.row >= row && r.row <= last ? Object.assign({}, r, { row: r.row + 1 }) : r;
  });
  shifted.push(record);
  monthData[block.listKey] = sortByRowDesc_(shifted);
  if (block.hasDailyTotals) monthData.dailyExpenses = computeDailyExpenses_(monthData[block.listKey]);

  const blanks = new Set();
  (monthData[block.blankRowsKey] || []).forEach(function (b) {
    if (last) {
      if (b < row || b > last + 1) blanks.add(b);
      else if (b <= last) blanks.add(b + 1);
    } else if (b !== row) {
      blanks.add(b);
    }
  });
  let list2 = Array.from(blanks).sort(function (a, b) { return a - b; });
  if (!list2.length) {
    const next = (last || row) + (last ? 2 : 1);
    if (next <= CONFIG.MAX_DATA_ROW) list2 = [next];
  }
  monthData[block.blankRowsKey] = list2;
  return true;
}

function conflictError_(message) {
  const err = new Error(OPLOG_CONFLICT_PREFIX_ + message);
  err.conflict = true;
  return err;
}

/**
 * 在文件鎖內依紀錄還原（只讀一次、寫一次這個區塊）。
 * 回傳 { core, log, monthData }：core 是給前端合併的差量，log 是這次還原自己的操作紀錄。
 */
function applyLedgerRevert_(sheet, block, entry, plan, monthData, month) {
  const cap = Math.min(CONFIG.MAX_DATA_ROW, sheet.getMaxRows());
  const values = sheet.getRange(CONFIG.MIN_DATA_ROW, block.startCol, cap - CONFIG.MIN_DATA_ROW + 1, block.width).getValues();
  const base = { type: block.type, month: month };
  let md = monthData;

  if (plan.kind === 'restore') {
    const record = buildStoredRecord_(block, entry.row, Object.assign({}, entry.before));
    const restored = restoreRecord_(sheet, block, entry.row, record, values);
    if (md && !applyRestoreToMonthData_(block, md, record, values, restored)) md = null;
    return {
      core: Object.assign({ op: 'restore', row: entry.row, record: record }, base),
      log: { row: entry.row, before: null, after: record },
      monthData: md,
    };
  }

  if (plan.kind === 'remove') {
    const row = locateLedgerRow_(block, values, entry.row, entry.after);
    if (!row) throw conflictError_('這筆紀錄新增之後又被修改或刪除過（可能是另一台裝置），為避免刪錯，沒有還原。');
    const current = filledRecordAt_(block, values, row);
    const removal = shiftLedgerRowsUp_(sheet, block, row, values);
    if (md && !applyDeleteToMonthData_(block, md, row, removal)) md = null;
    return {
      core: Object.assign({ op: 'delete', row: row }, base),
      log: { row: row, before: current, after: null },
      monthData: md,
    };
  }

  if (plan.kind === 'update') {
    const row = locateLedgerRow_(block, values, entry.row, entry.after);
    if (!row) throw conflictError_('這筆紀錄修改之後又被變更過（可能是另一台裝置），為避免覆蓋，沒有還原。');
    const current = filledRecordAt_(block, values, row);
    const record = buildStoredRecord_(block, row, Object.assign({}, entry.before));
    ledgerRowRange_(sheet, block, row).setValues([recordToRowValues_(block, record)]);
    if (md && Array.isArray(md[block.listKey])) putRecordIntoMonthData_(block, md, record);
    else md = null;
    return {
      core: Object.assign({ op: 'update', row: row, record: record }, base),
      log: { row: row, before: current, after: record },
      monthData: md,
    };
  }

  // paid：每一列都要仍是標記後的狀態，才把是否已繳寫回原值（一次寫入 F 欄的連續範圍）
  const offset = block.paidCol - block.startCol;
  const targets = entry.after.map(function (after, i) {
    const row = locateLedgerRow_(block, values, after.row, after);
    if (!row) throw conflictError_('有紀錄在標記之後又被變更過（可能是另一台裝置），為避免覆蓋，沒有還原。');
    return { row: row, current: filledRecordAt_(block, values, row), paid: normalizePaidCode_(entry.before[i].paid) };
  });
  const paidByRow = {};
  targets.forEach(function (t) { paidByRow[t.row] = t.paid; });
  const rows = targets.map(function (t) { return t.row; }).sort(function (a, b) { return a - b; });
  const first = rows[0];
  const lastRow = rows[rows.length - 1];
  const column = [];
  for (let r = first; r <= lastRow; r++) {
    if (Object.prototype.hasOwnProperty.call(paidByRow, r)) column.push([paidByRow[r]]);
    else {
      const cell = values[r - CONFIG.MIN_DATA_ROW][offset];
      column.push([typeof cell === 'string' ? literalText_(cell) : cell]);
    }
  }
  sheet.getRange(first, block.paidCol, column.length, 1).setValues(column);

  if (md && Array.isArray(md.expenses)) {
    md.expenses.forEach(function (r) {
      if (Object.prototype.hasOwnProperty.call(paidByRow, r.row)) r.paid = paidByRow[r.row];
    });
  } else {
    md = null;
  }
  return {
    core: Object.assign({ op: 'paid', rows: rows, paidByRow: paidByRow }, base),
    log: {
      row: targets.map(function (t) { return t.row; }),
      before: targets.map(function (t) { return t.current; }),
      after: targets.map(function (t) { return Object.assign({}, t.current, { paid: t.paid }); }),
    },
    monthData: md,
  };
}

/**
 * 復原／還原一筆操作：form { undoOf: 要還原的 opId, opId?: 這次復原自己的 opId（冪等）, month?: 月份（提示，讓預算與快取一次讀好） }。
 * 回應和其他記帳寫入相同（差量格式；op 可能是 restore／update／delete／paid），另外帶 undoOf。
 * 修改後又被改過、新增後又被改過或刪掉時丟出以「衝突：」開頭的錯誤，不覆蓋。
 */
function undoRecordOp_(form) {
  const target = normalizeOpId_(form.undoOf);
  if (!target) throw new Error('缺少要還原的操作。');
  const opId = normalizeOpId_(form.opId) || serverOpId_();
  const hint = CONFIG.MONTH_PATTERN.test(String(form.month || '')) ? form.month : '';
  const prelude = readWritePrelude_(hint ? [hint] : []);
  let sheet = null;
  let plan = null;

  const locked = withDocumentLock_(function () {
    const state = readLockedLedgerState_(hint ? [hint] : [], [opId]);
    const replay = replayedLedgerOp_(state, opId, hint);
    if (replay) {
      sheet = getTargetSheet_(replay.core.month).sheet;
      plan = { kind: replay.core.op === 'paid' ? 'paid' : 'other' };
      return replay;
    }

    const ss = getSpreadsheet_();
    const logSheet = opLogSheet_(ss, false);
    const entry = logSheet ? findOpLogEntry_(logSheet, target) : null;
    plan = opLogRevertPlan_(entry);
    if (plan.error) throw new Error(plan.error);
    if (entry.undone) throw new Error('這筆操作已經還原過了。');

    const month = entry.month;
    const block = LEDGER_BLOCKS_[entry.type];
    sheet = getTargetSheet_(month).sheet;
    const cached = month === hint ? state.monthData[hint] : getCachedMonthData_(month);
    const result = applyLedgerRevert_(sheet, block, entry, plan, cached, month);
    const monthData = result.monthData || readMonthSheetDataFromSheet_(sheet, month, { save: false });

    const core = Object.assign(result.core, { opId: opId, undoOf: target });
    appendOpLog_(ss, [Object.assign({ action: 'undo', month: month, type: block.type, opId: opId, undoOf: target }, result.log)]);
    const months = {};
    months[month] = monthData;
    commitLedgerCaches_(months, opResultMap_(opId, core));
    return { core: core, monthData: monthData, marksJson: state.marksJson };
  });
  return finishLedgerMutation_(locked, sheet, form, prelude, { summary: plan.kind !== 'paid' });
}
