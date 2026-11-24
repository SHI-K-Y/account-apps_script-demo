/**
 * 平台層：所有 Google 服務（試算表、快取、指令碼屬性、鎖、時區）都從這裡取得。
 *
 * 其他模組不直接呼叫 SpreadsheetApp / CacheService / PropertiesService / LockService / Session，
 * 日後要更換儲存方式（例如改用別的資料庫或快取）時，只需要改這個檔案與各模組的「資料存取」函式。
 *
 * 這裡的暫存變數只在單次執行（一次請求）內有效；Apps Script 每次執行都會重新初始化全域變數。
 */
let spreadsheetMemo_ = null;
let scriptCacheMemo_ = null;
let scriptPropsMemo_ = null;
let documentLockDepth_ = 0;

const DEFAULT_TIME_ZONE_ = 'Asia/Taipei';
const DOCUMENT_LOCK_TIMEOUT_MS_ = 10000;

function scriptCache_() {
  return scriptCacheMemo_ || (scriptCacheMemo_ = CacheService.getScriptCache());
}

function scriptProps_() {
  return scriptPropsMemo_ || (scriptPropsMemo_ = PropertiesService.getScriptProperties());
}

/** 取得記帳用的試算表；同一次執行內只開啟一次。 */
function getSpreadsheet_() {
  if (spreadsheetMemo_) return spreadsheetMemo_;

  const savedId = scriptProps_().getProperty(CONFIG.PROP_KEYS.SPREADSHEET_ID);
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

function scriptTimeZone_() {
  return Session.getScriptTimeZone() || DEFAULT_TIME_ZONE_;
}

/**
 * 預算計算用的「今天」：固定以台北時間為準（不受試算表或指令碼時區設定影響）。
 * 回傳 { iso: '2026-11-14', month: '2026.11', day: 14 }。
 */
function budgetToday_() {
  const iso = Utilities.formatDate(new Date(), DEFAULT_TIME_ZONE_, 'yyyy-MM-dd');
  return { iso: iso, month: iso.slice(0, 4) + '.' + iso.slice(5, 7), day: Number(iso.slice(8, 10)) };
}

function spreadsheetTimeZone_(ss) {
  return (ss && ss.getSpreadsheetTimeZone()) || scriptTimeZone_();
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
