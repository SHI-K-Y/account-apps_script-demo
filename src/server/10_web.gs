/**
 * 網頁進入點與管理用函式。
 *   doGet   回傳記帳網頁
 *   doPost  選用的 HTTP JSON API（設定 API_TOKEN 後才啟用，見 04_auth.gs）
 *   onEdit  有人直接在試算表上編輯時，清掉後端快取
 *   setup / setupAppIcon / rebuildAllSummaries  從 Apps Script 編輯器手動執行的管理工具
 */
const APP_TITLE_ = '我的記帳';
const INCLUDABLE_FILES_ = Object.freeze(['style', 'app', 'assets']);

/**
 * 回傳記帳網頁（P09）：所有需要的快取（啟動資料、本月明細、預算設定、月初餘額、doGet 設定）用一次 getAll 讀齊，
 * 絕不開試算表——預算需要的快取沒命中時，啟動資料不帶 budget、標示 budgetPending，交給前端的背景同步補上。
 * 偵錯：網址加 ?timing=1，或指令碼屬性 DEBUG_DOGET_TIMING=1（執行 setup() 後生效），各階段耗時會印到「執行項目」的紀錄。
 */
function doGet(e) {
  const marks = { start: Date.now() };
  const snap = readDoGetSnapshot_();
  marks.cache = Date.now();
  const config = snap.config;
  const timing = Boolean(config.debugTiming) || Boolean(e && e.parameter && e.parameter.timing === '1');
  if (timing) console.time('doGet');

  if (!isAuthorizedUser_(config.allowedEmails)) return buildAccessDeniedPage_();
  marks.auth = Date.now();

  const template = HtmlService.createTemplateFromFile('Index');
  template.initialDataJson = buildDoGetBootJson_(snap);
  template.execUrl = config.execUrl || '#';
  marks.boot = Date.now();
  const output = template
    .evaluate()
    .setTitle(APP_TITLE_)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
  marks.template = Date.now();

  // 指令碼屬性的備援快照（快取全空時用）不在記帳寫入時更新（P10），改在這裡低頻更新
  if (snap.snapshotDue) refreshBootSnapshotFromDoGet_(snap);
  marks.snapshot = Date.now();

  if (config.iconUrl) {
    try {
      output.setFaviconUrl(config.iconUrl);
    } catch (err) {
      console.warn('setFaviconUrl 失敗，已略過：' + err);
    }
  }

  if (timing) {
    console.timeEnd('doGet');
    console.log('[doGet] ' + JSON.stringify({
      totalMs: Date.now() - marks.start,
      cacheMs: marks.cache - marks.start,
      authMs: marks.auth - marks.cache,
      bootMs: marks.boot - marks.auth,
      templateMs: marks.template - marks.boot,
      snapshotMs: marks.snapshot - marks.template,
      bootHit: Boolean(snap.boot),
      monthHit: Boolean(snap.monthData),
      configHit: snap.configHit,
      budgetPending: snap.budgetPending,
      bootBytes: snap.bootBytes,
      template: typeof BUILD_TEMPLATE_MODE_ === 'string' ? BUILD_TEMPLATE_MODE_ : 'include',
    }));
  }
  return output;
}

/** doGet 需要的所有快取，一次 getAll 讀回。DOGET_CONFIG 沒命中時從指令碼屬性重建（不碰試算表）。 */
function readDoGetSnapshot_() {
  const today = budgetToday_();
  const K = CONFIG.CACHE_KEYS;
  const monthKey = K.MONTH_DATA_PREFIX + today.month;
  const openingKey = K.BUDGET_OPENING_PREFIX + today.month;
  const got = cacheGetAllMixed_([K.BOOT_JSON, monthKey], [K.DOGET_CONFIG, K.BUDGET_CONFIG, openingKey, K.BOOT_SNAPSHOT_STAMP]);

  let config = null;
  try { config = got.plain[K.DOGET_CONFIG] ? JSON.parse(got.plain[K.DOGET_CONFIG]) : null; } catch (e) { config = null; }
  const configHit = Boolean(config && Array.isArray(config.allowedEmails));
  if (!configHit) config = refreshDoGetConfig_();

  return {
    today: today,
    config: config,
    configHit: configHit,
    boot: got.large[K.BOOT_JSON],
    monthData: got.large[monthKey],
    budgetConfigJson: got.plain[K.BUDGET_CONFIG],
    openingJson: got.plain[openingKey],
    snapshotStamp: Number(got.plain[K.BOOT_SNAPSHOT_STAMP]) || 0,
    snapshotDue: false,
    bootForSnapshot: null,
    budgetPending: false,
    bootBytes: 0,
  };
}

/**
 * 把這次 doGet 組好的最新啟動資料寫進指令碼屬性的備援快照（P10）：只有快取命中、清單已用最新明細蓋過時才寫，
 * 而且距離上次超過 CONFIG.BOOT_SNAPSHOT_INTERVAL_MS（上次的時間記在快取裡，和其他快取同一次 getAll 讀回）。
 */
function refreshBootSnapshotFromDoGet_(snap) {
  try {
    saveBootSnapshot_(snap.bootForSnapshot, { snapshotOnly: true });
    scriptCache_().put(CONFIG.CACHE_KEYS.BOOT_SNAPSHOT_STAMP, String(Date.now()), CONFIG.CACHE_TTL);
  } catch (e) {}
}

/** doGet 用的設定：允許名單、App 圖示網址、網頁網址、偵錯旗標。setup()、setupAppIcon() 與快取沒命中時更新。 */
function readDoGetConfigFromProps_() {
  const config = { allowedEmails: [], iconUrl: '', execUrl: '', debugTiming: false };
  try {
    const props = scriptProps_();
    config.allowedEmails = parseAllowedEmails_(props.getProperty(AUTH_PROP_KEYS_.ALLOWED_EMAILS));
    config.iconUrl = props.getProperty('APP_ICON_URL') || '';
    config.debugTiming = /^(1|true|on|yes)$/i.test(String(props.getProperty('DEBUG_DOGET_TIMING') || '').trim());
  } catch (e) {}
  config.execUrl = webAppUrl_();
  return config;
}

function refreshDoGetConfig_() {
  const config = readDoGetConfigFromProps_();
  try {
    scriptCache_().put(CONFIG.CACHE_KEYS.DOGET_CONFIG, JSON.stringify(config), CONFIG.DOGET_CONFIG_TTL);
  } catch (e) {}
  return config;
}

/**
 * 組出內嵌在頁面裡的啟動資料（精簡格式，見 11_bootstrap.gs）。
 *   fromFreshCache  快取命中、而且是這個月的資料：前端不用再背景同步
 *   budgetPending   預算算不出來（預算快取沒命中）：沒有 budget，前端要背景同步
 * 記帳寫入不更新 BOOT_JSON（P10）：清單一律用本月明細快取蓋過；蓋不了（明細快取沒命中、或啟動資料不是本月）時
 * 清單可能比較舊，標成不是最新的，讓前端背景同步。
 */
function buildDoGetBootJson_(snap) {
  let boot = snap.boot;
  let fresh = Boolean(boot);
  if (!boot) {
    try {
      const snapshotStr = scriptProps_().getProperty(CONFIG.PROP_KEYS.BOOT_SNAPSHOT);
      boot = snapshotStr ? JSON.parse(snapshotStr) : null;
    } catch (e) { boot = null; }
  }
  if (!boot) return 'null';

  try {
    const tz = boot.timeZone || DEFAULT_TIME_ZONE_;
    const nowMonth = tz === DEFAULT_TIME_ZONE_ ? snap.today.month : Utilities.formatDate(new Date(), tz, 'yyyy.MM');
    if (boot.currentMonth !== nowMonth) fresh = false;

    const recent = boot.initialRecent;
    if (recent && recent.month) {
      const monthData = recent.month === snap.today.month && snap.monthData ? snap.monthData : null;
      if (monthData) overlayBootRecent_(boot, monthData);
      else fresh = false;
      const lists = Array.isArray(recent.fullExpenses)
        ? { expenses: recent.fullExpenses, incomes: recent.fullIncomes || [] }
        : null;
      const result = lists ? budgetStatusFromCache_(recent.month, lists, snap.budgetConfigJson, snap.openingJson, snap.today.month) : null;
      // 算不出來時不沿用啟動資料裡存的 budget：即使是今天算的，之前月份有異動（月初餘額快取被清掉）也可能已經過時。
      // 只有精簡快照（沒有整月明細，本來就會背景同步）才沿用今天算的那份。
      if (result) {
        recent.budget = result.status;
      } else if (lists || !(recent.budget && recent.budget.todayISO === snap.today.iso)) {
        delete recent.budget;
        snap.budgetPending = true;
      }
    }
  } catch (e) {
    fresh = false;
  }

  boot.fromFreshCache = fresh;
  if (snap.budgetPending) boot.budgetPending = true;
  else delete boot.budgetPending;
  if (fresh && snap.boot && Date.now() - snap.snapshotStamp >= CONFIG.BOOT_SNAPSHOT_INTERVAL_MS) {
    snap.snapshotDue = true;
    snap.bootForSnapshot = boot;
  }
  const json = sanitizeJsonForScriptTag_(JSON.stringify(boot));
  snap.bootBytes = json.length;
  return json;
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

  // 記帳寫入的回應：HTTP API 預設維持舊的完整格式（iOS 捷徑等既有呼叫端不用改，見 wantsFullResponse_）
  httpApiFullResponse_ = true;
  try {
    return { ok: true, data: dispatchApi_({ action: request.action, args: request.args }) };
  } finally {
    httpApiFullResponse_ = false;
  }
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
  refreshDoGetConfig_();
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
  rememberSpreadsheetId_(ss.getId());
  refreshDoGetConfig_();

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
