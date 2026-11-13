/* =============================================================================
 * Api — 前端呼叫後端的唯一出口
 * -----------------------------------------------------------------------------
 * 所有後端呼叫都經過這裡，再由「傳輸層」送出去。目前的傳輸層是 Apps Script 的
 * google.script.run，後端只開放一個函式 api({ action, args })（見 src/server/05_api.gs）。
 * 日後若把前端搬到別的地方，只要換掉 transport()，各頁面的程式都不用動。
 *
 * 兩種用法（擇一）：
 *   1. Promise：
 *        Api.call('getFullRecords', month, 'expense', false).then(render).catch(showServerError);
 *   2. 與 google.script.run 相同的鏈式寫法（既有程式沿用）：
 *        Api.server.withSuccessHandler(render).withFailureHandler(showServerError).getFullRecords(month, 'expense', false);
 *
 * 這一層統一處理：
 *   - 離線時，寫入類操作立刻回報失敗（不會讓畫面卡在等待）。
 *   - 讀取類操作遇到暫時性錯誤（網路不穩、Google 伺服器忙碌）自動重試一次。
 *   - 讀取類操作超過時限沒有回應就回報逾時（寫入類不設時限，避免「其實已寫入卻顯示失敗」）。
 *   - 把 Apps Script 的英文／技術性錯誤訊息換成看得懂的說法；原始訊息保留在 error.rawMessage。
 * ============================================================================= */
const Api = (function() {
  // 只讀取、不修改試算表的操作：可以安全地重試與設定逾時。
  const READ_ACTIONS = new Set([
    'getInitialData', 'getRecentRecords', 'getFullRecords', 'searchRecords',
    'getAssetOverview', 'getOverviewCharts', 'getSettingsOptions',
    'getFxLedgers', 'getFxLedgerData', 'getFxRates'
  ]);
  const READ_TIMEOUT_MS = 45000;
  const RETRY_DELAY_MS = 700;
  const TRANSIENT_RE = /NetworkError|HTTP 0|連線失敗|server error occurred|伺服器發生錯誤|Service (?:Spreadsheets|invoked)|timed out|暫時無法|系統忙碌中/i;

  let pending = 0;
  let pendingWrites = 0;

  function transport() {
    if (typeof google === 'undefined' || !google.script || !google.script.run) return null;
    return google.script.run;
  }

  function notifyActivity() {
    try {
      document.dispatchEvent(new CustomEvent('apiactivity', { detail: { pending: pending, pendingWrites: pendingWrites } }));
    } catch (e) {}
  }

  function isOffline() {
    try { return navigator.onLine === false; } catch (e) { return false; }
  }

  function friendlyMessage(raw, isRead) {
    const text = String(raw || '');
    if (/NetworkError|HTTP 0|連線失敗/i.test(text)) {
      return isRead ? '網路連線不穩，讀取失敗，請稍後再試一次。' : '網路連線不穩，這次操作可能沒有送出，請確認後再試一次。';
    }
    if (/Script function not found|找不到指令碼函式/i.test(text)) return '網頁與後端版本不一致，請重新整理頁面。';
    if (/Authorization is required|需要授權|PERMISSION_DENIED/i.test(text)) return '登入狀態已失效，請重新整理頁面並重新登入。';
    if (/server error occurred|伺服器發生錯誤/i.test(text)) return 'Google 伺服器暫時忙碌，請稍後再試一次。';
    if (/Exceeded maximum execution time|執行時間上限/i.test(text)) return '處理時間過長而中斷，請稍後再試一次。';
    return text.replace(/^(?:Exception|Error|ScriptError):\s*/, '') || '發生未知錯誤';
  }

  function toError(err, isRead) {
    const raw = err && err.message ? err.message : String(err || '');
    const out = new Error(friendlyMessage(raw, isRead));
    out.rawMessage = raw;
    out.transient = TRANSIENT_RE.test(raw);
    return out;
  }

  function send(action, args, onOk, onErr, attempt) {
    const isRead = READ_ACTIONS.has(action);
    const fail = function(err) {
      if (typeof onErr === 'function') onErr(err);
      else console.error('[Api] ' + action + ' 失敗：', err);
    };

    const run = transport();
    if (!run) {
      fail(toError('NetworkError: 找不到後端連線（google.script.run）', isRead));
      return;
    }
    if (!isRead && isOffline()) {
      const offline = new Error('目前沒有網路連線，資料尚未送出，請連上網路後再試一次。');
      offline.rawMessage = 'offline';
      offline.transient = true;
      fail(offline);
      return;
    }

    let settled = false;
    let timer = 0;
    const settle = function() {
      if (settled) return false;
      settled = true;
      if (timer) clearTimeout(timer);
      pending = Math.max(0, pending - 1);
      if (!isRead) pendingWrites = Math.max(0, pendingWrites - 1);
      notifyActivity();
      return true;
    };

    pending += 1;
    if (!isRead) pendingWrites += 1;
    notifyActivity();

    if (isRead) {
      timer = setTimeout(function() {
        if (!settle()) return;
        const timeout = new Error('讀取逾時，請檢查網路後再試一次。');
        timeout.rawMessage = 'timeout';
        timeout.transient = true;
        fail(timeout);
      }, READ_TIMEOUT_MS);
    }

    try {
      run
        .withSuccessHandler(function(result) {
          if (!settle()) return;
          if (typeof onOk === 'function') onOk(result);
        })
        .withFailureHandler(function(err) {
          if (!settle()) return;
          const error = toError(err, isRead);
          if (isRead && error.transient && !attempt) {
            setTimeout(function() { send(action, args, onOk, onErr, 1); }, RETRY_DELAY_MS);
            return;
          }
          fail(error);
        })
        .api({ action: action, args: args });
    } catch (e) {
      // 參數無法序列化等同步錯誤
      if (settle()) fail(toError(e, isRead));
    }
  }

  /** Promise 介面：Api.call('addExpense', form) */
  function call(action) {
    const args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function(resolve, reject) {
      send(action, args, resolve, reject, 0);
    });
  }

  /** 與 google.script.run 相同的鏈式介面，讓既有呼叫點只需要換掉開頭。 */
  function makeRunner(handlers) {
    return new Proxy({}, {
      get: function(_, prop) {
        if (prop === 'withSuccessHandler') return function(fn) { return makeRunner(Object.assign({}, handlers, { ok: fn })); };
        if (prop === 'withFailureHandler') return function(fn) { return makeRunner(Object.assign({}, handlers, { fail: fn })); };
        if (prop === 'withUserObject') return function(obj) { return makeRunner(Object.assign({}, handlers, { user: obj, hasUser: true })); };
        if (typeof prop !== 'string') return undefined;
        return function() {
          const args = Array.prototype.slice.call(arguments);
          const ok = handlers.ok;
          const failHandler = handlers.fail;
          send(
            prop,
            args,
            ok ? function(result) { return handlers.hasUser ? ok(result, handlers.user) : ok(result); } : null,
            failHandler ? function(err) { return handlers.hasUser ? failHandler(err, handlers.user) : failHandler(err); } : null,
            0
          );
        };
      }
    });
  }

  return {
    call: call,
    get server() { return makeRunner({}); },
    pending: function() { return pending; },
    pendingWrites: function() { return pendingWrites; },
    isReadAction: function(action) { return READ_ACTIONS.has(action); }
  };
})();
