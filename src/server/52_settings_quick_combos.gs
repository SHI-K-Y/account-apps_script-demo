const QUICK_COMBO_LIMITS_ = Object.freeze({ MAX_COUNT: 20, MAX_TITLE_LENGTH: 20 });

function isCreditCardPaymentValue_(payment, cards) {
  const raw = String(payment || '').trim();
  if (raw.indexOf('信用卡') === -1 || raw.indexOf('簽帳卡') === 0) return false;
  const normalize = function (text) {
    return String(text || '').toLowerCase().replace(/\s+/g, '');
  };
  const cardName = normalize(raw.replace(/^[^-－—–]*[-－—–]/, ''));
  return !(cards || []).some(function (card) {
    return card && card.type === 'debit' && normalize(card.name) === cardName;
  });
}

function normalizeQuickCombo_(raw, position, options, cards, existing) {
  const fail = function (message) {
    throw new Error('第 ' + position + ' 組常用組合：' + message);
  };
  if (!raw || typeof raw !== 'object') fail('資料格式錯誤。');

  const type = raw.type;
  if (type !== 'expense' && type !== 'income') fail('類型只能是支出或收入。');
  const isExpense = (type === 'expense');
  const previous = (existing && existing.type === type) ? existing : null;

  const title = String(raw.title == null ? '' : raw.title).trim();
  if (!title) fail('請輸入組合標題。');
  if (title.length > QUICK_COMBO_LIMITS_.MAX_TITLE_LENGTH) {
    fail('組合標題不可超過 ' + QUICK_COMBO_LIMITS_.MAX_TITLE_LENGTH + ' 字。');
  }

  const checkOption = function (field, value, allowed, label) {
    if (previous && previous[field] === value) return;
    try {
      validateOption_(value, allowed || [], label);
    } catch (err) {
      fail(err.message);
    }
  };

  const item = stripEmoji_(raw.item);
  if (!item) fail('請選擇項目。');
  checkOption('item', item, isExpense ? options.expenseItems : options.incomeItems, isExpense ? '支出項目' : '收入項目');

  const category = stripEmoji_(raw.category);
  if (!category) fail('請選擇總類。');
  checkOption('category', category, isExpense ? options.expenseCategories : options.incomeCategories, isExpense ? '支出總類' : '收入總類');

  let payment = '';
  let paid = '';
  if (isExpense) {
    payment = stripEmoji_(raw.payment);
    if (!payment) fail('請選擇支付方式。');
    checkOption('payment', payment, options.paymentMethods, '支出方式');
    try {
      paid = normalizePaidCode_(raw.paid);
    } catch (err) {
      fail(err.message);
    }
    paid = isCreditCardPaymentValue_(payment, cards) ? (paid || 'X') : '';
  }

  let amount = '';
  const rawAmount = String(raw.amount == null ? '' : raw.amount).trim();
  if (rawAmount) {
    let parsedAmount = 0;
    try {
      parsedAmount = normalizeAmount_(rawAmount);
    } catch (err) {
      fail(err.message);
    }
    if (!Number.isInteger(parsedAmount)) fail('金額必須是正整數。');
    amount = String(parsedAmount);
  }

  const combo = { id: '', type: type, title: title, item: item, category: category, payment: payment, paid: paid, amount: amount, updatedAt: 0 };
  const isUnchanged = Boolean(existing) && ['type', 'title', 'item', 'category', 'payment', 'paid', 'amount'].every(function (field) {
    return existing[field] === combo[field];
  });
  combo.updatedAt = (isUnchanged && existing.updatedAt) ? existing.updatedAt : Date.now();
  return combo;
}

function saveQuickCombos_(combos) {
  return withDocumentLock_(function () {
    if (!Array.isArray(combos)) throw new Error('常用組合資料格式錯誤。');
    if (combos.length > QUICK_COMBO_LIMITS_.MAX_COUNT) {
      throw new Error('常用組合最多 ' + QUICK_COMBO_LIMITS_.MAX_COUNT + ' 組。');
    }

    const ss = getSpreadsheet_();
    const meta = getSettingsMetadata_(ss);
    const options = readOptions_(ss);

    const existingById = {};
    meta.quickCombos.forEach(function (c) {
      if (c && c.id) existingById[c.id] = c;
    });

    const usedIds = {};
    meta.quickCombos = combos.map(function (raw, idx) {
      const rawId = raw && typeof raw.id === 'string' ? raw.id : '';
      const hasValidId = /^[\w-]{1,64}$/.test(rawId);
      const existing = hasValidId && Object.prototype.hasOwnProperty.call(existingById, rawId) ? existingById[rawId] : null;
      const combo = normalizeQuickCombo_(raw, idx + 1, options, meta.cards, existing);
      let id = hasValidId ? rawId : '';
      if (!id || usedIds[id]) {
        id = 'combo_' + Date.now() + '_' + idx + '_' + Math.random().toString(36).slice(2, 6);
      }
      usedIds[id] = true;
      combo.id = id;
      return combo;
    });

    if (!saveSettingsMetadata_(meta, ss)) {
      throw new Error('常用組合儲存失敗，請稍後再試。');
    }

    const updated = readAllOptionsData_(ss, true);
    updateBootSnapshotOptions_(updated);

    return {
      ok: true,
      options: updated.raw,
      simpleOptions: updated.simple,
      metadata: updated.metadata,
    };
  });
}

function renameQuickComboOption_(meta, category, oldText, newText) {
  const targets = {
    expenseItems: { type: 'expense', field: 'item' },
    incomeItems: { type: 'income', field: 'item' },
    expenseCategories: { type: 'expense', field: 'category' },
    incomeCategories: { type: 'income', field: 'category' },
    paymentMethods: { type: 'expense', field: 'payment' },
  };
  const target = targets[category];
  if (!target || !Array.isArray(meta.quickCombos)) return;
  meta.quickCombos.forEach(function (combo) {
    if (combo && combo.type === target.type && combo[target.field] === oldText) {
      combo[target.field] = newText;
    }
  });
}

function renamePaymentValue_(value, cardRenameMap, channelRenameMap, bankRenameMap) {
  const lookup = function (map, key) {
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
    const lowerKey = key.toLowerCase();
    const matched = Object.keys(map).filter(function (k) {
      return k.trim().toLowerCase() === lowerKey;
    });
    return matched.length ? map[matched[matched.length - 1]] : null;
  };

  const trimmed = String(value || '').trim();
  if (!trimmed) return String(value || '');
  const dashMatch = trimmed.match(/[-－—–]/);
  if (!dashMatch) {
    const renamedCard = lookup(cardRenameMap, trimmed);
    return renamedCard === null ? value : renamedCard;
  }
  const channelPart = trimmed.slice(0, dashMatch.index).trim();
  const cardPart = trimmed.slice(dashMatch.index + 1).trim();
  const newChannel = lookup(channelRenameMap, channelPart);
  const newCard = lookup(cardRenameMap, cardPart);
  const finalChannel = newChannel === null ? channelPart : newChannel;
  const midCard = newCard === null ? cardPart : newCard;
  const newBank = finalChannel === '轉帳' ? lookup(bankRenameMap || {}, midCard) : null;
  if (newChannel === null && newCard === null && newBank === null) return value;
  return finalChannel + '-' + (newBank === null ? midCard : newBank);
}
