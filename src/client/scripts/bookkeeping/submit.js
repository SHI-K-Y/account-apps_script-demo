function handleMutationRecentUpdate(result, fallbackMonth) {
  const targetMonth = (result && result.month) || fallbackMonth || getMonth();
  LocalCache.invalidateOverview(targetMonth);
  if (typeof window.__invalidateOverviewFlag === 'function') {
    window.__invalidateOverviewFlag();
  }
  if (result && result.recent) {
    LocalCache.saveRecent(targetMonth, result.recent);
    if (targetMonth === getMonth() && (!result.recent.month || result.recent.month === targetMonth)) {
      renderRecent(result.recent);
    }
  } else {
    if (targetMonth === getMonth()) {
      loadRecent(targetMonth, true);
    }
  }
}

function submitExpense() {
  const form = {
    month: getMonth(),
    day: getDay('expenseDate'),
    item: state.expense.item,
    category: state.expense.category,
    payment: state.expense.payment,
    paid: state.expense.paid,
    amount: state.expense.amount,
    note: document.getElementById('expenseNote').value,
  };

  if (!form.day) return showToast('請選擇日期', 'error');
  if (!form.item) return rejectEntryStep('expense', 'item', '請選擇支出項目');
  if (!form.category) return rejectEntryStep('expense', 'category', '請選擇支出總類');
  if (!form.payment) return rejectEntryStep('expense', 'payment', '請選擇支出方式');
  if (!form.amount || Number(form.amount) <= 0) return rejectEntryStep('expense', 'amount', '請輸入支出金額');

  const formSnapshot = {
    ...form,
    paymentTouched: state.expense.paymentTouched,
    categoryTouched: state.expense.categoryTouched,
    quickComboId: quickComboApplied.expense.id,
    quickComboNote: quickComboApplied.expense.note,
  };
  const fDay = Number(form.day);
  const fAmt = Number(form.amount) || 0;

  if (!state.dailyExpenses) state.dailyExpenses = {};
  if (fDay) {
    if (!state.dailyExpenses[fDay]) state.dailyExpenses[fDay] = { total: 0, count: 0 };
    state.dailyExpenses[fDay].total += fAmt;
    state.dailyExpenses[fDay].count += 1;
    updateTodayExpenseUI();
  }

  const tempId = 'temp_exp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const pendingRecord = {
    tempId: tempId,
    month: form.month,
    isPending: true,
    row: 'pending',
    day: form.day,
    item: form.item,
    category: form.category,
    payment: form.payment,
    paid: form.paid,
    amount: form.amount,
    note: form.note,
  };

  if (!window.__activePendingExpenses) window.__activePendingExpenses = [];
  window.__activePendingExpenses.unshift(pendingRecord);
  updateTodayExpenseUI();

  if (state.recentState && state.recentState.expense) {
    const expState = state.recentState.expense;
    if (!Array.isArray(expState.records)) expState.records = [];
    expState.records.unshift(pendingRecord);
    if (Array.isArray(expState.fullRecords) && expState.fullRecords !== expState.records) {
      expState.fullRecords.unshift(pendingRecord);
    }
    if (isRecentDateFiltered('expense')) {
      applyRecentDateFilter('expense');
    } else {
      renderRecentList('recentExpenses', expState.isFull ? expState.records : expState.records.slice(0, 8), 'expense');
      const expFull = expState.isFull;
      updateRecentHeader('expense', expFull, expState.records.length);
    }
    animatePendingRecentRow('recentExpenses', tempId);
  }

  clearExpenseAfterSave();
  showToast('已記錄（同步中…）', 'info');
  Motion.haptic('success');
  const expenseSubmitBtn = document.getElementById('expenseSubmit');
  playSubmitConfirm(expenseSubmitBtn);
  Motion.burst(expenseSubmitBtn, BURST_PALETTE.expense);

  state.mutationVersion++;

  Api.server
    .withSuccessHandler(result => {
      if (window.__activePendingExpenses) {
        window.__activePendingExpenses = window.__activePendingExpenses.filter(r => r.tempId !== tempId);
      }
      handleMutationRecentUpdate(result, form.month);
      flashSyncedRecentRow('recentExpenses', form);
      LocalCache.saveItemPref(form.item, { payment: form.payment, category: form.category });
      if (state.expense.item === form.item) applyExpenseItemPrefs(form.item);
      const displayAmount = '$' + fAmt.toLocaleString('zh-TW');
      showToast(`記帳完成 ${form.item} ${displayAmount}`, 'success');
    })
    .withFailureHandler(error => {
      const leavingRow = captureRecentRow('recentExpenses', '.recent-item[data-temp-id="' + tempId + '"]');
      if (window.__activePendingExpenses) {
        window.__activePendingExpenses = window.__activePendingExpenses.filter(r => r.tempId !== tempId);
      }
      if (state.recentState && state.recentState.expense) {
        const expState = state.recentState.expense;
        if (Array.isArray(expState.records)) {
          expState.records = expState.records.filter(r => r.tempId !== tempId);
        }
        if (Array.isArray(expState.fullRecords)) {
          expState.fullRecords = expState.fullRecords.filter(r => r.tempId !== tempId);
        }
        if (isRecentDateFiltered('expense')) {
          applyRecentDateFilter('expense');
        } else {
          const displayList = expState.isFull ? (expState.records || []) : (expState.records || []).slice(0, 8);
          renderRecentList('recentExpenses', displayList, 'expense');
          updateRecentHeader('expense', expState.isFull, (expState.records || []).length);
        }
      }
      playRecentRowExit(leavingRow);
      if (fDay && state.dailyExpenses && state.dailyExpenses[fDay]) {
        state.dailyExpenses[fDay].total = Math.max(0, state.dailyExpenses[fDay].total - fAmt);
        state.dailyExpenses[fDay].count = Math.max(0, state.dailyExpenses[fDay].count - 1);
        updateTodayExpenseUI();
      }
      restoreExpenseForm(formSnapshot);
      showToast('記帳失敗，已還原輸入內容：' + (error.message || error), 'error');
    })
    .addExpense(form);
}

function submitIncome() {
  const form = {
    month: getMonth(),
    day: getDay('incomeDate'),
    item: state.income.item,
    category: state.income.category,
    amount: state.income.amount,
    note: document.getElementById('incomeNote').value,
  };

  if (!form.day) return showToast('請選擇日期', 'error');
  if (!form.item) return rejectEntryStep('income', 'item', '請選擇收入項目');
  if (!form.category) return rejectEntryStep('income', 'category', '請選擇收入總類');
  if (!form.amount || Number(form.amount) <= 0) return rejectEntryStep('income', 'amount', '請輸入收入金額');

  const formSnapshot = {
    ...form,
    quickComboId: quickComboApplied.income.id,
    quickComboNote: quickComboApplied.income.note,
  };
  const fAmt = Number(form.amount) || 0;

  const tempId = 'temp_inc_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
  const pendingRecord = {
    tempId: tempId,
    month: form.month,
    isPending: true,
    row: 'pending',
    day: form.day,
    item: form.item,
    category: form.category,
    amount: form.amount,
    note: form.note,
  };

  if (!window.__activePendingIncomes) window.__activePendingIncomes = [];
  window.__activePendingIncomes.unshift(pendingRecord);

  if (state.recentState && state.recentState.income) {
    const incState = state.recentState.income;
    if (!Array.isArray(incState.records)) incState.records = [];
    incState.records.unshift(pendingRecord);
    if (Array.isArray(incState.fullRecords) && incState.fullRecords !== incState.records) {
      incState.fullRecords.unshift(pendingRecord);
    }
    if (isRecentDateFiltered('income')) {
      applyRecentDateFilter('income');
    } else {
      renderRecentList('recentIncomes', incState.isFull ? incState.records : incState.records.slice(0, 8), 'income');
      const incFull = incState.isFull;
      updateRecentHeader('income', incFull, incState.records.length);
    }
    animatePendingRecentRow('recentIncomes', tempId);
  }

  clearIncomeAfterSave();
  showToast('收入已記錄（同步中…）', 'info');
  Motion.haptic('success');
  const incomeSubmitBtn = document.getElementById('incomeSubmit');
  playSubmitConfirm(incomeSubmitBtn);
  Motion.burst(incomeSubmitBtn, BURST_PALETTE.income);

  state.mutationVersion++;

  Api.server
    .withSuccessHandler(result => {
      if (window.__activePendingIncomes) {
        window.__activePendingIncomes = window.__activePendingIncomes.filter(r => r.tempId !== tempId);
      }
      handleMutationRecentUpdate(result, form.month);
      flashSyncedRecentRow('recentIncomes', form);
      const displayAmount = '$' + fAmt.toLocaleString('zh-TW');
      showToast(`記帳完成 ${displayAmount}`, 'success');
    })
    .withFailureHandler(error => {
      const leavingRow = captureRecentRow('recentIncomes', '.recent-item[data-temp-id="' + tempId + '"]');
      if (window.__activePendingIncomes) {
        window.__activePendingIncomes = window.__activePendingIncomes.filter(r => r.tempId !== tempId);
      }
      if (state.recentState && state.recentState.income) {
        const incState = state.recentState.income;
        if (Array.isArray(incState.records)) {
          incState.records = incState.records.filter(r => r.tempId !== tempId);
        }
        if (Array.isArray(incState.fullRecords)) {
          incState.fullRecords = incState.fullRecords.filter(r => r.tempId !== tempId);
        }
        if (isRecentDateFiltered('income')) {
          applyRecentDateFilter('income');
        } else {
          const displayList = incState.isFull ? (incState.records || []) : (incState.records || []).slice(0, 8);
          renderRecentList('recentIncomes', displayList, 'income');
          updateRecentHeader('income', incState.isFull, (incState.records || []).length);
        }
      }
      playRecentRowExit(leavingRow);
      restoreIncomeForm(formSnapshot);
      showToast('收入記錄失敗，已還原輸入內容：' + (error.message || error), 'error');
    })
    .addIncome(form);
}

function clearExpenseAfterSave() {
  state.expense.amount = '';
  state.expense.paid = isCreditCardPayment(state.expense.payment) ? 'X' : '';
  state.expense.item = '';
  state.expense.itemSuggested = false;
  state.expense.paymentTouched = false;
  state.expense.categoryTouched = false;
  if (!state.expense.category && state.data && state.data.options) {
    state.expense.category = prefer('生活費', state.data.options.expenseCategories);
  }
  document.getElementById('expenseNote').value = '';
  renderAmount('expense');
  updatePaidSectionVisibility();
  syncExpenseItemSelectionUI();
  applySuggestedExpenseItem();
  clearQuickComboSelection('expense');
}

function clearIncomeAfterSave() {
  state.income.amount = '';
  state.income.item = '';
  document.getElementById('incomeNote').value = '';
  renderAmount('income');
  const itemContainer = document.getElementById('incomeItemChoices');
  if (itemContainer) {
    itemContainer.querySelectorAll('.choice').forEach(x => {
      x.classList.remove('selected');
      x.setAttribute('aria-pressed', 'false');
    });
  }
  clearQuickComboSelection('income');
}

function restoreExpenseForm(snapshot) {
  if (!snapshot) return;
  state.expense.item = snapshot.item || '';
  state.expense.itemSuggested = false;
  state.expense.paymentTouched = Boolean(snapshot.paymentTouched);
  state.expense.categoryTouched = Boolean(snapshot.categoryTouched);
  restoreQuickComboSelection('expense', snapshot);
  state.expense.category = snapshot.category || '';
  state.expense.payment = snapshot.payment || '';
  state.expense.paid = snapshot.paid || '';
  state.expense.amount = String(snapshot.amount || '');
  const noteInput = document.getElementById('expenseNote');
  if (noteInput) noteInput.value = snapshot.note || '';
  renderAmount('expense');
  renderAllChoices();
}

function restoreIncomeForm(snapshot) {
  if (!snapshot) return;
  restoreQuickComboSelection('income', snapshot);
  state.income.item = snapshot.item || '';
  state.income.category = snapshot.category || '';
  state.income.amount = String(snapshot.amount || '');
  const noteInput = document.getElementById('incomeNote');
  if (noteInput) noteInput.value = snapshot.note || '';
  renderAmount('income');
  renderAllChoices();
}

function clearForms({ keepDates = false } = {}) {
  quickComboApplied.expense = { id: '', note: '' };
  quickComboApplied.income = { id: '', note: '' };
  state.expense.item = '';
  state.expense.itemSuggested = false;
  state.expense.paymentTouched = false;
  state.expense.categoryTouched = false;
  state.expense.category = prefer('生活費', state.data.options.expenseCategories);
  state.expense.payment = prefer('現金', state.data.options.paymentMethods);
  state.expense.paid = isCreditCardPayment(state.expense.payment) ? 'X' : '';
  state.expense.amount = '';
  state.income.item = '';
  state.income.category = prefer('生活費', state.data.options.incomeCategories);
  state.income.amount = '';
  document.getElementById('expenseNote').value = '';
  document.getElementById('incomeNote').value = '';
  renderAmount('expense');
  renderAmount('income');
  renderAllChoices();
  if (!keepDates) {
    setDatesForMonth(getMonth());
    applySuggestedExpenseItem();
  }
}
