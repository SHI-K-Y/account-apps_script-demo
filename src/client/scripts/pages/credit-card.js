var CreditCardParser = {
  getActiveCreditCards: function() {
    var metaCards = (typeof settingsState !== 'undefined' && settingsState.metadata && Array.isArray(settingsState.metadata.cards))
      ? settingsState.metadata.cards
      : ((state.data && state.data.settingsMetadata && Array.isArray(state.data.settingsMetadata.cards))
        ? state.data.settingsMetadata.cards
        : []);

    var activeList = [];
    metaCards.forEach(function(c) {
      if (c && c.name && c.type !== 'debit') {
        var cleanName = String(c.name).trim();
        if (cleanName) {
          activeList.push({
            id: c.id || ('card_' + cleanName),
            cardName: cleanName,
            channels: Array.isArray(c.channels) ? c.channels.slice() : [],
            imageSrc: getPaymentCardImage(cleanName, cleanName)
          });
        }
      }
    });
    return activeList;
  },

  getDebitCardNameSet: function() {
    var metaCards = (typeof settingsState !== 'undefined' && settingsState.metadata && Array.isArray(settingsState.metadata.cards))
      ? settingsState.metadata.cards
      : ((state.data && state.data.settingsMetadata && Array.isArray(state.data.settingsMetadata.cards))
        ? state.data.settingsMetadata.cards
        : []);
    var debitSet = new Set();
    metaCards.forEach(function(c) {
      if (c && c.name && c.type === 'debit') {
        var n = String(c.name).trim().toLowerCase();
        if (n) {
          debitSet.add(n);
          var stripped = n.replace(/\s*(簽帳金融卡|簽帳卡|金融卡|卡)$/u, '').trim();
          if (stripped) debitSet.add(stripped);
        }
      }
    });
    return debitSet;
  },

  parse: function(paymentStr) {
    var raw = String(paymentStr || '').trim();
    if (!raw) return null;

    if (
      raw.indexOf('簽帳') !== -1 ||
      raw.indexOf('金融卡') !== -1 ||
      raw === '現金' ||
      raw.indexOf('轉帳') === 0 ||
      raw.indexOf('匯款') === 0 ||
      raw === '資金轉移'
    ) {
      return null;
    }

    var dashMatch = raw.match(/[-－—–]/);
    var channelRaw = '信用卡';
    var cardRaw = raw;

    if (dashMatch && dashMatch.index !== undefined) {
      var idx = dashMatch.index;
      channelRaw = raw.slice(0, idx).trim();
      cardRaw = raw.slice(idx + 1).trim() || raw;
    }

    if (
      channelRaw === '簽帳卡' ||
      channelRaw === '轉帳' ||
      channelRaw === '匯款' ||
      channelRaw === '現金'
    ) {
      return null;
    }

    var debitCardNames = this.getDebitCardNameSet();
    var cardRawLower = cardRaw.toLowerCase().trim();
    var cardRawBaseLower = cardRaw.replace(/\s*(信用卡|簽帳卡|金融卡|卡)$/u, '').trim().toLowerCase();
    if (debitCardNames.has(cardRawLower) || (cardRawBaseLower && debitCardNames.has(cardRawBaseLower))) {
      return null;
    }

    var chLower = channelRaw.toLowerCase();
    var channelLabel = channelRaw;
    var channelClass = 'ch-credit';

    if (chLower.indexOf('line') !== -1 || chLower.indexOf('linw') !== -1) {
      channelLabel = 'Line Pay';
      channelClass = 'ch-linepay';
    } else if (chLower.indexOf('悠活支付') !== -1 || chLower.indexOf('yohopay') !== -1) {
      channelLabel = '悠活支付';
      channelClass = 'ch-yohopay';
    } else if (chLower.indexOf('青禾電子支付') !== -1 || chLower.indexOf('青禾wallet') !== -1) {
      channelLabel = '青禾電子支付';
      channelClass = 'ch-qinghe';
    } else if (channelRaw === '信用卡') {
      channelLabel = '一般刷卡';
      channelClass = 'ch-credit';
    }

    var activeCreditCards = this.getActiveCreditCards();
    var matchedCard = null;
    var normCardRaw = cardRawLower.replace(/\s+/g, '');
    var normCardBase = cardRawBaseLower.replace(/\s+/g, '');

    for (var i = 0; i < activeCreditCards.length; i++) {
      var ac = activeCreditCards[i];
      var acLower = ac.cardName.toLowerCase().trim();
      var acNorm = acLower.replace(/\s+/g, '');
      var acBaseNorm = ac.cardName.replace(/\s*(信用卡|卡)$/u, '').trim().toLowerCase().replace(/\s+/g, '');

      if (
        cardRawLower === acLower ||
        normCardRaw === acNorm ||
        (normCardBase && acBaseNorm && normCardBase === acBaseNorm)
      ) {
        matchedCard = ac;
        break;
      }
    }

    if (!matchedCard && normCardBase) {
      for (var j = 0; j < activeCreditCards.length; j++) {
        var ac2 = activeCreditCards[j];
        var ac2Base = ac2.cardName.replace(/\s*(信用卡|卡)$/u, '').trim().toLowerCase().replace(/\s+/g, '');
        if (ac2Base && (ac2Base.indexOf(normCardBase) !== -1 || normCardBase.indexOf(ac2Base) !== -1)) {
          matchedCard = ac2;
          break;
        }
      }
    }

    if (matchedCard) {
      return {
        rawPayment: raw,
        channelLabel: channelLabel,
        channelClass: channelClass,
        cardName: matchedCard.cardName,
        cardId: matchedCard.id,
        imageSrc: matchedCard.imageSrc || getPaymentCardImage(matchedCard.cardName, matchedCard.cardName)
      };
    }

    if (raw.indexOf('信用卡') === -1) {
      return null;
    }

    var base = cardRaw.replace(/(信用卡|卡)$/u, '').trim();
    var cardName = (!base || base === '信用卡') ? '一般信用卡' : cardRaw;

    return {
      rawPayment: raw,
      channelLabel: channelLabel,
      channelClass: channelClass,
      cardName: cardName,
      cardId: null,
      imageSrc: getPaymentCardImage(cardName, cardName)
    };
  },

  collectCardsSummary: function(records, optionPaymentMethods) {
    var self = this;
    var cardMap = new Map();
    var activeOrderMap = new Map();

    function ensureCard(cardName, extraMeta) {
      if (!cardMap.has(cardName)) {
        var img = (extraMeta && extraMeta.imageSrc) || getPaymentCardImage(cardName, cardName);
        cardMap.set(cardName, {
          cardName: cardName,
          cardId: (extraMeta && extraMeta.id) || null,
          imageSrc: img,
          isActiveSettingCard: Boolean(extraMeta && extraMeta.isActiveSettingCard),
          count: 0,
          totalAmount: 0,
          paidAmount: 0,
          unpaidAmount: 0,
          paidCount: 0,
          unpaidCount: 0,
          channels: new Set(),
          records: [],
        });
      } else if (extraMeta) {
        var existing = cardMap.get(cardName);
        if (extraMeta.id && !existing.cardId) existing.cardId = extraMeta.id;
        if (extraMeta.imageSrc && !existing.imageSrc) existing.imageSrc = extraMeta.imageSrc;
        if (extraMeta.isActiveSettingCard) existing.isActiveSettingCard = true;
      }
      return cardMap.get(cardName);
    }

    var activeCreditCards = this.getActiveCreditCards();
    activeCreditCards.forEach(function(ac, idx) {
      activeOrderMap.set(ac.cardName, idx);
      var entry = ensureCard(ac.cardName, {
        id: ac.id,
        imageSrc: ac.imageSrc,
        isActiveSettingCard: true
      });
      (ac.channels || []).forEach(function(ch) {
        if (ch === '信用卡') entry.channels.add('一般刷卡');
        else if (ch) entry.channels.add(ch);
      });
    });

    if (!activeCreditCards.length) {
      (optionPaymentMethods || []).forEach(function(pm) {
        var info = self.parse(pm);
        if (info && info.cardName) {
          var entry = ensureCard(info.cardName, { imageSrc: info.imageSrc });
          entry.channels.add(info.channelLabel);
        }
      });
    }

    var allCcRecords = [];
    var totalAll = 0;
    var paidAll = 0;
    var unpaidAll = 0;
    var paidCountAll = 0;
    var unpaidCountAll = 0;
    var allChannels = new Set();

    (records || []).forEach(function(rec) {
      var info = self.parse(rec.payment);
      if (!info) return;

      var amt = FinanceUtils.parse(rec.amount);
      var isPaid = String(rec.paid || '').trim().toUpperCase() === 'O';
      var enriched = Object.assign({}, rec, {
        ccInfo: info,
        isPaid: isPaid,
        numericAmount: amt,
      });

      allCcRecords.push(enriched);
      allChannels.add(info.channelLabel);

      totalAll += amt;
      if (isPaid) {
        paidAll += amt;
        paidCountAll += 1;
      } else {
        unpaidAll += amt;
        unpaidCountAll += 1;
      }

      var cardEntry = ensureCard(info.cardName, {
        id: info.cardId,
        imageSrc: info.imageSrc
      });
      cardEntry.count += 1;
      cardEntry.totalAmount += amt;
      if (isPaid) {
        cardEntry.paidAmount += amt;
        cardEntry.paidCount += 1;
      } else {
        cardEntry.unpaidAmount += amt;
        cardEntry.unpaidCount += 1;
      }
      cardEntry.channels.add(info.channelLabel);
      cardEntry.records.push(enriched);
    });

    var cardList = Array.from(cardMap.values()).map(function(c) {
      if (!c.imageSrc) {
        c.imageSrc = getPaymentCardImage(c.cardName, c.cardName);
      }
      return c;
    }).sort(function(a, b) {
      var aActive = activeOrderMap.has(a.cardName);
      var bActive = activeOrderMap.has(b.cardName);
      if (aActive && !bActive) return -1;
      if (!aActive && bActive) return 1;
      if (aActive && bActive) {
        if (b.unpaidAmount !== a.unpaidAmount && (a.unpaidAmount > 0 || b.unpaidAmount > 0)) {
          return b.unpaidAmount - a.unpaidAmount;
        }
        return activeOrderMap.get(a.cardName) - activeOrderMap.get(b.cardName);
      }
      if (b.unpaidAmount !== a.unpaidAmount) return b.unpaidAmount - a.unpaidAmount;
      if (b.totalAmount !== a.totalAmount) return b.totalAmount - a.totalAmount;
      return b.count - a.count;
    });

    return {
      all: {
        cardName: 'ALL',
        displayName: '全部信用卡',
        count: allCcRecords.length,
        totalAmount: totalAll,
        paidAmount: paidAll,
        unpaidAmount: unpaidAll,
        paidCount: paidCountAll,
        unpaidCount: unpaidCountAll,
        channels: Array.from(allChannels),
        records: allCcRecords,
      },
      cards: cardList,
      cardMap: cardMap,
    };
  }
};

var goCcBtn = document.getElementById('goCreditCardPageBtn');
if (goCcBtn) {
  goCcBtn.addEventListener('click', function() {
    switchPage('creditcard');
  });
}

var ccBackBtn = document.getElementById('ccBackBtn');
if (ccBackBtn) {
  ccBackBtn.addEventListener('click', function() {
    switchPage('settlement');
  });
}

window.appSwitchPage = switchPage;

document.querySelectorAll('[data-open-search]').forEach(function(btn) {
  btn.addEventListener('click', function() {
    SearchPage.setOrigin(document.body.dataset.page);
    switchPage('search');
  });
});
var srBackBtn = document.getElementById('srBackBtn');
if (srBackBtn) {
  srBackBtn.addEventListener('click', function() {
    switchPage(SearchPage.getOrigin());
  });
}

var ccRefreshBtn = document.getElementById('ccRefreshBtn');
if (ccRefreshBtn) {
  ccRefreshBtn.addEventListener('click', function() {
    loadCreditCardAll(true);
  });
}

// 信用卡對帳會讀取所有月份工作表；每次向後端要幾個月份（避免單次呼叫太久而逾時）
var CC_MONTHS_PER_BATCH = 6;
var ccLoadSeq = 0;

function ccBusyKey(month, row) {
  return month + '#' + row;
}

function getCcAllMonths() {
  return (state.data && Array.isArray(state.data.months)) ? state.data.months.slice() : [];
}

// 把各月份的支出合併成一個清單（新月份在前），每筆加上所屬月份
function collectCcRecords() {
  var out = [];
  getCcAllMonths().forEach(function(m) {
    var list = ccState.recordsByMonth[m];
    if (!Array.isArray(list)) return;
    list.forEach(function(r) {
      out.push(Object.assign({}, r, { month: m }));
    });
  });
  return out;
}

// 「2026.11」+ 15 → 「11/15」
function formatCcDate(month, day) {
  var monthNum = parseInt(String(month || '').split(/\D+/)[1], 10);
  var parsedDay = parseInt(day, 10);
  var dayPart = !isNaN(parsedDay) ? String(parsedDay) : (day ? String(day).trim() : '');
  if (!dayPart) return '未填';
  return !isNaN(monthNum) ? (monthNum + '/' + dayPart) : (dayPart + '日');
}

// 「2026.11」→「2026 年 11 月」
function formatCcMonthLabel(month) {
  var parts = String(month || '').split(/\D+/);
  var y = parseInt(parts[0], 10);
  var m = parseInt(parts[1], 10);
  if (isNaN(y) || isNaN(m)) return String(month || '');
  return y + ' 年 ' + m + ' 月';
}

// 可供切換的月份（新月份在前），略過舊版面、未納入對帳的月份
function getCcSelectableMonths() {
  var skipped = ccState.skippedMonths || {};
  return getCcAllMonths().filter(function(m) { return !skipped[m]; });
}

function buildCcMonthBarHtml(months) {
  var sel = ccState.selectedMonth;
  var idx = months.indexOf(sel);
  var currentMonth = state.data && state.data.currentMonth;
  // 選單是新月份在前：「‹」往較舊的月份、「›」往較新的月份；從「全部月份」按「‹」會跳到最新的月份
  var olderTarget = (sel === 'ALL') ? months[0] : months[idx + 1];
  var newerTarget = (sel === 'ALL' || idx <= 0) ? null : months[idx - 1];

  var opts = '<option value="ALL"' + (sel === 'ALL' ? ' selected' : '') + '>全部月份</option>';
  months.forEach(function(m) {
    opts += '<option value="' + escAttr(m) + '"' + (m === sel ? ' selected' : '') + '>' +
              escHtml(formatCcMonthLabel(m) + (m === currentMonth ? '（本月）' : '')) +
            '</option>';
  });

  return '<div class="cc-month-bar">' +
           '<button type="button" class="icon-btn cc-month-step" data-month-target="' + escAttr(olderTarget || '') + '"' +
             (olderTarget ? '' : ' disabled') + ' title="上一個月" aria-label="上一個月">' + iconHtml('caret-left') + '</button>' +
           '<select id="ccMonthSelect" class="month-select cc-month-select" aria-label="選擇月份">' + opts + '</select>' +
           '<button type="button" class="icon-btn cc-month-step" data-month-target="' + escAttr(newerTarget || '') + '"' +
             (newerTarget ? '' : ' disabled') + ' title="下一個月" aria-label="下一個月">' + iconHtml('caret-right') + '</button>' +
         '</div>';
}

function emptyCcScope(cardName) {
  return {
    cardName: cardName,
    count: 0,
    totalAmount: 0,
    paidAmount: 0,
    unpaidAmount: 0,
    paidCount: 0,
    unpaidCount: 0,
    records: [],
  };
}

function openCreditCardReconciliation() {
  loadCreditCardAll(false);
}

/**
 * 讀取所有月份的支出明細。
 * forceRefresh=false 時只讀還沒有資料的月份（先用記憶體與本機快取）；
 * onlyMonths 可限定只重新讀哪些月份（例如批次標記失敗後還原）。
 */
function loadCreditCardAll(forceRefresh, onlyMonths) {
  var container = document.getElementById('creditCardContent');
  if (!container) return;
  if (!ccState.skippedMonths) ccState.skippedMonths = {};

  var months = Array.isArray(onlyMonths) ? onlyMonths.slice() : getCcAllMonths();
  if (forceRefresh && !onlyMonths) ccState.skippedMonths = {};

  var pending = [];
  months.forEach(function(m) {
    if (forceRefresh) { pending.push(m); return; }
    if (Array.isArray(ccState.recordsByMonth[m]) || ccState.skippedMonths[m]) return;
    var cachedRecent = LocalCache.getRecent(m);
    if (cachedRecent && Array.isArray(cachedRecent.fullExpenses)) {
      ccState.recordsByMonth[m] = cachedRecent.fullExpenses;
      return;
    }
    pending.push(m);
  });

  if (!pending.length) {
    renderCreditCardPage();
    return;
  }

  var seq = ++ccLoadSeq;
  var hadSkeleton = !collectCcRecords().length;
  ccState.loadingProgress = { done: 0, total: pending.length };
  renderCreditCardPage();
  setLoading(true);

  var batches = [];
  for (var i = 0; i < pending.length; i += CC_MONTHS_PER_BATCH) {
    batches.push(pending.slice(i, i + CC_MONTHS_PER_BATCH));
  }
  var failedMonths = [];

  function finish() {
    ccState.loadingProgress = null;
    setLoading(false);
    renderCreditCardPage();
    if (hadSkeleton) Motion.revealCards(container);
    if (failedMonths.length) {
      showToast('有 ' + failedMonths.length + ' 個月份讀取失敗：' + failedMonths.join('、'), 'error');
    } else if (forceRefresh && !onlyMonths) {
      showToast('已重新讀取所有月份的信用卡消費明細', 'success');
    }
  }

  function next(idx) {
    if (seq !== ccLoadSeq) return;
    if (idx >= batches.length) { finish(); return; }
    var batch = batches[idx];
    Api.call('getCreditCardRecords', batch, Boolean(forceRefresh))
      .then(function(res) {
        if (seq !== ccLoadSeq) return;
        var byMonth = (res && res.recordsByMonth) || {};
        Object.keys(byMonth).forEach(function(m) {
          ccState.recordsByMonth[m] = byMonth[m] || [];
        });
        ((res && res.skippedMonths) || []).concat((res && res.missingMonths) || []).forEach(function(m) {
          ccState.skippedMonths[m] = true;
        });
        failedMonths = failedMonths.concat((res && res.failedMonths) || []);
        ccState.loadingProgress.done += batch.length;
        renderCreditCardPage();
        next(idx + 1);
      })
      .catch(function(err) {
        if (seq !== ccLoadSeq) return;
        ccState.loadingProgress = null;
        renderCreditCardPage();
        showServerError(err);
      });
  }
  next(0);
}

function renderCreditCardPage() {
  var container = document.getElementById('creditCardContent');
  if (!container) return;

  var allExpenseRecords = collectCcRecords();
  var progress = ccState.loadingProgress;

  if (!allExpenseRecords.length && progress) {
    if (!container.querySelector('.overview-skeleton')) {
      container._ccRegions = null;
      container.innerHTML =
        '<div class="overview-skeleton">' +
          '<div class="skel-block skel-hero"></div>' +
          '<div class="skel-block skel-row"></div>' +
          '<div class="skel-block skel-row"></div>' +
        '</div>';
    }
    return;
  }

  var paymentOptions = (state.data && state.data.options && state.data.options.paymentMethods) || DEFAULT_OPTIONS_FALLBACK.paymentMethods;
  // 卡別分頁依所有月份列出（切換月份時分頁不會消失）；金額、筆數與明細只算所選月份
  var summaryAllMonths = CreditCardParser.collectCardsSummary(allExpenseRecords, paymentOptions);

  if (ccState.selectedCard !== 'ALL' && !summaryAllMonths.cardMap.has(ccState.selectedCard)) {
    ccState.selectedCard = 'ALL';
  }

  var selectableMonths = getCcSelectableMonths();
  if (ccState.selectedMonth !== 'ALL' && selectableMonths.indexOf(ccState.selectedMonth) === -1) {
    ccState.selectedMonth = 'ALL';
  }
  var selectedMonth = ccState.selectedMonth;
  var isAllMonths = (selectedMonth === 'ALL');

  var summary = isAllMonths
    ? summaryAllMonths
    : CreditCardParser.collectCardsSummary(allExpenseRecords.filter(function(r) {
        return r.month === selectedMonth;
      }), paymentOptions);

  var activeScope = (ccState.selectedCard === 'ALL')
    ? summary.all
    : (summary.cardMap.get(ccState.selectedCard) || emptyCcScope(ccState.selectedCard));

  var activeCardTitle = (ccState.selectedCard === 'ALL') ? '全部信用卡' : activeScope.cardName;
  var monthLoading = !isAllMonths && !Array.isArray(ccState.recordsByMonth[selectedMonth]);

  var filteredRecords = (activeScope.records || []).filter(function(r) {
    if (ccState.statusFilter === 'unpaid') return !r.isPaid;
    if (ccState.statusFilter === 'paid') return r.isPaid;
    return true;
  });

  // P06：頁面分成幾個區塊，各自只在 HTML 改變時替換；明細列以「月份｜列號」比對，只更新有變化的列。
  // 點擊與月份選單一律委派到 container（bindCreditCardEvents，只綁一次）。
  var regions = ensureCcRegions(container);
  ccState.view = {
    activeScope: activeScope,
    activeCardTitle: activeCardTitle,
    isAllMonths: isAllMonths,
    selectedMonth: selectedMonth
  };

  var tabsHtml = '<div class="cc-card-tabs" role="tablist" aria-label="選擇信用卡別">';
  var isAllActive = (ccState.selectedCard === 'ALL');
  tabsHtml += '<button type="button" class="cc-card-tab' + (isAllActive ? ' active' : '') + '" data-card="ALL">' +
            (summary.all.count > 0 ? '<span class="cc-tab-dot' + (summary.all.unpaidCount > 0 ? ' has-unpaid' : '') + '"></span>' : '') +
            '<span>全部信用卡</span>' +
          '</button>';

  summaryAllMonths.cards.forEach(function(c) {
    var isActive = (ccState.selectedCard === c.cardName);
    var thumbHtml = c.imageSrc
      ? '<img class="cc-tab-card-img" src="' + escAttr(c.imageSrc) + '" alt="" width="24" height="15" decoding="async">'
      : '';
    // 小圓點反映所選月份：有消費才顯示，有未繳時為紅色
    var scoped = summary.cardMap.get(c.cardName);
    var dotHtml = (scoped && scoped.count > 0)
      ? '<span class="cc-tab-dot' + (scoped.unpaidCount > 0 ? ' has-unpaid' : '') + '"></span>'
      : '';
    tabsHtml += '<button type="button" class="cc-card-tab' + (isActive ? ' active' : '') + '" data-card="' + escAttr(c.cardName) + '">' +
              dotHtml +
              thumbHtml +
              '<span>' + escHtml(c.cardName) + '</span>' +
            '</button>';
  });
  tabsHtml += '</div>';
  if (setCcRegion(regions.tabs, tabsHtml)) Motion.segmented(regions.tabs.firstElementChild, '.cc-card-tab');

  setCcRegion(regions.month, buildCcMonthBarHtml(selectableMonths));

  setCcRegion(regions.summary, '<div class="cc-summary-bar">' +
            '<div class="cc-stat-box">' +
              '<span class="cc-stat-label">消費總額</span>' +
              '<span class="cc-stat-val">$' + ovFmt(activeScope.totalAmount) + '</span>' +
            '</div>' +
            '<div class="cc-stat-box">' +
              '<span class="cc-stat-label">未繳金額</span>' +
              '<span class="cc-stat-val' + (activeScope.unpaidAmount > 0 ? ' unpaid' : '') + '">$' + ovFmt(activeScope.unpaidAmount) + '</span>' +
            '</div>' +
            '<div class="cc-stat-box">' +
              '<span class="cc-stat-label">已繳金額</span>' +
              '<span class="cc-stat-val paid">$' + ovFmt(activeScope.paidAmount) + '</span>' +
            '</div>' +
          '</div>');

  var toolbarHtml = '<div class="cc-toolbar">' +
            '<div class="cc-status-filters" role="tablist" aria-label="繳費狀態篩選">' +
              '<button type="button" class="cc-filter-btn' + (ccState.statusFilter === 'all' ? ' active' : '') + '" data-sfilter="all">全部 (' + activeScope.count + ')</button>' +
              '<button type="button" class="cc-filter-btn' + (ccState.statusFilter === 'unpaid' ? ' active' : '') + '" data-sfilter="unpaid">未繳 (' + activeScope.unpaidCount + ')</button>' +
              '<button type="button" class="cc-filter-btn' + (ccState.statusFilter === 'paid' ? ' active' : '') + '" data-sfilter="paid">已繳 (' + activeScope.paidCount + ')</button>' +
            '</div>';

  if (activeScope.unpaidCount > 0) {
    toolbarHtml += '<button type="button" id="ccBatchMarkPaidBtn" class="cc-batch-paid-btn"' + (ccState.batchBusy ? ' disabled' : '') + '>' +
              (ccState.batchBusy ? '' : iconHtml('check')) + '<span>' + (ccState.batchBusy ? '更新中…' : '全部標為已繳') + '</span>' +
            '</button>';
  }
  toolbarHtml += '</div>';
  if (setCcRegion(regions.toolbar, toolbarHtml)) Motion.segmented(regions.toolbar.querySelector('.cc-status-filters'), '.cc-filter-btn');

  var skippedList = Object.keys(ccState.skippedMonths || {}).sort().reverse();
  var noteHtml = '';
  if (progress) {
    noteHtml = '<div class="cc-load-note" role="status">正在讀取所有月份的明細…（' + progress.done + '/' + progress.total + '）</div>';
  } else if (skippedList.length) {
    noteHtml = '<div class="cc-load-note">以下月份的工作表是舊版面，未納入對帳：' + escHtml(skippedList.join('、')) + '</div>';
  }
  setCcRegion(regions.note, noteHtml);

  var card = regions.card;
  if (!filteredRecords.length) {
    var emptyMsg;
    if (monthLoading) {
      emptyMsg = '正在讀取這個月份的明細…';
    } else if (activeScope.count === 0) {
      emptyMsg = isAllMonths
        ? '尚無此信用卡的消費紀錄。'
        : (formatCcMonthLabel(selectedMonth) + '沒有' + (ccState.selectedCard === 'ALL' ? '信用卡' : '此信用卡的') + '消費紀錄。');
    } else {
      emptyMsg = ccState.statusFilter === 'unpaid'
        ? (isAllMonths ? '目前沒有未繳帳單。' : '這個月份沒有未繳帳單。')
        : '沒有符合的消費明細。';
    }
    setCcRegion(card, '<div class="empty" style="padding:28px 12px;">' + escHtml(emptyMsg) + '</div>');
    return;
  }

  var list = card.firstElementChild;
  if (!list || !list.classList.contains('cc-tx-list')) {
    card.innerHTML = '<div class="cc-tx-list"></div>';
    card._ccHtml = null;
    list = card.firstElementChild;
  }
  ListRender.reconcile(list, filteredRecords, {
    key: function(rec) { return rec.month + '|' + rec.row; },
    sig: ccTxRowHtml,
    html: ccTxRowHtml,
    chunk: { listId: [ccState.selectedCard, selectedMonth, ccState.statusFilter].join('|') }
  });
}

function ccTxRowHtml(rec) {
  var dayText = formatCcDate(rec.month, rec.day);
  var itemDisplayHtml = rec.item ? itemIconLabelHtml(rec.item) : '未填';
  var isPaid = rec.isPaid;
  var isRowBusy = Boolean(ccState.busyRows[ccBusyKey(rec.month, rec.row)]);
  var hasNote = Boolean(rec.note && String(rec.note).trim() !== '');

  var cardDisplay = rec.ccInfo.cardName;
  var subText = '';
  if (ccState.selectedCard === 'ALL') {
    subText = (rec.ccInfo.channelLabel === '一般刷卡')
      ? cardDisplay
      : (rec.ccInfo.channelLabel + '，' + cardDisplay);
  } else {
    subText = rec.ccInfo.channelLabel;
  }

  return '<div class="cc-tx-item' + (isPaid ? ' is-paid' : '') + '" data-month="' + escAttr(rec.month) + '" data-row="' + rec.row + '">' +
            '<div class="cc-tx-day">' + escHtml(dayText) + '</div>' +
            '<div class="cc-tx-main">' +
              '<div class="cc-tx-title-row">' +
                '<span class="cc-tx-item-name">' + itemDisplayHtml + '</span>' +
                (hasNote ? '<span class="cc-tx-note-inline">，' + escHtml(rec.note) + '</span>' : '') +
              '</div>' +
              '<div class="cc-tx-sub">' + escHtml(subText) + '</div>' +
            '</div>' +
            '<div class="cc-tx-right">' +
              '<div class="cc-tx-amount">$' + ovFmt(Math.abs(rec.numericAmount)) + '</div>' +
              '<button type="button" class="cc-paid-btn' + (isPaid ? ' already-paid' : '') + '" data-month="' + escAttr(rec.month) + '" data-row="' + rec.row + '" data-paid="' + (isPaid ? 'O' : 'X') + '"' + (isRowBusy ? ' disabled' : '') + ' title="' + (isPaid ? '點擊取消已繳費狀態' : '點擊標記為已繳費') + '" aria-label="' + (isPaid ? '已繳費，點擊取消' : '未繳費，點擊標記已繳') + '">' +
                '<span class="uv-btn-sign" aria-hidden="true">' +
                  (isRowBusy
                    ? '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-dasharray="28" stroke-dashoffset="10" stroke-linecap="round"/></svg>'
                    : '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>') +
                '</span>' +
                '<span class="uv-btn-text">已繳費</span>' +
              '</button>' +
            '</div>' +
          '</div>';
}

/** 區塊外殼：display: contents，不影響原本的排版（樣式在 11-credit-card.css）。 */
function ensureCcRegions(container) {
  var r = container._ccRegions;
  if (r && r.tabs.parentNode === container && r.card.parentNode === container) return r;
  container.innerHTML =
    '<div class="cc-region"></div><div class="cc-region"></div><div class="cc-region"></div>' +
    '<div class="cc-region"></div><div class="cc-region"></div><div class="ov-card cc-tx-card"></div>';
  var kids = container.children;
  r = { tabs: kids[0], month: kids[1], summary: kids[2], toolbar: kids[3], note: kids[4], card: kids[5] };
  container._ccRegions = r;
  bindCreditCardEvents(container);
  return r;
}

/** HTML 和上次相同就不動；有替換時回傳 true。 */
function setCcRegion(el, html) {
  if (el._ccHtml === html) return false;
  el._ccHtml = html;
  el.innerHTML = html;
  return true;
}

function bindCreditCardEvents(container) {
  if (container._ccBound) return;
  container._ccBound = true;

  container.addEventListener('change', function(e) {
    var monthSelect = e.target && e.target.closest ? e.target.closest('#ccMonthSelect') : null;
    if (!monthSelect) return;
    ccState.selectedMonth = monthSelect.value || 'ALL';
    renderCreditCardPage();
  });

  container.addEventListener('click', function(e) {
    var t = e.target;
    if (!t || !t.closest) return;
    var tabBtn = t.closest('.cc-card-tab');
    if (tabBtn && container.contains(tabBtn)) {
      ccState.selectedCard = tabBtn.dataset.card || 'ALL';
      renderCreditCardPage();
      return;
    }
    var stepBtn = t.closest('.cc-month-step');
    if (stepBtn && container.contains(stepBtn)) {
      var target = stepBtn.dataset.monthTarget;
      if (!target) return;
      ccState.selectedMonth = target;
      renderCreditCardPage();
      return;
    }
    var filterBtn = t.closest('.cc-filter-btn');
    if (filterBtn && container.contains(filterBtn)) {
      ccState.statusFilter = filterBtn.dataset.sfilter || 'all';
      renderCreditCardPage();
      return;
    }
    var paidBtn = t.closest('.cc-paid-btn');
    if (paidBtn && container.contains(paidBtn)) {
      e.stopPropagation();
      if (paidBtn.disabled) return;
      var rowNum = Number(paidBtn.dataset.row);
      var currentPaid = paidBtn.dataset.paid;
      var nextPaid = (currentPaid === 'O') ? 'X' : 'O';
      toggleSingleCreditCardPaid(paidBtn.dataset.month, rowNum, nextPaid);
      return;
    }
    var batchBtn = t.closest('#ccBatchMarkPaidBtn');
    if (batchBtn && container.contains(batchBtn)) {
      if (batchBtn.disabled) return;
      if (ccState.loadingProgress) {
        showToast('還在讀取其他月份的明細，請稍候再操作', 'error');
        return;
      }
      var view = ccState.view || {};
      var unpaid = ((view.activeScope && view.activeScope.records) || []).filter(function(r) { return !r.isPaid; });
      if (!unpaid.length) return;
      var rowsByMonth = {};
      unpaid.forEach(function(r) {
        (rowsByMonth[r.month] = rowsByMonth[r.month] || []).push(r.row);
      });
      var scopeText = '「' + view.activeCardTitle + '」' + (view.isAllMonths ? '' : formatCcMonthLabel(view.selectedMonth));
      if (!confirm('確定要將' + scopeText + '的 ' + unpaid.length + ' 筆未繳明細，全數標記為【已繳費】嗎？')) {
        return;
      }
      batchMarkUnpaidRecords(rowsByMonth);
    }
  });
}

// 組出「11/15的午餐共120元」這種描述，讓 toast 指出是哪一筆消費
function describeCreditCardRecord(month, rec) {
  if (!rec) return '這筆消費';
  var dayText = formatCcDate(month, rec.day);
  if (dayText === '未填') dayText = '未填日期';
  var itemText = rec.item ? String(rec.item).trim() : '未填項目';
  var amountText = ovFmt(Math.abs(FinanceUtils.parse(rec.amount)));
  return dayText + '的' + itemText + '共' + amountText + '元';
}

// 寫入成功後，用後端回傳的該月最新資料更新畫面與快取
// 後端回傳差量（P10）時合併進該月份現有的清單；沒有可合併的清單時，畫面上已經先改好的狀態就是結果
function applyCreditCardMutationResult(month, res) {
  var resolved = resolveMutationRecent(res, month);
  var recent = resolved.recent;
  if (recent && !resolved.stale) {
    LocalCache.saveRecent(month, recent);
    if (Array.isArray(recent.fullExpenses)) {
      ccState.recordsByMonth[month] = recent.fullExpenses;
    }
    if (month === getMonth()) renderRecent(recent);
  } else if (recent && month === getMonth()) {
    // 本機清單比後端舊：不拿它蓋掉信用卡頁的資料，重新讀取這個月份
    loadRecent(month, true);
  }
  LocalCache.invalidateOverview(month);
}

function afterCreditCardMutations() {
  LocalCache.saveSettlement(null);
  if (typeof window.__invalidateOverviewFlag === 'function') {
    window.__invalidateOverviewFlag();
  }
}

function toggleSingleCreditCardPaid(month, rowNum, targetPaid) {
  var busyKey = ccBusyKey(month, rowNum);
  if (!month || !rowNum || ccState.busyRows[busyKey]) return;

  state.mutationVersion++;
  ccState.busyRows[busyKey] = true;

  var monthRecords = ccState.recordsByMonth[month] || [];
  var prevPaid = 'X';
  var targetRec = null;
  monthRecords.forEach(function(r) {
    if (Number(r.row) === Number(rowNum)) {
      prevPaid = r.paid || 'X';
      r.paid = targetPaid;
      targetRec = r;
    }
  });
  var toastDesc = describeCreditCardRecord(month, targetRec);
  renderCreditCardPage();

  Api.server
    .withSuccessHandler(function(res) {
      delete ccState.busyRows[busyKey];
      applyCreditCardMutationResult(month, res);
      afterCreditCardMutations();
      renderCreditCardPage();
      showToast(toastDesc + '，' + (targetPaid === 'O' ? '已繳費' : '未繳費'), 'success');
    })
    .withFailureHandler(function(err) {
      delete ccState.busyRows[busyKey];
      monthRecords.forEach(function(r) {
        if (Number(r.row) === Number(rowNum)) {
          r.paid = prevPaid;
        }
      });
      renderCreditCardPage();
      showServerError(err);
    })
    .markCreditCardPaid({ month: month, row: rowNum, paid: targetPaid });
}

// rowsByMonth：{ '2026.11': [5, 8], '2026.10': [12] }，每個月份各送一次，依序執行
function batchMarkUnpaidRecords(rowsByMonth) {
  var months = Object.keys(rowsByMonth || {}).filter(function(m) {
    return Array.isArray(rowsByMonth[m]) && rowsByMonth[m].length;
  });
  if (!months.length || ccState.batchBusy) return;

  state.mutationVersion++;
  ccState.batchBusy = true;

  var total = 0;
  months.forEach(function(m) {
    var rowSet = new Set(rowsByMonth[m].map(Number));
    total += rowSet.size;
    (ccState.recordsByMonth[m] || []).forEach(function(r) {
      if (rowSet.has(Number(r.row))) r.paid = 'O';
    });
  });
  renderCreditCardPage();

  var doneCount = 0;
  function next(idx) {
    if (idx >= months.length) {
      ccState.batchBusy = false;
      afterCreditCardMutations();
      renderCreditCardPage();
      showToast('已成功將 ' + total + ' 筆信用卡消費標記為【已繳費 (O)】！', 'success');
      return;
    }
    var month = months[idx];
    var rows = rowsByMonth[month];
    Api.call('batchMarkCreditCardPaid', { month: month, rows: rows, paid: 'O' })
      .then(function(res) {
        applyCreditCardMutationResult(month, res);
        doneCount += rows.length;
        next(idx + 1);
      })
      .catch(function(err) {
        ccState.batchBusy = false;
        if (doneCount) afterCreditCardMutations();
        // 還沒寫入成功的月份重新讀取，畫面才會和試算表一致
        var remaining = months.slice(idx);
        remaining.forEach(function(m) { delete ccState.recordsByMonth[m]; });
        loadCreditCardAll(true, remaining);
        showServerError(err);
      });
  }
  next(0);
}
