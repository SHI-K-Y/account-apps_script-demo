/**
 * API 閘道：前端（或外部程式）呼叫後端的唯一入口。
 *
 *   google.script.run.api({ action: 'addExpense', args: [form] })
 *
 * - 只有列在 apiRoutes_() 的操作可以被呼叫；其餘後端函式名稱都以底線結尾，
 *   Apps Script 不允許從瀏覽器直接呼叫，縮小可被濫用的範圍。
 * - 每次呼叫都會先檢查存取權限（見 assertAuthorized_）。
 * - 成功時直接回傳結果；失敗時丟出 Error，前端會收到錯誤訊息。
 *
 * 新增一個後端功能的步驟：
 *   1. 在對應的模組寫一個以底線結尾的函式（例如 exportMonth_）。
 *   2. 在下方 apiRoutes_() 登記：exportMonth: { handler: exportMonth_ }。
 *   3. 前端呼叫 Api.call('exportMonth', …) 或 Api.server.…exportMonth(…)。
 */
const API_MAX_ARGS_ = 6;
let apiRoutesMemo_ = null;

/**
 * 路由表。
 *   handler  實際執行的函式
 *   form     true 表示第一個參數必須是物件（表單），閘道會先擋掉格式不對的請求
 *   write    true 表示會修改試算表（外部 HTTP API 可用來區分唯讀／可寫入的權杖）
 *
 * 記帳寫入（addExpense…batchMarkCreditCardPaid、addRecords，P10）：
 *   - 表單可帶 opId（8–80 個英數字、-、_）：同一個 opId 在 6 小時內重送只會寫入一次，回傳上次的結果（replayed: true）。
 *   - 回應預設是差量格式 { ok, op, type, month, row, record, dailyExpenses, budget, counts }；
 *     表單帶 full: true（或經由 HTTP API 而且沒帶 full: false）時是舊的完整格式 { ok, type, month, row, record, recent }。
 */
function apiRoutes_() {
  if (apiRoutesMemo_) return apiRoutesMemo_;
  apiRoutesMemo_ = Object.freeze({
    // 啟動與記帳
    getInitialData:         { handler: getInitialData_ },
    getRecentRecords:       { handler: getRecentRecords_ },
    getFullRecords:         { handler: getFullRecords_ },
    addExpense:             { handler: addExpense_, form: true, write: true },
    addIncome:              { handler: addIncome_, form: true, write: true },
    updateExpense:          { handler: updateExpense_, form: true, write: true },
    updateIncome:           { handler: updateIncome_, form: true, write: true },
    deleteExpense:          { handler: deleteExpense_, form: true, write: true },
    deleteIncome:           { handler: deleteIncome_, form: true, write: true },
    addRecords:             { handler: addRecords_, write: true },
    createNewMonthSheet:    { handler: createNewMonthSheet_, write: true },
    searchRecords:          { handler: searchRecords_ },

    // 總覽與圖表
    getAssetOverview:       { handler: getAssetOverview_ },
    getOverviewCharts:      { handler: getOverviewCharts_ },
    batchRead:              { handler: batchRead_ },

    // 對帳與信用卡對帳
    getSettlementData:      { handler: getSettlementData_, write: true },
    updateSettlementDate:   { handler: updateSettlementDate_, write: true },
    updateSettlementActual: { handler: updateSettlementActual_, form: true, write: true },
    clearSettlementActual:  { handler: clearSettlementActual_, write: true },
    getCreditCardRecords:   { handler: getCreditCardRecords_ },
    markCreditCardPaid:     { handler: markCreditCardPaid_, form: true, write: true },
    batchMarkCreditCardPaid: { handler: batchMarkCreditCardPaid_, form: true, write: true },

    // 選項設定
    getSettingsOptions:     { handler: getSettingsOptions_ },
    saveSettingsItemWithEmoji: { handler: saveSettingsItemWithEmoji_, write: true },
    deleteSettingsOption:   { handler: deleteSettingsOption_, write: true },
    deleteSettingsItemWithEmoji: { handler: deleteSettingsItemWithEmoji_, write: true },
    addSettingsOption:      { handler: addSettingsOption_, write: true },
    updateSettingsOption:   { handler: updateSettingsOption_, write: true },
    reorderSettingsOptions: { handler: reorderSettingsOptions_, write: true },
    saveQuickCombos:        { handler: saveQuickCombos_, write: true },
    saveMealSlots:          { handler: saveMealSlots_, form: true, write: true },
    saveRecordReminders:    { handler: saveRecordReminders_, form: true, write: true },
    savePaymentSettingsConfig: { handler: savePaymentSettingsConfig_, write: true },

    // 預算
    getBudgetSettings:      { handler: getBudgetSettings_ },
    saveBudgetSettings:     { handler: saveBudgetSettings_, form: true, write: true },
    deleteBudgetSettings:   { handler: deleteBudgetSettings_, write: true },

    // 國外交易帳簿
    getFxLedgers:           { handler: getFxLedgers_ },
    getFxLedgerData:        { handler: getFxLedgerData_ },
    getFxRates:             { handler: getFxRates_ },
    createFxLedger:         { handler: createFxLedger_, write: true },
    updateFxLedger:         { handler: updateFxLedger_, write: true },
    setFxLedgerArchived:    { handler: setFxLedgerArchived_, write: true },
    deleteFxLedger:         { handler: deleteFxLedger_, write: true },
    addFxRecord:            { handler: addFxRecord_, write: true },
    updateFxRecord:         { handler: updateFxRecord_, write: true },
    deleteFxRecord:         { handler: deleteFxRecord_, write: true },
  });
  return apiRoutesMemo_;
}

function isPlainObject_(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 解析並檢查請求，回傳 { action, route, args }。 */
function resolveApiRequest_(request) {
  if (!isPlainObject_(request)) throw new Error('請求格式錯誤，請重新整理頁面後再試一次。');

  const action = typeof request.action === 'string' ? request.action : '';
  const routes = apiRoutes_();
  if (!action || !Object.prototype.hasOwnProperty.call(routes, action)) {
    throw new Error('不支援的操作：' + String(request.action).slice(0, 60));
  }

  const args = request.args === undefined || request.args === null ? [] : request.args;
  if (!Array.isArray(args) || args.length > API_MAX_ARGS_) {
    throw new Error('請求參數格式錯誤。');
  }

  const route = routes[action];
  if (route.form && !isPlainObject_(args[0])) {
    throw new Error('資料格式錯誤，請重新整理頁面後再試一次。');
  }
  return { action: action, route: route, args: args };
}

/**
 * 批次讀取（P12）：batchRead([{ action, args }, …]) 在同一次執行裡依序做好幾個唯讀操作，
 * 每一項各自回傳 { ok: true, data } 或 { ok: false, error }（一項失敗不影響其他項）。
 * - 只接受 BATCH_READ_ACTIONS_（與前端 core/api.js 的 READ_ACTIONS 相同，不含 batchRead 本身），最多 BATCH_READ_MAX_ 項。
 * - 同一次執行共用試算表（getSpreadsheet_ 本來就只開一次）與快取讀取（withCacheReadMemo_）：
 *   已知會用到的快取鍵先一次 getAll 讀回（primeBatchReadCache_），各操作自己的 getAll 就直接命中，不再呼叫 CacheService。
 */
const BATCH_READ_ACTIONS_ = Object.freeze([
  'getInitialData', 'getRecentRecords', 'getFullRecords', 'searchRecords', 'getCreditCardRecords',
  'getAssetOverview', 'getOverviewCharts', 'getSettingsOptions',
  'getFxLedgers', 'getFxLedgerData', 'getFxRates', 'getBudgetSettings',
]);
const BATCH_READ_MAX_ = 8;

function batchRead_(requests) {
  if (!Array.isArray(requests) || !requests.length || requests.length > BATCH_READ_MAX_) {
    throw new Error('批次讀取的參數格式錯誤（1–' + BATCH_READ_MAX_ + ' 項）。');
  }
  return withCacheReadMemo_(function () {
    primeBatchReadCache_(requests);
    return requests.map(function (req) {
      const action = isPlainObject_(req) && typeof req.action === 'string' ? req.action : '';
      try {
        if (BATCH_READ_ACTIONS_.indexOf(action) === -1) {
          throw new Error('批次讀取不支援的操作：' + String(isPlainObject_(req) ? req.action : req).slice(0, 60));
        }
        const resolved = resolveApiRequest_(req);
        return { ok: true, data: resolved.route.handler.apply(null, resolved.args) };
      } catch (err) {
        console.error('[api] batchRead ' + action + ' 失敗：' + (err && err.stack ? err.stack : err));
        return { ok: false, error: String(err && err.message ? err.message : err) };
      }
    });
  });
}

/** 總覽、圖表、預算設定會用到的快取鍵（與各自的快取優先路徑相同）合成一次 getAll；其他操作照舊自己讀。 */
function primeBatchReadCache_(requests) {
  const K = CONFIG.CACHE_KEYS;
  const keys = [];
  const add = function (k) { if (keys.indexOf(k) === -1) keys.push(k); };
  const addMonthData = function (month) { add(K.MONTH_DATA_PREFIX + month); add(largeCacheChunkKey_(K.MONTH_DATA_PREFIX + month, 0)); };
  let today = null;
  const currentMonth = function () { return (today || (today = budgetToday_())).month; };
  requests.forEach(function (req) {
    if (!isPlainObject_(req)) return;
    const args = Array.isArray(req.args) ? req.args : [];
    if (req.action === 'getAssetOverview' && !args[0]) {
      add(K.OVERVIEW_PREFIX + currentMonth());
      add(K.MONTHS_LIST);
    } else if (req.action === 'getOverviewCharts' && !args[1] && /^\d{4}\.\d{2}$/.test(String(args[0]))) {
      add(K.CHARTS_PREFIX + args[0]);
      add(K.OPTIONS_SIMPLE);
      add(K.BUDGET_CONFIG);
      add(K.BUDGET_OPENING_PREFIX + args[0]);
      addMonthData(args[0]);
    } else if (req.action === 'getBudgetSettings' && !args[0]) {
      add(K.BUDGET_CONFIG);
      add(K.BUDGET_OPENING_PREFIX + currentMonth());
      addMonthData(currentMonth());
    }
  });
  if (keys.length < 2) return;
  try { scriptCache_().getAll(keys); } catch (e) {}
}

function dispatchApi_(request) {
  const resolved = resolveApiRequest_(request);
  try {
    return resolved.route.handler.apply(null, resolved.args);
  } catch (err) {
    // 留一份紀錄在 Apps Script 的「執行項目」，方便事後追查；訊息原樣回給前端顯示。
    console.error('[api] ' + resolved.action + ' 失敗：' + (err && err.stack ? err.stack : err));
    throw err;
  }
}

/**
 * 網頁前端的進入點（google.script.run.api）。
 * 偵錯計時（P11）：請求帶 timing: true 時（doGet 開了計時——網址 ?timing=1 或指令碼屬性 DEBUG_DOGET_TIMING=1——
 * 之後前端每個呼叫都會帶），在「執行項目」印出 [api-timing]：總耗時、權限檢查、處理函式耗時，
 * 以及這次有沒有開試算表（spreadsheet: false 表示整個命中快取）。
 */
function api(request) {
  const timing = isPlainObject_(request) && request.timing === true;
  if (!timing) {
    assertAuthorized_();
    return dispatchApi_(request);
  }
  const t0 = Date.now();
  assertAuthorized_();
  const t1 = Date.now();
  let ok = false;
  try {
    const out = dispatchApi_(request);
    ok = true;
    return out;
  } finally {
    const route = apiRoutes_()[request.action];
    console.log('[api-timing] ' + JSON.stringify({
      action: String(request.action).slice(0, 60),
      write: Boolean(route && route.write),
      totalMs: Date.now() - t0,
      authMs: t1 - t0,
      handlerMs: Date.now() - t1,
      spreadsheet: spreadsheetOpened_(),
      ok: ok,
    }));
  }
}
