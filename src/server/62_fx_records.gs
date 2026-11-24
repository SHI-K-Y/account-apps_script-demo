function normalizeFxRecordForm_(form, options, existingPayment) {
  const date = normalizeFxIsoDate_(form && form.date);
  if (!date) throw new Error('請選擇有效的日期。');

  const item = stripEmoji_(requiredText_(form.item, '請選擇交易項目'));
  validateOption_(item, options.fxItems || [], '交易項目');

  const payment = stripEmoji_(requiredText_(form.payment, '請選擇交易方式'));
  const paymentOptions = options.paymentMethods || [];
  if (paymentOptions.indexOf(payment) === -1 && !(existingPayment && payment === existingPayment)) {
    validateOption_(payment, paymentOptions, '交易方式');
  }

  const currency = requiredText_(form.currency, '請選擇幣別').toUpperCase();
  validateOption_(currency, options.fxCurrencies || [], '幣別');

  const amount = roundFx2_(normalizeAmount_(form.amount));
  if (amount <= 0) throw new Error('金額必須是大於 0 的數字。');

  let rate = 1;
  if (currency !== FX_HOME_CURRENCY_) {
    rate = Number(String(form.rate == null ? '' : form.rate).replace(/,/g, '').trim());
    if (!Number.isFinite(rate) || rate <= 0 || rate > FX_RATE_MAX_) {
      throw new Error('匯率必須是大於 0 且不超過 ' + FX_RATE_MAX_ + ' 的數字（1 ' + currency + ' = ? NTD）。');
    }
  }

  const note = textOrBlank_(form.note, 200);
  return { date: date, item: item, payment: payment, currency: currency, amount: amount, rate: rate, note: note };
}

function writeFxRow_(sheet, row, rec, tz) {
  sheet.getRange(row, FX_COL_.DATE, 1, 5).setValues([[
    fxIsoToSheetDate_(rec.date, tz),
    literalText_(rec.item),
    literalText_(rec.payment),
    literalText_(rec.currency),
    rec.amount,
  ]]);
  sheet.getRange(row, FX_COL_.NOTE).setValue(literalText_(rec.note));
  sheet.getRange(row, FX_COL_.RATE).setValue(rec.rate);
}

function fxRecordFromRow_(row, rec) {
  return {
    row: row,
    date: rec.date,
    item: rec.item,
    payment: rec.payment,
    currency: rec.currency,
    amount: rec.amount,
    rate: rec.rate,
    twd: roundFx2_(rec.amount * rec.rate),
    note: rec.note,
  };
}

function fxSummaryOf_(ledger) {
  return { totalTwd: ledger.totalTwd, count: ledger.count };
}

function isFxRowEmpty_(values) {
  return values.every(function (v) { return v === '' || v === null || String(v).trim() === ''; });
}

function addFxRecord_(form) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const tz = DEFAULT_TIME_ZONE_;
    const sheet = getFxLedgerSheet_(ss, form && form.ledgerId);
    const options = readFxOptions_(ss);
    const rec = normalizeFxRecordForm_(form, options, null);

    let payload = getFxLedgerCache_(sheet.getSheetId());
    let row = null;
    if (payload && payload.header && Array.isArray(payload.records) && payload.blankRow) {
      const candidate = Number(payload.blankRow);
      if (candidate >= CONFIG.FX_MIN_DATA_ROW && candidate <= CONFIG.FX_MAX_DATA_ROW &&
          isFxRowEmpty_(sheet.getRange(candidate, FX_COL_.DATE, 1, 5).getValues()[0])) {
        row = candidate;
      }
    }
    if (!row) {
      payload = loadFxLedgerFromSheet_(ss, sheet, options);
      row = payload.blankRow;
    }
    if (!row) throw new Error('這本帳簿已滿（第 ' + CONFIG.FX_MIN_DATA_ROW + '～' + CONFIG.FX_MAX_DATA_ROW + ' 列都有資料）。');

    writeFxRow_(sheet, row, rec, tz);

    const record = fxRecordFromRow_(row, rec);
    payload.records = payload.records.filter(function (r) { return Number(r.row) !== row; });
    payload.records.push(record);
    sortFxRecords_(payload.records);
    refreshFxLedgerCacheAfterWrite_(ss, sheet, payload, options);

    return { ok: true, record: record, summary: fxSummaryOf_(payload.ledger), ledger: payload.ledger, blankRow: payload.blankRow };
  });
}

function updateFxRecord_(form) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const tz = DEFAULT_TIME_ZONE_;
    const sheet = getFxLedgerSheet_(ss, form && form.ledgerId);
    const row = Number(form.row);
    if (!Number.isInteger(row) || row < CONFIG.FX_MIN_DATA_ROW || row > CONFIG.FX_MAX_DATA_ROW) {
      throw new Error('無效的資料列號：' + form.row);
    }
    const current = sheet.getRange(row, FX_COL_.DATE, 1, FX_READ_COLS_).getValues()[0];
    const currentItem = cellToStr_(current[1]);
    const hasAmount = current[4] !== '' && current[4] !== null && String(current[4]).trim() !== '';
    if (!currentItem && !hasAmount) throw new Error('這筆紀錄已不存在，請重新讀取帳簿。');

    const options = readFxOptions_(ss);
    const rec = normalizeFxRecordForm_(form, options, cellToStr_(current[2]));
    writeFxRow_(sheet, row, rec, tz);

    const record = fxRecordFromRow_(row, rec);
    let payload = getFxLedgerCache_(sheet.getSheetId());
    if (payload && payload.header && Array.isArray(payload.records)) {
      payload.records = payload.records.filter(function (r) { return Number(r.row) !== row; });
      payload.records.push(record);
      sortFxRecords_(payload.records);
      refreshFxLedgerCacheAfterWrite_(ss, sheet, payload, options);
    } else {
      payload = loadFxLedgerFromSheet_(ss, sheet, options);
      scriptCache_().remove(CONFIG.CACHE_KEYS.FX_LEDGERS);
    }

    return { ok: true, record: record, summary: fxSummaryOf_(payload.ledger), ledger: payload.ledger, blankRow: payload.blankRow };
  });
}

function fxTemplateFormulasR1C1_(ss, row) {
  let dateF = '';
  let rateF = '';
  try {
    const template = ss.getSheetByName(CONFIG.FX_TEMPLATE_SHEET);
    if (template) {
      dateF = template.getRange(row, FX_COL_.DATE).getFormulaR1C1();
      rateF = template.getRange(row, FX_COL_.RATE).getFormulaR1C1();
    }
  } catch (e) {}
  return { date: dateF || FX_FORMULA_DATE_R1C1_, rate: rateF || FX_FORMULA_RATE_R1C1_ };
}

function deleteFxRecord_(form) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const tz = DEFAULT_TIME_ZONE_;
    const sheet = getFxLedgerSheet_(ss, form && form.ledgerId);
    const row = Number(form.row);
    if (!Number.isInteger(row) || row < CONFIG.FX_MIN_DATA_ROW || row > CONFIG.FX_MAX_DATA_ROW) {
      throw new Error('無效的資料列號：' + form.row);
    }

    const minRow = CONFIG.FX_MIN_DATA_ROW;
    const maxRow = Math.min(CONFIG.FX_MAX_DATA_ROW, sheet.getMaxRows());
    const values = sheet.getRange(minRow, 2, maxRow - minRow + 1, FX_READ_COLS_).getValues();
    const isData = function (r) {
      return cellToStr_(r[1]) !== '' || (r[4] !== '' && r[4] !== null && String(r[4]).trim() !== '');
    };
    if (!values[row - minRow] || !isData(values[row - minRow])) {
      throw new Error('這筆紀錄已不存在，請重新讀取帳簿。');
    }
    let lastDataRow = row;
    for (let i = values.length - 1; i >= 0; i--) {
      if (isData(values[i])) { lastDataRow = minRow + i; break; }
    }

    const asLiteral = function (cell) { return typeof cell === 'string' ? literalText_(cell) : cell; };
    if (row < lastDataRow) {
      const moved = values.slice(row - minRow + 1, lastDataRow - minRow + 1);
      sheet.getRange(row, FX_COL_.DATE, moved.length, 5).setValues(moved.map(function (r) {
        return r.slice(0, 5).map(asLiteral);
      }));
      sheet.getRange(row, FX_COL_.NOTE, moved.length, 1).setValues(moved.map(function (r) { return [asLiteral(r[6])]; }));
      sheet.getRange(row, FX_COL_.RATE, moved.length, 1).setValues(moved.map(function (r) { return [asLiteral(r[8])]; }));
    }

    sheet.getRange(lastDataRow, FX_COL_.ITEM, 1, 4).clearContent();
    sheet.getRange(lastDataRow, FX_COL_.NOTE).clearContent();
    const formulas = fxTemplateFormulasR1C1_(ss, lastDataRow);
    sheet.getRange(lastDataRow, FX_COL_.DATE).setFormulaR1C1(formulas.date);
    sheet.getRange(lastDataRow, FX_COL_.RATE).setFormulaR1C1(formulas.rate);
    flushSpreadsheet_();

    const options = readFxOptions_(ss);
    const payload = loadFxLedgerFromSheet_(ss, sheet, options);
    scriptCache_().remove(CONFIG.CACHE_KEYS.FX_LEDGERS);

    return {
      ok: true,
      row: row,
      records: payload.records,
      summary: fxSummaryOf_(payload.ledger),
      ledger: payload.ledger,
      blankRow: payload.blankRow,
    };
  });
}

function batchUpdateFxPaymentColumns_(ss, cardRenameMap, channelRenameMap, bankRenameMap) {
  let changed = 0;
  const ids = [];
  listFxLedgerSheets_(ss).forEach(function (sheet) {
    ids.push(sheet.getSheetId());
    const maxRow = Math.min(CONFIG.FX_MAX_DATA_ROW, sheet.getMaxRows());
    const count = maxRow - CONFIG.FX_MIN_DATA_ROW + 1;
    if (count <= 0) return;
    const range = sheet.getRange(CONFIG.FX_MIN_DATA_ROW, FX_COL_.PAYMENT, count, 1);
    const colValues = range.getValues();
    let sheetChanged = 0;
    const updated = colValues.map(function (r) {
      const orig = r[0];
      if (typeof orig !== 'string' || !orig.trim()) return [orig];
      const next = renamePaymentValue_(orig, cardRenameMap, channelRenameMap, bankRenameMap);
      if (String(next) !== orig) {
        sheetChanged++;
        return [literalText_(next)];
      }
      return [literalText_(orig)];
    });
    if (sheetChanged > 0) {
      range.setValues(updated);
      changed += sheetChanged;
    }
  });
  if (ids.length) invalidateFxCaches_(ids);
  return changed;
}
