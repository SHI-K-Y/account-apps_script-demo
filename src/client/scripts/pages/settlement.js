var settlementRefreshBtn = document.getElementById('settlementRefreshBtn');
if (settlementRefreshBtn) {
  settlementRefreshBtn.addEventListener('click', function() {
    var dateInput = document.getElementById('stDateInput');
    var curDate = (dateInput && dateInput.value) ? dateInput.value : null;
    loadSettlement(true, curDate);
  });
}

function getAutoAdjustItemName(isDeficit) {
  var opt = (state.data && state.data.options) ? state.data.options : DEFAULT_OPTIONS_FALLBACK;
  if (isDeficit) {
    var expItems = opt.expenseItems || [];
    if (expItems.includes('結帳短缺')) return '結帳短缺';
    if (expItems.includes('對帳短缺')) return '對帳短缺';
    if (expItems.includes('其他')) return '其他';
    return expItems[0] || '結帳短缺';
  } else {
    var incItems = opt.incomeItems || [];
    if (incItems.includes('對帳溢餘')) return '對帳溢餘';
    if (incItems.includes('結帳溢餘')) return '結帳溢餘';
    if (incItems.includes('其他')) return '其他';
    return incItems[0] || '對帳溢餘';
  }
}

function loadSettlement(forceRefresh, customDate) {
  var container = document.getElementById('settlementContent');
  if (!container) return;

  var cachedSt = !forceRefresh ? LocalCache.getSettlement() : null;
  var prerendered = Boolean(cachedSt) && settlementPrerenderSig !== '' && settlementPrerenderSig === JSON.stringify(cachedSt);
  settlementPrerenderSig = '';
  // 重新讀取時畫面上已經有資料：照樣留著，不換成骨架（P12）
  var showing = !cachedSt && Boolean(container.querySelector('.st-date-section'));
  if (cachedSt) {
    // 開機時已經用同一份快取畫好（prerenderSettlement）就不重建
    if (!prerendered) renderSettlement(cachedSt);
  } else if (!showing) {
    container.innerHTML =
      '<div class="overview-skeleton">' +
        '<div class="skel-block skel-hero"></div>' +
        '<div class="skel-block skel-row"></div>' +
        '<div class="skel-block skel-row"></div>' +
      '</div>';
    setLoading(true);
  }

  var dateInput = document.getElementById('stDateInput');
  var targetDate = customDate || (dateInput && dateInput.value) || getClientToday().todayISO;
  // 已經畫了快取（P12）：標題旁顯示「更新中」，不遮畫面
  var syncDone = (cachedSt || showing) ? SyncStatus.begin('settlement') : function() {};

  Api.server
    .withSuccessHandler(function(data) {
      syncDone();
      setLoading(false);
      settlementLoaded = true;
      LocalCache.saveSettlement(data);
      var hadSkeleton = Boolean(container.querySelector('.overview-skeleton'));
      if (hadSkeleton || !cachedSt || JSON.stringify(cachedSt) !== JSON.stringify(data)) renderSettlement(data);
      if (hadSkeleton) Motion.revealCards(container);
      if (forceRefresh) {
        showToast('對帳資料已重新讀取', 'success');
      }
    })
    .withFailureHandler(function(err) {
      syncDone();
      setLoading(false);
      if (!cachedSt && !showing) {
        container.innerHTML =
          '<div style="text-align:center;padding:40px 14px;color:var(--muted);">' +
            '<p style="font-size:15px;font-weight:700;">載入失敗</p>' +
            '<p style="font-size:13px;">' + escHtml(err && err.message ? err.message : '發生未知錯誤') + '</p>' +
          '</div>';
      }
    })
    .getSettlementData(targetDate);
}

// 開機第三段（閒置時，app/bootstrap.js）用 LocalCache 先把對帳頁畫進隱藏的頁面容器（P08），
// 第一次切到對帳頁時就不用在切頁當下重建（見 loadSettlement）。
var settlementPrerenderSig = '';
function prerenderSettlement() {
  var container = document.getElementById('settlementContent');
  var cached = LocalCache.getSettlement();
  if (!container || !cached || settlementLoaded || settlementPrerenderSig) return false;
  renderSettlement(cached);
  settlementPrerenderSig = JSON.stringify(cached);
  return true;
}

function renderSettlement(d) {
  var container = document.getElementById('settlementContent');
  if (!container || !d) return;
  settlementPrerenderSig = '';

  var html = '';

  var now = new Date();
  var todayStr = now.getFullYear() + '/' + (now.getMonth() + 1) + '/' + now.getDate();
  html += '<div class="overview-month-badge">' +
            '對帳系統，更新時間 ' + escHtml(todayStr) +
          '</div>';

  var clientToday = getClientToday();
  var dateVal = d.settlementDate ? formatDateForInput(d.settlementDate) : clientToday.todayISO;
  html += '<div class="st-date-section">' +
            '<div class="st-date-card ov-card">' +
              '<div class="st-date-head">' +
                '<div class="st-date-icon" aria-hidden="true">' + iconHtml('calendar-blank') + '</div>' +
                '<span class="st-date-title">對帳日期</span>' +
              '</div>' +
              '<div class="date-row">' +
                '<div class="date-picker-wrap">' +
                  '<input type="date" id="stDateInput" class="text-input date-input" value="' + escAttr(dateVal) + '">' +
                  '<button class="date-cal-btn" type="button" id="stCalBtn" title="選擇日期" aria-label="選擇日期">' +
                    '' + iconHtml('calendar-blank', 'regular', 'ic-20') + '' +
                  '</button>' +
                  '<div id="stCalendar" class="calendar-popover" role="dialog" aria-label="對帳日曆選擇器" hidden></div>' +
                '</div>' +
                '<div class="date-quick-btns">' +
                  '<button class="choice" type="button" id="stTodayBtn">今天</button>' +
                '</div>' +
              '</div>' +
            '</div>' +
          '</div>';

  html += '<div class="st-balances-group">';

  var ledger = d.ledger || {};
  var ledgerTotal = ovParseNum(ledger.total);

  html += '<div class="st-balance-col">';
  html += '<h3 class="ov-section-title"><span class="ov-icon-box is-ledger" aria-hidden="true">' + iconHtml('notebook') + '</span>記帳簿餘額</h3>';
  html += '<div class="ov-cards">';
  html += '<div class="ov-card">';
  html += '<div class="st-ledger-grid" id="stLedgerGrid">';
  html += buildStLedgerItem('shopping-cart', '生活費餘額', ledger.livingBalance, false, 'stLivingBalance');
  html += buildStLedgerItem('bank', '存款餘額', ledger.savingsBalance, false, 'stSavingsBalance');
  html += buildStLedgerItem('handshake', '代收代付餘額', ledger.agencyBalance, false, 'stAgencyBalance');
  html += buildStLedgerItem('credit-card', '累計信用卡未繳', ledger.creditCardUnpaid, true, 'stCreditCardUnpaid');
  html += '</div>';
  html += '<div class="st-total-bar" id="stLedgerTotalBar">';
  html += '<span class="st-total-label">帳簿總餘額</span>';
  html += '<span class="st-total-val" id="stLedgerTotal">' + ovFmt(ledgerTotal) + '</span>';
  html += '</div>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  var actual = d.actual || {};
  var labels = d.actualLabels || {};
  var actualTotal = ovParseNum(actual.total);

  html += '<div class="st-balance-col">';
  html += '<h3 class="ov-section-title"><span class="ov-icon-box is-actual" aria-hidden="true">' + iconHtml('coins') + '</span>實際餘額</h3>';
  html += '<div class="ov-cards">';
  html += '<div class="ov-card">';
  html += '<div class="st-actual-grid">';

  var actualFields = [
    { key: 'cash', icon: 'money' },
    { key: 'bankShanlan', icon: 'bank' },
    { key: 'bankBeichen', icon: 'bank' },
    { key: 'bankAurora', icon: 'bank' },
    { key: 'bankHaiyue', icon: 'bank' },
    { key: 'bankYunshan', icon: 'bank' },
    { key: 'bankQinghe', icon: 'bank' },
  ];

  actualFields.forEach(function(f) {
    var label = labels[f.key] || f.key;
    var val = actual[f.key] || '0';
    html += '<div class="st-actual-item">' +
              '<div class="st-actual-label">' +
                '<span class="st-actual-icon" aria-hidden="true">' + iconHtml(f.icon) + '</span>' +
                '<span>' + escHtml(label) + '</span>' +
              '</div>' +
              '<div class="st-actual-input-wrap">' +
                '<span class="st-actual-prefix">$</span>' +
                '<input type="number" class="st-actual-input" data-field="' + escAttr(f.key) + '" value="' + ovParseNum(val) + '" placeholder="0" step="1">' +
              '</div>' +
            '</div>';
  });

  html += '</div>';
  html += '<div class="st-total-bar actual">';
  html += '<span class="st-total-label">實際總餘額</span>';
  html += '<span class="st-total-val" id="stActualTotal">' + (actualTotal < 0 ? '-' : '') + ovFmt(actualTotal) + '</span>';
  html += '</div>';
  html += '</div>';
  html += '</div>';
  html += '</div>';

  html += '</div>';

  var diff = ovParseNum(d.difference);
  var diffStatus = diff > 0 ? 'surplus' : (diff < 0 ? 'deficit' : 'match');
  var diffLabel = diff > 0 ? '溢餘' : (diff < 0 ? '短缺' : '帳目一致');
  var diffIcon = diff === 0 ? 'check-circle' : (diff > 0 ? 'chart-line-up' : 'chart-line-down');

  html += '<div class="st-diff-section" id="stDiffSection">';
  html += '<div class="st-diff-card ' + diffStatus + '">';
  html += '<div class="st-diff-head">';
  html += '<span class="st-diff-icon" aria-hidden="true">' + iconHtml(diffIcon) + '</span>';
  html += '<span class="st-diff-title">差額（實際 - 帳簿）</span>';
  html += '<span class="st-diff-badge ' + diffStatus + '">' + diffLabel + '</span>';
  html += '</div>';
  html += '<div class="st-diff-amount ' + diffStatus + '">' + (diff > 0 ? '+' : '') + ovFmt(diff) + '</div>';
  html += '<div class="st-diff-hint">＋為溢餘、－為短缺、0為帳目一致</div>';
  html += '</div>';

  var isDeficit = (diff < 0);
  var adjustActionText = getAutoAdjustItemName(isDeficit);
  var adjustTypeLabel = isDeficit ? '支出' : '收入';
  var adjustAmtStr = ovFmt(Math.abs(diff));
  html += '<div class="st-balance-adjust-wrap" id="stBalanceAdjustWrap"' + (diff === 0 ? ' style="display:none;"' : '') + '>';
  html += '<button id="stAutoAdjustBtn" class="st-adjust-btn" type="button" data-diff="' + diff + '">';
  html += '<span class="st-adjust-icon" aria-hidden="true">' + iconHtml('lightning') + '</span>';
  html += '<span id="stAdjustBtnText" class="st-adjust-text">一鍵寫入平帳紀錄（' + adjustTypeLabel + '「' + escHtml(adjustActionText) + '」 $' + adjustAmtStr + '）</span>';
  html += '</button>';
  html += '</div>';

  html += '</div>';

  html += '<div class="st-actions">';
  html += '<button id="stSubmitBtn" class="st-submit-btn" type="button">';
  html += '' + iconHtml('floppy-disk', 'regular', 'ic-16') + '';
  html += ' 儲存對帳';
  html += '</button>';
  html += '<button id="stClearBtn" class="st-clear-btn" type="button">';
  html += '' + iconHtml('trash', 'regular', 'ic-14') + '';
  html += ' 清空輸入區';
  html += '</button>';
  html += '</div>';

  html += '<div class="st-instructions">';
  html += '<div class="ov-card">';
  html += '<div class="st-date-head" style="margin-bottom:10px">';
  html += '<div class="st-date-icon" aria-hidden="true">' + iconHtml('note-pencil') + '</div>';
  html += '<span class="st-date-title">對帳使用說明</span>';
  html += '</div>';
  html += '<ol class="st-steps">';
  html += '<li>選擇對帳基準日期（系統將自動更新該月份之記帳簿餘額）</li>';
  html += '<li>分別輸入各帳戶目前現實清點餘額</li>';
  html += '<li>檢查差額是否為 0（帳目一致）</li>';
  html += '<li>確認無誤後點擊「儲存對帳」寫入試算表</li>';
  html += '<li>對帳完成後，可點擊「清空輸入區」重置</li>';
  html += '</ol>';
  html += '</div>';
  html += '</div>';

  container.innerHTML = html;

  bindSettlementEvents(d);
}

function initStCalendarPicker() {
  bindCalendarPickerEvents({
    inputId: 'stDateInput',
    btnId: 'stCalBtn',
    calId: 'stCalendar',
    onToggle: toggleStCalendar,
    onInputChange: function() {
      var input = document.getElementById('stDateInput');
      if (input && input.value) {
        handleSettlementDateChange(input.value);
      }
      var calEl = document.getElementById('stCalendar');
      if (calEl && !calEl.hidden) {
        renderStCalendar();
      }
    }
  });
}

function toggleStCalendar() {
  var calEl = document.getElementById('stCalendar');
  if (!calEl) return;
  closeCalendar('expense');
  closeCalendar('income');

  if (calEl.hidden) {
    var input = document.getElementById('stDateInput');
    var val = input ? input.value : '';
    if (val && val.includes('-')) {
      var p = val.split('-').map(Number);
      stCalState.year = p[0];
      stCalState.month = p[1];
    } else {
      var clientToday = getClientToday();
      var tp = clientToday.todayISO.split('-').map(Number);
      stCalState.year = tp[0];
      stCalState.month = tp[1];
    }
    renderStCalendar();
    calEl.hidden = false;
  } else {
    calEl.hidden = true;
  }
}

function closeStCalendar() {
  var calEl = document.getElementById('stCalendar');
  if (calEl) calEl.hidden = true;
}

function renderStCalendar() {
  var calEl = document.getElementById('stCalendar');
  var input = document.getElementById('stDateInput');
  if (!calEl || !input) return;

  var currentVal = input.value || '';
  var clientToday = getClientToday();

  var year = stCalState.year;
  var monthNum = stCalState.month;

  var currentDayNum = currentVal.startsWith(year + '-' + pad(monthNum) + '-')
    ? Number(currentVal.split('-')[2])
    : null;

  calEl.innerHTML = '';

  var header = document.createElement('div');
  header.className = 'cal-header';

  var navBox = document.createElement('div');
  navBox.className = 'cal-title-box';
  navBox.style.gap = '6px';

  var prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'cal-nav-btn';
  prevBtn.innerHTML = iconHtml('caret-left');
  prevBtn.title = '上個月';
  prevBtn.setAttribute('aria-label', '上個月');
  prevBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    stCalState.month--;
    if (stCalState.month < 1) {
      stCalState.month = 12;
      stCalState.year--;
    }
    renderStCalendar();
  });
  navBox.appendChild(prevBtn);

  var title = document.createElement('span');
  title.className = 'cal-title';
  title.textContent = year + ' 年 ' + monthNum + ' 月';
  navBox.appendChild(title);

  var nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'cal-nav-btn';
  nextBtn.innerHTML = iconHtml('caret-right');
  nextBtn.title = '下個月';
  nextBtn.setAttribute('aria-label', '下個月');
  nextBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    stCalState.month++;
    if (stCalState.month > 12) {
      stCalState.month = 1;
      stCalState.year++;
    }
    renderStCalendar();
  });
  navBox.appendChild(nextBtn);

  var thisMonthISO = year + '.' + pad(monthNum);
  if (thisMonthISO === clientToday.currentMonth) {
    var badge = document.createElement('span');
    badge.className = 'cal-badge';
    badge.textContent = '本月';
    navBox.appendChild(badge);
  }

  var closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'cal-close-btn';
  closeBtn.innerHTML = iconHtml('x');
  closeBtn.setAttribute('aria-label', '關閉日曆');
  closeBtn.addEventListener('click', function(e) {
    e.stopPropagation();
    closeStCalendar();
  });

  header.appendChild(navBox);
  header.appendChild(closeBtn);
  calEl.appendChild(header);

  calEl.appendChild(buildCalendarGrid({
    year: year,
    monthNum: monthNum,
    currentDayNum: currentDayNum,
    todayISO: clientToday.todayISO,
    onSelectDay: function(dNum) {
      selectStCalendarDay(year, monthNum, dNum);
    }
  }));

  var footer = document.createElement('div');
  footer.className = 'cal-footer';
  footer.style.justifyContent = 'space-between';

  var hint = document.createElement('span');
  hint.style.color = 'var(--muted)';
  hint.style.fontSize = '11px';
  hint.textContent = '對帳基準日';

  var info = document.createElement('span');
  info.className = 'cal-selected-info';
  info.textContent = currentDayNum ? ('已選 ' + monthNum + '月' + currentDayNum + '日') : '';

  footer.appendChild(hint);
  footer.appendChild(info);
  calEl.appendChild(footer);
}

function selectStCalendarDay(year, monthNum, day) {
  var formattedDate = year + '-' + pad(monthNum) + '-' + pad(day);
  var input = document.getElementById('stDateInput');
  if (input) {
    input.value = formattedDate;
  }
  closeStCalendar();
  handleSettlementDateChange(formattedDate);
}

function setStLedgerLoading(isLoading) {
  var grid = document.getElementById('stLedgerGrid');
  var bar = document.getElementById('stLedgerTotalBar');
  var diff = document.getElementById('stDiffSection');
  if (grid) grid.classList.toggle('loading', isLoading);
  if (bar) bar.classList.toggle('loading', isLoading);
  if (diff) diff.classList.toggle('loading', isLoading);
}

function handleSettlementDateChange(dateStr) {
  if (!dateStr) return;

  var input = document.getElementById('stDateInput');
  if (input && input.value !== dateStr) {
    input.value = dateStr;
  }

  setStLedgerLoading(true);

  Api.server
    .withSuccessHandler(function(data) {
      setStLedgerLoading(false);
      if (!data) return;
      LocalCache.saveSettlement(data);
      if (data.settlementDate) {
        var formatted = formatDateForInput(data.settlementDate);
        if (input && formatted && input.value !== formatted) {
          input.value = formatted;
        }
      }
      updateSettlementLedgerDisplay(data);
      showToast('已更新 ' + (input ? input.value : dateStr) + ' 記帳簿餘額', 'success');
    })
    .withFailureHandler(function(err) {
      setStLedgerLoading(false);
      showToast(err && err.message ? err.message : '更新記帳簿餘額失敗', 'error');
    })
    .updateSettlementDate(dateStr);
}

function updateSettlementLedgerDisplay(data, preservedActuals) {
  if (!data || !data.ledger) return;

  var ledger = data.ledger;
  var livingEl = document.getElementById('stLivingBalance');
  if (livingEl) livingEl.textContent = '$' + ovFmt(ovParseNum(ledger.livingBalance));

  var savingsEl = document.getElementById('stSavingsBalance');
  if (savingsEl) savingsEl.textContent = '$' + ovFmt(ovParseNum(ledger.savingsBalance));

  var agencyEl = document.getElementById('stAgencyBalance');
  if (agencyEl) agencyEl.textContent = '$' + ovFmt(ovParseNum(ledger.agencyBalance));

  var creditEl = document.getElementById('stCreditCardUnpaid');
  if (creditEl) {
    var cNum = ovParseNum(ledger.creditCardUnpaid);
    creditEl.textContent = '$' + ovFmt(cNum);
    creditEl.className = 'st-ledger-val' + (cNum > 0 ? ' warn' : '');
  }

  var ledgerTotalEl = document.getElementById('stLedgerTotal');
  var ledgerTotal = ovParseNum(ledger.total);
  if (ledgerTotalEl) ledgerTotalEl.textContent = ovFmt(ledgerTotal);

  var inputs = document.querySelectorAll('.st-actual-input');
  if (preservedActuals) {
    inputs.forEach(function(inp) {
      var key = inp.dataset.field;
      if (key && preservedActuals[key] !== undefined) {
        inp.value = preservedActuals[key];
      }
    });
  } else if (data.actual) {
    var actual = data.actual;
    inputs.forEach(function(inp) {
      var key = inp.dataset.field;
      if (key && actual[key] !== undefined && actual[key] !== null) {
        var backendVal = ovParseNum(actual[key]);
        if (backendVal > 0 || inp.value === '' || inp.value === '0') {
          inp.value = backendVal;
        }
      }
    });
  }

  updateActualTotal(ledgerTotal);
}

function refreshSettlementAfterAdjust(dateStr, preservedActuals) {
  setStLedgerLoading(true);

  Api.server
    .withSuccessHandler(function(data) {
      setStLedgerLoading(false);
      var adjustBtn = document.getElementById('stAutoAdjustBtn');
      if (adjustBtn) {
        adjustBtn.disabled = false;
        adjustBtn.innerHTML = '<span class="st-adjust-icon" aria-hidden="true">' + iconHtml('lightning') + '</span><span class="st-adjust-text" id="stAdjustBtnText">一鍵寫入平帳紀錄</span>';
      }
      if (!data) return;
      if (preservedActuals && data.actual) {
        for (var k in preservedActuals) {
          if (Object.prototype.hasOwnProperty.call(preservedActuals, k)) {
            data.actual[k] = preservedActuals[k];
          }
        }
      }
      Prefetch.afterMutation();
      LocalCache.saveSettlement(data);
      settlementLoaded = true;
      updateSettlementLedgerDisplay(data, preservedActuals);
    })
    .withFailureHandler(function(err) {
      setStLedgerLoading(false);
      var adjustBtn = document.getElementById('stAutoAdjustBtn');
      if (adjustBtn) {
        adjustBtn.disabled = false;
        adjustBtn.innerHTML = '<span class="st-adjust-icon" aria-hidden="true">' + iconHtml('lightning') + '</span><span class="st-adjust-text" id="stAdjustBtnText">一鍵寫入平帳紀錄（重試）</span>';
      }
      showToast(err && err.message ? err.message : '刷新記帳簿餘額失敗', 'error');
    })
    .updateSettlementDate(dateStr);
}

function bindSettlementEvents(data) {
  initStCalendarPicker();

  var todayBtn = document.getElementById('stTodayBtn');
  if (todayBtn) {
    todayBtn.addEventListener('click', function() {
      var today = getClientToday().todayISO;
      var input = document.getElementById('stDateInput');
      if (input) {
        input.value = today;
      }
      closeStCalendar();
      handleSettlementDateChange(today);
    });
  }

  stDomCache.refresh();

  stDomCache.inputs.forEach(function(inp) {
    inp.addEventListener('input', function() {
      updateActualTotal();
    });
  });

  var submitBtn = document.getElementById('stSubmitBtn');
  if (submitBtn) {
    submitBtn.addEventListener('click', function() {
      submitSettlement();
    });
  }

  var clearBtn = document.getElementById('stClearBtn');
  if (clearBtn) {
    clearBtn.addEventListener('click', function() {
      clearSettlement();
    });
  }

  var autoAdjustBtn = document.getElementById('stAutoAdjustBtn');
  if (autoAdjustBtn) {
    autoAdjustBtn.addEventListener('click', function() {
      var currentDiff = parseFloat(autoAdjustBtn.dataset.diff);
      if (!Number.isFinite(currentDiff) || currentDiff === 0) return;

      var dateInput = document.getElementById('stDateInput');
      var dateVal = (dateInput && dateInput.value) ? dateInput.value : getClientToday().todayISO;
      var p = dateVal.split(/[-/.]/);
      if (p.length < 3) {
        showToast('無法取得正確對帳日期', 'error');
        return;
      }

      var targetMonth = p[0] + '.' + pad(parseInt(p[1], 10));
      var targetDay = parseInt(p[2], 10);
      var absAmt = Math.abs(currentDiff);
      var isDeficit = (currentDiff < 0);

      var opt = (state.data && state.data.options) ? state.data.options : DEFAULT_OPTIONS_FALLBACK;

      var expenseCat = (opt.expenseCategories && opt.expenseCategories.includes('生活費'))
        ? '生活費'
        : (opt.expenseCategories ? opt.expenseCategories[0] : '生活費');
      var incomeCat = (opt.incomeCategories && opt.incomeCategories.includes('生活費'))
        ? '生活費'
        : (opt.incomeCategories ? opt.incomeCategories[0] : '生活費');

      var paymentMethod = (opt.paymentMethods && opt.paymentMethods.includes('現金'))
        ? '現金'
        : (opt.paymentMethods ? opt.paymentMethods[0] : '現金');

      var targetItem = getAutoAdjustItemName(isDeficit);
      var typeName = isDeficit ? '支出' : '收入';

      var confirmMsg = '確定要一鍵寫入平帳紀錄嗎？\n\n' +
        '• 工作表：' + targetMonth + '\n' +
        '• 日期：' + targetDay + ' 日\n' +
        '• 類型：' + typeName + '「' + targetItem + '」\n' +
        '• 金額：$' + ovFmt(absAmt) + '\n\n' +
        '寫入完成後系統將自動刷新記帳與對帳資料。';

      if (!confirm(confirmMsg)) return;

      var preservedActuals = {};
      var actInputs = document.querySelectorAll('.st-actual-input');
      actInputs.forEach(function(inp) {
        var key = inp.dataset.field;
        if (key) {
          preservedActuals[key] = inp.value;
        }
      });

      state.mutationVersion++;

      autoAdjustBtn.disabled = true;
      autoAdjustBtn.innerHTML = '<span class="st-adjust-icon" aria-hidden="true">' + iconHtml('hourglass-medium') + '</span><span class="st-adjust-text">平帳紀錄寫入中…</span>';

      if (isDeficit) {
        var expForm = {
          month: targetMonth,
          day: targetDay,
          item: targetItem,
          category: expenseCat,
          payment: paymentMethod,
          paid: '',
          amount: absAmt,
          note: '對帳平帳調整（' + targetItem + '）'
        };
        Api.server
          .withSuccessHandler(function(res) {
            showToast('平帳支出紀錄已成功寫入！', 'success');
            handleMutationRecentUpdate(res, targetMonth);
            refreshSettlementAfterAdjust(dateVal, preservedActuals);
          })
          .withFailureHandler(function(err) {
            autoAdjustBtn.disabled = false;
            autoAdjustBtn.innerHTML = '<span class="st-adjust-icon" aria-hidden="true">' + iconHtml('lightning') + '</span><span class="st-adjust-text" id="stAdjustBtnText">一鍵寫入平帳紀錄（重試）</span>';
            showToast('寫入平帳紀錄失敗：' + (err.message || err), 'error');
          })
          .addExpense(expForm);
      } else {
        var incForm = {
          month: targetMonth,
          day: targetDay,
          item: targetItem,
          category: incomeCat,
          amount: absAmt,
          note: '對帳平帳調整（' + targetItem + '）'
        };
        Api.server
          .withSuccessHandler(function(res) {
            showToast('平帳收入紀錄已成功寫入！', 'success');
            handleMutationRecentUpdate(res, targetMonth);
            refreshSettlementAfterAdjust(dateVal, preservedActuals);
          })
          .withFailureHandler(function(err) {
            autoAdjustBtn.disabled = false;
            autoAdjustBtn.innerHTML = '<span class="st-adjust-icon" aria-hidden="true">' + iconHtml('lightning') + '</span><span class="st-adjust-text" id="stAdjustBtnText">一鍵寫入平帳紀錄（重試）</span>';
            showToast('寫入平帳紀錄失敗：' + (err.message || err), 'error');
          })
          .addIncome(incForm);
      }
    });
  }

  updateActualTotal();
}

var stDomCache = {
  inputs: [],
  creditEl: null,
  totalEl: null,
  ledgerTotalEl: null,
  diffCard: null,
  diffAmount: null,
  diffBadge: null,
  diffIcon: null,
  refresh: function() {
    this.inputs = document.querySelectorAll('.st-actual-input');
    this.creditEl = document.getElementById('stCreditCardUnpaid');
    this.totalEl = document.getElementById('stActualTotal');
    this.ledgerTotalEl = document.getElementById('stLedgerTotal');
    this.diffCard = document.querySelector('.st-diff-card');
    this.diffAmount = document.querySelector('.st-diff-amount');
    this.diffBadge = document.querySelector('.st-diff-badge');
    this.diffIcon = document.querySelector('.st-diff-icon');
  }
};

function updateActualTotal(customLedgerTotal) {
  if (!stDomCache.totalEl) stDomCache.refresh();
  var assetSum = 0;
  stDomCache.inputs.forEach(function(inp) {
    var v = parseFloat(inp.value);
    if (Number.isFinite(v)) assetSum += v;
  });

  var creditUnpaid = stDomCache.creditEl ? FinanceUtils.parse(stDomCache.creditEl.textContent) : 0;
  var actualTotal = assetSum - creditUnpaid;

  if (stDomCache.totalEl) {
    stDomCache.totalEl.textContent = (actualTotal < 0 ? '-' : '') + FinanceUtils.format(actualTotal);
  }

  var ledgerTotal;
  if (customLedgerTotal !== undefined && Number.isFinite(customLedgerTotal)) {
    ledgerTotal = customLedgerTotal;
  } else {
    ledgerTotal = stDomCache.ledgerTotalEl ? FinanceUtils.parse(stDomCache.ledgerTotalEl.textContent) : 0;
  }

  var diff = actualTotal - ledgerTotal;
  updateDiffDisplay(diff);
}

function updateDiffDisplay(diff) {
  if (!stDomCache.diffCard || !stDomCache.diffAmount) stDomCache.refresh();
  var diffCard = stDomCache.diffCard;
  var diffAmount = stDomCache.diffAmount;
  var diffBadge = stDomCache.diffBadge;
  var diffIcon = stDomCache.diffIcon;
  if (!diffCard || !diffAmount) return;

  var status = diff > 0 ? 'surplus' : (diff < 0 ? 'deficit' : 'match');
  var label = diff > 0 ? '溢餘' : (diff < 0 ? '短缺' : '帳目一致');
  var icon = diff === 0 ? 'check-circle' : (diff > 0 ? 'chart-line-up' : 'chart-line-down');

  diffCard.className = 'st-diff-card ' + status;
  diffAmount.className = 'st-diff-amount ' + status;
  diffAmount.textContent = (diff > 0 ? '+' : (diff < 0 ? '-' : '')) + ovFmt(diff);
  if (diffBadge) {
    diffBadge.className = 'st-diff-badge ' + status;
    diffBadge.textContent = label;
  }
  if (diffIcon) setIcon(diffIcon, icon);

  var adjustWrap = document.getElementById('stBalanceAdjustWrap');
  var adjustBtn = document.getElementById('stAutoAdjustBtn');
  var adjustText = document.getElementById('stAdjustBtnText');
  if (adjustWrap && adjustBtn && adjustText) {
    if (diff !== 0) {
      adjustWrap.style.display = 'block';
      adjustBtn.dataset.diff = String(diff);
      var isDef = (diff < 0);
      var actText = getAutoAdjustItemName(isDef);
      var typeLbl = isDef ? '支出' : '收入';
      adjustText.textContent = '一鍵寫入平帳紀錄（' + typeLbl + '「' + actText + '」 $' + ovFmt(Math.abs(diff)) + '）';
    } else {
      adjustWrap.style.display = 'none';
    }
  }
}

function submitSettlement() {
  var dateInput = document.getElementById('stDateInput');
  if (!dateInput || !dateInput.value) {
    showToast('請先選擇對帳日期', 'error');
    return;
  }

  var form = {
    date: dateInput.value,
  };

  var inputs = document.querySelectorAll('.st-actual-input');
  inputs.forEach(function(inp) {
    form[inp.dataset.field] = inp.value || '0';
  });

  var btn = document.getElementById('stSubmitBtn');
  if (btn) { btn.disabled = true; btn.textContent = '寫入中…'; }
  setLoading(true);

  Api.server
    .withSuccessHandler(function(data) {
      setLoading(false);
      if (btn) { btn.disabled = false; btn.innerHTML = '' + iconHtml('floppy-disk', 'regular', 'ic-16') + ' 儲存對帳'; }
      LocalCache.saveSettlement(data);
      renderSettlement(data);
      showToast('對帳資料已儲存', 'success');
    })
    .withFailureHandler(function(err) {
      setLoading(false);
      if (btn) { btn.disabled = false; btn.innerHTML = '' + iconHtml('floppy-disk', 'regular', 'ic-16') + ' 儲存對帳'; }
      showToast(err && err.message ? err.message : '儲存失敗', 'error');
    })
    .updateSettlementActual(form);
}

function clearSettlement() {
  if (!confirm('確定要清空對帳系統的所有輸入區嗎？')) return;

  var btn = document.getElementById('stClearBtn');
  if (btn) { btn.disabled = true; btn.textContent = '清空中…'; }
  setLoading(true);

  Api.server
    .withSuccessHandler(function(data) {
      setLoading(false);
      if (btn) { btn.disabled = false; btn.innerHTML = '' + iconHtml('trash', 'regular', 'ic-14') + ' 清空輸入區'; }
      LocalCache.saveSettlement(data);
      renderSettlement(data);
      showToast('已清空對帳輸入區', 'success');
    })
    .withFailureHandler(function(err) {
      setLoading(false);
      if (btn) { btn.disabled = false; btn.innerHTML = '' + iconHtml('trash', 'regular', 'ic-14') + ' 清空輸入區'; }
      showToast(err && err.message ? err.message : '清空失敗', 'error');
    })
    .clearSettlementActual();
}

function formatDateForInput(dateStr) {
  if (!dateStr) return '';
  var parts = String(dateStr).trim().split(/[-/.]/);
  if (parts.length >= 3 && parts[0].length === 4) {
    return parts[0] + '-' + parts[1].padStart(2, '0') + '-' + parts[2].substring(0, 2).padStart(2, '0');
  }
  return dateStr;
}

function buildStLedgerItem(icon, label, val, isWarn, id) {
  var num = ovParseNum(val);
  return '<div class="st-ledger-item">' +
           '<div class="st-ledger-label">' +
             '<span class="st-ledger-icon" aria-hidden="true">' + iconHtml(icon) + '</span>' +
             '<span>' + escHtml(label) + '</span>' +
           '</div>' +
           '<span class="st-ledger-val' + (isWarn && num > 0 ? ' warn' : '') + '"' + (id ? ' id="' + escAttr(id) + '"' : '') + '>$' + ovFmt(num) + '</span>' +
         '</div>';
}
