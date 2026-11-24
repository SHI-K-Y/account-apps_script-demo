/* =============================================================================
 * Prefetch — 閒置預取（P12）：切到總覽、設定時資料已經是最新的
 * -----------------------------------------------------------------------------
 * 開機第三段（app/bootstrap.js）與每次記帳成功後的閒置時間，用一次 batchRead 預取
 * 「總覽＋本月圖表＋預算設定」，存進 LocalCache；總覽頁還沒打開時順便在隱藏的容器裡預先畫好（prerenderOverview）。
 * 開機那一次另外帶上國外帳簿列表（旅行提示要用，以前是國外帳簿頁自己在載入後另外讀一次）。
 *
 *   Prefetch.boot()               開機第三段呼叫
 *   Prefetch.afterMutation(month) 記帳、對帳、設定變更成功後呼叫：總覽、對帳、圖表、預算標成過期（不刪除），
 *                                 等所有寫入都回來（Api.pendingWrites() 為 0）之後：
 *                                 總覽頁正開著 → 直接重新讀取（畫面上是舊數字＋「更新中」）；沒開著 → 閒置時預取
 *   Prefetch.isFresh(kind, month) 快取沒有過期、而且是 FRESH_MS 內拿到的：切頁時不用再問伺服器
 *
 * 預取途中又有寫入（state.mutationVersion 變了）時，拿到的結果可能是寫入前的：照樣存（比更舊的好），
 * 但維持過期標記，等寫入回來再預取一次。切頁時正在進行中的預取會被 Api 合併，不會重送。
 * ============================================================================= */
const Prefetch = (function() {
  const FRESH_MS = 90 * 1000;
  let queued = false;
  let running = null;
  let waitingWrites = false;

  function overviewMonth() {
    const ov = LocalCache.getOverview();
    return (ov && ov.month) || (state.data && state.data.currentMonth) || getClientToday().currentMonth;
  }

  /** 總覽頁與預取共用的批次內容。 */
  function requestsFor(month, force) {
    return [
      { action: 'getAssetOverview', args: [Boolean(force)] },
      { action: 'getOverviewCharts', args: [month, Boolean(force)] },
      { action: 'getBudgetSettings', args: [Boolean(force)] },
    ];
  }

  /** 把批次結果存進 LocalCache（版本變了就維持過期）。回傳原本的結果陣列。 */
  function store(results, month, version) {
    const ov = results[0];
    const ch = results[1];
    const bu = results[2];
    if (ov && ov.ok && ov.data) LocalCache.saveOverview(ov.data);
    if (ch && ch.ok && ch.data) LocalCache.saveCharts(month, ch.data);
    if (bu && bu.ok && bu.data) LocalCache.saveBudgetSettings(bu.data);
    if (version !== state.mutationVersion) LocalCache.markStale(month);
    return results;
  }

  function isFresh(kind, month) {
    const s = LocalCache.status(kind, month);
    return Boolean(s && !s.stale && Date.now() - s.savedAt < FRESH_MS && Api.pendingWrites() === 0);
  }

  function run(withFx) {
    if (running) return running;
    if (Api.pendingWrites() > 0) { waitingWrites = true; return Promise.resolve(null); }
    const month = overviewMonth();
    const fx = Boolean(withFx) && typeof ForeignPage === 'object' && typeof ForeignPage.acceptPrefetchedList === 'function';
    if (!fx && isFresh('overview') && isFresh('charts', month) && isFresh('budget')) return Promise.resolve(null);
    const version = state.mutationVersion;
    const reqs = requestsFor(month, false).concat(fx ? [{ action: 'getFxLedgers', args: [false] }] : []);
    running = Api.batch(reqs).then(results => {
      running = null;
      store(results, month, version);
      if (fx && results[3] && results[3].ok) ForeignPage.acceptPrefetchedList(results[3].data);
      if (version !== state.mutationVersion) schedule();
      // 總覽頁還沒打開：用新資料重新預先畫好（打開時只播放數字動畫）
      else if (typeof prerenderOverview === 'function') BootPhase.onIdle(() => prerenderOverview());
      return results;
    }, () => { running = null; return null; });
    return running;
  }

  function schedule(withFx) {
    if (queued) return;
    queued = true;
    BootPhase.onIdle(() => { queued = false; run(withFx); });
  }

  function onWritesSettled() {
    if (document.body.dataset.page === 'overview' && typeof loadOverview === 'function') loadOverview(false);
    else schedule();
  }

  document.addEventListener('apiactivity', e => {
    if (waitingWrites && e.detail && e.detail.pendingWrites === 0) {
      waitingWrites = false;
      onWritesSettled();
    }
  });

  return {
    boot: () => schedule(true),
    run: run,
    requestsFor: requestsFor,
    store: store,
    isFresh: isFresh,
    /** 總覽頁打開時還有寫入沒回來：先顯示舊資料，寫入都回來後再讀。 */
    waitForWrites: function() { waitingWrites = true; },
    afterMutation: function(month) {
      LocalCache.markStale(month);
      if (typeof window.__invalidateOverviewFlag === 'function') window.__invalidateOverviewFlag();
      if (Api.pendingWrites() > 0) { waitingWrites = true; return; }
      onWritesSettled();
    },
  };
})();
