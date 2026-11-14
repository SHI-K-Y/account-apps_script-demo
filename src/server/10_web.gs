/**
 * 網頁進入點與管理用函式。
 *   doGet   回傳記帳網頁
 *   doPost  選用的 HTTP JSON API（設定 API_TOKEN 後才啟用，見 04_auth.gs）
 *   onEdit  有人直接在試算表上編輯時，清掉後端快取
 *   setup / setupAppIcon / rebuildAllSummaries  從 Apps Script 編輯器手動執行的管理工具
 */
const APP_TITLE_ = '我的記帳';
const INCLUDABLE_FILES_ = Object.freeze(['style', 'app', 'assets']);

function doGet() {
  if (!isAuthorizedUser_()) return buildAccessDeniedPage_();

  const template = HtmlService.createTemplateFromFile('Index');
  template.initialDataJson = getBootstrapJsonForDoGet_();
  const output = template
    .evaluate()
    .setTitle(APP_TITLE_)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);

  try {
    const iconUrl = scriptProps_().getProperty('APP_ICON_URL');
    if (iconUrl) output.setFaviconUrl(iconUrl);
  } catch (e) {
    console.warn('setFaviconUrl 失敗，已略過：' + e);
  }
  return output;
}

function buildAccessDeniedPage_() {
  const html = '<!DOCTYPE html><html lang="zh-Hant"><head><meta charset="UTF-8"><base target="_top">' +
    '<style>html{background:#faf6ef;color:#1c1c1e;font:16px/1.6 system-ui,"PingFang TC","Noto Sans TC",sans-serif}' +
    '@media (prefers-color-scheme:dark){html{background:#000;color:#faf6ef}}' +
    'main{max-width:22em;margin:22vh auto 0;padding:0 24px;text-align:center}h1{font-size:20px;margin:0 0 8px}p{margin:0;opacity:.75}</style></head>' +
    '<body><main><h1>沒有存取權限</h1><p>這個記帳簿只開放給指定的 Google 帳號。請確認已登入正確的帳號後再重新開啟。</p></main></body></html>';
  return HtmlService.createHtmlOutput(html)
    .setTitle(APP_TITLE_)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 選用的 HTTP JSON API，讓網頁以外的程式（捷徑、自動化腳本、未來獨立的前端）也能記帳。
 * 預設關閉；在指令碼屬性設定 API_TOKEN（至少 16 個字元）後啟用。
 *
 *   POST <網頁應用程式網址>
 *   Content-Type: text/plain 或 application/json
 *   { "token": "…", "action": "addExpense", "args": [ { "month": "2026.11", "day": 13, … } ] }
 *
 * 回應固定是 JSON：{ "ok": true, "data": … } 或 { "ok": false, "error": "…" }。
 */
function doPost(e) {
  let payload;
  try {
    payload = handleHttpApiRequest_(e);
  } catch (err) {
    payload = { ok: false, error: err && err.message ? err.message : String(err) };
  }
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function handleHttpApiRequest_(e) {
  const body = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
  if (!body || body.length > 200000) throw new Error('請求內容格式錯誤。');
  let request;
  try {
    request = JSON.parse(body);
  } catch (err) {
    throw new Error('請求內容必須是 JSON。');
  }
  if (!isPlainObject_(request)) throw new Error('請求內容必須是 JSON 物件。');

  const scope = resolveApiTokenScope_(request.token);
  const resolved = resolveApiRequest_({ action: request.action, args: request.args });
  if (resolved.route.write && scope !== 'write') throw new Error('這個權杖只能讀取資料。');

  return { ok: true, data: dispatchApi_({ action: request.action, args: request.args }) };
}

function setupAppIcon() {
  assertOwner_();
  const dataUri = getAppIconDataUri_();
  if (!dataUri) {
    throw new Error('assets.html 的 APP_ICON_BASE64 尚未設定或格式不正確（請確認是完整的 Base64，單行、單引號）。');
  }
  const m = dataUri.match(/^data:(image\/[\w+.-]+);base64,(.+)$/);
  const mime = m[1];
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/x-icon': 'ico' }[mime] || 'png';
  const bytes = Utilities.base64Decode(m[2]);

  if (mime === 'image/png') {
    const tail = String.fromCharCode.apply(null, bytes.slice(-8, -4).map(function(b) { return b & 0xff; }));
    if (tail !== 'IEND') {
      throw new Error('PNG 資料不完整（缺少結尾 IEND），Base64 可能在複製時被截斷，請重新轉換並完整貼上。');
    }
  }

  const props = scriptProps_();
  const oldId = props.getProperty('APP_ICON_FILE_ID');
  if (oldId) {
    try { DriveApp.getFileById(oldId).setTrashed(true); } catch (e) {  }
  }

  const file = DriveApp.createFile(Utilities.newBlob(bytes, mime, '記帳簿-app-icon.' + ext));
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  const url = 'https://lh3.googleusercontent.com/d/' + file.getId() + '#.' + ext;

  props.setProperty('APP_ICON_FILE_ID', file.getId());
  props.setProperty('APP_ICON_URL', url);
  console.log('App Logo 已設定完成：' + url + '（大小 ' + bytes.length + ' bytes）');
  return url;
}

function getAppIconDataUri_() {
  const src = HtmlService.createHtmlOutputFromFile('assets').getContent();
  const m = src.match(/const\s+APP_ICON_BASE64\s*=\s*'([^']*)'/);
  const raw = m ? m[1].replace(/\s+/g, '') : '';
  if (!raw) return '';
  if (/^data:image\/[\w+.-]+;base64,[A-Za-z0-9+\/=]+$/.test(raw)) return raw;
  if (!/^[A-Za-z0-9+\/=]+$/.test(raw)) return '';
  const mime = raw.indexOf('iVBOR') === 0 ? 'image/png'
    : raw.indexOf('/9j/') === 0 ? 'image/jpeg'
    : raw.indexOf('UklGR') === 0 ? 'image/webp'
    : 'image/png';
  return 'data:' + mime + ';base64,' + raw;
}

/** Index.html 範本用來載入其他檔案（只允許固定的幾個檔名）。 */
function include(filename) {
  if (INCLUDABLE_FILES_.indexOf(filename) === -1) throw new Error('不允許載入的檔案：' + filename);
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function onEdit(e) {
  try {
    invalidateAllCaches_();
  } catch (err) {}

  try {
    const sheetName = e && e.range ? e.range.getSheet().getName() : '';
    if (CONFIG.MONTH_PATTERN.test(sheetName)) {
      // 即使月份清單快照不存在，也確保被編輯的那個月份一定會重新讀取。
      invalidateMonthCaches_(sheetName);
      markSummaryDirtyWithLock_([sheetName]);
    }
  } catch (err) {}

  try {
    const editedSheet = e && e.range ? e.range.getSheet() : null;
    if (editedSheet && editedSheet.getName().indexOf(CONFIG.FX_PREFIX) === 0) {
      invalidateFxCaches_([editedSheet.getSheetId()]);
    }
  } catch (err) {}
}

function getBootstrapJsonForDoGet_() {
  try {
    const cache = scriptCache_();
    const cachedStr = cache.get(CONFIG.CACHE_KEYS.BOOT_JSON);
    if (cachedStr) {
      const parsed = refreshBootBudget_(JSON.parse(cachedStr));
      parsed.fromFreshCache = true;
      return sanitizeJsonForScriptTag_(JSON.stringify(parsed));
    }

    const props = scriptProps_();
    const snapshotStr = props.getProperty(CONFIG.PROP_KEYS.BOOT_SNAPSHOT);
    if (snapshotStr) {
      const parsed = refreshBootBudget_(JSON.parse(snapshotStr));
      parsed.fromFreshCache = false;
      return sanitizeJsonForScriptTag_(JSON.stringify(parsed));
    }
  } catch (e) {}
  return 'null';
}

function sanitizeJsonForScriptTag_(jsonStr) {
  if (!jsonStr) return 'null';
  return String(jsonStr).replace(/</g, '\\u003c');
}

function setup() {
  assertOwner_();
  const ss = getActiveSpreadsheet_();
  if (!ss) {
    throw new Error('請先從你的 Google Sheet：擴充功能 → Apps Script 開啟此專案，再執行 setup()。');
  }

  const settings = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
  if (!settings) {
    throw new Error(`找不到「${CONFIG.SETTINGS_SHEET}」工作表。`);
  }

  const months = getMonthsList_(ss, true);
  if (!months.length) {
    throw new Error('找不到像 2026.10 這種格式的月份工作表。');
  }

  scriptProps_().setProperty(CONFIG.PROP_KEYS.SPREADSHEET_ID, ss.getId());

  try {
    getInitialData_(true);
  } catch (e) {}

  return {
    ok: true,
    spreadsheetName: ss.getName(),
    months,
    message: `設定完成，目前連結的試算表：${ss.getName()}`,
  };
}
