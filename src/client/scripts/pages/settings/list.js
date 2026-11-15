function renderSettingsList() {
  var container = document.getElementById('settingsListContainer');
  if (!container) return;

  if (settingsState.currentTab === 'preferences') {
    renderPreferencesSettings(container);
    return;
  }

  if (settingsState.currentTab === 'budget') {
    BudgetSettings.render(container);
    return;
  }

  if (settingsState.currentTab === 'mealSlots') {
    MealSlotSettings.render(container);
    return;
  }

  if (settingsState.currentTab === 'reminders') {
    ReminderSettings.render(container);
    return;
  }

  if (!settingsState.data) return;

  ensureMetadataInitialized();

  if (settingsState.currentTab === 'paymentMethods') {
    renderPaymentSettingsModule(container);
    return;
  }

  if (settingsState.currentTab === 'quickCombos') {
    renderQuickComboSettings(container);
    return;
  }

  var tab = settingsState.currentTab;
  var items = settingsState.data[tab] || [];
  var tabLabel = SETTINGS_TAB_LABELS[tab] || '選項';
  var isItemWithEmoji = (tab === 'expenseItems' || tab === 'incomeItems');

  if (!items.length) {
    container.innerHTML =
      '<div class="settings-empty">' +
        '<div class="settings-empty-icon" aria-hidden="true">' + iconHtml('tray') + '</div>' +
        '<div class="settings-empty-text">尚無' + tabLabel + '，請於上方新增</div>' +
      '</div>';
    return;
  }

  var html = '<div class="settings-list-header">' +
               '<div class="settings-list-title-wrap">' +
                 '<span class="settings-list-title">' + tabLabel + '</span>' +
                 '<span class="settings-order-hint">可使用上下箭頭或拖曳自訂順序</span>' +
               '</div>' +
               '<span class="settings-list-count">共 ' + items.length + ' 項</span>' +
             '</div>' +
             '<ul class="settings-list" id="settingsSortableList">';

  items.forEach(function(item, idx) {
    var itemIcon = isItemWithEmoji ? getItemIcon(item.value) : '';
    var isFirst = (idx === 0);
    var isLast = (idx === items.length - 1);
    html += '<li class="settings-item" draggable="true" data-row="' + item.row + '" data-idx="' + idx + '">' +
              '<div class="settings-item-main">' +
                '<span class="settings-drag-handle" title="按住拖曳自訂順序" aria-label="拖曳排序">' + iconHtml('dots-six-vertical') + '</span>' +
                '<span class="settings-item-order">' + (idx + 1) + '</span>' +
                (itemIcon ? '<span class="settings-item-emoji" aria-hidden="true">' + iconHtml(itemIcon) + '</span>' : '') +
                '<span class="settings-item-value" id="settingsVal_' + item.row + '">' + escHtml(isItemWithEmoji ? itemDisplayName(item.value) : item.value) + '</span>' +
              '</div>' +
              '<div class="settings-item-actions">' +
                '<button class="settings-action-btn settings-move-btn settings-move-up-btn" type="button" data-idx="' + idx + '" title="向上移動一位"' + (isFirst ? ' disabled' : '') + '>' +
                  iconHtml('caret-up') +
                '</button>' +
                '<button class="settings-action-btn settings-move-btn settings-move-down-btn" type="button" data-idx="' + idx + '" title="向下移動一位"' + (isLast ? ' disabled' : '') + '>' +
                  iconHtml('caret-down') +
                '</button>' +
                '<button class="settings-action-btn settings-edit-btn" type="button" data-row="' + item.row + '" data-value="' + escAttr(item.value) + '" title="修改">' +
                  '' + iconHtml('note-pencil', 'regular', 'ic-15') + '' +
                '</button>' +
                '<button class="settings-action-btn settings-delete-btn" type="button" data-row="' + item.row + '" data-value="' + escAttr(item.value) + '" title="刪除">' +
                  '' + iconHtml('trash', 'regular', 'ic-15') + '' +
                '</button>' +
              '</div>' +
            '</li>';
  });

  html += '</ul>';
  container.innerHTML = html;

  container.querySelectorAll('.settings-move-up-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var idx = Number(btn.dataset.idx);
      if (idx > 0) {
        reorderSettingsItem(tab, idx, idx - 1, true);
      }
    });
  });

  container.querySelectorAll('.settings-move-down-btn').forEach(function(btn) {
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      var idx = Number(btn.dataset.idx);
      if (idx < items.length - 1) {
        reorderSettingsItem(tab, idx, idx + 1, true);
      }
    });
  });

  bindSettingsListDrag(container.querySelector('#settingsSortableList'), function(from, to) {
    reorderSettingsItem(tab, from, to);
  });

  container.querySelectorAll('.settings-edit-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var row = Number(btn.dataset.row);
      var oldValue = btn.dataset.value;
      if (isItemWithEmoji) {
        openItemEmojiEditModal(tab, row, oldValue);
      } else {
        startInlineEdit(row, oldValue);
      }
    });
  });

  container.querySelectorAll('.settings-delete-btn').forEach(function(btn) {
    btn.addEventListener('click', function() {
      var row = Number(btn.dataset.row);
      var value = btn.dataset.value;
      openSettingsDeleteConfirm({
        mode: isItemWithEmoji ? 'itemWithEmoji' : 'simpleOption',
        category: tab,
        row: row,
        name: value,
        label: tabLabel
      });
    });
  });
}

var reorderDebounceTimers = {};
var reorderSeq = 0;

function bindSettingsListDrag(sortableList, onMove) {
  if (!sortableList) return;
  var dragSrcIdx = null;

  sortableList.querySelectorAll('.settings-item').forEach(function(itemEl) {
    itemEl.addEventListener('dragstart', function(e) {
      dragSrcIdx = Number(itemEl.dataset.idx);
      itemEl.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      try {
        e.dataTransfer.setData('text/plain', String(dragSrcIdx));
      } catch (err) {}
    });

    itemEl.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!itemEl.classList.contains('dragging')) {
        itemEl.classList.add('drag-over');
      }
    });

    itemEl.addEventListener('dragleave', function() {
      itemEl.classList.remove('drag-over');
    });

    itemEl.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      itemEl.classList.remove('drag-over');
      var targetIdx = Number(itemEl.dataset.idx);
      if (dragSrcIdx !== null && targetIdx !== dragSrcIdx && !isNaN(targetIdx)) {
        var from = dragSrcIdx;
        dragSrcIdx = null;
        onMove(from, targetIdx);
      }
    });

    itemEl.addEventListener('dragend', function() {
      itemEl.classList.remove('dragging');
      sortableList.querySelectorAll('.settings-item').forEach(function(el) {
        el.classList.remove('drag-over');
      });
      dragSrcIdx = null;
    });
  });
}

function reorderSettingsItem(category, fromIdx, toIdx, withFlip) {
  if (!settingsState.data || !settingsState.data[category]) return;
  var list = settingsState.data[category];
  if (fromIdx < 0 || fromIdx >= list.length || toIdx < 0 || toIdx >= list.length || fromIdx === toIdx) return;

  var moved = list.splice(fromIdx, 1)[0];
  list.splice(toIdx, 0, moved);

  list.forEach(function(it, i) {
    it.row = i + 2;
  });

  if (withFlip) {
    Motion.flipList(document.getElementById('settingsListContainer'), '.settings-item', function(el) {
      var v = el.querySelector('.settings-item-value');
      return v ? v.textContent : '';
    }, renderSettingsList);
  } else {
    renderSettingsList();
  }

  if (state.data && state.data.options && state.data.options[category]) {
    state.data.options[category] = list.map(function(it) { return it.value; });
    if (state.data.settingsOptions) {
      state.data.settingsOptions[category] = list;
    }
    LocalCache.saveBoot(state.data);
    renderAllChoices();
  }

  reorderSeq++;
  var currentSeq = reorderSeq;

  if (reorderDebounceTimers[category]) {
    clearTimeout(reorderDebounceTimers[category]);
  }

  reorderDebounceTimers[category] = setTimeout(function() {
    delete reorderDebounceTimers[category];
    var currentList = (settingsState.data && settingsState.data[category]) ? settingsState.data[category] : list;
    var orderedValues = currentList.map(function(it) { return it.value; });

    Api.server
      .withSuccessHandler(function(result) {
        if (currentSeq !== reorderSeq) {
          return;
        }
        if (result && result.ok) {
          settingsState.data = result.options;
          if (result.metadata) {
            settingsState.metadata = result.metadata;
            LocalCache.saveSettingsMetadata(result.metadata);
          }
          renderSettingsList();
          refreshBookkeepingOptions(result.simpleOptions, result.options, result.metadata);
        }
      })
      .withFailureHandler(function(err) {
        if (currentSeq !== reorderSeq) {
          return;
        }
        showToast('排序更新失敗：' + (err.message || err), 'error');
        loadSettings(true);
      })
      .reorderSettingsOptions(category, orderedValues);
  }, 350);
}

var reorderChannelDebounceTimer = null;
var reorderChannelSeq = 0;

function reorderPaymentChannel(fromIdx, toIdx) {
  var m = ensureMetadataInitialized();
  var list = m.channels || [];
  if (fromIdx < 0 || fromIdx >= list.length || toIdx < 0 || toIdx >= list.length || fromIdx === toIdx) return;

  var moved = list.splice(fromIdx, 1)[0];
  list.splice(toIdx, 0, moved);
  m.channels = list;

  LocalCache.saveSettingsMetadata(m);
  var container = document.getElementById('settingsListContainer');
  if (container) {
    renderPaymentSettingsModule(container);
  }

  var newPmList = ['現金'];
  (m.channels || []).forEach(function(ch) {
    var chName = String(ch.name || '').trim();
    if (!chName) return;
    (m.cards || []).forEach(function(card) {
      var cardChannels = Array.isArray(card.channels) ? card.channels : [];
      if (cardChannels.includes(chName)) {
        var cardName = String(card.name || '').trim();
        if (cardName) {
          var combined = chName + '-' + cardName;
          if (!newPmList.includes(combined)) newPmList.push(combined);
        }
      }
    });
  });
  (m.banks || []).forEach(function(b) {
    var bName = String(b.name || '').trim();
    if (bName) {
      var tName = '轉帳-' + bName;
      if (!newPmList.includes(tName)) newPmList.push(tName);
    }
  });

  if (state.data && state.data.options) {
    state.data.options.paymentMethods = newPmList;
    if (state.data.settingsOptions) {
      state.data.settingsOptions.paymentMethods = newPmList.map(function(val, i) {
        return { row: i + 2, value: val };
      });
    }
    state.data.settingsMetadata = m;
    LocalCache.saveBoot(state.data);
    renderAllChoices();
  }

  reorderChannelSeq++;
  var currentSeq = reorderChannelSeq;

  if (reorderChannelDebounceTimer) {
    clearTimeout(reorderChannelDebounceTimer);
  }

  reorderChannelDebounceTimer = setTimeout(function() {
    reorderChannelDebounceTimer = null;
    Api.server
      .withSuccessHandler(function(result) {
        if (currentSeq !== reorderChannelSeq) return;
        if (result && result.ok) {
          settingsState.data = result.options;
          if (result.metadata) {
            settingsState.metadata = result.metadata;
            LocalCache.saveSettingsMetadata(result.metadata);
          }
          var cont = document.getElementById('settingsListContainer');
          if (cont) renderPaymentSettingsModule(cont);
          refreshBookkeepingOptions(result.simpleOptions, result.options, result.metadata);
        }
      })
      .withFailureHandler(function(err) {
        if (currentSeq !== reorderChannelSeq) return;
        showToast('通路排序更新失敗：' + (err.message || err), 'error');
        loadSettings(true);
      })
      .savePaymentSettingsConfig({
        channels: m.channels || [],
        cards: m.cards || [],
        banks: m.banks || [],
        channelColors: m.channelColors || {}
      });
  }, 350);
}
