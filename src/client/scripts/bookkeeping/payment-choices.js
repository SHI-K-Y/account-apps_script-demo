/* 內嵌的預設卡面與銀行 logo（assets.html）排在頁面最後才下載（P08）：首屏先畫不含這些圖片的選項，
 * 圖片到齊後由 AppBoot 呼叫 refreshPaymentImages()，只重畫當時缺圖的支付方式選項（使用者自訂的圖片不受影響）。 */
let paymentImagesMissedFlag = false;
const paymentImagesMissedIds = new Set();
function paymentImagesLoaded() {
  return typeof PAYMENT_CARD_IMAGES !== 'undefined' && typeof BANK_LOGOS !== 'undefined';
}
function paymentImagesMissed() {
  return paymentImagesMissedIds.size > 0;
}
function defaultCardImage(key) {
  if (!paymentImagesLoaded()) { paymentImagesMissedFlag = true; return ''; }
  return PAYMENT_CARD_IMAGES[key] || '';
}
function defaultBankLogo(key) {
  if (!paymentImagesLoaded()) { paymentImagesMissedFlag = true; return ''; }
  return BANK_LOGOS[key] || '';
}
function refreshPaymentImages() {
  const ids = Array.from(paymentImagesMissedIds);
  paymentImagesMissedIds.clear();
  ids.forEach(id => {
    const container = document.getElementById(id);
    const args = container && container._payArgs;
    if (!args || !container._choiceSetter) return;
    const current = container.querySelector('.choice.selected');
    renderPaymentChoices(id, args.items, current ? current._choiceValue : args.selected, container._choiceSetter);
  });
}

function getPaymentCardImage(rawValue, displayName) {
  const combined = `${rawValue || ''} ${displayName || ''}`.trim();
  if (!combined) return '';

  const prefix = String(rawValue || '').split(/[-－—–]/)[0].trim();
  if (prefix === '轉帳' || prefix === '匯款' || combined === '現金') {
    return '';
  }

  const norm = combined.toLowerCase();

  if (typeof settingsState !== 'undefined' && settingsState.metadata && Array.isArray(settingsState.metadata.cards)) {
    const cardTarget = (displayName || rawValue || '').toLowerCase().trim();
    const cachedImgs = LocalCache.getCustomImages();
    for (let i = 0; i < settingsState.metadata.cards.length; i++) {
      const c = settingsState.metadata.cards[i];
      if (c && c.name) {
        const cName = c.name.toLowerCase().trim();
        if (cardTarget === cName || cardTarget.includes(cName) || cName.includes(cardTarget)) {
          const customSrc = (c.id && cachedImgs[c.id]) || c.customImage || c.image || '';
          if (customSrc) return customSrc;
          if (c.imageKey && defaultCardImage(c.imageKey)) return defaultCardImage(c.imageKey);
        }
      }
    }
  }

  if (norm.includes('山嵐簽帳') || ((norm.includes('山嵐') || norm.includes('山嵐銀行')) && norm.includes('簽帳'))) {
    return defaultCardImage('shanlanDebit');
  }

  if (norm.includes('海悅簽帳') || (norm.includes('海悅') && norm.includes('簽帳'))) {
    return defaultCardImage('haiyueDebit');
  }

  if (norm.includes('wave') || (norm.includes('海悅') && norm.includes('信用卡'))) {
    return defaultCardImage('haiyueWave');
  }

  if (norm.includes('北辰聯名') || norm.includes('megamart') || norm.includes('美佳量販') || (norm.includes('北辰') && (norm.includes('聯名') || norm.includes('信用卡')))) {
    return defaultCardImage('beichenMegamart');
  }

  if (norm.includes('evercard') || (norm.includes('青禾') && norm.includes('信用卡'))) {
    return defaultCardImage('qingheEvercard');
  }

  return '';
}

function getBankLogo(rawValue, displayName, channel) {
  const ch = channel || (String(rawValue || '').split(/[-－—–]/)[0].trim());
  if (!ch.includes('轉帳') && !ch.includes('匯款') && !ch.toLowerCase().includes('transfer')) {
    return '';
  }

  const combined = `${rawValue || ''} ${displayName || ''}`.toLowerCase();

  if (typeof settingsState !== 'undefined' && settingsState.metadata && Array.isArray(settingsState.metadata.banks)) {
    const bankTarget = (displayName || rawValue || '').toLowerCase().trim();
    const cachedImgs = LocalCache.getCustomImages();
    for (let i = 0; i < settingsState.metadata.banks.length; i++) {
      const b = settingsState.metadata.banks[i];
      if (b && b.name) {
        const bName = b.name.toLowerCase().trim();
        if (bankTarget === bName || bankTarget.includes(bName) || bName.includes(bankTarget)) {
          const customSrc = (b.id && cachedImgs[b.id]) || b.customLogo || b.logo || '';
          if (customSrc) return customSrc;
          if (b.logoKey && defaultBankLogo(b.logoKey)) return defaultBankLogo(b.logoKey);
        }
      }
    }
  }

  if (combined.includes('山嵐銀行') || combined.includes('山嵐')) {
    return defaultBankLogo('shanlan');
  }
  if (combined.includes('雲杉')) {
    return defaultBankLogo('yunshan');
  }
  if (combined.includes('北辰')) {
    return defaultBankLogo('beichen');
  }
  if (combined.includes('青禾')) {
    return defaultBankLogo('qinghe');
  }
  if (combined.includes('海悅')) {
    return defaultBankLogo('haiyue');
  }

  return '';
}


function hexToRgbaStr(hex, alpha) {
  const clean = String(hex || '').replace('#', '').trim();
  if (clean.length !== 6) return `rgba(40, 132, 101, ${alpha})`;
  const r = parseInt(clean.slice(0, 2), 16) || 0;
  const g = parseInt(clean.slice(2, 4), 16) || 0;
  const b = parseInt(clean.slice(4, 6), 16) || 0;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function parsePaymentMethods(methods) {
  const groupMap = new Map();
  const groups = [];

  (methods || []).forEach(raw => {
    const rawStr = String(raw || '').trim();
    if (!rawStr) return;

    const dashMatch = rawStr.match(/[-－—–]/);
    let channelName = '';
    let cardName = '';

    if (dashMatch && dashMatch.index !== undefined) {
      const idx = dashMatch.index;
      channelName = rawStr.slice(0, idx).trim();
      cardName = rawStr.slice(idx + 1).trim() || rawStr;
    } else {
      if (rawStr.includes('轉帳') || rawStr.includes('匯款') || rawStr.toLowerCase().includes('transfer')) {
        channelName = '轉帳';
        cardName = rawStr;
      } else if (rawStr.includes('現金')) {
        channelName = '現金';
        cardName = rawStr;
      } else {
        channelName = '其他';
        cardName = rawStr;
      }
    }

    if (!groupMap.has(channelName)) {
      const newGroup = { channel: channelName, items: [] };
      groupMap.set(channelName, newGroup);
      groups.push(newGroup);
    }

    groupMap.get(channelName).items.push({
      rawValue: rawStr,
      displayName: cardName
    });
  });

  const channelOrderMap = new Map();
  var metaChannels = (typeof settingsState !== 'undefined' && settingsState.metadata && settingsState.metadata.channels) ||
                     (state.data && state.data.settingsMetadata && state.data.settingsMetadata.channels);
  if (Array.isArray(metaChannels)) {
    metaChannels.forEach((ch, idx) => {
      if (ch && ch.name) channelOrderMap.set(String(ch.name).trim(), idx);
    });
  }

  groups.sort((a, b) => {
    const aIsCash = /現金/.test(a.channel);
    const bIsCash = /現金/.test(b.channel);
    if (aIsCash && !bIsCash) return -1;
    if (!aIsCash && bIsCash) return 1;

    const aOrder = channelOrderMap.has(a.channel) ? channelOrderMap.get(a.channel) : (a.channel === '轉帳' ? 900 : 999);
    const bOrder = channelOrderMap.has(b.channel) ? channelOrderMap.get(b.channel) : (b.channel === '轉帳' ? 900 : 999);
    if (aOrder !== bOrder) return aOrder - bOrder;

    return 0;
  });

  return groups;
}

function playCardSpin(imgEl) {
  if (!imgEl) return;
  imgEl.classList.remove('card-spin');
  void imgEl.offsetWidth;
  imgEl.classList.add('card-spin');
  imgEl.addEventListener('animationend', () => imgEl.classList.remove('card-spin'), { once: true });
}

// 選項晶片（P06）：點擊委派到容器，選取變化只切換 selected 與 aria-pressed；
// 只有選項清單本身（含圖示、卡面、自訂顏色等畫得出來的內容）改變時才整組重建。
function bindChoiceContainer(container) {
  if (container._choiceBound) return;
  container._choiceBound = true;
  container.addEventListener('click', e => {
    const button = e.target && e.target.closest ? e.target.closest('.choice') : null;
    if (!button || !container.contains(button) || !('_choiceValue' in button)) return;
    const setter = container._choiceSetter;
    if (!setter) return;
    const seq = container._choiceSeq;
    setter(button._choiceValue);
    // setter 裡重新渲染了同一組選項：畫面已依最新狀態同步，不再手動切換
    if (container._choiceSeq !== seq) return;
    ListRender.syncSelected(container, btn => btn === button);
    const img = button.querySelector('.choice-card-img');
    if (img) playCardSpin(img);
  });
}

/** 共用的前置處理：登記 setter；簽章沒變時只同步選取狀態並回傳 true。 */
function reuseChoices(container, sig, setter, isSelected) {
  bindChoiceContainer(container);
  container._choiceSetter = setter;
  container._choiceSeq = (container._choiceSeq || 0) + 1;
  if (!ListRender.sameSig(container, sig)) return false;
  ListRender.syncSelected(container, isSelected);
  return true;
}

function customChannelColor(channel) {
  if (typeof settingsState === 'undefined' || !settingsState.metadata) return '';
  const m = settingsState.metadata;
  if (m.channelColors && m.channelColors[channel]) return m.channelColors[channel];
  if (Array.isArray(m.channels)) {
    const chObj = m.channels.find(c => c && c.name === channel);
    if (chObj && chObj.color) return chObj.color;
  }
  return '';
}

function renderPaymentChoices(containerId, items, selected, setter) {
  const container = document.getElementById(containerId);
  if (!container) return;

  paymentImagesMissedFlag = false;
  const groups = parsePaymentMethods(items).map(group => ({
    channel: group.channel,
    channelType: getPaymentType(group.channel),
    customCol: customChannelColor(group.channel),
    items: group.items.map(item => ({
      rawValue: item.rawValue,
      displayName: item.displayName,
      payType: getPaymentType(item.rawValue),
      cardImgSrc: getPaymentCardImage(item.rawValue, item.displayName) || '',
      bankLogoSrc: getBankLogo(item.rawValue, item.displayName, group.channel) || '',
    })),
  }));
  if (paymentImagesMissedFlag) paymentImagesMissedIds.add(containerId);
  container._payArgs = { items: items, selected: selected };
  const sig = 'pay\u0001' + JSON.stringify(groups);
  if (reuseChoices(container, sig, setter, btn => btn._choiceValue === selected)) return;

  container.innerHTML = '';
  if (!groups.length) return;

  const wrap = document.createElement('div');
  wrap.className = 'payment-groups-wrap';

  groups.forEach(group => {
    const groupEl = document.createElement('div');
    groupEl.className = 'pay-group';

    const channelType = group.channelType;
    if (channelType) {
      groupEl.dataset.payment = channelType;
    }

    const headerEl = document.createElement('div');
    headerEl.className = 'pay-group-header';
    if (channelType) {
      headerEl.dataset.payment = channelType;
    }

    const badgeEl = document.createElement('span');
    badgeEl.className = 'pay-group-badge';
    if (channelType) {
      badgeEl.classList.add('pay-badge-' + channelType);
      badgeEl.dataset.payment = channelType;
    }
    badgeEl.textContent = group.channel;

    const customCol = group.customCol;
    if (customCol) {
      badgeEl.dataset.customColor = 'true';
      badgeEl.style.setProperty('--custom-ch-color', customCol);
      badgeEl.style.setProperty('--custom-ch-bg', hexToRgbaStr(customCol, 0.15));
      badgeEl.style.setProperty('--custom-ch-border', hexToRgbaStr(customCol, 0.45));
      badgeEl.style.setProperty('--custom-ch-glow', hexToRgbaStr(customCol, 0.55));
      badgeEl.style.setProperty('--custom-ch-light', hexToRgbaStr(customCol, 0.85));
      groupEl.dataset.customColor = 'true';
      groupEl.style.setProperty('--custom-ch-color', customCol);
      groupEl.style.setProperty('--custom-ch-bg', hexToRgbaStr(customCol, 0.12));
      groupEl.style.setProperty('--custom-ch-border', hexToRgbaStr(customCol, 0.38));
      groupEl.style.setProperty('--custom-ch-hover-bg', hexToRgbaStr(customCol, 0.22));
      groupEl.style.setProperty('--custom-ch-selected-bg', hexToRgbaStr(customCol, 0.28));
      groupEl.style.setProperty('--custom-ch-glow', hexToRgbaStr(customCol, 0.35));
    }

    headerEl.appendChild(badgeEl);
    groupEl.appendChild(headerEl);

    const gridEl = document.createElement('div');
    gridEl.className = 'pay-group-grid';

    group.items.forEach(item => {
      const button = document.createElement('button');
      button.type = 'button';
      const isSelected = (item.rawValue === selected);
      button.className = 'choice' + (isSelected ? ' selected' : '');
      button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');

      button.dataset.value = item.rawValue;
      button._choiceValue = item.rawValue;

      const payType = item.payType;
      if (payType) {
        button.classList.add('pay-' + payType);
        button.dataset.payment = payType;
      }
      if (customCol) {
        button.dataset.customColor = 'true';
      }

      const cardImgSrc = item.cardImgSrc;
      if (cardImgSrc) {
        button.classList.add('has-card-img');
        const imgEl = document.createElement('img');
        imgEl.className = 'choice-card-img';
        imgEl.src = cardImgSrc;
        imgEl.alt = item.displayName;
        imgEl.width = 76;
        imgEl.height = 48;
        imgEl.loading = 'lazy';
        imgEl.decoding = 'async';
        imgEl.setAttribute('aria-hidden', 'true');
        button.appendChild(imgEl);
      }

      const bankLogoSrc = item.bankLogoSrc;
      if (bankLogoSrc && !cardImgSrc) {
        button.classList.add('has-bank-icon');
        const bankImg = document.createElement('img');
        bankImg.className = 'choice-bank-icon';
        bankImg.src = bankLogoSrc;
        bankImg.alt = '';
        bankImg.width = 25;
        bankImg.height = 18;
        bankImg.loading = 'lazy';
        bankImg.decoding = 'async';
        bankImg.setAttribute('aria-hidden', 'true');
        button.appendChild(bankImg);
      }

      const textSpan = document.createElement('span');
      textSpan.className = 'choice-text';
      textSpan.textContent = item.displayName;
      button.appendChild(textSpan);

      gridEl.appendChild(button);
    });

    groupEl.appendChild(gridEl);
    wrap.appendChild(groupEl);
  });

  container.appendChild(wrap);
}

function renderChoices(containerId, items, selected, setter) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const isPayment = (containerId === 'paymentChoices' || containerId === 'editPaymentChoices');
  const isItem = (containerId === 'expenseItemChoices' || containerId === 'incomeItemChoices' || containerId === 'editItemChoices' || containerId === 'comboItemChoices' || containerId === 'srItemChoices');
  const isCategory = (containerId === 'expenseCategoryChoices' || containerId === 'incomeCategoryChoices' || containerId === 'editCategoryChoices' || containerId === 'comboCategoryChoices' || containerId === 'srCategoryChoices');

  if (isPayment) {
    renderPaymentChoices(containerId, items, selected, setter);
    return;
  }

  const entries = (items || []).map(value => (isItem
    ? [value, getItemCategory(value) || '', getItemIcon(value) || '', itemDisplayName(value)]
    : [value]));
  const sig = (isItem ? 'item' : isCategory ? 'cat' : 'plain') + '\u0001' + JSON.stringify(entries);
  if (reuseChoices(container, sig, setter, btn => btn._choiceValue === selected)) return;
  container.innerHTML = '';

  entries.forEach(entry => {
    const value = entry[0];
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice' + (value === selected ? ' selected' : '');
    button.setAttribute('aria-pressed', value === selected ? 'true' : 'false');
    button.dataset.value = value;
    button._choiceValue = value;

    if (isCategory) {
      button.classList.add('category-choice');
    }

    if (isItem) {
      const cat = entry[1];
      if (cat && cat !== 'default') {
        button.classList.add('cat-' + cat);
        button.dataset.cat = cat;
      }

      if (value.length > 7 || value.includes('大項') || value.includes('代收代付')) {
        button.classList.add('choice-span-full');
      }
    }

    if (isItem) {
      const icon = entry[2];
      if (icon) {
        button.classList.add('has-emoji');
        const emojiSpan = document.createElement('span');
        emojiSpan.className = 'choice-emoji';
        emojiSpan.setAttribute('aria-hidden', 'true');
        emojiSpan.appendChild(iconEl(icon));

        const textSpan = document.createElement('span');
        textSpan.className = 'choice-text';
        textSpan.textContent = entry[3];

        button.appendChild(emojiSpan);
        button.appendChild(textSpan);
      } else {
        button.textContent = value;
      }
    } else {
      button.textContent = value;
    }

    container.appendChild(button);
  });
}

function getPaymentType(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const prefix = raw.split(/[-－—–]/)[0].trim().toLowerCase();
  if (prefix.includes('line') || prefix.includes('linw')) return 'linepay';
  if (prefix.includes('現金')) return 'cash';
  if (prefix.includes('信用卡')) return 'credit';
  if (prefix.includes('簽帳卡') || prefix.includes('簽帳')) return 'debit';
  if (prefix.includes('青禾')) return 'qinghe';
  if (prefix.includes('悠活支付') || prefix.includes('yohopay')) return 'yohopay';
  if (prefix.includes('轉帳') || prefix.includes('匯款') || prefix.includes('transfer')) return 'transfer';
  return 'other';
}

function renderPaidChoiceGroup(containerId, getValue, setValue, { includeNotApplicable = true } = {}) {
  const container = document.getElementById(containerId);
  if (!container) return;
  const currentVal = getValue();
  const items = [
    { value: 'O', label: '已繳' },
    { value: 'X', label: '未繳' },
  ];
  if (includeNotApplicable) items.unshift({ value: '', label: '不適用' });
  const sig = 'paid\u0001' + (includeNotApplicable ? '1' : '0');
  if (reuseChoices(container, sig, setValue, btn => btn._choiceValue === currentVal)) return;
  container.innerHTML = '';
  items.forEach(item => {
    const isSelected = (currentVal === item.value);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice' + (isSelected ? ' selected' : '');
    button.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
    button.textContent = item.label;
    button._choiceValue = item.value;
    container.appendChild(button);
  });
}

function renderPaidChoices() {
  renderPaidChoiceGroup('paidChoices', () => state.expense.paid, val => {
    state.expense.paid = val;
    onUserPick('expense', 'paid');
  }, { includeNotApplicable: false });
}

function isCreditCardPayment(payment) {
  const raw = String(payment || '').trim();
  if (!raw.includes('信用卡') || raw.startsWith('簽帳卡')) return false;

  const metadata = settingsState.metadata || (state.data && state.data.settingsMetadata);
  const cards = metadata && Array.isArray(metadata.cards) ? metadata.cards : [];
  const normalize = text => String(text || '').toLowerCase().replace(/\s+/g, '');
  const cardName = normalize(raw.replace(/^[^-－—–]*[-－—–]/, ''));
  return !cards.some(card => card && card.type === 'debit' && normalize(card.name) === cardName);
}

function setPaidFieldVisible(el, visible, animate = true) {
  if (!el) return Promise.resolve();
  const wasVisible = !el.classList.contains('is-collapsed');
  if (animate && visible === wasVisible) return el.paidSettlePromise || Promise.resolve();

  clearTimeout(el.paidCollapseTimer);
  if (el.paidSettleResolve) el.paidSettleResolve();
  const shouldAnimate = animate && Motion.level() === 'full';
  let resolveSettle;
  const settlePromise = new Promise(r => { resolveSettle = r; });
  el.paidSettlePromise = settlePromise;
  el.paidSettleResolve = resolveSettle;
  const settle = () => {
    el.classList.remove('is-animating');
    if (!visible) el.hidden = true;
    if (el.paidSettlePromise === settlePromise) {
      el.paidSettlePromise = null;
      el.paidSettleResolve = null;
    }
    resolveSettle();
  };

  el.inert = !visible;
  if (shouldAnimate) el.classList.add('is-animating');
  if (visible) {
    el.hidden = false;
    if (shouldAnimate) void el.offsetHeight;
  }
  el.classList.toggle('is-collapsed', !visible);

  if (shouldAnimate) {
    el.paidCollapseTimer = setTimeout(settle, 250);
  } else {
    settle();
  }
  return settlePromise;
}

function updatePaidSectionVisibility() {
  const isCredit = isCreditCardPayment(state.expense.payment);
  state.expense.paid = isCredit ? (state.expense.paid || 'X') : '';
  renderPaidChoices();
  scheduleStepProgress('expense');
  return setPaidFieldVisible(document.getElementById('paidSection'), isCredit);
}

function updateEditPaidFieldVisibility(animate = true) {
  const visible = editState.type === 'expense' && isCreditCardPayment(editState.payment);
  const modal = document.getElementById('editRecordModal');
  if (modal) {
    modal.classList.toggle('is-paid-motion', animate);
    modal.classList.toggle('is-paid-hidden', !visible);
  }
  setPaidFieldVisible(document.getElementById('editPaidField'), visible, animate);
}

function prefer(current, items) {
  if (!items || !items.length) return current || '';
  if (current && items.includes(current)) return current;
  if (items.includes('生活費')) return '生活費';
  return items[0] || '';
}
