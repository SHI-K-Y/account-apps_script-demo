const OverviewCharts = (function() {
  const FILTER_STORAGE_KEY = 'FAST_BOOKKEEPING_CHARTS_FILTER_V1';
  const FILTER_ALL = '__all__';
  const DEFAULT_CATEGORY = '生活費';
  const DONUT_TOP_N = 6;
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

  const st = {
    root: null,
    month: null,
    overviewMonth: null,
    months: [],
    userPicked: false,
    data: null,
    filter: null,
    dailyMode: 'daily',
    focus: null,
    donutCtl: null,
    ctx: null,
    token: 0,
    error: null,
  };

  try {
    st.filter = localStorage.getItem(FILTER_STORAGE_KEY) || null;
  } catch (e) {}

  const num = v => ovParseNum(v);
  const fmtMoney = v => '$' + ovFmt(Math.round(num(v)));
  const zeros = n => new Array(n).fill(0);
  const sumTo = (arr, n) => (arr || []).slice(0, n).reduce((a, v) => a + num(v), 0);

  function pctChange(cur, prev) {
    if (!(prev > 0)) return null;
    return Math.round((cur - prev) / prev * 100);
  }

  function deltaHtml(pct, prefix, useArrow) {
    const pre = prefix ? escHtml(prefix) + ' ' : '';
    if (pct == null) return '<span class="oc-delta">' + pre + '無</span>';
    const cls = pct > 0 ? ' is-up' : pct < 0 ? ' is-down' : '';
    const abs = Math.abs(pct) + '%';
    const text = useArrow
      ? (pct > 0 ? iconHtml('arrow-up') : pct < 0 ? iconHtml('arrow-down') : '') + (pct === 0 ? '持平' : abs)
      : (pct > 0 ? '+' : pct < 0 ? '−' : '±') + abs;
    return '<span class="oc-delta' + cls + '">' + pre + text + '</span>';
  }

  function truncate(str, n) {
    const chars = Array.from(String(str || ''));
    return chars.length > n ? chars.slice(0, n).join('') + '…' : chars.join('');
  }

  function itemLabelHtml(name) {
    return itemIconLabelHtml(name, 'oc-emoji');
  }

  function monthParts(month) {
    const parts = String(month || '').split('.');
    return { year: Number(parts[0]), month: Number(parts[1]) };
  }

  function dayLabel(month, day) {
    const p = monthParts(month);
    const wd = WEEKDAYS[new Date(p.year, p.month - 1, day).getDay()];
    return p.month + '/' + day + '（' + wd + '）';
  }

  function viewOf(stats, filter) {
    if (!stats) return null;
    const n = Number(stats.daysInMonth) || 31;
    const v = { daysInMonth: n, total: 0, count: 0, byItem: {}, daily: zeros(n), dailyCount: zeros(n), maxRecord: null };
    const byCategory = stats.byCategory || {};
    const cats = filter === FILTER_ALL ? Object.keys(byCategory) : [filter];
    cats.forEach(cat => {
      const b = byCategory[cat];
      if (!b) return;
      v.total += num(b.total);
      v.count += num(b.count);
      Object.keys(b.byItem || {}).forEach(name => {
        const it = v.byItem[name] || (v.byItem[name] = { total: 0, count: 0 });
        it.total += num(b.byItem[name].total);
        it.count += num(b.byItem[name].count);
      });
      for (let i = 0; i < n; i++) {
        v.daily[i] += num(b.daily && b.daily[i]);
        v.dailyCount[i] += num(b.dailyCount && b.dailyCount[i]);
      }
      if (b.maxRecord && (!v.maxRecord || num(b.maxRecord.amount) > num(v.maxRecord.amount))) {
        v.maxRecord = b.maxRecord;
      }
    });
    return v;
  }

  function trendExpense(row, filter) {
    const map = (row && row.expenseByCategory) || {};
    if (filter === FILTER_ALL) return Object.keys(map).reduce((a, k) => a + num(map[k]), 0);
    return num(map[filter]);
  }

  function chipList(data) {
    const cats = (data && Array.isArray(data.categories) ? data.categories : []).slice();
    [data && data.current, data && data.previous].forEach(stats => {
      if (!stats || !stats.byCategory) return;
      Object.keys(stats.byCategory).forEach(c => { if (cats.indexOf(c) === -1) cats.push(c); });
    });
    const chips = [];
    if (cats.indexOf(DEFAULT_CATEGORY) !== -1) chips.push({ value: DEFAULT_CATEGORY, label: DEFAULT_CATEGORY });
    chips.push({ value: FILTER_ALL, label: '全部支出' });
    cats.forEach(c => { if (c !== DEFAULT_CATEGORY) chips.push({ value: c, label: c }); });
    return chips;
  }

  function resolveFilter(chips, data) {
    if (st.filter && chips.some(c => c.value === st.filter)) return st.filter;
    if (chips.some(c => c.value === DEFAULT_CATEGORY)) return DEFAULT_CATEGORY;
    const firstCat = data && data.categories && data.categories[0];
    return firstCat && chips.some(c => c.value === firstCat) ? firstCat : FILTER_ALL;
  }

  function ensureRoot() {
    if (st.root) return st.root;
    const root = document.createElement('section');
    root.id = 'overviewChartsSection';
    root.className = 'oc-section';
    root.setAttribute('aria-label', '支出分析');
    root.innerHTML =
      '<div class="oc-head">' +
        '<h3 class="ov-section-title"><span class="ov-icon-box" aria-hidden="true">' + iconHtml('chart-bar') + '</span>支出分析</h3>' +
        '<select class="month-select oc-month-select" aria-label="選擇支出分析月份"></select>' +
      '</div>' +
      '<div class="oc-chips" role="group" aria-label="支出篩選"></div>' +
      '<div class="oc-body"></div>';
    root.addEventListener('click', onRootClick);
    root.querySelector('.oc-month-select').addEventListener('change', e => setMonth(e.target.value));
    document.addEventListener('click', e => {
      if (st.focus == null) return;
      if (e.target.closest && e.target.closest('.mc-slice, .oc-legend-item')) return;
      setFocus(null);
    });
    st.root = root;
    return root;
  }

  function body() { return st.root.querySelector('.oc-body'); }

  function renderMonthSelect() {
    const sel = st.root.querySelector('.oc-month-select');
    const months = st.months.slice();
    if (st.month && months.indexOf(st.month) === -1) months.unshift(st.month);
    sel.innerHTML = months.map(m =>
      '<option value="' + escAttr(m) + '"' + (m === st.month ? ' selected' : '') + '>' + escHtml(m) + '</option>'
    ).join('');
  }

  function renderChips(chips) {
    st.root.querySelector('.oc-chips').innerHTML = chips.map(c =>
      '<button type="button" class="oc-chip" data-oc-action="filter" data-value="' + escAttr(c.value) + '"' +
      ' aria-pressed="' + (c.value === st.filter ? 'true' : 'false') + '">' + escHtml(c.label) + '</button>'
    ).join('');
  }

  function renderSkeleton() {
    const b = body();
    b.innerHTML =
      '<div class="overview-skeleton oc-skeleton" aria-busy="true" aria-label="圖表載入中">' +
        '<div class="skel-block oc-skel-summary"></div>' +
        '<div class="skel-block oc-skel-chart"></div>' +
        '<div class="skel-block oc-skel-chart"></div>' +
      '</div>';
    MiniCharts.releaseDetached();
  }

  function renderError(message) {
    body().innerHTML =
      '<div class="ov-card oc-card oc-error" role="alert">' +
        '<p class="oc-error-title">支出分析載入失敗</p>' +
        '<p class="oc-error-msg">' + escHtml(message) + '</p>' +
        '<button type="button" class="oc-retry" data-oc-action="retry">重試</button>' +
      '</div>';
    MiniCharts.releaseDetached();
  }

  /* 先畫本機快取（過期的也照樣畫，P12），再向伺服器取新資料。
   * opts.result：總覽頁的 batchRead 已經在讀這個月份 → 等它的結果（{ ok, data, error }），不另外送請求
   * opts.noFetch：快取是剛預取的最新資料 → 不問伺服器（沒有快取時照常讀） */
  function load(month, force, opts) {
    if (!st.root || !month) return;
    const o = opts || {};
    st.month = month;
    renderMonthSelect();
    const token = ++st.token;
    const showingSameMonth = st.data && st.data.month === month;
    const cached = force ? null : LocalCache.getCharts(month);
    st.error = null;

    if (cached) {
      const changed = !showingSameMonth || JSON.stringify(st.data) !== JSON.stringify(cached);
      st.data = cached;
      if (changed) {
        st.focus = null;
        render(!showingSameMonth);
      }
    } else if (!showingSameMonth) {
      st.data = null;
      body().style.minHeight = body().offsetHeight ? body().offsetHeight + 'px' : '';
      renderSkeleton();
    }
    if (o.noFetch && cached) {
      st.root.classList.remove('is-refreshing');
      return;
    }
    // 使用者按「重新讀取」時淡化舊圖表；背景更新（快取過期）不淡化，只在標題旁顯示「更新中」
    st.root.classList.toggle('is-refreshing', Boolean(force && st.data));

    const onData = function(data) {
      if (token !== st.token) return;
      st.root.classList.remove('is-refreshing');
      body().style.minHeight = '';
      if (!data) return;
      LocalCache.saveCharts(month, data);
      const wasEmpty = !st.data;
      const changed = wasEmpty || JSON.stringify(st.data) !== JSON.stringify(data);
      st.data = data;
      if (changed) {
        st.focus = null;
        render(wasEmpty);
      }
    };
    const onError = function(err) {
      if (token !== st.token) return;
      st.root.classList.remove('is-refreshing');
      body().style.minHeight = '';
      const message = err && err.message ? err.message : '發生未知錯誤';
      if (st.data && st.data.month === month) {
        st.error = message;
        render(false);
      } else {
        renderError(message);
      }
    };
    if (o.result && typeof o.result.then === 'function') {
      o.result.then(r => (r && r.ok ? onData(r.data) : onError(r && r.error)), onError);
      return;
    }
    const done = SyncStatus.begin('overview');
    Api.call('getOverviewCharts', month, Boolean(force))
      .then(data => { done(); onData(data); }, err => { done(); onError(err); });
  }

  function setMonth(month) {
    if (!month || month === st.month) return;
    st.userPicked = month !== st.overviewMonth;
    st.focus = null;
    load(month, false);
  }

  function setFilter(value) {
    if (value === st.filter) return;
    st.filter = value;
    try { localStorage.setItem(FILTER_STORAGE_KEY, value); } catch (e) {}
    st.focus = null;
    render(true);
  }

  function setMode(mode) {
    if (mode === st.dailyMode || !st.ctx) return;
    st.dailyMode = mode;
    renderDailyChart(st.ctx, true);
  }

  function setFocus(i) {
    st.focus = i;
    if (st.donutCtl) st.donutCtl.setFocus(i);
    if (!st.root) return;
    const legend = st.root.querySelector('.oc-legend');
    if (!legend) return;
    legend.classList.toggle('has-focus', i != null);
    legend.querySelectorAll('.oc-legend-item').forEach(btn => {
      const on = i != null && Number(btn.dataset.i) === i;
      btn.classList.toggle('is-focus', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
  }

  function onRootClick(e) {
    const btn = e.target.closest('[data-oc-action]');
    if (!btn || !st.root.contains(btn)) return;
    const action = btn.dataset.ocAction;
    if (action === 'filter') setFilter(btn.dataset.value);
    else if (action === 'mode') setMode(btn.dataset.value);
    else if (action === 'retry') load(st.month, false);
    else if (action === 'legend') {
      const i = Number(btn.dataset.i);
      setFocus(st.focus === i ? null : i);
    }
  }

  function buildContext(data) {
    const chips = chipList(data);
    const filter = resolveFilter(chips, data);
    const client = getClientToday();
    const p = monthParts(data.month);
    const isCurrent = data.month === client.currentMonth;
    const view = viewOf(data.current, filter) || viewOf({ daysInMonth: new Date(p.year, p.month, 0).getDate(), byCategory: {} }, filter);
    const prevView = viewOf(data.previous, filter);
    const today = new Date().getDate();
    const elapsedDays = isCurrent ? Math.min(today, view.daysInMonth) : view.daysInMonth;

    const items = Object.keys(view.byItem)
      .map(name => ({ name: name, total: view.byItem[name].total, count: view.byItem[name].count }))
      .filter(it => it.total > 0)
      .sort((a, b) => b.total - a.total);
    let slices = items.slice(0, DONUT_TOP_N).map(it => ({ label: it.name, value: it.total, count: it.count, names: [it.name] }));
    const rest = items.slice(DONUT_TOP_N);
    if (rest.length === 1) {
      slices.push({ label: rest[0].name, value: rest[0].total, count: rest[0].count, names: [rest[0].name] });
    } else if (rest.length > 1) {
      slices.push({
        label: '其他（' + rest.length + ' 項）',
        value: rest.reduce((a, it) => a + it.total, 0),
        count: rest.reduce((a, it) => a + it.count, 0),
        names: rest.map(it => it.name),
        isOther: true,
      });
    }
    const sliceTotal = slices.reduce((a, sl) => a + sl.value, 0);
    slices = slices.map((sl, i) => {
      const prevTotal = prevView ? sl.names.reduce((a, n) => a + num(prevView.byItem[n] && prevView.byItem[n].total), 0) : null;
      return Object.assign(sl, {
        className: 'mc-c' + Math.min(i + 1, 7),
        pct: sliceTotal > 0 ? Math.round(sl.value / sliceTotal * 100) : 0,
        prevTotal: prevTotal,
      });
    });

    return {
      data, chips, filter, isCurrent, today, elapsedDays, view, prevView, items, slices, sliceTotal,
      year: p.year,
      monthNum: p.month,
      filterLabel: filter === FILTER_ALL ? '全部' : filter,
    };
  }

  function render(animate) {
    if (!st.root) return;
    if (!st.data) { renderSkeleton(); return; }
    const ctx = buildContext(st.data);
    st.filter = ctx.filter;
    st.ctx = ctx;
    renderChips(ctx.chips);

    let html = '';
    if (st.error) {
      html += '<div class="oc-inline-error" role="alert"><span>更新失敗：' + escHtml(st.error) + '</span>' +
        '<button type="button" class="oc-retry" data-oc-action="retry">重試</button></div>';
    }
    html += BudgetView.progressHtml(st.data.budget, st.data.month);
    html += summaryHtml(ctx);
    html += '<div class="oc-grid">' + donutCardHtml(ctx) + dailyCardHtml(ctx) + '</div>';
    html += trendCardHtml(ctx);
    body().innerHTML = html;
    MiniCharts.releaseDetached();

    renderDonutChart(ctx, animate);
    renderDailyChart(ctx, animate);
    renderTrendChart(ctx, animate);
    setFocus(st.focus != null && st.focus < ctx.slices.length ? st.focus : null);
  }

  function summaryHtml(ctx) {
    const v = ctx.view;
    const pv = ctx.prevView;
    let pct = null;
    if (pv) {
      const cur = ctx.isCurrent ? sumTo(v.daily, ctx.today) : v.total;
      const prev = ctx.isCurrent ? sumTo(pv.daily, Math.min(ctx.today, pv.daysInMonth)) : pv.total;
      pct = pctChange(cur, prev);
    }
    const avg = ctx.elapsedDays > 0 ? v.total / ctx.elapsedDays : 0;
    const top = ctx.items[0];
    const maxRec = v.maxRecord && num(v.maxRecord.amount) > 0 ? v.maxRecord : null;
    const title = ctx.isCurrent ? '本月支出' : ctx.monthNum + ' 月支出';

    let h = '<div class="oc-summary">';
    h += '<div class="ov-card oc-card oc-stat">' + UvFx.cardRing +
           '<span class="oc-stat-label">' + escHtml(title) + '</span>' +
           '<span class="oc-stat-val">' + fmtMoney(v.total) + '</span>' +
           deltaHtml(pct, ctx.isCurrent ? '比上月同期' : '比上月', false) +
         '</div>';
    h += '<div class="ov-card oc-card oc-stat">' + UvFx.cardRing +
           '<span class="oc-stat-label">日均花費</span>' +
           '<span class="oc-stat-val">' + fmtMoney(avg) + '</span>' +
           '<span class="oc-stat-sub">' + (ctx.isCurrent ? '已過 ' + ctx.elapsedDays + ' 天' : '共 ' + ctx.elapsedDays + ' 天') + '</span>' +
         '</div>';
    h += '<div class="ov-card oc-card oc-stat">' + UvFx.cardRing +
           '<span class="oc-stat-label">花最多的項目</span>' +
           (top
             ? '<span class="oc-stat-val oc-stat-item">' + itemLabelHtml(top.name) + '</span>' +
               '<span class="oc-stat-sub">' + fmtMoney(top.total) + '，' + (ctx.sliceTotal > 0 ? Math.round(top.total / ctx.sliceTotal * 100) : 0) + '%</span>'
             : '<span class="oc-stat-val">無</span><span class="oc-stat-sub">尚無紀錄</span>') +
         '</div>';
    h += '<div class="ov-card oc-card oc-stat">' + UvFx.cardRing +
           '<span class="oc-stat-label">最大單筆</span>' +
           (maxRec
             ? '<span class="oc-stat-val">' + fmtMoney(maxRec.amount) + '</span>' +
               '<span class="oc-stat-sub">' + itemLabelHtml(maxRec.item) + '，' +
                 (maxRec.day ? escHtml(ctx.monthNum + '/' + maxRec.day) : '日期不明') + '</span>' +
               (maxRec.note ? '<span class="oc-stat-note" title="' + escAttr(maxRec.note) + '">' + escHtml(truncate(maxRec.note, 24)) + '</span>' : '')
             : '<span class="oc-stat-val">無</span><span class="oc-stat-sub">尚無紀錄</span>') +
         '</div>';
    h += '</div>';
    return h;
  }

  function tableToggle(headHtml, rowsHtml) {
    return '<details class="oc-table">' +
             '<summary>以表格檢視</summary>' +
             '<div class="oc-table-scroll"><table><thead><tr>' + headHtml + '</tr></thead><tbody>' + rowsHtml + '</tbody></table></div>' +
           '</details>';
  }

  function itemDeltaHtml(cur, prev, useArrowPrefix) {
    if (prev == null) return '';
    if (!(prev > 0)) return '<span class="oc-delta">' + (useArrowPrefix ? '上月無' : '無') + '</span>';
    return deltaHtml(pctChange(cur, prev), useArrowPrefix ? '比上月' : '', true);
  }

  function donutCardHtml(ctx) {
    let h = '<div class="ov-card oc-card oc-donut-card">' + UvFx.cardRing;
    h += '<div class="oc-card-head"><span class="oc-card-title">項目占比</span>' +
           '<span class="oc-card-sub">' + escHtml(ctx.filterLabel) + '</span></div>';
    if (!ctx.slices.length) {
      h += '<div class="oc-empty">這個月還沒有支出紀錄</div></div>';
      return h;
    }
    h += '<div class="oc-donut-wrap"><div class="mc-chart oc-donut-chart"></div><ul class="oc-legend">';
    ctx.slices.forEach((sl, i) => {
      h += '<li><button type="button" class="oc-legend-item" data-oc-action="legend" data-i="' + i + '" aria-pressed="false">' +
             '<span class="oc-sw ' + sl.className + '" aria-hidden="true"></span>' +
             '<span class="oc-legend-name">' + (sl.isOther ? '<span class="oc-emoji" aria-hidden="true">' + iconHtml('folders') + '</span>' + escHtml(sl.label) : itemLabelHtml(sl.label)) + '</span>' +
             '<span class="oc-legend-amt">' + fmtMoney(sl.value) + '</span>' +
             '<span class="oc-legend-meta">' + sl.pct + '%，' + sl.count + ' 筆' +
               (sl.prevTotal != null ? '，' + itemDeltaHtml(sl.value, sl.prevTotal, true) : '') +
             '</span>' +
           '</button></li>';
    });
    h += '</ul></div>';

    const rows = ctx.items.map(it => {
      const prev = ctx.prevView ? num(ctx.prevView.byItem[it.name] && ctx.prevView.byItem[it.name].total) : null;
      return '<tr><td>' + itemLabelHtml(it.name) + '</td><td>' + fmtMoney(it.total) + '</td>' +
        '<td>' + (ctx.sliceTotal > 0 ? Math.round(it.total / ctx.sliceTotal * 100) : 0) + '%</td>' +
        '<td>' + it.count + '</td><td>' + (prev == null ? '無' : itemDeltaHtml(it.total, prev, false)) + '</td></tr>';
    }).join('');
    h += tableToggle('<th scope="col">項目</th><th scope="col">金額</th><th scope="col">占比</th><th scope="col">筆數</th><th scope="col">比上月</th>', rows);
    h += '</div>';
    return h;
  }

  function renderDonutChart(ctx, animate) {
    st.donutCtl = null;
    const el = st.root.querySelector('.oc-donut-chart');
    if (!el) return;
    const top = ctx.slices[0];
    st.donutCtl = MiniCharts.donut(el, {
      slices: ctx.slices,
      animate: animate,
      ariaLabel: ctx.monthNum + ' 月' + ctx.filterLabel + '支出 ' + ovFmt(Math.round(ctx.view.total)) + ' 元' +
        (top ? '，' + top.label + '占 ' + top.pct + '%' : ''),
      center: { main: fmtMoney(ctx.view.total), sub: ctx.view.count + ' 筆' },
      centerFor: i => {
        const sl = ctx.slices[i];
        return sl ? { main: fmtMoney(sl.value), sub: truncate(sl.isOther ? '其他' : sl.label, 6) + '，' + sl.pct + '%' } : null;
      },
      onSlice: i => setFocus(st.focus === i ? null : i),
    });
  }

  function dailyCardHtml(ctx) {
    const v = ctx.view;
    let h = '<div class="ov-card oc-card oc-daily-card">' + UvFx.cardRing;
    h += '<div class="oc-card-head"><span class="oc-card-title">每日花費</span>' +
           '<div class="oc-seg" role="group" aria-label="每日或累計">' +
             '<button type="button" data-oc-action="mode" data-value="daily" aria-pressed="' + (st.dailyMode === 'daily') + '">每日</button>' +
             '<button type="button" data-oc-action="mode" data-value="cum" aria-pressed="' + (st.dailyMode === 'cum') + '">累計</button>' +
           '</div></div>';
    if (!v.count) {
      h += '<div class="oc-empty">這個月還沒有支出紀錄</div></div>';
      return h;
    }
    h += '<div class="mc-chart oc-daily-chart"></div><div class="oc-chart-legend"></div>';

    let cum = 0;
    let rows = '';
    for (let i = 0; i < v.daysInMonth; i++) {
      cum += v.daily[i];
      if (!v.daily[i] && !v.dailyCount[i]) continue;
      rows += '<tr><td>' + escHtml(dayLabel(ctx.data.month, i + 1)) + '</td><td>' + fmtMoney(v.daily[i]) + '</td>' +
        '<td>' + v.dailyCount[i] + '</td><td>' + fmtMoney(cum) + '</td></tr>';
    }
    const undated = Math.round(v.total - sumTo(v.daily, v.daysInMonth));
    if (undated) rows += '<tr><td>日期不明</td><td>' + fmtMoney(undated) + '</td><td>無</td><td>無</td></tr>';
    h += tableToggle('<th scope="col">日期</th><th scope="col">金額</th><th scope="col">筆數</th><th scope="col">累計</th>', rows);
    h += '</div>';
    return h;
  }

  function renderDailyChart(ctx, animate) {
    const card = st.root.querySelector('.oc-daily-card');
    if (!card) return;
    card.querySelectorAll('.oc-seg button').forEach(b => {
      b.setAttribute('aria-pressed', b.dataset.value === st.dailyMode ? 'true' : 'false');
    });
    const el = card.querySelector('.oc-daily-chart');
    const legendEl = card.querySelector('.oc-chart-legend');
    if (!el) return;

    const v = ctx.view;
    const n = v.daysInMonth;
    const labels = [];
    for (let d = 1; d <= n; d++) labels.push(String(d));
    const emptyFrom = ctx.isCurrent ? Math.min(ctx.today, n) : n;
    const highlightIndex = ctx.isCurrent ? Math.min(ctx.today, n) - 1 : -1;
    const avg = ctx.elapsedDays > 0 ? v.total / ctx.elapsedDays : 0;
    const monthLabel = ctx.monthNum + ' 月';

    if (st.dailyMode === 'cum') {
      const cur = [];
      let run = 0;
      for (let i = 0; i < n; i++) {
        run += v.daily[i];
        cur.push(i < emptyFrom ? Math.round(run * 100) / 100 : null);
      }
      const series = [{ values: cur, className: 'is-current', area: true }];
      let prev = null;
      if (ctx.prevView) {
        prev = [];
        let pr = 0;
        for (let i = 0; i < n; i++) {
          if (i < ctx.prevView.daysInMonth) {
            pr += ctx.prevView.daily[i];
            prev.push(Math.round(pr * 100) / 100);
          } else {
            prev.push(null);
          }
        }
        series.push({ values: prev, className: 'is-prev' });
      }
      const lastIdx = emptyFrom - 1;
      MiniCharts.lines(el, {
        labels: labels,
        series: series,
        highlightIndex: highlightIndex,
        animate: animate,
        ariaLabel: monthLabel + ctx.filterLabel + '累計支出 ' + ovFmt(Math.round(lastIdx >= 0 ? cur[lastIdx] : 0)) + ' 元' +
          (prev && lastIdx >= 0 && prev[lastIdx] != null ? '，上月同日累計 ' + ovFmt(Math.round(prev[lastIdx])) + ' 元' : ''),
        tooltip: i => {
          const label = escHtml(dayLabel(ctx.data.month, i + 1));
          if (cur[i] == null) return label + ' 上月同日累計 ' + fmtMoney(prev && prev[i] != null ? prev[i] : 0);
          let t = label + ' 累計 ' + fmtMoney(cur[i]);
          if (prev && prev[i] != null) t += '<span class="mc-tip-sub">上月同日 ' + fmtMoney(prev[i]) + '</span>';
          return t;
        },
      });
      legendEl.innerHTML =
        '<span class="oc-key"><i class="oc-key-line is-current"></i>本月累計</span>' +
        (prev ? '<span class="oc-key"><i class="oc-key-line is-prev"></i>上月累計</span>' : '<span class="oc-key is-muted">上月無資料</span>');
      return;
    }

    MiniCharts.bars(el, {
      labels: labels,
      series: [{ values: v.daily, className: 'is-daily' }],
      highlightIndex: highlightIndex,
      emptyFrom: emptyFrom,
      avg: avg,
      avgLabel: '日均 ' + fmtMoney(avg),
      animate: animate,
      ariaLabel: monthLabel + ctx.filterLabel + '每日支出，日均 ' + ovFmt(Math.round(avg)) + ' 元',
      tooltip: i => escHtml(dayLabel(ctx.data.month, i + 1)) + ' ' + fmtMoney(v.daily[i]) + '，' + v.dailyCount[i] + ' 筆',
    });
    legendEl.innerHTML =
      '<span class="oc-key"><i class="oc-key-line is-avg"></i>日均線</span>' +
      (ctx.isCurrent ? '<span class="oc-key"><i class="oc-key-box is-today"></i>今天</span>' : '');
  }

  function trendCardHtml(ctx) {
    const trend = Array.isArray(ctx.data.trend) ? ctx.data.trend : [];
    let h = '<div class="ov-card oc-card oc-trend-card">' + UvFx.cardRing;
    h += '<div class="oc-card-head"><span class="oc-card-title">近 ' + trend.length + ' 個月收支</span>' +
           '<span class="oc-card-sub">點選月份可切換</span></div>';
    h += '<div class="mc-chart oc-trend-chart"></div>';
    h += '<div class="oc-chart-legend">' +
           '<span class="oc-key"><i class="oc-key-box is-income"></i>收入</span>' +
           '<span class="oc-key"><i class="oc-key-box is-expense"></i>支出（' + escHtml(ctx.filterLabel) + '）</span>' +
           '<span class="oc-key is-muted">長條上方為結餘</span>' +
         '</div>';
    const rows = trend.map(row => {
      const inc = num(row.incomeTotal);
      const exp = trendExpense(row, ctx.filter);
      return '<tr' + (row.month === ctx.data.month ? ' class="is-current"' : '') + '><td>' + escHtml(row.month) + '</td>' +
        '<td>' + fmtMoney(inc) + '</td><td>' + fmtMoney(exp) + '</td><td>' + escHtml(ovFmtSigned(Math.round(inc - exp))) + '</td></tr>';
    }).join('');
    h += tableToggle('<th scope="col">月份</th><th scope="col">收入</th><th scope="col">支出</th><th scope="col">結餘</th>', rows);
    h += '</div>';
    return h;
  }

  function renderTrendChart(ctx, animate) {
    const el = st.root.querySelector('.oc-trend-chart');
    if (!el) return;
    const trend = Array.isArray(ctx.data.trend) ? ctx.data.trend : [];
    const incomes = trend.map(row => num(row.incomeTotal));
    const expenses = trend.map(row => trendExpense(row, ctx.filter));
    const target = trend.findIndex(row => row.month === ctx.data.month);
    const targetRow = trend[target];
    MiniCharts.bars(el, {
      labels: trend.map(row => monthParts(row.month).month + '月'),
      series: [
        { values: incomes, className: 'is-income' },
        { values: expenses, className: 'is-expense' },
      ],
      height: 200,
      band: true,
      highlightIndex: target,
      animate: animate,
      valueLabels: trend.map((row, i) => {
        const bal = incomes[i] - expenses[i];
        return { text: (bal > 0 ? '+' : '') + MiniCharts.fmtCompact(bal), className: bal >= 0 ? 'is-pos' : 'is-neg' };
      }),
      ariaLabel: '近 ' + trend.length + ' 個月收支' +
        (targetRow ? '，' + monthParts(targetRow.month).month + ' 月收入 ' + ovFmt(Math.round(incomes[target])) +
          ' 元、支出 ' + ovFmt(Math.round(expenses[target])) + ' 元' : ''),
      onPick: i => { if (trend[i]) setMonth(trend[i].month); },
    });
  }

  return {
    attach: function(placeholder, overview) {
      const root = ensureRoot();
      if (overview) {
        st.overviewMonth = overview.month || st.overviewMonth;
        const months = Array.isArray(overview.months) && overview.months.length
          ? overview.months
          : ((state.data && state.data.months) || []);
        st.months = months.slice();
      }
      if (placeholder && placeholder !== root) placeholder.replaceWith(root);
      if (!st.month) {
        st.month = st.overviewMonth;
        // 有本機快取就直接畫（P12：預先畫好的總覽連圖表一起，切過去時不會先看到骨架）。
        // 畫在隱藏的頁面時寬度量不到，先用預設寬度，顯示後 ResizeObserver 會照實際寬度重畫
        const cached = st.month ? LocalCache.getCharts(st.month) : null;
        if (cached) {
          st.data = cached;
          render(false);
        } else {
          renderSkeleton();
        }
      }
      renderMonthSelect();
    },

    /** opts 見 load()：result（batchRead 的結果）只在要載入的就是 overviewMonth 時使用。 */
    loadForOverview: function(overviewMonth, force, opts) {
      if (overviewMonth) st.overviewMonth = overviewMonth;
      const keepPicked = st.userPicked && st.month && st.months.indexOf(st.month) !== -1;
      if (!keepPicked) st.userPicked = false;
      const month = keepPicked ? st.month : st.overviewMonth;
      load(month, force, month === overviewMonth ? opts : null);
    },

    needsReloadFor: function(overviewMonth) {
      return !st.userPicked && overviewMonth && overviewMonth !== st.month;
    },
  };
})();
