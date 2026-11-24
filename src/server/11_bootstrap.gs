/**
 * 啟動資料（BOOT_JSON）：doGet 內嵌在頁面裡、前端開機第一段就用它畫首屏。
 * 快取裡存的是精簡格式（P09）：initialRecent 只放整月的 fullExpenses／fullIncomes，前端自己取前 8 筆；
 * 對外的 getInitialData（google.script.run 與 HTTP API）由 expandBootPayload_ 補回 expenses／incomes，回傳格式不變。
 */
function getInitialData_(forceRefresh) {
  const isForce = Boolean(forceRefresh);

  if (!isForce) {
    const parsed = cacheGetLarge_(CONFIG.CACHE_KEYS.BOOT_JSON);
    if (parsed) {
      try {
        const now = new Date();
        const tz = parsed.timeZone || scriptTimeZone_();
        const todayISO = Utilities.formatDate(now, tz, 'yyyy-MM-dd');
        const currentMonth = Utilities.formatDate(now, tz, 'yyyy.MM');
        if (parsed.currentMonth === currentMonth && parsed.options && parsed.initialRecent) {
          parsed.todayISO = todayISO;
          parsed.fromFreshCache = true;
          return expandBootPayload_(refreshBootBudget_(parsed));
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

  const payload = {
    todayISO,
    currentMonth,
    selectedMonth,
    timeZone,
    months,
    options: allOptions.simple,
    settingsOptions: allOptions.raw,
    settingsMetadata: allOptions.metadata,
    initialRecent: buildBootRecent_(selectedMonth, monthData),
    cachedAt: Date.now(),
    fromFreshCache: true,
  };

  saveBootSnapshot_(payload);
  return expandBootPayload_(payload);
}

/** 啟動資料裡的最近紀錄：只放整月（前端自己取前 8 筆），不再重複放一份前 8 筆。 */
function buildBootRecent_(month, monthData) {
  const recent = buildRecentPayload_(month, monthData, 0, 0);
  delete recent.expenses;
  delete recent.incomes;
  return recent;
}

/** 對外的 getInitialData 維持舊格式：initialRecent 補上前 8 筆的 expenses／incomes（不改動傳入的物件）。 */
function expandBootPayload_(boot) {
  const recent = boot && boot.initialRecent;
  if (!recent || (Array.isArray(recent.expenses) && Array.isArray(recent.incomes))) return boot;
  return Object.assign({}, boot, {
    initialRecent: Object.assign({}, recent, {
      expenses: Array.isArray(recent.expenses) ? recent.expenses : (recent.fullExpenses || []).slice(0, 8),
      incomes: Array.isArray(recent.incomes) ? recent.incomes : (recent.fullIncomes || []).slice(0, 8),
    }),
  });
}

/**
 * 存啟動資料：CacheService（大型值，可超過 100 KB）＋ PropertiesService 的備援快照（單值 9 KB，放不下就只放前 8 筆）。
 * options.snapshotOnly：只更新備援快照（快取裡沒有啟動資料時用，避免把舊快照當成最新的放回快取）。
 */
function saveBootSnapshot_(payload, options) {
  if (!payload) return;
  const snapshotOnly = Boolean(options && options.snapshotOnly);
  try {
    if (!snapshotOnly) cachePutLarge_(CONFIG.CACHE_KEYS.BOOT_JSON, payload, CONFIG.CACHE_TTL);
    const jsonStr = JSON.stringify(payload);
    if (splitUtf8Chunks_(jsonStr, 8500).length === 1) {
      scriptProps_().setProperty(CONFIG.PROP_KEYS.BOOT_SNAPSHOT, jsonStr);
    } else {
      const recent = payload.initialRecent;
      const compactPayload = Object.assign({}, payload, {
        initialRecent: recent ? {
          month: recent.month,
          expenses: (recent.expenses || recent.fullExpenses || []).slice(0, 8),
          incomes: (recent.incomes || recent.fullIncomes || []).slice(0, 8),
          dailyExpenses: recent.dailyExpenses || {},
          budget: recent.budget || null,
        } : null,
      });
      const compactStr = JSON.stringify(compactPayload);
      if (splitUtf8Chunks_(compactStr, 8800).length === 1) {
        scriptProps_().setProperty(CONFIG.PROP_KEYS.BOOT_SNAPSHOT, compactStr);
      }
    }
  } catch (e) {}
}

/** 讀出目前的啟動資料以便修改：{ boot, inCache }；快取沒有時退回備援快照。 */
function readBootForUpdate_() {
  const cached = cacheGetLarge_(CONFIG.CACHE_KEYS.BOOT_JSON);
  if (cached) return { boot: cached, inCache: true };
  try {
    const rawStr = scriptProps_().getProperty(CONFIG.PROP_KEYS.BOOT_SNAPSHOT);
    if (rawStr) return { boot: JSON.parse(rawStr), inCache: false };
  } catch (e) {}
  return { boot: null, inCache: false };
}

/** 記帳之後：把啟動資料的最近紀錄換成最新的月份明細並存回（快取裡的啟動資料因此一直是最新的）。 */
function syncBootSnapshotWithMonthData_(month, monthData) {
  try {
    const current = readBootForUpdate_();
    const boot = current.boot;
    if (boot && boot.selectedMonth === month) {
      boot.initialRecent = buildBootRecent_(month, monthData);
      boot.cachedAt = Date.now();
      saveBootSnapshot_(boot, { snapshotOnly: !current.inCache });
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
