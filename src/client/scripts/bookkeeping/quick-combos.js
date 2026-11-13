const quickComboApplied = {
  expense: { id: '', note: '' },
  income: { id: '', note: '' },
};

function getQuickCombos() {
  const metadata = settingsState.metadata || (state.data && state.data.settingsMetadata);
  return metadata && Array.isArray(metadata.quickCombos) ? metadata.quickCombos : [];
}

function getQuickComboIssues(combo) {
  const options = (state.data && state.data.options) || {};
  const isExpense = combo.type !== 'income';
  const fields = [
    { field: 'item', label: '項目', allowed: isExpense ? options.expenseItems : options.incomeItems },
    { field: 'category', label: '總類', allowed: isExpense ? options.expenseCategories : options.incomeCategories },
  ];
  if (isExpense) fields.push({ field: 'payment', label: '支付方式', allowed: options.paymentMethods });
  return fields
    .filter(entry => !(entry.allowed || []).includes(combo[entry.field]))
    .map(entry => ({ field: entry.field, label: entry.label, value: combo[entry.field] }));
}

function formatQuickComboAmount(amount) {
  return '$' + new Intl.NumberFormat('zh-TW').format(Number(amount));
}

function setQuickComboMenuOpen(isOpen, animate = true) {
  ['expense', 'income'].forEach(type => {
    const section = document.getElementById(type + 'ComboSec');
    const toggle = document.getElementById(type + 'ComboToggle');
    if (section) section.classList.toggle('is-open', isOpen);
    if (toggle) toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    setPaidFieldVisible(document.getElementById(type + 'ComboBody'), isOpen, animate);
  });
}

function bindQuickComboMenu() {
  setQuickComboMenuOpen(LocalCache.getQuickComboMenuOpen(), false);
  ['expense', 'income'].forEach(type => {
    const toggle = document.getElementById(type + 'ComboToggle');
    if (!toggle) return;
    toggle.addEventListener('click', () => {
      const isOpen = toggle.getAttribute('aria-expanded') !== 'true';
      setQuickComboMenuOpen(isOpen);
      LocalCache.saveQuickComboMenuOpen(isOpen);
    });
  });
}

function getQuickComboMenuSummary(combos, selectedId) {
  if (!combos.length) return '尚未建立';
  const selected = combos.find(combo => combo.id === selectedId);
  if (selected) return selected.title;
  return combos.length + ' 組';
}

function quickComboMenuSummaryHasWarn(combos, selectedId) {
  if (!combos.length || combos.some(combo => combo.id === selectedId)) return false;
  return combos.some(combo => getQuickComboIssues(combo).length > 0);
}

function renderQuickComboChips() {
  const isWaitingForData = !settingsState.metadata && (!state.data || state.data.options === DEFAULT_OPTIONS_FALLBACK);
  ['expense', 'income'].forEach(type => {
    const container = document.getElementById(type + 'ComboChips');
    const summary = document.getElementById(type + 'ComboMeta');
    if (!container) return;
    container.innerHTML = '';
    if (summary) summary.textContent = '';
    if (isWaitingForData) return;

    const combos = getQuickCombos().filter(combo => combo && combo.type === type);
    if (summary) {
      summary.textContent = getQuickComboMenuSummary(combos, quickComboApplied[type].id);
      if (quickComboMenuSummaryHasWarn(combos, quickComboApplied[type].id)) {
        summary.prepend(iconEl('warning', 'regular', 'quick-combo-meta-warn'));
      }
    }
    if (!combos.length) {
      const createChip = document.createElement('button');
      createChip.type = 'button';
      createChip.className = 'quick-combo-chip is-empty';
      createChip.textContent = '＋ 建立常用組合';
      createChip.addEventListener('click', openQuickComboSettings);
      container.appendChild(createChip);
      return;
    }

    combos.forEach(combo => {
      const isInvalid = getQuickComboIssues(combo).length > 0;
      const isSelected = quickComboApplied[type].id === combo.id;
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'quick-combo-chip' + (isSelected ? ' selected' : '') + (isInvalid ? ' is-invalid' : '');
      chip.dataset.comboId = combo.id;
      chip.setAttribute('aria-pressed', isSelected ? 'true' : 'false');

      const addText = (className, text) => {
        const span = document.createElement('span');
        span.className = className;
        span.textContent = text;
        chip.appendChild(span);
      };
      const addIcon = (className, name) => {
        const span = document.createElement('span');
        span.className = className;
        span.setAttribute('aria-hidden', 'true');
        span.appendChild(iconEl(name));
        chip.appendChild(span);
      };
      if (isInvalid) addIcon('quick-combo-chip-warn', 'warning');
      addIcon('quick-combo-chip-emoji', getItemIcon(combo.item) || 'tag');
      addText('quick-combo-chip-title', combo.title);
      if (combo.amount) addText('quick-combo-chip-amount', formatQuickComboAmount(combo.amount));

      chip.addEventListener('click', () => applyQuickCombo(combo.id));
      container.appendChild(chip);
    });
  });
}

function openQuickComboSettings() {
  const navBtn = document.querySelector('.nav-item[data-page="settings"]');
  const tabBtn = document.querySelector('.settings-tab[data-stab="quickCombos"]');
  if (navBtn) navBtn.click();
  if (tabBtn && !tabBtn.classList.contains('active')) tabBtn.click();
}

function computeQuickComboNote(current, title, lastTitle) {
  let userText = String(current || '').trim();
  if (lastTitle) {
    if (userText === lastTitle) userText = '';
    else if (userText.startsWith(lastTitle + ' ')) userText = userText.slice(lastTitle.length + 1).trim();
  }
  if (!userText) return { note: title, addedTitle: title };
  if (userText.includes(title)) return { note: userText, addedTitle: '' };
  return { note: title + ' ' + userText, addedTitle: title };
}

function applyQuickCombo(comboId) {
  const combo = getQuickCombos().find(entry => entry && entry.id === comboId);
  if (!combo || !state.data || !state.data.options) return;

  const type = combo.type === 'income' ? 'income' : 'expense';
  const form = state[type];
  const issues = getQuickComboIssues(combo);
  const isValid = field => !issues.some(issue => issue.field === field);

  if (isValid('item')) form.item = combo.item;
  if (isValid('category')) form.category = combo.category;
  if (combo.amount) form.amount = String(combo.amount);

  if (type === 'expense') {
    if (isValid('item')) form.itemSuggested = false;
    if (isValid('category')) form.categoryTouched = true;
    if (isValid('payment')) {
      form.payment = combo.payment;
      form.paymentTouched = true;
    }
    syncExpenseItemSelectionUI();
    renderExpenseCategoryChoices();
    renderExpensePaymentChoices();
    updatePaidSectionVisibility();
    if (isValid('payment') && combo.paid && isCreditCardPayment(form.payment)) {
      form.paid = combo.paid;
      renderPaidChoices();
    }
  } else {
    renderIncomeChoices();
  }
  renderAmount(type);

  const noteInput = document.getElementById(type + 'Note');
  const applied = quickComboApplied[type];
  if (noteInput) {
    const result = computeQuickComboNote(noteInput.value, combo.title, applied.note);
    noteInput.value = result.note.slice(0, noteInput.maxLength > 0 ? noteInput.maxLength : 200);
    applied.note = result.addedTitle;
  }
  applied.id = combo.id;

  renderQuickComboChips();
  const chip = Array.from(document.querySelectorAll('#' + type + 'ComboChips .quick-combo-chip'))
    .find(entry => entry.dataset.comboId === combo.id);
  if (chip) {
    chip.classList.add('just-applied');
    setTimeout(() => chip.classList.remove('just-applied'), 600);
  }

  if (issues.length) {
    const names = issues.map(issue => '『' + issue.value + '』').join('、');
    showToast('組合中的' + names + '已不存在，請到設定頁更新', 'error');
  } else {
    showToast('已套用『' + combo.title + '』，確認日期後送出', 'success');
  }

  if (Prefs.get().autoScroll) {
    if (combo.amount) {
      goToEntryStep(type, 'bar', { reason: 'combo', announce: '組合已套用，確認日期後即可送出' });
    } else {
      goToEntryStep(type, 'amount', { reason: 'combo', announce: '下一步：' + ENTRY_STEP_ACTIONS.amount });
    }
  }
}

function clearQuickComboSelection(type) {
  quickComboApplied[type] = { id: '', note: '' };
  renderQuickComboChips();
}

function restoreQuickComboSelection(type, snapshot) {
  quickComboApplied[type] = { id: snapshot.quickComboId || '', note: snapshot.quickComboNote || '' };
}
