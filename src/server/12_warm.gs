/**
 * 快取預熱（P11）：時間觸發器每 CONFIG.WARM_INTERVAL_HOURS 小時執行一次 warmCaches，
 * 把開頁與總覽會用到的快取全部重建（CacheService 最長 6 小時，2 小時一次就不會整批過期），
 * 早上第一次開啟時 doGet、總覽、圖表、預算設定、國外帳簿清單都直接命中快取，不必等開試算表。
 *
 * 重建的內容（依序，每一步各自在文件鎖內、各自 try/catch，一步失敗不影響其他步）：
 *   budget      預算設定（BUDGET_CONFIG）與本月月初餘額（BUDGET_OPENING_<本月>）
 *   boot        啟動資料（BOOT_JSON）：月份清單、選項（OPTIONS_ALL／OPTIONS_SIMPLE）、本月明細；並更新備援快照 BOOT_SNAPSHOT
 *   prevMonth   上個月的明細（MONTH_DATA_<上月>）
 *   overview    本月總覽（OVERVIEW_<本月>）
 *   charts      本月圖表（CHARTS_<本月>）與月底預估用的前三個月明細（FORECAST_HISTORY_<本月>，F06）
 *   netWorth    淨資產歷史（NET_WORTH：從 _資產快照 讀，F06）
 *   fxLedgers   國外帳簿清單（FX_LEDGERS）
 *   config      doGet 設定（DOGET_CONFIG：允許名單、圖示、網址），存活時間撐到下一次預熱
 * 每一步都在文件鎖內做，是為了不和記帳寫入交錯：寫入會就地更新明細快取，
 * 預熱若在寫入前讀了工作表、寫入後才存回快取，就會把舊資料蓋回去。
 *
 * 執行時間估算：一次約 5–16 秒（主要是讀本月／上月明細、選項、總覽區塊與各國外帳簿；前兩、三個月的明細快取還在時不重讀），
 * 每天 12 次 ≈ 1–3 分鐘，遠低於一般帳號時間觸發器每天 90 分鐘的配額。
 * 偵錯：每次執行都會在「執行項目」印出 [warmCaches] 各步驟耗時。
 */
const WARM_HANDLER_ = 'warmCaches';

/**
 * 時間觸發器的處理函式（公開名稱，不能以底線結尾）。
 * 只接受本專案觸發器的事件或擁有者在編輯器直接執行；其他來源（例如網頁的 google.script.run）直接 return。
 */
function warmCaches(e) {
  if (!isTrustedTriggerCall_(e, WARM_HANDLER_)) return;
  return runWarmCaches_();
}

/** 安裝（或重新安裝）預熱觸發器；setup() 會呼叫。回傳觸發器 ID。 */
function installWarmCachesTrigger_() {
  return installTimeTrigger_(WARM_HANDLER_, function (builder) {
    return builder.everyHours(CONFIG.WARM_INTERVAL_HOURS);
  });
}

function runWarmCaches_() {
  const started = Date.now();
  const steps = [];
  const step = function (name, fn) {
    const t0 = Date.now();
    try {
      withDocumentLock_(fn);
      steps.push({ step: name, ms: Date.now() - t0 });
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      steps.push({ step: name, ms: Date.now() - t0, error: message });
      console.warn('[warmCaches] ' + name + ' 失敗：' + message);
    }
  };

  const ss = getSpreadsheet_();
  rememberSpreadsheetId_(ss.getId());
  const today = budgetToday_();
  let months = [];

  // 預算先做：啟動資料裡的預算狀態會用到最新的設定與月初餘額
  step('budget', function () {
    readBudgetConfig_(ss, true);
    budgetOpeningBalance_(ss, today.month, true);
  });

  let bootMonth = '';
  step('boot', function () {
    const boot = getInitialData_(true);
    months = (boot && boot.months) || [];
    bootMonth = (boot && boot.initialRecent && boot.initialRecent.month) || '';
    // 備援快照剛由 getInitialData_ 更新：doGet 接下來半小時內不用再寫一次
    try { scriptCache_().put(CONFIG.CACHE_KEYS.BOOT_SNAPSHOT_STAMP, String(Date.now()), CONFIG.CACHE_TTL); } catch (e) {}
  });
  if (!months.length) {
    try { months = getMonthsList_(ss, false); } catch (e) { months = []; }
  }
  const exists = new Set(months);
  const target = exists.has(today.month) ? today.month : (months[0] || '');

  // 本月明細已經由 boot 重建；另外補上本月（boot 選了別的月份時）與上月
  [today.month, shiftMonth_(today.month, -1)].forEach(function (m) {
    if (!exists.has(m) || m === bootMonth) return;
    step('month:' + m, function () { getMonthData_(ss, m, true); });
  });

  if (target) {
    step('overview', function () { readAssetOverviewFromSheet_(ss, target, months); });
    step('charts', function () {
      // 不用 forceRefresh：那會強制重建月份彙總（寫入工作表）；明細快取剛更新過，清掉圖表快取重算即可
      // 月底預估的歷史明細（F06）一起重建，存活時間才撐得到下一次預熱
      scriptCache_().removeAll([CONFIG.CACHE_KEYS.CHARTS_PREFIX + target, CONFIG.CACHE_KEYS.FORECAST_HISTORY_PREFIX + target]);
      getOverviewCharts_(target, false);
    });
  }

  step('netWorth', function () { loadNetWorthClosed_(ss, months, today); });

  step('fxLedgers', function () {
    scriptCache_().remove(CONFIG.CACHE_KEYS.FX_LEDGERS);
    getFxLedgers_(false);
  });

  step('config', function () { refreshDoGetConfig_(CONFIG.WARM_DOGET_CONFIG_TTL); });

  const summary = { totalMs: Date.now() - started, month: target, steps: steps };
  console.log('[warmCaches] ' + JSON.stringify(summary));
  return summary;
}
