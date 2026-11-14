var SETTINGS_TAB_LABELS = {
  expenseItems: '支出項目',
  incomeItems: '收入項目',
  expenseCategories: '支出總類',
  incomeCategories: '收入總類',
  paymentMethods: '支出方式',
  quickCombos: '常用組合',
  budget: '預算',
};

var ICON_CATEGORIES = {
  '餐飲美食': ['egg', 'bowl-food', 'cooking-pot', 'cookie', 'pint-glass', 'fork-knife', 'bowl-steam', 'hamburger', 'pizza', 'fish-simple', 'bread', 'coffee', 'beer-stein', 'orange-slice', 'leaf', 'cake', 'fire', 'ice-cream', 'wine', 'martini', 'carrot', 'avocado', 'popcorn', 'knife'],
  '交通出行': ['car', 'motorcycle', 'bus', 'subway', 'train', 'airplane-tilt', 'taxi', 'gas-pump', 'letter-circle-p', 'bicycle', 'boat', 'ticket', 'scooter', 'van', 'truck', 'tram', 'sailboat', 'charging-station', 'tire', 'road-horizon', 'map-pin', 'suitcase-rolling', 'globe-hemisphere-east'],
  '居家生活': ['house', 'lightbulb', 'device-mobile', 'washing-machine', 't-shirt', 'spray-bottle', 'shopping-cart', 'couch', 'broom', 'toilet-paper', 'shower', 'key', 'package', 'drop', 'flame', 'wifi-high', 'plant', 'bathtub', 'toolbox', 'wrench', 'paint-roller', 'lamp', 'baby', 'scissors'],
  '娛樂購物': ['game-controller', 'shopping-bag', 'film-slate', 'music-notes', 'books', 'barbell', 'palette', 'microphone-stage', 'gift', 'puzzle-piece', 'paw-print', 'tent', 'camera', 'headphones', 'television', 'guitar', 'basketball', 'soccer-ball', 'sneaker', 'dress', 'handbag', 'sparkle', 'flower', 'laptop'],
  '財務收入': ['money', 'bank', 'chart-line-up', 'chart-line-down', 'handshake', 'arrows-left-right', 'house-line', 'credit-card', 'contactless-payment', 'receipt', 'coins', 'diamond', 'envelope-simple', 'trophy', 'pill', 'hospital', 'piggy-bank', 'wallet', 'hand-coins', 'briefcase', 'graduation-cap', 'first-aid', 'tooth', 'shield-check']
};

var ICON_LABELS = {
  'egg': '早餐', 'bowl-food': '便當', 'cooking-pot': '火鍋', 'cookie': '點心', 'pint-glass': '飲料', 'fork-knife': '餐飲',
  'bowl-steam': '麵食', 'hamburger': '漢堡', 'pizza': '披薩', 'fish-simple': '海鮮', 'bread': '麵包', 'coffee': '咖啡',
  'beer-stein': '啤酒', 'orange-slice': '水果', 'leaf': '蔬食', 'cake': '蛋糕', 'fire': '燒烤', 'ice-cream': '冰品',
  'wine': '紅酒', 'martini': '調酒', 'carrot': '蔬菜', 'avocado': '健康餐', 'popcorn': '零食', 'knife': '食材',
  'car': '汽車', 'motorcycle': '機車', 'bus': '公車', 'subway': '捷運', 'train': '火車', 'airplane-tilt': '機票',
  'taxi': '計程車', 'gas-pump': '加油', 'letter-circle-p': '停車', 'bicycle': '腳踏車', 'boat': '船', 'ticket': '票券',
  'scooter': '滑板車', 'van': '廂型車', 'truck': '貨運', 'tram': '輕軌', 'sailboat': '渡輪', 'charging-station': '充電',
  'tire': '保養', 'road-horizon': '過路費', 'map-pin': '景點', 'suitcase-rolling': '行李', 'globe-hemisphere-east': '旅行',
  'house': '房租', 'lightbulb': '水電', 'device-mobile': '電信', 'washing-machine': '洗衣', 't-shirt': '衣物', 'spray-bottle': '日用品',
  'shopping-cart': '日常採買', 'couch': '家具', 'broom': '清潔', 'toilet-paper': '衛生紙', 'shower': '衛浴', 'key': '鑰匙',
  'package': '其他', 'drop': '水費', 'flame': '瓦斯', 'wifi-high': '網路', 'plant': '植物', 'bathtub': '浴室',
  'toolbox': '修繕', 'wrench': '維修', 'paint-roller': '裝潢', 'lamp': '燈具', 'baby': '育兒', 'scissors': '美髮',
  'game-controller': '遊戲', 'shopping-bag': '購物', 'film-slate': '電影', 'music-notes': '音樂', 'books': '書籍', 'barbell': '運動',
  'palette': '藝術', 'microphone-stage': '唱歌', 'gift': '禮物', 'puzzle-piece': '玩具', 'paw-print': '寵物', 'tent': '露營',
  'camera': '攝影', 'headphones': '耳機', 'television': '影音', 'guitar': '樂器', 'basketball': '球類', 'soccer-ball': '足球',
  'sneaker': '鞋子', 'dress': '服飾', 'handbag': '包包', 'sparkle': '美妝', 'flower': '花', 'laptop': '3C',
  'money': '現金', 'bank': '銀行', 'chart-line-up': '投資', 'chart-line-down': '虧損', 'handshake': '代收代付', 'arrows-left-right': '轉帳',
  'house-line': '家裡', 'credit-card': '信用卡', 'contactless-payment': '感應支付', 'receipt': '收據', 'coins': '零錢', 'diamond': '珠寶',
  'envelope-simple': '紅包', 'trophy': '獎金', 'pill': '醫藥', 'hospital': '醫院', 'piggy-bank': '存錢', 'wallet': '錢包',
  'hand-coins': '小費', 'briefcase': '工作', 'graduation-cap': '學費', 'first-aid': '保健', 'tooth': '牙醫', 'shield-check': '保險'
};

var PRESET_CHANNEL_COLORS = [
  '#288465', '#06c755', '#2563eb', '#ea580c', '#d97706',
  '#0d9488', '#8c5835', '#f472b6', '#0284c7', '#7c3aed',
  '#de4e45', '#64748b'
];

var PRESET_CARDS_LIST = [
  { key: 'shanlanDebit', label: '山嵐簽帳卡', src: PAYMENT_CARD_IMAGES.shanlanDebit },
  { key: 'haiyueWave', label: '海悅 WAVE', src: PAYMENT_CARD_IMAGES.haiyueWave },
  { key: 'haiyueDebit', label: '海悅簽帳卡', src: PAYMENT_CARD_IMAGES.haiyueDebit },
  { key: 'qingheEvercard', label: '青禾 Evercard', src: PAYMENT_CARD_IMAGES.qingheEvercard },
  { key: 'beichenMegamart', label: '北辰聯名卡', src: PAYMENT_CARD_IMAGES.beichenMegamart }
];

var PRESET_BANKS_LIST = [
  { key: 'shanlan', label: '山嵐銀行', src: BANK_LOGOS.shanlan },
  { key: 'haiyue', label: '海悅銀行', src: BANK_LOGOS.haiyue },
  { key: 'beichen', label: '北辰銀行', src: BANK_LOGOS.beichen },
  { key: 'qinghe', label: '青禾銀行', src: BANK_LOGOS.qinghe },
  { key: 'yunshan', label: '雲杉銀行', src: BANK_LOGOS.yunshan }
];

var emojiPickerTarget = 'addBar';
var currentEmojiCategory = '餐飲美食';

function ensureMetadataInitialized() {
  if (!settingsState.metadata) {
    settingsState.metadata = LocalCache.getSettingsMetadata() || {};
  }
  var m = settingsState.metadata;
  if (!m.itemEmojis) m.itemEmojis = m.emojis || {};
  if (!m.emojis) m.emojis = m.itemEmojis;

  var defaultChannels = [
    { id: 'ch_linepay', name: 'Line Pay', color: '#06c755' },
    { id: 'ch_credit', name: '信用卡', color: '#2563eb' },
    { id: 'ch_debit', name: '簽帳卡', color: '#ea580c' },
    { id: 'ch_yohopay', name: '悠活支付', color: '#d97706' },
    { id: 'ch_qinghe', name: '青禾電子支付', color: '#0d9488' }
  ];

  if (!Array.isArray(m.channels) || !m.channels.length) {
    m.channels = defaultChannels.map(function(c) { return Object.assign({}, c); });
  }
  if (!m.channelColors) m.channelColors = {};
  m.channels.forEach(function(ch) {
    if (ch && ch.name && ch.color && !m.channelColors[ch.name]) {
      m.channelColors[ch.name] = ch.color;
    }
  });

  if (!Array.isArray(m.cards) || !m.cards.length || !Array.isArray(m.banks) || !m.banks.length) {
    var rawPm = (state.data && state.data.options && state.data.options.paymentMethods) || DEFAULT_OPTIONS_FALLBACK.paymentMethods;
    var migrated = buildMigratedMetadataFromPayments(rawPm, m.channels);
    if (!Array.isArray(m.cards) || !m.cards.length) m.cards = migrated.cards;
    if (!Array.isArray(m.banks) || !m.banks.length) m.banks = migrated.banks;
    m.channels = migrated.channels;
    m.channels.forEach(function(ch) {
      if (ch && ch.name && ch.color) m.channelColors[ch.name] = ch.color;
    });
  }

  if (Array.isArray(m.cards) && m.cards.length) {
    var mergedCardMap = new Map();
    var normalizedCards = [];
    m.cards.forEach(function(c) {
      if (!c || !c.name) return;
      var rawCardName = String(c.name).trim();
      var isGhostHaiyue = (c.id === 'card_haiyue_credit');
      var normName = isGhostHaiyue ? '海悅 wave 信用卡' : rawCardName;
      var normId = isGhostHaiyue ? 'card_haiyue_wave' : c.id;
      var key = normName.toLowerCase();
      if (mergedCardMap.has(key)) {
        var existCard = mergedCardMap.get(key);
        (c.channels || []).forEach(function(ch) {
          if (ch && !existCard.channels.includes(ch)) existCard.channels.push(ch);
        });
        if (!existCard.customImage && (c.customImage || c.image)) {
          existCard.customImage = c.customImage || c.image;
          existCard.image = existCard.customImage;
        }
        if (!existCard.imageKey && c.imageKey) existCard.imageKey = c.imageKey;
      } else {
        c.id = normId;
        c.name = normName;
        c.channels = Array.isArray(c.channels) ? c.channels.slice() : [];
        mergedCardMap.set(key, c);
        normalizedCards.push(c);
      }
    });
    m.cards = normalizedCards;
  }

  var cachedImgs = LocalCache.getCustomImages();
  (m.cards || []).forEach(function(c) {
    if (c && c.id && cachedImgs[c.id]) {
      c.customImage = cachedImgs[c.id];
      c.image = cachedImgs[c.id];
    }
  });
  (m.banks || []).forEach(function(b) {
    if (b && b.id && cachedImgs[b.id]) {
      b.customLogo = cachedImgs[b.id];
      b.logo = cachedImgs[b.id];
    }
  });

  return m;
}

function buildMigratedMetadataFromPayments(paymentMethods, existingChannels) {
  var channelMap = new Map();
  var palette = PRESET_CHANNEL_COLORS;
  (existingChannels || []).forEach(function(ch) {
    if (ch && ch.name) channelMap.set(ch.name, ch);
  });

  var cardMap = new Map();
  var bankMap = new Map();

  (paymentMethods || []).forEach(function(raw, idx) {
    var str = String(raw || '').trim();
    if (!str || str === '現金') return;
    var dashMatch = str.match(/[-－—–]/);
    if (!dashMatch || dashMatch.index === undefined) return;
    var chName = str.slice(0, dashMatch.index).trim();
    var itemName = str.slice(dashMatch.index + 1).trim();
    if (!chName || !itemName) return;

    if (chName === '轉帳' || chName === '匯款') {
      if (!bankMap.has(itemName)) {
        var lKey = '';
        if (itemName.includes('山嵐') || itemName.includes('山嵐銀行')) lKey = 'shanlan';
        else if (itemName.includes('海悅')) lKey = 'haiyue';
        else if (itemName.includes('北辰')) lKey = 'beichen';
        else if (itemName.includes('青禾')) lKey = 'qinghe';
        else if (itemName.includes('雲杉')) lKey = 'yunshan';
        bankMap.set(itemName, {
          id: 'bank_' + (idx + 1),
          name: itemName,
          logoKey: lKey,
          customLogo: ''
        });
      }
    } else {
      if (!channelMap.has(chName)) {
        channelMap.set(chName, {
          id: 'ch_custom_' + channelMap.size,
          name: chName,
          color: palette[channelMap.size % palette.length]
        });
      }
      if (itemName === '海悅信用卡' || itemName === '海悅 wave 卡') {
        itemName = '海悅 wave 信用卡';
      }
      if (!cardMap.has(itemName)) {
        var iKey = '';
        var norm = itemName.toLowerCase();
        if (norm.includes('山嵐') && norm.includes('簽帳')) iKey = 'shanlanDebit';
        else if (norm.includes('海悅') && norm.includes('簽帳')) iKey = 'haiyueDebit';
        else if (norm.includes('wave') || (norm.includes('海悅') && norm.includes('信用卡'))) iKey = 'haiyueWave';
        else if (norm.includes('北辰')) iKey = 'beichenMegamart';
        else if (norm.includes('evercard') || norm.includes('青禾')) iKey = 'qingheEvercard';
        var cType = (norm.includes('簽帳') || chName === '簽帳卡') ? 'debit' : 'credit';
        cardMap.set(itemName, {
          id: 'card_' + (idx + 1),
          name: itemName,
          type: cType,
          imageKey: iKey,
          customImage: '',
          channels: [chName]
        });
      } else {
        var cardEntry = cardMap.get(itemName);
        if (!cardEntry.channels.includes(chName)) {
          cardEntry.channels.push(chName);
        }
      }
    }
  });

  return {
    channels: Array.from(channelMap.values()),
    cards: Array.from(cardMap.values()),
    banks: Array.from(bankMap.values())
  };
}

function stripEmojiClient(text) {
  if (!text) return '';
  return String(text)
    .replace(/[\u{1F300}-\u{1F9FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F910}-\u{1F96B}\u{1F980}-\u{1F9E0}\u{FE00}-\u{FE0F}\u{200D}]/gu, '')
    .trim();
}

var SETTINGS_PAGE_TITLE = '選項設定';

function syncSettingsDrillHeader() {
  var activeTab = document.querySelector('.settings-tab.active');
  var titleEl = document.querySelector('#pageSettings .settings-head h1');
  var subbar = document.getElementById('settingsSubbar');
  if (titleEl) titleEl.textContent = activeTab ? (SETTINGS_TAB_LABELS[activeTab.dataset.stab] || (activeTab.querySelector('.uv-tab-label') || activeTab).textContent.trim() || SETTINGS_PAGE_TITLE) : SETTINGS_PAGE_TITLE;
  if (subbar) subbar.hidden = !activeTab;
}

function playSettingsDrillTransition(entering) {
  var targets = entering
    ? ['settingsPaySubnav', 'settingsTopActionBar', 'settingsPayActionBar', 'settingsListContainer']
      .map(function(id) { return document.getElementById(id); })
      .filter(function(el) { return el && el.style.display !== 'none' && el.getClientRects().length; })
    : Array.prototype.slice.call(document.querySelectorAll('.settings-tabs'));
  var offset = entering ? 24 : -24;
  targets.forEach(function(el) {
    Motion.animate(el, {
      full: [{ opacity: 0, transform: 'translateX(' + offset + 'px)' }, { opacity: 1, transform: 'none' }],
      lite: [{ opacity: 0 }, { opacity: 1 }]
    }, { duration: Motion.dur('slow'), easing: Motion.ease('out') });
  });
  Motion.cancelScroll();
  window.scrollTo({ top: 0 });
  document.querySelectorAll('.settings-head').forEach(function(h) { h.classList.remove('head-hidden'); });
}

function leaveSettingsTab() {
  document.querySelectorAll('.settings-tab').forEach(function(t) { t.classList.remove('active'); t.setAttribute('aria-pressed', 'false'); });
  closeEmojiPopover();
  settingsState.addFormOpen = false;
  updateSettingsTopControls();
  syncSettingsDrillHeader();
  playSettingsDrillTransition(false);
}

document.querySelectorAll('.settings-tab').forEach(function(tab) {
  tab.addEventListener('click', function() {
    if (tab.classList.contains('active')) {
      leaveSettingsTab();
      return;
    }
    document.querySelectorAll('.settings-tab').forEach(function(t) { t.classList.remove('active'); t.setAttribute('aria-pressed', 'false'); });
    tab.classList.add('active');
    tab.setAttribute('aria-pressed', 'true');
    settingsState.currentTab = tab.dataset.stab;
    closeEmojiPopover();
    settingsState.addFormOpen = false;
    updateSettingsTopControls();
    renderSettingsList();
    syncSettingsDrillHeader();
    playSettingsDrillTransition(true);
  });
});

var settingsBackBtn = document.getElementById('settingsBackBtn');
if (settingsBackBtn) settingsBackBtn.addEventListener('click', leaveSettingsTab);

document.querySelectorAll('.settings-subtab').forEach(function(subBtn) {
  subBtn.addEventListener('click', function() {
    document.querySelectorAll('.settings-subtab').forEach(function(b) { b.classList.remove('active'); });
    subBtn.classList.add('active');
    settingsState.paySubtab = subBtn.dataset.subtab || 'cards';
    updateSettingsTopControls();
    renderSettingsList();
  });
});

function updateSettingsTopControls() {
  var tab = settingsState.currentTab;
  var isPay = (tab === 'paymentMethods');
  var isItemWithEmoji = (tab === 'expenseItems' || tab === 'incomeItems');
  var isQuickCombos = (tab === 'quickCombos');

  var paySubnav = document.getElementById('settingsPaySubnav');
  var addBar = document.getElementById('settingsAddBar');
  var payActionBar = document.getElementById('settingsPayActionBar');
  var topActionBar = document.getElementById('settingsTopActionBar');
  var toggleBtn = document.getElementById('settingsToggleAddBtn');
  var toggleBtnText = document.getElementById('settingsToggleAddBtnText');
  var emojiPickBtn = document.getElementById('settingsEmojiPickBtn');
  var newInput = document.getElementById('settingsNewInput');

  if (tab === 'preferences' || tab === 'budget') {
    if (paySubnav) paySubnav.style.display = 'none';
    if (payActionBar) payActionBar.style.display = 'none';
    if (topActionBar) topActionBar.style.display = 'none';
    if (addBar) addBar.style.display = 'none';
    return;
  }

  if (paySubnav) paySubnav.style.display = isPay ? 'flex' : 'none';
  if (payActionBar) payActionBar.style.display = isPay ? 'flex' : 'none';
  if (topActionBar) topActionBar.style.display = isPay ? 'none' : 'flex';

  if (!isPay) {
    if (addBar) {
      addBar.style.display = (settingsState.addFormOpen && !isQuickCombos) ? 'block' : 'none';
    }
    if (toggleBtn) {
      if (settingsState.addFormOpen) {
        toggleBtn.classList.add('active');
        toggleBtn.setAttribute('aria-expanded', 'true');
        if (toggleBtnText) toggleBtnText.textContent = '收起';
      } else {
        toggleBtn.classList.remove('active');
        toggleBtn.setAttribute('aria-expanded', 'false');
        if (toggleBtnText) toggleBtnText.textContent = isQuickCombos ? '新增組合' : '新增項目';
      }
    }
    if (emojiPickBtn) emojiPickBtn.style.display = isItemWithEmoji ? 'inline-flex' : 'none';
    if (newInput) {
      newInput.placeholder = '輸入新' + (SETTINGS_TAB_LABELS[tab] || '選項') + '名稱…';
    }
    if (isItemWithEmoji) {
      var defaultIcon = (tab === 'incomeItems') ? 'money' : 'egg';
      setAddBarEmoji(defaultIcon);
    }
  } else {
    if (addBar) addBar.style.display = 'none';
    var sub = settingsState.paySubtab || 'cards';
    var titleEl = document.getElementById('payActionTitle');
    var descEl = document.getElementById('payActionDesc');
    var btnTextEl = document.getElementById('payAddBtnText');

    if (sub === 'cards') {
      if (titleEl) titleEl.textContent = '卡別管理（信用卡 / 簽帳卡）';
      if (descEl) descEl.textContent = '自訂卡片名稱、卡面縮圖，並勾選綁定支援的支付通路';
      if (btnTextEl) btnTextEl.textContent = '新增卡別';
    } else if (sub === 'channels') {
      if (titleEl) titleEl.textContent = '支付通路群組管理';
      if (descEl) descEl.textContent = '管理支付通路名稱、群組主題色彩與自訂排列順序，即時套用至記帳頁面';
      if (btnTextEl) btnTextEl.textContent = '新增通路';
    } else if (sub === 'banks') {
      if (titleEl) titleEl.textContent = '轉帳通路管理（銀行設定）';
      if (descEl) descEl.textContent = '管理常用轉帳銀行名稱與專屬圓標圖示';
      if (btnTextEl) btnTextEl.textContent = '新增銀行';
    }
  }
}

function setAddBarEmoji(iconName) {
  settingsState.selectedIcon = resolveIconName(iconName) || 'tag';
  var el = document.getElementById('settingsCurrentEmoji');
  setIcon(el, settingsState.selectedIcon);
}

var settingsNewInput = document.getElementById('settingsNewInput');
if (settingsNewInput) {
  settingsNewInput.addEventListener('input', function() {
    var tab = settingsState.currentTab;
    if (tab === 'expenseItems' || tab === 'incomeItems') {
      var val = stripEmojiClient(settingsNewInput.value);
      if (val) {
        var guessed = getItemIcon(val);
        if (guessed && guessed !== 'tag') {
          setAddBarEmoji(guessed);
        }
      }
    }
  });
  settingsNewInput.addEventListener('keydown', function(e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      addSettingsItem();
    } else if (e.key === 'Escape' && settingsState.addFormOpen) {
      var toggleBtn = document.getElementById('settingsToggleAddBtn');
      if (toggleBtn) toggleBtn.click();
    }
  });
}

var settingsRefreshBtn = document.getElementById('settingsRefreshBtn');
if (settingsRefreshBtn) {
  settingsRefreshBtn.addEventListener('click', function() {
    settingsLoaded = false;
    loadSettings(true);
    settingsLoaded = true;
  });
}

var settingsToggleAddBtn = document.getElementById('settingsToggleAddBtn');
if (settingsToggleAddBtn) {
  settingsToggleAddBtn.addEventListener('click', function() {
    if (settingsState.currentTab === 'quickCombos') {
      openQuickComboModal(null);
      return;
    }
    settingsState.addFormOpen = !settingsState.addFormOpen;
    var addBar = document.getElementById('settingsAddBar');
    var toggleBtnText = document.getElementById('settingsToggleAddBtnText');
    var newInput = document.getElementById('settingsNewInput');

    if (settingsState.addFormOpen) {
      if (addBar) {
        addBar.style.display = 'block';
        addBar.classList.add('animate-in');
      }
      settingsToggleAddBtn.classList.add('active');
      settingsToggleAddBtn.setAttribute('aria-expanded', 'true');
      if (toggleBtnText) toggleBtnText.textContent = '收起';
      if (newInput) {
        setTimeout(function() { newInput.focus(); }, 60);
      }
    } else {
      if (addBar) {
        addBar.style.display = 'none';
        addBar.classList.remove('animate-in');
      }
      settingsToggleAddBtn.classList.remove('active');
      settingsToggleAddBtn.setAttribute('aria-expanded', 'false');
      if (toggleBtnText) toggleBtnText.textContent = '新增項目';
    }
  });
}

var settingsAddBtn = document.getElementById('settingsAddBtn');
if (settingsAddBtn) {
  settingsAddBtn.addEventListener('click', function() {
    addSettingsItem();
  });
}

var settingsPayAddBtn = document.getElementById('settingsPayAddBtn');
if (settingsPayAddBtn) {
  settingsPayAddBtn.addEventListener('click', function() {
    var sub = settingsState.paySubtab || 'cards';
    if (sub === 'cards') openCardModal(null);
    else if (sub === 'channels') openChannelModal(null);
    else if (sub === 'banks') openBankModal(null);
  });
}

var emojiPickBtn = document.getElementById('settingsEmojiPickBtn');
if (emojiPickBtn) {
  emojiPickBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    emojiPickerTarget = 'addBar';
    toggleEmojiPopover(emojiPickBtn);
  });
}

var itemEditEmojiBtn = document.getElementById('itemEditEmojiBtn');
if (itemEditEmojiBtn) {
  itemEditEmojiBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    emojiPickerTarget = 'itemModal';
    toggleEmojiPopover(itemEditEmojiBtn);
  });
}

var emojiPopoverCloseBtn = document.getElementById('emojiPopoverCloseBtn');
if (emojiPopoverCloseBtn) {
  emojiPopoverCloseBtn.addEventListener('click', function() {
    closeEmojiPopover();
  });
}

document.addEventListener('click', function(e) {
  var pop = document.getElementById('emojiPickerPopover');
  if (pop && !pop.hidden) {
    if (!pop.contains(e.target) && !e.target.closest('#settingsEmojiPickBtn') && !e.target.closest('#itemEditEmojiBtn')) {
      closeEmojiPopover();
    }
  }
});

function toggleEmojiPopover(anchorBtn) {
  var pop = document.getElementById('emojiPickerPopover');
  if (!pop) return;
  if (!pop.hidden) {
    closeEmojiPopover();
    return;
  }
  renderEmojiPopoverContent();
  pop.hidden = false;

  var rect = anchorBtn.getBoundingClientRect();
  var top = rect.bottom + 8;
  var left = Math.max(12, Math.min(rect.left, window.innerWidth - 332));
  if (top + 290 > window.innerHeight) {
    top = Math.max(12, rect.top - 290);
  }
  pop.style.top = top + 'px';
  pop.style.left = left + 'px';
}

function closeEmojiPopover() {
  var pop = document.getElementById('emojiPickerPopover');
  if (pop) pop.hidden = true;
}

function renderEmojiPopoverContent() {
  var tabsEl = document.getElementById('emojiPopoverTabs');
  var gridEl = document.getElementById('emojiPopoverGrid');
  if (!tabsEl || !gridEl) return;

  tabsEl.innerHTML = '';
  Object.keys(ICON_CATEGORIES).forEach(function(catName) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-pop-tab' + (catName === currentEmojiCategory ? ' active' : '');
    b.textContent = catName;
    b.addEventListener('click', function(e) {
      e.stopPropagation();
      currentEmojiCategory = catName;
      renderEmojiPopoverContent();
    });
    tabsEl.appendChild(b);
  });

  gridEl.innerHTML = '';
  var icons = ICON_CATEGORIES[currentEmojiCategory] || [];
  icons.forEach(function(name) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'emoji-grid-btn';
    btn.dataset.icon = name;
    btn.setAttribute('aria-label', ICON_LABELS[name] || name);
    btn.title = ICON_LABELS[name] || name;
    btn.appendChild(iconEl(name));
    btn.addEventListener('click', function(e) {
      e.stopPropagation();
      if (emojiPickerTarget === 'itemModal') {
        setIcon(document.getElementById('itemEditEmojiChar'), name);
        setIcon(document.getElementById('itemEditModalCurrentEmoji'), name);
      } else {
        setAddBarEmoji(name);
      }
      closeEmojiPopover();
    });
    gridEl.appendChild(btn);
  });
}

function loadSettings(forceRefresh) {
  var container = document.getElementById('settingsListContainer');
  if (!container) return;

  ensureMetadataInitialized();
  updateSettingsTopControls();

  if (forceRefresh) BudgetSettings.invalidate();

  if (!forceRefresh && settingsState.data) {
    renderSettingsList();
    return;
  }

  if (settingsState.currentTab === 'preferences' || settingsState.currentTab === 'budget') {
    renderSettingsList();
  } else {
    container.innerHTML =
      '<div class="overview-skeleton">' +
        '<div class="skel-block skel-row"></div>' +
        '<div class="skel-block skel-row"></div>' +
        '<div class="skel-block skel-row"></div>' +
      '</div>';
  }

  settingsState.loading = true;

  Api.server
    .withSuccessHandler(function(data) {
      settingsState.loading = false;
      if (data && data.options) {
        settingsState.data = data.options;
        if (data.metadata) {
          settingsState.metadata = data.metadata;
          LocalCache.saveSettingsMetadata(data.metadata);
        }
      } else {
        settingsState.data = data;
        if (data && data.metadata) {
          settingsState.metadata = data.metadata;
          LocalCache.saveSettingsMetadata(data.metadata);
          renderQuickComboChips();
        }
      }
      ensureMetadataInitialized();
      var hadSkeleton = Boolean(container.querySelector('.overview-skeleton'));
      renderSettingsList();
      if (hadSkeleton) Motion.revealCards(container);
      RefreshSpin.stopAll();
      if (forceRefresh) {
        showToast('設定選項已重新讀取', 'success');
      }
    })
    .withFailureHandler(function(err) {
      settingsState.loading = false;
      RefreshSpin.stopAll();
      if (settingsState.currentTab === 'preferences' || settingsState.currentTab === 'budget') {
        showToast('載入設定失敗：' + (err.message || err), 'error');
        return;
      }
      container.innerHTML =
        '<div class="settings-empty">' +
          '<div class="settings-empty-icon" aria-hidden="true">' + iconHtml('warning') + '</div>' +
          '<div class="settings-empty-text">載入失敗：' + (err.message || err) + '</div>' +
        '</div>';
      showToast('載入設定失敗：' + (err.message || err), 'error');
    })
    .getSettingsOptions(Boolean(forceRefresh));
}
