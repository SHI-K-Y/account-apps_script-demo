/**
 * 啟動資料（BOOT_JSON）：doGet 內嵌在頁面裡、前端開機第一段就用它畫首屏。
 * 快取裡存的是精簡格式（P09）：initialRecent 只放整月的 fullExpenses／fullIncomes，前端自己取前 8 筆；
 * 對外的 getInitialData（google.script.run 與 HTTP API）由 expandBootPayload_ 補回 expenses／incomes，回傳格式不變。
 * 記帳寫入不再更新 BOOT_JSON（P10）：裡面的清單可能比較舊，讀出來時一律用月份明細快取（MONTH_DATA）蓋過，
 * 明細快取沒有時從工作表重讀。
 */
function getInitialData_(forceRefresh) {
  const isForce = Boolean(forceRefresh);

  if (!isForce) {
    // 啟動資料、（通常就是它要的）本月明細、預算設定與本月月初餘額一次 getAll 讀回（P11：預算不用再各讀一次）
    const today = budgetToday_();
    const K = CONFIG.CACHE_KEYS;
    const guessKey = K.MONTH_DATA_PREFIX + today.month;
    const openingKey = K.BUDGET_OPENING_PREFIX + today.month;
    const all = cacheGetAllMixed_([K.BOOT_JSON, guessKey], [K.BUDGET_CONFIG, openingKey]);
    const got = all.large;
    const parsed = got[K.BOOT_JSON];
    if (parsed) {
      try {
        const tz = parsed.timeZone || DEFAULT_TIME_ZONE_;
        const now = new Date();
        const todayISO = tz === DEFAULT_TIME_ZONE_ ? today.iso : Utilities.formatDate(now, tz, 'yyyy-MM-dd');
        const currentMonth = tz === DEFAULT_TIME_ZONE_ ? today.month : Utilities.formatDate(now, tz, 'yyyy.MM');
        if (parsed.currentMonth === currentMonth && parsed.options && parsed.initialRecent) {
          const recentMonth = parsed.initialRecent.month;
          let monthData = !recentMonth ? null
            : (K.MONTH_DATA_PREFIX + recentMonth === guessKey ? got[guessKey] : getCachedMonthData_(recentMonth));
          if (!monthData && recentMonth) {
            try { monthData = getMonthData_(null, recentMonth, true); } catch (e) { monthData = null; }
          }
          if (monthData) {
            parsed.todayISO = todayISO;
            parsed.fromFreshCache = true;
            const budgetCache = { configJson: all.plain[K.BUDGET_CONFIG], openingJson: all.plain[openingKey], openingMonth: today.month };
            return expandBootPayload_(refreshBootBudget_(parsed, monthData, budgetCache));
          }
        }
      } catch (e) {}
    }
  }

  const ss = getSpreadsheet_();
  const timeZone = DEFAULT_TIME_ZONE_;
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
      // 精簡版（P11）：最近紀錄只放前 8 筆、設定裡的卡片／銀行圖片拿掉（圖片動輒數 KB，放著幾乎一定超過 9 KB）。
      // 用快照開機時 doGet 一定會標成不是最新的，前端背景同步後圖片就補上。
      const compactPayload = Object.assign({}, payload, {
        settingsMetadata: stripMetadataImages_(payload.settingsMetadata),
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

/** 用最新的月份明細蓋過啟動資料裡的最近紀錄（就地修改並回傳 boot；不含預算）。 */
function overlayBootRecent_(boot, monthData) {
  const recent = boot && boot.initialRecent;
  if (!recent || !monthData) return boot;
  recent.fullExpenses = monthData.expenses || [];
  recent.fullIncomes = monthData.incomes || [];
  recent.dailyExpenses = monthData.dailyExpenses || {};
  delete recent.expenses;
  delete recent.incomes;
  return boot;
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
