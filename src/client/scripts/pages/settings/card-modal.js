var cardDraft = {
  id: null,
  oldName: null,
  name: '',
  type: 'credit',
  imageKey: 'haiyueWave',
  customImage: '',
  channels: []
};

function openCardModal(cardObj) {
  var m = ensureMetadataInitialized();
  var isEdit = Boolean(cardObj && cardObj.id);
  settingsState.editingCardId = isEdit ? cardObj.id : null;

  cardDraft.id = isEdit ? cardObj.id : ('card_' + Date.now());
  cardDraft.oldName = isEdit ? (cardObj.name || '') : null;
  cardDraft.name = isEdit ? (cardObj.name || '') : '';
  cardDraft.type = isEdit ? (cardObj.type || 'credit') : 'credit';
  cardDraft.imageKey = isEdit ? (cardObj.imageKey || '') : 'haiyueWave';
  var cachedImgs = LocalCache.getCustomImages();
  cardDraft.customImage = isEdit ? ((cachedImgs[cardObj.id]) || cardObj.customImage || cardObj.image || '') : '';
  cardDraft.channels = isEdit && Array.isArray(cardObj.channels) ? cardObj.channels.slice() : [];

  var titleEl = document.getElementById('cardModalTitle');
  if (titleEl) titleEl.textContent = isEdit ? '修改卡別' : '新增卡別';

  var nameInput = document.getElementById('cardFormName');
  if (nameInput) nameInput.value = cardDraft.name;

  updateCardTypeRadiosUI();
  renderCardPresetThumbsUI();
  renderCardChannelPillsUI(m.channels || []);
  updateCardMockupPreviewUI();

  var modal = document.getElementById('cardEditModal');
  if (modal) openModal(modal);
}

function closeCardModal() {
  var modal = document.getElementById('cardEditModal');
  if (modal) closeModal(modal);
  settingsState.editingCardId = null;
}

function updateCardTypeRadiosUI() {
  var creditLbl = document.getElementById('cardTypeCreditLabel');
  var debitLbl = document.getElementById('cardTypeDebitLabel');
  var isDebit = (cardDraft.type === 'debit');
  if (creditLbl) {
    creditLbl.classList.toggle('active', !isDebit);
    var r1 = creditLbl.querySelector('input');
    if (r1) r1.checked = !isDebit;
  }
  if (debitLbl) {
    debitLbl.classList.toggle('active', isDebit);
    var r2 = debitLbl.querySelector('input');
    if (r2) r2.checked = isDebit;
  }
}

document.querySelectorAll('input[name="cardFormType"]').forEach(function(radio) {
  radio.addEventListener('change', function() {
    cardDraft.type = radio.value === 'debit' ? 'debit' : 'credit';
    updateCardTypeRadiosUI();
    updateCardMockupPreviewUI();
  });
});

var cardFormNameInput = document.getElementById('cardFormName');
if (cardFormNameInput) {
  cardFormNameInput.addEventListener('input', function() {
    cardDraft.name = cardFormNameInput.value.trim();
    updateCardMockupPreviewUI();
  });
}

function renderCardPresetThumbsUI() {
  var wrap = document.getElementById('cardPresetThumbs');
  if (!wrap) return;
  wrap.innerHTML = '';
  PRESET_CARDS_LIST.forEach(function(preset) {
    var btn = document.createElement('button');
    btn.type = 'button';
    var isSelected = (!cardDraft.customImage && cardDraft.imageKey === preset.key);
    btn.className = 'card-preset-thumb-btn' + (isSelected ? ' active' : '');
    btn.title = preset.label;
    btn.innerHTML = '<img src="' + escAttr(preset.src) + '" alt="' + escAttr(preset.label) + '">';
    btn.addEventListener('click', function() {
      cardDraft.customImage = '';
      cardDraft.imageKey = preset.key;
      renderCardPresetThumbsUI();
      updateCardMockupPreviewUI();
    });
    wrap.appendChild(btn);
  });
}

var cardImageFileInput = document.getElementById('cardImageFileInput');
if (cardImageFileInput) {
  cardImageFileInput.addEventListener('change', function(e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    ImageOptimizer.compressCardImage(file)
      .then(function(dataUrl) {
        cardDraft.customImage = dataUrl;
        cardDraft.imageKey = '';
        renderCardPresetThumbsUI();
        updateCardMockupPreviewUI();
        showToast('卡面圖片已完成壓縮優化', 'success');
      })
      .catch(function(err) {
        showToast(err.message || '圖片處理失敗', 'error');
      });
    cardImageFileInput.value = '';
  });
}

function renderCardChannelPillsUI(channels) {
  var wrap = document.getElementById('cardChannelPills');
  if (!wrap) return;
  wrap.innerHTML = '';
  (channels || []).forEach(function(ch) {
    var isChecked = cardDraft.channels.includes(ch.name);
    var lbl = document.createElement('label');
    lbl.className = 'channel-pill-checkbox' + (isChecked ? ' checked' : '');
    var dotStyle = ch.color ? ' style="display:inline-block;width:8px;height:8px;border-radius:50%;background:' + escAttr(ch.color) + ';"' : '';
    lbl.innerHTML =
      '<input type="checkbox" value="' + escAttr(ch.name) + '"' + (isChecked ? ' checked' : '') + '>' +
      '<span' + dotStyle + '></span>' +
      '<span>' + escHtml(ch.name) + '</span>' +
      '<span class="pill-check-icon" aria-hidden="true">' + iconHtml('check') + '</span>';
    var chk = lbl.querySelector('input');
    chk.addEventListener('change', function() {
      if (chk.checked) {
        if (!cardDraft.channels.includes(ch.name)) cardDraft.channels.push(ch.name);
        lbl.classList.add('checked');
      } else {
        cardDraft.channels = cardDraft.channels.filter(function(x) { return x !== ch.name; });
        lbl.classList.remove('checked');
      }
    });
    wrap.appendChild(lbl);
  });
}

function updateCardMockupPreviewUI() {
  var bgEl = document.getElementById('cardMockupBg');
  var typeEl = document.getElementById('cardMockupType');
  var nameEl = document.getElementById('cardMockupName');

  var imgSrc = cardDraft.customImage || (cardDraft.imageKey && PAYMENT_CARD_IMAGES[cardDraft.imageKey]) || '';
  if (bgEl) {
    bgEl.style.backgroundImage = imgSrc ? ('url("' + imgSrc + '")') : 'none';
  }
  if (typeEl) {
    typeEl.textContent = (cardDraft.type === 'debit') ? 'Debit card' : 'Credit card';
  }
  if (nameEl) {
    nameEl.textContent = cardDraft.name || '卡片名稱';
  }
}

ModalManager.register('cardEditModal', {
  close: closeCardModal,
  busy: 'cardModalSubmitBtn'
});

var cardModalCloseIconBtn = document.getElementById('cardModalCloseIconBtn');
if (cardModalCloseIconBtn) cardModalCloseIconBtn.addEventListener('click', function() { ModalManager.close('cardEditModal'); });
var cardModalCancelBtn = document.getElementById('cardModalCancelBtn');
if (cardModalCancelBtn) cardModalCancelBtn.addEventListener('click', function() { ModalManager.close('cardEditModal'); });
var cardEditModalEl = document.getElementById('cardEditModal');
if (cardEditModalEl) {
  cardEditModalEl.addEventListener('click', function(e) {
    if (e.target === e.currentTarget) ModalManager.close('cardEditModal');
  });
}

var cardModalSubmitBtn = document.getElementById('cardModalSubmitBtn');
if (cardModalSubmitBtn) {
  cardModalSubmitBtn.addEventListener('click', function() {
    var cleanName = stripEmojiClient(cardDraft.name).replace(/[-－—–]/g, ' ').trim();
    if (!cleanName) {
      showToast('請輸入卡片名稱', 'error');
      return;
    }
    if (!cardDraft.channels.length) {
      showToast('請至少勾選一個支援的支付通路', 'error');
      return;
    }

    var m = ensureMetadataInitialized();
    var duplicate = (m.cards || []).find(function(c) {
      return c.name.toLowerCase() === cleanName.toLowerCase() && c.id !== cardDraft.id;
    });
    if (duplicate) {
      showToast('已存在相同名稱的卡片', 'error');
      return;
    }

    var newCardRecord = {
      id: cardDraft.id,
      name: cleanName,
      type: cardDraft.type,
      imageKey: cardDraft.imageKey || '',
      customImage: cardDraft.customImage || '',
      image: cardDraft.customImage || '',
      channels: cardDraft.channels.slice()
    };

    LocalCache.saveCustomImage(newCardRecord.id, newCardRecord.customImage);

    var isRenamed = Boolean(cardDraft.oldName && cardDraft.oldName !== cleanName);
    if (isRenamed && ccState.selectedCard === cardDraft.oldName) {
      ccState.selectedCard = cleanName;
    }

    var idx = (m.cards || []).findIndex(function(c) { return c.id === cardDraft.id; });
    if (idx >= 0) {
      m.cards[idx] = newCardRecord;
    } else {
      m.cards.push(newCardRecord);
    }

    var extraPayload = {
      cardRenames: isRenamed ? [{ id: cardDraft.id, oldName: cardDraft.oldName, newName: cleanName }] : []
    };

    persistPaymentSettingsToServer(m, cardModalSubmitBtn, '儲存卡別', function(result) {
      closeCardModal();
      if (result && result.updatedRowsCount > 0) {
        showToast('已儲存「' + cleanName + '」，並自動更新過往 ' + result.updatedMonthsCount + ' 個月份共 ' + result.updatedRowsCount + ' 筆歷史紀錄！', 'success');
      } else {
        showToast('已儲存卡別「' + cleanName + '」', 'success');
      }
    }, extraPayload);
  });
}
