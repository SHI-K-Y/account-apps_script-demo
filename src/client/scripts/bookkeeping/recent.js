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

  if (isToday) {
    if (titleEl) titleEl.textContent = '今日總花費';
    if (dateBadgeEl) dateBadgeEl.textContent = `${dateText} 今天`;
    if (subInfoEl) subInfoEl.textContent = dayCount > 0 ? `今日累計支出 ${dayCount} 筆` : '今日尚無支出紀錄';
    if (backTodayBtn) backTodayBtn.style.display = 'none';
  } else {
    if (titleEl) titleEl.textContent = isCurrentMonth ? '當日總花費' : `${dateText} 總花費`;
    if (dateBadgeEl) dateBadgeEl.textContent = `${dateText} (所選日期)`;
    if (subInfoEl) subInfoEl.textContent = dayCount > 0 ? `當日累計支出 ${dayCount} 筆` : '該日尚無支出紀錄';
    if (backTodayBtn) {
      backTodayBtn.style.display = isCurrentMonth ? 'inline-block' : 'none';
    }
  }

  if (countBadgeEl) {
    const prevCount = countBadgeEl._dayCount;
    countBadgeEl.textContent = `共 ${dayCount} 筆`;
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
}

function updateRecentHeader(type, isFull, count) {
  const isExpense = (type === 'expense');
  const countElId = isExpense ? 'recentExpenseCount' : 'recentIncomeCount';
  const el = document.getElementById(countElId);
  if (!el) return;

  if (isFull) {
    if (count === 0) {
      el.textContent = '當月無紀錄';
    } else {
      el.textContent = `當月全部共 ${count} 筆`;
    }
  } else {
    el.textContent = '最後 8 筆';
  }
}

function updateLoadFullButton(type, isFull, totalCount) {
  const isExpense = (type === 'expense');
  const btnId = isExpense ? 'loadFullExpensesBtn' : 'loadFullIncomesBtn';
  const btn = document.getElementById(btnId);
  if (!btn) return;

  btn.classList.remove('loading');
  btn.disabled = false;

  const count = typeof totalCount === 'number' ? totalCount : 0;

  if (isFull) {
    btn.classList.add('is-expanded');
    if (count > 8) {
      btn.title = `收合為最近 8 筆${isExpense ? '支出' : '收入'}紀錄`;
      btn.innerHTML = `
        ${iconHtml('caret-up', 'regular', 'ic-15 load-full-icon')}
        <span class="load-full-text">收合至最近 8 筆</span>
      `;
    } else {
      btn.title = `已顯示當月全部共 ${count} 筆紀錄`;
      btn.innerHTML = `
        ${iconHtml('check-circle', 'regular', 'ic-15 load-full-icon')}
        <span class="load-full-text">已載入全部交易紀錄（共 ${count} 筆）</span>
      `;
    }
  } else {
    btn.classList.remove('is-expanded');
    btn.title = `載入當月完整${isExpense ? '支出' : '收入'}紀錄`;
    btn.innerHTML = `
      ${iconHtml('file-text', 'regular', 'ic-15 load-full-icon')}
      <span class="load-full-text">載入完整交易紀錄</span>
    `;
  }
}

function setLoadFullButtonLoading(btn, isLoading) {
  if (!btn) return;
  btn.disabled = isLoading;
  if (isLoading) {
    btn.classList.add('loading');
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
  if (totalEl) totalEl.textContent = '$' + sumTotal.toLocaleString('zh-TW');
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

function renderRecentList(containerId, records, type, isFiltered) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const filterInput = document.getElementById(containerId === 'recentIncomes' ? 'incomeFilterDate' : 'expenseFilterDate');
  const recState = state.recentState && state.recentState[type];
  const listKey = [getMonth(), filterInput ? filterInput.value : '', recState && recState.isFull ? 'full' : 'top',
    (records && records.length) ? 'items' : 'empty'].join('|');
  const shouldStagger = container.dataset.listKey !== listKey;
  container.dataset.listKey = listKey;

  container.innerHTML = '';
  if (!records || !records.length) {
    container.innerHTML = isFiltered
      ? '<div class="empty">該日期尚無交易紀錄。</div>'
      : '<div class="empty">這個月還沒有紀錄。</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  records.forEach(record => {
    fragment.appendChild(buildRecentItem(record, type));
  });
  container.appendChild(fragment);
  if (shouldStagger) Motion.staggerIn(container.children, { max: 12, stagger: 30 });
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
  row.classList.remove('sync-ok');
  void row.offsetWidth;
  row.classList.add('sync-ok');
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
    row.classList.remove('sync-ok');
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
    while (btn.firstChild) label.appendChild(btn.firstChild);
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

function buildRecentItem(record, type, opts) {
  opts = opts || {};
  const terms = opts.terms && opts.terms.length ? opts.terms : null;
  const hl = text => highlightMatchesHtml(text, terms);
  const locked = Boolean(opts.locked);

  const item = document.createElement('div');
  item.className = 'recent-item' + (record.isPending ? ' is-pending' : '');
  item.dataset.row = record.row;
  if (record.tempId) item.dataset.tempId = record.tempId;
  item._record = record;

  const day = document.createElement('div');
  day.className = 'recent-day';
  const parsedDay = parseInt(record.day, 10);
  day.textContent = !isNaN(parsedDay) ? `${parsedDay}日` : (record.day ? `${record.day}日` : '未填');

  const main = document.createElement('div');
  main.className = 'recent-main';
  const strong = document.createElement('strong');
  const itemIcon = getItemIcon(record.item);
  const itemIconHtml = itemIcon ? '<span class="item-inline-icon" aria-hidden="true">' + iconHtml(itemIcon) + '</span>' : '';
  if (terms) {
    strong.innerHTML = itemIconHtml + hl(itemDisplayName(record.item));
  } else {
    strong.innerHTML = itemIconHtml + escHtml(itemDisplayName(record.item));
  }
  if (record.isPending) {
    const pendingBadge = document.createElement('span');
    pendingBadge.className = 'recent-pending-badge';
    pendingBadge.textContent = '同步中…';
    strong.appendChild(pendingBadge);
  }
  const small = document.createElement('small');
  if (type === 'expense') {
    const paidLabel = record.paid === 'O' ? '已繳' : record.paid === 'X' ? '未繳' : '未設定';
    if (terms) {
      small.innerHTML = `${hl(record.category)}｜${hl(record.payment)}｜${escHtml(paidLabel)}${record.note ? '｜' + hl(record.note) : ''}`;
    } else {
      small.textContent = `${record.category}｜${record.payment}｜${paidLabel}${record.note ? '｜' + record.note : ''}`;
    }
  } else {
    if (terms) {
      small.innerHTML = `${hl(record.category)}${record.note ? '｜' + hl(record.note) : ''}`;
    } else {
      small.textContent = `${record.category}${record.note ? '｜' + record.note : ''}`;
    }
  }
  main.appendChild(strong);
  if (opts.dateLabel) {
    const dateEl = document.createElement('div');
    dateEl.className = 'recent-fulldate';
    dateEl.textContent = opts.dateLabel;
    main.appendChild(dateEl);
  }
  main.appendChild(small);

  const right = document.createElement('div');
  right.className = 'recent-right';

  const amount = document.createElement('div');
  amount.className = 'recent-amount';
  const num = parseAmount(record.amount);
  const absFormatted = Math.abs(num).toLocaleString('zh-TW');
  const sign = num < 0 ? '-' : (type === 'income' ? '+' : '');
  amount.textContent = `${sign}$${absFormatted}`;
  right.appendChild(amount);

  const actions = document.createElement('div');
  actions.className = 'recent-actions';

  const editBtn = document.createElement('button');
  editBtn.className = 'recent-act-btn edit-btn';
  editBtn.type = 'button';
  if (record.isPending || locked) {
    const hint = record.isPending ? '資料同步中，暫無法修改' : (opts.lockedHint || '資料更新中，暫無法修改');
    editBtn.disabled = true;
    editBtn.title = hint;
    editBtn.setAttribute('aria-label', hint);
    editBtn.style.opacity = '0.35';
    editBtn.style.pointerEvents = 'none';
  } else {
    editBtn.title = '修改此筆交易紀錄';
    editBtn.setAttribute('aria-label', '修改此筆交易紀錄');
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (opts.onEdit) opts.onEdit(record, type);
      else openEditModal(record, type);
    });
  }
  editBtn.innerHTML = '' + iconHtml('note-pencil', 'regular', 'ic-14') + '';

  const delBtn = document.createElement('button');
  delBtn.className = 'recent-act-btn delete-btn';
  delBtn.type = 'button';
  if (record.isPending || locked) {
    const hint = record.isPending ? '資料同步中，暫無法刪除' : (opts.lockedHint || '資料更新中，暫無法刪除');
    delBtn.disabled = true;
    delBtn.title = hint;
    delBtn.setAttribute('aria-label', hint);
    delBtn.style.opacity = '0.35';
    delBtn.style.pointerEvents = 'none';
  } else {
    delBtn.title = '刪除此筆交易紀錄';
    delBtn.setAttribute('aria-label', '刪除此筆交易紀錄');
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (opts.onDelete) opts.onDelete(record, type);
      else openDeleteModal(record, type);
    });
  }
  delBtn.innerHTML = '' + iconHtml('trash', 'regular', 'ic-14') + '';

  actions.appendChild(editBtn);
  actions.appendChild(delBtn);
  right.appendChild(actions);

  item.appendChild(day);
  item.appendChild(main);
  item.appendChild(right);
  return item;
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
