const SearchPage = (function () {
  'use strict';

  const BATCH_SIZE = 6;
  const MAX_RECORDS = 1000;
  const RECENT_MAX = 8;
  const RECENT_KEY = 'FAST_BOOKKEEPING_SEARCH_RECENT_V1';
  const BARS_COLLAPSED_ROWS = 6;
  const DEFAULT_RANGE = 'recent3';

  const $ = function (id) { return document.getElementById(id); };
  const reduceMotion = function () {
    return Motion.level() !== 'full';
  };

  function newTypeStats() { return { byMonth: {} }; }

  const S = {
    active: false,
    origin: 'bookkeeping',

    type: 'all',
    range: DEFAULT_RANGE,
    customFrom: '',
    customTo: '',
    items: new Set(),
    categories: new Set(),
    payments: new Set(),
    paid: '',
    moreOpen: false,

    token: 0,
    running: false,
    stopped: false,
    error: '',
    hasSearched: false,
    plannedMonths: [],
    doneMonths: 0,
    query: null,

    records: [],
    stats: { expense: newTypeStats(), income: newTypeStats() },
    skipped: [],
    missing: [],
    failed: [],
    truncated: false,
    capped: false,

    stale: false,
    seenVersion: 0,
    refreshing: new Set(),
    requeryFailed: new Set(),

    barsExpanded: false,
    recentList: [],
  };

  const MONEY_DIGITS = { maximumFractionDigits: 2 };
  function money(n, withPlus) {
    const v = Number(n) || 0;
    const sign = v < 0 ? '-' : (withPlus ? '+' : '');
    return sign + '$' + Fmt.num(Math.abs(v), MONEY_DIGITS);
  }

  function typeMoney(type, n) {
    return money(n, type === 'income');
  }

  function shiftMonthStr(month, delta) {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    const idx = y * 12 + (m - 1) + delta;
    const ny = Math.floor(idx / 12);
    const nm = idx - ny * 12 + 1;
    return ny + '.' + (nm < 10 ? '0' + nm : String(nm));
  }

  function monthTitle(month) {
    return month.slice(0, 4) + ' 年 ' + Number(month.slice(5, 7)) + ' 月';
  }

  function chunk(list, size) {
    const out = [];
    for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  function fullDateLabel(rec) {
    const d = parseInt(rec.day, 10);
    if (isNaN(d) || !rec.month) return '';
    const y = Number(rec.month.slice(0, 4));
    const m = Number(rec.month.slice(5, 7));
    const w = new Date(y, m - 1, d).getDay();
    return pad(m) + '/' + pad(d) + '（' + '日一二三四五六'.charAt(w) + '）';
  }

  function dayNum(rec) {
    const d = parseInt(rec.day, 10);
    return isNaN(d) ? -1 : d;
  }

  function cmpRec(a, b) {
    const da = dayNum(a);
    const db = dayNum(b);
    if (da !== db) return db - da;
    if (a.row !== b.row) return b.row - a.row;
    if (a.type !== b.type) return a.type === 'expense' ? -1 : 1;
    return 0;
  }

  function sortRecords() {
    S.records.sort(function (a, b) {
      if (a.month !== b.month) return a.month < b.month ? 1 : -1;
      return cmpRec(a, b);
    });
  }

  function availableMonths() {
    const all = (state.data && Array.isArray(state.data.months)) ? state.data.months.slice() : [];
    all.sort();
    all.reverse();
    return all;
  }

  function resetStats() {
    S.stats = { expense: newTypeStats(), income: newTypeStats() };
  }

  function statsApply(rec, sign) {
    const t = S.stats[rec.type];
    if (!t) return;
    const amount = Number(rec.amount) || 0;
    const itemKey = rec.item || '（無項目）';
    const mm = t.byMonth[rec.month] || (t.byMonth[rec.month] = { count: 0, total: 0, byItem: {} });
    mm.count += sign;
    mm.total += sign * amount;
    const it = mm.byItem[itemKey] || (mm.byItem[itemKey] = { count: 0, total: 0 });
    it.count += sign;
    it.total += sign * amount;
    if (it.count <= 0) delete mm.byItem[itemKey];
    if (mm.count <= 0) delete t.byMonth[rec.month];
  }

  function typeTotals(type) {
    const t = S.stats[type];
    const out = { count: 0, total: 0, months: [], byItem: {} };
    Object.keys(t.byMonth).forEach(function (m) {
      const mm = t.byMonth[m];
      out.count += mm.count;
      out.total += mm.total;
      out.months.push(m);
      Object.keys(mm.byItem || {}).forEach(function (k) {
        const o = out.byItem[k] || (out.byItem[k] = { count: 0, total: 0 });
        o.count += mm.byItem[k].count;
        o.total += mm.byItem[k].total;
      });
    });
    return out;
  }

  function activeTypes() {
    if (!S.query) return [];
    return S.query.type === 'all' ? ['expense', 'income'] : [S.query.type];
  }

  function totalHitCount() {
    return activeTypes().reduce(function (n, t) { return n + typeTotals(t).count; }, 0);
  }

  function loadRecentList() {
    try {
      const raw = localStorage.getItem(RECENT_KEY);
      const arr = raw ? JSON.parse(raw) : [];
      if (Array.isArray(arr)) {
        S.recentList = arr.filter(function (x) { return typeof x === 'string' && x; }).slice(0, RECENT_MAX);
      }
    } catch (e) {  }
  }

  function persistRecentList() {
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(S.recentList)); } catch (e) {}
  }

  function pushRecent(keyword) {
    const key = normalizeSearchText(keyword);
    S.recentList = S.recentList.filter(function (k) { return normalizeSearchText(k) !== key; });
    S.recentList.unshift(keyword);
    S.recentList = S.recentList.slice(0, RECENT_MAX);
    persistRecentList();
    renderRecentChips();
  }

  function renderRecentChips() {
    const wrap = $('srRecentWrap');
    const box = $('srRecentChips');
    if (!wrap || !box) return;
    box.innerHTML = '';
    wrap.hidden = S.recentList.length === 0;
    S.recentList.forEach(function (kw, idx) {
      const chip = document.createElement('span');
      chip.className = 'sr-recent-chip';

      const main = document.createElement('button');
      main.type = 'button';
      main.className = 'sr-recent-chip-main';
      main.textContent = kw;
      main.title = '搜尋「' + kw + '」';
      main.addEventListener('click', function () {
        $('srInput').value = kw;
        syncControls();
        startSearch();
      });

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'sr-recent-chip-del';
      del.setAttribute('aria-label', '刪除搜尋記錄「' + kw + '」');
      del.innerHTML = '' + iconHtml('x', 'regular', 'ic-12') + '';
      del.addEventListener('click', function () {
        S.recentList.splice(idx, 1);
        persistRecentList();
        renderRecentChips();
      });

      chip.appendChild(main);
      chip.appendChild(del);
      box.appendChild(chip);
    });
  }

  function computeMonths() {
    const all = availableMonths();
    const cur = getClientToday().currentMonth;
    switch (S.range) {
      case 'month':
        if (all.indexOf(cur) !== -1) return [cur];
        return all.length ? [all[0]] : [];
      case 'recent3': {
        const from = shiftMonthStr(cur, -2);
        return all.filter(function (m) { return m >= from && m <= cur; });
      }
      case 'year':
        return all.filter(function (m) { return m.slice(0, 4) === cur.slice(0, 4); });
      case 'custom': {
        let a = S.customFrom || (all.length ? all[all.length - 1] : '');
        let b = S.customTo || (all.length ? all[0] : '');
        if (a > b) { const t = a; a = b; b = t; }
        return all.filter(function (m) { return m >= a && m <= b; });
      }
      case 'all':
      default:
        return all;
    }
  }

  function readAmounts() {
    const parse = function (id) {
      const raw = $(id).value.trim();
      if (raw === '') return { value: null };
      const n = Number(raw);
      if (!isFinite(n) || n < 0) return { error: true };
      return { value: n };
    };
    const min = parse('srMinAmount');
    const max = parse('srMaxAmount');
    if (min.error || max.error) return { error: '金額必須是大於或等於 0 的數字' };
    if (min.value !== null && max.value !== null && min.value > max.value) {
      return { error: '最小金額不能大於最大金額' };
    }
    return { min: min.value, max: max.value };
  }

  function activeMoreCount() {
    const hasAmt = $('srMinAmount').value.trim() !== '' || $('srMaxAmount').value.trim() !== '';
    let n = 0;
    if (S.items.size) n++;
    if (S.categories.size) n++;
    if (S.type !== 'income' && S.payments.size) n++;
    if (S.type !== 'income' && S.paid) n++;
    if (hasAmt) n++;
    return n;
  }

  function hasAnyCondition() {
    return S.type !== 'all' || activeMoreCount() > 0;
  }

  function hasAnythingToClear() {
    return $('srInput').value.trim() !== '' || S.type !== 'all' || S.range !== DEFAULT_RANGE || activeMoreCount() > 0;
  }

  function payloadFromQuery(q, months) {
    return {
      months: months,
      keyword: q.keyword,
      type: q.type,
      items: q.items,
      categories: q.categories,
      payments: q.payments,
      paid: q.paid,
      minAmount: q.minAmount,
      maxAmount: q.maxAmount,
    };
  }

  function setPressed(btn, on) {
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  }

  function syncControls() {
    document.querySelectorAll('#pageSearch [data-sr-type]').forEach(function (b) { setPressed(b, b.dataset.srType === S.type); });
    document.querySelectorAll('#pageSearch [data-sr-range]').forEach(function (b) { setPressed(b, b.dataset.srRange === S.range); });
    document.querySelectorAll('#pageSearch [data-sr-paid]').forEach(function (b) { setPressed(b, b.dataset.srPaid === S.paid); });

    $('srCustomRange').hidden = S.range !== 'custom';

    const isIncome = S.type === 'income';
    $('srPaymentField').hidden = isIncome;
    $('srPaidField').hidden = isIncome;
    $('srPayHint').hidden = !(S.type === 'all' && (S.payments.size || S.paid));

    const n = activeMoreCount();
    const badge = $('srMoreBadge');
    badge.hidden = n === 0;
    badge.textContent = String(n);

    const toggle = $('srMoreToggle');
    toggle.setAttribute('aria-expanded', S.moreOpen ? 'true' : 'false');
    toggle.classList.toggle('open', S.moreOpen);
    Motion.toggleHidden($('srMorePanel'), S.moreOpen);

    $('srClearAll').hidden = !hasAnythingToClear();
    $('srClearBtn').hidden = $('srInput').value === '';
    measureHead();
  }

  function fillMonthSelects() {
    const all = availableMonths();
    const from = $('srFromMonth');
    const to = $('srToMonth');
    [from, to].forEach(function (sel) {
      sel.innerHTML = '';
      all.forEach(function (m) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        sel.appendChild(opt);
      });
    });
    if (!S.customFrom || all.indexOf(S.customFrom) === -1) S.customFrom = all.length ? all[Math.min(2, all.length - 1)] : '';
    if (!S.customTo || all.indexOf(S.customTo) === -1) S.customTo = all.length ? all[0] : '';
    from.value = S.customFrom;
    to.value = S.customTo;
  }

  function uniq(list) {
    const seen = new Set();
    return list.filter(function (v) { if (!v || seen.has(v)) return false; seen.add(v); return true; });
  }

  function renderMulti(containerId, isPayment, items, selectedSet, onChange) {
    const container = $(containerId);
    if (!container) return;
    selectedSet.forEach(function (v) { if (items.indexOf(v) === -1) selectedSet.delete(v); });

    if (isPayment) renderPaymentChoices(containerId, items, '', function () {});
    else renderChoices(containerId, items, '', function () {});

    container.querySelectorAll('.choice').forEach(function (btn) {
      const on = selectedSet.has(btn.dataset.value);
      btn.classList.toggle('selected', on);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
    });

    container._srMulti = { set: selectedSet, onChange: onChange };
    if (!container._srBound) {
      container._srBound = true;
      container.addEventListener('click', function (e) {
        const btn = e.target.closest ? e.target.closest('.choice') : null;
        if (!btn || !container.contains(btn)) return;
        e.stopPropagation();
        e.preventDefault();
        const cfg = container._srMulti;
        const v = btn.dataset.value;
        if (cfg.set.has(v)) cfg.set.delete(v); else cfg.set.add(v);
        const on = cfg.set.has(v);
        btn.classList.toggle('selected', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        cfg.onChange();
      }, true);
    }
  }

  function renderFilterChoices() {
    const o = state.data && state.data.options;
    if (!o) return;
    const items = S.type === 'expense' ? (o.expenseItems || [])
      : S.type === 'income' ? (o.incomeItems || [])
      : uniq((o.expenseItems || []).concat(o.incomeItems || []));
    const categories = S.type === 'expense' ? (o.expenseCategories || [])
      : S.type === 'income' ? (o.incomeCategories || [])
      : uniq((o.expenseCategories || []).concat(o.incomeCategories || []));

    renderMulti('srItemChoices', false, items, S.items, syncControls);
    renderMulti('srCategoryChoices', false, categories, S.categories, syncControls);
    if (S.type !== 'income') {
      renderMulti('srPaymentChoices', true, o.paymentMethods || [], S.payments, syncControls);
    }
  }

  function measureHead() {
    const head = $('srHead');
    const page = $('pageSearch');
    if (!head || !page || !head.offsetHeight) return;
    const topPx = parseFloat(getComputedStyle(head).top) || 8;
    page.style.setProperty('--sr-sticky-top', Math.round(head.offsetHeight + topPx + 3) + 'px');
  }

  function resetResults() {
    S.records = [];
    resetStats();
    S.skipped = [];
    S.missing = [];
    S.failed = [];
    S.truncated = false;
    S.capped = false;
    S.error = '';
    S.stopped = false;
    S.stale = false;
    S.refreshing = new Set();
    S.requeryFailed = new Set();
    S.barsExpanded = false;
    $('srResults').innerHTML = '';
  }

  function startSearch() {
    const keyword = $('srInput').value.trim();
    const amt = readAmounts();
    if (amt.error) {
      showToast(amt.error, 'error');
      return;
    }
    if (!keyword && !hasAnyCondition()) {
      showToast('請輸入關鍵字或選擇篩選條件', 'error');
      $('srInput').focus();
      return;
    }

    const months = computeMonths();
    const token = ++S.token;
    resetResults();

    const isIncome = S.type === 'income';
    S.query = {
      keyword: keyword,
      terms: uniq(normalizeSearchText(keyword).split(/\s+/)),
      type: S.type,
      items: Array.from(S.items),
      categories: Array.from(S.categories),
      payments: isIncome ? [] : Array.from(S.payments),
      paid: isIncome ? '' : S.paid,
      minAmount: amt.min,
      maxAmount: amt.max,
    };
    S.plannedMonths = months;
    S.doneMonths = 0;
    S.hasSearched = true;
    S.running = months.length > 0;
    S.seenVersion = state.mutationVersion;

    if (keyword) pushRecent(keyword);
    $('srInput').blur();
    renderAll();

    if (!months.length) return;
    runBatch(token, chunk(months, BATCH_SIZE), 0);
  }

  function runBatch(token, batches, index) {
    if (token !== S.token) return;
    if (index >= batches.length) {
      S.running = false;
      renderAll();
      return;
    }
    const months = batches[index];
    Api.server
      .withSuccessHandler(function (res) {
        if (token !== S.token) return;
        mergeBatch(res, months);
        runBatch(token, batches, index + 1);
      })
      .withFailureHandler(function (err) {
        if (token !== S.token) return;
        S.running = false;
        S.error = (err && err.message) ? err.message : '搜尋失敗，請稍後再試';
        renderAll();
      })
      .searchRecords(payloadFromQuery(S.query, months));
  }

  function mergeBatch(res, requestedMonths) {
    res = res || {};
    S.doneMonths += requestedMonths.length;

    const fresh = [];
    (res.results || []).forEach(function (rec) {
      if (S.records.length >= MAX_RECORDS) { S.capped = true; return; }
      S.records.push(rec);
      fresh.push(rec);
    });
    if (res.truncated) S.truncated = true;

    const byType = (res.stats && res.stats.byType) || {};
    ['expense', 'income'].forEach(function (type) {
      const src = (byType[type] && byType[type].byMonth) || {};
      Object.keys(src).forEach(function (m) { S.stats[type].byMonth[m] = src[m]; });
    });

    S.skipped = S.skipped.concat(res.skippedMonths || []);
    S.missing = S.missing.concat(res.missingMonths || []);
    S.failed = S.failed.concat(res.failedMonths || []);

    appendGroups(fresh);
    renderProgress();
    renderNotices();
    renderSummary();
    renderEmpty();
  }

  function stopSearch() {
    if (!S.running) return;
    S.token++;
    S.running = false;
    S.stopped = true;
    renderAll();
  }

  function clearAll() {
    S.token++;
    S.running = false;
    S.hasSearched = false;
    S.query = null;
    S.type = 'all';
    S.range = DEFAULT_RANGE;
    S.items.clear();
    S.categories.clear();
    S.payments.clear();
    S.paid = '';
    $('srInput').value = '';
    $('srMinAmount').value = '';
    $('srMaxAmount').value = '';
    resetResults();
    renderFilterChoices();
    syncControls();
    renderAll();
    $('srInput').focus();
  }

  function renderAll() {
    syncControls();
    renderProgress();
    renderNotices();
    renderSummary();
    renderEmpty();
    $('srResults').classList.toggle('is-stale', S.stale);
  }

  function renderProgress() {
    const box = $('srProgress');
    const total = S.plannedMonths.length;
    box.hidden = !S.running;
    if (!S.running) return;
    const pct = total ? Math.min(100, Math.round(S.doneMonths / total * 100)) : 0;
    $('srProgressText').textContent = '已搜尋 ' + S.doneMonths + ' / ' + total + ' 個月';
    $('srProgressFill').style.setProperty('--p', pct / 100);
    $('srProgressTrack').setAttribute('aria-valuenow', String(pct));
  }

  function rangeText(months) {
    const list = months.slice().sort();
    if (list.length <= 3) return list.join('、');
    return list[0] + '～' + list[list.length - 1];
  }

  function renderNotices() {
    const box = $('srNotices');
    const parts = [];

    if (S.skipped.length) {
      parts.push('<div class="sr-notice">已略過 ' + S.skipped.length + ' 個舊格式月份（' + escHtml(rangeText(S.skipped)) + '）</div>');
    }
    if (S.failed.length) {
      parts.push('<div class="sr-notice is-warn">有 ' + S.failed.length + ' 個月份讀取失敗（' + escHtml(rangeText(S.failed)) + '），結果不完整</div>');
    }
    if (S.capped) {
      parts.push('<div class="sr-notice is-warn">結果過多，僅列出最近 ' + MAX_RECORDS + ' 筆，請縮小範圍（統計數字仍涵蓋全部命中）</div>');
    } else if (S.truncated) {
      parts.push('<div class="sr-notice is-warn">單批命中超過 300 筆，較舊的明細未列出，請縮小範圍（統計數字仍涵蓋全部命中）</div>');
    }
    if (S.stopped) {
      parts.push('<div class="sr-notice">已停止搜尋（已搜尋 ' + S.doneMonths + ' / ' + S.plannedMonths.length + ' 個月），以下僅含已搜尋的月份</div>');
    }
    if (S.error) {
      parts.push('<div class="sr-notice is-error">搜尋中斷：' + escHtml(S.error) + '（以下僅含已搜尋的月份）</div>');
    }
    if (S.stale) {
      parts.push('<div class="sr-notice is-warn sr-notice-action"><span>資料已有異動，搜尋結果可能不是最新的，編輯與刪除已暫停。</span><button type="button" class="sr-link-btn" data-sr-rerun>重新搜尋</button></div>');
    }
    if (S.requeryFailed.size) {
      parts.push('<div class="sr-notice is-error sr-notice-action"><span>部分月份刪除後重新讀取失敗（' + escHtml(rangeText(Array.from(S.requeryFailed))) + '），請重新搜尋。</span><button type="button" class="sr-link-btn" data-sr-rerun>重新搜尋</button></div>');
    }
    box.innerHTML = parts.join('');
  }

  function renderEmpty() {
    const box = $('srEmpty');
    if (!S.hasSearched) {
      box.innerHTML = '<div class="sr-hint"><div class="sr-hint-title">搜尋所有月份的交易</div>' +
        '<p>輸入關鍵字（多個關鍵字用空白分隔，需全部符合），或只用篩選條件，例如「近 3 個月所有用某張信用卡的支出」。</p></div>';
      return;
    }
    if (S.running || totalHitCount() > 0) {
      box.innerHTML = '';
      return;
    }
    const noMonths = S.plannedMonths.length === 0;
    const allSkipped = !noMonths && S.skipped.length >= S.plannedMonths.length;
    let msg = '試著放寬關鍵字或篩選條件。';
    if (noMonths) msg = '所選範圍內沒有可搜尋的月份。';
    else if (allSkipped) msg = '所選範圍內的月份都是舊格式，無法搜尋。';
    else if (S.range !== 'all') msg = '目前範圍沒有符合的紀錄，可以放寬到全部月份試試。';
    box.innerHTML = '<div class="sr-empty-card"><div class="sr-empty-title">找不到符合的紀錄</div><p>' + escHtml(msg) + '</p>' +
      (S.range !== 'all' ? '<button type="button" class="sr-primary-btn" data-sr-all-months>改搜全部月份</button>' : '') +
      '</div>';
  }

  function topItems(type) {
    const byItem = typeTotals(type).byItem;
    const keys = Object.keys(byItem);
    if (keys.length < 2) return [];
    return keys
      .map(function (k) { return { name: k, count: byItem[k].count, total: byItem[k].total }; })
      .sort(function (a, b) { return Math.abs(b.total) - Math.abs(a.total); })
      .slice(0, 3);
  }

  function renderSummary() {
    const el = $('srSummary');
    const types = activeTypes();
    const count = totalHitCount();
    if (!S.hasSearched || count === 0) {
      el.hidden = true;
      el.innerHTML = '';
      return;
    }

    const agg = {};
    types.forEach(function (t) { agg[t] = typeTotals(t); });
    const monthSet = new Set();
    types.forEach(function (t) { agg[t].months.forEach(function (m) { monthSet.add(m); }); });
    const months = Array.from(monthSet).sort().reverse();

    let html = '<div class="sr-sum-card">';
    if (types.length === 1) {
      const t = types[0];
      const a = agg[t];
      html += '<div class="sr-sum-big">共 ' + a.count + ' 筆，合計 <span class="' + (t === 'income' ? 'is-inc' : 'is-exp') + '">' + escHtml(typeMoney(t, a.total)) + '</span></div>';
      html += '<div class="sr-sum-sub">平均每筆 ' + escHtml(typeMoney(t, a.count ? a.total / a.count : 0)) + '，涵蓋 ' + months.length + ' 個月</div>';
    } else {
      html += '<div class="sr-sum-big">共 ' + count + ' 筆</div>';
      html += '<div class="sr-sum-split">';
      types.forEach(function (t) {
        const a = agg[t];
        html += '<div class="sr-sum-split-item ' + (t === 'income' ? 'is-inc' : 'is-exp') + '">' +
          '<span class="sr-sum-split-label">' + (t === 'income' ? '收入' : '支出') + '</span>' +
          '<span class="sr-sum-split-amt">' + escHtml(typeMoney(t, a.total)) + '</span>' +
          '<span class="sr-sum-split-meta">' + a.count + ' 筆' + (a.count ? '，平均 ' + escHtml(typeMoney(t, a.total / a.count)) : '') + '</span></div>';
      });
      html += '</div>';
      html += '<div class="sr-sum-sub">支出與收入分開加總，涵蓋 ' + months.length + ' 個月</div>';
    }

    const maxByType = {};
    types.forEach(function (t) {
      maxByType[t] = 0;
      months.forEach(function (m) {
        const mm = S.stats[t].byMonth[m];
        if (mm) maxByType[t] = Math.max(maxByType[t], Math.abs(mm.total));
      });
    });
    const hasGroup = {};
    $('srResults').querySelectorAll('.sr-group').forEach(function (g) { hasGroup[g.dataset.month] = true; });

    const showAllBars = S.barsExpanded || months.length <= BARS_COLLAPSED_ROWS + 1;
    const rows = showAllBars ? months : months.slice(0, BARS_COLLAPSED_ROWS);
    html += '<div class="sr-sum-block"><div class="sr-sum-title">每月分布 <small>點月份跳到該月結果</small></div><div class="sr-bars">';
    rows.forEach(function (m) {
      const clickable = hasGroup[m];
      html += '<' + (clickable ? 'button type="button"' : 'div') + ' class="sr-bar-row' + (clickable ? '' : ' is-static') + '" data-month="' + escAttr(m) + '"' +
        (clickable ? ' aria-label="跳到 ' + escAttr(m) + ' 的結果"' : '') + '>';
      html += '<span class="sr-bar-month">' + escHtml(m) + '</span><span class="sr-bar-track">';
      types.forEach(function (t) {
        const mm = S.stats[t].byMonth[m];
        const v = mm ? Math.abs(mm.total) : 0;
        const w = maxByType[t] > 0 && v > 0 ? Math.max(3, Math.round(v / maxByType[t] * 100)) : 0;
        const isMax = mm && v > 0 && v === maxByType[t] && months.length > 1;
        html += '<span class="sr-bar-fill ' + (t === 'income' ? 'is-inc' : 'is-exp') + (isMax ? ' is-max' : '') + '" style="width:' + w + '%"></span>';
      });
      html += '</span><span class="sr-bar-amt">';
      types.forEach(function (t) {
        const mm = S.stats[t].byMonth[m];
        html += '<span class="' + (t === 'income' ? 'is-inc' : 'is-exp') + '">' + (mm ? escHtml(typeMoney(t, mm.total)) : '無') + '</span>';
      });
      html += '</span></' + (clickable ? 'button' : 'div') + '>';
    });
    html += '</div>';
    if (!showAllBars) {
      html += '<button type="button" class="sr-link-btn sr-bars-toggle" data-sr-bars-toggle>顯示全部 ' + months.length + ' 個月</button>';
    } else if (S.barsExpanded && months.length > BARS_COLLAPSED_ROWS + 1) {
      html += '<button type="button" class="sr-link-btn sr-bars-toggle" data-sr-bars-toggle>收合</button>';
    }
    html += '</div>';

    const topBlocks = [];
    types.forEach(function (t) {
      const top = topItems(t);
      if (!top.length) return;
      let chips = '';
      top.forEach(function (it) {
        chips += '<span class="sr-top-chip ' + (t === 'income' ? 'is-inc' : 'is-exp') + '">' +
          '<b>' + itemIconLabelHtml(it.name) + '</b>' +
          '<span>' + escHtml(typeMoney(t, it.total)) + '</span><small>' + it.count + ' 筆</small></span>';
      });
      topBlocks.push('<div class="sr-top-row">' + (types.length > 1 ? '<span class="sr-top-label">' + (t === 'income' ? '收入' : '支出') + '</span>' : '') + chips + '</div>');
    });
    if (topBlocks.length) {
      html += '<div class="sr-sum-block"><div class="sr-sum-title">金額前 3 名的項目</div>' + topBlocks.join('') + '</div>';
    }

    html += '</div>';
    el.innerHTML = html;
    el.hidden = false;
  }

  function recordsOfMonth(month) {
    return S.records.filter(function (r) { return r.month === month; });
  }

  function groupHeadHtml(month) {
    const types = activeTypes();
    const bits = [];
    let count = 0;
    types.forEach(function (t) {
      const mm = S.stats[t].byMonth[month];
      if (mm) count += mm.count;
    });
    bits.push(count + ' 筆');
    const present = types.filter(function (t) { return S.stats[t].byMonth[month]; });
    present.forEach(function (t) {
      const mm = S.stats[t].byMonth[month];
      const label = types.length > 1 ? (t === 'income' ? '收入 ' : '支出 ') : '';
      bits.push('<span class="' + (t === 'income' ? 'is-inc' : 'is-exp') + '">' + label + escHtml(typeMoney(t, mm.total)) + '</span>');
    });
    return '<span class="sr-group-title">' + escHtml(monthTitle(month)) + '</span>' +
      '<span class="sr-group-meta">' + bits.join('，') + '</span>';
  }

  function guardRecordAction(rec) {
    if (S.stale) { showToast('資料已有異動，請先重新搜尋再編輯', 'error'); return false; }
    if (S.refreshing.has(rec.month) || S.requeryFailed.has(rec.month)) {
      showToast('這個月份正在重新讀取，請稍後再試', 'error');
      return false;
    }
    return true;
  }

  function buildSearchItem(rec) {
    const locked = S.refreshing.has(rec.month) || S.requeryFailed.has(rec.month);
    const el = buildRecentItem(rec, rec.type, {
      terms: S.query ? S.query.terms : [],
      dateLabel: fullDateLabel(rec),
      locked: locked,
      lockedHint: '這個月份正在重新讀取，暫無法修改',
      onEdit: function (r, type) { if (guardRecordAction(r)) openEditModal(r, type, r.month); },
      onDelete: function (r, type) { if (guardRecordAction(r)) openDeleteModal(r, type, r.month); },
    });
    el.classList.add('sr-item');
    if (rec.type === 'income') el.classList.add('income-rec');
    return el;
  }

  function fillGroup(section, month) {
    section.querySelector('.sr-group-head').innerHTML = groupHeadHtml(month);
    const list = section.querySelector('.sr-list');
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    recordsOfMonth(month).forEach(function (rec) { frag.appendChild(buildSearchItem(rec)); });
    list.appendChild(frag);
    section.classList.toggle('is-refreshing', S.refreshing.has(month));
  }

  function buildGroup(month) {
    const section = document.createElement('section');
    section.className = 'sr-group';
    section.dataset.month = month;
    section.innerHTML = '<div class="sr-group-head"></div><div class="recent-list sr-list"></div>';
    fillGroup(section, month);
    return section;
  }

  function appendGroups(freshRecords) {
    const box = $('srResults');
    const order = [];
    const seen = new Set();
    freshRecords.forEach(function (r) {
      if (!seen.has(r.month)) { seen.add(r.month); order.push(r.month); }
    });
    order.forEach(function (m) {
      if (!box.querySelector('.sr-group[data-month="' + m + '"]')) box.appendChild(buildGroup(m));
    });
  }

  function refreshGroup(month) {
    const box = $('srResults');
    let section = box.querySelector('.sr-group[data-month="' + month + '"]');
    const hasRecords = recordsOfMonth(month).length > 0;
    if (!hasRecords) {
      if (section) section.remove();
      return;
    }
    if (!section) {
      section = buildGroup(month);
      const groups = Array.from(box.querySelectorAll('.sr-group'));
      const next = groups.find(function (g) { return g.dataset.month < month; });
      if (next) box.insertBefore(section, next); else box.appendChild(section);
      return;
    }
    fillGroup(section, month);
  }

  function scrollToMonth(month) {
    const g = $('srResults').querySelector('.sr-group[data-month="' + month + '"]');
    if (!g) return;
    g.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
    if (!reduceMotion()) {
      g.classList.add('is-flash');
      setTimeout(function () { g.classList.remove('is-flash'); }, 1200);
    }
  }

  function findRecord(month, type, row) {
    for (let i = 0; i < S.records.length; i++) {
      const r = S.records[i];
      if (r.month === month && r.type === type && r.row === row) return i;
    }
    return -1;
  }

  function onRecordUpdated(info) {
    if (!info) return;
    S.seenVersion = state.mutationVersion;
    if (S.running) S.stale = true;
    const idx = findRecord(info.month, info.type, Number(info.row));
    if (idx === -1) { renderAll(); return; }

    const old = S.records[idx];
    const src = info.record || {};
    const next = Object.assign({}, old, {
      day: src.day !== undefined ? src.day : old.day,
      item: src.item !== undefined ? src.item : old.item,
      category: src.category !== undefined ? src.category : old.category,
      payment: old.type === 'expense' && src.payment !== undefined ? src.payment : old.payment,
      paid: old.type === 'expense' && src.paid !== undefined ? src.paid : old.paid,
      amount: src.amount !== undefined ? Number(src.amount) : old.amount,
      note: src.note !== undefined ? src.note : old.note,
    });
    statsApply(old, -1);
    statsApply(next, +1);
    S.records[idx] = next;
    sortRecords();
    refreshGroup(info.month);
    renderAll();
  }

  function onRecordDeleted(info) {
    if (!info) return;
    S.seenVersion = state.mutationVersion;
    if (S.running) S.stale = true;
    const month = info.month;
    const idx = findRecord(month, info.type, Number(info.row));
    if (idx !== -1) {
      statsApply(S.records[idx], -1);
      S.records.splice(idx, 1);
    }
    if (!S.query) { renderAll(); return; }

    S.refreshing.add(month);
    S.requeryFailed.delete(month);
    refreshGroup(month);
    renderAll();

    const token = S.token;
    Api.server
      .withSuccessHandler(function (res) {
        if (token !== S.token) return;
        replaceMonth(month, res);
      })
      .withFailureHandler(function () {
        if (token !== S.token) return;
        S.refreshing.delete(month);
        S.requeryFailed.add(month);
        refreshGroup(month);
        renderAll();
        showToast('重新讀取 ' + month + ' 失敗，請重新搜尋', 'error');
      })
      .searchRecords(payloadFromQuery(S.query, [month]));
  }

  function replaceMonth(month, res) {
    res = res || {};
    S.records = S.records.filter(function (r) { return r.month !== month; });
    ['expense', 'income'].forEach(function (t) { delete S.stats[t].byMonth[month]; });

    const byType = (res.stats && res.stats.byType) || {};
    ['expense', 'income'].forEach(function (t) {
      const src = (byType[t] && byType[t].byMonth && byType[t].byMonth[month]) || null;
      if (src) S.stats[t].byMonth[month] = src;
    });
    (res.results || []).forEach(function (rec) { S.records.push(rec); });
    if (res.truncated) S.truncated = true;
    sortRecords();

    S.refreshing.delete(month);
    S.requeryFailed.delete(month);
    refreshGroup(month);
    renderAll();
  }

  function onEnter() {
    S.active = true;
    fillMonthSelects();
    renderFilterChoices();
    renderRecentChips();

    if (S.hasSearched && !S.running && state.mutationVersion !== S.seenVersion) {
      S.stale = true;
    }
    renderAll();
    measureHead();

    const input = $('srInput');
    try { input.focus({ preventScroll: true }); } catch (e) { input.focus(); }
  }

  function onLeave() {
    if (!S.active) return;
    S.active = false;
    if (S.running) {
      S.token++;
      S.running = false;
      S.stopped = true;
    }
    const input = $('srInput');
    if (input && document.activeElement === input) input.blur();
    renderAll();
  }

  function init() {
    if (!$('pageSearch')) return;
    loadRecentList();
    renderRecentChips();
    renderEmpty();

    $('srForm').addEventListener('submit', function (e) {
      e.preventDefault();
      startSearch();
    });
    $('srInput').addEventListener('input', function () {
      $('srClearBtn').hidden = $('srInput').value === '';
      $('srClearAll').hidden = !hasAnythingToClear();
    });
    $('srClearBtn').addEventListener('click', function () {
      $('srInput').value = '';
      syncControls();
      $('srInput').focus();
    });

    document.querySelectorAll('#pageSearch [data-sr-type]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        S.type = btn.dataset.srType;
        if (S.type === 'income') { S.payments.clear(); S.paid = ''; }
        renderFilterChoices();
        syncControls();
      });
    });
    document.querySelectorAll('#pageSearch [data-sr-range]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        S.range = btn.dataset.srRange;
        if (S.range === 'custom') fillMonthSelects();
        syncControls();
      });
    });
    document.querySelectorAll('#pageSearch [data-sr-paid]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        S.paid = btn.dataset.srPaid;
        syncControls();
      });
    });
    $('srFromMonth').addEventListener('change', function (e) { S.customFrom = e.target.value; });
    $('srToMonth').addEventListener('change', function (e) { S.customTo = e.target.value; });
    $('srMinAmount').addEventListener('input', syncControls);
    $('srMaxAmount').addEventListener('input', syncControls);

    $('srMoreToggle').addEventListener('click', function () {
      S.moreOpen = !S.moreOpen;
      syncControls();
    });
    $('srClearAll').addEventListener('click', clearAll);
    $('srStopBtn').addEventListener('click', stopSearch);
    $('srRecentClearAll').addEventListener('click', function () {
      S.recentList = [];
      persistRecentList();
      renderRecentChips();
    });

    $('pageSearch').addEventListener('click', function (e) {
      const t = e.target;
      if (!t || !t.closest) return;
      const bar = t.closest('.sr-bar-row[data-month]');
      if (bar && !bar.classList.contains('is-static')) { scrollToMonth(bar.dataset.month); return; }
      if (t.closest('[data-sr-bars-toggle]')) { S.barsExpanded = !S.barsExpanded; renderSummary(); return; }
      if (t.closest('[data-sr-rerun]')) { startSearch(); return; }
      if (t.closest('[data-sr-all-months]')) {
        S.range = 'all';
        syncControls();
        startSearch();
      }
    });

    if (window.ResizeObserver && $('srHead')) {
      new ResizeObserver(measureHead).observe($('srHead'));
    }
    window.addEventListener('resize', measureHead);
  }

  init();

  return {
    getOrigin: function () { return S.origin; },
    setOrigin: function (page) { S.origin = (page === 'overview') ? 'overview' : 'bookkeeping'; },
    onEnter: onEnter,
    onLeave: onLeave,
    onRecordUpdated: onRecordUpdated,
    onRecordDeleted: onRecordDeleted,
  };
})();
