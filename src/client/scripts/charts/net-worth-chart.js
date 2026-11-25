/* =============================================================================
 * NetWorthChart — 總覽的「資產軌跡」：淨資產、生活費餘額、存款餘額三條線（F06）
 * -----------------------------------------------------------------------------
 * 資料來自 getNetWorthHistory（後端 34_net_worth.gs，最近 24 個月）；本月的點一律用總覽頁手上的數字
 * （記帳後總覽會更新，歷史不用重抓）。過完的月份很少變，所以本機快取沒過期、6 小時內拿過就不問伺服器；
 * 不和總覽的 batchRead 合在一起：第一次（快照還沒建好）要掃很多張工作表，不能拖慢總覽。
 *
 * 進場動畫：線條放在 .mc-reveal（裁切窗）裡，由左往右揭開，只動 transform（見 14-charts.css），由合成器執行。
 * 第一次捲進畫面才播放（預先畫好的頁面在畫面外時先藏著線條），切換 6／12／24 個月時再播放一次。
 * ============================================================================= */
const NetWorthChart = (function() {
  const RANGE_KEY = 'FAST_BOOKKEEPING_NETWORTH_RANGE_V1';
  const RANGES = [6, 12, 24];
  const FRESH_MS = 6 * 3600 * 1000;
  const SERIES = [
    { key: 'total', label: '淨資產', className: 'is-nw-total', overview: 'assetTotal', area: true },
    { key: 'living', label: '生活費餘額', className: 'is-nw-living', overview: 'livingBalance' },
    { key: 'savings', label: '存款餘額', className: 'is-nw-savings', overview: 'savingsBalance' },
  ];

  const st = {
    root: null,
    data: null,        // getNetWorthHistory 的結果
    overview: null,    // 總覽頁正在顯示的資料（本月的點用它）
    range: 12,
    hidden: new Set(), // 圖例關掉的線
    seen: false,       // 進場動畫播過了
    observer: null,
    loading: false,
    error: null,
    sig: '',
  };
  try {
    const saved = Number(localStorage.getItem(RANGE_KEY));
    if (RANGES.indexOf(saved) !== -1) st.range = saved;
  } catch (e) {}

  const money = v => (v < 0 ? '−' : '') + '$' + ovFmt(Math.abs(Math.round(v)));
  const signed = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + '$' + ovFmt(Math.abs(Math.round(v)));

  function shiftMonth(month, delta) {
    const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta;
    const m = index % 12 + 1;
    return Math.floor(index / 12) + '.' + (m < 10 ? '0' + m : m);
  }

  function monthName(month) {
    return month.slice(0, 4) + ' 年 ' + Number(month.slice(5, 7)) + ' 月';
  }

  /** 總覽頁的數字 → 本月的點；讀不到標籤的欄位不畫（與後端 netWorthPoint_ 相同）。 */
  function overviewPoint() {
    const ov = st.overview;
    if (!ov || !ov.month || ov.assetTotal == null) return null;
    const missing = new Set((Array.isArray(ov.warnings) ? ov.warnings : []).map(w => w && w.key));
    const point = { month: ov.month };
    SERIES.forEach(s => {
      const text = String(ov[s.overview] == null ? '' : ov[s.overview]).trim();
      point[s.key] = missing.has(s.overview) || !text || text.charAt(0) === '#' ? null : ovParseNum(text);
    });
    return point.total == null ? null : point;
  }

  /** 選取範圍內連續的月份（缺的月份是 null，線會斷開），第一個月是有資料的月份。 */
  function rowsInRange() {
    const byMonth = {};
    ((st.data && st.data.points) || []).forEach(p => { byMonth[p.month] = p; });
    const live = overviewPoint();
    const newest = Object.keys(byMonth).sort().pop() || '';
    if (live && live.month >= newest) byMonth[live.month] = live;
    const months = Object.keys(byMonth).sort();
    if (!months.length) return [];
    const last = months[months.length - 1];
    const start = shiftMonth(last, -(st.range - 1));
    const first = months.find(m => m >= start);
    const rows = [];
    for (let m = first; m <= last; m = shiftMonth(m, 1)) rows.push(byMonth[m] || { month: m, total: null, living: null, savings: null });
    return rows;
  }

  /* ----------------------------------- 畫面 ----------------------------------- */

  function ensureRoot() {
    if (st.root) return st.root;
    const root = document.createElement('section');
    root.id = 'netWorthSection';
    root.className = 'oc-section nw-section';
    root.setAttribute('aria-label', '資產軌跡');
    root.innerHTML =
      '<div class="oc-head">' +
        '<h3 class="ov-section-title"><span class="ov-icon-box" aria-hidden="true">' + iconHtml('chart-line') + '</span>資產軌跡</h3>' +
        '<div class="oc-seg nw-range" role="group" aria-label="顯示幾個月">' +
          RANGES.map(n => '<button type="button" data-nw-range="' + n + '" aria-pressed="' + (n === st.range) + '">' + n + ' 個月</button>').join('') +
        '</div>' +
      '</div>' +
      '<div class="nw-body"></div>';
    root.addEventListener('click', onClick);
    st.root = root;
    return root;
  }

  function onClick(e) {
    const range = e.target.closest('[data-nw-range]');
    const legend = e.target.closest('[data-nw-series]');
    if (range) {
      const n = Number(range.dataset.nwRange);
      if (n === st.range) return;
      st.range = n;
      try { localStorage.setItem(RANGE_KEY, String(n)); } catch (err) {}
      st.root.querySelectorAll('[data-nw-range]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.nwRange) === n)));
      render(true);
    } else if (legend) {
      const key = legend.dataset.nwSeries;
      // 至少留一條線
      if (st.hidden.has(key)) st.hidden.delete(key);
      else if (st.hidden.size < SERIES.length - 1) st.hidden.add(key);
      else return;
      render(false);
      const again = st.root.querySelector('[data-nw-series="' + key + '"]');
      if (again) again.focus({ preventScroll: true });
    } else if (e.target.closest('[data-nw-retry]')) {
      load(true);
    }
  }

  function seriesValues(rows) {
    return SERIES.filter(s => !st.hidden.has(s.key)).map(s => Object.assign({ values: rows.map(r => r[s.key]) }, s));
  }

  function axisLabel(month, i) {
    const m = Number(month.slice(5, 7));
    return m === 1 || i === 0 ? month.slice(2, 4) + '/' + m : m + '月';
  }

  function cardHtml(rows) {
    const first = rows.find(r => r.total != null);
    const last = rows[rows.length - 1];
    const diff = first && last && last.total != null ? last.total - first.total : null;
    let h = '<div class="ov-card oc-card nw-card">' + UvFx.cardRing;
    h += '<div class="oc-card-head"><span class="oc-card-title">淨資產 ' + (last.total != null ? escHtml(money(last.total)) : '讀不到') + '</span>' +
           (diff != null && first !== last ? '<span class="oc-card-sub">比 ' + escHtml(monthName(first.month)) + ' ' + escHtml(signed(diff)) + '</span>' : '') + '</div>';
    if (rows.length < 2) return h + '<div class="oc-empty">累積兩個月以上的資料，就能看到資產變化</div></div>';
    h += '<div class="mc-chart nw-chart"></div>';
    h += '<div class="oc-chart-legend nw-legend">' + SERIES.map(s => {
      const on = !st.hidden.has(s.key);
      return '<button type="button" class="nw-key" data-nw-series="' + s.key + '" aria-pressed="' + on + '">' +
               '<i class="nw-key-line ' + s.className + '" aria-hidden="true"></i>' + escHtml(s.label) +
               '<b>' + (last[s.key] == null ? '—' : escHtml(money(last[s.key]))) + '</b></button>';
    }).join('') + '</div>';
    h += '<details class="oc-table"><summary>以表格檢視</summary><div class="oc-table-scroll"><table><thead><tr>' +
           '<th scope="col">月份</th>' + SERIES.map(s => '<th scope="col">' + escHtml(s.label) + '</th>').join('') + '</tr></thead><tbody>' +
           rows.slice().reverse().map(r => '<tr><td>' + escHtml(r.month) + '</td>' +
             SERIES.map(s => '<td>' + (r[s.key] == null ? '無' : escHtml(money(r[s.key]))) + '</td>').join('') + '</tr>').join('') +
         '</tbody></table></div></details>';
    return h + '</div>';
  }

  function render(animate) {
    if (!st.root) return;
    const body = st.root.querySelector('.nw-body');
    const rows = rowsInRange();
    st.sig = JSON.stringify(rows);
    if (!st.data) {
      body.innerHTML = st.error
        ? '<div class="ov-card oc-card oc-error" role="alert"><p class="oc-error-title">資產軌跡載入失敗</p><p class="oc-error-msg">' + escHtml(st.error) +
            '</p><button type="button" class="oc-retry" data-nw-retry>重試</button></div>'
        : '<div class="overview-skeleton oc-skeleton" aria-busy="true" aria-label="資產軌跡載入中"><div class="skel-block oc-skel-chart"></div></div>';
      MiniCharts.releaseDetached();
      return;
    }
    if (!rows.length) { body.innerHTML = ''; st.root.hidden = true; return; }
    st.root.hidden = false;
    const wasOpen = Boolean(body.querySelector('.oc-table[open]'));
    body.innerHTML = cardHtml(rows);
    if (wasOpen) { const t = body.querySelector('.oc-table'); if (t) t.open = true; }
    MiniCharts.releaseDetached();
    const el = body.querySelector('.nw-chart');
    if (!el) return;

    const series = seriesValues(rows);
    const last = rows[rows.length - 1];
    MiniCharts.lines(el, {
      labels: rows.map((r, i) => axisLabel(r.month, i)),
      series: series,
      height: 210,
      tickMinPx: 34,
      negative: true,
      reveal: true,
      endDots: true,
      highlightIndex: rows.length - 1,
      animate: animate && st.seen,
      ariaLabel: '近 ' + rows.length + ' 個月資產軌跡，' + SERIES.map(s => s.label + ' ' + (last[s.key] == null ? '讀不到' : ovFmt(Math.round(last[s.key])) + ' 元')).join('、'),
      tooltip: i => escHtml(monthName(rows[i].month)) + series.map(s =>
        rows[i][s.key] == null ? '' : '<span class="mc-tip-sub"><i class="nw-key-line ' + s.className + '" aria-hidden="true"></i>' + escHtml(s.label) + ' ' + escHtml(money(rows[i][s.key])) + '</span>').join(''),
    });
    waitForView(el);
  }

  /** 第一次進場：線條先藏著，整張圖捲進畫面時才播放（畫面外播了也看不到）。 */
  function waitForView(el) {
    if (st.seen) return;
    if (typeof IntersectionObserver !== 'function' || Motion.level() !== 'full') { st.seen = true; return; }
    el.classList.add('is-waiting');
    if (st.observer) return;
    st.observer = new IntersectionObserver(entries => {
      if (!entries.some(en => en.isIntersecting)) return;
      st.observer.disconnect();
      st.observer = null;
      st.seen = true;
      const chart = st.root.querySelector('.nw-chart');
      if (!chart) return;
      // 圖已經畫好了，只要讓裁切窗開始播放（不重建 SVG）
      requestAnimationFrame(() => {
        chart.classList.remove('is-waiting');
        const reveal = chart.querySelector('.mc-reveal');
        if (reveal) reveal.classList.add('is-playing');
      });
    }, { threshold: 0.35 });
    st.observer.observe(st.root);
  }

  /* ----------------------------------- 資料 ----------------------------------- */

  function isFresh() {
    const s = LocalCache.status('netWorth');
    return Boolean(st.data && s && !s.stale && Date.now() - s.savedAt < FRESH_MS &&
      st.data.currentMonth === getClientToday().currentMonth);
  }

  /** 總覽頁打開、開機預取時呼叫（預取時可能還沒畫出來）：快取夠新就不問伺服器；有舊資料時照樣先顯示。 */
  function load(force) {
    if (!st.data) st.data = LocalCache.getNetWorth();
    if (st.loading || (!force && isFresh())) return;
    st.loading = true;
    st.error = null;
    if (!st.data) render(false);
    const version = state.mutationVersion;
    const done = SyncStatus.begin('overview');
    Api.call('getNetWorthHistory', Boolean(force)).then(data => {
      done();
      st.loading = false;
      if (!data || !Array.isArray(data.points)) return;
      st.data = data;
      LocalCache.saveNetWorth(data);
      if (version !== state.mutationVersion) LocalCache.markNetWorthStale();
      if (st.root && (JSON.stringify(rowsInRange()) !== st.sig || !st.root.querySelector('.nw-card'))) render(false);
    }, err => {
      done();
      st.loading = false;
      st.error = err && err.message ? err.message : '發生未知錯誤';
      if (!st.data) render(false);   // 有舊資料就繼續顯示舊的
    });
  }

  return {
    /** renderOverview 重建頁面時把區塊放回去；數字沒變就不重畫。 */
    attach: function(placeholder, overview) {
      const root = ensureRoot();
      st.overview = overview || st.overview;
      if (placeholder && placeholder !== root) placeholder.replaceWith(root);
      if (!st.data) st.data = LocalCache.getNetWorth();
      if (!root.querySelector('.nw-body').firstChild || JSON.stringify(rowsInRange()) !== st.sig) render(false);
    },
    load: load,
  };
})();
