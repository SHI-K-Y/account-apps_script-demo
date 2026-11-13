function getFxLedgers_(forceRefresh) {
  const isForce = Boolean(forceRefresh);
  const cache = scriptCache_();
  if (!isForce) {
    const cached = cache.get(CONFIG.CACHE_KEYS.FX_LEDGERS);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
  }

  const ss = getSpreadsheet_();
  const options = readFxOptions_(ss);
  const sheets = listFxLedgerSheets_(ss);
  const ledgers = sheets.map(function (sheet) {
    const cachedLedger = isForce ? null : getFxLedgerCache_(sheet.getSheetId());
    if (cachedLedger && cachedLedger.header && Array.isArray(cachedLedger.records)) {
      return buildFxLedgerObject_(ss, sheet, cachedLedger.header, cachedLedger.records, options);
    }
    return loadFxLedgerFromSheet_(ss, sheet, options).ledger;
  });
  sortFxLedgers_(ledgers);
  saveFxLedgerIds_(sheets.map(function (s) { return s.getSheetId(); }));

  const result = { ledgers: ledgers, fetchedAt: Date.now() };
  try {
    const str = JSON.stringify(result);
    if (fitsCacheValue_(str)) cache.put(CONFIG.CACHE_KEYS.FX_LEDGERS, str, CONFIG.CACHE_TTL);
  } catch (e) {}
  return result;
}

function sortFxLedgers_(ledgers) {
  ledgers.sort(function (a, b) {
    if (a.archived !== b.archived) return a.archived ? 1 : -1;
    const sa = a.startDate || '';
    const sb = b.startDate || '';
    if (sa !== sb) return sa < sb ? 1 : -1;
    return String(a.name).localeCompare(String(b.name), 'zh-Hant');
  });
  return ledgers;
}

function getFxLedgerData_(ledgerId, forceRefresh) {
  const isForce = Boolean(forceRefresh);
  let payload = isForce ? null : getFxLedgerCache_(ledgerId);
  let ratesInfo = isForce ? null : getCachedFxRates_(ledgerId);
  let ss = null;
  let sheet = null;

  if (!payload) {
    ss = getSpreadsheet_();
    sheet = getFxLedgerSheet_(ss, ledgerId);
    payload = loadFxLedgerFromSheet_(ss, sheet, readFxOptions_(ss));
  }
  if (!ratesInfo) {
    ss = ss || getSpreadsheet_();
    sheet = sheet || getFxLedgerSheet_(ss, ledgerId);
    ratesInfo = getFxRatesFromSheet_(ss, sheet);
  }

  return {
    ledger: payload.ledger,
    records: payload.records,
    rates: ratesInfo.rates,
    ratesFetchedAt: ratesInfo.fetchedAt,
    blankRow: payload.blankRow,
  };
}

function getFxRates_(ledgerId, forceRefresh) {
  if (!forceRefresh) {
    const cached = getCachedFxRates_(ledgerId);
    if (cached) return cached;
  }
  const ss = getSpreadsheet_();
  const sheet = getFxLedgerSheet_(ss, ledgerId);
  return getFxRatesFromSheet_(ss, sheet);
}


function validateFxLedgerName_(rawName) {
  const name = String(rawName == null ? '' : rawName).trim();
  if (!name) throw new Error('請輸入帳簿名稱。');
  if (name.length > FX_NAME_MAX_LENGTH_) throw new Error('帳簿名稱最多 ' + FX_NAME_MAX_LENGTH_ + ' 個字。');
  if (FX_INVALID_NAME_CHARS_.test(name)) throw new Error('帳簿名稱不可包含 [ ] * ? / \\ : 這些符號。');
  if (/^'|'$/.test(name)) throw new Error('帳簿名稱不可以單引號開頭或結尾。');
  if (CONFIG.FX_PREFIX + name === CONFIG.FX_TEMPLATE_SHEET) throw new Error('「' + name + '」是範本名稱，請換一個名稱。');
  return name;
}

function validateFxLedgerFields_(form, options) {
  const country = String(form && form.country != null ? form.country : '').trim();
  if (!country) throw new Error('請選擇國家。');
  validateOption_(country, options.fxCountries || [], '國家');
  const startDate = normalizeFxIsoDate_(form.startDate);
  const endDate = normalizeFxIsoDate_(form.endDate);
  if (!startDate || !endDate) throw new Error('請選擇有效的旅行期間。');
  if (startDate > endDate) throw new Error('結束日不可早於開始日。');
  return { country: country, startDate: startDate, endDate: endDate };
}

function writeFxLedgerHeader_(sheet, fields) {
  sheet.getRange('F1').setValue(formatFxPeriod_(fields.startDate, fields.endDate));
  sheet.getRange('I1').setValue(literalText_(fields.country));
}

function createFxLedger_(form) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const options = readFxOptions_(ss);
    const name = validateFxLedgerName_(form && form.name);
    const fields = validateFxLedgerFields_(form || {}, options);
    const sheetName = CONFIG.FX_PREFIX + name;
    if (ss.getSheetByName(sheetName)) throw new Error('已經有「' + sheetName + '」工作表，請換一個名稱。');

    const template = ss.getSheetByName(CONFIG.FX_TEMPLATE_SHEET);
    if (!template) throw new Error('找不到範本「' + CONFIG.FX_TEMPLATE_SHEET + '」工作表。');

    const newSheet = template.copyTo(ss).setName(sheetName);
    if (newSheet.isSheetHidden()) newSheet.showSheet();
    writeFxLedgerHeader_(newSheet, fields);

    const templateIdx = template.getIndex();
    const newIdx = newSheet.getIndex();
    const targetPos = newIdx > templateIdx ? templateIdx : templateIdx - 1;
    if (targetPos !== newIdx) {
      ss.setActiveSheet(newSheet);
      ss.moveActiveSheet(Math.max(1, targetPos));
    }
    flushSpreadsheet_();

    const payload = {
      header: { periodText: formatFxPeriod_(fields.startDate, fields.endDate), country: fields.country },
      records: [],
      blankRow: CONFIG.FX_MIN_DATA_ROW,
      cachedAt: Date.now(),
    };
    payload.ledger = buildFxLedgerObject_(ss, newSheet, payload.header, [], options);
    saveFxLedgerCache_(newSheet.getSheetId(), payload);
    scriptCache_().remove(CONFIG.CACHE_KEYS.FX_LEDGERS);

    return { ok: true, ledger: payload.ledger, ledgers: getFxLedgers_(false).ledgers };
  });
}

function updateFxLedger_(form) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const options = readFxOptions_(ss);
    const sheet = getFxLedgerSheet_(ss, form && form.ledgerId);
    const name = validateFxLedgerName_(form.name);
    const fields = validateFxLedgerFields_(form, options);

    const newSheetName = CONFIG.FX_PREFIX + name;
    if (newSheetName !== sheet.getName()) {
      const existing = ss.getSheetByName(newSheetName);
      if (existing && existing.getSheetId() !== sheet.getSheetId()) {
        throw new Error('已經有「' + newSheetName + '」工作表，請換一個名稱。');
      }
      sheet.setName(newSheetName);
    }
    writeFxLedgerHeader_(sheet, fields);
    flushSpreadsheet_();

    invalidateFxCaches_([sheet.getSheetId()]);
    const payload = loadFxLedgerFromSheet_(ss, sheet, options);
    return { ok: true, ledger: payload.ledger, ledgers: getFxLedgers_(false).ledgers };
  });
}

function setFxLedgerArchived_(form) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const sheet = getFxLedgerSheet_(ss, form && form.ledgerId);
    const archived = Boolean(form.archived);
    if (archived && !sheet.isSheetHidden()) sheet.hideSheet();
    if (!archived && sheet.isSheetHidden()) sheet.showSheet();
    flushSpreadsheet_();

    const options = readFxOptions_(ss);
    let payload = getFxLedgerCache_(sheet.getSheetId());
    if (payload && payload.header && Array.isArray(payload.records)) {
      payload.ledger = buildFxLedgerObject_(ss, sheet, payload.header, payload.records, options);
      saveFxLedgerCache_(sheet.getSheetId(), payload);
    } else {
      payload = loadFxLedgerFromSheet_(ss, sheet, options);
    }
    scriptCache_().remove(CONFIG.CACHE_KEYS.FX_LEDGERS);
    return { ok: true, ledger: payload.ledger, ledgers: getFxLedgers_(false).ledgers };
  });
}

function deleteFxLedger_(form) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const sheet = getFxLedgerSheet_(ss, form && form.ledgerId);
    const sheetName = sheet.getName();
    if (!isFxLedgerSheetName_(sheetName)) throw new Error('只能刪除國外交易記帳簿。');
    const name = fxLedgerNameOf_(sheetName);
    if (String(form.confirmName == null ? '' : form.confirmName) !== name) {
      throw new Error('輸入的名稱與帳簿名稱「' + name + '」不同，未刪除。');
    }
    const id = sheet.getSheetId();
    ss.deleteSheet(sheet);
    flushSpreadsheet_();

    try { scriptCache_().removeAll(fxCacheKeys_([id])); } catch (e) {}
    const result = getFxLedgers_(true);
    return { ok: true, deletedId: id, ledgers: result.ledgers };
  });
}
