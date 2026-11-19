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
    container._settingsListTab = null;
    container.innerHTML =
      '<div class="settings-empty">' +
        '<div class="settings-empty-icon" aria-hidden="true">' + iconHtml('tray') + '</div>' +
        '<div class="settings-empty-text">尚無' + tabLabel + '，請於上方新增</div>' +
      '</div>';
    return;
  }

  // P06：同一個分頁重繪時只更新有變化的列（排序、改名、新增、刪除），外框與標題不重建；
  // 按鈕與拖曳一律委派到清單（bindSettingsListEvents／bindSettingsListDrag，只綁一次）。
  var list = container.querySelector(':scope > #settingsSortableList');
  if (container._settingsListTab !== tab || !list) {
    container.innerHTML = '<div class="settings-list-header">' +
                 '<div class="settings-list-title-wrap">' +
                   '<span class="settings-list-title">' + tabLabel + '</span>' +
                   '<span class="settings-order-hint">可使用上下箭頭或拖曳自訂順序</span>' +
                 '</div>' +
                 '<span class="settings-list-count"></span>' +
               '</div>' +
               '<ul class="settings-list" id="settingsSortableList"></ul>';
    container._settingsListTab = tab;
    list = container.querySelector('#settingsSortableList');
  }
  ListRender.setText(container.querySelector('.settings-list-count'), '共 ' + items.length + ' 項');
  bindSettingsListEvents(container);
  container._settingsList = { tab: tab, count: items.length, isItemWithEmoji: isItemWithEmoji, tabLabel: tabLabel };

  var rowHtml = function(item) {
    var itemIcon = isItemWithEmoji ? getItemIcon(item.value) : '';
    return '<li class="settings-item" draggable="true" data-row="' + item.row + '">' +
              '<div class="settings-item-main">' +
                '<span class="settings-drag-handle" title="按住拖曳自訂順序" aria-label="拖曳排序">' + iconHtml('dots-six-vertical') + '</span>' +
                '<span class="settings-item-order"></span>' +
                (itemIcon ? '<span class="settings-item-emoji" aria-hidden="true">' + iconHtml(itemIcon) + '</span>' : '') +
                '<span class="settings-item-value" id="settingsVal_' + item.row + '">' + escHtml(isItemWithEmoji ? itemDisplayName(item.value) : item.value) + '</span>' +
              '</div>' +
              '<div class="settings-item-actions">' +
                '<button class="settings-action-btn settings-move-btn settings-move-up-btn" type="button" title="向上移動一位">' +
                  iconHtml('caret-up') +
                '</button>' +
                '<button class="settings-action-btn settings-move-btn settings-move-down-btn" type="button" title="向下移動一位">' +
                  iconHtml('caret-down') +
                '</button>' +
                '<button class="settings-action-btn settings-edit-btn" type="button" data-row="' + item.row + '" data-value="' + escAttr(item.value) + '" title="修改">' +
                  iconHtml('note-pencil', 'regular', 'ic-15') +
                '</button>' +
                '<button class="settings-action-btn settings-delete-btn" type="button" data-row="' + item.row + '" data-value="' + escAttr(item.value) + '" title="刪除">' +
                  iconHtml('trash', 'regular', 'ic-15') +
                '</button>' +
              '</div>' +
            '</li>';
  };
  // 行內編輯中的列：以前重繪會整份重建、順便結束編輯；這裡維持一樣的行為，不沿用那一列
  list.querySelectorAll('.settings-item.editing').forEach(ListRender.markLeaving);
  ListRender.reconcile(list, items, {
    key: function(item) { return item.value; },
    sig: rowHtml,
    html: rowHtml,
    // 跟著位置變的部分（序號、data-idx、上下鈕是否停用）每次都直接更新，其餘內容不動
    place: function(el, item, idx) {
      var idxStr = String(idx);
      if (el.dataset.idx !== idxStr) {
        el.dataset.idx = idxStr;
        el.querySelector('.settings-item-order').textContent = String(idx + 1);
        el.querySelectorAll('.settings-move-btn').forEach(function(btn) { btn.dataset.idx = idxStr; });
      }
      var up = el.querySelector('.settings-move-up-btn');
      var down = el.querySelector('.settings-move-down-btn');
      if (up.disabled !== (idx === 0)) up.disabled = (idx === 0);
      if (down.disabled !== (idx === items.length - 1)) down.disabled = (idx === items.length - 1);
    }
  });

  bindSettingsListDrag(list, function(from, to) {
    reorderSettingsItem(tab, from, to);
  });
}

function bindSettingsListEvents(container) {
  if (container._settingsListBound) return;
  container._settingsListBound = true;
  container.addEventListener('click', function(e) {
    var info = container._settingsList;
    var btn = e.target && e.target.closest ? e.target.closest('.settings-action-btn') : null;
    if (!info || !btn || !btn.closest('#settingsSortableList') || !container.contains(btn)) return;
    if (container._settingsListTab !== info.tab || btn.disabled) return;
    var tab = info.tab;
    if (btn.classList.contains('settings-move-up-btn') || btn.classList.contains('settings-move-down-btn')) {
      e.stopPropagation();
      var idx = Number(btn.dataset.idx);
      if (btn.classList.contains('settings-move-up-btn')) {
        if (idx > 0) reorderSettingsItem(tab, idx, idx - 1, true);
      } else if (idx < info.count - 1) {
        reorderSettingsItem(tab, idx, idx + 1, true);
      }
      return;
    }
    var row = Number(btn.dataset.row);
    var value = btn.dataset.value;
    if (btn.classList.contains('settings-edit-btn')) {
      if (info.isItemWithEmoji) openItemEmojiEditModal(tab, row, value);
      else startInlineEdit(row, value);
    } else if (btn.classList.contains('settings-delete-btn')) {
      openSettingsDeleteConfirm({
        mode: info.isItemWithEmoji ? 'itemWithEmoji' : 'simpleOption',
        category: tab,
        row: row,
        name: value,
        label: info.tabLabel
      });
    }
  });
}

var reorderDebounceTimers = {};
var reorderSeq = 0;

// 拖曳排序：事件委派到清單本身（P06），列重繪或增減時不必重新綁定；onMove 每次渲染更新。
function bindSettingsListDrag(sortableList, onMove) {
  if (!sortableList) return;
  sortableList._settingsDragMove = onMove;
  if (sortableList._settingsDragBound) return;
  sortableList._settingsDragBound = true;
  var dragSrcIdx = null;
  var itemOf = function(e) {
    var el = e.target && e.target.closest ? e.target.closest('.settings-item') : null;
    return el && el.parentNode === sortableList ? el : null;
  };

  sortableList.addEventListener('dragstart', function(e) {
    var itemEl = itemOf(e);
    if (!itemEl) return;
    dragSrcIdx = Number(itemEl.dataset.idx);
    itemEl.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    try {
      e.dataTransfer.setData('text/plain', String(dragSrcIdx));
    } catch (err) {}
  });

  sortableList.addEventListener('dragover', function(e) {
    var itemEl = itemOf(e);
    if (!itemEl) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (!itemEl.classList.contains('dragging')) {
      itemEl.classList.add('drag-over');
    }
  });

  sortableList.addEventListener('dragleave', function(e) {
    var itemEl = itemOf(e);
    if (itemEl) itemEl.classList.remove('drag-over');
  });

  sortableList.addEventListener('drop', function(e) {
    var itemEl = itemOf(e);
    if (!itemEl) return;
    e.preventDefault();
    e.stopPropagation();
    itemEl.classList.remove('drag-over');
    var targetIdx = Number(itemEl.dataset.idx);
    if (dragSrcIdx !== null && targetIdx !== dragSrcIdx && !isNaN(targetIdx)) {
      var from = dragSrcIdx;
      dragSrcIdx = null;
      sortableList._settingsDragMove(from, targetIdx);
    }
  });

  sortableList.addEventListener('dragend', function(e) {
    var itemEl = itemOf(e);
    if (itemEl) itemEl.classList.remove('dragging');
    sortableList.querySelectorAll('.settings-item').forEach(function(el) {
      el.classList.remove('drag-over');
    });
    dragSrcIdx = null;
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
