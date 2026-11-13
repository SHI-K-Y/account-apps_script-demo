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

/** 驗證前端送來的表單並轉成一筆紀錄（不含列號）。驗證順序固定，錯誤訊息才會穩定。 */
function parseRecordForm_(block, form, target) {
  const record = { day: normalizeDay_(form.day, target.daysInMonth) };
  block.fields.forEach(function (field) {
    record[field.key] = stripEmoji_(requiredText_(form[field.key], field.required));
  });
  if (block.type === 'expense') record.paid = normalizePaidCode_(form.paid);
  record.amount = normalizeAmount_(form.amount);
  record.note = textOrBlank_(form.note, 200);

  const options = readOptions_(target.ss);
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

/** 找出可寫入的空白列：優先用快取記下的空白列（寫入前會再確認真的是空的）。 */
function findWritableLedgerRow_(sheet, block, month) {
  let monthData = getCachedMonthData_(month);
  let row = null;

  const cachedBlanks = monthData && monthData[block.blankRowsKey];
  if (Array.isArray(cachedBlanks) && cachedBlanks.length > 0) {
    if (isLedgerRowBlank_(sheet, block, cachedBlanks[0])) row = cachedBlanks[0];
  }

  if (!row) {
    monthData = readMonthSheetDataFromSheet_(sheet, month);
    const blanks = monthData[block.blankRowsKey];
    row = blanks && blanks.length > 0
      ? blanks[0]
      : findNextBlankRow_(sheet, CONFIG.MIN_DATA_ROW, block.startCol, block.width);
  }
  return { row, monthData };
}

/** 刪除一列並把下方的紀錄往上遞補；回傳刪除前最後一筆資料所在的列（沒有資料時為 0）。 */
function removeLedgerRow_(sheet, block, row) {
  const maxRows = Math.min(CONFIG.MAX_DATA_ROW, sheet.getMaxRows());
  const rowCount = maxRows - CONFIG.MIN_DATA_ROW + 1;
  const values = sheet.getRange(CONFIG.MIN_DATA_ROW, block.startCol, rowCount, block.width).getValues();

  let lastDataRow = 0;
  for (let i = values.length - 1; i >= 0; i--) {
    if (!values[i].every(isBlankCell_)) {
      lastDataRow = CONFIG.MIN_DATA_ROW + i;
      break;
    }
  }

  if (lastDataRow && row <= lastDataRow) {
    if (row === lastDataRow) {
      ledgerRowRange_(sheet, block, row).clearContent();
    } else {
      const startIdx = row - CONFIG.MIN_DATA_ROW + 1;
      const endIdx = lastDataRow - CONFIG.MIN_DATA_ROW + 1;
      const shiftValues = values.slice(startIdx, endIdx).map(function (r) {
        return r.map(function (cell) {
          return typeof cell === 'string' ? literalText_(cell) : cell;
        });
      });
      shiftValues.push(new Array(block.width).fill(''));
      ledgerRowRange_(sheet, block, row, shiftValues.length).setValues(shiftValues);
    }
  }
  return lastDataRow;
}

/* -------------------------------- 記帳服務 -------------------------------- */

function afterLedgerMutation_(month, options) {
  invalidateOverviewAndSettlementCache_(month);
  if (!options || options.summary !== false) markSummaryDirty_(month);
}

function addRecord_(kind, form) {
  const block = LEDGER_BLOCKS_[kind];
  return withDocumentLock_(function () {
    const target = getTargetSheet_(form.month);
    const sheet = target.sheet;
    const record = parseRecordForm_(block, form, target);

    const slot = findWritableLedgerRow_(sheet, block, form.month);
    const row = slot.row;
    const monthData = slot.monthData;
    writeLedgerRow_(sheet, block, row, record);

    const newRecord = buildStoredRecord_(block, row, record);

    if (monthData) {
      const list = monthData[block.listKey].filter(function (r) { return r.row !== row; });
      list.push(newRecord);
      list.sort(function (a, b) { return b.row - a.row; });
      monthData[block.listKey] = list;
      if (block.hasDailyTotals) monthData.dailyExpenses = computeDailyExpenses_(list);
      const blanks = (monthData[block.blankRowsKey] || []).filter(function (r) { return r !== row; });
      if (blanks.length === 0 && row + 1 <= CONFIG.MAX_DATA_ROW) blanks.push(row + 1);
      monthData[block.blankRowsKey] = blanks;
      saveMonthDataCache_(form.month, monthData);
      syncBootSnapshotWithMonthData_(form.month, monthData);
    }
    afterLedgerMutation_(form.month);

    return {
      ok: true,
      type: block.type,
      month: form.month,
      row,
      record: newRecord,
      recent: monthData ? buildRecentPayload_(form.month, monthData, 8, 8) : null,
    };
  });
}

function updateRecord_(kind, form) {
  const block = LEDGER_BLOCKS_[kind];
  return withDocumentLock_(function () {
    const target = getTargetSheet_(form.month);
    const sheet = target.sheet;
    const row = parseLedgerRow_(form.row);
    const record = parseRecordForm_(block, form, target);

    writeLedgerRow_(sheet, block, row, record);
    const updatedRecord = buildStoredRecord_(block, row, record);

    let monthData = getCachedMonthData_(form.month);
    if (monthData) {
      const list = monthData[block.listKey];
      const idx = list.findIndex(function (r) { return r.row === row; });
      if (idx !== -1) {
        list[idx] = updatedRecord;
      } else {
        list.push(updatedRecord);
        list.sort(function (a, b) { return b.row - a.row; });
      }
      if (block.hasDailyTotals) monthData.dailyExpenses = computeDailyExpenses_(list);
      saveMonthDataCache_(form.month, monthData);
    } else {
      monthData = readMonthSheetDataFromSheet_(sheet, form.month);
    }
    syncBootSnapshotWithMonthData_(form.month, monthData);
    afterLedgerMutation_(form.month);

    return {
      ok: true,
      type: block.type,
      month: form.month,
      row,
      record: updatedRecord,
      recent: buildRecentPayload_(form.month, monthData, 8, 8),
    };
  });
}

function deleteRecord_(kind, form) {
  const block = LEDGER_BLOCKS_[kind];
  return withDocumentLock_(function () {
    const target = getTargetSheet_(form.month);
    const sheet = target.sheet;
    const row = parseLedgerRow_(form.row);

    const lastDataRow = removeLedgerRow_(sheet, block, row);

    const monthData = readMonthSheetDataFromSheet_(sheet, form.month);
    if (lastDataRow) {
      const existingBlanks = Array.isArray(monthData[block.blankRowsKey]) ? monthData[block.blankRowsKey] : [];
      monthData[block.blankRowsKey] = Array.from(new Set(existingBlanks.concat([lastDataRow])))
        .sort(function (a, b) { return a - b; });
      saveMonthDataCache_(form.month, monthData);
    }
    syncBootSnapshotWithMonthData_(form.month, monthData);
    afterLedgerMutation_(form.month);

    return {
      ok: true,
      type: block.type,
      month: form.month,
      row,
      recent: buildRecentPayload_(form.month, monthData, 8, 8),
    };
  });
}

function addExpense_(form) { return addRecord_('expense', form); }
function addIncome_(form) { return addRecord_('income', form); }
function updateExpense_(form) { return updateRecord_('expense', form); }
function updateIncome_(form) { return updateRecord_('income', form); }
function deleteExpense_(form) { return deleteRecord_('expense', form); }
function deleteIncome_(form) { return deleteRecord_('income', form); }

/* ------------------------------ 信用卡已繳標記 ------------------------------ */

function resolvePaidCode_(form) {
  return normalizePaidCode_(form.paid !== undefined ? form.paid : 'O');
}

function markCreditCardPaid_(form) {
  const block = LEDGER_BLOCKS_.expense;
  return withDocumentLock_(function () {
    const target = getTargetSheet_(form.month);
    const sheet = target.sheet;
    const row = parseLedgerRow_(form.row);
    const paid = resolvePaidCode_(form);

    sheet.getRange(row, block.paidCol).setValue(paid);

    let monthData = getCachedMonthData_(form.month);
    if (monthData && Array.isArray(monthData.expenses)) {
      const idx = monthData.expenses.findIndex(function (r) { return r.row === row; });
      if (idx !== -1) {
        monthData.expenses[idx].paid = paid;
        saveMonthDataCache_(form.month, monthData);
      } else {
        monthData = readMonthSheetDataFromSheet_(sheet, form.month);
      }
    } else {
      monthData = readMonthSheetDataFromSheet_(sheet, form.month);
    }

    syncBootSnapshotWithMonthData_(form.month, monthData);
    afterLedgerMutation_(form.month, { summary: false });

    return {
      ok: true,
      month: form.month,
      row,
      paid,
      recent: buildRecentPayload_(form.month, monthData, 8, 8),
    };
  });
}

function batchMarkCreditCardPaid_(form) {
  const block = LEDGER_BLOCKS_.expense;
  return withDocumentLock_(function () {
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
    const paidColumnLetter = columnLetter_(block.paidCol);
    sheet.getRangeList(validRows.map(function (r) { return paidColumnLetter + r; })).setValue(paid);

    let monthData = getCachedMonthData_(form.month);
    if (monthData && Array.isArray(monthData.expenses)) {
      const rowSet = new Set(validRows);
      monthData.expenses.forEach(function (r) {
        if (rowSet.has(r.row)) r.paid = paid;
      });
      saveMonthDataCache_(form.month, monthData);
    } else {
      monthData = readMonthSheetDataFromSheet_(sheet, form.month);
    }

    syncBootSnapshotWithMonthData_(form.month, monthData);
    afterLedgerMutation_(form.month, { summary: false });

    return {
      ok: true,
      month: form.month,
      rows: validRows,
      paid,
      recent: buildRecentPayload_(form.month, monthData, 8, 8),
    };
  });
}
