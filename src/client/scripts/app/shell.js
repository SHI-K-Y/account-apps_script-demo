function initDynamicHeader() {
  let lastScrollTop = 0;
  let ticking = false;
  const threshold = 10;
  const topSafeZone = 35;
  const scrolledThreshold = 4;

  // 效能：標頭是靜態 DOM，只查詢一次；且只在 class 真的需要改變時才寫入，
  // 避免捲動時每一幀都對所有標頭做 DOM 寫入。（其他程式也會移除 head-hidden，所以以 DOM 現況為準，不另存狀態）
  const headers = Array.prototype.slice.call(document.querySelectorAll('.head, .overview-head, .settlement-head, .cc-head, .fx-head'));
  const setHeaderClass = (name, on) => {
    for (let i = 0; i < headers.length; i++) {
      if (headers[i].classList.contains(name) !== on) headers[i].classList.toggle(name, on);
    }
  };

  function onScroll() {
    const scrollTop = window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
    const clampedScroll = Math.max(0, scrollTop);

    setHeaderClass('head-scrolled', clampedScroll > scrolledThreshold);

    if (clampedScroll <= topSafeZone) {
      setHeaderClass('head-hidden', false);
    } else if (clampedScroll > lastScrollTop + threshold) {
      setHeaderClass('head-hidden', true);
    } else if (clampedScroll < lastScrollTop - threshold) {
      setHeaderClass('head-hidden', false);
    }

    lastScrollTop = clampedScroll;
    ticking = false;
  }

  window.addEventListener('scroll', () => {
    if (!ticking) {
      window.requestAnimationFrame(onScroll);
      ticking = true;
    }
  }, { passive: true });

  onScroll();
}

function updateNavPill(instant) {
  const nav = document.getElementById('bottomNav');
  const pill = document.getElementById('navPill');
  if (!nav || !pill) return;
  const active = nav.querySelector('.nav-item.active');
  if (!active || !active.offsetWidth) {
    nav.classList.remove('has-pill');
    return;
  }
  const firstTime = !nav.classList.contains('has-pill');
  if (instant || firstTime) nav.classList.add('pill-instant');
  const prevX = pill._lgX;
  const nextX = active.offsetLeft;
  pill.style.width = active.offsetWidth + 'px';
  pill.style.height = active.offsetHeight + 'px';
  pill.style.translate = nextX + 'px ' + active.offsetTop + 'px';
  pill._lgX = nextX;
  nav.classList.add('has-pill');
  if (!instant && !firstTime && typeof prevX === 'number' && prevX !== nextX) {
    Motion.liquidStretch(pill, nextX - prevX, active.offsetWidth);
  }
  if (instant || firstTime) {
    void pill.offsetWidth;
    requestAnimationFrame(() => {
      if (!document.documentElement.dataset.vt) nav.classList.remove('pill-instant');
    });
  }
}

function initNavPill() {
  updateNavPill(true);
  let resizeTimer = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => updateNavPill(true), 80);
  }, { passive: true });

  Motion.watchIndicator(document.body, 'data-mode', () => document.querySelector('#pageBookkeeping .head .tabs'));
  const fxTabs = document.getElementById('fxTabs');
  Motion.watchIndicator(fxTabs, 'data-active', () => fxTabs);
}

function bindTabs() {
  document.querySelectorAll('.tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      const prevMode = document.body.dataset.mode;
      document.querySelectorAll('.tab[data-tab]').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.panel').forEach(x => x.classList.remove('active'));
      btn.classList.add('active');
      const panel = document.getElementById(btn.dataset.tab + 'Panel');
      panel.classList.add('active');
      document.body.dataset.mode = btn.dataset.tab;
      if (prevMode && prevMode !== btn.dataset.tab) {
        const offset = btn.dataset.tab === 'income' ? 24 : -24;
        Motion.animate(panel, {
          full: [{ opacity: 0, transform: 'translateX(' + offset + 'px)' }, { opacity: 1, transform: 'none' }],
          lite: [{ opacity: 0 }, { opacity: 1 }]
        }, { duration: Motion.dur('slow'), easing: Motion.ease('out') });
      }
      Motion.cancelScroll();
      window.scrollTo({ top: 0 });
      document.querySelectorAll('.head, .overview-head').forEach(h => h.classList.remove('head-hidden'));
      closeCalendar('expense');
      closeCalendar('income');
    });
  });
}

function bindStaticEvents() {
  document.getElementById('monthSelect').addEventListener('change', e => {
    state.mutationVersion++;
    const selectedMonth = e.target.value;
    closeCalendar('expense');
    closeCalendar('income');
    setDatesForMonth(selectedMonth);
    clearForms({ keepDates: true });
    resetRecentFullState();

    const cachedRecent = LocalCache.getRecent(selectedMonth);
    if (cachedRecent) {
      renderRecent(cachedRecent);
    }
    loadRecent(selectedMonth);
  });

  document.getElementById('refreshBtn').addEventListener('click', () => {
    state.mutationVersion++;
    closeCalendar('expense');
    closeCalendar('income');
    const month = getMonth();
    setLoading(true);
    Api.server
      .withSuccessHandler(data => {
        state.data = data;
        const client = getClientToday();
        state.data.todayISO = client.todayISO;
        state.data.currentMonth = client.currentMonth;
        if (data.settingsOptions) {
          settingsState.data = data.settingsOptions;
        }
        if (data.settingsMetadata) {
          settingsState.metadata = data.settingsMetadata;
          LocalCache.saveSettingsMetadata(data.settingsMetadata);
        }
        LocalCache.saveBoot(state.data);
        renderAllChoices();
        resetRecentFullState();
        if (data.initialRecent && data.initialRecent.month === month) {
          LocalCache.saveRecent(month, data.initialRecent);
          renderRecent(data.initialRecent);
          setLoading(false);
          showToast('資料已重新讀取', 'success');
        } else {
          loadRecent(month, true);
          setLoading(false);
          showToast('資料已重新讀取', 'success');
        }
      })
      .withFailureHandler(showServerError)
      .getInitialData(true);
  });

  document.querySelectorAll('.theme-toggle-btn').forEach(btn => {
    btn.addEventListener('click', toggleTheme);
  });

  document.getElementById('expenseTodayBtn').addEventListener('click', () => setToday('expenseDate'));
  document.getElementById('expenseYesterdayBtn').addEventListener('click', () => setYesterday('expenseDate'));
  document.getElementById('incomeTodayBtn').addEventListener('click', () => setToday('incomeDate'));
  document.getElementById('incomeYesterdayBtn').addEventListener('click', () => setYesterday('incomeDate'));

  const expDateInput = document.getElementById('expenseDate');
  if (expDateInput) {
    expDateInput.addEventListener('change', updateTodayExpenseUI);
    expDateInput.addEventListener('input', updateTodayExpenseUI);
    expDateInput.addEventListener('change', applySuggestedExpenseItem);
    expDateInput.addEventListener('input', applySuggestedExpenseItem);
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') applySuggestedExpenseItem();
  });
  const backTodayBtn = document.getElementById('todayExpenseBackTodayBtn');
  if (backTodayBtn) {
    backTodayBtn.addEventListener('click', () => {
      setToday('expenseDate');
    });
  }

  initCalendarPicker('expense');
  initCalendarPicker('income');

  document.getElementById('expenseSubmit').addEventListener('click', submitExpense);
  document.getElementById('incomeSubmit').addEventListener('click', submitIncome);

  const loadFullExpensesBtn = document.getElementById('loadFullExpensesBtn');
  if (loadFullExpensesBtn) {
    loadFullExpensesBtn.addEventListener('click', () => toggleFullRecords('expense'));
  }
  const loadFullIncomesBtn = document.getElementById('loadFullIncomesBtn');
  if (loadFullIncomesBtn) {
    loadFullIncomesBtn.addEventListener('click', () => toggleFullRecords('income'));
  }

  bindRecentDateFilterEvents();
  bindQuickComboMenu();

  ModalManager.register('editRecordModal', {
    close: closeEditModal,
    busy: 'editModalSubmitBtn'
  });
  ModalManager.register('deleteConfirmModal', {
    close: closeDeleteModal,
    busy: 'deleteModalConfirmBtn'
  });

  const editCloseIconBtn = document.getElementById('editModalCloseIconBtn');
  if (editCloseIconBtn) editCloseIconBtn.addEventListener('click', () => ModalManager.close('editRecordModal'));
  const editCancelBtn = document.getElementById('editModalCancelBtn');
  if (editCancelBtn) editCancelBtn.addEventListener('click', () => ModalManager.close('editRecordModal'));
  const editSubmitBtn = document.getElementById('editModalSubmitBtn');
  if (editSubmitBtn) editSubmitBtn.addEventListener('click', submitEditRecord);
  const editModal = document.getElementById('editRecordModal');
  if (editModal) {
    editModal.addEventListener('click', e => {
      if (e.target === e.currentTarget) ModalManager.close('editRecordModal');
    });
  }

  const deleteCloseIconBtn = document.getElementById('deleteModalCloseIconBtn');
  if (deleteCloseIconBtn) deleteCloseIconBtn.addEventListener('click', () => ModalManager.close('deleteConfirmModal'));
  const deleteCancelBtn = document.getElementById('deleteModalCancelBtn');
  if (deleteCancelBtn) deleteCancelBtn.addEventListener('click', () => ModalManager.close('deleteConfirmModal'));
  const deleteConfirmBtn = document.getElementById('deleteModalConfirmBtn');
  if (deleteConfirmBtn) deleteConfirmBtn.addEventListener('click', confirmDeleteRecord);
  const deleteModal = document.getElementById('deleteConfirmModal');
  if (deleteModal) {
    deleteModal.addEventListener('click', e => {
      if (e.target === e.currentTarget) ModalManager.close('deleteConfirmModal');
    });
  }

  ModalManager.register('addMonthModal', {
    close: closeAddMonthModal,
    busy: 'addMonthSubmitBtn'
  });

  const addMonthSheetBtn = document.getElementById('addMonthSheetBtn');
  if (addMonthSheetBtn) addMonthSheetBtn.addEventListener('click', openAddMonthModal);

  const addMonthCloseIconBtn = document.getElementById('addMonthCloseIconBtn');
  if (addMonthCloseIconBtn) addMonthCloseIconBtn.addEventListener('click', () => ModalManager.close('addMonthModal'));

  const addMonthCancelBtn = document.getElementById('addMonthCancelBtn');
  if (addMonthCancelBtn) addMonthCancelBtn.addEventListener('click', () => ModalManager.close('addMonthModal'));

  const addMonthSubmitBtn = document.getElementById('addMonthSubmitBtn');
  if (addMonthSubmitBtn) addMonthSubmitBtn.addEventListener('click', submitAddMonthSheet);

  const addMonthModalEl = document.getElementById('addMonthModal');
  if (addMonthModalEl) {
    addMonthModalEl.addEventListener('click', e => {
      if (e.target === e.currentTarget) ModalManager.close('addMonthModal');
    });
  }

  const addMonthInput = document.getElementById('addMonthInput');
  if (addMonthInput) {
    addMonthInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        submitAddMonthSheet();
      }
    });
  }

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      const pop = document.getElementById('emojiPickerPopover');
      if (pop && !pop.hidden) {
        pop.hidden = true;
        return;
      }
      closeCalendar('expense');
      closeCalendar('income');
      closeCalendar('st');
      closeCalendar('expenseFilter');
      closeCalendar('incomeFilter');
      ModalManager.handleEscape();
    }
  });

  document.addEventListener('click', e => {
    if (!e.target.closest('.date-picker-wrap') && !e.target.closest('.recent-calendar-popover') && !e.target.closest('.recent-date-picker-chip')) {
      closeCalendar('expense');
      closeCalendar('income');
      closeCalendar('st');
      closeCalendar('expenseFilter');
      closeCalendar('incomeFilter');
    }
  });
}

function toggleTheme(e) {
  ThemeManager.toggle(e && e.currentTarget ? e.currentTarget : null);
}
