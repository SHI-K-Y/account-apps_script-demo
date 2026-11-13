function getSettingsOptions_(forceRefresh) {
  const all = readAllOptionsData_(null, Boolean(forceRefresh));
  return Object.assign({}, all.raw, { metadata: all.metadata });
}

function readAllOptionsData_(ss, forceRefresh) {
  const cache = scriptCache_();
  if (!forceRefresh) {
    const cached = cache.get(CONFIG.CACHE_KEYS.OPTIONS_ALL);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
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
  try {
    const jsonStr = JSON.stringify(combined);
    cache.put(CONFIG.CACHE_KEYS.OPTIONS_ALL, jsonStr, CONFIG.CACHE_TTL);
    scriptProps_().setProperty(CONFIG.PROP_KEYS.OPTIONS_SNAPSHOT, jsonStr);
  } catch (e) {}

  return combined;
}

function readOptions_(ssOrSettings) {
  const cache = scriptCache_();
  const cached = cache.get(CONFIG.CACHE_KEYS.OPTIONS_ALL);
  if (cached) {
    try { return JSON.parse(cached).simple; } catch (e) {}
  }
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
