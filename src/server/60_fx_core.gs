const FX_COL_ = Object.freeze({ DATE: 2, ITEM: 3, PAYMENT: 4, CURRENCY: 5, AMOUNT: 6, TWD: 7, NOTE: 8, RATE: 10 });
const FX_READ_COLS_ = 9;
const FX_HOME_CURRENCY_ = 'NTD';
const FX_NAME_MAX_LENGTH_ = 30;
const FX_INVALID_NAME_CHARS_ = /[\[\]\*\?\/\\:]/;
const FX_RATES_TTL_ = 1800;
const FX_RATE_MAX_ = 10000;
const FX_FORMULA_DATE_R1C1_ = '=IF(RC[1]="","", IF(RC="", TODAY(), RC))';
const FX_FORMULA_RATE_R1C1_ = '=IF(RC[-5]="","",IF(RC="",VLOOKUP(RC[-5],R4C13:R21C14,2,FALSE),RC))';

function readFxOptionColumns_(values) {
  const result = {
    rawItems: [], rawCountries: [], rawCurrencies: [],
    items: [], countries: [], currencies: [], countryCurrency: {},
  };
  const seenItem = new Set();
  const seenCountry = new Set();
  const seenCurrency = new Set();
  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const rowNum = i + 2;
    const country = String(row[11] || '').trim();
    const currency = String(row[12] || '').trim().toUpperCase();
    const item = String(row[13] || '').trim();

    if (country) {
      result.rawCountries.push({ row: rowNum, value: country, currency: currency });
      if (currency && !result.countryCurrency[country]) result.countryCurrency[country] = currency;
      if (!seenCountry.has(country) && currency !== FX_HOME_CURRENCY_ && country !== '台灣') {
        seenCountry.add(country);
        result.countries.push(country);
      }
    }
    if (currency) {
      result.rawCurrencies.push({ row: rowNum, value: currency });
      if (!seenCurrency.has(currency)) {
        seenCurrency.add(currency);
        result.currencies.push(currency);
      }
    }
    if (item) {
      result.rawItems.push({ row: rowNum, value: item });
      if (!seenItem.has(item)) {
        seenItem.add(item);
        result.items.push(item);
      }
    }
  }
  if (!seenCurrency.has(FX_HOME_CURRENCY_)) result.currencies.unshift(FX_HOME_CURRENCY_);
  return result;
}

function readFxOptions_(ss) {
  let options = readOptions_(ss);
  if (!options || !Array.isArray(options.fxItems) || !Array.isArray(options.fxCurrencies)) {
    options = readAllOptionsData_(ss, true).simple;
  }
  return options;
}

function fxTimeZone_(ss) {
  return spreadsheetTimeZone_(ss);
}

function isFxLedgerSheetName_(name) {
  const str = String(name || '');
  return str.indexOf(CONFIG.FX_PREFIX) === 0 && str !== CONFIG.FX_TEMPLATE_SHEET && str.length > CONFIG.FX_PREFIX.length;
}

function fxLedgerNameOf_(sheetName) {
  return String(sheetName || '').slice(CONFIG.FX_PREFIX.length);
}

function listFxLedgerSheets_(ss) {
  return ss.getSheets().filter(function (sheet) {
    return isFxLedgerSheetName_(sheet.getName());
  });
}

function getFxLedgerSheet_(ss, ledgerId) {
  const id = Number(ledgerId);
  if (!Number.isInteger(id)) throw new Error('無效的帳簿 ID。');
  const sheets = ss.getSheets();
  for (let i = 0; i < sheets.length; i++) {
    if (sheets[i].getSheetId() === id) {
      if (!isFxLedgerSheetName_(sheets[i].getName())) {
        throw new Error('這張工作表不是國外交易記帳簿。');
      }
      return sheets[i];
    }
  }
  throw new Error('找不到這本國外帳簿，可能已在試算表中刪除，請重新讀取。');
}

function readFxLedgerIds_() {
  try {
    const raw = scriptProps_().getProperty(CONFIG.PROP_KEYS.FX_LEDGER_IDS);
    const ids = raw ? JSON.parse(raw) : [];
    return Array.isArray(ids) ? ids : [];
  } catch (e) {
    return [];
  }
}

function saveFxLedgerIds_(ids) {
  try {
    const merged = Array.from(new Set((ids || []).map(Number).filter(Number.isInteger)));
    scriptProps_().setProperty(CONFIG.PROP_KEYS.FX_LEDGER_IDS, JSON.stringify(merged));
  } catch (e) {}
}

function fxCacheKeys_(ids) {
  const keys = [CONFIG.CACHE_KEYS.FX_LEDGERS];
  (ids || []).forEach(function (id) {
    keys.push(CONFIG.CACHE_KEYS.FX_LEDGER_PREFIX + id);
    keys.push(CONFIG.CACHE_KEYS.FX_RATES_PREFIX + id);
  });
  return keys;
}

function invalidateFxCaches_(ids) {
  try {
    const list = ids && ids.length ? ids : readFxLedgerIds_();
    const keys = [CONFIG.CACHE_KEYS.FX_LEDGERS];
    list.forEach(function (id) { keys.push(CONFIG.CACHE_KEYS.FX_LEDGER_PREFIX + id); });
    scriptCache_().removeAll(keys);
  } catch (e) {}
}

function getFxLedgerCache_(ledgerId) {
  try {
    const raw = scriptCache_().get(CONFIG.CACHE_KEYS.FX_LEDGER_PREFIX + ledgerId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveFxLedgerCache_(ledgerId, payload) {
  const key = CONFIG.CACHE_KEYS.FX_LEDGER_PREFIX + ledgerId;
  const cache = scriptCache_();
  try {
    const str = JSON.stringify(payload);
    if (fitsCacheValue_(str)) {
      cache.put(key, str, CONFIG.CACHE_TTL);
    } else {
      cache.remove(key);
    }
  } catch (e) {
    try { cache.remove(key); } catch (err) {}
  }
}

function fxPad2_(n) {
  return String(n).padStart(2, '0');
}

function normalizeFxIsoDate_(value) {
  const m = String(value == null ? '' : value).trim().match(/^(\d{4})[-\/.](\d{1,2})[-\/.](\d{1,2})$/);
  if (!m) return '';
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1900 || y > 2200 || mo < 1 || mo > 12 || d < 1) return '';
  if (d > new Date(y, mo, 0).getDate()) return '';
  return y + '-' + fxPad2_(mo) + '-' + fxPad2_(d);
}

function fxCellToIso_(value, tz) {
  if (value instanceof Date || Object.prototype.toString.call(value) === '[object Date]') {
    if (isNaN(value.getTime())) return '';
    return Utilities.formatDate(value, tz, 'yyyy-MM-dd');
  }
  return normalizeFxIsoDate_(value);
}

function fxIsoToSheetDate_(iso, tz) {
  return Utilities.parseDate(iso + ' 12:00:00', tz, 'yyyy-MM-dd HH:mm:ss');
}

function parseFxPeriod_(text) {
  const str = String(text == null ? '' : text).trim();
  const m = str.match(/(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})\s*(?:~|～|〜|至|－|—|–|\s-\s)\s*(\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})/);
  if (!m) return null;
  const startDate = normalizeFxIsoDate_(m[1]);
  const endDate = normalizeFxIsoDate_(m[2]);
  if (!startDate || !endDate || startDate > endDate) return null;
  return { startDate: startDate, endDate: endDate };
}

function formatFxPeriod_(startIso, endIso) {
  return startIso.replace(/-/g, '/') + '~' + endIso.replace(/-/g, '/');
}

function roundFx2_(num) {
  return Math.round((Number(num) || 0) * 100) / 100;
}


function readFxSheetRows_(sheet, tz) {
  const minRow = CONFIG.FX_MIN_DATA_ROW;
  const maxRow = Math.min(CONFIG.FX_MAX_DATA_ROW, sheet.getMaxRows());
  const rowCount = Math.max(0, maxRow - minRow + 1);
  const records = [];
  let blankRow = null;
  let lastDataRow = 0;
  if (!rowCount) return { records: records, blankRow: null, lastDataRow: 0 };

  const values = sheet.getRange(minRow, 2, rowCount, FX_READ_COLS_).getValues();
  for (let i = 0; i < values.length; i++) {
    const r = values[i];
    const rowNum = minRow + i;
    const item = cellToStr_(r[1]);
    const amountRaw = r[4];
    const hasAmount = amountRaw !== '' && amountRaw !== null && String(amountRaw).trim() !== '';
    if (!item && !hasAmount) {
      if (blankRow === null) blankRow = rowNum;
      continue;
    }
    lastDataRow = rowNum;
    const currency = cellToStr_(r[3]).toUpperCase();
    const amount = cleanAmount_(amountRaw);
    let rate = typeof r[8] === 'number' ? r[8] : cleanAmount_(r[8]);
    if (!Number.isFinite(rate) || rate <= 0) rate = currency === FX_HOME_CURRENCY_ ? 1 : 0;
    records.push({
      row: rowNum,
      date: fxCellToIso_(r[0], tz),
      item: item,
      payment: cellToStr_(r[2]),
      currency: currency,
      amount: amount,
      rate: rate,
      twd: roundFx2_(amount * rate),
      note: cellToStr_(r[6]),
    });
  }
  sortFxRecords_(records);
  return { records: records, blankRow: blankRow, lastDataRow: lastDataRow };
}

function sortFxRecords_(records) {
  records.sort(function (a, b) {
    const da = a.date || '';
    const db = b.date || '';
    if (da !== db) return da < db ? 1 : -1;
    return b.row - a.row;
  });
  return records;
}

function nextFxBlankRow_(records) {
  const used = new Set((records || []).map(function (r) { return Number(r.row); }));
  for (let row = CONFIG.FX_MIN_DATA_ROW; row <= CONFIG.FX_MAX_DATA_ROW; row++) {
    if (!used.has(row)) return row;
  }
  return null;
}

function readFxHeader_(sheet) {
  const display = sheet.getRange(1, 6, 1, 4).getDisplayValues()[0];
  return { periodText: String(display[0] || '').trim(), country: String(display[3] || '').trim() };
}

function fxMostUsedForeignCurrency_(records) {
  const counts = {};
  (records || []).forEach(function (r) {
    if (r.currency && r.currency !== FX_HOME_CURRENCY_) counts[r.currency] = (counts[r.currency] || 0) + 1;
  });
  let best = '';
  Object.keys(counts).forEach(function (c) { if (!best || counts[c] > counts[best]) best = c; });
  return best;
}

function buildFxLedgerObject_(ss, sheet, header, records, options) {
  const id = sheet.getSheetId();
  const sheetName = sheet.getName();
  const countryMap = (options && options.fxCountryCurrency) || {};
  const country = header.country || '';
  let currency = country ? (countryMap[country] || '') : FX_HOME_CURRENCY_;
  if (!currency) currency = fxMostUsedForeignCurrency_(records) || FX_HOME_CURRENCY_;

  let totalTwd = 0;
  let lastDate = '';
  let minDate = '';
  (records || []).forEach(function (r) {
    totalTwd += Number(r.twd) || 0;
    if (r.date) {
      if (!lastDate || r.date > lastDate) lastDate = r.date;
      if (!minDate || r.date < minDate) minDate = r.date;
    }
  });

  const period = parseFxPeriod_(header.periodText);
  const ledger = {
    id: id,
    sheetName: sheetName,
    name: fxLedgerNameOf_(sheetName),
    country: country,
    currency: currency,
    startDate: period ? period.startDate : minDate,
    endDate: period ? period.endDate : lastDate,
    archived: sheet.isSheetHidden(),
    totalTwd: roundFx2_(totalTwd),
    count: (records || []).length,
    lastDate: lastDate,
    sheetUrl: ss.getUrl() + '#gid=' + id,
  };
  if (!period) ledger.periodMissing = true;
  return ledger;
}

function loadFxLedgerFromSheet_(ss, sheet, options) {
  const tz = fxTimeZone_(ss);
  const header = readFxHeader_(sheet);
  const parsed = readFxSheetRows_(sheet, tz);
  const payload = {
    header: header,
    ledger: buildFxLedgerObject_(ss, sheet, header, parsed.records, options),
    records: parsed.records,
    blankRow: parsed.blankRow,
    cachedAt: Date.now(),
  };
  saveFxLedgerCache_(sheet.getSheetId(), payload);
  return payload;
}

function refreshFxLedgerCacheAfterWrite_(ss, sheet, payload, options) {
  payload.ledger = buildFxLedgerObject_(ss, sheet, payload.header, payload.records, options);
  payload.blankRow = nextFxBlankRow_(payload.records);
  payload.cachedAt = Date.now();
  saveFxLedgerCache_(sheet.getSheetId(), payload);
  try { scriptCache_().remove(CONFIG.CACHE_KEYS.FX_LEDGERS); } catch (e) {}
  return payload;
}

function readFxRatesFromSheet_(sheet) {
  const values = sheet.getRange(4, 12, 18, 3).getValues();
  const rates = [];
  const seen = new Set();
  values.forEach(function (r) {
    const currency = String(r[1] == null ? '' : r[1]).trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(currency) || seen.has(currency)) return;
    seen.add(currency);
    const num = r[2];
    const rate = (typeof num === 'number' && Number.isFinite(num) && num > 0) ? num : null;
    rates.push({ country: String(r[0] == null ? '' : r[0]).trim(), currency: currency, rate: currency === FX_HOME_CURRENCY_ ? 1 : rate });
  });
  return rates;
}

function getFxRatesFromSheet_(ss, sheet) {
  let rates = readFxRatesFromSheet_(sheet);
  if (!rates.length) {
    const template = ss.getSheetByName(CONFIG.FX_TEMPLATE_SHEET);
    if (template) rates = readFxRatesFromSheet_(template);
  }
  const result = { rates: rates, fetchedAt: Date.now() };
  try {
    scriptCache_().put(CONFIG.CACHE_KEYS.FX_RATES_PREFIX + sheet.getSheetId(), JSON.stringify(result), FX_RATES_TTL_);
  } catch (e) {}
  return result;
}

function getCachedFxRates_(ledgerId) {
  try {
    const raw = scriptCache_().get(CONFIG.CACHE_KEYS.FX_RATES_PREFIX + ledgerId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}
