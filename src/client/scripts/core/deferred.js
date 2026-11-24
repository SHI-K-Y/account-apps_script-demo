/* 延後執行的程式（P07；P08 調整執行時機）
 * 首頁用不到的模組（pages/*、charts/*：總覽、對帳、信用卡、設定、搜尋、國外帳簿）由建置腳本放進
 * <script type="text/plain" id="deferredApp">：瀏覽器只當成文字，不會解析、編譯。
 *
 * P08：開機不再等整份頁面下載完（app/bootstrap.js 在開機程式執行完就開始畫首屏），這段文字與後面的內嵌圖片
 * （assets.html，設定頁的頂層程式會用到）可能還在下載。所以「可以執行」＝ DOMContentLoaded 之後（available()），
 * 在那之前要求執行的會先記下來，一到 DOMContentLoaded 就同步執行：
 *   1. 開機第三段（閒置時，app/bootstrap.js）：whenAvailable(true) 執行，之後預先渲染總覽與對帳頁
 *   2. 切換頁面前：router 的 switchPage 先呼叫 ensure()；還不能執行時等它執行完再切過去
 *   3. 使用者第一次觸控、點擊或按鍵（捕獲階段，在事件送到目標之前）：延後模組在頂層綁了記帳頁上的按鈕
 *      （搜尋、國外交易帳簿入口），要在點擊送達前就綁好（頁面還沒下載完時，等 DOMContentLoaded 才綁得上）
 *   4. 快取裡有進行中的旅行帳簿：記帳頁一打開就要顯示旅行提示（ForeignPage 初始化時畫的），
 *      開機流程會等延後程式執行完才移除載入畫面
 * 執行方式是建立 <script> 並設定 textContent（不用 eval／new Function），頂層的 const／function 才會是全域的。
 * 延後的模組頂層只做三件事：宣告函式與狀態、綁定自己頁面／彈窗的事件、註冊自己的彈窗（ModalManager.register）；
 * 沒有任何開機模組在頂層或首屏流程裡呼叫它們（router 的切頁、搜尋結果的同步更新都在使用者操作之後，見上面 2、3）。
 */
const DeferredApp = (function() {
  const SOURCE_ID = 'deferredApp';
  let done = false;
  let wanted = false;
  const waiters = [];
  const availableWaiters = [];

  function source() {
    return document.getElementById(SOURCE_ID);
  }

  /** 延後的程式與內嵌圖片都已經下載、解析完（DOMContentLoaded 之後）。 */
  function available() {
    return document.readyState !== 'loading';
  }

  /** 執行延後的程式；已經執行過、或頁面上沒有延後的程式時直接回傳 true。
   *  頁面還沒下載完時回傳 false，並在 DOMContentLoaded 時自動執行。 */
  function ensure() {
    if (done) return true;
    if (!available()) {
      wanted = true;
      return false;
    }
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

  /** 可以執行時 resolve；run 為 true 時順便執行（resolve 時已經載入）。 */
  function whenAvailable(run) {
    return new Promise(resolve => {
      const go = () => { if (run) ensure(); resolve(); };
      if (available()) go();
      else availableWaiters.push(go);
    });
  }

  /** 保險：閒置時執行（開機流程出錯、沒有走到第三段時）。 */
  function schedule() {
    if (done) return;
    whenAvailable(false).then(() => {
      if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(ensure, { timeout: 1500 });
      else setTimeout(ensure, 200);
    });
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
  if (!available()) {
    document.addEventListener('DOMContentLoaded', function() {
      if (wanted) ensure();
      while (availableWaiters.length) {
        try { availableWaiters.shift()(); } catch (e) { console.error(e); }
      }
    }, { once: true });
  }
  // 開機流程沒有走到第三段（出錯）時的保險：載入完成後一樣排進閒置時間
  window.addEventListener('load', function() { setTimeout(schedule, 3000); }, { once: true });

  return {
    ensure: ensure,
    loaded: loaded,
    available: available,
    whenLoaded: whenLoaded,
    whenAvailable: whenAvailable,
    schedule: schedule,
    hasActiveTripHint: hasActiveTripHint
  };
})();
