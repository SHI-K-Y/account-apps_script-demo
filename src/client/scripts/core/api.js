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
 *   - 記帳寫入（OP_ACTIONS）每次都帶一個 opId（P10）：後端用它去重，同一個 opId 只會寫入一次、重送時回傳上次的結果，
 *     所以這些寫入遇到暫時性錯誤也可以安全地自動重試一次。其他寫入照舊不重試。
 *   - 讀取類操作超過時限沒有回應就回報逾時（寫入類不設時限，避免「其實已寫入卻顯示失敗」）。
 *   - 把 Apps Script 的英文／技術性錯誤訊息換成看得懂的說法；原始訊息保留在 error.rawMessage。
 *   - 相同的讀取（同一個 action＋參數）正在進行中時合併成一次（P12）：後來的呼叫拿到同一份結果的複本。
 *   - 批次讀取（P12）：Api.batch([{ action, args }, …]) 用一次伺服器執行（後端 batchRead）讀好幾樣東西，
 *     回傳 Promise<[{ ok, data } | { ok: false, error }]>（順序同輸入）。只接受 READ_ACTIONS 裡的操作；
 *     其中已經在進行中的讀取直接沿用、不重送；只剩一項時改用一般呼叫；後端還沒有 batchRead（版本不一致）時逐項送出。
 * ============================================================================= */
const Api = (function() {
  // 只讀取、不修改試算表的操作：可以安全地重試與設定逾時。
  const READ_ACTIONS = new Set([
    'getInitialData', 'getRecentRecords', 'getFullRecords', 'searchRecords', 'getCreditCardRecords',
    'getAssetOverview', 'getOverviewCharts', 'getSettingsOptions',
    'getFxLedgers', 'getFxLedgerData', 'getFxRates', 'getBudgetSettings', 'getOpLog', 'getNetWorthHistory', 'batchRead'
  ]);
  // 後端支援 opId 去重的寫入（src/server/21_records.gs）：第一個參數是表單（addRecords 是表單陣列）
  const OP_ACTIONS = new Set([
    'addExpense', 'addIncome', 'updateExpense', 'updateIncome', 'deleteExpense', 'deleteIncome',
    'markCreditCardPaid', 'batchMarkCreditCardPaid', 'addRecords', 'undoRecordOp'
  ]);
  const READ_TIMEOUT_MS = 45000;
  const RETRY_DELAY_MS = 700;
  const TRANSIENT_RE = /NetworkError|HTTP 0|連線失敗|server error occurred|伺服器發生錯誤|Service (?:Spreadsheets|invoked)|timed out|暫時無法|系統忙碌中/i;

  let pending = 0;
  let pendingWrites = 0;
  let timingFlag = null;

  /** 偵錯計時（P11）：doGet 開了計時（?timing=1 或 DEBUG_DOGET_TIMING）時，每個呼叫都請後端印出耗時。 */
  function debugTiming() {
    if (timingFlag === null) {
      try { timingFlag = Boolean(window.__INITIAL_DATA__ && window.__INITIAL_DATA__.debugTiming); } catch (e) { timingFlag = false; }
    }
    return timingFlag;
  }

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

  function newOpId() {
    try {
      if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    } catch (e) {}
    let out = '';
    try {
      const bytes = new Uint8Array(16);
      crypto.getRandomValues(bytes);
      for (let i = 0; i < bytes.length; i++) out += (bytes[i] + 256).toString(16).slice(1);
      return out;
    } catch (e) {}
    for (let i = 0; i < 4; i++) out += Math.floor(Math.random() * 0x100000000).toString(16).padStart(8, '0');
    return out;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  /** 第一次送出前替表單加上 opId（複製一份，不改呼叫端的物件）；重試時沿用同一份參數。回傳是否帶了 opId。 */
  function attachOpIds(action, args) {
    if (!OP_ACTIONS.has(action) || !args.length) return false;
    const withId = function(form) {
      if (!isPlainObject(form)) return form;
      return form.opId ? form : Object.assign({}, form, { opId: newOpId() });
    };
    if (Array.isArray(args[0])) {
      args[0] = args[0].map(withId);
      return args[0].length > 0 && args[0].every(function(f) { return isPlainObject(f) && f.opId; });
    }
    args[0] = withId(args[0]);
    return Boolean(isPlainObject(args[0]) && args[0].opId);
  }

  function send(action, args, onOk, onErr, attempt) {
    const isRead = READ_ACTIONS.has(action);
    const idempotent = !isRead && !attempt ? attachOpIds(action, args) : (!isRead && OP_ACTIONS.has(action));
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
          if ((isRead || idempotent) && error.transient && !attempt) {
            setTimeout(function() { send(action, args, onOk, onErr, 1); }, RETRY_DELAY_MS);
            return;
          }
          fail(error);
        })
        .api(debugTiming() ? { action: action, args: args, timing: true } : { action: action, args: args });
    } catch (e) {
      // 參數無法序列化等同步錯誤
      if (settle()) fail(toError(e, isRead));
    }
  }

  /* ------------------------- 合併進行中的相同讀取（P12） ------------------------- */
  const inflight = new Map();   // action＋參數 → 原始的 Promise（還沒回來的讀取）

  function readKey(action, args) {
    if (!READ_ACTIONS.has(action) || action === 'batchRead') return '';
    try { return action + '\u0000' + JSON.stringify(args); } catch (e) { return ''; }
  }
  function copyOf(v) {
    if (v == null || typeof v !== 'object') return v;
    try { if (typeof structuredClone === 'function') return structuredClone(v); } catch (e) {}
    return JSON.parse(JSON.stringify(v));
  }
  const same = function(v) { return v; };

  /* 第一個呼叫者拿到原始結果，之後合併進來的拿到複本（各自修改不會互相影響）。
   * 先在原始 Promise 上掛一個 same：第一個呼叫者的處理函式排在所有複本做完之後，複本一定是還沒被改過的。 */
  function track(key, raw) {
    inflight.set(key, raw);
    const done = function() { if (inflight.get(key) === raw) inflight.delete(key); };
    raw.then(done, done);
    return raw.then(same);
  }
  function joinInflight(key) {
    const raw = key && inflight.get(key);
    return raw ? raw.then(copyOf) : null;
  }

  function request(action, args) {
    const key = readKey(action, args);
    const joined = joinInflight(key);
    if (joined) return joined;
    const raw = new Promise(function(resolve, reject) { send(action, args, resolve, reject, 0); });
    return key ? track(key, raw) : raw;
  }

  /** Promise 介面：Api.call('addExpense', form) */
  function call(action) {
    return request(action, Array.prototype.slice.call(arguments, 1));
  }

  /** 批次讀取：Api.batch([{ action: 'getAssetOverview', args: [false] }, …]) */
  function batch(requests) {
    const items = (Array.isArray(requests) ? requests : []).map(function(r) {
      return { action: r && r.action, args: r && Array.isArray(r.args) ? r.args : [] };
    });
    const results = new Array(items.length);
    const toSend = [];
    items.forEach(function(it, i) {
      if (!READ_ACTIONS.has(it.action) || it.action === 'batchRead') {
        results[i] = Promise.reject(toError('批次讀取只接受唯讀操作：' + it.action, true));
        return;
      }
      const joined = joinInflight(readKey(it.action, it.args));
      if (joined) results[i] = joined; else toSend.push(i);
    });
    if (toSend.length === 1) {
      results[toSend[0]] = request(items[toSend[0]].action, items[toSend[0]].args);
    } else if (toSend.length > 1) {
      const payload = toSend.map(function(i) { return { action: items[i].action, args: items[i].args }; });
      const whole = new Promise(function(resolve, reject) { send('batchRead', [payload], resolve, reject, 0); });
      toSend.forEach(function(i, j) {
        const it = items[i];
        const raw = whole.then(function(out) {
          const r = Array.isArray(out) ? out[j] : null;
          if (r && r.ok) return r.data;
          throw toError(r && r.error ? r.error : '批次讀取沒有回傳這一項的結果', true);
        }, function(err) {
          // 後端還沒有 batchRead（剛部署、頁面是新版但後端是舊版）：逐項送出
          if (/不支援的操作/.test(err && err.rawMessage || '')) {
            return new Promise(function(resolve, reject) { send(it.action, it.args, resolve, reject, 0); });
          }
          throw err;
        });
        const key = readKey(it.action, it.args);
        results[i] = key ? track(key, raw) : raw;
      });
    }
    return Promise.all(results.map(function(p) {
      return p.then(function(data) { return { ok: true, data: data }; }, function(error) { return { ok: false, error: error }; });
    }));
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
          const onOk = ok ? function(result) { return handlers.hasUser ? ok(result, handlers.user) : ok(result); } : null;
          const onErr = failHandler ? function(err) { return handlers.hasUser ? failHandler(err, handlers.user) : failHandler(err); } : null;
          const key = readKey(prop, args);
          if (!key) { send(prop, args, onOk, onErr, 0); return; }
          // 讀取：和進行中的相同讀取合併
          // 處理函式自己丟出的錯誤照舊是「未捕捉的錯誤」（不要變成 Promise 的 rejection 被吞掉）
          const rethrow = function(e) { setTimeout(function() { throw e; }, 0); };
          request(prop, args).then(function(result) {
            try { if (onOk) onOk(result); } catch (e) { rethrow(e); }
          }, function(err) {
            try {
              if (onErr) onErr(err);
              else console.error('[Api] ' + prop + ' 失敗：', err);
            } catch (e) { rethrow(e); }
          });
        };
      }
    });
  }

  return {
    call: call,
    batch: batch,
    get server() { return makeRunner({}); },
    pending: function() { return pending; },
    pendingWrites: function() { return pendingWrites; },
    isReadAction: function(action) { return READ_ACTIONS.has(action); },
    newOpId: newOpId
  };
})();
