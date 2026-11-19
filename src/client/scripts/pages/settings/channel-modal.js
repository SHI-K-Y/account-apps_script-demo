var channelDraft = {
  oldName: null,
  name: '',
  color: '#288465',
  boundCardIds: []
};

function openChannelModal(chObj) {
  var isEdit = Boolean(chObj && chObj.name);
  settingsState.editingChannelName = isEdit ? chObj.name : null;

  channelDraft.oldName = isEdit ? chObj.name : null;
  channelDraft.name = isEdit ? chObj.name : '';
  channelDraft.color = (chObj && chObj.color) || '#288465';

  var m = ensureMetadataInitialized();
  var boundIds = [];
  if (isEdit && chObj.name) {
    (m.cards || []).forEach(function(card) {
      if (Array.isArray(card.channels) && card.channels.includes(chObj.name)) {
        boundIds.push(card.id);
      }
    });
  }
  channelDraft.boundCardIds = boundIds;

  var titleEl = document.getElementById('channelModalTitle');
  if (titleEl) titleEl.textContent = isEdit ? '修改支付通路' : '新增支付通路';

  var nameInput = document.getElementById('channelFormName');
  if (nameInput) nameInput.value = channelDraft.name;

  var nativePicker = document.getElementById('channelNativeColorPicker');
  if (nativePicker) nativePicker.value = channelDraft.color;

  renderColorPresetSwatchesUI();
  renderChannelBoundCardsUI();
  updateChannelPreviewUI();

  var modal = document.getElementById('channelEditModal');
  if (modal) openModal(modal);
}

function closeChannelModal() {
  var modal = document.getElementById('channelEditModal');
  if (modal) closeModal(modal);
  settingsState.editingChannelName = null;
}

function renderChannelBoundCardsUI() {
  var wrap = document.getElementById('channelBoundCardPills');
  if (!wrap) return;
  wrap.innerHTML = '';

  var m = ensureMetadataInitialized();
  var cards = m.cards || [];

  if (!cards.length) {
    wrap.innerHTML = '<span class="channel-no-cards-hint">尚無已設定的卡別，可儲存通路後至「卡別管理」新增卡片</span>';
    return;
  }

  var cachedImgs = LocalCache.getCustomImages();

  cards.forEach(function(card) {
    var isChecked = channelDraft.boundCardIds.includes(card.id);
    var lbl = document.createElement('label');
    lbl.className = 'channel-pill-checkbox card-pill-checkbox' + (isChecked ? ' checked' : '');

    var imgSrc = (card.id && cachedImgs[card.id]) || card.customImage || card.image || (card.imageKey && PAYMENT_CARD_IMAGES[card.imageKey]) || '';
    var thumbHtml = imgSrc
      ? '<img class="card-pill-mini-thumb" src="' + escAttr(imgSrc) + '" alt="" width="22" height="14" decoding="async">'
      : '<span class="card-pill-mini-icon" aria-hidden="true">' + iconHtml(card.type === 'debit' ? 'contactless-payment' : 'credit-card') + '</span>';

    lbl.innerHTML =
      '<input type="checkbox" value="' + escAttr(card.id) + '"' + (isChecked ? ' checked' : '') + '>' +
      thumbHtml +
      '<span class="card-pill-title">' + escHtml(card.name) + '</span>' +
      '<span class="pill-check-icon" aria-hidden="true">' + iconHtml('check') + '</span>';

    var chk = lbl.querySelector('input');
    chk.addEventListener('change', function() {
      if (chk.checked) {
        if (!channelDraft.boundCardIds.includes(card.id)) {
          channelDraft.boundCardIds.push(card.id);
        }
        lbl.classList.add('checked');
      } else {
        channelDraft.boundCardIds = channelDraft.boundCardIds.filter(function(id) { return id !== card.id; });
        lbl.classList.remove('checked');
      }
      updateChannelPreviewUI();
    });

    wrap.appendChild(lbl);
  });
}

var channelSelectAllCardsBtn = document.getElementById('channelSelectAllCardsBtn');
if (channelSelectAllCardsBtn) {
  channelSelectAllCardsBtn.addEventListener('click', function() {
    var m = ensureMetadataInitialized();
    channelDraft.boundCardIds = (m.cards || []).map(function(c) { return c.id; });
    renderChannelBoundCardsUI();
    updateChannelPreviewUI();
  });
}

var channelDeselectAllCardsBtn = document.getElementById('channelDeselectAllCardsBtn');
if (channelDeselectAllCardsBtn) {
  channelDeselectAllCardsBtn.addEventListener('click', function() {
    channelDraft.boundCardIds = [];
    renderChannelBoundCardsUI();
    updateChannelPreviewUI();
  });
}

function renderColorPresetSwatchesUI() {
  var wrap = document.getElementById('colorPresetSwatches');
  if (!wrap) return;
  wrap.innerHTML = '';
  PRESET_CHANNEL_COLORS.forEach(function(hex) {
    var btn = document.createElement('button');
    btn.type = 'button';
    var isAct = (channelDraft.color.toLowerCase() === hex.toLowerCase());
    btn.className = 'color-swatch-btn' + (isAct ? ' active' : '');
    btn.style.backgroundColor = hex;
    btn.addEventListener('click', function() {
      channelDraft.color = hex;
      var nativePicker = document.getElementById('channelNativeColorPicker');
      if (nativePicker) nativePicker.value = hex;
      renderColorPresetSwatchesUI();
      updateChannelPreviewUI();
    });
    wrap.appendChild(btn);
  });
}

var channelNativeColorPicker = document.getElementById('channelNativeColorPicker');
if (channelNativeColorPicker) {
  channelNativeColorPicker.addEventListener('input', function() {
    channelDraft.color = channelNativeColorPicker.value;
    renderColorPresetSwatchesUI();
    updateChannelPreviewUI();
  });
}

var channelFormNameInput = document.getElementById('channelFormName');
if (channelFormNameInput) {
  channelFormNameInput.addEventListener('input', function() {
    channelDraft.name = channelFormNameInput.value.trim();
    updateChannelPreviewUI();
  });
}

function updateChannelPreviewUI() {
  var hexText = document.getElementById('channelColorHexText');
  var badge = document.getElementById('channelPreviewBadge');
  var textSpan = document.getElementById('channelPreviewText');
  var dot = document.getElementById('channelPreviewDot');
  var countSpan = document.getElementById('channelPreviewCardsCount');
  if (hexText) hexText.textContent = channelDraft.color;
  if (badge) {
    badge.style.backgroundColor = hexToRgbaStr(channelDraft.color, 0.18);
    badge.style.borderColor = hexToRgbaStr(channelDraft.color, 0.55);
    badge.style.color = channelDraft.color;
  }
  if (dot) {
    dot.style.backgroundColor = channelDraft.color;
    dot.style.boxShadow = '0 0 6px ' + hexToRgbaStr(channelDraft.color, 0.6);
  }
  if (textSpan) textSpan.textContent = channelDraft.name || '通路名稱';
  if (countSpan) {
    var count = (channelDraft.boundCardIds || []).length;
    countSpan.textContent = count > 0 ? ('已選 ' + count + ' 張卡片') : '尚未勾選卡片';
  }
}

ModalManager.register('channelEditModal', {
  close: closeChannelModal,
  busy: 'channelModalSubmitBtn'
});

var channelModalCloseIconBtn = document.getElementById('channelModalCloseIconBtn');
if (channelModalCloseIconBtn) channelModalCloseIconBtn.addEventListener('click', function() { ModalManager.close('channelEditModal'); });
var channelModalCancelBtn = document.getElementById('channelModalCancelBtn');
if (channelModalCancelBtn) channelModalCancelBtn.addEventListener('click', function() { ModalManager.close('channelEditModal'); });
var channelEditModalEl = document.getElementById('channelEditModal');
if (channelEditModalEl) {
  channelEditModalEl.addEventListener('click', function(e) {
    if (e.target === e.currentTarget) ModalManager.close('channelEditModal');
  });
}

var channelModalSubmitBtn = document.getElementById('channelModalSubmitBtn');
if (channelModalSubmitBtn) {
  channelModalSubmitBtn.addEventListener('click', function() {
    var cleanName = stripEmojiClient(channelDraft.name).replace(/[-－—–]/g, ' ').trim();
    if (!cleanName) {
      showToast('請輸入支付通路名稱', 'error');
      return;
    }
    if (cleanName === '轉帳' || cleanName === '現金') {
      showToast('「現金」與「轉帳」為系統專用保留通道', 'error');
      return;
    }

    var m = ensureMetadataInitialized();
    var dup = (m.channels || []).find(function(ch) {
      return ch.name.toLowerCase() === cleanName.toLowerCase() && ch.name !== channelDraft.oldName;
    });
    if (dup) {
      showToast('已存在相同名稱的支付通路', 'error');
      return;
    }

    if (channelDraft.oldName) {
      var chObj = (m.channels || []).find(function(ch) { return ch.name === channelDraft.oldName; });
      if (chObj) {
        chObj.name = cleanName;
        chObj.color = channelDraft.color;
      }
      if (channelDraft.oldName !== cleanName) {
        delete m.channelColors[channelDraft.oldName];
      }
    } else {
      m.channels.push({
        id: 'ch_' + Date.now(),
        name: cleanName,
        color: channelDraft.color
      });
    }
    m.channelColors[cleanName] = channelDraft.color;

    (m.cards || []).forEach(function(card) {
      if (!Array.isArray(card.channels)) card.channels = [];
      if (channelDraft.oldName && channelDraft.oldName !== cleanName) {
        card.channels = card.channels.filter(function(cn) { return cn !== channelDraft.oldName; });
      }
      var shouldBind = channelDraft.boundCardIds.includes(card.id);
      if (shouldBind) {
        if (!card.channels.includes(cleanName)) {
          card.channels.push(cleanName);
        }
      } else {
        card.channels = card.channels.filter(function(cn) { return cn !== cleanName; });
      }
    });

    var isChannelRenamed = Boolean(channelDraft.oldName && channelDraft.oldName !== cleanName);
    var extraPayload = {
      channelRenames: isChannelRenamed ? [{ oldName: channelDraft.oldName, newName: cleanName }] : []
    };

    persistPaymentSettingsToServer(m, channelModalSubmitBtn, '儲存通路', function(result) {
      closeChannelModal();
      if (result && result.updatedRowsCount > 0) {
        showToast('已儲存「' + cleanName + '」，並自動更新過往 ' + result.updatedMonthsCount + ' 個月份共 ' + result.updatedRowsCount + ' 筆歷史紀錄！', 'success');
      } else {
        showToast('已儲存支付通路「' + cleanName + '」', 'success');
      }
    }, extraPayload);
  });
}
