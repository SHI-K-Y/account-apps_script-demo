var overviewRefreshBtn = document.getElementById('overviewRefreshBtn');
if (overviewRefreshBtn) {
  overviewRefreshBtn.addEventListener('click', function() {
    loadOverview(true);
  });
}

// opts.defer（頁面切換時由 router 傳入）：圖表的渲染比較重，交給 PageWork 在轉場動畫開始後再做；
// 卡片本身用 LocalCache 的資料直接畫（圖表區先是骨架）。
function loadOverview(forceRefresh, opts) {
  var container = document.getElementById('overviewContent');
  if (!container) return;
  var defer = opts && typeof opts.defer === 'function' ? opts.defer : null;

  var cachedOv = !forceRefresh ? LocalCache.getOverview() : null;
  var chartsStarted = false;
  var chartsJob = null;
  if (cachedOv) {
    renderOverview(cachedOv);
    if (defer) {
      chartsJob = { cancelled: false };
      var job = chartsJob;
      defer(function() {
        if (job.cancelled) return;
        chartsJob = null;
        OverviewCharts.loadForOverview(cachedOv.month, forceRefresh);
      });
    } else {
      OverviewCharts.loadForOverview(cachedOv.month, forceRefresh);
    }
    chartsStarted = true;
  } else {
    container.innerHTML =
      '<div class="overview-skeleton">' +
        '<div class="skel-block skel-hero"></div>' +
        '<div class="skel-block skel-row"></div>' +
        '<div class="skel-block skel-row"></div>' +
        '<div class="skel-block skel-row"></div>' +
      '</div>';
    setLoading(true);
  }

  Api.server
    .withSuccessHandler(function(data) {
      setLoading(false);
      overviewLoaded = true;
      LocalCache.saveOverview(data);
      var hadSkeleton = Boolean(container.querySelector('.overview-skeleton'));
      renderOverview(data);
      if (hadSkeleton) Motion.revealCards(container);
      if (chartsJob) {
        // 延後的圖表工作還沒輪到：直接用最新的月份載入，原本那件取消
        chartsJob.cancelled = true;
        chartsJob = null;
        if (data) OverviewCharts.loadForOverview(data.month, forceRefresh);
      } else if (data && (!chartsStarted || OverviewCharts.needsReloadFor(data.month))) {
        OverviewCharts.loadForOverview(data.month, forceRefresh);
      }
      if (forceRefresh) {
        showToast('資產總覽已重新讀取', 'success');
      }
    })
    .withFailureHandler(function(err) {
      setLoading(false);
      if (!cachedOv) {
        container.innerHTML =
          '<div style="text-align:center;padding:40px 14px;color:var(--muted);">' +
            '<p style="font-size:15px;font-weight:700;">載入失敗</p>' +
            '<p style="font-size:13px;">' + escHtml(err && err.message ? err.message : '發生未知錯誤') + '</p>' +
          '</div>';
      }
    })
    .getAssetOverview(Boolean(forceRefresh));
}

function renderOverview(d) {
  var container = document.getElementById('overviewContent');
  if (!container || !d) return;

  var html = '';
  var noticeWasOpen = Boolean(container.querySelector('.ov-layout-notice[open]'));

  var now = new Date();
  var todayStr = now.getFullYear() + '/' + (now.getMonth() + 1) + '/' + now.getDate();
  html += '<div class="overview-month-badge">' +
            '資料來源：' + escHtml(d.month) + ' 工作表，更新時間 ' + escHtml(todayStr) +
          '</div>';

  html += buildOverviewLayoutNotice(d.warnings, noticeWasOpen);

  var totalNum = ovParseNum(d.assetTotal);
  var incNum = ovParseNum(d.totalIncome);
  var expNum = ovParseNum(d.totalExpense);
  var balNum = ovParseNum(d.monthBalance);

  html += '<div class="ov-hero">' + UvFx.cardRing +
            '<div class="ov-hero-label">資產總餘額</div>' +
            '<div class="ov-hero-amount">' + ovFmt(totalNum) + '</div>' +
            '<div class="ov-hero-sub">含所有帳戶累計餘額</div>' +
            '<div class="ov-month-summary">' +
              '<div class="ov-mini-card">' +
                '<span class="ov-mini-label">當月總收入</span>' +
                '<span class="ov-mini-val positive">' + ovFmt(incNum) + '</span>' +
              '</div>' +
              '<div class="ov-mini-card">' +
                '<span class="ov-mini-label">當月總支出</span>' +
                '<span class="ov-mini-val negative">' + ovFmt(expNum) + '</span>' +
              '</div>' +
              '<div class="ov-mini-card">' +
                '<span class="ov-mini-label">當月收支</span>' +
                '<span class="ov-mini-val ' + (balNum >= 0 ? 'positive' : 'negative') + '">' + ovFmtSigned(balNum) + '</span>' +
              '</div>' +
            '</div>' +
          '</div>';

  html += '<div class="ov-cards ov-category-cards">';

  var livingBal = ovParseNum(d.livingBalance);
  html += buildCategoryCard({
    icon: 'shopping-cart', iconClass: 'living', title: '生活費',
    balance: livingBal,
    rows: [
      { label: '當月收入', val: d.livingIncome, cls: 'inc' },
      { label: '當月支出', val: d.livingExpense, cls: 'exp' },
      { label: '目前餘額', val: d.livingBalance, highlight: true, balNum: livingBal },
    ]
  });

  var savBal = ovParseNum(d.savingsBalance);
  html += buildCategoryCard({
    icon: 'bank', iconClass: 'savings', title: '存款',
    balance: savBal,
    rows: [
      { label: '當月收入', val: d.savingsIncome, cls: 'inc' },
      { label: '當月支出', val: d.savingsExpense, cls: 'exp' },
      { label: '目前餘額', val: d.savingsBalance, highlight: true, balNum: savBal },
    ]
  });

  var ageBal = ovParseNum(d.agencyBalance);
  html += buildCategoryCard({
    icon: 'handshake', iconClass: 'agency', title: '代收代付',
    balance: ageBal,
    rows: [
      { label: '當月收入', val: d.agencyIncome, cls: 'inc' },
      { label: '當月支出', val: d.agencyExpense, cls: 'exp' },
      { label: '目前餘額', val: d.agencyBalance, highlight: true, balNum: ageBal },
    ]
  });

  html += '</div>';

  html += '<div id="overviewChartsSection"></div>';

  html += '<h3 class="ov-section-title"><span class="ov-icon-box is-pay" aria-hidden="true">' + iconHtml('credit-card') + '</span>支付方式分析</h3>';
  html += '<div class="ov-cards">';
  html += '<div class="ov-card">' + UvFx.cardRing;
  html += '<div class="ov-pay-grid">';
  html += buildPayItem('現金支出', d.cashExpense, false);
  html += buildPayItem('Line Pay 支出', d.linePayExpense, false);
  html += buildPayItem('信用卡支出', d.creditCardExpense, false);
  html += buildPayItem('信用卡已繳', d.creditCardPaid, false);
  html += buildPayItem('累計信用卡未繳', d.creditCardUnpaid, true, true);
  html += '</div>';
  html += '</div>';
  html += '</div>';

  container.innerHTML = html;
  animateOverviewNumbers(container, { total: totalNum, inc: incNum, exp: expNum, bal: balNum });
  OverviewCharts.attach(container.querySelector('#overviewChartsSection'), d);
}

var overviewNumberEls = {};
function animateOverviewNumbers(container, values) {
  var minis = container.querySelectorAll('.ov-mini-val');
  var targets = [
    { key: 'total', el: container.querySelector('.ov-hero-amount'), format: function(v) { return ovFmt(Math.round(v)); } },
    { key: 'inc', el: minis[0], format: function(v) { return ovFmt(Math.round(v)); } },
    { key: 'exp', el: minis[1], format: function(v) { return ovFmt(Math.round(v)); } },
    { key: 'bal', el: minis[2], format: function(v) { return ovFmtSigned(Math.round(v)); } }
  ];
  targets.forEach(function(t) {
    if (!t.el) return;
    var to = values[t.key];
    var prev = overviewNumberEls[t.key];
    var from = 0;
    if (prev) {
      if (prev._countRaf) cancelAnimationFrame(prev._countRaf);
      prev._countRaf = 0;
      from = typeof prev._countCurrent === 'number' ? prev._countCurrent : 0;
    }
    overviewNumberEls[t.key] = t.el;
    Motion.countUp(t.el, from, to, { format: t.format, duration: 700 });
  });
}

function buildOverviewLayoutNotice(warnings, open) {
  if (!Array.isArray(warnings) || !warnings.length) return '';
  var items = warnings.map(function(w) {
    if (!w) return '';
    var label = w.label || w.key || '';
    var text = w.type === 'labelNotFound'
      ? '找不到標籤「' + label + '」' + (w.fallbackCell ? '，改讀預設位置 ' + w.fallbackCell : '，改用預設位置讀取')
      : (label || '未知的欄位');
    return '<li>' + escHtml(text) + '</li>';
  }).join('');
  return '<details class="ov-layout-notice"' + (open ? ' open' : '') + '>' +
           '<summary>' +
             '<span class="ov-layout-notice-icon" aria-hidden="true">!</span>' +
             '<span class="ov-layout-notice-text">試算表總覽區的版面可能有變動，部分數字使用預設位置讀取</span>' +
             '<span class="ov-layout-notice-toggle">詳細（' + warnings.length + '）</span>' +
           '</summary>' +
           '<ul class="ov-layout-notice-list">' + items + '</ul>' +
         '</details>';
}

function buildCategoryCard(cfg) {
  var bal = cfg.balance;
  var badgeCls = bal > 0 ? 'positive' : (bal < 0 ? 'negative' : 'neutral');
  var badgeText = bal > 0 ? '盈餘' : (bal < 0 ? '虧損' : '持平');

  var h = '<div class="ov-card">' + UvFx.cardRing;
  h += '<div class="ov-card-head">';
  h += '<div class="ov-card-icon ' + escAttr(cfg.iconClass) + '" aria-hidden="true">' + iconHtml(cfg.icon) + '</div>';
  h += '<span class="ov-card-title">' + escHtml(cfg.title) + '</span>';
  h += '<span class="ov-card-badge ' + badgeCls + '">' + badgeText + '</span>';
  h += '</div>';
  h += '<div class="ov-data-rows">';
  cfg.rows.forEach(function(row) {
    var num = ovParseNum(row.val);
    var valCls = row.cls || '';
    if (row.highlight) {
      valCls = row.balNum >= 0 ? 'inc' : 'exp';
    }
    h += '<div class="ov-data-row' + (row.highlight ? ' highlight' : '') + '">';
    h += '<span class="ov-data-label">' + escHtml(row.label) + '</span>';
    h += '<span class="ov-data-val ' + valCls + '">' + ovFmt(Math.abs(num)) + (num < 0 ? ' <span style="font-size:11px;opacity:.6">(負)</span>' : '') + '</span>';
    h += '</div>';
  });
  h += '</div>';
  h += '</div>';
  return h;
}

function buildPayItem(label, val, fullWidth, warn) {
  var num = ovParseNum(val);
  return '<div class="ov-pay-item' + (fullWidth ? ' full-width' : '') + '">' +
           '<span class="ov-pay-label">' + escHtml(label) + '</span>' +
           '<span class="ov-pay-val' + (warn && num > 0 ? ' warn' : '') + '">' + ovFmt(num) + '</span>' +
         '</div>';
}
