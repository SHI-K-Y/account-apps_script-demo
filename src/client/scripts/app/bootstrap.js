/* =============================================================================
 * AppBoot — 開機流程（P08）：先畫出可以記帳的畫面，其他工作往後排
 * -----------------------------------------------------------------------------
 * 開機程式的最後一行（app/start.js）呼叫 AppBoot.start()。這時所有頁面與彈窗的 HTML、啟動資料（__INITIAL_DATA__）
 * 都已經解析好，但排在後面的延後程式（deferredApp，P07）與內嵌圖片（assets.html）可能還在下載——開機不等它們，
 * 也不等 DOMContentLoaded。三段之間讓出主執行緒（瀏覽器可以繪製、處理點擊、繼續解析）；第一段之後等首屏那一幀畫完
 * （BootPhase.nextFrame）才做第二段：
 *
 *   第一段（首屏）：日期、支出面板的選項與鍵盤、今日總花費、最近支出前 8 筆、月份選單（目前月份）
 *                   → 送出背景同步 → __boot.done() 移除載入畫面
 *   第二段：收入面板（選項、鍵盤）、最近收入、完整的月份選單、次要的事件綁定、提醒卡片判斷、
 *           各模組用 BootPhase.later() 登記的工作
 *   第三段（requestIdleCallback）：LocalCache 寫回、設定 metadata 快取、執行延後程式（P07）、
 *           用 LocalCache 預先渲染總覽、對帳與設定頁（畫在隱藏的頁面容器裡）、閒置預取總覽＋本月圖表＋預算（P12，
 *           app/prefetch.js，一次 batchRead）、各模組用 BootPhase.idle() 登記的工作
 *
 * LocalCache 的資料在 IndexedDB（P12）：頁面一開始（partials/boot-loader.html）就開始讀，第一段之前最多等
 * LOCAL_CACHE_WAIT_MS（通常和等第一幀同時就讀完了）；超過時間還沒讀完就照樣用伺服器內嵌的資料開機。
 * IndexedDB 裡還沒有資料（第一次開啟、被清掉）時不等：建立資料庫要好幾十毫秒，等了也是空的。
 *
 * 有本機快取時，第一段完全不用等伺服器：用 __INITIAL_DATA__ 與 LocalCache 裡比較新的那份；背景同步回來後
 * 照舊由 applyInitialData() 一次更新全部（同步途中也可以正常操作）。都沒有資料時才保留載入畫面等同步結果。
 * 內嵌圖片在 DOMContentLoaded 時才一定到齊：那時補上支付方式的卡面與 App 圖示（onAssetsLoaded）。
 * ============================================================================= */
const AppBoot = (function() {
  const LOCAL_CACHE_WAIT_MS = 250;
  let started = false;
  const pendingLocalSaves = { boot: false, meta: null };

  /** 選出這次開機要用的資料：伺服器內嵌的與本機快取，取 cachedAt 比較新的。 */
  function pickBootData() {
    const serverBoot = (typeof window.__INITIAL_DATA__ === 'object' && window.__INITIAL_DATA__) ? window.__INITIAL_DATA__ : null;
    const localBoot = LocalCache.getBoot();
    let best = null;
    if (serverBoot && localBoot) {
      best = ((serverBoot.cachedAt || 0) >= (localBoot.cachedAt || 0)) ? serverBoot : localBoot;
    } else {
      best = serverBoot || localBoot;
    }
    const usable = Boolean(best && best.options && best.months && best.months.length);
    return { serverBoot: serverBoot, best: usable ? best : null };
  }

  /* ------------------------------ 第一段：首屏 ------------------------------ */
  function stageFirstScreen() {
    if (window.__boot) __boot.step(0.86, '正在初始化畫面…', 0.9);
    const client = getClientToday();

    initDynamicHeader();
    bindTabs();
    bindStaticEvents();
    buildKeypad('expenseKeypad', 'expense');
    renderAmount('expense');
    ['expenseDate', 'incomeDate'].forEach(id => {
      const input = document.getElementById(id);
      if (input) input.value = client.todayISO;
    });
    updateRecentDateFilterBounds(client.currentMonth);

    const picked = pickBootData();
    let needSync = true;
    if (picked.best) {
      applyInitialData(picked.best, { isBackgroundSync: false, firstScreen: true });
      pendingLocalSaves.boot = true;   // 寫回 LocalCache 留到第三段（內容沒變就不寫）
      const serverBoot = picked.serverBoot;
      // budgetPending：伺服器的預算快取沒命中，內嵌資料沒有 budget（doGet 不開試算表，P09），要靠背景同步補上
      needSync = !(serverBoot && serverBoot.fromFreshCache && !serverBoot.budgetPending &&
        state.data.initialRecent && state.data.initialRecent.month === state.data.selectedMonth);
    } else {
      applyInitialData({
        todayISO: client.todayISO,
        currentMonth: client.currentMonth,
        selectedMonth: client.currentMonth,
        months: [client.currentMonth],
        options: DEFAULT_OPTIONS_FALLBACK,
        initialRecent: null,
      }, { isBackgroundSync: false, firstScreen: true });
      setLoading(true);
    }
    // 請求越早送出越好（伺服器 0.3–2 秒），回應一定在第二段之後才會處理
    if (needSync) syncInitialDataInBackground(false);
    initNavPill();
  }

  /** 首屏畫好了：移除載入畫面。沒有任何資料（第一次開啟、快取被清掉）時等背景同步回來再移除。 */
  function finishLoader() {
    const boot = window.__boot;
    if (!boot) {
      document.documentElement.classList.add('boot-ready');
      try { window.dispatchEvent(new Event('bootready')); } catch (e) {}
      return;
    }
    if (boot.finished || boot.hadError) return;
    const body = document.body;
    if (!body.classList.contains('busy')) { boot.done(); return; }
    boot.step(0.9, '正在從 Google 試算表同步最新資料…', 0.97);
    const mo = new MutationObserver(() => {
      if (!body.classList.contains('busy')) { mo.disconnect(); boot.done(); }
    });
    mo.observe(body, { attributes: true, attributeFilter: ['class'] });
    setTimeout(() => { mo.disconnect(); boot.done(); }, 15000);
  }

  /* ------------------------------ 第二段 ------------------------------ */
  function stageSecond() {
    buildKeypad('incomeKeypad', 'income');
    renderAmount('income');
    renderIncomeEntryChoices();
    // 最近收入：用目前的狀態畫（背景同步若已經先回來，這裡畫的就是最新的，ListRender 會沿用節點）
    renderRecentType('income');
    populateMonths();
    bindSecondaryEvents();
  }

  /* ------------------------------ 第三段（閒置） ------------------------------ */
  function saveLocalCaches() {
    if (pendingLocalSaves.meta) {
      LocalCache.saveSettingsMetadata(pendingLocalSaves.meta);
      pendingLocalSaves.meta = null;
    }
    if (pendingLocalSaves.boot) {
      pendingLocalSaves.boot = false;
      // 開機後已經有寫入或背景同步存過最新的資料時，LocalCache 會判斷內容相同而不寫
      if (state.data && state.data.options !== DEFAULT_OPTIONS_FALLBACK) LocalCache.saveBoot(state.data);
    }
  }

  function prerenderPages() {
    // 延後程式還沒到（網路慢）或已經切到別頁：不預先渲染，切頁時照原本的流程畫
    if (!DeferredApp.loaded() || (document.body.dataset.page || 'bookkeeping') !== 'bookkeeping') return;
    if (typeof prerenderOverview === 'function') prerenderOverview();
    if (typeof prerenderSettlement === 'function') prerenderSettlement();
  }
  function prerenderSettingsPage() {
    if (!DeferredApp.loaded() || (document.body.dataset.page || 'bookkeeping') !== 'bookkeeping') return;
    if (typeof prerenderSettings === 'function') prerenderSettings();
  }

  async function run() {
    // 先等一幀：開機程式的編譯與頂層執行自成一個任務；已經解析好的頁面骨架在這一幀先算好樣式與排版
    // （載入畫面還蓋著，看不到），首屏加上的選項、清單在下一幀只要增量計算，不會擠成一個長任務。
    // 同時等 LocalCache 從 IndexedDB 讀完（P12）
    await Promise.all([BootPhase.nextFrame(), LocalCache.mayHaveData() ? LocalCache.whenReady(LOCAL_CACHE_WAIT_MS) : null]);
    try {
      stageFirstScreen();
    } catch (e) {
      BootPhase.report(e);   // 載入畫面顯示錯誤（partials/boot-loader.html 監聽 window 的 error）
    }
    // 旅行中：記帳頁一打開就要顯示旅行提示（ForeignPage 畫的），等延後程式到齊再移除載入畫面
    if (DeferredApp.hasActiveTripHint()) await DeferredApp.whenAvailable(true);
    finishLoader();

    // 等首屏那一幀畫完再做第二段：首屏的樣式、排版在那一幀計算，不被第二段強制提早算、擠成一個長任務
    await BootPhase.nextFrame();
    try { stageSecond(); } catch (e) { BootPhase.report(e); }
    ReminderPrompt.start();   // 有背景同步時會等同步結束，用最新資料判斷
    await BootPhase.flushLater();

    BootPhase.idle(saveLocalCaches);
    // 執行延後程式（P07）；頁面還沒下載完時等它到齊，執行完再排一次閒置時間預先渲染總覽與對帳頁
    BootPhase.idle(() => DeferredApp.whenAvailable(true).then(() => {
      BootPhase.idle(prerenderPages);
      BootPhase.idle(prerenderSettingsPage);
      // 閒置預取（P12）：切到總覽、設定時已經是最新的
      BootPhase.idle(Prefetch.boot);
    }));
    await BootPhase.flushIdle();
  }

  /** 內嵌圖片（assets.html）到齊：補上首屏先省略的卡面、銀行 logo 與 App 圖示。 */
  function onAssetsLoaded() {
    applyAppIcon();
    if (paymentImagesMissed()) refreshPaymentImages();
  }

  return {
    start: function() {
      if (started) return;
      started = true;
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onAssetsLoaded, { once: true });
      else onAssetsLoaded();
      run().catch(BootPhase.report);
    },
    /** 第三段寫回的設定 metadata（applyInitialData 收到新的 metadata 時登記）。 */
    queueSettingsMetadata: function(meta) { pendingLocalSaves.meta = meta; },
  };
})();

/**
 * 套用啟動資料。開機第一段（opts.firstScreen）只畫首屏用到的部分，其餘交給第二段；
 * 背景同步（opts.isBackgroundSync）回來時一次更新全部，只重畫有變的部分。
 */
function applyInitialData(data, opts) {
  if (!data) return;
  const options = opts || {};
  const isBackgroundSync = Boolean(options.isBackgroundSync);
  const firstScreen = Boolean(options.firstScreen);

  const prevOptionsJson = (state.data && state.data.options) ? JSON.stringify(state.data.options) : '';
  const prevMonthsJson = (state.data && state.data.months) ? JSON.stringify(state.data.months) : '';
  const prevSelectedMonth = getMonth();

  state.data = data;

  const client = getClientToday();
  state.data.todayISO = client.todayISO;
  state.data.currentMonth = client.currentMonth;

  if (isBackgroundSync && prevSelectedMonth && state.data.months.includes(prevSelectedMonth)) {
    state.data.selectedMonth = prevSelectedMonth;
  } else if (state.data.months.includes(client.currentMonth)) {
    state.data.selectedMonth = client.currentMonth;
  }

  if (data.settingsOptions) {
    settingsState.data = data.settingsOptions;
  }
  if (data.settingsMetadata) {
    settingsState.metadata = data.settingsMetadata;
    // 開機時寫回 LocalCache 留到閒置時間（第三段）；之後的背景同步照舊立即寫入
    if (firstScreen) AppBoot.queueSettingsMetadata(data.settingsMetadata);
    else LocalCache.saveSettingsMetadata(data.settingsMetadata);
  } else if (!settingsState.metadata) {
    const cachedMeta = LocalCache.getSettingsMetadata();
    if (cachedMeta) settingsState.metadata = cachedMeta;
  }

  const newMonthsJson = JSON.stringify(state.data.months || []);
  const newOptionsJson = JSON.stringify(state.data.options || {});

  if (!isBackgroundSync || newMonthsJson !== prevMonthsJson) {
    // 首屏只放目前月份這一個選項（getMonth() 讀的就是它），完整清單在第二段補上
    populateMonths(firstScreen ? { onlySelected: true } : null);
    if (!isBackgroundSync) {
      setDatesForMonth(state.data.selectedMonth);
    }
  }

  if (firstScreen) {
    renderExpenseChoices();
  } else if (!isBackgroundSync || newOptionsJson !== prevOptionsJson) {
    renderAllChoices();
  } else {
    renderQuickComboChips();
  }

  const recentOpts = firstScreen ? { only: 'expense' } : null;
  const targetMonth = state.data.selectedMonth;
  if (data.initialRecent && data.initialRecent.month === targetMonth) {
    // 開機時 initialRecent 會跟著 saveBoot 一起寫回（第三段）
    if (!firstScreen) LocalCache.saveRecent(targetMonth, data.initialRecent);
    renderRecent(data.initialRecent, recentOpts);
  } else {
    const cachedRecent = LocalCache.getRecent(targetMonth);
    if (cachedRecent && !isBackgroundSync) {
      renderRecent(cachedRecent, recentOpts);
    }
    loadRecent(targetMonth);
  }
}

function syncInitialDataInBackground(forceRefresh) {
  const syncVersion = state.mutationVersion;
  ReminderPrompt.syncStarted();
  Api.server
    .withSuccessHandler(data => {
      setLoading(false);
      if (syncVersion === state.mutationVersion && data) {
        applyInitialData(data, { isBackgroundSync: true });
        LocalCache.saveBoot(state.data);
      }
      ReminderPrompt.syncFinished();
    })
    .withFailureHandler(err => {
      setLoading(false);
      if (!state.data || !state.data.initialRecent) {
        showServerError(err);
      } else {
        console.warn('Background sync error:', err);
      }
      ReminderPrompt.syncFinished();
    })
    .getInitialData(Boolean(forceRefresh));
}
