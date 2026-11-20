/* 延後執行的程式（P07）
 * 首頁用不到的模組（pages/*、charts/*：總覽、對帳、信用卡、設定、搜尋、國外帳簿）由建置腳本放進
 * <script type="text/plain" id="deferredApp">：瀏覽器只當成文字，不會解析、編譯。開機完成後在閒置時執行；
 * 下面幾種情況會提早「同步」執行，行為和以前（全部一起載入）一樣：
 *   1. 切換頁面前（router 的 switchPage 會先呼叫 DeferredApp.ensure()）
 *   2. 使用者第一次觸控、點擊或按鍵（捕獲階段，在事件送到目標之前）：延後模組在頂層綁了記帳頁上的按鈕
 *      （搜尋、國外交易帳簿入口），要在點擊送達前就綁好
 *   3. 快取裡有進行中的旅行帳簿：記帳頁一打開就要顯示旅行提示（ForeignPage 初始化時畫的），
 *      在 DOMContentLoaded 的第一時間（開機程式的 init() 之前）執行
 * 執行方式是建立 <script> 並設定 textContent（不用 eval／new Function），頂層的 const／function 才會是全域的。
 * 延後的模組頂層只做三件事：宣告函式與狀態、綁定自己頁面／彈窗的事件、註冊自己的彈窗（ModalManager.register）；
 * 沒有任何開機模組在頂層或 init() 裡呼叫它們（router 的切頁、搜尋結果的同步更新都在使用者操作之後，見上面 1、2）。
 * 「閒置時」＝開機完成（<html> 加上 boot-ready，見 partials/boot-loader.html 送出的 bootready 事件）之後的
 * requestIdleCallback（最晚 1.5 秒）；不支援 requestIdleCallback 的瀏覽器（Safari）改用 200ms 的 setTimeout。
 */
const DeferredApp = (function() {
  const SOURCE_ID = 'deferredApp';
  const IDLE_TIMEOUT_MS = 1500;
  let done = false;
  let scheduled = false;
  const waiters = [];

  function source() {
    return document.getElementById(SOURCE_ID);
  }

  /** 執行延後的程式；已經執行過、或頁面上沒有延後的程式時直接回傳。回傳是否已載入。 */
  function ensure() {
    if (done) return true;
    const src = source();
    done = true;
    unbindFirstInput();
    if (src) {
      const el = document.createElement('script');
      el.textContent = src.textContent;
      // 換掉文字節點（釋放原始文字），插入的當下就同步執行
      src.parentNode.replaceChild(el, src);
    }
    while (waiters.length) {
      try { waiters.shift()(); } catch (e) { console.error(e); }
    }
    return true;
  }

  function loaded() {
    return done;
  }

  /** 延後模組載入後執行 fn（已載入就立刻執行）。 */
  function whenLoaded(fn) {
    if (done) fn();
    else waiters.push(fn);
  }

  /** 開機完成後呼叫：閒置時（最晚 1.5 秒）執行。 */
  function schedule() {
    if (done || scheduled) return;
    scheduled = true;
    if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(ensure, { timeout: IDLE_TIMEOUT_MS });
    else setTimeout(ensure, 200);
  }

  const FIRST_INPUT_EVENTS = ['pointerdown', 'touchstart', 'mousedown', 'keydown', 'click'];
  function onFirstInput() {
    ensure();
  }
  function bindFirstInput() {
    FIRST_INPUT_EVENTS.forEach(function(type) {
      window.addEventListener(type, onFirstInput, { capture: true, passive: true });
    });
  }
  function unbindFirstInput() {
    FIRST_INPUT_EVENTS.forEach(function(type) {
      window.removeEventListener(type, onFirstInput, { capture: true, passive: true });
    });
  }

  /** 快取裡有今天進行中的旅行帳簿（而且今天沒有關掉提示）：記帳頁要立刻顯示旅行提示。
   *  條件與 pages/foreign.js 的 activeTripLedger()／updateTripHint() 相同。 */
  function hasActiveTripHint() {
    try {
      const cached = LocalCache.getFxList();
      const ledgers = cached && Array.isArray(cached.ledgers) ? cached.ledgers : [];
      if (!ledgers.length) return false;
      const today = getClientToday().todayISO;
      if (LocalCache.getFxHintHiddenDate() === today) return false;
      const isIso = function(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); };
      return ledgers.some(function(l) {
        return l && !l.archived && isIso(l.startDate) && isIso(l.endDate) && l.startDate <= today && today <= l.endDate;
      });
    } catch (e) {
      return false;
    }
  }

  bindFirstInput();
  window.addEventListener('bootready', schedule, { once: true });
  // 沒有開機畫面（或它出錯沒有送出 bootready）時的保險：載入完成後一樣排進閒置時間
  window.addEventListener('load', function() { setTimeout(schedule, 3000); }, { once: true });
  // 這個監聽在 bootstrap.js 的 init() 之前註冊，DOMContentLoaded 時會先執行
  document.addEventListener('DOMContentLoaded', function() {
    if (hasActiveTripHint()) ensure();
  }, { once: true });

  return { ensure: ensure, loaded: loaded, whenLoaded: whenLoaded, schedule: schedule, hasActiveTripHint: hasActiveTripHint };
})();
