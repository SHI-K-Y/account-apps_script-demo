function loadRecent(month, forceRefresh) {
  const reqMonth = month;
  const reqVersion = state.mutationVersion;
  const expLim = (state.recentState && state.recentState.expense && state.recentState.expense.isFull) ? 0 : 8;
  const incLim = (state.recentState && state.recentState.income && state.recentState.income.isFull) ? 0 : 8;

  Api.server
    .withSuccessHandler(data => {
      if (data && data.month) {
        LocalCache.saveRecent(data.month, data);
      }
      if (!data || data.month !== getMonth() || reqVersion !== state.mutationVersion) {
        return;
      }
      renderRecent(data);
    })
    .withFailureHandler(showServerError)
    .getRecentRecords(month, expLim, incLim, Boolean(forceRefresh));
}

function renderRecent(data) {
  if (!data) return;
  const expFull = state.recentState && state.recentState.expense ? state.recentState.expense.isFull : false;
  const incFull = state.recentState && state.recentState.income ? state.recentState.income.isFull : false;

  const fullExp = data.fullExpenses || data.expenses || [];
  const fullInc = data.fullIncomes || data.incomes || [];

  const rawExpRecords = expFull ? fullExp : (data.expenses || fullExp.slice(0, 8));
  const rawIncRecords = incFull ? fullInc : (data.incomes || fullInc.slice(0, 8));

  const pendingExp = (window.__activePendingExpenses && data.month)
    ? window.__activePendingExpenses.filter(r => r.month === data.month)
    : [];
  const pendingInc = (window.__activePendingIncomes && data.month)
    ? window.__activePendingIncomes.filter(r => r.month === data.month)
    : [];

  const expRecords = [...pendingExp, ...rawExpRecords];
  const incRecords = [...pendingInc, ...rawIncRecords];

  if (data.month && Array.isArray(data.fullExpenses)) {
    ccState.recordsByMonth[data.month] = data.fullExpenses;
  }

  if (state.recentState) {
    if (state.recentState.expense) {
      state.recentState.expense.records = expRecords;
      if (data.fullExpenses) state.recentState.expense.fullRecords = [...pendingExp, ...data.fullExpenses];
    }
    if (state.recentState.income) {
      state.recentState.income.records = incRecords;
      if (data.fullIncomes) state.recentState.income.fullRecords = [...pendingInc, ...data.fullIncomes];
    }
  }

  if (data.dailyExpenses) {
    state.dailyExpenses = data.dailyExpenses;
  }
  if (Object.prototype.hasOwnProperty.call(data, 'budget')) {
    state.budget = data.budget || null;
  } else if (state.budget && state.budget.month !== data.month) {
    state.budget = null;
  }

  if (isRecentDateFiltered('expense')) {
    applyRecentDateFilter('expense');
  } else {
    renderRecentList('recentExpenses', expRecords, 'expense');
  }

  if (isRecentDateFiltered('income')) {
    applyRecentDateFilter('income');
  } else {
    renderRecentList('recentIncomes', incRecords, 'income');
  }

  updateRecentHeader('expense', expFull, expRecords.length);
  updateLoadFullButton('expense', expFull, expRecords.length);

  updateRecentHeader('income', incFull, incRecords.length);
  updateLoadFullButton('income', incFull, incRecords.length);

  updateTodayExpenseUI();
  ReminderPrompt.onRecordsChanged();
}

function updateTodayExpenseUI() {
  const card = document.getElementById('todayExpenseCard');
  if (!card) return;

  const currentMonth = getMonth();
  const client = getClientToday();
  const expenseDateInput = document.getElementById('expenseDate');
  const selectedDateStr = (expenseDateInput && expenseDateInput.value) ? expenseDateInput.value : client.todayISO;

  const isCurrentMonth = (currentMonth === client.currentMonth);
  const isToday = isCurrentMonth && (selectedDateStr === client.todayISO);

  let targetDay = null;
  if (selectedDateStr) {
    const parts = selectedDateStr.split('-');
    if (parts.length === 3) {
      targetDay = parseInt(parts[2], 10);
    }
  }
  if (!targetDay || isNaN(targetDay)) {
    targetDay = parseInt(client.todayISO.split('-')[2], 10);
  }

  let dayTotal = 0;
  let dayCount = 0;

  if (state.dailyExpenses && state.dailyExpenses[targetDay]) {
    dayTotal = Number(state.dailyExpenses[targetDay].total) || 0;
    dayCount = Number(state.dailyExpenses[targetDay].count) || 0;
  } else if (state.recentState && state.recentState.expense && state.recentState.expense.records) {
    state.recentState.expense.records.forEach(r => {
      if (parseInt(r.day, 10) === targetDay) {
        dayTotal += (Number(r.amount) || 0);
        dayCount += 1;
      }
    });
  }

  const titleEl = document.getElementById('todayExpenseTitle');
  const dateBadgeEl = document.getElementById('todayExpenseDateBadge');
  const countBadgeEl = document.getElementById('todayExpenseCountBadge');
  const amountEl = document.getElementById('todayExpenseAmount');
  const subInfoEl = document.getElementById('todayExpenseSubInfo');
  const backTodayBtn = document.getElementById('todayExpenseBackTodayBtn');

  let dateText = '';
  if (selectedDateStr) {
    const p = selectedDateStr.split('-').map(Number);
    if (p.length === 3) {
      dateText = `${p[1]}月${p[2]}日`;
    }
  }

  // 每記一筆都會呼叫好幾次：文字沒變就不寫入（P06）
  const setText = ListRender.setText;
  if (isToday) {
    setText(titleEl, '今日總花費');
    setText(dateBadgeEl, `${dateText} 今天`);
    setText(subInfoEl, dayCount > 0 ? `今日累計支出 ${dayCount} 筆` : '今日尚無支出紀錄');
    if (backTodayBtn && backTodayBtn.style.display !== 'none') backTodayBtn.style.display = 'none';
  } else {
    setText(titleEl, isCurrentMonth ? '當日總花費' : `${dateText} 總花費`);
    setText(dateBadgeEl, `${dateText} (所選日期)`);
    setText(subInfoEl, dayCount > 0 ? `當日累計支出 ${dayCount} 筆` : '該日尚無支出紀錄');
    if (backTodayBtn) {
      const display = isCurrentMonth ? 'inline-block' : 'none';
      if (backTodayBtn.style.display !== display) backTodayBtn.style.display = display;
    }
  }

  if (countBadgeEl) {
    const prevCount = countBadgeEl._dayCount;
    setText(countBadgeEl, `共 ${dayCount} 筆`);
    countBadgeEl._dayCount = dayCount;
    if (typeof prevCount === 'number' && prevCount !== dayCount) {
      Motion.animate(countBadgeEl, {
        full: [
          { transform: 'scale(1)', easing: Motion.ease('out') },
          { transform: 'scale(1.18)', offset: 0.4, easing: Motion.ease('spring') },
          { transform: 'scale(1)' }
        ],
        lite: [{ opacity: 0.3 }, { opacity: 1 }]
      }, { duration: Motion.dur('slow') });
    }
  }

  if (amountEl) {
    if (typeof amountEl._countTarget !== 'number') {
      amountEl.textContent = FinanceUtils.format(dayTotal);
      amountEl._countTarget = dayTotal;
      amountEl._countCurrent = dayTotal;
    } else if (amountEl._countTarget !== dayTotal) {
      Motion.countUp(amountEl, amountEl._countTarget, dayTotal, { format: v => FinanceUtils.format(Math.round(v)) });
    }
  }

  BudgetView.renderToday(document.getElementById('todayBudgetLine'), {
    budget: state.budget,
    month: currentMonth,
    isToday: isToday,
    isCurrentMonth: isCurrentMonth,
  });
}

function updateRecentHeader(type, isFull, count) {
  const isExpense = (type === 'expense');
  const countElId = isExpense ? 'recentExpenseCount' : 'recentIncomeCount';
  const el = document.getElementById(countElId);
  if (!el) return;

  if (isFull) {
    ListRender.setText(el, count === 0 ? '當月無紀錄' : `當月全部共 ${count} 筆`);
  } else {
    ListRender.setText(el, '最後 8 筆');
  }
}

function updateLoadFullButton(type, isFull, totalCount) {
  const isExpense = (type === 'expense');
  const btnId = isExpense ? 'loadFullExpensesBtn' : 'loadFullIncomesBtn';
  const btn = document.getElementById(btnId);
  if (!btn) return;

  if (btn.classList.contains('loading')) btn.classList.remove('loading');
  if (btn.disabled) btn.disabled = false;

  const count = typeof totalCount === 'number' ? totalCount : 0;

  // 內容沒變就不重建按鈕（P06：每記一筆都會呼叫）；setLoadFullButtonLoading 換掉內容時會清掉快取
  let title;
  let html;
  if (isFull) {
    if (!btn.classList.contains('is-expanded')) btn.classList.add('is-expanded');
    if (count > 8) {
      title = `收合為最近 8 筆${isExpense ? '支出' : '收入'}紀錄`;
      html = `
        ${iconHtml('caret-up', 'regular', 'ic-15 load-full-icon')}
        <span class="load-full-text">收合至最近 8 筆</span>
      `;
    } else {
      title = `已顯示當月全部共 ${count} 筆紀錄`;
      html = `
        ${iconHtml('check-circle', 'regular', 'ic-15 load-full-icon')}
        <span class="load-full-text">已載入全部交易紀錄（共 ${count} 筆）</span>
      `;
    }
  } else {
    if (btn.classList.contains('is-expanded')) btn.classList.remove('is-expanded');
    title = `載入當月完整${isExpense ? '支出' : '收入'}紀錄`;
    html = `
      ${iconHtml('file-text', 'regular', 'ic-15 load-full-icon')}
      <span class="load-full-text">載入完整交易紀錄</span>
    `;
  }
  if (btn.title !== title) btn.title = title;
  ListRender.setHtml(btn, html);
}

function setLoadFullButtonLoading(btn, isLoading) {
  if (!btn) return;
  btn.disabled = isLoading;
  if (isLoading) {
    btn.classList.add('loading');
    btn._lrHtml = null;
    btn.innerHTML = `
      ${iconHtml('spinner-gap', 'regular', 'ic-15 load-full-icon spinner')}
      <span class="load-full-text">載入中…</span>
    `;
  } else {
    btn.classList.remove('loading');
  }
}

function resetRecentFullState() {
  if (!state.recentState) return;
  state.recentState.expense.isFull = false;
  state.recentState.expense.records = null;
  state.recentState.expense.fullRecords = null;
  state.recentState.income.isFull = false;
  state.recentState.income.records = null;
  state.recentState.income.fullRecords = null;

  ['expense', 'income'].forEach(type => {
    const isExpense = (type === 'expense');
    const dateInput = document.getElementById(isExpense ? 'expenseFilterDate' : 'incomeFilterDate');
    const clearBtn = document.getElementById(isExpense ? 'expenseFilterClearBtn' : 'incomeFilterClearBtn');
    const summary = document.getElementById(isExpense ? 'expenseFilterSummary' : 'incomeFilterSummary');
    const customLabelEl = document.getElementById(isExpense ? 'expenseFilterCustomLabel' : 'incomeFilterCustomLabel');
    if (dateInput) dateInput.value = '';
    if (customLabelEl) customLabelEl.textContent = '選擇日期';
    if (clearBtn) clearBtn.style.display = 'none';
    if (summary) summary.style.display = 'none';
    closeCalendar(isExpense ? 'expenseFilter' : 'incomeFilter');
    setActiveDateChip(type, 'all');
  });

  updateRecentDateFilterBounds(getMonth());
  updateRecentHeader('expense', false, 8);
  updateLoadFullButton('expense', false, 8);
  updateRecentHeader('income', false, 8);
  updateLoadFullButton('income', false, 8);
}

function isRecentDateFiltered(type) {
  const isExpense = (type === 'expense');
  const input = document.getElementById(isExpense ? 'expenseFilterDate' : 'incomeFilterDate');
  return Boolean(input && input.value && input.value.trim() !== '');
}

function setActiveDateChip(type, activeName) {
  const isExpense = (type === 'expense');
  const allBtn = document.getElementById(isExpense ? 'expenseFilterAllBtn' : 'incomeFilterAllBtn');
  const todayBtn = document.getElementById(isExpense ? 'expenseFilterTodayBtn' : 'incomeFilterTodayBtn');
  const yesterdayBtn = document.getElementById(isExpense ? 'expenseFilterYesterdayBtn' : 'incomeFilterYesterdayBtn');
  const calBtn = document.getElementById(isExpense ? 'expenseFilterCalBtn' : 'incomeFilterCalBtn');

  if (allBtn) allBtn.classList.toggle('active', activeName === 'all');
  if (todayBtn) todayBtn.classList.toggle('active', activeName === 'today');
  if (yesterdayBtn) yesterdayBtn.classList.toggle('active', activeName === 'yesterday');
  if (calBtn) calBtn.classList.toggle('active', activeName === 'custom');
}

function isRecordOnDay(record, targetDay) {
  if (!record || targetDay === null || targetDay === undefined) return false;
  const numDay = parseInt(targetDay, 10);
  const recDayNum = parseInt(record.day, 10);
  if (!isNaN(recDayNum) && !isNaN(numDay)) {
    return recDayNum === numDay;
  }
  const dayStr = String(record.day || '').trim();
  if (dayStr === String(targetDay) || dayStr === String(pad(numDay))) {
    return true;
  }
  if (dayStr.includes('-')) {
    const parts = dayStr.split('-');
    return parseInt(parts[parts.length - 1], 10) === numDay;
  }
  return false;
}

function applyRecentDateFilter(type) {
  const isExpense = (type === 'expense');
  const dateInput = document.getElementById(isExpense ? 'expenseFilterDate' : 'incomeFilterDate');
  const clearBtn = document.getElementById(isExpense ? 'expenseFilterClearBtn' : 'incomeFilterClearBtn');
  const summary = document.getElementById(isExpense ? 'expenseFilterSummary' : 'incomeFilterSummary');
  const countEl = document.getElementById(isExpense ? 'expenseFilteredCount' : 'incomeFilteredCount');
  const totalEl = document.getElementById(isExpense ? 'expenseFilteredTotal' : 'incomeFilteredTotal');
  const dateLabelEl = document.getElementById(isExpense ? 'expenseFilteredDateLabel' : 'incomeFilteredDateLabel');
  const customLabelEl = document.getElementById(isExpense ? 'expenseFilterCustomLabel' : 'incomeFilterCustomLabel');
  const containerId = isExpense ? 'recentExpenses' : 'recentIncomes';

  if (!state.recentState || !state.recentState[type]) return;
  const currentRecState = state.recentState[type];
  const allRecords = currentRecState.fullRecords || currentRecState.records || [];

  const val = dateInput ? dateInput.value.trim() : '';

  if (!val) {
    setActiveDateChip(type, 'all');
    if (customLabelEl) customLabelEl.textContent = '選擇日期';
    if (clearBtn) clearBtn.style.display = 'none';
    if (summary) summary.style.display = 'none';
    const displayList = currentRecState.isFull ? allRecords : allRecords.slice(0, 8);
    renderRecentList(containerId, displayList, type, false);
    updateRecentHeader(type, currentRecState.isFull, displayList.length);
    return;
  }

  const parts = val.split('-').map(Number);
  if (parts.length !== 3 || isNaN(parts[2])) {
    return;
  }
  const targetDay = parts[2];
  const targetMonth = parts[1];

  if (clearBtn) clearBtn.style.display = 'inline-flex';

  const clientToday = getClientToday();
  const [cy, cm, cd] = clientToday.todayISO.split('-').map(Number);
  const yDate = new Date(cy, cm - 1, cd - 1);
  const yISO = `${yDate.getFullYear()}-${pad(yDate.getMonth() + 1)}-${pad(yDate.getDate())}`;

  if (val === clientToday.todayISO) {
    setActiveDateChip(type, 'today');
    if (customLabelEl) customLabelEl.textContent = '選擇日期';
    if (dateLabelEl) dateLabelEl.textContent = `${targetMonth}月${targetDay}日 (今天)`;
  } else if (val === yISO) {
    setActiveDateChip(type, 'yesterday');
    if (customLabelEl) customLabelEl.textContent = '選擇日期';
    if (dateLabelEl) dateLabelEl.textContent = `${targetMonth}月${targetDay}日 (昨天)`;
  } else {
    setActiveDateChip(type, 'custom');
    if (customLabelEl) customLabelEl.textContent = `${targetMonth}/${targetDay}`;
    if (dateLabelEl) dateLabelEl.textContent = `${targetMonth}月${targetDay}日`;
  }

  const filtered = allRecords.filter(r => isRecordOnDay(r, targetDay));
  const sumTotal = filtered.reduce((acc, r) => acc + (Math.abs(parseAmount(r.amount)) || 0), 0);

  if (countEl) countEl.textContent = filtered.length;
  if (totalEl) totalEl.textContent = '$' + Fmt.num(sumTotal);
  if (summary) summary.style.display = 'flex';

  const countElHeader = document.getElementById(isExpense ? 'recentExpenseCount' : 'recentIncomeCount');
  if (countElHeader) {
    countElHeader.textContent = `${targetDay}日共 ${filtered.length} 筆`;
  }

  renderRecentList(containerId, filtered, type, true);
}

function clearRecentDateFilter(type) {
  const isExpense = (type === 'expense');
  const dateInput = document.getElementById(isExpense ? 'expenseFilterDate' : 'incomeFilterDate');
  const customLabelEl = document.getElementById(isExpense ? 'expenseFilterCustomLabel' : 'incomeFilterCustomLabel');
  if (dateInput) {
    dateInput.value = '';
  }
  if (customLabelEl) {
    customLabelEl.textContent = '選擇日期';
  }
  closeCalendar(isExpense ? 'expenseFilter' : 'incomeFilter');
  applyRecentDateFilter(type);
}

function setRecentDateFilterShortcut(type, shortcut) {
  const isExpense = (type === 'expense');
  const dateInputId = isExpense ? 'expenseFilterDate' : 'incomeFilterDate';
  closeCalendar(isExpense ? 'expenseFilter' : 'incomeFilter');
  if (shortcut === 'today') {
    setToday(dateInputId);
  } else if (shortcut === 'yesterday') {
    setYesterday(dateInputId);
  }
}

function updateRecentDateFilterBounds(monthStr) {
  const m = monthStr || getMonth();
  if (!m || !m.includes('.')) return;
  const [year, monthNum] = m.split('.').map(Number);
  const daysInMonth = new Date(year, monthNum, 0).getDate();
  const minDate = `${year}-${pad(monthNum)}-01`;
  const maxDate = `${year}-${pad(monthNum)}-${pad(daysInMonth)}`;

  ['expense', 'income'].forEach(type => {
    const isExpense = (type === 'expense');
    const dateInput = document.getElementById(isExpense ? 'expenseFilterDate' : 'incomeFilterDate');
    if (dateInput) {
      dateInput.min = minDate;
      dateInput.max = maxDate;
    }
  });
}

function bindRecentDateFilterEvents() {
  ['expense', 'income'].forEach(type => {
    const isExpense = (type === 'expense');
    const allBtn = document.getElementById(isExpense ? 'expenseFilterAllBtn' : 'incomeFilterAllBtn');
    const todayBtn = document.getElementById(isExpense ? 'expenseFilterTodayBtn' : 'incomeFilterTodayBtn');
    const yesterdayBtn = document.getElementById(isExpense ? 'expenseFilterYesterdayBtn' : 'incomeFilterYesterdayBtn');
    const dateInput = document.getElementById(isExpense ? 'expenseFilterDate' : 'incomeFilterDate');
    const clearBtn = document.getElementById(isExpense ? 'expenseFilterClearBtn' : 'incomeFilterClearBtn');

    if (allBtn) {
      allBtn.addEventListener('click', () => clearRecentDateFilter(type));
    }
    if (todayBtn) {
      todayBtn.addEventListener('click', () => setRecentDateFilterShortcut(type, 'today'));
    }
    if (yesterdayBtn) {
      yesterdayBtn.addEventListener('click', () => setRecentDateFilterShortcut(type, 'yesterday'));
    }
    if (dateInput) {
      dateInput.addEventListener('change', () => applyRecentDateFilter(type));
      dateInput.addEventListener('input', () => applyRecentDateFilter(type));
    }
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        clearRecentDateFilter(type);
      });
    }

    initCalendarPicker(isExpense ? 'expenseFilter' : 'incomeFilter');
  });
}

function toggleFullRecords(type) {
  const isExpense = (type === 'expense');
  const btnId = isExpense ? 'loadFullExpensesBtn' : 'loadFullIncomesBtn';
  const containerId = isExpense ? 'recentExpenses' : 'recentIncomes';
  const btn = document.getElementById(btnId);
  const month = getMonth();

  if (!state.recentState) {
    state.recentState = {
      expense: { isFull: false, records: null, fullRecords: null },
      income: { isFull: false, records: null, fullRecords: null }
    };
  }
  const currentRecState = state.recentState[type];

  if (currentRecState.isFull) {
    currentRecState.isFull = false;
    const sourceList = currentRecState.fullRecords || currentRecState.records;
    if (Array.isArray(sourceList)) {
      const top8 = sourceList.slice(0, 8);
      currentRecState.records = [...top8];
      if (isRecentDateFiltered(type)) {
        applyRecentDateFilter(type);
      } else {
        renderRecentList(containerId, top8, type, false);
        updateRecentHeader(type, false, top8.length);
      }
      updateLoadFullButton(type, false, sourceList.length);
      showToast(`已切換為最近 8 筆${isExpense ? '支出' : '收入'}紀錄`, 'info');
      return;
    }
    loadRecent(month);
    return;
  }

  if (Array.isArray(currentRecState.fullRecords)) {
    currentRecState.isFull = true;
    currentRecState.records = [...currentRecState.fullRecords];
    if (isRecentDateFiltered(type)) {
      applyRecentDateFilter(type);
    } else {
      renderRecentList(containerId, currentRecState.records, type, false);
      updateRecentHeader(type, true, currentRecState.records.length);
    }
    updateLoadFullButton(type, true, currentRecState.records.length);
    showToast(`已載入當月完整${isExpense ? '支出' : '收入'}紀錄（共 ${currentRecState.records.length} 筆）`, 'success');
    return;
  }

  setLoadFullButtonLoading(btn, true);

  Api.server
    .withSuccessHandler(res => {
      setLoadFullButtonLoading(btn, false);
      const records = (res && res.records) || (isExpense ? res.expenses : res.incomes) || [];
      currentRecState.isFull = true;
      currentRecState.records = [...records];
      currentRecState.fullRecords = [...records];
      if (res && res.dailyExpenses) {
        state.dailyExpenses = res.dailyExpenses;
      }
      if (isRecentDateFiltered(type)) {
        applyRecentDateFilter(type);
      } else {
        renderRecentList(containerId, records, type, false);
        updateRecentHeader(type, true, records.length);
      }
      updateLoadFullButton(type, true, records.length);
      updateTodayExpenseUI();
      showToast(`已載入當月完整${isExpense ? '支出' : '收入'}紀錄（共 ${records.length} 筆）`, 'success');
    })
    .withFailureHandler(err => {
      setLoadFullButtonLoading(btn, false);
      updateLoadFullButton(type, false, 8);
      showServerError(err);
    })
    .getFullRecords(month, type);
}

// 明細列的點擊一律委派到清單容器（P06）：每次重繪不必再逐筆綁事件。
//   - 修改／刪除鈕：用 closest('.edit-btn')／closest('.delete-btn') 找到按鈕，紀錄取自列上的 _record；
//     處理函式放在容器的 _recentHandlers（搜尋頁的清單會帶自己的 onEdit／onDelete）。
//   - 手機（沒有 hover）點擊明細列 → 切換 .is-open 展開完整資訊；樣式在 20-uiverse-effects.css。
//     桌機改由 CSS :hover 展開，這裡不處理。一次只展開一筆，點列表以外的地方會收合。
let recentToggleDocBound = false;
function bindRecentList(container, opts) {
  if (!container) return;
  const o = opts || {};
  container._recentHandlers = { onEdit: o.onEdit || null, onDelete: o.onDelete || null };
  if (o.toggle) container._recentToggle = true;
  if (container._recentListBound) return;
  container._recentListBound = true;
  container.addEventListener('click', e => {
    const target = e.target;
    const btn = target && target.closest ? target.closest('.edit-btn, .delete-btn') : null;
    if (btn && container.contains(btn)) {
      // 和以前綁在按鈕上一樣：按鈕的點擊不會冒泡到列（不會順便展開／收合）或更外層
      e.stopPropagation();
      const row = btn.closest('.recent-item');
      const record = row && row._record;
      if (btn.disabled || !record) return;
      const type = row._recentType;
      const h = container._recentHandlers || {};
      if (btn.classList.contains('edit-btn')) {
        if (h.onEdit) h.onEdit(record, type); else openEditModal(record, type);
      } else if (h.onDelete) {
        h.onDelete(record, type);
      } else {
        openDeleteModal(record, type);
      }
      return;
    }
    if (!container._recentToggle) return;
    if (window.matchMedia && window.matchMedia('(hover: hover)').matches) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).length) return;
    const item = target && target.closest && target.closest('.recent-item');
    if (!item || !container.contains(item)) return;
    const willOpen = !item.classList.contains('is-open');
    container.querySelectorAll('.recent-item.is-open').forEach(el => el.classList.remove('is-open'));
    if (willOpen) item.classList.add('is-open');
  });
  if (o.toggle && !recentToggleDocBound) {
    recentToggleDocBound = true;
    document.addEventListener('click', e => {
      if (e.target.closest && e.target.closest('.recent-item')) return;
      document.querySelectorAll('#recentExpenses .recent-item.is-open, #recentIncomes .recent-item.is-open')
        .forEach(el => el.classList.remove('is-open'));
    });
  }
}

/** 列的 key：同步中的列用 tempId，其餘用「月份｜類型｜列號」。 */
function recentItemKey(record, type) {
  if (record && record.tempId && record.isPending) return 't:' + record.tempId;
  return (record.month || getMonth()) + '|' + type + '|' + record.row;
}

/** 列的內容識別：刪除後列號往上遞補、或同步中變成已同步時，用它認回同一個節點。 */
function recentItemIdent(record, type) {
  const d = parseInt(record.day, 10);
  return [record.month || getMonth(), type, isNaN(d) ? String(record.day || '') : d, record.item || '', record.category || '',
    record.payment || '', record.paid || '', parseAmount(record.amount), record.note || ''].join('\u0001');
}

/** 畫面上會用到的所有內容；和節點上次的簽章相同就完全不動。 */
function recentItemSig(record, type, opts, ident) {
  const o = opts || {};
  return [ident === undefined ? recentItemIdent(record, type) : ident, record.row, record.tempId || '', record.isPending ? 1 : 0,
    getItemIcon(record.item) || '', itemDisplayName(record.item), o.locked ? 1 : 0, o.lockedHint || '',
    o.terms && o.terms.length ? o.terms.join(' ') : '', o.dateLabel || ''].join('\u0002');
}

function renderRecentList(containerId, records, type, isFiltered) {
  const container = document.getElementById(containerId);
  if (!container) return;
  bindRecentList(container, { toggle: true });
  const filterInput = document.getElementById(containerId === 'recentIncomes' ? 'incomeFilterDate' : 'expenseFilterDate');
  const recState = state.recentState && state.recentState[type];
  const isFull = Boolean(recState && recState.isFull);
  const listKey = [getMonth(), filterInput ? filterInput.value : '', isFull ? 'full' : 'top',
    (records && records.length) ? 'items' : 'empty'].join('|');
  const shouldStagger = container.dataset.listKey !== listKey;
  if (shouldStagger) container.dataset.listKey = listKey;

  const res = ListRender.reconcile(container, records || [], {
    key: r => recentItemKey(r, type),
    ident: r => recentItemIdent(r, type),
    sig: (r, i, ident) => recentItemSig(r, type, null, ident),
    create: (r, i, ident) => buildRecentItem(r, type, null, ident),
    update: (el, r, i, ident) => patchRecentItem(el, r, type, null, ident),
    place: (el, r) => { el._record = r; },
    empty: isFiltered
      ? '<div class="empty">該日期尚無交易紀錄。</div>'
      : '<div class="empty">這個月還沒有紀錄。</div>',
    chunk: { listId: listKey.replace(/\|(items|empty)$/, '') },
  });
  // 進場動畫只給這次新出現的節點；沿用的節點不重播
  if (shouldStagger && res.created.length) Motion.staggerIn(res.created, { max: 12, stagger: 30 });
}

function animatePendingRecentRow(containerId, tempId) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const row = container.querySelector('.recent-item[data-temp-id="' + tempId + '"]');
  if (row) Motion.expandIn(row);
}

function captureRecentRow(containerId, selector) {
  const container = document.getElementById(containerId);
  if (!container) return null;
  const el = container.querySelector(selector);
  if (!el) return null;
  // 這個節點接下來要播刪除動畫：重繪時不能拿它去顯示別筆紀錄（列號會往上遞補）
  ListRender.markLeaving(el);
  return { el: el, containerId: containerId, index: Array.prototype.indexOf.call(container.children, el) };
}

function playRecentRowExit(snapshot) {
  if (!snapshot || !snapshot.el) return;
  const el = snapshot.el;
  if (!el.isConnected) {
    const container = document.getElementById(snapshot.containerId);
    if (!container || Motion.level() === 'off') return;
    el.getAnimations && el.getAnimations().forEach(a => a.cancel());
    el.classList.add('is-leaving');
    el.setAttribute('aria-hidden', 'true');
    el.inert = true;
    const ref = container.children[snapshot.index] || null;
    container.insertBefore(el, ref);
  }
  Motion.collapseOut(el);
}

function flashSyncedRecentRow(containerId, form) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const same = r => r && !r.isPending &&
    String(parseInt(r.day, 10)) === String(parseInt(form.day, 10)) &&
    r.item === form.item &&
    Number(parseAmount(r.amount)) === Number(form.amount) &&
    String(r.note || '') === String(form.note || '');
  const row = Array.prototype.find.call(container.querySelectorAll('.recent-item'), el => same(el._record));
  if (!row) return;
  clearTimeout(row._syncTimer);
  // 重新觸發 ::after 的閃光：已經在閃時換成同內容的另一組 keyframes（換名字就會重播），
  // 不必先拿掉 class 再強制重算（這個頁面有 size container，重算樣式也會連帶排版）
  if (row.classList.contains('sync-ok')) row.classList.toggle('sync-alt');
  else row.classList.add('sync-ok');
  const strong = row.querySelector('.recent-main strong');
  let check = row.querySelector('.recent-sync-check');
  if (strong && !check) {
    check = document.createElement('span');
    check.className = 'recent-sync-check';
    check.innerHTML = iconHtml('check');
    check.setAttribute('aria-label', '已同步');
    strong.appendChild(check);
    Motion.animate(check, {
      full: [{ opacity: 0, transform: 'scale(0.4)' }, { opacity: 1, transform: 'scale(1)' }],
      lite: [{ opacity: 0 }, { opacity: 1 }]
    }, { duration: Motion.dur('slow'), easing: Motion.ease('spring') });
  }
  row._syncTimer = setTimeout(() => {
    row.classList.remove('sync-ok', 'sync-alt');
    if (check && check.isConnected) {
      Motion.animate(check, [{ opacity: 1 }, { opacity: 0 }], { duration: Motion.dur('base'), fill: 'forwards' })
        .then(() => check.remove());
    }
  }, 1600);
}

const BURST_PALETTE = {
  expense: ['--burst-exp-1', '--burst-exp-2', '--burst-exp-3', '--burst-exp-4'],
  income: ['--burst-inc-1', '--burst-inc-2', '--burst-inc-3', '--burst-inc-4'],
  fx: ['--burst-fx-1', '--burst-fx-2', '--burst-fx-3', '--burst-fx-4'],
};

function playSubmitConfirm(btn) {
  const level = Motion.level();
  if (!btn || level === 'off') return;
  let label = btn.querySelector('.submit-label');
  if (!label) {
    label = document.createElement('span');
    label.className = 'submit-label';
    // 外框流光圖層（.uv-btn-ring，UvFx）要留在按鈕的第一層，絕對定位才會以按鈕為準
    Array.from(btn.childNodes).forEach(n => {
      if (!(n.nodeType === 1 && n.classList.contains('uv-btn-ring'))) label.appendChild(n);
    });
    btn.appendChild(label);
  }
  let check = btn.querySelector('.submit-check');
  if (!check) {
    check = document.createElement('span');
    check.className = 'submit-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M5 12.5l4.5 4.5L19 7.5" pathLength="1"></path></svg>';
    btn.appendChild(check);
  }
  const path = check.querySelector('path');
  (btn._confirmAnims || []).forEach(a => a && a.cancel && a.cancel());
  const total = 1000;
  const opts = { duration: total, easing: 'linear' };
  const anims = [];
  const run = (el, frames) => {
    try { anims.push(el.animate(frames, opts)); } catch (e) {}
  };
  run(label, [{ opacity: 1 }, { opacity: 0, offset: 0.12 }, { opacity: 0, offset: 0.82 }, { opacity: 1 }]);
  run(check, [{ opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.82 }, { opacity: 0 }]);
  if (level === 'full' && path) {
    run(path, [
      { strokeDashoffset: 1, offset: 0 },
      { strokeDashoffset: 1, offset: 0.1, easing: Motion.ease('out') },
      { strokeDashoffset: 0, offset: 0.52 },
      { strokeDashoffset: 0, offset: 1 }
    ]);
  }
  btn._confirmAnims = anims;
}

// 明細列的骨架只組一次，之後每列 cloneNode（P06：不必每列 createElement 十幾次、再解析兩次按鈕圖示的 HTML）
let recentItemTemplate = null;
function buildRecentItem(record, type, opts, ident) {
  if (!recentItemTemplate) {
    recentItemTemplate = document.createElement('div');
    recentItemTemplate.className = 'recent-item';
    recentItemTemplate.innerHTML =
      '<div class="recent-day"></div>' +
      '<div class="recent-main"><strong></strong><small></small></div>' +
      '<div class="recent-right"><div class="recent-amount"></div>' +
        '<div class="recent-actions">' +
          '<button class="recent-act-btn edit-btn" type="button">' + iconHtml('note-pencil', 'regular', 'ic-14') + '</button>' +
          '<button class="recent-act-btn delete-btn" type="button">' + iconHtml('trash', 'regular', 'ic-14') + '</button>' +
        '</div>' +
      '</div>';
  }
  const item = recentItemTemplate.cloneNode(true);
  const day = item.firstChild;
  const main = day.nextSibling;
  const right = main.nextSibling;
  const actions = right.lastChild;
  item._rv = {
    day: day, main: main, strong: main.firstChild, small: main.lastChild, amount: right.firstChild,
    edit: actions.firstChild, del: actions.lastChild, dateEl: null,
  };
  patchRecentItem(item, record, type, opts, ident);
  return item;
}

function setRecentActionState(btn, cache, key, enabled, hint, activeLabel) {
  const label = enabled ? activeLabel : hint;
  const sig = (enabled ? '1' : '0') + label;
  if (cache[key] === sig) return;
  cache[key] = sig;
  btn.disabled = !enabled;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.style.opacity = enabled ? '' : '0.35';
  btn.style.pointerEvents = enabled ? '' : 'none';
}

/**
 * 只更新有變的部分（P06）：重繪時沿用同一個節點，日期、項目、明細、金額、按鈕狀態各自比對上次的值，
 * 相同就不碰 DOM。修改／刪除的點擊由 bindRecentList 委派處理。
 */
function patchRecentItem(item, record, type, opts, ident) {
  opts = opts || {};
  if (ident === undefined) ident = recentItemIdent(record, type);
  const v = item._rv;
  const prev = v.vals || (v.vals = {});
  const terms = opts.terms && opts.terms.length ? opts.terms : null;
  const hl = text => highlightMatchesHtml(text, terms);
  const locked = Boolean(opts.locked);
  const pending = Boolean(record.isPending);

  if (prev.ident !== undefined && prev.ident !== ident) {
    // 換成另一筆內容時收起手機上展開的明細（以前整份重建也會收起）
    item.classList.remove('is-open');
  }
  prev.ident = ident;
  item._recentType = type;
  if (item.classList.contains('is-pending') !== pending) item.classList.toggle('is-pending', pending);
  const rowStr = String(record.row);
  if (item.dataset.row !== rowStr) item.dataset.row = rowStr;
  if (record.tempId) {
    if (item.dataset.tempId !== record.tempId) item.dataset.tempId = record.tempId;
  } else if (item.dataset.tempId !== undefined) {
    delete item.dataset.tempId;
  }

  const parsedDay = parseInt(record.day, 10);
  ListRender.setText(v.day, !isNaN(parsedDay) ? `${parsedDay}日` : (record.day ? `${record.day}日` : '未填'));

  const itemIcon = getItemIcon(record.item);
  const itemIconHtml = itemIcon ? '<span class="item-inline-icon" aria-hidden="true">' + iconHtml(itemIcon) + '</span>' : '';
  const strongHtml = itemIconHtml + (terms ? hl(itemDisplayName(record.item)) : escHtml(itemDisplayName(record.item))) +
    (pending ? '<span class="recent-pending-badge">同步中…</span>' : '');
  if (prev.strong !== strongHtml) {
    prev.strong = strongHtml;
    v.strong.innerHTML = strongHtml;
  }

  const dateLabel = opts.dateLabel || '';
  if (dateLabel) {
    if (!v.dateEl) {
      v.dateEl = document.createElement('div');
      v.dateEl.className = 'recent-fulldate';
      v.main.insertBefore(v.dateEl, v.small);
    }
    ListRender.setText(v.dateEl, dateLabel);
  } else if (v.dateEl) {
    v.dateEl.remove();
    v.dateEl = null;
  }

  let smallKey;
  if (type === 'expense') {
    const paidLabel = record.paid === 'O' ? '已繳' : record.paid === 'X' ? '未繳' : '未設定';
    smallKey = terms
      ? 'h' + `${hl(record.category)}｜${hl(record.payment)}｜${escHtml(paidLabel)}${record.note ? '｜' + hl(record.note) : ''}`
      : 't' + `${record.category}｜${record.payment}｜${paidLabel}${record.note ? '｜' + record.note : ''}`;
  } else {
    smallKey = terms
      ? 'h' + `${hl(record.category)}${record.note ? '｜' + hl(record.note) : ''}`
      : 't' + `${record.category}${record.note ? '｜' + record.note : ''}`;
  }
  if (prev.small !== smallKey) {
    prev.small = smallKey;
    if (smallKey.charAt(0) === 'h') v.small.innerHTML = smallKey.slice(1);
    else v.small.textContent = smallKey.slice(1);
  }

  const num = parseAmount(record.amount);
  const sign = num < 0 ? '-' : (type === 'income' ? '+' : '');
  const amountKey = sign + num;
  if (prev.amount !== amountKey) {
    prev.amount = amountKey;
    v.amount.textContent = `${sign}$${Fmt.num(Math.abs(num))}`;
  }

  const enabled = !pending && !locked;
  const lockHint = what => (pending ? '資料同步中，暫無法' + what : (opts.lockedHint || '資料更新中，暫無法' + what));
  setRecentActionState(v.edit, prev, 'edit', enabled, lockHint('修改'), '修改此筆交易紀錄');
  setRecentActionState(v.del, prev, 'del', enabled, lockHint('刪除'), '刪除此筆交易紀錄');
  item._record = record;
}

function normalizeSearchText(text) {
  const str = String(text == null ? '' : text);
  let out = '';
  for (let i = 0; i < str.length; i++) {
    let ch = str.charAt(i);
    const code = ch.charCodeAt(0);
    if (code >= 0xFF01 && code <= 0xFF5E) {
      ch = String.fromCharCode(code - 0xFEE0);
    } else if (code === 0x3000) {
      ch = ' ';
    }
    const lower = ch.toLowerCase();
    out += lower.length === 1 ? lower : ch;
  }
  return out;
}

function highlightMatchesHtml(text, terms) {
  const raw = String(text == null ? '' : text);
  if (!raw || !terms || !terms.length) return escHtml(raw);
  const norm = normalizeSearchText(raw);
  const hit = new Array(raw.length).fill(false);
  let any = false;
  terms.forEach(term => {
    if (!term) return;
    let from = 0;
    for (;;) {
      const idx = norm.indexOf(term, from);
      if (idx === -1) break;
      for (let k = idx; k < idx + term.length; k++) hit[k] = true;
      any = true;
      from = idx + term.length;
    }
  });
  if (!any) return escHtml(raw);

  let html = '';
  let i = 0;
  while (i < raw.length) {
    let j = i;
    while (j < raw.length && hit[j] === hit[i]) j++;
    const seg = escHtml(raw.slice(i, j));
    html += hit[i] ? '<mark class="sr-mark">' + seg + '</mark>' : seg;
    i = j;
  }
  return html;
}
