function addSettingsItem() {
  var input = document.getElementById('settingsNewInput');
  if (!input) return;
  var rawValue = input.value.trim();
  var cleanValue = stripEmojiClient(rawValue);
  if (!cleanValue) {
    showToast('請輸入純文字選項名稱', 'error');
    input.focus();
    return;
  }

  var tab = settingsState.currentTab;
  var isItemWithEmoji = (tab === 'expenseItems' || tab === 'incomeItems');
  var chosenEmoji = isItemWithEmoji ? (ICON_VALUE_PREFIX + (settingsState.selectedIcon || getItemIcon(cleanValue) || 'tag')) : '';
  var addPos = settingsState.addPosition || 'bottom';

  var addBtn = document.getElementById('settingsAddBtn');
  if (addBtn) addBtn.disabled = true;
  setLoading(true);

  if (isItemWithEmoji) {
    var m = ensureMetadataInitialized();
    m.itemEmojis[cleanValue] = chosenEmoji;
    m.emojis[cleanValue] = chosenEmoji;
    LocalCache.saveSettingsMetadata(m);

    Api.server
      .withSuccessHandler(function(result) {
        setLoading(false);
        if (addBtn) addBtn.disabled = false;
        if (result && result.ok) {
          settingsState.data = result.options;
          if (result.metadata) {
            settingsState.metadata = result.metadata;
            LocalCache.saveSettingsMetadata(result.metadata);
          }
          renderSettingsList();
          input.value = '';
          input.focus();
          showToast('已新增「' + cleanValue + '」', 'success');
          refreshBookkeepingOptions(result.simpleOptions, result.options, result.metadata);
        }
      })
      .withFailureHandler(function(err) {
        setLoading(false);
        if (addBtn) addBtn.disabled = false;
        showToast('新增失敗：' + (err.message || err), 'error');
      })
      .saveSettingsItemWithEmoji({
        category: tab,
        row: null,
        name: cleanValue,
        emoji: chosenEmoji,
        position: addPos
      });
  } else {
    Api.server
      .withSuccessHandler(function(result) {
        setLoading(false);
        if (addBtn) addBtn.disabled = false;
        if (result && result.ok) {
          settingsState.data = result.options;
          renderSettingsList();
          input.value = '';
          input.focus();
          showToast('已新增「' + cleanValue + '」', 'success');
          refreshBookkeepingOptions(result.simpleOptions, result.options, result.metadata);
        }
      })
      .withFailureHandler(function(err) {
        setLoading(false);
        if (addBtn) addBtn.disabled = false;
        showToast('新增失敗：' + (err.message || err), 'error');
      })
      .addSettingsOption(tab, cleanValue, addPos);
  }
}

function openItemEmojiEditModal(category, row, currentName) {
  settingsState.editingItemCategory = category;
  settingsState.editingItemRow = row;

  var cleanName = stripEmojiClient(currentName);
  var curIcon = getItemIcon(currentName) || 'tag';

  var emojiCharEl = document.getElementById('itemEditEmojiChar');
  var modalEmojiEl = document.getElementById('itemEditModalCurrentEmoji');
  var nameInput = document.getElementById('itemEditNameInput');

  setIcon(emojiCharEl, curIcon);
  setIcon(modalEmojiEl, curIcon);
  if (nameInput) nameInput.value = cleanName;

  settingsState.editingItemColor = getCustomItemColor(String(currentName || '').trim()) || getCustomItemColor(cleanName);
  renderItemEditColorSwatches();

  var modal = document.getElementById('itemEditModal');
  if (modal) openModal(modal);
  setTimeout(function() {
    if (nameInput) {
      nameInput.focus();
      nameInput.select();
    }
  }, 60);
}

/* 按鈕顏色：第一格「自動」＝照名稱判斷（格子本身顯示自動判斷出來的顏色），其餘是 ITEM_COLOR_PALETTE 的色板 */
function renderItemEditColorSwatches() {
  var wrap = document.getElementById('itemEditColorSwatches');
  if (!wrap) return;
  if (!wrap._bound) {
    wrap._bound = true;
    wrap.addEventListener('click', function(e) {
      var btn = e.target.closest('.item-color-swatch');
      if (!btn || !wrap.contains(btn)) return;
      selectItemEditColor(btn.dataset.color || '', false);
    });
    wrap.addEventListener('keydown', function(e) {
      var keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!keys[e.key]) return;
      e.preventDefault();
      var btns = Array.prototype.slice.call(wrap.querySelectorAll('.item-color-swatch'));
      var idx = btns.indexOf(document.activeElement);
      if (idx < 0) idx = 0;
      var next = btns[(idx + keys[e.key] + btns.length) % btns.length];
      selectItemEditColor(next.dataset.color || '', true);
    });
    var nameInput = document.getElementById('itemEditNameInput');
    if (nameInput) nameInput.addEventListener('input', updateItemEditColorPreview);
  }

  if (!wrap.childElementCount) {
    var autoBtn = document.createElement('button');
    autoBtn.type = 'button';
    autoBtn.className = 'item-color-swatch item-color-swatch-auto';
    autoBtn.dataset.color = '';
    autoBtn.setAttribute('role', 'radio');
    autoBtn.setAttribute('aria-label', '自動（依項目名稱）');
    autoBtn.title = '自動（依項目名稱）';
    autoBtn.innerHTML = iconHtml('magic-wand', 'regular', 'ic-14') + '<span>自動</span>';
    wrap.appendChild(autoBtn);
    ITEM_COLOR_PALETTE.forEach(function(c) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'item-color-swatch';
      btn.dataset.color = c.key;
      btn.setAttribute('role', 'radio');
      btn.setAttribute('aria-label', c.label);
      btn.title = c.label;
      btn.style.setProperty('--sw-ink', 'var(--cat-' + c.key + '-ink)');
      btn.style.setProperty('--sw-bg', 'var(--cat-' + c.key + '-bg-selected)');
      btn.innerHTML = '<span class="item-color-swatch-dot" aria-hidden="true">' + iconHtml('check', 'regular', 'item-color-swatch-check') + '</span>';
      wrap.appendChild(btn);
    });
  }
  syncItemEditColorSwatches();
}

function selectItemEditColor(key, focus) {
  settingsState.editingItemColor = isItemColorKey(key) ? key : '';
  syncItemEditColorSwatches();
  if (focus) {
    var wrap = document.getElementById('itemEditColorSwatches');
    var active = wrap && wrap.querySelector('.item-color-swatch[aria-checked="true"]');
    if (active) active.focus();
  }
}

function itemEditPreviewName() {
  var nameInput = document.getElementById('itemEditNameInput');
  return stripEmojiClient(nameInput ? nameInput.value : '');
}

function syncItemEditColorSwatches() {
  var wrap = document.getElementById('itemEditColorSwatches');
  if (!wrap) return;
  var current = settingsState.editingItemColor || '';
  wrap.querySelectorAll('.item-color-swatch').forEach(function(btn) {
    var on = (btn.dataset.color || '') === current;
    btn.setAttribute('aria-checked', on ? 'true' : 'false');
    btn.tabIndex = on ? 0 : -1;
  });
  updateItemEditColorPreview();
}

function updateItemEditColorPreview() {
  var preview = document.getElementById('itemEditColorPreview');
  var autoBtn = document.querySelector('#itemEditColorSwatches .item-color-swatch-auto');
  var name = itemEditPreviewName();
  var autoCat = getAutoItemCategory(name || '');
  var autoKey = autoCat && autoCat !== 'default' ? autoCat : '';
  if (autoBtn) {
    if (autoKey) {
      autoBtn.style.setProperty('--sw-ink', 'var(--cat-' + autoKey + '-ink)');
      autoBtn.style.setProperty('--sw-bg', 'var(--cat-' + autoKey + '-bg-selected)');
    } else {
      autoBtn.style.removeProperty('--sw-ink');
      autoBtn.style.removeProperty('--sw-bg');
    }
  }
  if (!preview) return;
  var cat = settingsState.editingItemColor || autoKey;
  if (cat) preview.dataset.cat = cat;
  else delete preview.dataset.cat;
  var icon = readIconName(document.getElementById('itemEditEmojiChar')) || 'tag';
  preview.innerHTML = '<span class="choice-emoji" aria-hidden="true">' + iconHtml(icon) + '</span>' +
    '<span class="choice-text">' + escHtml(name || '項目名稱') + '</span>';
}

function closeItemEmojiEditModal() {
  closeEmojiPopover();
  var modal = document.getElementById('itemEditModal');
  if (modal) closeModal(modal);
  settingsState.editingItemRow = null;
  settingsState.editingItemCategory = null;
  settingsState.editingItemColor = '';
}

ModalManager.register('itemEditModal', {
  close: closeItemEmojiEditModal,
  busy: 'itemEditModalSubmitBtn'
});

var itemEditCloseBtn = document.getElementById('itemEditModalCloseIconBtn');
if (itemEditCloseBtn) itemEditCloseBtn.addEventListener('click', function() { ModalManager.close('itemEditModal'); });
var itemEditCancelBtn = document.getElementById('itemEditModalCancelBtn');
if (itemEditCancelBtn) itemEditCancelBtn.addEventListener('click', function() { ModalManager.close('itemEditModal'); });
var itemEditModalEl = document.getElementById('itemEditModal');
if (itemEditModalEl) {
  itemEditModalEl.addEventListener('click', function(e) {
    if (e.target === e.currentTarget) ModalManager.close('itemEditModal');
  });
}

var itemEditSubmitBtn = document.getElementById('itemEditModalSubmitBtn');
if (itemEditSubmitBtn) {
  itemEditSubmitBtn.addEventListener('click', function() {
    var nameInput = document.getElementById('itemEditNameInput');
    var emojiCharEl = document.getElementById('itemEditEmojiChar');
    var cleanName = stripEmojiClient(nameInput ? nameInput.value : '');
    var chosenEmoji = ICON_VALUE_PREFIX + (readIconName(emojiCharEl) || 'tag');

    if (!cleanName) {
      showToast('請輸入項目名稱', 'error');
      return;
    }

    var category = settingsState.editingItemCategory;
    var row = settingsState.editingItemRow;
    if (!category || !row) return;

    itemEditSubmitBtn.disabled = true;
    itemEditSubmitBtn.textContent = '儲存中…';
    setLoading(true);

    var chosenColor = settingsState.editingItemColor || '';
    var m = ensureMetadataInitialized();
    m.itemEmojis[cleanName] = chosenEmoji;
    m.emojis[cleanName] = chosenEmoji;
    if (!m.itemColors) m.itemColors = {};
    if (chosenColor) m.itemColors[cleanName] = chosenColor;
    else delete m.itemColors[cleanName];
    LocalCache.saveSettingsMetadata(m);

    Api.server
      .withSuccessHandler(function(result) {
        setLoading(false);
        itemEditSubmitBtn.disabled = false;
        itemEditSubmitBtn.textContent = '儲存修改';
        if (result && result.ok) {
          settingsState.data = result.options;
          if (result.metadata) {
            settingsState.metadata = result.metadata;
            LocalCache.saveSettingsMetadata(result.metadata);
          }
          closeItemEmojiEditModal();
          renderSettingsList();
          showToast('已更新「' + cleanName + '」', 'success');
          refreshBookkeepingOptions(result.simpleOptions, result.options, result.metadata);
        }
      })
      .withFailureHandler(function(err) {
        setLoading(false);
        itemEditSubmitBtn.disabled = false;
        itemEditSubmitBtn.textContent = '儲存修改';
        showToast('修改失敗：' + (err.message || err), 'error');
      })
      .saveSettingsItemWithEmoji({
        category: category,
        row: row,
        name: cleanName,
        emoji: chosenEmoji,
        color: chosenColor
      });
  });
}

function startInlineEdit(row, oldValue) {
  var valSpan = document.getElementById('settingsVal_' + row);
  if (!valSpan) return;
  if (valSpan.querySelector('.settings-edit-input')) return;

  var li = valSpan.closest('.settings-item');
  if (li) li.classList.add('editing');

  var input = document.createElement('input');
  input.type = 'text';
  input.className = 'text-input settings-edit-input';
  input.value = oldValue;
  input.maxLength = 50;

  var btnGroup = document.createElement('div');
  btnGroup.className = 'settings-edit-btns';

  var saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'settings-save-btn';
  saveBtn.textContent = '儲存';

  var cancelBtn = document.createElement('button');
  cancelBtn.type = 'button';
  cancelBtn.className = 'settings-cancel-btn';
  cancelBtn.textContent = '取消';

  btnGroup.appendChild(saveBtn);
  btnGroup.appendChild(cancelBtn);

  valSpan.textContent = '';
  valSpan.appendChild(input);
  valSpan.appendChild(btnGroup);

  input.focus();
  input.select();

  function doSave() {
    var newValue = stripEmojiClient(input.value);
    if (!newValue) {
      showToast('選項名稱不可為空白', 'error');
      return;
    }
    if (newValue === oldValue) {
      doCancel();
      return;
    }

    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    setLoading(true);

    Api.server
      .withSuccessHandler(function(result) {
        setLoading(false);
        if (result && result.ok) {
          settingsState.data = result.options;
          renderSettingsList();
          showToast('已修改「' + oldValue + '」→「' + newValue + '」', 'success');
          refreshBookkeepingOptions(result.simpleOptions, result.options, result.metadata);
        }
      })
      .withFailureHandler(function(err) {
        setLoading(false);
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        showToast('修改失敗：' + (err.message || err), 'error');
      })
      .updateSettingsOption(settingsState.currentTab, row, newValue);
  }

  function doCancel() {
    if (li) li.classList.remove('editing');
    valSpan.textContent = oldValue;
  }

  saveBtn.addEventListener('click', doSave);
  cancelBtn.addEventListener('click', doCancel);
  input.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') { e.preventDefault(); doSave(); }
    if (e.key === 'Escape') { e.preventDefault(); doCancel(); }
  });
}
