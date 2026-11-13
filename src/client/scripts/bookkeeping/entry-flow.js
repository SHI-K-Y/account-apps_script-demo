function populateMonths() {
  const select = document.getElementById('monthSelect');
  select.innerHTML = '';
  state.data.months.forEach(month => {
    const option = document.createElement('option');
    option.value = month;
    option.textContent = month;
    if (month === state.data.selectedMonth) option.selected = true;
    select.appendChild(option);
  });

  const ccSelect = document.getElementById('ccMonthSelect');
  if (ccSelect) {
    const targetCcMonth = ccState.month || state.data.selectedMonth;
    ccSelect.innerHTML = '';
    state.data.months.forEach(month => {
      const option = document.createElement('option');
      option.value = month;
      option.textContent = month;
      if (month === targetCcMonth) option.selected = true;
      ccSelect.appendChild(option);
    });
    if (!ccState.month) ccState.month = targetCcMonth;
  }
}

function renderAllChoices() {
  const o = state.data.options;
  renderChoices('expenseItemChoices', o.expenseItems, state.expense.item, value => {
    selectExpenseItem(value);
    onUserPick('expense', 'item');
  });

  state.expense.category = prefer(state.expense.category || '生活費', o.expenseCategories);
  renderExpenseCategoryChoices();

  const initialPayment = prefer(state.expense.payment || '現金', o.paymentMethods);
  state.expense.payment = initialPayment;

  renderExpensePaymentChoices();
  updatePaidSectionVisibility();

  state.income.category = prefer(state.income.category || '生活費', o.incomeCategories);
  renderIncomeChoices();

  syncExpenseItemSelectionUI();
  applySuggestedExpenseItem();
  renderQuickComboChips();
}

function renderIncomeChoices() {
  const o = state.data.options;
  renderChoices('incomeItemChoices', o.incomeItems, state.income.item, value => {
    state.income.item = value;
    onUserPick('income', 'item');
  });
  renderChoices('incomeCategoryChoices', o.incomeCategories, state.income.category, value => {
    state.income.category = value;
    onUserPick('income', 'category');
  });
  scheduleStepProgress('income');
}

function renderExpenseCategoryChoices() {
  renderChoices('expenseCategoryChoices', state.data.options.expenseCategories, state.expense.category, value => {
    state.expense.category = value;
    state.expense.categoryTouched = true;
    onUserPick('expense', 'category');
  });
  scheduleStepProgress('expense');
}

function renderExpensePaymentChoices() {
  renderPaymentChoices('paymentChoices', state.data.options.paymentMethods, state.expense.payment, value => {
    state.expense.payment = value;
    state.expense.paymentTouched = true;
    const paidSettled = updatePaidSectionVisibility();
    onUserPick('expense', 'payment', { after: paidSettled });
  });
}

function selectExpenseItem(value) {
  state.expense.item = value;
  state.expense.itemSuggested = false;
  syncExpenseItemSelectionUI();
  applyExpenseItemPrefs(value);
}

const ENTRY_FLOW = {
  expense: ['item', 'category', 'payment', 'paid', 'amount'],
  income:  ['item', 'category', 'amount'],
};
const ENTRY_STEP_LABELS = { item: '項目', category: '總類', payment: '支付方式', paid: '是否已繳', amount: '金額', note: '備註' };
const ENTRY_STEP_ACTIONS = { item: '選擇項目', category: '選擇總類', payment: '選擇支付方式', paid: '選擇是否已繳', amount: '輸入金額' };

function getEntryStepSection(type, step) {
  const panel = document.getElementById(type + 'Panel');
  if (!panel) return null;
  if (step === 'bar') return panel.querySelector('.bar');
  return panel.querySelector('.sec[data-step="' + step + '"]');
}

function isEntryStepActive(type, step) {
  if (type === 'expense' && step === 'paid') return isCreditCardPayment(state.expense.payment);
  return true;
}

function getActiveEntryFlow(type) {
  return (ENTRY_FLOW[type] || []).filter(step => isEntryStepActive(type, step));
}

function getNextEntryStep(type, step) {
  const flow = ENTRY_FLOW[type] || [];
  const idx = flow.indexOf(step);
  if (idx < 0) return null;
  for (let i = idx + 1; i < flow.length; i++) {
    if (isEntryStepActive(type, flow[i])) return flow[i];
  }
  return null;
}

function isEntryStepDone(type, step) {
  const form = state[type] || {};
  switch (step) {
    case 'item': return Boolean(form.item);
    case 'category': return Boolean(form.category);
    case 'payment': return Boolean(form.payment);
    case 'paid': return form.paid === 'O' || form.paid === 'X';
    case 'amount': return Number(form.amount || 0) > 0;
    default: return false;
  }
}

function announceEntryStep(message) {
  const el = document.getElementById('entryStepAnnouncer');
  if (!el) return;
  el.textContent = '';
  setTimeout(() => { el.textContent = message; }, 50);
}

function goToEntryStep(type, step, { reason = 'pick', after, announce } = {}) {
  const el = getEntryStepSection(type, step);
  if (!el) return Promise.resolve(false);
  return Motion.scrollToSection(el, {
    reason: reason,
    after: after,
    align: step === 'bar' ? 'end' : 'start',
    effect: 'arrive',
    onArrive: announce ? () => announceEntryStep(announce) : null,
  });
}

function onUserPick(type, step, { after } = {}) {
  scheduleStepProgress(type);
  if (!Prefs.get().autoScroll) return;
  if (document.body.dataset.page && document.body.dataset.page !== 'bookkeeping') return;
  const next = getNextEntryStep(type, step);
  if (!next) return;
  goToEntryStep(type, next, {
    reason: 'pick',
    after: after,
    announce: '下一步：' + (ENTRY_STEP_ACTIONS[next] || ENTRY_STEP_LABELS[next]),
  });
}

function rejectEntryStep(type, step, message) {
  showToast(message, 'error');
  Motion.haptic('error');
  const el = getEntryStepSection(type, step);
  if (el) Motion.scrollToSection(el, { reason: 'validation', delay: 0, effect: 'error' });
}

const stepProgressState = {
  expense: { raf: 0, done: null, key: '' },
  income: { raf: 0, done: null, key: '' },
};

function scheduleStepProgress(type) {
  const s = stepProgressState[type];
  if (!s || s.raf) return;
  s.raf = requestAnimationFrame(() => {
    s.raf = 0;
    renderStepDots(type);
  });
}

function renderStepDots(type) {
  const container = document.getElementById(type + 'StepDots');
  if (!container) return;
  const s = stepProgressState[type];
  const flow = getActiveEntryFlow(type);
  const key = flow.join(',');

  if (s.key !== key) {
    container.innerHTML = '';
    flow.forEach(step => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'step-dot';
      btn.dataset.dotStep = step;
      const mark = document.createElement('span');
      mark.className = 'step-dot-mark';
      mark.setAttribute('aria-hidden', 'true');
      btn.appendChild(mark);
      btn.addEventListener('click', () => {
        goToEntryStep(type, step, { reason: 'dot' });
      });
      container.appendChild(btn);
    });
    s.key = key;
  }

  const prevDone = s.done;
  const nextDone = {};
  container.querySelectorAll('.step-dot').forEach(btn => {
    const step = btn.dataset.dotStep;
    const done = isEntryStepDone(type, step);
    nextDone[step] = done;
    btn.classList.toggle('is-done', done);
    const label = (ENTRY_STEP_LABELS[step] || step) + '：' + (done ? '已完成' : '未完成') + '，點一下前往';
    btn.setAttribute('aria-label', label);
    btn.title = (ENTRY_STEP_LABELS[step] || step) + (done ? '（已完成）' : '');
    if (done && prevDone && prevDone[step] === false) {
      Motion.animate(btn.querySelector('.step-dot-mark'), {
        full: [
          { transform: 'scale(0.6)', opacity: 0.4 },
          { transform: 'scale(1.35)', opacity: 1, offset: 0.55 },
          { transform: 'scale(1)', opacity: 1 }
        ],
        lite: [{ opacity: 0.2 }, { opacity: 1 }]
      }, { duration: 320, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
    }
  });
  s.done = nextDone;
}

function syncExpenseItemSelectionUI() {
  scheduleStepProgress('expense');
  const container = document.getElementById('expenseItemChoices');
  if (!container) return;
  container.querySelectorAll('.choice').forEach(button => {
    const isSelected = button.dataset.value === state.expense.item;
    const isSuggested = isSelected && state.expense.itemSuggested;
    button.classList.toggle('selected', isSelected);
    button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    button.classList.toggle('suggested', isSuggested);
    const badge = button.querySelector('.choice-suggest-badge');
    if (isSuggested && !badge) {
      const newBadge = document.createElement('span');
      newBadge.className = 'choice-suggest-badge';
      newBadge.textContent = '建議';
      button.appendChild(newBadge);
    } else if (!isSuggested && badge) {
      badge.remove();
    }
  });
}

function getSuggestedExpenseItem() {
  const now = new Date();
  const minutes = now.getHours() * 60 + now.getMinutes();
  const toMinutes = time => {
    const [hour, minute] = time.split(':').map(Number);
    return hour * 60 + minute;
  };
  const slot = MEAL_TIME_SLOTS.find(s => minutes >= toMinutes(s.start) && minutes <= toMinutes(s.end));
  const items = state.data.options.expenseItems;
  return slot && Array.isArray(items) && items.includes(slot.item) ? slot.item : '';
}

function applySuggestedExpenseItem() {
  if (!state.data || !state.data.options || state.data.options === DEFAULT_OPTIONS_FALLBACK) return;
  if (state.expense.item && !state.expense.itemSuggested) return;

  const dateInput = document.getElementById('expenseDate');
  const isToday = Boolean(dateInput) && dateInput.value === getClientToday().todayISO;
  const nextItem = isToday ? getSuggestedExpenseItem() : '';
  if (nextItem === state.expense.item) return;

  state.expense.item = nextItem;
  state.expense.itemSuggested = Boolean(nextItem);
  syncExpenseItemSelectionUI();
  applyExpenseItemPrefs(nextItem);
}

function applyExpenseItemPrefs(item) {
  const options = state.data && state.data.options;
  if (!item || !options || options === DEFAULT_OPTIONS_FALLBACK) return;
  const pref = LocalCache.getItemPrefs()[item];
  if (!pref) return;

  const isPaymentValid = (options.paymentMethods || []).includes(pref.payment);
  const isCategoryValid = (options.expenseCategories || []).includes(pref.category);
  if (!isPaymentValid || !isCategoryValid) LocalCache.removeItemPref(item);

  if (isCategoryValid && !state.expense.categoryTouched && pref.category !== state.expense.category) {
    state.expense.category = pref.category;
    renderExpenseCategoryChoices();
  }
  if (isPaymentValid && !state.expense.paymentTouched && pref.payment !== state.expense.payment) {
    state.expense.payment = pref.payment;
    renderExpensePaymentChoices();
    updatePaidSectionVisibility();
    flashAutoAppliedPayment();
  }
}

function flashAutoAppliedPayment() {
  const container = document.getElementById('paymentChoices');
  if (!container) return;
  const button = Array.from(container.querySelectorAll('.choice'))
    .find(choice => choice.dataset.value === state.expense.payment);
  if (!button) return;
  button.classList.add('auto-applied');
  setTimeout(() => button.classList.remove('auto-applied'), 600);
}
