/**
 * 修改／刪除視窗由記帳頁、搜尋頁、信用卡對帳頁共用；source 決定寫入後要同步哪一頁：
 *   ''（記帳頁）｜'search'（有給 monthArg 時的預設）｜'creditcard'（pages/credit-card.js 的 CreditCardRecords）
 */
function recordModalSource(monthArg, source) {
  return source || (monthArg ? 'search' : '');
}

/** 信用卡對帳頁的月份清單可能是本機快取：帶上畫面上的內容，後端核對這一列還是同一筆才寫入。 */
function recordExpectation(record, source) {
  if (source !== 'creditcard') return null;
  return {
    day: record.day,
    item: record.item || '',
    category: record.category || '',
    payment: record.payment || '',
    paid: record.paid || '',
    amount: record.amount,
    note: record.note || '',
  };
}

function isRecordConflict(err) {
  return /^衝突：/.test(String((err && err.message) || err || ''));
}

/** 復原修改／刪除；信用卡對帳頁在復原期間鎖住那個月份，完成後重畫（失敗則重新讀取）。 */
function undoRecordModalOp(source, month, opId) {
  const run = () => undoLedgerOps([{ opId: opId, month: month }]);
  return source === 'creditcard' ? CreditCardRecords.track(month, run) : run();
}

function openEditModal(record, type, monthArg, source) {
  if (!state.data || !state.data.options) return;
  const o = state.data.options;
  const month = monthArg || getMonth();

  editState.active = true;
  editState.source = recordModalSource(monthArg, source);
  editState.expect = recordExpectation(record, editState.source);
  editState.type = type;
  editState.month = month;
  editState.row = record.row;
  editState.day = parseInt(record.day, 10) || 1;
  editState.item = record.item || '';
  editState.category = record.category || '';
  editState.amount = String(record.amount || '');
  editState.note = record.note || '';

  const isExpense = (type === 'expense');
  if (isExpense) {
    editState.payment = record.payment || prefer('現金', o.paymentMethods);
    editState.paid = record.paid !== undefined && record.paid !== null ? String(record.paid).toUpperCase() : '';
  }

  const modalIcon = document.getElementById('editModalIcon');
  if (modalIcon) modalIcon.className = 'modal-icon ' + (isExpense ? 'expense' : 'income');
  document.getElementById('editModalTitle').textContent = isExpense ? '修改支出紀錄' : '修改收入紀錄';
  document.getElementById('editModalSubtitle').textContent = `${month} 工作表 第 ${record.row} 列`;

  document.getElementById('editRecordMonthBadge').textContent = month;

  const maxDays = getDaysInMonth(editState.month);
  const dayInput = document.getElementById('editRecordDay');
  dayInput.max = maxDays;
  dayInput.value = editState.day;

  const amountInput = document.getElementById('editRecordAmount');
  amountInput.value = Math.abs(parseAmount(editState.amount)) || '';

  const noteInput = document.getElementById('editRecordNote');
  noteInput.value = editState.note;

  const items = isExpense ? o.expenseItems : o.incomeItems;
  renderChoices('editItemChoices', items, editState.item, val => {
    editState.item = val;
  });

  const categories = isExpense ? o.expenseCategories : o.incomeCategories;
  renderChoices('editCategoryChoices', categories, editState.category, val => {
    editState.category = val;
  });

  const payField = document.getElementById('editPaymentField');
  if (isExpense) {
    if (payField) payField.style.display = 'flex';
    renderPaymentChoices('editPaymentChoices', o.paymentMethods, editState.payment, val => {
      editState.payment = val;
      editState.paid = isCreditCardPayment(val) ? (editState.paid || 'X') : '';
      renderEditPaidChoices();
      updateEditPaidFieldVisibility();
    });
    renderEditPaidChoices();
  } else {
    if (payField) payField.style.display = 'none';
  }
  updateEditPaidFieldVisibility(false);

  const modal = document.getElementById('editRecordModal');
  if (modal) {
    openModal(modal);
    modal.classList.toggle('is-expense', isExpense);
    modal.classList.toggle('is-income', !isExpense);
  }
  Motion.haptic('light');
}

function renderEditPaidChoices() {
  renderPaidChoiceGroup('editPaidChoices', () => editState.paid, val => { editState.paid = val; });
}

function closeEditModal() {
  const modal = document.getElementById('editRecordModal');
  if (modal) closeModal(modal);
  editState.active = false;
}

function submitEditRecord() {
  if (!editState.active) return;
  const isExpense = (editState.type === 'expense');

  const maxDays = getDaysInMonth(editState.month);
  const dayVal = parseInt(document.getElementById('editRecordDay').value, 10);
  if (isNaN(dayVal) || dayVal < 1 || dayVal > maxDays) {
    return showToast('請輸入有效日期 (1～' + maxDays + ')', 'error');
  }

  const amountVal = parseAmount(document.getElementById('editRecordAmount').value);
  if (!amountVal || amountVal <= 0) {
    return showToast('請輸入有效金額', 'error');
  }

  if (!editState.item) {
    return showToast(isExpense ? '請選擇支出項目' : '請選擇收入項目', 'error');
  }

  if (!editState.category) {
    return showToast(isExpense ? '請選擇支出總類' : '請選擇收入總類', 'error');
  }

  const noteVal = document.getElementById('editRecordNote').value.trim();

  const editSource = editState.source;
  const editMonth = editState.month;
  const editType = editState.type;
  const editRow = editState.row;
  const fromCreditCard = editSource === 'creditcard';

  state.mutationVersion++;
  if (fromCreditCard) CreditCardRecords.begin(editMonth);
  const submitBtn = document.getElementById('editModalSubmitBtn');
  submitBtn.disabled = true;
  submitBtn.textContent = '儲存中…';

  // 儲存成功：合併回應，提示帶「復原」（F05：5 秒內按下就把修改前的值寫回；該列又被改過時提示衝突）
  const onEditSaved = (res, form) => {
    submitBtn.disabled = false;
    submitBtn.textContent = '儲存修改';
    closeEditModal();
    handleMutationRecentUpdate(res, editMonth);
    if (fromCreditCard) CreditCardRecords.end(editMonth);
    const syncSearch = (r) => {
      if (editSource === 'search' && r) {
        DeferredApp.ensure() && SearchPage.onRecordUpdated({ month: editMonth, type: editType, row: r.row, record: r.record });
      }
    };
    syncSearch({ row: editRow, record: (res && res.record) || form });
    showUndoToast('交易紀錄已修改', () => undoRecordModalOp(editSource, editMonth, (res && res.opId) || form.opId)
      .then(results => {
        syncSearch(results[0]);
        return '已復原修改';
      }));
  };

  const onEditFailed = err => {
    submitBtn.disabled = false;
    submitBtn.textContent = '儲存修改';
    showServerError(err);
    if (fromCreditCard) {
      if (isRecordConflict(err)) closeEditModal();
      CreditCardRecords.fail(editMonth, err);
    }
  };

  if (isExpense) {
    const form = {
      month: editState.month,
      row: editState.row,
      day: dayVal,
      item: editState.item,
      category: editState.category,
      payment: editState.payment,
      paid: editState.paid,
      amount: amountVal,
      note: noteVal,
      opId: Api.newOpId(),
    };
    if (editState.expect) form.expect = editState.expect;

    Api.server
      .withSuccessHandler(res => onEditSaved(res, form))
      .withFailureHandler(onEditFailed)
      .updateExpense(form);
  } else {
    const form = {
      month: editState.month,
      row: editState.row,
      day: dayVal,
      item: editState.item,
      category: editState.category,
      amount: amountVal,
      note: noteVal,
      opId: Api.newOpId(),
    };

    Api.server
      .withSuccessHandler(res => onEditSaved(res, form))
      .withFailureHandler(onEditFailed)
      .updateIncome(form);
  }
}

function openDeleteModal(record, type, monthArg, source) {
  const month = monthArg || getMonth();
  deleteState.active = true;
  deleteState.source = recordModalSource(monthArg, source);
  deleteState.expect = recordExpectation(record, deleteState.source);
  deleteState.type = type;
  deleteState.month = month;
  deleteState.row = record.row;
  deleteState.record = record;

  const isExpense = (type === 'expense');

  const badge = document.getElementById('deletePreviewBadge');
  if (badge) {
    badge.textContent = isExpense ? '支出' : '收入';
    badge.className = 'delete-type-badge ' + (isExpense ? 'expense' : 'income');
  }

  const parsedDay = parseInt(record.day, 10);
  const dayStr = !isNaN(parsedDay) ? `${parsedDay}日` : (record.day ? `${record.day}日` : '');
  const dateEl = document.getElementById('deletePreviewDate');
  if (dateEl) dateEl.textContent = `${month}.${pad(parsedDay || 1)} (${dayStr})`;

  const itemEl = document.getElementById('deletePreviewItem');
  if (itemEl) itemEl.innerHTML = itemIconLabelHtml(record.item);

  const num = parseAmount(record.amount);
  const absFormatted = Fmt.num(Math.abs(num));
  const sign = num < 0 ? '-' : (isExpense ? '' : '+');
  const amountEl = document.getElementById('deletePreviewAmount');
  if (amountEl) {
    amountEl.textContent = `${sign}$${absFormatted}`;
    amountEl.className = 'delete-preview-amount ' + (isExpense ? 'expense' : 'income');
  }

  let details = '';
  if (isExpense) {
    const paidLabel = record.paid === 'O' ? '已繳' : record.paid === 'X' ? '未繳' : '未設定';
    details = `${record.category}｜${record.payment}｜${paidLabel}${record.note ? '｜' + record.note : ''}`;
  } else {
    details = `${record.category}${record.note ? '｜' + record.note : ''}`;
  }
  const detailsEl = document.getElementById('deletePreviewDetails');
  if (detailsEl) detailsEl.textContent = details;

  const modal = document.getElementById('deleteConfirmModal');
  if (modal) openModal(modal);
  Motion.haptic('error');
}

function closeDeleteModal() {
  const modal = document.getElementById('deleteConfirmModal');
  if (modal) closeModal(modal);
  deleteState.active = false;
}

function confirmDeleteRecord() {
  if (!deleteState.active) return;
  const isExpense = (deleteState.type === 'expense');
  const deleteSource = deleteState.source;
  const fromCreditCard = deleteSource === 'creditcard';

  state.mutationVersion++;
  const confirmBtn = document.getElementById('deleteModalConfirmBtn');
  confirmBtn.disabled = true;
  confirmBtn.textContent = '刪除中…';

  const form = {
    month: deleteState.month,
    row: deleteState.row,
    opId: Api.newOpId(),
  };
  if (deleteState.expect) form.expect = deleteState.expect;
  if (fromCreditCard) CreditCardRecords.begin(form.month);

  const successHandler = (res) => {
    const recentContainerId = isExpense ? 'recentExpenses' : 'recentIncomes';
    const leavingRow = deleteSource === 'search' ? null
      : fromCreditCard ? CreditCardRecords.captureRow(form.month, form.row)
        : captureRecentRow(recentContainerId, '.recent-item[data-row="' + form.row + '"]');
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '' + iconHtml('trash', 'regular', 'ic-18') + '確認刪除';
    const targetMonth = deleteState.month;
    const targetType = deleteState.type;
    closeDeleteModal();
    handleMutationRecentUpdate(res, targetMonth);
    if (fromCreditCard) CreditCardRecords.end(form.month);
    playRecentRowExit(leavingRow);
    if (deleteSource === 'search') {
      DeferredApp.ensure() && SearchPage.onRecordDeleted({ month: targetMonth, type: targetType, row: form.row });
    }
    // F05：5 秒內按「復原」，後端把這筆插回原本的列（下方的紀錄往下移回原位）
    showUndoToast('已刪除該筆交易紀錄', () => undoRecordModalOp(deleteSource, targetMonth, (res && res.opId) || form.opId)
      .then(() => {
        if (deleteSource === 'search') DeferredApp.ensure() && SearchPage.onRecordRestored({ month: targetMonth, type: targetType });
        return '已復原刪除的紀錄';
      }));
  };

  const failureHandler = (err) => {
    confirmBtn.disabled = false;
    confirmBtn.innerHTML = '' + iconHtml('trash', 'regular', 'ic-18') + '確認刪除';
    showServerError(err);
    if (fromCreditCard) {
      if (isRecordConflict(err)) closeDeleteModal();
      CreditCardRecords.fail(form.month, err);
    }
  };

  if (isExpense) {
    Api.server
      .withSuccessHandler(successHandler)
      .withFailureHandler(failureHandler)
      .deleteExpense(form);
  } else {
    Api.server
      .withSuccessHandler(successHandler)
      .withFailureHandler(failureHandler)
      .deleteIncome(form);
  }
}

function getSuggestedNextMonth() {
  const months = (state.data && state.data.months) || [];
  const client = getClientToday();
  const currentRealMonth = client.currentMonth;

  if (currentRealMonth && !months.includes(currentRealMonth)) {
    return currentRealMonth;
  }

  let latestMonth = '';
  months.forEach(m => {
    if (/^\d{4}\.\d{2}$/.test(m)) {
      if (!latestMonth || m > latestMonth) {
        latestMonth = m;
      }
    }
  });

  if (!latestMonth) {
    return currentRealMonth || '2026.11';
  }

  const parts = latestMonth.split('.');
  let year = parseInt(parts[0], 10);
  let month = parseInt(parts[1], 10);
  month += 1;
  if (month > 12) {
    month = 1;
    year += 1;
  }
  const nextMonthStr = String(month).padStart(2, '0');
  return `${year}.${nextMonthStr}`;
}

function openAddMonthModal() {
  const suggested = getSuggestedNextMonth();
  const input = document.getElementById('addMonthInput');
  const hintText = document.getElementById('addMonthSuggestedText');
  if (input) input.value = suggested;
  if (hintText) hintText.textContent = suggested;

  const modal = document.getElementById('addMonthModal');
  if (modal) {
    openModal(modal);
    if (input) {
      setTimeout(() => {
        input.focus();
        input.select();
      }, 50);
    }
  }
}

function closeAddMonthModal() {
  if (ModalManager.isBusy('addMonthModal')) return false;
  const modal = document.getElementById('addMonthModal');
  if (modal) closeModal(modal);
  return true;
}

function submitAddMonthSheet() {
  const input = document.getElementById('addMonthInput');
  const targetMonth = String(input ? input.value : '').trim();

  if (!/^\d{4}\.(0[1-9]|1[0-2])$/.test(targetMonth)) {
    showToast('請輸入正確的月份格式 YYYY.MM（例如 2026.11）', 'error');
    if (input) input.focus();
    return;
  }

  if (state.data && state.data.months && state.data.months.includes(targetMonth)) {
    showToast(`「${targetMonth}」工作表已存在，無須重複建立。`, 'error');
    return;
  }

  const submitBtn = document.getElementById('addMonthSubmitBtn');
  const originalText = submitBtn ? submitBtn.textContent : '確認建立';
  if (submitBtn) {
    submitBtn.disabled = true;
    submitBtn.textContent = '建立中…';
  }
  document.body.classList.add('busy');

  Api.server
    .withSuccessHandler(res => {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
      document.body.classList.remove('busy');

      if (!res || !res.ok) {
        showToast((res && res.message) || '建立失敗，請稍後再試', 'error');
        return;
      }

      state.mutationVersion++;
      state.data.months = res.months;
      state.data.selectedMonth = res.month;
      LocalCache.saveBoot(state.data);
      populateMonths();

      closeCalendar('expense');
      closeCalendar('income');
      setDatesForMonth(res.month);
      clearForms({ keepDates: true });
      resetRecentFullState();

      if (res.recent) {
        LocalCache.saveRecent(res.month, res.recent);
        renderRecent(res.recent);
      } else {
        loadRecent(res.month);
      }

      closeAddMonthModal();
      showToast(`已成功建立 ${res.month} 記帳工作表！`, 'success');
    })
    .withFailureHandler(err => {
      if (submitBtn) {
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
      }
      document.body.classList.remove('busy');
      showToast((err && err.message) || '建立失敗，請檢查網路或試算表設定', 'error');
    })
    .createNewMonthSheet(targetMonth);
}
