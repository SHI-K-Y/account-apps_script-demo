function getRecentRecords_(month, expenseLimit, incomeLimit, forceRefresh) {
  validateMonthFormat_(month);
  const expLimit = (typeof expenseLimit === 'number') ? expenseLimit : 8;
  const incLimit = (typeof incomeLimit === 'number') ? incomeLimit : 8;
  const monthData = getMonthData_(null, month, Boolean(forceRefresh));
  return buildRecentPayload_(month, monthData, expLimit, incLimit);
}

function getFullRecords_(month, type, forceRefresh) {
  validateMonthFormat_(month);
  const monthData = getMonthData_(null, month, Boolean(forceRefresh));
  if (type === 'expense') {
    return {
      month,
      type: 'expense',
      records: monthData.expenses,
      dailyExpenses: monthData.dailyExpenses,
    };
  } else if (type === 'income') {
    return {
      month,
      type: 'income',
      records: monthData.incomes,
    };
  }
  return {
    month,
    expenses: monthData.expenses,
    incomes: monthData.incomes,
    dailyExpenses: monthData.dailyExpenses,
  };
}

/**
 * 月份工作表的記帳區塊版面（資料存取層）。
 * 支出與收入是同一張工作表上的兩個欄位區塊，從第 CONFIG.MIN_DATA_ROW 列開始往下寫。
 * 欄位順序就是寫入試算表的順序；日後版面若調整，只需要改這裡。
 */
const LEDGER_BLOCKS_ = Object.freeze({
  expense: Object.freeze({
    type: 'expense',
    startCol: 2,   // B 欄：日期｜支出項目｜支出總類｜支出方式｜是否已繳｜支出金額｜備註
    width: 7,
    paidCol: 6,    // F 欄：是否已繳
    listKey: 'expenses',
    blankRowsKey: 'blankExpenseRows',
    hasDailyTotals: true,
    fields: Object.freeze([
      Object.freeze({ key: 'item', required: '請選擇支出項目', label: '支出項目', options: 'expenseItems' }),
      Object.freeze({ key: 'category', required: '請選擇支出總類', label: '支出總類', options: 'expenseCategories' }),
      Object.freeze({ key: 'payment', required: '請選擇支出方式', label: '支出方式', options: 'paymentMethods' }),
    ]),
  }),
  income: Object.freeze({
    type: 'income',
    startCol: 11,  // K 欄：日期｜收入項目｜收入總類｜收入金額｜備註
    width: 5,
    listKey: 'incomes',
    blankRowsKey: 'blankIncomeRows',
    hasDailyTotals: false,
    fields: Object.freeze([
      Object.freeze({ key: 'item', required: '請選擇收入項目', label: '收入項目', options: 'incomeItems' }),
      Object.freeze({ key: 'category', required: '請選擇收入總類', label: '收入總類', options: 'incomeCategories' }),
    ]),
  }),
});

function isBlankCell_(value) {
  return value === '' || value === null || String(value).trim() === '';
}

function parseLedgerRow_(rawRow) {
  const row = Number(rawRow);
  if (!Number.isInteger(row) || row < CONFIG.MIN_DATA_ROW || row > CONFIG.MAX_DATA_ROW) {
    throw new Error(`無效的資料列號：${rawRow}`);
  }
  return row;
}

/**
 * 驗證前端送來的表單並轉成一筆紀錄（不含列號）。驗證順序固定，錯誤訊息才會穩定。
 * @param simpleOptions  選用：已經讀好的簡易選項（readOptions_ 的結果）；沒給時在這裡讀
 */
function parseRecordForm_(block, form, target, simpleOptions) {
  const record = { day: normalizeDay_(form.day, target.daysInMonth) };
  block.fields.forEach(function (field) {
    record[field.key] = stripEmoji_(requiredText_(form[field.key], field.required));
  });
  if (block.type === 'expense') record.paid = normalizePaidCode_(form.paid);
  record.amount = normalizeAmount_(form.amount);
  record.note = textOrBlank_(form.note, 200);

  const options = simpleOptions || readOptions_(target.ss);
  block.fields.forEach(function (field) {
    validateOption_(record[field.key], options[field.options], field.label);
  });
  return record;
}

/** 一筆紀錄 → 要寫進試算表的一列（文字欄位會避免被當成公式）。 */
function recordToRowValues_(block, record) {
  if (block.type === 'expense') {
    return [
      record.day,
      literalText_(record.item),
      literalText_(record.category),
      literalText_(record.payment),
      record.paid,
      record.amount,
      literalText_(record.note),
    ];
  }
  return [
    record.day,
    literalText_(record.item),
    literalText_(record.category),
    record.amount,
    literalText_(record.note),
  ];
}

function buildStoredRecord_(block, row, record) {
  if (block.type === 'expense') {
    return {
      row,
      day: record.day,
      item: record.item,
      category: record.category,
      payment: record.payment,
      paid: record.paid,
      amount: record.amount,
      note: record.note,
    };
  }
  return {
    row,
    day: record.day,
    item: record.item,
    category: record.category,
    amount: record.amount,
    note: record.note,
  };
}

/* ------------------------------ 試算表讀寫 ------------------------------ */

function ledgerRowRange_(sheet, block, row, numRows) {
  return sheet.getRange(row, block.startCol, numRows || 1, block.width);
}

function isLedgerRowBlank_(sheet, block, row) {
  return ledgerRowRange_(sheet, block, row).getValues()[0].every(isBlankCell_);
}

function writeLedgerRow_(sheet, block, row, record) {
  ledgerRowRange_(sheet, block, row).setValues([recordToRowValues_(block, record)]);
}

/**
 * 找出可寫入的空白列：優先用快取記下的空白列（寫入前會再確認真的是空的）。
 * @param cachedMonthData  鎖內已經從快取讀回的月份明細（沒有時為 null）
 * 回傳 { row, monthData }；monthData 一定有值（快取沒有或不可靠時從工作表重讀，不存快取，由呼叫端一起存）。
 */
function findWritableLedgerRow_(sheet, block, month, cachedMonthData) {
  let monthData = cachedMonthData || null;
  let row = null;

  const cachedBlanks = monthData && monthData[block.blankRowsKey];
  if (Array.isArray(cachedBlanks) && cachedBlanks.length > 0) {
    if (isLedgerRowBlank_(sheet, block, cachedBlanks[0])) row = cachedBlanks[0];
  }

  if (!row) {
    monthData = readMonthSheetDataFromSheet_(sheet, month, { save: false });
    const blanks = monthData[block.blankRowsKey];
    row = blanks && blanks.length > 0
      ? blanks[0]
      : findNextBlankRow_(sheet, CONFIG.MIN_DATA_ROW, block.startCol, block.width);
  }
  return { row, monthData };
}

/**
 * 一次找出 count 個可寫入的空白列（批次寫入用，P10）：讀一次這個區塊的欄位，由上往下挑空白列，
 * 結果和逐筆寫入（每次用最上面的空白列）相同。
 * 回傳 { rows: [列號…]（可能少於 count：可用列已滿）, spareBlanks: [剩下的空白列，最多 5 個] }。
 */
function findWritableLedgerRows_(sheet, block, count) {
  const cap = Math.min(CONFIG.MAX_DATA_ROW, sheet.getMaxRows());
  const end = Math.min(cap, Math.max(sheet.getLastRow(), CONFIG.MIN_DATA_ROW - 1) + count);
  const rows = [];
  const spare = [];
  if (end >= CONFIG.MIN_DATA_ROW) {
    const values = sheet.getRange(CONFIG.MIN_DATA_ROW, block.startCol, end - CONFIG.MIN_DATA_ROW + 1, block.width).getValues();
    for (let i = 0; i < values.length; i++) {
      if (!values[i].every(isBlankCell_)) continue;
      if (rows.length < count) rows.push(CONFIG.MIN_DATA_ROW + i);
      else if (spare.length < 5) spare.push(CONFIG.MIN_DATA_ROW + i);
      else break;
    }
  }
  if (!spare.length && end + 1 <= cap) spare.push(end + 1);
  return { rows: rows, spareBlanks: spare };
}

/**
 * 表單帶 expect（前端畫面上這一列的內容）時，寫入前先確認試算表的這一列還是同一筆：紀錄沒有固定 ID，
 * 別的裝置刪過上方的紀錄後，舊畫面的列號會指到別筆。沒帶 expect（記帳頁、HTTP API）時不檢查。
 * current 是剛在鎖內讀到的內容，不會多一次試算表讀取。
 */
function assertLedgerRowExpected_(block, current, expected) {
  if (!isPlainObject_(expected)) return;
  if (ledgerRecordsMatch_(block, current, expected)) return;
  throw new Error(OPLOG_CONFLICT_PREFIX_ + '這筆紀錄已經被修改或移動（可能來自另一台裝置），這次沒有寫入，請確認最新內容後再試一次。');
}

/**
 * 刪除一列並把下方的紀錄往上遞補。
 * 回傳 { lastDataRow: 刪除前最後一筆資料所在的列（沒有資料時為 0）, values: 刪除前這個區塊的內容（從 MIN_DATA_ROW 起） }。
 * @param expected  選用：前端畫面上這一列的內容，對不上就不刪（見 assertLedgerRowExpected_）
 */
function removeLedgerRow_(sheet, block, row, expected) {
  const maxRows = Math.min(CONFIG.MAX_DATA_ROW, sheet.getMaxRows());
  const rowCount = maxRows - CONFIG.MIN_DATA_ROW + 1;
  const values = sheet.getRange(CONFIG.MIN_DATA_ROW, block.startCol, rowCount, block.width).getValues();
  assertLedgerRowExpected_(block, filledRecordAt_(block, values, row), expected);
  return shiftLedgerRowsUp_(sheet, block, row, values);
}

/**
 * removeLedgerRow_ 的寫入部分：values 是剛讀到的區塊內容（從 MIN_DATA_ROW 起），只寫一次。
 * 復原（24_oplog.gs）讀過區塊後也用這個刪除，不用再讀一次。
 */
function shiftLedgerRowsUp_(sheet, block, row, values) {
  const lastIdx = lastFilledLedgerIndex_(values);
  const lastDataRow = lastIdx === -1 ? 0 : CONFIG.MIN_DATA_ROW + lastIdx;

  if (lastDataRow && row <= lastDataRow) {
    if (row === lastDataRow) {
      ledgerRowRange_(sheet, block, row).clearContent();
    } else {
      const startIdx = row - CONFIG.MIN_DATA_ROW + 1;
      const endIdx = lastDataRow - CONFIG.MIN_DATA_ROW + 1;
      const shiftValues = values.slice(startIdx, endIdx).map(literalLedgerRow_);
      shiftValues.push(new Array(block.width).fill(''));
      ledgerRowRange_(sheet, block, row, shiftValues.length).setValues(shiftValues);
    }
  }
  return { lastDataRow: lastDataRow, values: values };
}

/* --------------------------- 月份明細的就地更新 --------------------------- */

function sortByRowDesc_(list) {
  list.sort(function (a, b) { return b.row - a.row; });
  return list;
}

/** 新增或修改一筆之後更新月份明細（同一列有舊紀錄就換掉）。 */
function putRecordIntoMonthData_(block, monthData, record) {
  const list = (monthData[block.listKey] || []).filter(function (r) { return r.row !== record.row; });
  list.push(record);
  monthData[block.listKey] = sortByRowDesc_(list);
  if (block.hasDailyTotals) monthData.dailyExpenses = computeDailyExpenses_(monthData[block.listKey]);
}

/** 新增一筆之後：放進清單並把那一列從空白列拿掉。 */
function applyAddToMonthData_(block, monthData, record) {
  putRecordIntoMonthData_(block, monthData, record);
  const row = record.row;
  const blanks = (monthData[block.blankRowsKey] || []).filter(function (r) { return r !== row; });
  if (blanks.length === 0 && row + 1 <= CONFIG.MAX_DATA_ROW) blanks.push(row + 1);
  monthData[block.blankRowsKey] = blanks;
}

/**
 * 刪除一列（下方往上遞補）之後，直接修改快取裡的月份明細，不再重讀整張工作表（P10）。
 * 先用刪除前讀到的區塊內容核對快取：筆數不同、或那一列有沒有資料對不上，就回傳 false（呼叫端改成重讀工作表）。
 */
function applyDeleteToMonthData_(block, monthData, row, removal) {
  const list = monthData && monthData[block.listKey];
  if (!Array.isArray(list)) return false;
  let filled = 0;
  removal.values.forEach(function (r) { if (!r.every(isBlankCell_)) filled++; });
  if (filled !== list.length) return false;
  const rowFilled = row - CONFIG.MIN_DATA_ROW < removal.values.length &&
    !removal.values[row - CONFIG.MIN_DATA_ROW].every(isBlankCell_);
  const inList = list.some(function (r) { return r.row === row; });
  if (rowFilled !== inList) return false;

  const last = removal.lastDataRow;
  if (!last || row > last) return true; // 沒有任何變動

  monthData[block.listKey] = list
    .filter(function (r) { return r.row !== row; })
    .map(function (r) { return r.row > row && r.row <= last ? Object.assign({}, r, { row: r.row - 1 }) : r; });
  if (block.hasDailyTotals) monthData.dailyExpenses = computeDailyExpenses_(monthData[block.listKey]);

  const blanks = new Set();
  (monthData[block.blankRowsKey] || []).forEach(function (b) {
    if (b < row || b > last) blanks.add(b);
    else if (b > row) blanks.add(b - 1);
  });
  blanks.add(last);
  monthData[block.blankRowsKey] = Array.from(blanks).sort(function (a, b) { return a - b; });
  return true;
}

/* ------------------------- 寫入流程與冪等（P10） -------------------------
 * 一次寫入的步驟：
 *   鎖外  一次 getAll 讀簡易選項與試算表 ID → 驗證表單 → 開試算表
 *   鎖內  一次 getAll 讀月份明細、冪等結果（OP_<opId>）與彙總標記鏡像 → 同一個 opId 已處理過就直接用上次的結果
 *         → 找空白列、setValues → 一次 putAll 存月份明細＋冪等結果
 *   鎖外  清總覽／圖表快取、標記彙總（已標記就不碰指令碼屬性）、算一次預算、組回應
 * 啟動快取（BOOT_JSON）與指令碼屬性的備援快照不在寫入路徑更新：doGet 與 getInitialData 會用最新的月份明細蓋過
 * 啟動資料裡的清單，備援快照改由 doGet 低頻更新（見 10_web.gs）。
 */
const OP_ID_PATTERN_ = /^[A-Za-z0-9_-]{8,80}$/;
const ADD_RECORDS_MAX_ = 50;

/** 這次執行是不是 HTTP API（doPost）：舊的呼叫端（iOS 捷徑）預設拿完整格式。 */
let httpApiFullResponse_ = false;

function normalizeOpId_(value) {
  return typeof value === 'string' && OP_ID_PATTERN_.test(value) ? value : '';
}

function opCacheKey_(opId) {
  return CONFIG.CACHE_KEYS.OP_PREFIX + opId;
}

/**
 * 回應格式：form.full === true 是舊的完整格式（含 recent：前 8 筆＋整月清單＋預算）；
 * 預設是差量格式（P10）。HTTP API 沒指定時用完整格式，舊的捷徑不用改。
 */
function wantsFullResponse_(form) {
  if (form && form.full === true) return true;
  if (form && form.full === false) return false;
  return httpApiFullResponse_;
}

/**
 * 鎖外的一次 getAll：記帳驗證用的簡易選項、試算表 ID、預算設定與這些月份的月初餘額（算預算用）。
 * 預算設定與月初餘額在鎖外讀沒關係：這次寫入不會改到它們（月初餘額只跟之前的月份有關）。
 */
function readWritePrelude_(months) {
  const K = CONFIG.CACHE_KEYS;
  const list = (months || []).filter(function (m) { return CONFIG.MONTH_PATTERN.test(String(m || '')); });
  const openingKeys = list.map(function (m) { return K.BUDGET_OPENING_PREFIX + m; });
  let got = {};
  try {
    got = scriptCache_().getAll([K.OPTIONS_SIMPLE, K.SPREADSHEET_ID, K.BUDGET_CONFIG].concat(openingKeys)) || {};
  } catch (e) { got = {}; }
  primeSpreadsheetId_(got[K.SPREADSHEET_ID]);
  const optionsJson = got[K.OPTIONS_SIMPLE] != null ? got[K.OPTIONS_SIMPLE] : null;
  let options = null;
  return {
    /** 簡易選項：第一次用到才解析（刪除與標記已繳用不到）。 */
    options: function (ss) {
      return options || (options = readOptions_(ss, optionsJson));
    },
    /** 預算狀態：快取裡的設定夠用就直接算，否則走一般流程（會讀快取或試算表）。 */
    budget: function (month, monthData) {
      const quick = got[K.BUDGET_CONFIG]
        ? budgetStatusFromCache_(month, monthData, got[K.BUDGET_CONFIG], got[K.BUDGET_OPENING_PREFIX + month] || null, month)
        : null;
      return quick ? quick.status : budgetStatusForMonth_(month, monthData);
    },
  };
}

/**
 * 鎖內的一次 getAll：這些月份的明細、這些 opId 上次的結果、彙總標記鏡像。
 * 回傳 { monthData: { 月份: 明細或 null }, ops: { opId: 結果 }, marksJson }。
 */
function readLockedLedgerState_(months, opIds) {
  const K = CONFIG.CACHE_KEYS;
  const ids = (opIds || []).filter(Boolean);
  const got = cacheGetAllMixed_(
    months.map(function (m) { return K.MONTH_DATA_PREFIX + m; }),
    ids.map(opCacheKey_).concat([K.SUMMARY_DIRTY_MARKS])
  );
  const monthData = {};
  months.forEach(function (m) { monthData[m] = got.large[K.MONTH_DATA_PREFIX + m] || null; });
  const ops = {};
  ids.forEach(function (id) {
    const raw = got.plain[opCacheKey_(id)];
    if (!raw) return;
    try { ops[id] = JSON.parse(raw); } catch (e) {}
  });
  return { monthData: monthData, ops: ops, marksJson: got.plain[K.SUMMARY_DIRTY_MARKS] };
}

/** 鎖內的一次 putAll：月份明細＋這次的冪等結果（不會丟錯；失敗時月份明細快取會被清掉）。 */
function commitLedgerCaches_(monthDataByMonth, opResults) {
  const large = {};
  Object.keys(monthDataByMonth || {}).forEach(function (m) {
    if (monthDataByMonth[m]) large[CONFIG.CACHE_KEYS.MONTH_DATA_PREFIX + m] = monthDataByMonth[m];
  });
  const plain = {};
  Object.keys(opResults || {}).forEach(function (id) {
    if (id) plain[opCacheKey_(id)] = JSON.stringify(opResults[id]);
  });
  // 冪等結果和月份明細都存 6 小時（CONFIG.OP_RESULT_TTL 與 CACHE_TTL 相同，才能放在同一次 putAll）
  return cachePutAllMixed_(large, plain, Math.min(CONFIG.CACHE_TTL, CONFIG.OP_RESULT_TTL));
}

function opResultMap_(opId, core) {
  const map = {};
  if (opId) map[opId] = core;
  return map;
}

function ledgerCounts_(monthData) {
  return {
    expenses: ((monthData && monthData.expenses) || []).length,
    incomes: ((monthData && monthData.incomes) || []).length,
  };
}

/**
 * 鎖外的收尾：清受影響的快取、標記彙總、算一次預算、組回應。
 * @param locked  鎖內回傳的 { core, monthData, marksJson, replayed }
 * @param sheet   重送（replay）時月份明細不在快取裡才用來重讀
 * @param prelude readWritePrelude_ 的結果（算預算用）
 */
function finishLedgerMutation_(locked, sheet, form, prelude, options) {
  const core = locked.core;
  const month = core.month;
  let monthData = locked.monthData;
  if (!monthData) monthData = readMonthSheetDataFromSheet_(sheet, month);

  invalidateOverviewAndSettlementCache_(month);
  if (!options || options.summary !== false) markSummaryDirty_(month, locked.marksJson);

  const budget = prelude.budget(month, monthData);
  const res = Object.assign({ ok: true }, core);
  if (locked.replayed) res.replayed = true;
  if (wantsFullResponse_(form)) {
    delete res.op;
    res.recent = buildRecentPayload_(month, monthData, 8, 8, budget);
  } else {
    res.dailyExpenses = monthData.dailyExpenses || {};
    res.budget = budget;
    res.counts = ledgerCounts_(monthData);
  }
  return res;
}

/** 鎖內：這個 opId 已經處理過就回傳上次的結果（不再寫入），否則回傳 null。 */
function replayedLedgerOp_(state, opId, month) {
  const core = opId ? state.ops[opId] : null;
  if (!core) return null;
  return { core: core, monthData: state.monthData[core.month || month] || null, marksJson: state.marksJson, replayed: true };
}

/* -------------------------------- 記帳服務 -------------------------------- */

function addRecord_(kind, form) {
  const block = LEDGER_BLOCKS_[kind];
  const opId = normalizeOpId_(form.opId);
  const prelude = readWritePrelude_([form.month]);
  const target = getTargetSheet_(form.month);
  const sheet = target.sheet;
  const record = parseRecordForm_(block, form, target, prelude.options(target.ss));

  const locked = withDocumentLock_(function () {
    const state = readLockedLedgerState_([form.month], [opId]);
    const replay = replayedLedgerOp_(state, opId, form.month);
    if (replay) return replay;

    const slot = findWritableLedgerRow_(sheet, block, form.month, state.monthData[form.month]);
    const row = slot.row;
    writeLedgerRow_(sheet, block, row, record);

    const newRecord = buildStoredRecord_(block, row, record);
    const monthData = slot.monthData;
    applyAddToMonthData_(block, monthData, newRecord);

    const logId = opId || serverOpId_();
    appendOpLog_(target.ss, [{ action: 'add', month: form.month, type: block.type, row: row, before: null, after: newRecord, opId: logId }]);
    const core = { op: 'add', type: block.type, month: form.month, row: row, record: newRecord, opId: logId };
    const months = {};
    months[form.month] = monthData;
    commitLedgerCaches_(months, opResultMap_(opId, core));
    return { core: core, monthData: monthData, marksJson: state.marksJson };
  });
  return finishLedgerMutation_(locked, sheet, form, prelude);
}

function updateRecord_(kind, form) {
  const block = LEDGER_BLOCKS_[kind];
  const opId = normalizeOpId_(form.opId);
  const prelude = readWritePrelude_([form.month]);
  const target = getTargetSheet_(form.month);
  const sheet = target.sheet;
  const row = parseLedgerRow_(form.row);
  const record = parseRecordForm_(block, form, target, prelude.options(target.ss));

  const locked = withDocumentLock_(function () {
    const state = readLockedLedgerState_([form.month], [opId]);
    const replay = replayedLedgerOp_(state, opId, form.month);
    if (replay) return replay;

    // 修改前的內容（操作紀錄與復原用）：直接讀這一列，不靠快取
    const range = ledgerRowRange_(sheet, block, row);
    const prev = ledgerValuesToRecord_(block, range.getValues()[0], row);
    assertLedgerRowExpected_(block, prev.filled ? prev.record : null, form.expect);
    range.setValues([recordToRowValues_(block, record)]);
    const updatedRecord = buildStoredRecord_(block, row, record);

    let monthData = state.monthData[form.month];
    if (monthData) {
      putRecordIntoMonthData_(block, monthData, updatedRecord);
    } else {
      monthData = readMonthSheetDataFromSheet_(sheet, form.month, { save: false });
    }

    const logId = opId || serverOpId_();
    appendOpLog_(target.ss, [{ action: 'update', month: form.month, type: block.type, row: row,
      before: prev.filled ? prev.record : null, after: updatedRecord, opId: logId }]);
    const core = { op: 'update', type: block.type, month: form.month, row: row, record: updatedRecord, opId: logId };
    const months = {};
    months[form.month] = monthData;
    commitLedgerCaches_(months, opResultMap_(opId, core));
    return { core: core, monthData: monthData, marksJson: state.marksJson };
  });
  return finishLedgerMutation_(locked, sheet, form, prelude);
}

function deleteRecord_(kind, form) {
  const block = LEDGER_BLOCKS_[kind];
  const opId = normalizeOpId_(form.opId);
  const prelude = readWritePrelude_([form.month]);
  const target = getTargetSheet_(form.month);
  const sheet = target.sheet;
  const row = parseLedgerRow_(form.row);

  const locked = withDocumentLock_(function () {
    const state = readLockedLedgerState_([form.month], [opId]);
    const replay = replayedLedgerOp_(state, opId, form.month);
    if (replay) return replay;

    const removal = removeLedgerRow_(sheet, block, row, form.expect);

    let monthData = state.monthData[form.month];
    if (!monthData || !applyDeleteToMonthData_(block, monthData, row, removal)) {
      monthData = readMonthSheetDataFromSheet_(sheet, form.month, { save: false });
      if (removal.lastDataRow) {
        const existingBlanks = Array.isArray(monthData[block.blankRowsKey]) ? monthData[block.blankRowsKey] : [];
        monthData[block.blankRowsKey] = Array.from(new Set(existingBlanks.concat([removal.lastDataRow])))
          .sort(function (a, b) { return a - b; });
      }
    }

    const logId = opId || serverOpId_();
    appendOpLog_(target.ss, [{ action: 'delete', month: form.month, type: block.type, row: row,
      before: filledRecordAt_(block, removal.values, row), after: null, opId: logId }]);
    const core = { op: 'delete', type: block.type, month: form.month, row: row, opId: logId };
    const months = {};
    months[form.month] = monthData;
    commitLedgerCaches_(months, opResultMap_(opId, core));
    return { core: core, monthData: monthData, marksJson: state.marksJson };
  });
  return finishLedgerMutation_(locked, sheet, form, prelude);
}

function addExpense_(form) { return addRecord_('expense', form); }
function addIncome_(form) { return addRecord_('income', form); }
function updateExpense_(form) { return updateRecord_('expense', form); }
function updateIncome_(form) { return updateRecord_('income', form); }
function deleteExpense_(form) { return deleteRecord_('expense', form); }
function deleteIncome_(form) { return deleteRecord_('income', form); }

/* ------------------------------ 批次新增（P10） ------------------------------
 * addRecords([form, …], { full })：給離線佇列一次送出多筆。每筆是 addExpense／addIncome 的表單再加上
 * type（'expense'｜'income'），各自帶 opId。一次鎖、一次開試算表；同一個月份、同一種類型連續的空白列用一次 setValues。
 * 每筆各自回傳成功或失敗（驗證失敗、可用列已滿），不會因為一筆失敗整批不寫。
 * 回傳 { ok: true, results: [ { ok, index, opId, op, type, month, row, record } 或 { ok: false, index, opId, error } ],
 *        months: { 月份: { dailyExpenses, budget, counts } } }（full 時每個月份改成 { recent }）
 */
function addRecords_(forms, options) {
  if (!Array.isArray(forms) || !forms.length) throw new Error('沒有要寫入的紀錄。');
  if (forms.length > ADD_RECORDS_MAX_) throw new Error('一次最多寫入 ' + ADD_RECORDS_MAX_ + ' 筆。');
  const full = wantsFullResponse_(options);
  const prelude = readWritePrelude_(forms.map(function (f) { return f && f.month; })
    .filter(function (m, i, all) { return all.indexOf(m) === i; }));

  const targets = {};
  const items = forms.map(function (form, index) {
    const item = { index: index, opId: normalizeOpId_(form && form.opId) };
    try {
      if (!isPlainObject_(form)) throw new Error('資料格式錯誤，請重新整理頁面後再試一次。');
      const block = LEDGER_BLOCKS_[form.type];
      if (!block) throw new Error('紀錄類型必須是 expense 或 income。');
      validateMonthFormat_(form.month);
      const target = targets[form.month] || (targets[form.month] = getTargetSheet_(form.month));
      item.block = block;
      item.month = form.month;
      item.record = parseRecordForm_(block, form, target, prelude.options(target.ss));
    } catch (e) {
      item.error = e && e.message ? e.message : String(e);
    }
    return item;
  });

  const valid = items.filter(function (it) { return !it.error; });
  const months = [];
  valid.forEach(function (it) { if (months.indexOf(it.month) === -1) months.push(it.month); });

  const locked = months.length ? withDocumentLock_(function () {
    const state = readLockedLedgerState_(months, valid.map(function (it) { return it.opId; }));
    const monthData = {};
    const done = {};      // 這一批裡已經處理過的 opId → 結果（同一批重複的 opId 視為重送）
    const opResults = {};
    const logEntries = []; // 整批的操作紀錄，最後一次 setValues

    const groups = [];    // [{ month, block, items }]，依第一次出現的順序
    valid.forEach(function (it) {
      if (it.opId && (state.ops[it.opId] || done[it.opId])) {
        it.core = state.ops[it.opId] || done[it.opId];
        it.replayed = true;
        return;
      }
      if (it.opId) done[it.opId] = true;
      let g = groups.find(function (x) { return x.month === it.month && x.block === it.block; });
      if (!g) groups.push(g = { month: it.month, block: it.block, items: [] });
      g.items.push(it);
    });

    groups.forEach(function (g) {
      const sheet = targets[g.month].sheet;
      if (!monthData[g.month]) {
        monthData[g.month] = state.monthData[g.month] || readMonthSheetDataFromSheet_(sheet, g.month, { save: false });
      }
      const md = monthData[g.month];
      const slots = findWritableLedgerRows_(sheet, g.block, g.items.length);

      // 依列號分段，連續的列一次 setValues
      let runStart = 0;
      for (let i = 1; i <= slots.rows.length; i++) {
        if (i < slots.rows.length && slots.rows[i] === slots.rows[i - 1] + 1) continue;
        const values = [];
        for (let j = runStart; j < i; j++) values.push(recordToRowValues_(g.block, g.items[j].record));
        ledgerRowRange_(sheet, g.block, slots.rows[runStart], values.length).setValues(values);
        runStart = i;
      }

      g.items.forEach(function (it, i) {
        const row = slots.rows[i];
        if (!row) {
          it.error = '可用輸入列已滿，這筆沒有寫入。';
          if (it.opId) delete done[it.opId];
          return;
        }
        const stored = buildStoredRecord_(g.block, row, it.record);
        putRecordIntoMonthData_(g.block, md, stored);
        const logId = it.opId || serverOpId_();
        logEntries.push({ index: it.index, action: 'add', month: g.month, type: g.block.type, row: row, before: null, after: stored, opId: logId });
        it.core = { op: 'add', type: g.block.type, month: g.month, row: row, record: stored, opId: logId };
        if (it.opId) {
          done[it.opId] = it.core;
          opResults[it.opId] = it.core;
        }
      });
      md[g.block.blankRowsKey] = slots.spareBlanks;
    });

    // 同一批裡重複的 opId：拿第一筆的結果
    valid.forEach(function (it) {
      if (it.replayed && it.core === true) it.core = done[it.opId];
    });

    // 操作紀錄照送來的順序（寫入時是依月份＋類型分組，順序不同）
    logEntries.sort(function (a, b) { return a.index - b.index; });
    if (logEntries.length) appendOpLog_(targets[logEntries[0].month].ss, logEntries);
    commitLedgerCaches_(monthData, opResults);
    months.forEach(function (m) { if (!monthData[m]) monthData[m] = state.monthData[m]; });
    return { monthData: monthData, marksJson: state.marksJson };
  }) : null;

  const results = items.map(function (it) {
    if (it.error || !it.core || it.core === true) {
      return { ok: false, index: it.index, opId: it.opId, error: it.error || '這筆沒有寫入。' };
    }
    const out = Object.assign({ ok: true, index: it.index, opId: it.opId }, it.core);
    if (it.replayed) out.replayed = true;
    return out;
  });

  const monthsOut = {};
  months.forEach(function (m) {
    let md = locked.monthData[m];
    if (!md) md = readMonthSheetDataFromSheet_(targets[m].sheet, m);
    invalidateOverviewAndSettlementCache_(m);
    markSummaryDirty_(m, locked.marksJson);
    const budget = prelude.budget(m, md);
    monthsOut[m] = full
      ? { recent: buildRecentPayload_(m, md, 8, 8, budget) }
      : { dailyExpenses: md.dailyExpenses || {}, budget: budget, counts: ledgerCounts_(md) };
  });

  return { ok: true, results: results, months: monthsOut };
}

/* ------------------------------ 信用卡已繳標記 ------------------------------ */

function resolvePaidCode_(form) {
  return normalizePaidCode_(form.paid !== undefined ? form.paid : 'O');
}

function markCreditCardPaid_(form) {
  const block = LEDGER_BLOCKS_.expense;
  const opId = normalizeOpId_(form.opId);
  const prelude = readWritePrelude_([form.month]);
  const target = getTargetSheet_(form.month);
  const sheet = target.sheet;
  const row = parseLedgerRow_(form.row);
  const paid = resolvePaidCode_(form);

  const locked = withDocumentLock_(function () {
    const state = readLockedLedgerState_([form.month], [opId]);
    const replay = replayedLedgerOp_(state, opId, form.month);
    if (replay) return replay;

    // 標記前的整列內容（操作紀錄與復原用）
    const prev = ledgerValuesToRecord_(block, ledgerRowRange_(sheet, block, row).getValues()[0], row).record;
    sheet.getRange(row, block.paidCol).setValue(paid);

    let monthData = state.monthData[form.month];
    const rec = monthData && Array.isArray(monthData.expenses)
      ? monthData.expenses.find(function (r) { return r.row === row; })
      : null;
    if (rec) rec.paid = paid;
    else monthData = readMonthSheetDataFromSheet_(sheet, form.month, { save: false });

    const logId = opId || serverOpId_();
    appendOpLog_(target.ss, [{ action: 'paid', month: form.month, type: 'expense', row: [row],
      before: [prev], after: [Object.assign({}, prev, { paid: paid })], opId: logId }]);
    const core = { op: 'paid', type: 'expense', month: form.month, row: row, paid: paid, opId: logId };
    const months = {};
    months[form.month] = monthData;
    commitLedgerCaches_(months, opResultMap_(opId, core));
    return { core: core, monthData: monthData, marksJson: state.marksJson };
  });
  return finishLedgerMutation_(locked, sheet, form, prelude, { summary: false });
}

function batchMarkCreditCardPaid_(form) {
  const block = LEDGER_BLOCKS_.expense;
  const opId = normalizeOpId_(form.opId);
  const prelude = readWritePrelude_([form.month]);
  const target = getTargetSheet_(form.month);
  const sheet = target.sheet;

  const rawRows = Array.isArray(form.rows) ? form.rows : [];
  const validRows = rawRows
    .map(function (r) { return Number(r); })
    .filter(function (r) { return Number.isInteger(r) && r >= CONFIG.MIN_DATA_ROW && r <= CONFIG.MAX_DATA_ROW; });

  if (!validRows.length) {
    throw new Error('沒有選擇要更新的交易列。');
  }
  const paid = resolvePaidCode_(form);

  const locked = withDocumentLock_(function () {
    const state = readLockedLedgerState_([form.month], [opId]);
    const replay = replayedLedgerOp_(state, opId, form.month);
    if (replay) return replay;

    // 標記前的內容（操作紀錄與復原用）：最小到最大列號一次讀完
    const minRow = Math.min.apply(null, validRows);
    const span = ledgerRowRange_(sheet, block, minRow, Math.max.apply(null, validRows) - minRow + 1).getValues();
    const prevRecords = validRows.map(function (r) { return ledgerValuesToRecord_(block, span[r - minRow], r).record; });

    const paidColumnLetter = columnLetter_(block.paidCol);
    sheet.getRangeList(validRows.map(function (r) { return paidColumnLetter + r; })).setValue(paid);

    let monthData = state.monthData[form.month];
    if (monthData && Array.isArray(monthData.expenses)) {
      const rowSet = new Set(validRows);
      monthData.expenses.forEach(function (r) {
        if (rowSet.has(r.row)) r.paid = paid;
      });
    } else {
      monthData = readMonthSheetDataFromSheet_(sheet, form.month, { save: false });
    }

    const logId = opId || serverOpId_();
    appendOpLog_(target.ss, [{ action: 'paid', month: form.month, type: 'expense', row: validRows, before: prevRecords,
      after: prevRecords.map(function (r) { return Object.assign({}, r, { paid: paid }); }), opId: logId }]);
    const core = { op: 'paid', type: 'expense', month: form.month, rows: validRows, paid: paid, opId: logId };
    const months = {};
    months[form.month] = monthData;
    commitLedgerCaches_(months, opResultMap_(opId, core));
    return { core: core, monthData: monthData, marksJson: state.marksJson };
  });
  return finishLedgerMutation_(locked, sheet, form, prelude, { summary: false });
}

/* --------------------------- 信用卡對帳：讀取多個月份 --------------------------- */

const CC_MAX_MONTHS_PER_BATCH_ = 12;

/**
 * 一次讀取多個月份工作表的支出明細，給信用卡對帳頁合併顯示。
 * 前端會把所有月份切成每批最多 CC_MAX_MONTHS_PER_BATCH_ 個依序呼叫，避免單次執行過久。
 * 舊版面的工作表（欄位配置不同）會略過，回傳在 skippedMonths。
 */
function getCreditCardRecords_(months, forceRefresh) {
  if (!Array.isArray(months) || !months.length) throw new Error('請指定要讀取的月份。');
  if (months.length > CC_MAX_MONTHS_PER_BATCH_) {
    throw new Error('一次最多讀取 ' + CC_MAX_MONTHS_PER_BATCH_ + ' 個月份。');
  }
  const list = [];
  months.forEach(function (m) {
    validateMonthFormat_(m);
    if (list.indexOf(m) === -1) list.push(m);
  });

  const force = Boolean(forceRefresh);
  let ss = null;
  const getSs = function () { return ss || (ss = getSpreadsheet_()); };
  const layouts = classifyMonthLayouts_(getSs, list, force);

  const recordsByMonth = {};
  const failedMonths = [];
  layouts.current.forEach(function (month) {
    try {
      const monthData = force ? getMonthData_(getSs(), month, true) : getMonthData_(null, month, false);
      recordsByMonth[month] = (monthData && monthData.expenses) || [];
    } catch (e) {
      failedMonths.push(month);
    }
  });

  return {
    recordsByMonth: recordsByMonth,
    skippedMonths: layouts.legacy.concat(layouts.unknown),
    missingMonths: layouts.missing,
    failedMonths: failedMonths,
  };
}
