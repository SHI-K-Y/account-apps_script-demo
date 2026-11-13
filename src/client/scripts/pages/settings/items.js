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

  var modal = document.getElementById('itemEditModal');
  if (modal) openModal(modal);
  setTimeout(function() {
    if (nameInput) {
      nameInput.focus();
      nameInput.select();
    }
  }, 60);
}

function closeItemEmojiEditModal() {
  closeEmojiPopover();
  var modal = document.getElementById('itemEditModal');
  if (modal) closeModal(modal);
  settingsState.editingItemRow = null;
  settingsState.editingItemCategory = null;
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

    var m = ensureMetadataInitialized();
    m.itemEmojis[cleanName] = chosenEmoji;
    m.emojis[cleanName] = chosenEmoji;
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
        emoji: chosenEmoji
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
