var bankDraft = {
  id: null,
  name: '',
  logoKey: 'shanlan',
  customLogo: ''
};

function openBankModal(bankObj) {
  var isEdit = Boolean(bankObj && bankObj.id);
  settingsState.editingBankId = isEdit ? bankObj.id : null;

  bankDraft.id = isEdit ? bankObj.id : ('bank_' + Date.now());
  bankDraft.name = isEdit ? (bankObj.name || '') : '';
  bankDraft.logoKey = isEdit ? (bankObj.logoKey || '') : 'shanlan';
  var cachedImgs = LocalCache.getCustomImages();
  bankDraft.customLogo = isEdit ? ((cachedImgs[bankObj.id]) || bankObj.customLogo || bankObj.logo || '') : '';

  var titleEl = document.getElementById('bankModalTitle');
  if (titleEl) titleEl.textContent = isEdit ? '修改轉帳銀行' : '新增轉帳銀行';

  var nameInput = document.getElementById('bankFormName');
  if (nameInput) nameInput.value = bankDraft.name;

  renderBankPresetLogosUI();
  updateBankPreviewUI();

  var modal = document.getElementById('bankEditModal');
  if (modal) openModal(modal);
}

function closeBankModal() {
  var modal = document.getElementById('bankEditModal');
  if (modal) closeModal(modal);
  settingsState.editingBankId = null;
}

function renderBankPresetLogosUI() {
  var wrap = document.getElementById('bankPresetLogos');
  if (!wrap) return;
  wrap.innerHTML = '';
  PRESET_BANKS_LIST.forEach(function(preset) {
    var btn = document.createElement('button');
    btn.type = 'button';
    var isAct = (!bankDraft.customLogo && bankDraft.logoKey === preset.key);
    btn.className = 'card-preset-thumb-btn' + (isAct ? ' active' : '');
    btn.style.width = '40px';
    btn.style.height = '40px';
    btn.style.borderRadius = '50%';
    btn.style.background = 'var(--logo-plate)';
    btn.style.padding = '3px';
    btn.title = preset.label;
    btn.innerHTML = '<img src="' + escAttr(preset.src) + '" alt="' + escAttr(preset.label) + '" style="object-fit:contain;">';
    btn.addEventListener('click', function() {
      bankDraft.customLogo = '';
      bankDraft.logoKey = preset.key;
      if (!bankDraft.name) {
        bankDraft.name = preset.label;
        var nameInput = document.getElementById('bankFormName');
        if (nameInput) nameInput.value = preset.label;
      }
      renderBankPresetLogosUI();
      updateBankPreviewUI();
    });
    wrap.appendChild(btn);
  });
}

var bankFormNameInput = document.getElementById('bankFormName');
if (bankFormNameInput) {
  bankFormNameInput.addEventListener('input', function() {
    bankDraft.name = bankFormNameInput.value.trim();
    updateBankPreviewUI();
  });
}

var bankLogoFileInput = document.getElementById('bankLogoFileInput');
if (bankLogoFileInput) {
  bankLogoFileInput.addEventListener('change', function(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    ImageOptimizer.compressBankLogo(file)
      .then(function(dataUrl) {
        bankDraft.customLogo = dataUrl;
        bankDraft.logoKey = '';
        renderBankPresetLogosUI();
        updateBankPreviewUI();
        showToast('銀行圖示已壓縮優化完成', 'success');
      })
      .catch(function(err) {
        showToast(err.message || '圖示處理失敗', 'error');
      });
    bankLogoFileInput.value = '';
  });
}

function updateBankPreviewUI() {
  var imgEl = document.getElementById('bankPreviewLogo');
  var nameEl = document.getElementById('bankPreviewName');
  var src = bankDraft.customLogo || (bankDraft.logoKey && BANK_LOGOS[bankDraft.logoKey]) || '';
  if (imgEl) {
    if (src) {
      imgEl.src = src;
      imgEl.style.display = 'inline-block';
    } else {
      imgEl.style.display = 'none';
    }
  }
  if (nameEl) {
    nameEl.textContent = bankDraft.name || '銀行名稱';
  }
}

ModalManager.register('bankEditModal', {
  close: closeBankModal,
  busy: 'bankModalSubmitBtn'
});

var bankModalCloseIconBtn = document.getElementById('bankModalCloseIconBtn');
if (bankModalCloseIconBtn) bankModalCloseIconBtn.addEventListener('click', function() { ModalManager.close('bankEditModal'); });
var bankModalCancelBtn = document.getElementById('bankModalCancelBtn');
if (bankModalCancelBtn) bankModalCancelBtn.addEventListener('click', function() { ModalManager.close('bankEditModal'); });
var bankEditModalEl = document.getElementById('bankEditModal');
if (bankEditModalEl) {
  bankEditModalEl.addEventListener('click', function(e) {
    if (e.target === e.currentTarget) ModalManager.close('bankEditModal');
  });
}

var bankModalSubmitBtn = document.getElementById('bankModalSubmitBtn');
if (bankModalSubmitBtn) {
  bankModalSubmitBtn.addEventListener('click', function() {
    var cleanName = stripEmojiClient(bankDraft.name).replace(/[-－—–]/g, ' ').trim();
    if (!cleanName) {
      showToast('請輸入銀行名稱', 'error');
      return;
    }

    var m = ensureMetadataInitialized();
    var dup = (m.banks || []).find(function(b) {
      return b.name.toLowerCase() === cleanName.toLowerCase() && b.id !== bankDraft.id;
    });
    if (dup) {
      showToast('已存在相同名稱的銀行', 'error');
      return;
    }

    var newBankRecord = {
      id: bankDraft.id,
      name: cleanName,
      logoKey: bankDraft.logoKey || '',
      customLogo: bankDraft.customLogo || '',
      logo: bankDraft.customLogo || ''
    };

    LocalCache.saveCustomImage(newBankRecord.id, newBankRecord.customLogo);

    var idx = (m.banks || []).findIndex(function(b) { return b.id === bankDraft.id; });
    if (idx >= 0) {
      m.banks[idx] = newBankRecord;
    } else {
      m.banks.push(newBankRecord);
    }

    persistPaymentSettingsToServer(m, bankModalSubmitBtn, '儲存銀行', function(result) {
      closeBankModal();
      if (result && result.updatedRowsCount > 0) {
        showToast('已儲存「' + cleanName + '」，並自動更新過往 ' + result.updatedMonthsCount + ' 個月份共 ' + result.updatedRowsCount + ' 筆歷史紀錄！', 'success');
      } else {
        showToast('已儲存轉帳銀行「' + cleanName + '」', 'success');
      }
    });
  });
}
