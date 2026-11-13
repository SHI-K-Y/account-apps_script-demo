var QUICK_COMBO_MAX_COUNT = 20;
var quickComboReorderTimer = null;
var quickComboReorderSeq = 0;
var quickComboReorderRollback = null;

function persistQuickCombos(list, opts) {
  var options = opts || {};
  var seq = options.seq;
  if (options.btn) options.btn.disabled = true;
  setLoading(true);

  Api.server
    .withSuccessHandler(function(result) {
      setLoading(false);
      if (options.btn) {
        options.btn.disabled = false;
        options.btn.textContent = options.btnLabel;
      }
      if (seq !== undefined && seq !== quickComboReorderSeq) return;
      if (result && result.ok) {
        settingsState.data = result.options;
        refreshBookkeepingOptions(result.simpleOptions, result.options, result.metadata);
        renderSettingsList();
        if (typeof options.onSuccess === 'function') options.onSuccess();
      }
    })
    .withFailureHandler(function(err) {
      setLoading(false);
      if (options.btn) {
        options.btn.disabled = false;
        options.btn.textContent = options.btnLabel;
      }
      if (seq !== undefined && seq !== quickComboReorderSeq) return;
      showToast((options.errorPrefix || '儲存失敗：') + (err.message || err), 'error');
      if (typeof options.onFailure === 'function') options.onFailure();
    })
    .saveQuickCombos(list);
}

function renderQuickComboSettings(container) {
  var combos = getQuickCombos();

  if (!combos.length) {
    container.innerHTML =
      '<div class="settings-empty">' +
        '<div class="settings-empty-icon" aria-hidden="true">' + iconHtml('lightning') + '</div>' +
        '<div class="settings-empty-text">把常記的固定支出或收入存成組合，記帳時點一下就能帶入</div>' +
        '<button class="settings-top-add-btn quick-combo-empty-add-btn" type="button">新增組合</button>' +
      '</div>';
    container.querySelector('.quick-combo-empty-add-btn').addEventListener('click', function() {
      openQuickComboModal(null);
    });
    return;
  }

  var html = '<div class="quick-combo-order-hint settings-order-hint">可使用上下箭頭或拖曳調整記帳頁的顯示順序</div>';
  [
    { type: 'expense', label: '支出組合', emptyText: '尚未建立支出組合' },
    { type: 'income', label: '收入組合', emptyText: '尚未建立收入組合' }
  ].forEach(function(group) {
    var indices = [];
    combos.forEach(function(combo, idx) {
      if ((combo.type === 'income' ? 'income' : 'expense') === group.type) indices.push(idx);
    });

    html += '<section class="quick-combo-group is-' + group.type + '" data-type="' + group.type + '">' +
              '<div class="settings-list-header quick-combo-group-header">' +
                '<div class="settings-list-title-wrap">' +
                  '<span class="quick-combo-group-dot" aria-hidden="true"></span>' +
                  '<span class="settings-list-title">' + group.label + '</span>' +
                  '<span class="settings-list-count">共 ' + indices.length + ' 組</span>' +
                '</div>' +
                '<button class="quick-combo-group-add" type="button" data-type="' + group.type + '">＋ 新增</button>' +
              '</div>';

    if (!indices.length) {
      html += '<div class="quick-combo-group-empty">' + group.emptyText + '</div></section>';
      return;
    }

    html += '<ul class="settings-list quick-combo-sortable-list">';
    indices.forEach(function(idx, pos) {
      var combo = combos[idx];
      var isExpense = group.type === 'expense';
      var prevIdx = pos > 0 ? indices[pos - 1] : -1;
      var nextIdx = pos < indices.length - 1 ? indices[pos + 1] : -1;
      var summary = [combo.item, combo.category];
      if (isExpense) summary.push(combo.payment);
      if (combo.amount) summary.push(formatQuickComboAmount(combo.amount));
      var warnings = getQuickComboIssues(combo).map(function(issue) {
        return '<div class="quick-combo-item-warn">' + iconHtml('warning') + escHtml(issue.label) + '已不存在，請點「編輯」修正</div>';
      }).join('');

      html += '<li class="settings-item quick-combo-item' + (warnings ? ' is-invalid' : '') + '" draggable="true" data-idx="' + idx + '">' +
                '<div class="settings-item-main quick-combo-item-main">' +
                  '<span class="settings-drag-handle" title="按住拖曳自訂順序" aria-label="拖曳排序">' + iconHtml('dots-six-vertical') + '</span>' +
                  '<span class="settings-item-order">' + (pos + 1) + '</span>' +
                  '<span class="settings-item-emoji" aria-hidden="true">' + iconHtml(getItemIcon(combo.item) || 'tag') + '</span>' +
                  '<div class="quick-combo-item-body">' +
                    '<div class="quick-combo-item-head">' +
                      '<span class="quick-combo-item-title">' + escHtml(combo.title) + '</span>' +
                    '</div>' +
                    '<div class="quick-combo-item-summary">' + escHtml(summary.join('，')) + '</div>' +
                    warnings +
                  '</div>' +
                '</div>' +
                '<div class="settings-item-actions">' +
                  '<button class="settings-action-btn settings-move-btn quick-combo-move" type="button" data-idx="' + idx + '" data-to="' + prevIdx + '" title="向上移動一位" aria-label="向上移動"' + (prevIdx < 0 ? ' disabled' : '') + '>' + iconHtml('caret-up') + '</button>' +
                  '<button class="settings-action-btn settings-move-btn quick-combo-move" type="button" data-idx="' + idx + '" data-to="' + nextIdx + '" title="向下移動一位" aria-label="向下移動"' + (nextIdx < 0 ? ' disabled' : '') + '>' + iconHtml('caret-down') + '</button>' +
                '<button class="settings-action-btn settings-edit-btn quick-combo-edit" type="button" data-idx="' + idx + '" title="編輯" aria-label="編輯">' +
                  '' + iconHtml('note-pencil', 'regular', 'ic-15') + '' +
                '</button>' +
                '<button class="settings-action-btn settings-delete-btn quick-combo-delete" type="button" data-idx="' + idx + '" title="刪除" aria-label="刪除">' +
                  '' + iconHtml('trash', 'regular', 'ic-15') + '' +
                '</button>' +
              '</div>' +
            '</li>';
    });
    html += '</ul></section>';
  });

  container.innerHTML = html;

  var bindByIdx = function(selector, handler) {
    container.querySelectorAll(selector).forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        handler(Number(btn.dataset.idx), btn);
      });
    });
  };
  bindByIdx('.quick-combo-move', function(idx, btn) {
    var to = Number(btn.dataset.to);
    if (to >= 0) moveQuickCombo(idx, to);
  });
  bindByIdx('.quick-combo-edit', function(idx) { openQuickComboModal(getQuickCombos()[idx]); });
  bindByIdx('.quick-combo-delete', function(idx) {
    var combo = getQuickCombos()[idx];
    if (!combo) return;
    openSettingsDeleteConfirm({ mode: 'quickCombo', id: combo.id, name: combo.title, label: '常用組合' });
  });
  container.querySelectorAll('.quick-combo-group-add').forEach(function(btn) {
    btn.addEventListener('click', function() { openQuickComboModal(null, btn.dataset.type); });
  });
  container.querySelectorAll('.quick-combo-sortable-list').forEach(function(list) {
    bindSettingsListDrag(list, moveQuickCombo);
  });
}

function moveQuickCombo(fromIdx, toIdx) {
  var list = getQuickCombos().slice();
  if (fromIdx < 0 || toIdx < 0 || fromIdx >= list.length || toIdx >= list.length || fromIdx === toIdx) return;
  if (!quickComboReorderRollback) quickComboReorderRollback = getQuickCombos().slice();

  list.splice(toIdx, 0, list.splice(fromIdx, 1)[0]);
  var m = ensureMetadataInitialized();
  m.quickCombos = list;
  renderSettingsList();
  renderQuickComboChips();

  quickComboReorderSeq++;
  var seq = quickComboReorderSeq;
  clearTimeout(quickComboReorderTimer);
  quickComboReorderTimer = setTimeout(function() {
    var rollback = quickComboReorderRollback;
    persistQuickCombos(list, {
      seq: seq,
      errorPrefix: '排序更新失敗：',
      onSuccess: function() { quickComboReorderRollback = null; },
      onFailure: function() {
        ensureMetadataInitialized().quickCombos = rollback;
        quickComboReorderRollback = null;
        renderSettingsList();
        renderQuickComboChips();
      }
    });
  }, 350);
}

function cancelPendingQuickComboReorder() {
  clearTimeout(quickComboReorderTimer);
  quickComboReorderRollback = null;
  quickComboReorderSeq++;
}

function getQuickComboChoiceLists(type) {
  var o = (state.data && state.data.options) || {};
  return type === 'income'
    ? { items: o.incomeItems || [], categories: o.incomeCategories || [], payments: [] }
    : { items: o.expenseItems || [], categories: o.expenseCategories || [], payments: o.paymentMethods || [] };
}

function renderQuickComboPaid(animate) {
  var d = state.combo;
  var isCredit = d.type === 'expense' && isCreditCardPayment(d.payment);
  renderPaidChoiceGroup('comboPaidChoices', function() { return d.paid; }, function(val) { d.paid = val; }, { includeNotApplicable: false });
  setPaidFieldVisible(document.getElementById('quickComboPaidField'), isCredit, animate);
}

function renderQuickComboFields(animate) {
  var d = state.combo;
  var lists = getQuickComboChoiceLists(d.type);
  var isExpense = d.type === 'expense';
  var modal = document.getElementById('quickComboModal');
  var icon = document.getElementById('quickComboModalIcon');
  if (modal) modal.dataset.type = d.type;
  if (icon) icon.className = 'modal-icon ' + d.type;
  document.querySelectorAll('#quickComboModal .tab').forEach(function(tab) {
    tab.classList.toggle('active', tab.dataset.comboType === d.type);
  });

  renderChoices('comboItemChoices', lists.items, d.item, function(val) { d.item = val; });
  renderChoices('comboCategoryChoices', lists.categories, d.category, function(val) { d.category = val; });

  var paymentField = document.getElementById('quickComboPaymentField');
  if (paymentField) paymentField.style.display = isExpense ? 'flex' : 'none';
  if (isExpense) {
    renderPaymentChoices('comboPaymentChoices', lists.payments, d.payment, function(val) {
      d.payment = val;
      d.paid = isCreditCardPayment(val) ? (d.paid || 'X') : '';
      renderQuickComboPaid(true);
    });
  }
  renderQuickComboPaid(animate);
}

function setQuickComboType(type) {
  var d = state.combo;
  if (d.type === type) return;
  d.type = type;
  var lists = getQuickComboChoiceLists(type);
  if (!lists.items.includes(d.item)) d.item = '';
  if (!lists.categories.includes(d.category)) d.category = '';
  if (type === 'income') {
    d.payment = '';
    d.paid = '';
  }
  renderQuickComboFields(false);
}

function updateQuickComboAmountHint() {
  var hasAmount = Number(state.combo.amount) > 0;
  var hint = document.getElementById('quickComboAmountHint');
  var noAmountBtn = document.getElementById('quickComboNoAmountBtn');
  if (hint) hint.textContent = hasAmount ? '套用時帶入此金額' : '未設定，套用時不更改金額';
  if (noAmountBtn) {
    noAmountBtn.classList.toggle('active', !hasAmount);
    noAmountBtn.setAttribute('aria-pressed', hasAmount ? 'false' : 'true');
  }
}

function updateQuickComboDupHint() {
  var input = document.getElementById('quickComboTitleInput');
  var dupHint = document.getElementById('quickComboDupHint');
  if (dupHint) dupHint.hidden = !isQuickComboTitleDuplicate(input ? input.value : '');
}

function isQuickComboTitleDuplicate(rawTitle) {
  var title = String(rawTitle || '').trim();
  return Boolean(title) && getQuickCombos().some(function(c) {
    return c.title === title && c.id !== state.combo.id;
  });
}

function openQuickComboModal(combo, defaultType) {
  if (!combo && getQuickCombos().length >= QUICK_COMBO_MAX_COUNT) {
    showToast('常用組合最多 ' + QUICK_COMBO_MAX_COUNT + ' 組，請先刪除不用的組合', 'error');
    return;
  }
  var keypad = document.getElementById('comboKeypad');
  if (keypad && !keypad.children.length) {
    buildKeypad('comboKeypad', 'combo');
    keypad.addEventListener('click', updateQuickComboAmountHint);
  }

  var type = (combo ? combo.type : defaultType) === 'income' ? 'income' : 'expense';
  var lists = getQuickComboChoiceLists(type);
  var payment = combo && lists.payments.includes(combo.payment) ? combo.payment : '';
  state.combo = {
    id: combo ? combo.id : '',
    type: type,
    item: combo && lists.items.includes(combo.item) ? combo.item : '',
    category: combo && lists.categories.includes(combo.category) ? combo.category : '',
    payment: payment,
    paid: payment && isCreditCardPayment(payment) ? ((combo && combo.paid) || 'X') : '',
    amount: combo && combo.amount ? String(combo.amount) : '',
  };

  document.getElementById('quickComboModalTitle').textContent = combo ? '編輯常用組合' : '新增常用組合';
  document.getElementById('quickComboTitleInput').value = combo ? combo.title : '';
  renderQuickComboFields(false);
  renderAmount('combo');
  updateQuickComboAmountHint();
  updateQuickComboDupHint();

  var modal = document.getElementById('quickComboModal');
  if (modal) openModal(modal);
  var card = modal ? modal.querySelector('.modal-card') : null;
  if (card) card.scrollTop = 0;
}

function closeQuickComboModal() {
  var modal = document.getElementById('quickComboModal');
  if (modal) closeModal(modal);
}

function failQuickComboField(fieldId, message) {
  showToast(message, 'error');
  var field = document.getElementById(fieldId);
  if (field) field.scrollIntoView({ block: 'center' });
}

function submitQuickCombo() {
  var d = state.combo;
  var input = document.getElementById('quickComboTitleInput');
  var title = input.value.trim();

  if (!title) {
    failQuickComboField('quickComboTitleField', '請輸入組合標題');
    input.focus();
    return;
  }
  if (!d.item) return failQuickComboField('quickComboItemField', '請選擇項目');
  if (!d.category) return failQuickComboField('quickComboCategoryField', '請選擇總類');
  if (d.type === 'expense' && !d.payment) return failQuickComboField('quickComboPaymentField', '請選擇支付方式');

  var isDuplicate = isQuickComboTitleDuplicate(title);
  var isExpense = d.type === 'expense';
  var isCredit = isExpense && isCreditCardPayment(d.payment);
  var record = {
    id: d.id || ('combo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6)),
    type: d.type,
    title: title,
    item: d.item,
    category: d.category,
    payment: isExpense ? d.payment : '',
    paid: isCredit ? (d.paid || 'X') : '',
    amount: Number(d.amount) > 0 ? String(Number(d.amount)) : '',
  };

  var list = getQuickCombos().slice();
  var existingIdx = list.findIndex(function(c) { return c.id === record.id; });
  if (existingIdx >= 0) {
    list[existingIdx] = record;
  } else {
    list.push(record);
  }

  cancelPendingQuickComboReorder();

  var submitBtn = document.getElementById('quickComboModalSubmitBtn');
  submitBtn.textContent = '儲存中…';
  persistQuickCombos(list, {
    btn: submitBtn,
    btnLabel: '儲存組合',
    onSuccess: function() {
      closeQuickComboModal();
      showToast('已儲存「' + title + '」' + (isDuplicate ? '（已有同名組合）' : ''), 'success');
    }
  });
}

ModalManager.register('quickComboModal', {
  close: closeQuickComboModal,
  busy: 'quickComboModalSubmitBtn'
});

['quickComboModalCloseIconBtn', 'quickComboModalCancelBtn'].forEach(function(id) {
  var btn = document.getElementById(id);
  if (btn) btn.addEventListener('click', function() { ModalManager.close('quickComboModal'); });
});
var quickComboModalEl = document.getElementById('quickComboModal');
if (quickComboModalEl) {
  quickComboModalEl.addEventListener('click', function(e) {
    if (e.target === e.currentTarget) ModalManager.close('quickComboModal');
  });
  quickComboModalEl.querySelectorAll('.tab').forEach(function(tab) {
    tab.addEventListener('click', function() { setQuickComboType(tab.dataset.comboType); });
  });
}
var quickComboTitleInput = document.getElementById('quickComboTitleInput');
if (quickComboTitleInput) quickComboTitleInput.addEventListener('input', updateQuickComboDupHint);
var quickComboNoAmountBtn = document.getElementById('quickComboNoAmountBtn');
if (quickComboNoAmountBtn) {
  quickComboNoAmountBtn.addEventListener('click', function() {
    state.combo.amount = '';
    renderAmount('combo');
    updateQuickComboAmountHint();
  });
}
var quickComboSubmitBtn = document.getElementById('quickComboModalSubmitBtn');
if (quickComboSubmitBtn) quickComboSubmitBtn.addEventListener('click', submitQuickCombo);
