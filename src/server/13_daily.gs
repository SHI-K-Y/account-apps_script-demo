/**
 * 每日維護（F05）：時間觸發器每天在 DAILY_AT_HOUR_ 點（台北時間；實際是那個小時內的某個時間）執行一次 dailyMaintenance。
 *
 * 同一時段的定時工作都合併在這裡依序執行（DAILY_JOBS_），不要每個功能各裝一個觸發器；
 * 之後的每日工作（例如 F01、F04 的自動入帳）加進 DAILY_JOBS_ 即可。每一項各自在 try/catch 裡，一項失敗不影響其他項；
 * 執行期間操作紀錄的來源記成 trigger（withOpLogSource_）。
 *
 * 目前的工作：
 *   opLogTrim         操作紀錄只保留最近 OPLOG_KEEP_（2,000）筆，刪掉較舊的列（24_oplog.gs 的 trimOpLog_）
 *   netWorthSnapshot  淨資產快照（F06，34_net_worth.gs）：每月 1 日寫入上個月；平常只檢查有沒有缺的、過期的
 *
 * 執行時間估算：opLogTrim 約 1–3 秒／天；netWorthSnapshot 平常約 1 秒（讀月份清單與快照），
 * 每月 1 日多讀一張月份工作表，改過以前的月份時多讀那個月起的工作表（一張約 0.3 秒，最多 24 張約 10 秒）；
 * 加上快取預熱（每 2 小時一次、每天約 1–3 分鐘），全部觸發器每天合計遠低於 90 分鐘的配額。
 * 偵錯：每次執行都會在「執行項目」印出 [dailyMaintenance] 各項耗時。
 */
const DAILY_HANDLER_ = 'dailyMaintenance';
const DAILY_AT_HOUR_ = 4;
const DAILY_JOBS_ = Object.freeze([
  Object.freeze({ name: 'opLogTrim', run: function () { return trimOpLog_(); } }),
  Object.freeze({ name: 'netWorthSnapshot', run: function () { return refreshNetWorthSnapshots_(); } }),
]);

/**
 * 時間觸發器的處理函式（公開名稱，不能以底線結尾）。
 * 只接受本專案觸發器的事件或擁有者在編輯器直接執行；其他來源直接 return。
 */
function dailyMaintenance(e) {
  if (!isTrustedTriggerCall_(e, DAILY_HANDLER_)) return;
  return withOpLogSource_('trigger', runDailyMaintenance_);
}

/** 安裝（或重新安裝）每日維護觸發器；setup() 會呼叫。回傳觸發器 ID。 */
function installDailyMaintenanceTrigger_() {
  return installTimeTrigger_(DAILY_HANDLER_, function (builder) {
    return builder.everyDays(1).atHour(DAILY_AT_HOUR_).inTimezone(DEFAULT_TIME_ZONE_);
  });
}

function runDailyMaintenance_() {
  const started = Date.now();
  const steps = DAILY_JOBS_.map(function (job) {
    const t0 = Date.now();
    try {
      const result = job.run();
      return { step: job.name, ms: Date.now() - t0, result: result };
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      console.warn('[dailyMaintenance] ' + job.name + ' 失敗：' + message);
      return { step: job.name, ms: Date.now() - t0, error: message };
    }
  });
  const summary = { totalMs: Date.now() - started, steps: steps };
  console.log('[dailyMaintenance] ' + JSON.stringify(summary));
  return summary;
}
