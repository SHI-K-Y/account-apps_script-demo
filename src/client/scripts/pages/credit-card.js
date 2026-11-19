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

var ccMonthSelect = document.getElementById('ccMonthSelect');
if (ccMonthSelect) {
  ccMonthSelect.addEventListener('change', function(e) {
    ccState.month = e.target.value;
    loadCreditCardMonth(ccState.month, false);
  });
}

var ccRefreshBtn = document.getElementById('ccRefreshBtn');
if (ccRefreshBtn) {
  ccRefreshBtn.addEventListener('click', function() {
    var targetMonth = ccState.month || getMonth();
    loadCreditCardMonth(targetMonth, true);
  });
}

function openCreditCardReconciliation() {
  var ccSelect = document.getElementById('ccMonthSelect');
  if (!ccState.month) {
    ccState.month = getMonth() || (state.data && state.data.selectedMonth) || getClientToday().currentMonth;
  }
  if (ccSelect && state.data && Array.isArray(state.data.months)) {
    if (!ccSelect.options.length) {
      populateMonths();
    }
    ccSelect.value = ccState.month;
  }
  loadCreditCardMonth(ccState.month, false);
}

function loadCreditCardMonth(month, forceRefresh) {
  if (!month) return;
  ccState.month = month;
  var ccSelect = document.getElementById('ccMonthSelect');
  if (ccSelect && ccSelect.value !== month) {
    ccSelect.value = month;
  }

  var container = document.getElementById('creditCardContent');
  if (!container) return;

  if (!forceRefresh) {
    if (Array.isArray(ccState.recordsByMonth[month])) {
      renderCreditCardPage(month, ccState.recordsByMonth[month]);
      return;
    }
    var cachedRecent = LocalCache.getRecent(month);
    if (cachedRecent && Array.isArray(cachedRecent.fullExpenses)) {
      ccState.recordsByMonth[month] = cachedRecent.fullExpenses;
      renderCreditCardPage(month, cachedRecent.fullExpenses);
      return;
    }
  }

  if (!Array.isArray(ccState.recordsByMonth[month])) {
    container.innerHTML =
      '<div class="overview-skeleton">' +
        '<div class="skel-block skel-hero"></div>' +
        '<div class="skel-block skel-row"></div>' +
        '<div class="skel-block skel-row"></div>' +
      '</div>';
  }
  setLoading(true);

  Api.server
    .withSuccessHandler(function(res) {
      setLoading(false);
      var records = (res && res.records) || (res && res.expenses) || [];
      ccState.recordsByMonth[month] = records;
      var hadSkeleton = Boolean(container.querySelector('.overview-skeleton'));
      renderCreditCardPage(month, records);
      if (hadSkeleton) Motion.revealCards(container);
      if (forceRefresh) {
        showToast('已重新讀取 ' + month + ' 信用卡消費明細', 'success');
      }
    })
    .withFailureHandler(function(err) {
      setLoading(false);
      showServerError(err);
    })
    .getFullRecords(month, 'expense', Boolean(forceRefresh));
}

function renderCreditCardPage(month, allExpenseRecords) {
  var container = document.getElementById('creditCardContent');
  if (!container) return;

  var paymentOptions = (state.data && state.data.options && state.data.options.paymentMethods) || DEFAULT_OPTIONS_FALLBACK.paymentMethods;
  var summary = CreditCardParser.collectCardsSummary(allExpenseRecords || [], paymentOptions);

  if (ccState.selectedCard !== 'ALL' && !summary.cardMap.has(ccState.selectedCard)) {
    ccState.selectedCard = 'ALL';
  }

  var activeScope = (ccState.selectedCard === 'ALL')
    ? summary.all
    : (summary.cardMap.get(ccState.selectedCard) || summary.all);

  var activeCardTitle = (ccState.selectedCard === 'ALL') ? '全部信用卡' : activeScope.cardName;

  var filteredRecords = (activeScope.records || []).filter(function(r) {
    if (ccState.statusFilter === 'unpaid') return !r.isPaid;
    if (ccState.statusFilter === 'paid') return r.isPaid;
    return true;
  });

  var html = '';

  html += '<div class="cc-card-tabs" role="tablist" aria-label="選擇信用卡別">';
  var isAllActive = (ccState.selectedCard === 'ALL');
  html += '<button type="button" class="cc-card-tab' + (isAllActive ? ' active' : '') + '" data-card="ALL">' +
            (summary.all.count > 0 ? '<span class="cc-tab-dot' + (summary.all.unpaidCount > 0 ? ' has-unpaid' : '') + '"></span>' : '') +
            '<span>全部信用卡</span>' +
          '</button>';

  summary.cards.forEach(function(c) {
    var isActive = (ccState.selectedCard === c.cardName);
    var thumbHtml = c.imageSrc
      ? '<img class="cc-tab-card-img" src="' + escAttr(c.imageSrc) + '" alt="">'
      : '';
    var dotHtml = (c.count > 0)
      ? '<span class="cc-tab-dot' + (c.unpaidCount > 0 ? ' has-unpaid' : '') + '"></span>'
      : '';
    html += '<button type="button" class="cc-card-tab' + (isActive ? ' active' : '') + '" data-card="' + escAttr(c.cardName) + '">' +
              dotHtml +
              thumbHtml +
              '<span>' + escHtml(c.cardName) + '</span>' +
            '</button>';
  });
  html += '</div>';

  html += '<div class="cc-summary-bar">' +
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
          '</div>';

  html += '<div class="cc-toolbar">' +
            '<div class="cc-status-filters" role="tablist" aria-label="繳費狀態篩選">' +
              '<button type="button" class="cc-filter-btn' + (ccState.statusFilter === 'all' ? ' active' : '') + '" data-sfilter="all">全部 (' + activeScope.count + ')</button>' +
              '<button type="button" class="cc-filter-btn' + (ccState.statusFilter === 'unpaid' ? ' active' : '') + '" data-sfilter="unpaid">未繳 (' + activeScope.unpaidCount + ')</button>' +
              '<button type="button" class="cc-filter-btn' + (ccState.statusFilter === 'paid' ? ' active' : '') + '" data-sfilter="paid">已繳 (' + activeScope.paidCount + ')</button>' +
            '</div>';

  if (activeScope.unpaidCount > 0) {
    html += '<button type="button" id="ccBatchMarkPaidBtn" class="cc-batch-paid-btn"' + (ccState.batchBusy ? ' disabled' : '') + '>' +
              (ccState.batchBusy ? '' : iconHtml('check')) + '<span>' + (ccState.batchBusy ? '更新中…' : '全部標為已繳') + '</span>' +
            '</button>';
  }
  html += '</div>';

  html += '<div class="ov-card cc-tx-card">';

  if (!filteredRecords.length) {
    var emptyMsg = activeScope.count === 0
      ? '本月尚無此信用卡的消費紀錄。'
      : (ccState.statusFilter === 'unpaid' ? '目前沒有未繳帳單。' : '沒有符合的消費明細。');
    html += '<div class="empty" style="padding:28px 12px;">' + escHtml(emptyMsg) + '</div>';
  } else {
    html += '<div class="cc-tx-list">';

    filteredRecords.forEach(function(rec) {
      var parsedDay = parseInt(rec.day, 10);
      var dayText = !isNaN(parsedDay) ? (parsedDay + '日') : (rec.day ? (rec.day + '日') : '未填');
      var itemDisplayHtml = rec.item ? itemIconLabelHtml(rec.item) : '未填';
      var isPaid = rec.isPaid;
      var isRowBusy = Boolean(ccState.busyRows[rec.row]);
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

      html += '<div class="cc-tx-item' + (isPaid ? ' is-paid' : '') + '" data-row="' + rec.row + '">' +
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
                  '<button type="button" class="cc-paid-btn' + (isPaid ? ' already-paid' : '') + '" data-row="' + rec.row + '" data-paid="' + (isPaid ? 'O' : 'X') + '"' + (isRowBusy ? ' disabled' : '') + ' title="' + (isPaid ? '點擊取消已繳費狀態' : '點擊標記為已繳費') + '" aria-label="' + (isPaid ? '已繳費，點擊取消' : '未繳費，點擊標記已繳') + '">' +
                    '<span class="uv-btn-sign" aria-hidden="true">' +
                      (isRowBusy
                        ? '<svg viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="2.5" stroke-dasharray="28" stroke-dashoffset="10" stroke-linecap="round"/></svg>'
                        : '<svg viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>') +
                    '</span>' +
                    '<span class="uv-btn-text">已繳費</span>' +
                  '</button>' +
                '</div>' +
              '</div>';
    });

    html += '</div>';
  }

  html += '</div>';

  container.innerHTML = html;

  container.querySelectorAll('.cc-card-tab').forEach(function(tabBtn) {
    tabBtn.addEventListener('click', function() {
      ccState.selectedCard = tabBtn.dataset.card || 'ALL';
      renderCreditCardPage(month, ccState.recordsByMonth[month] || []);
    });
  });

  container.querySelectorAll('.cc-filter-btn').forEach(function(filterBtn) {
    filterBtn.addEventListener('click', function() {
      ccState.statusFilter = filterBtn.dataset.sfilter || 'all';
      renderCreditCardPage(month, ccState.recordsByMonth[month] || []);
    });
  });

  container.querySelectorAll('.cc-paid-btn').forEach(function(paidBtn) {
    paidBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      var rowNum = Number(paidBtn.dataset.row);
      var currentPaid = paidBtn.dataset.paid;
      var nextPaid = (currentPaid === 'O') ? 'X' : 'O';
      toggleSingleCreditCardPaid(month, rowNum, nextPaid);
    });
  });

  var batchBtn = document.getElementById('ccBatchMarkPaidBtn');
  if (batchBtn) {
    batchBtn.addEventListener('click', function() {
      var unpaidRows = (activeScope.records || [])
        .filter(function(r) { return !r.isPaid; })
        .map(function(r) { return r.row; });
      if (!unpaidRows.length) return;
      if (!confirm('確定要將「' + activeCardTitle + '」的 ' + unpaidRows.length + ' 筆未繳明細，全數標記為【已繳費】嗎？')) {
        return;
      }
      batchMarkUnpaidRecords(month, unpaidRows);
    });
  }
}

// 組出「11/15的午餐共120元」這種描述，讓 toast 指出是哪一筆消費
// month 格式為「2026.11」
function describeCreditCardRecord(month, rec) {
  if (!rec) return '這筆消費';
  var monthNum = parseInt(String(month || '').split(/\D+/)[1], 10);
  var parsedDay = parseInt(rec.day, 10);
  var dayPart = !isNaN(parsedDay) ? String(parsedDay) : (rec.day ? String(rec.day).trim() : '');
  var dayText = !dayPart
    ? '未填日期'
    : (!isNaN(monthNum) ? (monthNum + '/' + dayPart) : (dayPart + '日'));
  var itemText = rec.item ? String(rec.item).trim() : '未填項目';
  var amountText = ovFmt(Math.abs(FinanceUtils.parse(rec.amount)));
  return dayText + '的' + itemText + '共' + amountText + '元';
}

function toggleSingleCreditCardPaid(month, rowNum, targetPaid) {
  if (!month || !rowNum || ccState.busyRows[rowNum]) return;

  state.mutationVersion++;
  ccState.busyRows[rowNum] = true;

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
  renderCreditCardPage(month, monthRecords);

  Api.server
    .withSuccessHandler(function(res) {
      delete ccState.busyRows[rowNum];
      if (res && res.recent) {
        LocalCache.saveRecent(month, res.recent);
        if (Array.isArray(res.recent.fullExpenses)) {
          ccState.recordsByMonth[month] = res.recent.fullExpenses;
        }
        if (month === getMonth()) {
          renderRecent(res.recent);
        }
      }
      LocalCache.invalidateOverview(month);
      LocalCache.saveSettlement(null);
      if (typeof window.__invalidateOverviewFlag === 'function') {
        window.__invalidateOverviewFlag();
      }
      renderCreditCardPage(month, ccState.recordsByMonth[month] || monthRecords);
      showToast(toastDesc + '，' + (targetPaid === 'O' ? '已繳費' : '未繳費'), 'success');
    })
    .withFailureHandler(function(err) {
      delete ccState.busyRows[rowNum];
      monthRecords.forEach(function(r) {
        if (Number(r.row) === Number(rowNum)) {
          r.paid = prevPaid;
        }
      });
      renderCreditCardPage(month, monthRecords);
      showServerError(err);
    })
    .markCreditCardPaid({ month: month, row: rowNum, paid: targetPaid });
}

function batchMarkUnpaidRecords(month, rows) {
  if (!month || !rows || !rows.length || ccState.batchBusy) return;

  state.mutationVersion++;
  ccState.batchBusy = true;

  var monthRecords = ccState.recordsByMonth[month] || [];
  var rowSet = new Set(rows.map(Number));
  monthRecords.forEach(function(r) {
    if (rowSet.has(Number(r.row))) {
      r.paid = 'O';
    }
  });
  renderCreditCardPage(month, monthRecords);

  Api.server
    .withSuccessHandler(function(res) {
      ccState.batchBusy = false;
      if (res && res.recent) {
        LocalCache.saveRecent(month, res.recent);
        if (Array.isArray(res.recent.fullExpenses)) {
          ccState.recordsByMonth[month] = res.recent.fullExpenses;
        }
        if (month === getMonth()) {
          renderRecent(res.recent);
        }
      }
      LocalCache.invalidateOverview(month);
      LocalCache.saveSettlement(null);
      if (typeof window.__invalidateOverviewFlag === 'function') {
        window.__invalidateOverviewFlag();
      }
      renderCreditCardPage(month, ccState.recordsByMonth[month] || monthRecords);
      showToast('已成功將 ' + rows.length + ' 筆信用卡消費標記為【已繳費 (O)】！', 'success');
    })
    .withFailureHandler(function(err) {
      ccState.batchBusy = false;
      loadCreditCardMonth(month, true);
      showServerError(err);
    })
    .batchMarkCreditCardPaid({ month: month, rows: rows, paid: 'O' });
}
