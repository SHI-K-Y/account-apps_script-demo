/**
 * 存取控制。
 *
 * 第一道防線是 Apps Script 網頁應用程式的部署設定（建議「具有存取權的使用者：只有我自己」）。
 * 這裡提供第二道、可自行開啟的檢查，用「指令碼屬性」設定（專案設定 → 指令碼屬性）：
 *
 *   ALLOWED_EMAILS   允許使用的 Google 帳號，逗號分隔。未設定＝不額外限制（維持原本行為）。
 *                    設定後，沒登入或不在名單內的人會看到「沒有存取權限」，也無法呼叫任何 API。
 *                    擁有者（部署這個網頁的人）永遠可以使用。
 *   API_TOKEN        外部 HTTP API（doPost）的完整權限權杖。未設定＝HTTP API 關閉。
 *   API_READ_TOKEN   外部 HTTP API 的唯讀權杖（只能呼叫不會修改試算表的操作）。
 */
const AUTH_PROP_KEYS_ = Object.freeze({
  ALLOWED_EMAILS: 'ALLOWED_EMAILS',
  API_TOKEN: 'API_TOKEN',
  API_READ_TOKEN: 'API_READ_TOKEN',
});
const AUTH_FAIL_CACHE_KEY_ = 'AUTH_FAIL_COUNT_V1';
const AUTH_FAIL_LIMIT_ = 10;
const AUTH_FAIL_WINDOW_SECONDS_ = 600;
const API_TOKEN_MIN_LENGTH_ = 16;

function normalizeEmail_(email) {
  return String(email == null ? '' : email).trim().toLowerCase();
}

function activeUserEmail_() {
  try { return normalizeEmail_(Session.getActiveUser().getEmail()); } catch (e) { return ''; }
}

function effectiveUserEmail_() {
  try { return normalizeEmail_(Session.getEffectiveUser().getEmail()); } catch (e) { return ''; }
}

function parseAllowedEmails_(raw) {
  return String(raw == null ? '' : raw).split(/[\s,;]+/).map(normalizeEmail_).filter(Boolean);
}

function readAllowedEmails_() {
  let raw = '';
  try { raw = scriptProps_().getProperty(AUTH_PROP_KEYS_.ALLOWED_EMAILS) || ''; } catch (e) { raw = ''; }
  return parseAllowedEmails_(raw);
}

/**
 * 目前的使用者能不能用這個網頁。未設定 ALLOWED_EMAILS 時一律允許。
 * @param allowedList  選用：已經讀好的允許名單（doGet 從 DOGET_CONFIG 快取拿，省一次讀指令碼屬性）；沒給就現在讀。
 *                     API 呼叫（assertAuthorized_）一律現讀，名單改了立即生效。
 */
function isAuthorizedUser_(allowedList) {
  const allowed = Array.isArray(allowedList) ? allowedList : readAllowedEmails_();
  if (!allowed.length) return true;
  const email = activeUserEmail_();
  if (!email) return false;
  // 先比對名單（不用再呼叫 Session）；名單外才看是不是擁有者本人
  return allowed.indexOf(email) !== -1 || email === effectiveUserEmail_();
}

function assertAuthorized_() {
  if (!isAuthorizedUser_()) {
    throw new Error('沒有存取權限：這個帳號不在允許名單內。');
  }
}

/**
 * 管理用函式（setup、setupAppIcon、rebuildAllSummaries…）的保護：
 * 只有擁有者本人可以執行。從 Apps Script 編輯器執行時，目前使用者就是擁有者。
 */
function assertOwner_() {
  if (!isOwnerSession_()) {
    throw new Error('這個功能只能由試算表擁有者從 Apps Script 編輯器執行。');
  }
}

/** 目前執行的人是不是擁有者本人（目前使用者＝部署者）。 */
function isOwnerSession_() {
  const active = activeUserEmail_();
  const owner = effectiveUserEmail_();
  return Boolean(active && owner && active === owner);
}

/** 固定時間的字串比較，避免從回應時間推測權杖內容。 */
function constantTimeEquals_(a, b) {
  const x = String(a);
  const y = String(b);
  let diff = x.length ^ y.length;
  const len = Math.max(x.length, y.length);
  for (let i = 0; i < len; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function readAuthFailCount_() {
  try { return Number(scriptCache_().get(AUTH_FAIL_CACHE_KEY_)) || 0; } catch (e) { return 0; }
}

function recordAuthFailure_() {
  try { scriptCache_().put(AUTH_FAIL_CACHE_KEY_, String(readAuthFailCount_() + 1), AUTH_FAIL_WINDOW_SECONDS_); } catch (e) {}
}

/**
 * 驗證外部 HTTP API 的權杖，回傳 'write'（完整權限）或 'read'（唯讀）。
 * 權杖錯誤太多次會暫時鎖定，降低被暴力猜測的機會。
 */
function resolveApiTokenScope_(token) {
  const props = scriptProps_();
  const writeToken = String(props.getProperty(AUTH_PROP_KEYS_.API_TOKEN) || '').trim();
  const readToken = String(props.getProperty(AUTH_PROP_KEYS_.API_READ_TOKEN) || '').trim();
  if (!writeToken && !readToken) throw new Error('HTTP API 尚未啟用。');

  if (readAuthFailCount_() >= AUTH_FAIL_LIMIT_) {
    throw new Error('驗證失敗次數過多，請稍後再試。');
  }

  const given = String(token == null ? '' : token).trim();
  const usable = function (t) { return t.length >= API_TOKEN_MIN_LENGTH_; };
  // 兩個權杖都比對完才判斷，避免比對時間洩漏是哪一種權杖。
  const isWrite = usable(writeToken) && constantTimeEquals_(given, writeToken);
  const isRead = usable(readToken) && constantTimeEquals_(given, readToken);
  if (isWrite) return 'write';
  if (isRead) return 'read';

  recordAuthFailure_();
  throw new Error('權杖錯誤。');
}
