function getInitialData_(forceRefresh) {
  const isForce = Boolean(forceRefresh);
  const cache = scriptCache_();

  if (!isForce) {
    const cachedBoot = cache.get(CONFIG.CACHE_KEYS.BOOT_JSON);
    if (cachedBoot) {
      try {
        const parsed = JSON.parse(cachedBoot);
        const now = new Date();
        const tz = parsed.timeZone || scriptTimeZone_();
        const todayISO = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
        const currentMonth = Utilities.formatDate(now, tz, 'yyyy.MM');
        if (parsed.currentMonth === currentMonth && parsed.options && parsed.initialRecent) {
          parsed.todayISO = todayISO;
          parsed.fromFreshCache = true;
          return refreshBootBudget_(parsed);
        }
      } catch (e) {}
    }
  }

  const ss = getSpreadsheet_();
  const timeZone = spreadsheetTimeZone_(ss);
  const now = new Date();
  const todayISO = Utilities.formatDate(now, timeZone, 'yyyy-MM-dd');
  const currentMonth = Utilities.formatDate(now, timeZone, 'yyyy.MM');

  let months = getMonthsList_(ss, isForce);
  if (!isForce && !months.includes(currentMonth)) {
    months = getMonthsList_(ss, true);
  }

  if (!months.length) {
    throw new Error('找不到月份工作表，例如 2026.10。');
  }

  const selectedMonth = months.includes(currentMonth) ? currentMonth : months[0];
  const allOptions = readAllOptionsData_(ss, isForce);
  const monthData = getMonthData_(ss, selectedMonth, isForce);

  const initialRecent = buildRecentPayload_(selectedMonth, monthData, 8, 8);

  const payload = {
    todayISO,
    currentMonth,
    selectedMonth,
    timeZone,
    months,
    options: allOptions.simple,
    settingsOptions: allOptions.raw,
    settingsMetadata: allOptions.metadata,
    initialRecent,
    cachedAt: Date.now(),
    fromFreshCache: true,
  };

  saveBootSnapshot_(payload);
  return payload;
}

function saveBootSnapshot_(payload, options) {
  if (!payload) return;
  const snapshotOnly = Boolean(options && options.snapshotOnly);
  try {
    const jsonStr = JSON.stringify(payload);
    if (!snapshotOnly) {
      const cache = scriptCache_();
      try {
        cache.put(CONFIG.CACHE_KEYS.BOOT_JSON, jsonStr, CONFIG.CACHE_TTL);
      } catch (cacheErr) {
        cache.remove(CONFIG.CACHE_KEYS.BOOT_JSON);
      }
    }
    if (splitUtf8Chunks_(jsonStr, 8500).length === 1) {
      scriptProps_().setProperty(CONFIG.PROP_KEYS.BOOT_SNAPSHOT, jsonStr);
    } else {
      const compactPayload = Object.assign({}, payload, {
        initialRecent: payload.initialRecent ? {
          month: payload.initialRecent.month,
          expenses: (payload.initialRecent.expenses || []).slice(0, 8),
          incomes: (payload.initialRecent.incomes || []).slice(0, 8),
          dailyExpenses: payload.initialRecent.dailyExpenses || {},
          budget: payload.initialRecent.budget || null,
        } : null,
      });
      const compactStr = JSON.stringify(compactPayload);
      if (splitUtf8Chunks_(compactStr, 8800).length === 1) {
        scriptProps_().setProperty(CONFIG.PROP_KEYS.BOOT_SNAPSHOT, compactStr);
      }
    }
  } catch (e) {}
}

function syncBootSnapshotWithMonthData_(month, monthData) {
  try {
    const cache = scriptCache_();
    const props = scriptProps_();
    const rawStr = cache.get(CONFIG.CACHE_KEYS.BOOT_JSON) || props.getProperty(CONFIG.PROP_KEYS.BOOT_SNAPSHOT);
    if (!rawStr) return;

    const boot = JSON.parse(rawStr);
    if (boot && boot.selectedMonth === month) {
      boot.initialRecent = buildRecentPayload_(month, monthData, 8, 8);
      boot.cachedAt = Date.now();
      saveBootSnapshot_(boot);
    }
  } catch (e) {}
}

function getMonthsList_(ss, forceRefresh) {
  const cache = scriptCache_();
  if (!forceRefresh) {
    const cached = cache.get(CONFIG.CACHE_KEYS.MONTHS_LIST);
    if (cached) {
      try { return JSON.parse(cached); } catch (e) {}
    }
  }

  const spreadsheet = ss || getSpreadsheet_();
  const months = spreadsheet.getSheets()
    .map(sheet => sheet.getName())
    .filter(name => CONFIG.MONTH_PATTERN.test(name))
    .sort()
    .reverse();

  try {
    const jsonStr = JSON.stringify(months);
    cache.put(CONFIG.CACHE_KEYS.MONTHS_LIST, jsonStr, CONFIG.CACHE_TTL);
    scriptProps_().setProperty(CONFIG.PROP_KEYS.MONTHS_SNAPSHOT, jsonStr);
  } catch (e) {}

  return months;
}
