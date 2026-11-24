function getSettingsOptions_(forceRefresh) {
  const all = readAllOptionsData_(null, Boolean(forceRefresh));
  return Object.assign({}, all.raw, { metadata: all.metadata });
}

function readAllOptionsData_(ss, forceRefresh) {
  if (!forceRefresh) {
    const got = cacheGetAllMixed_([CONFIG.CACHE_KEYS.OPTIONS_ALL], [CONFIG.CACHE_KEYS.OPTIONS_SIMPLE]);
    const cached = got.large[CONFIG.CACHE_KEYS.OPTIONS_ALL];
    if (cached) {
      // 舊版只存了 OPTIONS_ALL：補上記帳驗證用的簡易選項
      if (!got.plain[CONFIG.CACHE_KEYS.OPTIONS_SIMPLE] && cached.simple) saveSimpleOptionsCache_(cached.simple);
      return cached;
    }
  }

  const settings = getSettingsSheet_(ss);
  const actualLastRow = Math.max(2, Math.min(1000, settings.getLastRow()));
  const rowCount = Math.max(1, actualLastRow - 1);
  const readCols = Math.max(7, Math.min(14, settings.getMaxColumns()));
  const values = settings.getRange(2, 1, rowCount, readCols).getDisplayValues();

  const columnMap = {
    expenseItems: 1,
    incomeItems: 2,
    expenseCategories: 3,
    incomeCategories: 4,
    paymentMethods: 5,
  };

  const raw = {};
  const simple = {};

  Object.keys(columnMap).forEach(function (key) {
    const colIdx = columnMap[key];
    const rawItems = [];
    const seen = new Set();
    const simpleItems = [];

    for (let i = 0; i < values.length; i++) {
      const val = String(values[i][colIdx] || '').trim();
      if (val) {
        rawItems.push({ row: i + 2, value: val });
        if (!seen.has(val)) {
          seen.add(val);
          simpleItems.push(val);
        }
      }
    }
    raw[key] = rawItems;
    simple[key] = simpleItems;
  });

  const paidSeen = new Set();
  const paidCodes = [];
  for (let i = 0; i < values.length; i++) {
    const val = String(values[i][6] || '').trim();
    if (val && !paidSeen.has(val)) {
      paidSeen.add(val);
      paidCodes.push(val);
    }
  }
  simple.paidCodes = paidCodes;

  const fxOpts = readFxOptionColumns_(values);
  raw.fxItems = fxOpts.rawItems;
  raw.fxCountries = fxOpts.rawCountries;
  raw.fxCurrencies = fxOpts.rawCurrencies;
  simple.fxItems = fxOpts.items;
  simple.fxCountries = fxOpts.countries;
  simple.fxCurrencies = fxOpts.currencies;
  simple.fxCountryCurrency = fxOpts.countryCurrency;

  const metadata = getSettingsMetadata_(settings);

  const combined = { raw, simple, metadata };
  // 以前還會另存一份到指令碼屬性（OPTIONS_SNAPSHOT），但沒有任何地方讀它，只是多一次慢的寫入（P09 拿掉）。
  // 完整選項與簡易選項（記帳驗證用，P10）同一次 putAll 寫入。
  const simpleJson = JSON.stringify(simple);
  const plain = {};
  if (simpleJson.length < 90 * 1024) plain[CONFIG.CACHE_KEYS.OPTIONS_SIMPLE] = simpleJson;
  const large = {};
  large[CONFIG.CACHE_KEYS.OPTIONS_ALL] = combined;
  if (!cachePutAllMixed_(large, plain, CONFIG.CACHE_TTL)) {
    try { scriptCache_().remove(CONFIG.CACHE_KEYS.OPTIONS_SIMPLE); } catch (e) {}
  }

  return combined;
}

function saveSimpleOptionsCache_(simple) {
  try {
    const json = JSON.stringify(simple);
    if (json.length < 90 * 1024) scriptCache_().put(CONFIG.CACHE_KEYS.OPTIONS_SIMPLE, json, CONFIG.CACHE_TTL);
  } catch (e) {}
}

/** 簡易選項快取的字串 → 物件；格式不對時回傳 null（當作沒命中）。 */
function parseSimpleOptionsCache_(json) {
  if (typeof json !== 'string' || !json) return null;
  try {
    const simple = JSON.parse(json);
    return simple && Array.isArray(simple.expenseItems) && Array.isArray(simple.paymentMethods) ? simple : null;
  } catch (e) {
    return null;
  }
}

/**
 * 記帳驗證用的簡易選項（P10）：先讀小的 OPTIONS_SIMPLE（一般 JSON），不用每次解整份 OPTIONS_ALL（含 metadata 與圖片）。
 * @param ssOrSettings  試算表或設定工作表（快取沒命中時才用到）
 * @param simpleJson    選用：呼叫端已經一次 getAll 讀回的 OPTIONS_SIMPLE 字串（null 表示讀過但沒命中）
 */
function readOptions_(ssOrSettings, simpleJson) {
  const fromCache = parseSimpleOptionsCache_(simpleJson !== undefined ? simpleJson : (function () {
    try { return scriptCache_().get(CONFIG.CACHE_KEYS.OPTIONS_SIMPLE); } catch (e) { return null; }
  })());
  if (fromCache) return fromCache;
  const ss = (ssOrSettings && typeof ssOrSettings.getSheetByName === 'function')
    ? ssOrSettings
    : (ssOrSettings && typeof ssOrSettings.getParent === 'function' ? ssOrSettings.getParent() : null);
  return readAllOptionsData_(ss, false).simple;
}

function settingsColumnNumber_(categoryKey) {
  const col = SETTINGS_CATEGORY_COLUMNS_[categoryKey];
  if (!col) throw new Error('無效的設定類別：' + categoryKey);
  return col;
}

function stripEmoji_(text) {
  if (!text) return '';
  var str = String(text).trim();
  try {
    return str.replace(/[\u{1F300}-\u{1F9FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F1E6}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}]/gu, '').trim();
  } catch (e) {
    return str.replace(/[\uD83C-\uDBFF\uDC00-\uDFFF]+/g, '').trim();
  }
}
