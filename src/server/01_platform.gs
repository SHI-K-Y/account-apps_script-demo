/**
 * 平台層：所有 Google 服務（試算表、快取、指令碼屬性、鎖、時區）都從這裡取得。
 *
 * 其他模組不直接呼叫 SpreadsheetApp / CacheService / PropertiesService / LockService / Session，
 * 日後要更換儲存方式（例如改用別的資料庫或快取）時，只需要改這個檔案與各模組的「資料存取」函式。
 *
 * 這裡的暫存變數只在單次執行（一次請求）內有效；Apps Script 每次執行都會重新初始化全域變數。
 */
let spreadsheetMemo_ = null;
let spreadsheetIdMemo_ = null;
let scriptCacheMemo_ = null;
let scriptPropsMemo_ = null;
let documentLockDepth_ = 0;

// 全站固定時區（P11）：日期格式化、「今天」「本月」都用它，不再讀試算表或指令碼的時區設定
// （每次讀都是一次服務呼叫，而且會讓快取命中前就得先開試算表）。setup() 會檢查試算表時區是否一致。
const DEFAULT_TIME_ZONE_ = 'Asia/Taipei';
const DOCUMENT_LOCK_TIMEOUT_MS_ = 10000;

function scriptCache_() {
  const raw = scriptCacheMemo_ || (scriptCacheMemo_ = CacheService.getScriptCache());
  return cacheReadMemo_ ? memoizedCache_(raw, cacheReadMemo_) : raw;
}

/**
 * 同一次執行共用快取讀取（P12，batchRead 用）：fn 執行期間 scriptCache_() 回傳的快取會記住讀過的值
 * （包含「查過但沒有」），之後同一個鍵不再呼叫 CacheService；寫入、刪除照常送出並同步更新記住的值。
 */
let cacheReadMemo_ = null;
function withCacheReadMemo_(fn) {
  if (cacheReadMemo_) return fn();
  cacheReadMemo_ = Object.create(null);
  try { return fn(); } finally { cacheReadMemo_ = null; }
}

function memoizedCache_(raw, memo) {
  const known = function (k) { return Object.prototype.hasOwnProperty.call(memo, k); };
  return {
    get: function (k) {
      if (!known(k)) memo[k] = raw.get(k);
      return memo[k];
    },
    getAll: function (keys) {
      const miss = keys.filter(function (k) { return !known(k); });
      if (miss.length) {
        const got = raw.getAll(miss) || {};
        miss.forEach(function (k) { memo[k] = got[k] != null ? got[k] : null; });
      }
      const out = {};
      keys.forEach(function (k) { if (memo[k] != null) out[k] = memo[k]; });
      return out;
    },
    put: function (k, v, ttl) {
      const r = ttl === undefined ? raw.put(k, v) : raw.put(k, v, ttl);
      memo[k] = String(v);
      return r;
    },
    putAll: function (values, ttl) {
      const r = ttl === undefined ? raw.putAll(values) : raw.putAll(values, ttl);
      Object.keys(values).forEach(function (k) { memo[k] = String(values[k]); });
      return r;
    },
    remove: function (k) { memo[k] = null; return raw.remove(k); },
    removeAll: function (keys) { keys.forEach(function (k) { memo[k] = null; }); return raw.removeAll(keys); },
  };
}

function scriptProps_() {
  return scriptPropsMemo_ || (scriptPropsMemo_ = PropertiesService.getScriptProperties());
}

/**
 * 取得記帳用的試算表；同一次執行內只開啟一次。
 * 試算表 ID 先找 primeSpreadsheetId_ 給的（寫入時和其他快取一次 getAll 讀回）→ CacheService → 指令碼屬性（P10）。
 */
function getSpreadsheet_() {
  if (spreadsheetMemo_) return spreadsheetMemo_;

  let savedId = spreadsheetIdMemo_;
  if (!savedId) {
    try { savedId = scriptCache_().get(CONFIG.CACHE_KEYS.SPREADSHEET_ID); } catch (e) { savedId = null; }
  }
  if (!savedId) {
    savedId = scriptProps_().getProperty(CONFIG.PROP_KEYS.SPREADSHEET_ID);
    if (savedId) rememberSpreadsheetId_(savedId);
  }
  if (savedId) {
    spreadsheetMemo_ = SpreadsheetApp.openById(savedId);
    return spreadsheetMemo_;
  }

  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (!active) {
    throw new Error('找不到 Google Sheet。請先執行 setup()。');
  }
  spreadsheetMemo_ = active;
  return active;
}

/** 呼叫端已經從快取讀到試算表 ID 時先告訴這裡，getSpreadsheet_ 就不用再讀一次。 */
function primeSpreadsheetId_(id) {
  if (typeof id === 'string' && id) spreadsheetIdMemo_ = id;
}

/** 把試算表 ID 放進快取（setup() 與快取沒命中時）。 */
function rememberSpreadsheetId_(id) {
  spreadsheetIdMemo_ = id || null;
  try {
    if (id) scriptCache_().put(CONFIG.CACHE_KEYS.SPREADSHEET_ID, id, CONFIG.CACHE_TTL);
    else scriptCache_().remove(CONFIG.CACHE_KEYS.SPREADSHEET_ID);
  } catch (e) {}
}

function getActiveSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function flushSpreadsheet_() {
  SpreadsheetApp.flush();
}

/** 網頁應用程式的網址（載入失敗時的「重新載入」連結）；取不到時回傳空字串。 */
function webAppUrl_() {
  try { return ScriptApp.getService().getUrl() || ''; } catch (e) { return ''; }
}

/** 這次執行有沒有開過試算表（API 偵錯計時用來判斷是否整個命中快取）。 */
function spreadsheetOpened_() {
  return Boolean(spreadsheetMemo_);
}

/* ------------------------------ 時間觸發器（P11） ------------------------------
 * 安裝一律經過 installTimeTrigger_：先刪掉同一個處理函式的舊觸發器再建立，重跑 setup() 不會越裝越多。
 * 處理函式（公開名稱、不以底線結尾）開頭一定要先過 isTrustedTriggerCall_，其餘來源直接 return。
 */
function projectTriggers_() {
  return ScriptApp.getProjectTriggers();
}

/** 刪掉某個處理函式的所有觸發器，回傳刪掉幾個。 */
function removeTriggers_(handlerName) {
  let removed = 0;
  projectTriggers_().forEach(function (t) {
    if (t.getHandlerFunction() === handlerName) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  return removed;
}

/**
 * 安裝時間觸發器：configure(builder) 設定頻率（例如 b => b.everyHours(2)），回傳新觸發器的 ID。
 */
function installTimeTrigger_(handlerName, configure) {
  removeTriggers_(handlerName);
  const builder = configure(ScriptApp.newTrigger(handlerName).timeBased());
  return builder.create().getUniqueId();
}

/**
 * 觸發器處理函式的守門：只接受
 *   1. 本專案、而且就是這個處理函式的觸發器傳來的事件（triggerUid 要對得上，偽造的事件物件不算），或
 *   2. 擁有者本人直接執行（Apps Script 編輯器；沒有參數）。
 * google.script.run 從網頁呼叫時（帶任何參數、或不是擁有者）一律回傳 false。
 */
function isTrustedTriggerCall_(e, handlerName) {
  if (e !== undefined && e !== null) {
    if (typeof e !== 'object' || !e.triggerUid) return false;
    const uid = String(e.triggerUid);
    try {
      return projectTriggers_().some(function (t) {
        return String(t.getUniqueId()) === uid && t.getHandlerFunction() === handlerName;
      });
    } catch (err) {
      return false;
    }
  }
  return isOwnerSession_();
}

/**
 * 預算計算用的「今天」：固定以台北時間為準（不受試算表或指令碼時區設定影響）。
 * 回傳 { iso: '2026-11-14', month: '2026.11', day: 14 }。
 */
function budgetToday_() {
  const iso = Utilities.formatDate(new Date(), DEFAULT_TIME_ZONE_, 'yyyy-MM-dd');
  return { iso: iso, month: iso.slice(0, 4) + '.' + iso.slice(5, 7), day: Number(iso.slice(8, 10)) };
}

function getSettingsSheet_(ss) {
  const spreadsheet = ss || getSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(CONFIG.SETTINGS_SHEET);
  if (!sheet) {
    throw new Error(`找不到「${CONFIG.SETTINGS_SHEET}」工作表。`);
  }
  return sheet;
}

/** 對帳工作表（新舊名稱都接受）。 */
function getSettlementSheet_(ss) {
  const spreadsheet = ss || getSpreadsheet_();
  for (let i = 0; i < CONFIG.SETTLEMENT_SHEETS.length; i++) {
    const sheet = spreadsheet.getSheetByName(CONFIG.SETTLEMENT_SHEETS[i]);
    if (sheet) return sheet;
  }
  throw new Error('找不到「' + CONFIG.SETTLEMENT_SHEETS[0] + '」工作表。');
}

function validateMonthFormat_(month) {
  if (!CONFIG.MONTH_PATTERN.test(String(month || ''))) {
    throw new Error('月份格式錯誤，必須像 2026.10。');
  }
  const monthNumber = Number(String(month).slice(5, 7));
  if (monthNumber < 1 || monthNumber > 12) {
    throw new Error(`月份錯誤：${month}`);
  }
}

function getTargetSheet_(month) {
  validateMonthFormat_(month);
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(month);
  if (!sheet) {
    throw new Error(`找不到「${month}」工作表。`);
  }

  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(5, 7));
  const daysInMonth = new Date(year, monthNumber, 0).getDate();
  return { ss, sheet, year, monthNumber, daysInMonth };
}

/**
 * 在文件鎖內執行 fn，避免兩個請求同時寫入試算表。
 * 可巢狀呼叫：只有最外層會真的上鎖／解鎖（Apps Script 的鎖不會計數，
 * 內層若自行解鎖，外層剩下的寫入就會失去保護）。
 */
function withDocumentLock_(fn) {
  if (documentLockDepth_ > 0) {
    documentLockDepth_++;
    try {
      return fn();
    } finally {
      documentLockDepth_--;
    }
  }

  const lock = LockService.getDocumentLock();
  try {
    lock.waitLock(DOCUMENT_LOCK_TIMEOUT_MS_);
  } catch (e) {
    throw new Error('系統忙碌中（另一個操作尚未完成），請稍後再試一次。');
  }
  documentLockDepth_ = 1;
  try {
    return fn();
  } finally {
    documentLockDepth_ = 0;
    lock.releaseLock();
  }
}

/** 盡量取得文件鎖後執行 fn；拿不到鎖也照樣執行（用於不能失敗的輕量標記）。 */
function withDocumentLockIfAvailable_(fn, waitMs) {
  if (documentLockDepth_ > 0) return fn();
  let lock = null;
  try {
    lock = LockService.getDocumentLock();
    if (lock && !lock.tryLock(waitMs)) lock = null;
  } catch (e) {
    lock = null;
  }
  try {
    return fn();
  } finally {
    if (lock) {
      try { lock.releaseLock(); } catch (e) {}
    }
  }
}
