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
    createNewMonthSheet:    { handler: createNewMonthSheet_, write: true },
    searchRecords:          { handler: searchRecords_ },

    // 總覽與圖表
    getAssetOverview:       { handler: getAssetOverview_ },
    getOverviewCharts:      { handler: getOverviewCharts_ },

    // 對帳與信用卡對帳
    getSettlementData:      { handler: getSettlementData_, write: true },
    updateSettlementDate:   { handler: updateSettlementDate_, write: true },
    updateSettlementActual: { handler: updateSettlementActual_, form: true, write: true },
    clearSettlementActual:  { handler: clearSettlementActual_, write: true },
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
    savePaymentSettingsConfig: { handler: savePaymentSettingsConfig_, write: true },

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

/** 網頁前端的進入點（google.script.run.api）。 */
function api(request) {
  assertAuthorized_();
  return dispatchApi_(request);
}
