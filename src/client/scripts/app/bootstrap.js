document.addEventListener('DOMContentLoaded', init);

function init() {
  initDynamicHeader();
  bindTabs();
  initNavPill();
  bindStaticEvents();
  buildKeypad('expenseKeypad', 'expense');
  buildKeypad('incomeKeypad', 'income');
  renderAmount('expense');
  renderAmount('income');

  const clientInit = getClientToday();
  ['expenseDate', 'incomeDate'].forEach(id => {
    const input = document.getElementById(id);
    if (input) input.value = clientInit.todayISO;
  });
  updateTodayExpenseUI();
  updateRecentDateFilterBounds(clientInit.currentMonth);


  const serverBoot = (typeof window.__INITIAL_DATA__ === 'object' && window.__INITIAL_DATA__) ? window.__INITIAL_DATA__ : null;
  const localBoot = LocalCache.getBoot();

  let bestBoot = null;
  if (serverBoot && localBoot) {
    bestBoot = ((serverBoot.cachedAt || 0) >= (localBoot.cachedAt || 0)) ? serverBoot : localBoot;
  } else {
    bestBoot = serverBoot || localBoot;
  }

  if (bestBoot && bestBoot.options && bestBoot.months && bestBoot.months.length) {
    applyInitialData(bestBoot, { isBackgroundSync: false });
    LocalCache.saveBoot(state.data);

    const isFreshServerHit = Boolean(
      serverBoot &&
      serverBoot.fromFreshCache &&
      state.data.initialRecent &&
      state.data.initialRecent.month === state.data.selectedMonth
    );

    if (!isFreshServerHit) {
      syncInitialDataInBackground(false);
    }
  } else {
    const fallbackData = {
      todayISO: clientInit.todayISO,
      currentMonth: clientInit.currentMonth,
      selectedMonth: clientInit.currentMonth,
      months: [clientInit.currentMonth],
      options: DEFAULT_OPTIONS_FALLBACK,
      initialRecent: null,
    };
    applyInitialData(fallbackData, { isBackgroundSync: false });
    setLoading(true);
    syncInitialDataInBackground(false);
  }
}

function applyInitialData(data, opts) {
  if (!data) return;
  const options = opts || {};
  const isBackgroundSync = Boolean(options.isBackgroundSync);

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
    LocalCache.saveSettingsMetadata(data.settingsMetadata);
  } else if (!settingsState.metadata) {
    const cachedMeta = LocalCache.getSettingsMetadata();
    if (cachedMeta) settingsState.metadata = cachedMeta;
  }

  const newMonthsJson = JSON.stringify(state.data.months || []);
  const newOptionsJson = JSON.stringify(state.data.options || {});

  if (!isBackgroundSync || newMonthsJson !== prevMonthsJson) {
    populateMonths();
    if (!isBackgroundSync) {
      setDatesForMonth(state.data.selectedMonth);
    }
  }

  if (!isBackgroundSync || newOptionsJson !== prevOptionsJson) {
    renderAllChoices();
  } else {
    renderQuickComboChips();
  }

  const targetMonth = state.data.selectedMonth;
  if (data.initialRecent && data.initialRecent.month === targetMonth) {
    LocalCache.saveRecent(targetMonth, data.initialRecent);
    renderRecent(data.initialRecent);
  } else {
    const cachedRecent = LocalCache.getRecent(targetMonth);
    if (cachedRecent && !isBackgroundSync) {
      renderRecent(cachedRecent);
    }
    loadRecent(targetMonth);
  }
}

function syncInitialDataInBackground(forceRefresh) {
  const syncVersion = state.mutationVersion;
  Api.server
    .withSuccessHandler(data => {
      setLoading(false);
      if (syncVersion !== state.mutationVersion) return;
      if (!data) return;
      applyInitialData(data, { isBackgroundSync: true });
      LocalCache.saveBoot(state.data);
    })
    .withFailureHandler(err => {
      setLoading(false);
      if (!state.data || !state.data.initialRecent) {
        showServerError(err);
      } else {
        console.warn('Background sync error:', err);
      }
    })
    .getInitialData(Boolean(forceRefresh));
}
