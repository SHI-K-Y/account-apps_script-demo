const ForeignPage = (function () {
  const $ = id => document.getElementById(id);

  const FLAGS = {
    '韓國': 'KR', '日本': 'JP', '美國': 'US', '香港': 'HK', '中國': 'CN', '印度': 'IN', '印尼': 'ID',
    '泰國': 'TH', '越南': 'VN', '菲律賓': 'PH', '馬來西亞': 'MY', '新加坡': 'SG', '歐洲': 'EU',
  };
  const CUR_SYMBOL = {
    NTD: 'NT$', KRW: '₩', JPY: '¥', USD: 'US$', HKD: 'HK$', CNY: 'CN¥', THB: '฿', VND: '₫',
    PHP: '₱', MYR: 'RM', SGD: 'S$', EUR: '€', INR: '₹', IDR: 'Rp',
  };
  const NO_DECIMAL_CURRENCIES = ['NTD', 'KRW', 'JPY', 'VND', 'IDR'];
  const HOME = 'NTD';
  const ITEM_ICON_DEFAULT = {
    '飲食': 'bowl-steam', '交通費': 'subway', '住宿費': 'bed', '景點/門票': 'ticket', '購物': 'shopping-bag', '通訊': 'sim-card',
    '金融手續費': 'bank', '保險/醫療': 'stethoscope', '小費': 'hand-coins', '其他': 'package',
  };
  const FX_ITEM_CATEGORY = { '購物': 'bigexpense', '金融手續費': 'finance', '小費': 'other' };
  const DEFAULT_ITEMS = ['飲食', '交通費', '住宿費', '景點/門票', '購物', '通訊', '金融手續費', '保險/醫療', '小費', '其他'];
  const DEFAULT_COUNTRY_CURRENCY = {
    '台灣': 'NTD', '韓國': 'KRW', '日本': 'JPY', '美國': 'USD', '香港': 'HKD', '中國': 'CNY', '印度': 'INR',
    '印尼': 'IDR', '泰國': 'THB', '越南': 'VND', '菲律賓': 'PHP', '馬來西亞': 'MYR', '新加坡': 'SGD', '歐洲': 'EUR',
  };
  const DEFAULT_CURRENCIES = ['NTD', 'KRW', 'JPY', 'USD', 'HKD', 'CNY', 'INR', 'IDR', 'THB', 'VND', 'PHP', 'MYR', 'SGD', 'EUR'];
  const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
  const NAME_MAX = 30;
  const INVALID_NAME = /[\[\]\*\?\/\\:]/;
  const PREFIX = '國外交易記帳簿-';
  const TEMPLATE_NAME = '空白頁';
  const DETAIL_PAGE_SIZE = 50;
  const RECENT_LIMIT = 5;
  const RATE_MAX = 10000;

  const ui = {
    active: false,
    listLoading: false,
    listToken: 0,
    archivedOpen: false,
    rateEditing: false,
    moreCurrencies: false,
    calYear: 0,
    calMonth: 0,
    detailCount: DETAIL_PAGE_SIZE,
    detailObserver: null,
    statsFocus: null,
    statsDirty: true,
    inflight: {},
    version: {},
    resync: {},
    loadingLedger: {},
    ledgerError: {},
    ledgerModal: null,
    deleteLedgerBusy: false,
    recordEdit: null,
    recordBusy: false,
    deleteRecord: null,
    prevDone: null,
  };

  function arrOr(list, fallback) {
    return Array.isArray(list) && list.length ? list.slice() : fallback.slice();
  }

  function opts() {
    const o = (state.data && state.data.options) || {};
    const map = o.fxCountryCurrency && Object.keys(o.fxCountryCurrency).length ? o.fxCountryCurrency : DEFAULT_COUNTRY_CURRENCY;
    const countries = arrOr(o.fxCountries, Object.keys(DEFAULT_COUNTRY_CURRENCY))
      .filter(c => c !== '台灣' && map[c] !== HOME);
    const currencies = arrOr(o.fxCurrencies, DEFAULT_CURRENCIES);
    if (currencies.indexOf(HOME) === -1) currencies.unshift(HOME);
    return {
      items: arrOr(o.fxItems, DEFAULT_ITEMS),
      currencies: currencies,
      countries: countries,
      countryCurrency: map,
      payments: arrOr(o.paymentMethods, (typeof DEFAULT_OPTIONS_FALLBACK !== 'undefined' && DEFAULT_OPTIONS_FALLBACK.paymentMethods) || ['現金']),
    };
  }

  function nf(minFrac, maxFrac) {
    return Fmt.nf({ minimumFractionDigits: minFrac, maximumFractionDigits: maxFrac });
  }
  function decimalsOf(cur) { return NO_DECIMAL_CURRENCIES.indexOf(cur) === -1 ? 2 : 0; }
  function symOf(cur) { return CUR_SYMBOL[cur] || (cur ? cur + ' ' : ''); }
  function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
  function fmtTwd(n) {
    const v = Math.round(Number(n) || 0);
    return (v < 0 ? '-' : '') + 'NT$' + nf(0, 0).format(Math.abs(v));
  }
  function fmtNum(amount, cur) {
    const num = Number(amount) || 0;
    const d = decimalsOf(cur);
    const min = d > 0 && !Number.isInteger(num) ? 2 : 0;
    return nf(min, d).format(num);
  }
  function fmtLocal(amount, cur) {
    if (cur === HOME) return fmtTwd(amount);
    return symOf(cur) + fmtNum(amount, cur);
  }
  function fmtRate(rate) {
    const r = Number(rate) || 0;
    if (!r) return '無匯率';
    if (r >= 100) return nf(0, 2).format(r);
    if (r >= 1) return nf(0, 4).format(r);
    return Fmt.num(r, { maximumSignificantDigits: 4 });
  }
  function fmtClock(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    return pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function flagOf(country) {
    const code = FLAGS[country];
    return code
      ? '<span class="fx-flag-code">' + escHtml(code) + '</span>'
      : iconHtml('globe-hemisphere-east', 'regular', 'fx-flag-globe');
  }
  function itemIcon(name) {
    const custom = getCustomItemIconValue(name);
    if (custom) return resolveIconName(custom);
    return ITEM_ICON_DEFAULT[name] || getItemIcon(name) || 'tag';
  }
  function itemColorClass(name) {
    const items = opts().items;
    let idx = items.indexOf(name);
    if (idx === -1) {
      let h = 0;
      for (let i = 0; i < String(name).length; i++) h = (h * 31 + String(name).charCodeAt(i)) >>> 0;
      idx = h;
    }
    return 'fx-c' + ((idx % 10) + 1);
  }

  function todayISO() { return getClientToday().todayISO; }
  function parseIso(iso) { const p = String(iso).split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); }
  function toIso(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function addDays(iso, n) { const d = parseIso(iso); d.setDate(d.getDate() + n); return toIso(d); }
  function daysBetween(a, b) {
    const pa = a.split('-').map(Number);
    const pb = b.split('-').map(Number);
    return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
  }
  function isIso(v) { return /^\d{4}-\d{2}-\d{2}$/.test(String(v || '')); }
  function slash(iso) { return iso ? iso.replace(/-/g, '/') : ''; }
  function mdLabel(iso) {
    if (!isIso(iso)) return '日期不明';
    const d = parseIso(iso);
    return (d.getMonth() + 1) + '/' + d.getDate() + '（' + WEEKDAYS[d.getDay()] + '）';
  }
  function hasPeriod(l) { return l && isIso(l.startDate) && isIso(l.endDate); }
  function tripDays(l) { return hasPeriod(l) ? daysBetween(l.startDate, l.endDate) + 1 : 0; }
  function periodRange(l) {
    if (!hasPeriod(l)) return '期間未設定';
    const sameYear = l.startDate.slice(0, 4) === l.endDate.slice(0, 4);
    return slash(l.startDate) + ' – ' + (sameYear ? l.endDate.slice(5).replace('-', '/') : slash(l.endDate));
  }
  function tripStatus(l, today) {
    if (l.archived) return { key: 'archived', label: '已封存' };
    if (!hasPeriod(l)) return { key: 'unknown', label: '期間未設定' };
    if (today < l.startDate) return { key: 'upcoming', label: '即將出發，' + daysBetween(today, l.startDate) + ' 天後' };
    if (today > l.endDate) return { key: 'ended', label: '已結束' };
    return { key: 'active', label: '進行中，第 ' + (daysBetween(l.startDate, today) + 1) + ' 天' };
  }
  function dayIndexLabel(l, iso) {
    if (!hasPeriod(l) || !isIso(iso)) return '';
    if (iso < l.startDate) return '出發前';
    if (iso > l.endDate) return '旅行結束後';
    return '第 ' + (daysBetween(l.startDate, iso) + 1) + ' 天';
  }

  function keyOf(id) { return id == null ? '' : String(id); }
  function findLedger(id) {
    const key = keyOf(id);
    const fromList = (fxState.ledgers || []).find(l => keyOf(l.id) === key);
    if (fromList) return fromList;
    const d = fxState.dataById[key];
    return d && d.ledger ? d.ledger : null;
  }
  function currentKey() { return keyOf(fxState.currentId); }
  function currentLedger() { return findLedger(fxState.currentId); }
  function currentData() { return fxState.dataById[currentKey()] || null; }

  function getData(key) {
    if (!fxState.dataById[key]) {
      const cached = LocalCache.getFxLedger(key);
      if (cached) fxState.dataById[key] = cached;
    }
    return fxState.dataById[key] || null;
  }

  function sortRecords(list) {
    return list.sort((a, b) => {
      const da = a.date || '';
      const db = b.date || '';
      if (da !== db) return da < db ? 1 : -1;
      const ra = typeof a.row === 'number' ? a.row : Infinity;
      const rb = typeof b.row === 'number' ? b.row : Infinity;
      return rb - ra;
    });
  }

  function allRecords(key) {
    const d = fxState.dataById[key];
    const base = d && Array.isArray(d.records) ? d.records : [];
    const pend = (fxState.pending || []).filter(p => p.ledgerId === key);
    return sortRecords(base.concat(pend));
  }

  function persistData(key) {
    const d = fxState.dataById[key];
    if (d) LocalCache.saveFxLedger(key, d);
  }

  function upsertLedgerInList(ledger) {
    if (!ledger) return;
    const key = keyOf(ledger.id);
    const list = fxState.ledgers || [];
    const idx = list.findIndex(l => keyOf(l.id) === key);
    if (idx === -1) list.push(ledger);
    else list[idx] = Object.assign({}, list[idx], ledger);
    fxState.ledgers = list;
    LocalCache.saveFxList(list);
  }

  function rateFor(key, currency) {
    if (currency === HOME) return 1;
    const d = fxState.dataById[key];
    const rates = d && Array.isArray(d.rates) ? d.rates : [];
    const hit = rates.find(r => r.currency === currency);
    return hit && Number(hit.rate) > 0 ? Number(hit.rate) : null;
  }

  function computeSummary(ledger, records) {
    const today = todayISO();
    let total = 0;
    let todayTotal = 0;
    let inTrip = 0;
    records.forEach(r => {
      const twd = Number(r.twd) || 0;
      total += twd;
      if (r.date === today) todayTotal += twd;
      if (hasPeriod(ledger) && r.date && r.date >= ledger.startDate && r.date <= ledger.endDate) inTrip += twd;
    });
    let elapsed = 0;
    if (hasPeriod(ledger) && today >= ledger.startDate) {
      elapsed = daysBetween(ledger.startDate, today < ledger.endDate ? today : ledger.endDate) + 1;
    }
    return { total: total, today: todayTotal, count: records.length, avg: elapsed > 0 ? inTrip / elapsed : null, elapsed: elapsed, inTrip: inTrip };
  }

  function run(method, args, onOk, onErr) {
    const runner = Api.server
      .withSuccessHandler(res => onOk && onOk(res))
      .withFailureHandler(err => onErr && onErr(err));
    runner[method].apply(runner, args || []);
  }
  function errMsg(err) { return (err && err.message) ? err.message : String(err || '發生未知錯誤'); }

  function beginMutation(key) {
    ui.inflight[key] = (ui.inflight[key] || 0) + 1;
    ui.version[key] = (ui.version[key] || 0) + 1;
  }
  function endMutation(key) {
    ui.inflight[key] = Math.max(0, (ui.inflight[key] || 0) - 1);
    ui.version[key] = (ui.version[key] || 0) + 1;
    if (!ui.inflight[key] && ui.resync[key]) {
      ui.resync[key] = false;
      fetchLedger(key, false, { silent: true });
    }
  }
  function isBusy(key) { return (ui.inflight[key] || 0) > 0; }

  function loadLedgerList(force, opt) {
    const options = opt || {};
    const token = ++ui.listToken;
    ui.listLoading = true;
    if (ui.active && fxState.view === 'list' && !fxState.ledgersLoaded && !(fxState.ledgers || []).length) renderList();
    run('getFxLedgers', [Boolean(force)], res => {
      if (token !== ui.listToken) return;
      ui.listLoading = false;
      RefreshSpin.stop($('fxListRefreshBtn'));
      fxState.ledgers = (res && Array.isArray(res.ledgers)) ? res.ledgers : [];
      fxState.ledgersLoaded = true;
      LocalCache.saveFxList(fxState.ledgers);
      fxState.ledgers.forEach(l => {
        const d = fxState.dataById[keyOf(l.id)];
        if (d && !isBusy(keyOf(l.id))) d.ledger = Object.assign({}, d.ledger || {}, l);
      });
      if (ui.active) {
        if (fxState.view === 'list') renderList();
        else if (fxState.view === 'ledger' && !currentLedger()) {
          showToast('這本帳簿已不存在，已回到帳簿列表。', 'error');
          setView('list', 'back');
        } else if (fxState.view === 'ledger') renderLedgerHeader();
      }
      updateTripHint();
      if (options.prefetchHint) prefetchHintLedger();
      if (force && !options.silent) showToast('已重新讀取國外帳簿', 'success');
    }, err => {
      if (token !== ui.listToken) return;
      ui.listLoading = false;
      RefreshSpin.stop($('fxListRefreshBtn'));
      if (ui.active && fxState.view === 'list') renderList(errMsg(err));
      if (!options.silent) showToast('讀取國外帳簿失敗：' + errMsg(err), 'error');
    });
  }

  function ledgerCardHtml(l, today) {
    const st = tripStatus(l, today);
    const days = tripDays(l);
    const period = hasPeriod(l) ? periodRange(l) + '，' + days + ' 天' : '期間未設定';
    return '<div class="card fx-ledger-card' + (l.archived ? ' is-archived' : '') + '" role="button" tabindex="0" data-fx-open="' + escAttr(l.id) + '"' +
      ' aria-label="' + escAttr(l.name + '，' + st.label + '，總花費 ' + fmtTwd(l.totalTwd)) + '">' +
      '<div class="fx-lc-top"><span class="fx-lc-flag" aria-hidden="true">' + flagOf(l.country) + '</span>' +
      '<span class="fx-lc-name">' + escHtml(l.name) + '</span>' +
      '<span class="fx-status is-' + st.key + '">' + escHtml(st.label) + '</span></div>' +
      '<div class="fx-lc-meta"><span>' + escHtml((l.country || '未設定國家') + '，' + (l.currency || HOME)) + '</span>' +
      '<span>' + escHtml(period) + '</span></div>' +
      '<div class="fx-lc-bottom"><span class="fx-lc-total">' + fmtTwd(l.totalTwd) + '</span>' +
      '<span class="fx-lc-count">' + (Number(l.count) || 0) + ' 筆</span></div></div>';
  }

  const EMPTY_ART = '<svg class="fx-empty-art" viewBox="0 0 120 120" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="30" y="44" width="60" height="50" rx="9"/><path d="M48 44v-9a5 5 0 0 1 5-5h14a5 5 0 0 1 5 5v9"/>' +
    '<line x1="45" y1="44" x2="45" y2="94"/><line x1="75" y1="44" x2="75" y2="94"/>' +
    '<circle cx="42" cy="99" r="3"/><circle cx="78" cy="99" r="3"/>' +
    '<path d="M86 20l-6 6 4 4 6-6" opacity="0.55"/><path d="M96 16c3-3 7-3 8-2s1 5-2 8l-6 6-10-2-2 2 6 4 2 6 2-2-2-10z" opacity="0.7"/>' +
    '<path d="M14 34c6-4 12-4 18 0" opacity="0.4"/><path d="M98 60c5-3 9-3 14 0" opacity="0.4"/></svg>';

  function renderList(errorText) {
    const body = $('fxListBody');
    if (!body) return;
    const ledgers = fxState.ledgers || [];
    const today = todayISO();
    if (!ledgers.length && !fxState.ledgersLoaded) {
      body.innerHTML = errorText
        ? '<div class="card fx-empty"><h2 class="fx-empty-title">讀取失敗</h2><p class="fx-empty-desc">' + escHtml(errorText) + '</p>' +
          '<button type="button" class="submit-btn" data-fx-action="reload-list">' + UvFx.btnRing + '重新讀取</button></div>'
        : '<div class="overview-skeleton fx-list-loading"><div class="skel-block skel-hero"></div><div class="skel-block skel-row"></div></div>';
      return;
    }
    if (!ledgers.length) {
      body.innerHTML = '<div class="card fx-empty">' + EMPTY_ART +
        '<h2 class="fx-empty-title">還沒有國外帳簿</h2>' +
        '<p class="fx-empty-desc">出國前先建立一本帳簿，再開始記錄旅途花費。國外帳簿獨立計算，不會併入每月帳本。</p>' +
        '<button type="button" class="submit-btn" data-fx-action="add-ledger">' + UvFx.btnRing + '＋ 新增第一本帳簿</button></div>';
      Motion.revealCards(body, '.fx-empty');
      return;
    }
    const active = ledgers.filter(l => !l.archived);
    const archived = ledgers.filter(l => l.archived);
    let h = '';
    if (active.length) {
      h += '<div class="fx-list-grid">' + active.map(l => ledgerCardHtml(l, today)).join('') + '</div>';
    } else {
      h += '<div class="card fx-empty"><h2 class="fx-empty-title">沒有使用中的帳簿</h2>' +
        '<p class="fx-empty-desc">下一趟旅行前，新增一本帳簿就能開始記帳。封存的帳簿收在下方。</p>' +
        '<button type="button" class="submit-btn" data-fx-action="add-ledger">' + UvFx.btnRing + '＋ 新增帳簿</button></div>';
    }
    if (archived.length) {
      h += '<details class="fx-archived" id="fxArchivedBox"' + (ui.archivedOpen ? ' open' : '') + '>' +
        '<summary>已封存（' + archived.length + '）</summary>' +
        '<div class="fx-list-grid">' + archived.map(l => ledgerCardHtml(l, today)).join('') + '</div></details>';
    }
    const firstPaint = !body.querySelector('.fx-ledger-card');
    body.innerHTML = h;
    const box = $('fxArchivedBox');
    if (box) box.addEventListener('toggle', () => { ui.archivedOpen = box.open; });
    if (firstPaint) Motion.revealCards(body, '.fx-ledger-card, .fx-empty');
  }

  function setView(view, dir, update) {
    const page = $('pageForeign');
    const apply = () => {
      fxState.view = view;
      if (page) page.dataset.view = view;
      if (typeof update === 'function') update();
      if (view === 'list') renderList();
      closeMenu();
      closeCalendar();
      Motion.cancelScroll();
      window.scrollTo({ top: 0 });
      document.querySelectorAll('.fx-head').forEach(h => h.classList.remove('head-hidden'));
    };
    const lv = Motion.level();
    if (!ui.active || !dir || lv === 'off') { apply(); return; }
    if (typeof document.startViewTransition === 'function') {
      Motion.viewTransition(apply, lv === 'full' ? 'page-' + dir : 'page-fade');
      return;
    }
    apply();
    if (page) {
      clearTimeout(page._fxEnterTimer);
      page.classList.remove('page-enter-forward', 'page-enter-back');
      void page.offsetWidth;
      page.classList.add(dir === 'back' ? 'page-enter-back' : 'page-enter-forward');
      page._fxEnterTimer = setTimeout(() => page.classList.remove('page-enter-forward', 'page-enter-back'), Motion.dur('slow') + 80);
    }
  }

  function openLedger(id, opt) {
    const options = opt || {};
    const key = keyOf(id);
    if (!findLedger(key) && !getData(key)) {
      showToast('找不到這本帳簿，請重新讀取。', 'error');
      return;
    }
    getData(key);
    fxState.currentId = key;
    const prefs = LocalCache.getFxPrefs()[key] || {};
    fxState.tab = options.tab || prefs.tab || 'entry';
    fxState.filter = 'all';
    ui.detailCount = DETAIL_PAGE_SIZE;
    ui.statsFocus = null;
    ui.statsDirty = true;
    resetForm(key, true);
    const render = () => renderLedger();
    if (options.instant) {
      fxState.view = 'ledger';
      if ($('pageForeign')) $('pageForeign').dataset.view = 'ledger';
      render();
    } else {
      setView('ledger', 'forward', render);
    }
    fetchLedger(key, false);
  }

  function fetchLedger(key, force, opt) {
    const options = opt || {};
    const version = ui.version[key] || 0;
    ui.loadingLedger[key] = true;
    ui.ledgerError[key] = '';
    run('getFxLedgerData', [Number(key), Boolean(force)], res => {
      ui.loadingLedger[key] = false;
      if (!res) return;
      const stale = (ui.version[key] || 0) !== version || isBusy(key);
      const d = fxState.dataById[key] || {};
      if (stale) {
        d.rates = res.rates;
        d.ratesFetchedAt = res.ratesFetchedAt;
        fxState.dataById[key] = d;
        if (!d.records) ui.resync[key] = true;
      } else {
        fxState.dataById[key] = {
          ledger: res.ledger,
          records: Array.isArray(res.records) ? res.records : [],
          rates: res.rates,
          ratesFetchedAt: res.ratesFetchedAt,
          blankRow: res.blankRow,
        };
        upsertLedgerInList(res.ledger);
      }
      persistData(key);
      if (key === currentKey()) {
        if (!fxState.form.rateManual) {
          const r = rateFor(key, fxState.form.currency);
          fxState.form.rate = r;
        }
        if (ui.active && fxState.view === 'ledger') renderLedger({ keepForm: true });
        if (force && !options.silent) showToast('已重新讀取帳簿', 'success');
      }
      updateTripHint();
    }, err => {
      ui.loadingLedger[key] = false;
      ui.ledgerError[key] = errMsg(err);
      if (key === currentKey() && ui.active && fxState.view === 'ledger') {
        if (!fxState.dataById[key] || !fxState.dataById[key].records) renderLedger({ keepForm: true });
        if (!options.silent) showToast('讀取帳簿失敗：' + errMsg(err), 'error');
      }
    });
  }

  function renderLedger(opt) {
    const options = opt || {};
    const ledger = currentLedger();
    if (!ledger) return;
    renderLedgerHeader();
    renderTabs();
    if (!options.keepForm) renderForm();
    else { renderRateBox(); renderAmount(); renderCurrencyChoices(); }
    renderDynamic();
  }

  function renderLedgerHeader() {
    const ledger = currentLedger();
    if (!ledger) return;
    const today = todayISO();
    $('fxLedgerTitle').innerHTML = '<span class="fx-ledger-title-flag">' + flagOf(ledger.country) + '</span>' +
      '<span class="fx-ledger-title-name">' + escHtml(ledger.name) + '</span>';
    let sub = periodRange(ledger);
    if (hasPeriod(ledger)) {
      const days = tripDays(ledger);
      const st = tripStatus(ledger, today);
      if (st.key === 'active') sub += '，第 ' + (daysBetween(ledger.startDate, today) + 1) + ' 天／共 ' + days + ' 天';
      else if (st.key === 'upcoming') sub += '，' + daysBetween(today, ledger.startDate) + ' 天後出發／共 ' + days + ' 天';
      else sub += '，共 ' + days + ' 天' + (ledger.archived ? '（已封存）' : '（已結束）');
    }
    $('fxLedgerSubtitle').textContent = sub;
    const link = $('fxLedgerSheetLink');
    if (link) link.href = ledger.sheetUrl || '#';
  }

  function renderDynamic() {
    const key = currentKey();
    const ledger = currentLedger();
    if (!ledger) return;
    const records = allRecords(key);
    const sum = computeSummary(ledger, records);
    setMoney($('fxSumTotal'), sum.total);
    setMoney($('fxSumToday'), sum.today);
    const avgEl = $('fxSumAvg');
    if (sum.avg == null) {
      avgEl.textContent = '無資料';
      avgEl._countCurrent = undefined;
    } else {
      setMoney(avgEl, sum.avg);
    }
    renderRecentList(records);
    if (fxState.tab === 'detail') renderDetail();
    ui.statsDirty = true;
    if (fxState.tab === 'stats') renderStats(false);
    updateTripHint();
  }

  function setMoney(el, value) {
    if (!el) return;
    const v = Math.round(Number(value) || 0);
    if (typeof el._countCurrent === 'number' && Math.round(el._countCurrent) !== v) {
      Motion.countUp(el, el._countCurrent, v, { format: fmtTwd, duration: 500 });
    } else {
      el._countCurrent = v;
      el.textContent = fmtTwd(v);
    }
  }

  function loadingOrError(key) {
    if (ui.ledgerError[key]) {
      return '<div class="empty">讀取失敗：' + escHtml(ui.ledgerError[key]) +
        ' <button type="button" class="fx-link-btn" data-fx-action="reload-ledger">重新讀取</button></div>';
    }
    return '<div class="empty">讀取中…</div>';
  }

  function recordRowHtml(r, opt) {
    const options = opt || {};
    const isHome = r.currency === HOME;
    const meta = (options.showDate ? mdLabel(r.date) + '，' : '') + (r.payment || '');
    const actBtn = (act, icon, label) => {
      const text = r.isPending ? '資料同步中，暫無法' + label : label + '此筆交易紀錄';
      return '<button type="button" class="recent-act-btn ' + act + '-btn" data-fx-rec-act="' + act + '"' +
        (r.isPending ? ' disabled' : '') + ' title="' + escAttr(text) + '" aria-label="' + escAttr(text) + '">' +
        iconHtml(icon, 'regular', 'ic-14') + '</button>';
    };
    return '<div class="fx-rec' + (r.isPending ? ' is-pending' : '') + '"' +
      (r.isPending ? ' data-temp-id="' + escAttr(r.tempId) + '" aria-disabled="true"' : ' data-row="' + escAttr(r.row) + '"') + '>' +
      '<div class="fx-rec-emoji" aria-hidden="true">' + iconHtml(itemIcon(r.item)) + '</div>' +
      '<div class="fx-rec-main"><strong>' + escHtml(r.item) +
        (r.isPending ? '<span class="recent-pending-badge">同步中…</span>' : '') + '</strong>' +
        (r.note ? '<span class="fx-rec-note">' + escHtml(r.note) + '</span>' : '') +
        '<span class="fx-rec-pay">' + escHtml(meta) + '</span></div>' +
      '<div class="fx-rec-right"><div class="fx-rec-local">' + escHtml(fmtLocal(r.amount, r.currency)) + '</div>' +
        (isHome ? '' : '<div class="fx-rec-twd">' + escHtml(fmtTwd(r.twd)) + '</div>') +
        '<div class="recent-actions fx-rec-actions">' + actBtn('edit', 'note-pencil', '修改') + actBtn('delete', 'trash', '刪除') + '</div>' +
      '</div></div>';
  }

  function renderRecentList(records) {
    const box = $('fxRecentList');
    if (!box) return;
    const key = currentKey();
    const d = fxState.dataById[key];
    if (!d || !Array.isArray(d.records)) {
      ListRender.reconcile(box, [], { empty: loadingOrError(key) });
      $('fxRecentMeta').textContent = '';
      return;
    }
    const list = records.slice(0, RECENT_LIMIT);
    ListRender.setText($('fxRecentMeta'), records.length ? '共 ' + records.length + ' 筆' : '');
    reconcileRecordRows(box, list, () => true, '<div class="empty">這本帳簿還沒有紀錄，從上方開始記第一筆吧。</div>');
  }

  // 明細列以 key（列號或 tempId）比對（P06）：每列的 HTML 就是它的簽章，內容沒變的列完全不動；
  // ident 讓「同步中 → 已同步」、刪除後列號位移的列沿用原本的節點。
  function fxRecordKey(r) { return r.isPending ? 't:' + r.tempId : 'r:' + r.row; }
  function fxRecordIdent(r) {
    return [r.date || '', r.item || '', r.payment || '', r.currency || '', Number(r.amount) || 0, r.note || ''].join('\u0001');
  }
  function reconcileRecordRows(box, list, showDate, empty) {
    const htmlOf = r => recordRowHtml(r, { showDate: showDate(r) });
    return ListRender.reconcile(box, list, {
      key: fxRecordKey,
      ident: fxRecordIdent,
      sig: htmlOf,
      html: htmlOf,
      empty: empty,
    });
  }

  const TAB_ORDER = ['entry', 'detail', 'stats'];
  function renderTabs() {
    const idx = Math.max(0, TAB_ORDER.indexOf(fxState.tab));
    const tabs = $('fxTabs');
    tabs.dataset.active = String(idx);
    tabs.querySelectorAll('.tab').forEach(btn => {
      const on = btn.dataset.fxTab === fxState.tab;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $('fxPaneEntry').hidden = fxState.tab !== 'entry';
    $('fxPaneDetail').hidden = fxState.tab !== 'detail';
    $('fxPaneStats').hidden = fxState.tab !== 'stats';
  }

  function switchTab(tab) {
    if (TAB_ORDER.indexOf(tab) === -1 || tab === fxState.tab) return;
    const prevIdx = TAB_ORDER.indexOf(fxState.tab);
    fxState.tab = tab;
    LocalCache.saveFxPref(currentKey(), { tab: tab });
    closeCalendar();
    renderTabs();
    if (tab === 'detail') { ui.detailCount = DETAIL_PAGE_SIZE; renderDetail(); }
    if (tab === 'stats') renderStats(true);
    if (tab === 'entry') { renderPaymentChoices('fxPaymentChoices', paymentListWith(fxState.form.payment), fxState.form.payment, setPayment); }
    const pane = $(tab === 'entry' ? 'fxPaneEntry' : tab === 'detail' ? 'fxPaneDetail' : 'fxPaneStats');
    const offset = TAB_ORDER.indexOf(tab) > prevIdx ? 24 : -24;
    Motion.animate(pane, {
      full: [{ opacity: 0, transform: 'translateX(' + offset + 'px)' }, { opacity: 1, transform: 'none' }],
      lite: [{ opacity: 0 }, { opacity: 1 }]
    }, { duration: Motion.dur('slow'), easing: Motion.ease('out') });
    Motion.cancelScroll();
    window.scrollTo({ top: 0 });
    document.querySelectorAll('.fx-head').forEach(h => h.classList.remove('head-hidden'));
  }

  function resetForm(key, full) {
    const ledger = findLedger(key);
    const prefs = LocalCache.getFxPrefs()[key] || {};
    const o = opts();
    const f = fxState.form;
    if (full) {
      f.date = todayISO();
      f.payment = prefs.payment || '現金';
      const primary = (ledger && ledger.currency) || HOME;
      f.currency = (prefs.currency && o.currencies.indexOf(prefs.currency) !== -1) ? prefs.currency : primary;
      f.rate = rateFor(key, f.currency);
      f.rateManual = false;
      ui.moreCurrencies = false;
    }
    f.item = '';
    f.amount = '';
    f.note = '';
    ui.rateEditing = false;
  }

  function paymentListWith(extra) {
    const list = opts().payments.slice();
    if (extra && list.indexOf(extra) === -1) list.push(extra);
    return list;
  }

  function renderForm() {
    const f = fxState.form;
    const dateInput = $('fxDate');
    if (dateInput) dateInput.value = f.date || todayISO();
    renderDateHint();
    renderItemChoices('fxItemChoices', f.item, setItem);
    renderPaymentChoices('fxPaymentChoices', paymentListWith(f.payment), f.payment, setPayment);
    renderCurrencyChoices();
    buildKeypad();
    renderAmount();
    renderRateBox();
    $('fxNote').value = f.note || '';
    renderStepDots();
  }

  function renderDateHint() {
    const el = $('fxDateHint');
    const ledger = currentLedger();
    if (!el || !ledger) return;
    const date = $('fxDate').value;
    const label = dayIndexLabel(ledger, date);
    el.innerHTML = label ? iconHtml('calendar-blank') + escHtml(mdLabel(date) + '，' + label) : '';
    el.classList.toggle('is-warn', label === '出發前' || label === '旅行結束後');
  }

  function renderItemChoices(containerId, selected, setter) {
    const box = $(containerId);
    if (!box) return;
    const items = opts().items.slice();
    if (selected && items.indexOf(selected) === -1) items.push(selected);
    // 選項沒變時只切換選取狀態（P06），點擊委派到容器（payment-choices.js 的 bindChoiceContainer）
    const entries = items.map(value => [value, FX_ITEM_CATEGORY[value] || getItemCategory(value) || '', itemIcon(value)]);
    if (reuseChoices(box, 'fxitem\u0001' + JSON.stringify(entries), setter, b => b._choiceValue === selected)) return;
    box.innerHTML = '';
    entries.forEach(entry => {
      const value = entry[0];
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'choice has-emoji' + (value === selected ? ' selected' : '');
      btn.dataset.value = value;
      btn._choiceValue = value;
      btn.setAttribute('aria-pressed', value === selected ? 'true' : 'false');
      const cat = entry[1];
      if (cat && cat !== 'default') { btn.classList.add('cat-' + cat); btn.dataset.cat = cat; }
      const em = document.createElement('span');
      em.className = 'choice-emoji';
      em.setAttribute('aria-hidden', 'true');
      em.appendChild(iconEl(entry[2]));
      const tx = document.createElement('span');
      tx.className = 'choice-text';
      tx.textContent = value;
      btn.append(em, tx);
      box.appendChild(btn);
    });
  }

  function setItem(value) {
    fxState.form.item = value;
    renderStepDots();
  }
  function setPayment(value) {
    fxState.form.payment = value;
    renderStepDots();
  }

  function currencyOrder(primary) {
    const list = opts().currencies.slice();
    const head = [];
    if (primary && primary !== HOME) head.push(primary);
    head.push(HOME);
    return { head: head, rest: list.filter(c => head.indexOf(c) === -1) };
  }

  function currencyChipHtml(cur, selected, attr) {
    return '<button type="button" class="choice fx-cur-chip' + (cur === selected ? ' selected' : '') + '" ' + attr + '="' + escAttr(cur) + '" data-value="' + escAttr(cur) + '"' +
      ' aria-pressed="' + (cur === selected ? 'true' : 'false') + '">' +
      '<span class="fx-cur-code">' + escHtml(cur) + '</span><span class="fx-cur-sym">' + escHtml(CUR_SYMBOL[cur] || '') + '</span></button>';
  }

  function renderCurrencyChoices() {
    const box = $('fxCurrencyChoices');
    const ledger = currentLedger();
    if (!box || !ledger) return;
    const f = fxState.form;
    const order = currencyOrder(ledger.currency);
    let shown = order.head.slice();
    if (ui.moreCurrencies) shown = shown.concat(order.rest);
    else if (f.currency && shown.indexOf(f.currency) === -1) shown.push(f.currency);
    let h = shown.map(c => currencyChipHtml(c, f.currency, 'data-fx-cur')).join('');
    if (order.rest.length) {
      h += '<button type="button" class="choice fx-cur-more-btn" data-fx-action="more-currency" aria-expanded="' + (ui.moreCurrencies ? 'true' : 'false') + '">' +
        (ui.moreCurrencies ? '收起' + iconHtml('caret-up') : '更多' + iconHtml('caret-down')) + '</button>';
    }
    box.innerHTML = h;
  }

  function setCurrency(cur) {
    const f = fxState.form;
    if (cur === f.currency) return;
    const prevDecimals = decimalsOf(f.currency);
    f.currency = cur;
    f.rate = rateFor(currentKey(), cur);
    f.rateManual = false;
    ui.rateEditing = false;
    if (decimalsOf(cur) === 0 && f.amount.indexOf('.') !== -1) f.amount = f.amount.split('.')[0];
    if (prevDecimals !== decimalsOf(cur)) buildKeypad();
    renderCurrencyChoices();
    renderAmount();
    renderRateBox();
    renderStepDots();
  }

  function buildKeypad() {
    const box = $('fxKeypad');
    if (!box) return;
    const decimals = decimalsOf(fxState.form.currency);
    if (box.dataset.mode === String(decimals) && box.children.length) return;
    box.dataset.mode = String(decimals);
    box.innerHTML = '';
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', decimals ? '.' : '000', '0', '⌫'];
    keys.forEach(k => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'key' + (k === '⌫' ? ' special' : '');
      if (k === '⌫') b.innerHTML = iconHtml('backspace'); else b.textContent = k;
      b.dataset.value = k;
      b.setAttribute('aria-label', k === '⌫' ? '刪除一位' : k === '.' ? '小數點' : k);
      b.addEventListener('click', () => pressKey(k));
      box.appendChild(b);
    });
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'key special wide';
    clear.textContent = '清除金額';
    clear.addEventListener('click', () => {
      const had = Boolean(fxState.form.amount);
      fxState.form.amount = '';
      renderAmount(had ? 'clear' : null);
    });
    box.appendChild(clear);
  }

  function pressKey(key) {
    const f = fxState.form;
    const decimals = decimalsOf(f.currency);
    const before = f.amount || '';
    let v = before;
    let overflow = false;
    const intLen = s => s.split('.')[0].replace(/^0+/, '').length;
    if (key === '⌫') {
      v = v.slice(0, -1);
    } else if (key === '.') {
      if (!decimals) return;
      if (!v) v = '0.';
      else if (v.indexOf('.') === -1) v += '.';
    } else if (key === '000') {
      if (v && v !== '0') {
        if (intLen(v) + 3 <= 9) v += '000';
        else overflow = true;
      }
    } else {
      if (v === '0') v = '';
      const dot = v.indexOf('.');
      if (dot !== -1 && v.length - dot - 1 >= decimals) overflow = true;
      else if (dot === -1 && intLen(v) >= 9) overflow = true;
      else v += key;
    }
    f.amount = v;
    renderAmount(v === before ? null : (key === '⌫' ? 'remove' : 'add'));
    if (overflow) {
      Motion.haptic('error');
      Motion.shake($('fxLiveBox'));
    }
  }

  function amountNumber() {
    const n = parseFloat(fxState.form.amount || '0');
    return Number.isFinite(n) ? n : 0;
  }

  function typedText(v) {
    if (!v) return '0';
    const parts = v.split('.');
    const intText = nf(0, 0).format(Number(parts[0] || 0));
    return parts.length > 1 ? intText + '.' + parts[1] : intText;
  }

  function currentRate() {
    const f = fxState.form;
    if (f.currency === HOME) return 1;
    return Number(f.rate) > 0 ? Number(f.rate) : null;
  }

  function renderAmount(change) {
    const f = fxState.form;
    const cur = f.currency || HOME;
    const amount = amountNumber();
    const rate = currentRate();
    const twd = rate ? amount * rate : null;
    $('fxLiveCur').textContent = symOf(cur);
    $('fxLiveLabel').textContent = cur === HOME ? '台幣金額' : cur + ' 當地金額';
    renderLiveAmount($('fxLiveAmount'), typedText(f.amount), change);
    $('fxLiveBox').classList.toggle('has-value', amount > 0);
    const hint = $('fxConvertHint');
    if (cur === HOME) {
      hint.textContent = '台幣交易，不需換算';
    } else if (!rate) {
      hint.innerHTML = '取不到 ' + escHtml(cur) + ' 匯率，請在下方手動輸入';
    } else {
      hint.innerHTML = '≈ <b>' + escHtml(fmtTwd(twd)) + '</b>，1 ' + escHtml(cur) + ' = ' + escHtml(fmtRate(rate)) + ' NTD';
    }
    $('fxBarTwd').textContent = cur === HOME ? fmtTwd(amount) : (twd == null ? '尚無匯率' : '≈ ' + fmtTwd(twd));
    $('fxBarLocal').textContent = cur === HOME ? '台幣交易' : (symOf(cur) + typedText(f.amount));
    renderStepDots();
  }

  function renderRateBox() {
    const box = $('fxRateBox');
    if (!box) return;
    const key = currentKey();
    const f = fxState.form;
    const cur = f.currency || HOME;
    const d = fxState.dataById[key];
    box.classList.remove('is-missing');
    if (cur === HOME) {
      box.innerHTML = '<div class="fx-rate-line"><span class="fx-rate-main">1 NTD = 1 NTD</span><span class="fx-rate-meta">台幣交易，匯率固定為 1</span></div>';
      return;
    }
    const live = rateFor(key, cur);
    const rate = currentRate();
    const ratesLoaded = d && Array.isArray(d.rates);
    if (!rate && !ratesLoaded && !ui.ledgerError[key]) {
      box.innerHTML = '<div class="fx-rate-line"><span class="fx-rate-meta">正在讀取匯率參考表…</span>' +
        '<button type="button" class="fx-link-btn" data-fx-action="edit-rate">手動輸入</button></div>' + (ui.rateEditing ? rateInputHtml(cur, live) : '');
      return;
    }
    if (!rate || ui.rateEditing) {
      if (!rate) box.classList.add('is-missing');
      box.innerHTML = (!rate
        ? '<div class="fx-rate-warn">取不到 ' + escHtml(cur) + ' 即時匯率，請手動輸入（例如信用卡帳單上的實際匯率）</div>'
        : '') + rateInputHtml(cur, live);
      return;
    }
    const meta = f.rateManual
      ? '已手動設定' + (live ? '，參考表 ' + fmtRate(live) : '')
      : '匯率參考表' + (d && d.ratesFetchedAt ? '，' + fmtClock(d.ratesFetchedAt) + ' 取得' : '');
    box.innerHTML = '<div class="fx-rate-line"><span class="fx-rate-main">1 ' + escHtml(cur) + ' = ' + escHtml(fmtRate(rate)) + ' NTD' +
      (f.rateManual ? '<span class="fx-rate-badge">已手動設定</span>' : '') + '</span>' +
      '<button type="button" class="fx-link-btn" data-fx-action="edit-rate">修改匯率</button></div>' +
      '<div class="fx-rate-meta">' + escHtml(meta) + '</div>';
  }

  function rateInputHtml(cur, live) {
    const f = fxState.form;
    const val = Number(f.rate) > 0 ? String(f.rate) : '';
    return '<div class="fx-rate-input-row"><span>1 ' + escHtml(cur) + ' =</span>' +
      '<input type="text" id="fxRateInput" class="text-input" inputmode="decimal" autocomplete="off" placeholder="例如 0.0228" value="' + escAttr(val) + '" aria-label="手動匯率（1 ' + escAttr(cur) + ' 等於多少台幣）">' +
      '<span>NTD</span></div>' +
      '<div class="fx-rate-line"><span class="fx-rate-meta">1 單位外幣 = 多少台幣，記帳時會鎖定這個匯率</span>' +
      '<span>' + (live ? '<button type="button" class="fx-link-btn" data-fx-action="reset-rate">改回即時匯率</button> ' : '') +
      '<button type="button" class="fx-link-btn" data-fx-action="done-rate">完成</button></span></div>';
  }

  function parseRateInput(text) {
    const n = Number(String(text || '').replace(/,/g, '').trim());
    return Number.isFinite(n) && n > 0 && n <= RATE_MAX ? n : null;
  }

  const STEP_LABELS = { item: '交易項目', payment: '交易方式', currency: '幣別', amount: '金額' };
  function renderStepDots() {
    const box = $('fxStepDots');
    if (!box) return;
    const f = fxState.form;
    const done = { item: Boolean(f.item), payment: Boolean(f.payment), currency: Boolean(f.currency), amount: amountNumber() > 0 };
    if (!box.children.length) {
      Object.keys(STEP_LABELS).forEach(step => {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'step-dot';
        b.dataset.dotStep = step;
        const m = document.createElement('span');
        m.className = 'step-dot-mark';
        m.setAttribute('aria-hidden', 'true');
        b.appendChild(m);
        b.addEventListener('click', () => {
          const sec = document.querySelector('#fxPaneEntry .sec[data-fx-step="' + step + '"]');
          if (sec) Motion.scrollToSection(sec, { reason: 'dot', delay: 0 });
        });
        box.appendChild(b);
      });
    }
    const prev = ui.prevDone;
    box.querySelectorAll('.step-dot').forEach(b => {
      const step = b.dataset.dotStep;
      const isDone = done[step];
      b.classList.toggle('is-done', isDone);
      b.setAttribute('aria-label', STEP_LABELS[step] + '：' + (isDone ? '已完成' : '未完成') + '，點一下前往');
      if (isDone && prev && prev[step] === false) {
        Motion.animate(b.querySelector('.step-dot-mark'), {
          full: [{ transform: 'scale(0.6)', opacity: 0.4 }, { transform: 'scale(1.35)', opacity: 1, offset: 0.55 }, { transform: 'scale(1)', opacity: 1 }],
          lite: [{ opacity: 0.2 }, { opacity: 1 }]
        }, { duration: 320, easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' });
      }
    });
    ui.prevDone = done;
  }

  function rejectStep(step, message) {
    showToast(message, 'error');
    Motion.haptic('error');
    const sec = document.querySelector('#fxPaneEntry .sec[data-fx-step="' + step + '"]');
    if (sec) Motion.scrollToSection(sec, { reason: 'reject', effect: 'error', delay: 0 });
  }

  function toggleCalendar() {
    const cal = $('fxCalendar');
    if (!cal) return;
    if (!cal.hidden) { closeCalendar(); return; }
    const v = $('fxDate').value || todayISO();
    const d = parseIso(v);
    ui.calYear = d.getFullYear();
    ui.calMonth = d.getMonth() + 1;
    renderCalendar();
    cal.hidden = false;
  }

  function closeCalendar() {
    const cal = $('fxCalendar');
    if (cal) cal.hidden = true;
  }

  function renderCalendar() {
    const cal = $('fxCalendar');
    if (!cal) return;
    const ledger = currentLedger();
    const value = $('fxDate').value || '';
    const y = ui.calYear;
    const m = ui.calMonth;
    cal.innerHTML = '';
    const header = document.createElement('div');
    header.className = 'cal-header';
    const titleBox = document.createElement('div');
    titleBox.className = 'cal-title-box';
    const mkNav = (label, aria, delta) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cal-nav-btn';
      b.innerHTML = iconHtml(label);
      b.setAttribute('aria-label', aria);
      b.addEventListener('click', e => {
        e.stopPropagation();
        let mm = ui.calMonth + delta;
        let yy = ui.calYear;
        if (mm < 1) { mm = 12; yy--; }
        if (mm > 12) { mm = 1; yy++; }
        ui.calYear = yy;
        ui.calMonth = mm;
        renderCalendar();
      });
      return b;
    };
    const title = document.createElement('span');
    title.className = 'cal-title';
    title.textContent = y + ' 年 ' + m + ' 月';
    titleBox.append(mkNav('caret-left', '上個月', -1), title, mkNav('caret-right', '下個月', 1));
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'cal-close-btn';
    closeBtn.innerHTML = iconHtml('x');
    closeBtn.setAttribute('aria-label', '關閉日曆');
    closeBtn.addEventListener('click', e => { e.stopPropagation(); closeCalendar(); });
    header.append(titleBox, closeBtn);
    cal.appendChild(header);

    const selectedDay = value.slice(0, 7) === y + '-' + pad(m) ? Number(value.slice(8, 10)) : null;
    const grid = buildCalendarGrid({
      year: y, monthNum: m, currentDayNum: selectedDay, todayISO: todayISO(),
      onSelectDay: day => { setDate(y + '-' + pad(m) + '-' + pad(day)); closeCalendar(); },
    });
    cal.appendChild(grid);
    if (hasPeriod(ledger)) {
      cal.querySelectorAll('.cal-grid .cal-day:not(.empty)').forEach(btn => {
        const iso = y + '-' + pad(m) + '-' + pad(Number(btn.textContent));
        if (iso >= ledger.startDate && iso <= ledger.endDate) btn.classList.add('fx-in-trip');
      });
    }
    const footer = document.createElement('div');
    footer.className = 'cal-footer';
    const quick = document.createElement('div');
    quick.className = 'cal-quick-actions';
    const mkQuick = (label, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cal-quick-btn';
      b.textContent = label;
      b.addEventListener('click', e => { e.stopPropagation(); fn(); closeCalendar(); });
      quick.appendChild(b);
    };
    mkQuick('今天', () => setDate(todayISO()));
    mkQuick('昨天', () => setDate(addDays(todayISO(), -1)));
    if (hasPeriod(ledger)) mkQuick('出發日', () => setDate(ledger.startDate));
    const info = document.createElement('span');
    info.className = 'cal-selected-info';
    info.textContent = isIso(value) ? '已選 ' + mdLabel(value) : '';
    footer.append(quick, info);
    cal.appendChild(footer);
  }

  function setDate(iso) {
    if (!isIso(iso)) return;
    fxState.form.date = iso;
    $('fxDate').value = iso;
    renderDateHint();
  }

  function submit() {
    const key = currentKey();
    const ledger = currentLedger();
    if (!ledger) return;
    const f = fxState.form;
    const date = $('fxDate').value;
    f.note = $('fxNote').value;
    if (!isIso(date)) return rejectStep('date', '請選擇日期');
    if (!f.item) return rejectStep('item', '請選擇交易項目');
    if (!f.payment) return rejectStep('payment', '請選擇交易方式');
    if (!f.currency) return rejectStep('currency', '請選擇幣別');
    const amount = round2(amountNumber());
    if (!(amount > 0)) return rejectStep('amount', '請輸入金額');
    const rate = currentRate();
    if (!rate) {
      ui.rateEditing = true;
      renderRateBox();
      return rejectStep('rate', '取不到匯率，請先手動輸入匯率');
    }

    const form = { ledgerId: Number(key), date: date, item: f.item, payment: f.payment, currency: f.currency, amount: amount, rate: rate, note: String(f.note || '').trim() };
    const snapshot = { date: date, item: f.item, payment: f.payment, currency: f.currency, amount: f.amount, rate: f.rate, rateManual: f.rateManual, note: f.note };
    const twd = round2(amount * rate);
    const tempId = 'fx_tmp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    fxState.pending.push(Object.assign({}, form, { tempId: tempId, ledgerId: key, isPending: true, row: 'pending', twd: twd }));

    beginMutation(key);
    f.item = '';
    f.amount = '';
    f.note = '';
    $('fxNote').value = '';
    renderItemChoices('fxItemChoices', '', setItem);
    renderAmount();
    renderDynamic();
    const pendingRow = document.querySelector('#fxRecentList .fx-rec[data-temp-id="' + tempId + '"]');
    if (pendingRow) Motion.expandIn(pendingRow);
    showToast('已記錄（同步中…）', 'info');
    Motion.haptic('success');

    run('addFxRecord', [form], res => {
      fxState.pending = fxState.pending.filter(p => p.tempId !== tempId);
      const d = fxState.dataById[key] || (fxState.dataById[key] = { records: [] });
      if (!Array.isArray(d.records)) d.records = [];
      if (res && res.record) {
        d.records = d.records.filter(r => r.row !== res.record.row);
        d.records.push(res.record);
        sortRecords(d.records);
      }
      if (res && res.ledger) { d.ledger = res.ledger; upsertLedgerInList(res.ledger); }
      if (res && res.blankRow !== undefined) d.blankRow = res.blankRow;
      persistData(key);
      LocalCache.saveFxPref(key, { payment: form.payment, currency: form.currency });
      endMutation(key);
      if (key === currentKey() && ui.active) {
        renderDynamic();
        flashRow(res && res.record ? res.record.row : null);
      } else {
        updateTripHint();
      }
      const local = form.currency === HOME ? fmtTwd(form.amount) : fmtLocal(form.amount, form.currency) + '（' + fmtTwd(twd) + '）';
      showToast('記帳完成 ' + form.item + ' ' + local, 'success');
      const btn = $('fxSubmit');
      if (ui.active && key === currentKey() && fxState.tab === 'entry') {
        playSubmitConfirm(btn);
        Motion.burst(btn, BURST_PALETTE.fx);
      }
    }, err => {
      const leaving = captureRecentRow('fxRecentList', '.fx-rec[data-temp-id="' + tempId + '"]');
      fxState.pending = fxState.pending.filter(p => p.tempId !== tempId);
      endMutation(key);
      if (key === currentKey() && ui.active) {
        renderDynamic();
        playRecentRowExit(leaving);
        restoreForm(snapshot);
      } else {
        updateTripHint();
      }
      showToast('記帳失敗，已還原輸入內容：' + errMsg(err), 'error');
    });
  }

  function restoreForm(snap) {
    const f = fxState.form;
    Object.assign(f, snap);
    if (!f.rateManual) f.rate = rateFor(currentKey(), f.currency) || snap.rate;
    renderForm();
  }

  function flashRow(row) {
    if (row == null) return;
    const el = document.querySelector('#fxRecentList .fx-rec[data-row="' + row + '"]');
    if (!el) return;
    el.classList.remove('sync-ok');
    void el.offsetWidth;
    el.classList.add('sync-ok');
    setTimeout(() => el.classList.remove('sync-ok'), 1600);
  }

  function filteredRecords(records) {
    const today = todayISO();
    if (fxState.filter === 'all') return records;
    if (fxState.filter === 'today') return records.filter(r => r.date === today);
    return records.filter(r => r.item === fxState.filter);
  }

  function renderDetail() {
    const key = currentKey();
    const ledger = currentLedger();
    const listEl = $('fxDetailList');
    const chipsEl = $('fxFilterChips');
    if (!ledger || !listEl) return;
    const d = fxState.dataById[key];
    if (!d || !Array.isArray(d.records)) {
      ListRender.setHtml(chipsEl, '');
      ListRender.reconcile(listEl, [], { empty: loadingOrError(key) });
      return;
    }
    const records = allRecords(key);
    const o = opts();
    const used = new Set(records.map(r => r.item));
    const itemChips = o.items.filter(i => used.has(i)).concat(Array.from(used).filter(i => o.items.indexOf(i) === -1));
    if (fxState.filter !== 'all' && fxState.filter !== 'today' && !used.has(fxState.filter)) fxState.filter = 'all';
    const chip = (value, label) => '<button type="button" class="fx-chip" data-fx-filter="' + escAttr(value) + '" aria-pressed="' + (fxState.filter === value ? 'true' : 'false') + '">' + label + '</button>';
    ListRender.setHtml(chipsEl, chip('all', '全部') + chip('today', '今天') +
      itemChips.map(i => chip(i, '<span class="fx-chip-icon" aria-hidden="true">' + iconHtml(itemIcon(i)) + '</span>' + escHtml(i))).join(''));

    const list = filteredRecords(records);
    if (!list.length) {
      ListRender.reconcile(listEl, [], { empty: '<div class="empty">' + (records.length ? '沒有符合篩選條件的紀錄。' : '這本帳簿還沒有紀錄。') + '</div>' });
      observeDetail(false);
      return;
    }
    const groups = new Map();
    const preKey = '__pre__';
    const unknownKey = '__unknown__';
    list.forEach(r => {
      let g = r.date || unknownKey;
      if (hasPeriod(ledger) && r.date && r.date < ledger.startDate) g = preKey;
      if (!groups.has(g)) groups.set(g, { key: g, records: [], total: 0 });
      const grp = groups.get(g);
      grp.records.push(r);
      grp.total += Number(r.twd) || 0;
    });
    const ordered = Array.from(groups.values()).filter(g => g.key !== preKey && g.key !== unknownKey);
    if (groups.has(preKey)) ordered.push(groups.get(preKey));
    if (groups.has(unknownKey)) ordered.push(groups.get(unknownKey));

    // 每日一組（key＝日期），組內的列再各自以 key 比對（P06）：往下捲動載入更多、記一筆或刪一筆時，
    // 只新增或移除有變化的節點，已經畫好的組與列不重建。
    let budget = ui.detailCount;
    const blocks = [];
    for (let i = 0; i < ordered.length && budget > 0; i++) {
      const g = ordered[i];
      const rows = g.records.slice(0, budget);
      budget -= rows.length;
      let title;
      if (g.key === preKey) title = '出發前';
      else if (g.key === unknownKey) title = '日期不明';
      else {
        const idx = dayIndexLabel(ledger, g.key);
        title = mdLabel(g.key) + (idx ? '，' + idx : '');
      }
      blocks.push({ key: 'g:' + g.key, isPre: g.key === preKey, title: title, total: fmtTwd(g.total), rows: rows });
    }
    const remaining = list.length - Math.min(list.length, ui.detailCount);
    if (remaining > 0) blocks.push({ key: 'more', remaining: remaining });
    const headHtml = b => '<div class="fx-day-head' + (b.isPre ? ' is-pre' : '') + '"><span>' + escHtml(b.title) + '</span>' +
      '<small>小計 ' + escHtml(b.total) + '</small></div>';
    ListRender.reconcile(listEl, blocks, {
      key: b => b.key,
      sig: b => (b.key === 'more' ? 'more' + b.remaining : headHtml(b)),
      html: b => (b.key === 'more'
        ? '<div class="fx-detail-more">還有 ' + b.remaining + ' 筆，往下捲動載入…</div>'
        : '<section class="fx-day-group">' + headHtml(b) + '<div class="fx-rec-list"></div></section>'),
      update: (el, b) => {
        if (b.key === 'more') el.textContent = '還有 ' + b.remaining + ' 筆，往下捲動載入…';
        else el.firstElementChild.outerHTML = headHtml(b);
      },
      place: (el, b) => {
        if (b.key === 'more') return;
        reconcileRecordRows(el.querySelector('.fx-rec-list'), b.rows, () => b.isPre, '');
      },
    });
    observeDetail(remaining > 0);
  }

  function observeDetail(hasMore) {
    const sentinel = $('fxDetailSentinel');
    if (!sentinel) return;
    if (!('IntersectionObserver' in window)) {
      if (hasMore) { ui.detailCount = Infinity; renderDetail(); }
      return;
    }
    if (!ui.detailObserver) {
      ui.detailObserver = new IntersectionObserver(entries => {
        if (!entries.some(e => e.isIntersecting)) return;
        if (!ui.active || fxState.view !== 'ledger' || fxState.tab !== 'detail') return;
        const records = filteredRecords(allRecords(currentKey()));
        if (ui.detailCount >= records.length) return;
        ui.detailCount += DETAIL_PAGE_SIZE;
        renderDetail();
      }, { rootMargin: '0px 0px 240px 0px' });
    }
    ui.detailObserver.disconnect();
    if (hasMore) ui.detailObserver.observe(sentinel);
  }

  function renderStats(animate) {
    const key = currentKey();
    const ledger = currentLedger();
    const root = $('fxStats');
    if (!ledger || !root) return;
    const d = fxState.dataById[key];
    if (!d || !Array.isArray(d.records)) {
      root.innerHTML = '<div class="card">' + loadingOrError(key) + '</div>';
      return;
    }
    if (!ui.statsDirty && !animate && root.children.length) return;
    ui.statsDirty = false;
    const records = allRecords(key);
    if (!records.length) {
      root.innerHTML = '<div class="card"><div class="empty">這本帳簿還沒有紀錄，記帳後就會出現統計。</div></div>';
      return;
    }
    const sum = computeSummary(ledger, records);
    const today = todayISO();

    const byItem = {};
    const byPayment = {};
    const byCurrency = {};
    const byDay = {};
    let pre = { total: 0, count: 0 };
    let post = { total: 0, count: 0 };
    let undated = { total: 0, count: 0 };
    records.forEach(r => {
      const twd = Number(r.twd) || 0;
      (byItem[r.item] = byItem[r.item] || { total: 0, count: 0 });
      byItem[r.item].total += twd; byItem[r.item].count++;
      const pay = r.payment || '未填交易方式';
      (byPayment[pay] = byPayment[pay] || { total: 0, count: 0 });
      byPayment[pay].total += twd; byPayment[pay].count++;
      const cur = r.currency || HOME;
      (byCurrency[cur] = byCurrency[cur] || { local: 0, total: 0, count: 0 });
      byCurrency[cur].local += Number(r.amount) || 0; byCurrency[cur].total += twd; byCurrency[cur].count++;
      if (!r.date) { undated.total += twd; undated.count++; return; }
      if (hasPeriod(ledger) && r.date < ledger.startDate) { pre.total += twd; pre.count++; return; }
      if (hasPeriod(ledger) && r.date > ledger.endDate) { post.total += twd; post.count++; return; }
      (byDay[r.date] = byDay[r.date] || { total: 0, count: 0 });
      byDay[r.date].total += twd; byDay[r.date].count++;
    });
    let maxDay = null;
    Object.keys(byDay).forEach(day => { if (!maxDay || byDay[day].total > byDay[maxDay].total) maxDay = day; });

    let h = '<div class="card fx-stat-card">' + UvFx.cardRing + '<h2 class="fx-stat-title">總覽<small>以換算台幣計算</small></h2><div class="fx-kpis">' +
      kpi('總花費', fmtTwd(sum.total), '', true) +
      kpi('筆數', sum.count + ' 筆', '') +
      kpi('日均', sum.avg == null ? '無資料' : fmtTwd(sum.avg), sum.elapsed ? '旅行第 1～' + sum.elapsed + ' 天' : (hasPeriod(ledger) ? '尚未出發' : '期間未設定')) +
      kpi('最高單日', maxDay ? fmtTwd(byDay[maxDay].total) : '無資料', maxDay ? mdLabel(maxDay) : '') +
      '</div></div>';

    const items = Object.keys(byItem).map(n => ({ name: n, total: byItem[n].total, count: byItem[n].count }))
      .filter(it => it.total > 0).sort((a, b) => b.total - a.total);
    const itemTotal = items.reduce((a, it) => a + it.total, 0);
    let slices = items.length <= 6
      ? items.map(it => ({ label: it.name, value: it.total, count: it.count, className: itemColorClass(it.name) }))
      : items.slice(0, 5).map(it => ({ label: it.name, value: it.total, count: it.count, className: itemColorClass(it.name) }));
    if (items.length > 6) {
      const rest = items.slice(5);
      slices.push({ label: '其餘（' + rest.length + ' 項）', value: rest.reduce((a, it) => a + it.total, 0), count: rest.reduce((a, it) => a + it.count, 0), className: 'fx-c-rest', isOther: true });
    }
    slices = slices.map(sl => Object.assign(sl, { pct: itemTotal > 0 ? Math.round(sl.value / itemTotal * 1000) / 10 : 0 }));
    h += '<div class="card fx-stat-card">' + UvFx.cardRing + '<h2 class="fx-stat-title">交易項目分布<small>對應試算表「各細項總覽」</small></h2>';
    if (items.length) {
      h += '<div class="oc-donut-wrap"><div class="mc-chart oc-donut-chart" id="fxDonut"></div><ul class="fx-stat-list">' +
        items.map(it => {
          const pct = itemTotal > 0 ? Math.round(it.total / itemTotal * 1000) / 10 : 0;
          return '<li class="fx-stat-row"><span class="oc-sw ' + itemColorClass(it.name) + '" aria-hidden="true"></span>' +
            '<span class="fx-stat-name"><span class="item-inline-icon" aria-hidden="true">' + iconHtml(itemIcon(it.name)) + '</span>' + escHtml(it.name) + '</span>' +
            '<span class="fx-stat-amt">' + escHtml(fmtTwd(it.total)) + '</span>' +
            '<span class="fx-stat-meta">' + pct + '%，' + it.count + ' 筆</span></li>';
        }).join('') + '</ul></div>';
    } else {
      h += '<div class="empty">沒有金額大於 0 的紀錄</div>';
    }
    h += '</div>';

    const dayLabels = [];
    const dayValues = [];
    const dayIsos = [];
    let startIso = hasPeriod(ledger) ? ledger.startDate : null;
    let endIso = hasPeriod(ledger) ? ledger.endDate : null;
    if (!startIso) {
      const dated = Object.keys(byDay).sort();
      startIso = dated[0] || null;
      endIso = dated[dated.length - 1] || null;
    }
    if (startIso && endIso) {
      const n = Math.min(daysBetween(startIso, endIso) + 1, 120);
      for (let i = 0; i < n; i++) {
        const iso = addDays(startIso, i);
        dayIsos.push(iso);
        const dt = parseIso(iso);
        dayLabels.push((i === 0 || dt.getDate() === 1) ? (dt.getMonth() + 1) + '/' + dt.getDate() : String(dt.getDate()));
        dayValues.push(round2(byDay[iso] ? byDay[iso].total : 0));
      }
    }
    h += '<div class="card fx-stat-card">' + UvFx.cardRing + '<h2 class="fx-stat-title">每日花費<small>' + escHtml(periodRange(ledger)) + '</small></h2>';
    if (dayIsos.length) {
      h += '<div class="mc-chart" id="fxDailyChart"></div><div class="oc-chart-legend">' +
        '<span class="oc-key"><i class="oc-key-line is-avg"></i>日均線</span>' +
        (dayIsos.indexOf(today) !== -1 ? '<span class="oc-key"><i class="oc-key-box is-today"></i>今天</span>' : '') + '</div>';
    } else {
      h += '<div class="empty">沒有可以畫圖的日期</div>';
    }
    const extra = [];
    if (pre.count) extra.push('出發前（機票、保險等）<b>' + escHtml(fmtTwd(pre.total)) + '</b>，' + pre.count + ' 筆');
    if (post.count) extra.push('旅行結束後 <b>' + escHtml(fmtTwd(post.total)) + '</b>，' + post.count + ' 筆');
    if (undated.count) extra.push('日期不明 <b>' + escHtml(fmtTwd(undated.total)) + '</b>，' + undated.count + ' 筆');
    if (extra.length) h += '<div class="fx-stat-note">' + extra.join('<br>') + '</div>';
    h += '</div>';

    const pays = Object.keys(byPayment).map(n => ({ name: n, total: byPayment[n].total, count: byPayment[n].count }))
      .sort((a, b) => b.total - a.total);
    h += '<div class="card fx-stat-card">' + UvFx.cardRing + '<h2 class="fx-stat-title">交易方式</h2><ul class="fx-stat-list">' +
      pays.map(p => {
        const pct = sum.total > 0 ? Math.round(p.total / sum.total * 1000) / 10 : 0;
        return '<li class="fx-stat-row"><span></span><span class="fx-stat-name">' + escHtml(p.name) + '</span>' +
          '<span class="fx-stat-amt">' + escHtml(fmtTwd(p.total)) + '</span>' +
          '<span class="fx-stat-meta">' + pct + '%，' + p.count + ' 筆</span>' +
          '<span class="fx-meter" aria-hidden="true"><i style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></span></li>';
      }).join('') + '</ul></div>';

    const curs = Object.keys(byCurrency).sort((a, b) => byCurrency[b].total - byCurrency[a].total);
    h += '<div class="card fx-stat-card">' + UvFx.cardRing + '<h2 class="fx-stat-title">幣別</h2><ul class="fx-stat-list">' +
      curs.map(c => {
        const v = byCurrency[c];
        return '<li class="fx-stat-row"><span></span><span class="fx-stat-name">' + escHtml(c) + '，' + escHtml(fmtLocal(v.local, c)) + '</span>' +
          '<span class="fx-stat-amt">' + escHtml(fmtTwd(v.total)) + '</span>' +
          '<span class="fx-stat-meta">' + v.count + ' 筆</span></li>';
      }).join('') + '</ul></div>';

    root.innerHTML = h;
    MiniCharts.releaseDetached();
    const playAnim = Boolean(animate);

    const donutEl = $('fxDonut');
    if (donutEl) {
      const ctl = MiniCharts.donut(donutEl, {
        slices: slices,
        animate: playAnim,
        ariaLabel: '交易項目分布，總花費 ' + fmtTwd(itemTotal),
        center: { main: fmtTwd(itemTotal), sub: sum.count + ' 筆' },
        centerFor: i => {
          const sl = slices[i];
          return sl ? { main: fmtTwd(sl.value), sub: (sl.isOther ? '其餘' : sl.label).slice(0, 6) + '，' + sl.pct + '%' } : null;
        },
        onSlice: i => {
          ui.statsFocus = ui.statsFocus === i ? null : i;
          ctl.setFocus(ui.statsFocus);
        },
      });
    }

    const dailyEl = $('fxDailyChart');
    if (dailyEl) {
      const todayIdx = dayIsos.indexOf(today);
      const emptyFrom = todayIdx === -1 ? (today < dayIsos[0] ? 0 : dayIsos.length) : todayIdx + 1;
      MiniCharts.bars(dailyEl, {
        labels: dayLabels,
        series: [{ values: dayValues, className: 'is-fx' }],
        highlightIndex: todayIdx,
        emptyFrom: emptyFrom,
        avg: sum.avg || 0,
        avgLabel: sum.avg ? '日均 ' + fmtTwd(sum.avg) : '',
        animate: playAnim,
        ariaLabel: '每日花費' + (sum.avg ? '，日均 ' + fmtTwd(sum.avg) : ''),
        tooltip: i => escHtml(mdLabel(dayIsos[i]) + ' ' + fmtTwd(dayValues[i]) + '，' + (byDay[dayIsos[i]] ? byDay[dayIsos[i]].count : 0) + ' 筆'),
      });
    }
  }

  function kpi(label, value, sub, main) {
    return '<div class="fx-kpi' + (main ? ' is-main' : '') + '"><div class="fx-kpi-label">' + escHtml(label) + '</div>' +
      '<div class="fx-kpi-val">' + escHtml(value) + '</div>' + (sub ? '<div class="fx-kpi-sub">' + escHtml(sub) + '</div>' : '') + '</div>';
  }

  function toggleMenu() {
    const menu = $('fxLedgerMenu');
    if (!menu) return;
    if (menu.hidden) {
      menu.hidden = false;
      $('fxLedgerMenuBtn').setAttribute('aria-expanded', 'true');
    } else {
      closeMenu();
    }
  }
  function closeMenu() {
    const menu = $('fxLedgerMenu');
    if (menu && !menu.hidden) {
      menu.hidden = true;
      $('fxLedgerMenuBtn').setAttribute('aria-expanded', 'false');
    }
  }

  function openLedgerModal(mode, ledger) {
    const isEdit = mode === 'edit' && ledger;
    const today = todayISO();
    ui.ledgerModal = {
      mode: isEdit ? 'edit' : 'create',
      id: isEdit ? keyOf(ledger.id) : '',
      country: isEdit ? (ledger.country || '') : '',
      nameTouched: isEdit,
      busy: false,
      archived: isEdit ? Boolean(ledger.archived) : false,
    };
    $('fxLedgerModalTitle').textContent = isEdit ? '編輯帳簿' : '新增國外帳簿';
    $('fxLedgerModalSubtitle').textContent = isEdit
      ? '修改名稱會同步重新命名試算表中的工作表'
      : '將複製「國外交易記帳簿-空白頁」建立新的工作表';
    $('fxLedgerNameInput').value = isEdit ? ledger.name : '';
    $('fxStartInput').value = isEdit && isIso(ledger.startDate) ? ledger.startDate : today;
    $('fxEndInput').value = isEdit && isIso(ledger.endDate) ? ledger.endDate : addDays(today, 6);
    $('fxLedgerSubmitBtn').textContent = isEdit ? '儲存' : '建立帳簿';
    $('fxLedgerManage').hidden = !isEdit;
    $('fxArchiveBtn').textContent = isEdit && ledger.archived ? '取消封存' : '封存帳簿';
    renderCountryChoices();
    validateLedgerModal();
    openModal($('fxLedgerModal'));
    if (!isEdit) setTimeout(() => {
      const first = document.querySelector('#fxCountryChoices .choice');
      if (first) try { first.focus({ preventScroll: true }); } catch (e) {}
    }, 60);
  }

  function closeLedgerModal() {
    if (ui.ledgerModal && ui.ledgerModal.busy) return;
    closeModal($('fxLedgerModal'));
  }

  function renderCountryChoices() {
    const box = $('fxCountryChoices');
    const m = ui.ledgerModal;
    const o = opts();
    const list = o.countries.slice();
    if (m.country && list.indexOf(m.country) === -1) list.push(m.country);
    box.innerHTML = list.map(c => '<button type="button" class="choice" data-fx-country="' + escAttr(c) + '" data-value="' + escAttr(c) + '" aria-pressed="' + (c === m.country ? 'true' : 'false') + '">' +
      flagOf(c) + ' ' + escHtml(c) + '</button>').join('');
    box.querySelectorAll('.choice').forEach(b => b.classList.toggle('selected', b.dataset.fxCountry === m.country));
    const cur = m.country ? (o.countryCurrency[m.country] || '') : '';
    $('fxCountryHint').innerHTML = m.country ? '主要幣別：<b>' + escHtml(cur || '未設定') + '</b>' : '選擇旅行的國家，會自動帶入主要幣別';
  }

  function ledgerNameError(name) {
    const m = ui.ledgerModal;
    if (!name) return '請輸入帳簿名稱';
    if (name.length > NAME_MAX) return '帳簿名稱最多 ' + NAME_MAX + ' 個字';
    if (INVALID_NAME.test(name)) return '帳簿名稱不可包含 [ ] * ? / \\ : 這些符號';
    if (/^'|'$/.test(name)) return '帳簿名稱不可以單引號開頭或結尾';
    if (name === TEMPLATE_NAME) return '「空白頁」是範本名稱，請換一個名稱';
    const dup = (fxState.ledgers || []).some(l => l.name === name && keyOf(l.id) !== m.id);
    if (dup) return '已經有「' + PREFIX + name + '」工作表，請換一個名稱';
    return '';
  }

  function validateLedgerModal() {
    const m = ui.ledgerModal;
    if (!m) return false;
    const name = $('fxLedgerNameInput').value.trim();
    const nameErr = ledgerNameError(name);
    const nameHint = $('fxLedgerNameHint');
    nameHint.classList.toggle('is-error', Boolean(nameErr) && (m.nameTouched || name !== ''));
    if (nameErr && (m.nameTouched || name)) nameHint.textContent = nameErr;
    else if (name) nameHint.innerHTML = (m.mode === 'edit' ? '工作表名稱：' : '將建立工作表：') + '<b>' + escHtml(PREFIX + name) + '</b>';
    else nameHint.textContent = '預設為國家名稱，可改成「中國深圳」「韓國 2026 春」';

    const s = $('fxStartInput').value;
    const e = $('fxEndInput').value;
    const periodHint = $('fxPeriodHint');
    let periodOk = false;
    if (!isIso(s) || !isIso(e)) {
      periodHint.textContent = '請選擇開始日與結束日';
      periodHint.classList.add('is-error');
    } else if (s > e) {
      periodHint.textContent = '結束日不可早於開始日';
      periodHint.classList.add('is-error');
    } else {
      periodOk = true;
      periodHint.classList.remove('is-error');
      periodHint.innerHTML = '共 <b>' + (daysBetween(s, e) + 1) + '</b> 天';
    }
    const ok = Boolean(m.country) && !nameErr && periodOk;
    $('fxLedgerSubmitBtn').disabled = !ok || m.busy;
    return ok;
  }

  function submitLedgerModal() {
    const m = ui.ledgerModal;
    if (!m || m.busy || !validateLedgerModal()) return;
    const payload = {
      name: $('fxLedgerNameInput').value.trim(),
      country: m.country,
      startDate: $('fxStartInput').value,
      endDate: $('fxEndInput').value,
    };
    const btn = $('fxLedgerSubmitBtn');
    m.busy = true;
    btn.disabled = true;
    btn.textContent = m.mode === 'edit' ? '儲存中…' : '建立中…';
    const done = () => {
      m.busy = false;
      btn.textContent = m.mode === 'edit' ? '儲存' : '建立帳簿';
      validateLedgerModal();
    };
    if (m.mode === 'create') {
      run('createFxLedger', [payload], res => {
        done();
        fxState.ledgers = res.ledgers || fxState.ledgers;
        fxState.ledgersLoaded = true;
        LocalCache.saveFxList(fxState.ledgers);
        const key = keyOf(res.ledger.id);
        fxState.dataById[key] = { ledger: res.ledger, records: [], rates: null, ratesFetchedAt: 0, blankRow: 3 };
        persistData(key);
        closeModal($('fxLedgerModal'));
        showToast('已建立 ' + res.ledger.name + ' 帳簿', 'success');
        openLedger(key, { tab: 'entry' });
        updateTripHint();
      }, err => {
        done();
        showToast('建立帳簿失敗：' + errMsg(err), 'error');
      });
    } else {
      payload.ledgerId = Number(m.id);
      run('updateFxLedger', [payload], res => {
        done();
        applyLedgerResult(res);
        closeModal($('fxLedgerModal'));
        showToast('已更新帳簿', 'success');
      }, err => {
        done();
        showToast('更新帳簿失敗：' + errMsg(err), 'error');
      });
    }
  }

  function applyLedgerResult(res) {
    if (!res) return;
    if (Array.isArray(res.ledgers)) {
      fxState.ledgers = res.ledgers;
      fxState.ledgersLoaded = true;
      LocalCache.saveFxList(res.ledgers);
    }
    if (res.ledger) {
      const key = keyOf(res.ledger.id);
      const d = fxState.dataById[key];
      if (d) { d.ledger = res.ledger; persistData(key); }
      upsertLedgerInList(res.ledger);
    }
    if (ui.active) {
      if (fxState.view === 'ledger') { renderLedgerHeader(); renderCurrencyChoices(); renderDynamic(); }
      else renderList();
    }
    updateTripHint();
  }

  function toggleArchive() {
    const m = ui.ledgerModal;
    if (!m || m.busy || m.mode !== 'edit') return;
    const target = !m.archived;
    const btn = $('fxArchiveBtn');
    m.busy = true;
    btn.disabled = true;
    $('fxLedgerSubmitBtn').disabled = true;
    run('setFxLedgerArchived', [{ ledgerId: Number(m.id), archived: target }], res => {
      m.busy = false;
      btn.disabled = false;
      applyLedgerResult(res);
      closeModal($('fxLedgerModal'));
      const name = res && res.ledger ? res.ledger.name : '';
      showToast(target ? '已封存 ' + name + '（試算表中已隱藏）' : '已取消封存 ' + name, 'success');
    }, err => {
      m.busy = false;
      btn.disabled = false;
      validateLedgerModal();
      showToast((target ? '封存' : '取消封存') + '失敗：' + errMsg(err), 'error');
    });
  }

  function openDeleteLedgerModal() {
    const m = ui.ledgerModal;
    const ledger = m ? findLedger(m.id) : null;
    if (!ledger) return;
    closeModal($('fxLedgerModal'));
    ui.deleteLedgerId = keyOf(ledger.id);
    $('fxDeleteLedgerName').innerHTML = flagOf(ledger.country) + ' ' + escHtml(ledger.name);
    $('fxDeleteLedgerTotal').textContent = fmtTwd(ledger.totalTwd);
    $('fxDeleteLedgerInfo').textContent = '工作表「' + ledger.sheetName + '」，' + (Number(ledger.count) || 0) + ' 筆紀錄';
    $('fxDeleteLedgerExpect').textContent = ledger.name;
    $('fxDeleteLedgerInput').value = '';
    $('fxDeleteLedgerConfirmBtn').disabled = true;
    openModal($('fxDeleteLedgerModal'));
    setTimeout(() => { try { $('fxDeleteLedgerInput').focus({ preventScroll: true }); } catch (e) {} }, 80);
  }

  function closeDeleteLedgerModal() {
    if (ui.deleteLedgerBusy) return;
    closeModal($('fxDeleteLedgerModal'));
  }

  function confirmDeleteLedger() {
    const ledger = findLedger(ui.deleteLedgerId);
    if (!ledger || ui.deleteLedgerBusy) return;
    const typed = $('fxDeleteLedgerInput').value;
    if (typed !== ledger.name) return;
    const btn = $('fxDeleteLedgerConfirmBtn');
    ui.deleteLedgerBusy = true;
    btn.disabled = true;
    btn.textContent = '刪除中…';
    run('deleteFxLedger', [{ ledgerId: Number(ledger.id), confirmName: typed }], res => {
      ui.deleteLedgerBusy = false;
      btn.textContent = '永久刪除';
      const key = keyOf(ledger.id);
      delete fxState.dataById[key];
      LocalCache.removeFxLedger(key);
      fxState.ledgers = (res && Array.isArray(res.ledgers)) ? res.ledgers : (fxState.ledgers || []).filter(l => keyOf(l.id) !== key);
      LocalCache.saveFxList(fxState.ledgers);
      closeModal($('fxDeleteLedgerModal'));
      if (currentKey() === key) fxState.currentId = null;
      if (ui.active) setView('list', 'back');
      updateTripHint();
      showToast('已刪除 ' + ledger.name + ' 帳簿', 'success');
    }, err => {
      ui.deleteLedgerBusy = false;
      btn.textContent = '永久刪除';
      btn.disabled = $('fxDeleteLedgerInput').value !== ledger.name;
      showToast('刪除帳簿失敗：' + errMsg(err), 'error');
    });
  }

  function openRecordModal(record) {
    const key = currentKey();
    if (!record || record.isPending) return;
    if (isBusy(key)) {
      showToast('資料同步中，請稍候再修改', 'info');
      return;
    }
    const ledger = currentLedger();
    ui.recordEdit = {
      key: key,
      original: Object.assign({}, record),
      item: record.item,
      payment: record.payment,
      currency: record.currency || HOME,
    };
    $('fxRecordModalSubtitle').textContent = mdLabel(record.date) + (dayIndexLabel(ledger, record.date) ? '，' + dayIndexLabel(ledger, record.date) : '') + '，試算表第 ' + record.row + ' 列';
    $('fxEditDate').value = isIso(record.date) ? record.date : todayISO();
    $('fxEditAmount').value = String(record.amount);
    $('fxEditRate').value = record.currency === HOME ? '1' : String(record.rate || '');
    $('fxEditNote').value = record.note || '';
    renderEditCurrency();
    renderItemChoices('fxEditItemChoices', record.item, v => { ui.recordEdit.item = v; });
    renderPaymentChoices('fxEditPaymentChoices', paymentListWith(record.payment), record.payment, v => { ui.recordEdit.payment = v; });
    updateEditConvert();
    $('fxRecordSubmitBtn').disabled = false;
    openModal($('fxRecordModal'));
    fitEditAmountPrefix();
  }

  function renderEditCurrency() {
    const ed = ui.recordEdit;
    const ledger = currentLedger();
    const order = currencyOrder(ledger ? ledger.currency : '');
    const list = order.head.concat(order.rest);
    if (ed.currency && list.indexOf(ed.currency) === -1) list.push(ed.currency);
    $('fxEditCurrencyChoices').innerHTML = list.map(c => currencyChipHtml(c, ed.currency, 'data-fx-edit-cur')).join('');
    $('fxEditAmountCur').textContent = ed.currency;
    $('fxEditRateCur').textContent = ed.currency;
    $('fxEditRate').disabled = ed.currency === HOME;
    $('fxEditAmountPrefix').textContent = symOf(ed.currency).trim();
    fitEditAmountPrefix();
  }

  function fitEditAmountPrefix() {
    const prefix = $('fxEditAmountPrefix');
    const input = $('fxEditAmount');
    const w = prefix.offsetWidth;
    if (w) input.style.setProperty('padding-left', (w + 22) + 'px', 'important');
    else input.style.removeProperty('padding-left');
  }

  function setEditCurrency(cur) {
    const ed = ui.recordEdit;
    if (!ed || cur === ed.currency) return;
    ed.currency = cur;
    let rate;
    if (cur === HOME) rate = 1;
    else if (cur === ed.original.currency) rate = ed.original.rate;
    else rate = rateFor(ed.key, cur);
    $('fxEditRate').value = rate ? String(rate) : '';
    renderEditCurrency();
    updateEditConvert();
  }

  function updateEditConvert() {
    const ed = ui.recordEdit;
    if (!ed) return;
    const amount = parseFloat(String($('fxEditAmount').value).replace(/,/g, ''));
    const rate = ed.currency === HOME ? 1 : parseRateInput($('fxEditRate').value);
    const el = $('fxEditConvert');
    if (!(amount > 0)) el.textContent = '';
    else if (!rate) el.textContent = '請輸入 ' + ed.currency + ' 匯率';
    else el.textContent = ed.currency === HOME ? fmtTwd(amount) : '≈ ' + fmtTwd(amount * rate);
  }

  function closeRecordModal() {
    if (ui.recordBusy) return;
    closeModal($('fxRecordModal'));
  }

  function submitRecordModal() {
    const ed = ui.recordEdit;
    if (!ed || ui.recordBusy) return;
    const key = ed.key;
    const date = $('fxEditDate').value;
    const amountRaw = String($('fxEditAmount').value).replace(/,/g, '').trim();
    let amount = round2(parseFloat(amountRaw));
    const rate = ed.currency === HOME ? 1 : parseRateInput($('fxEditRate').value);
    const note = $('fxEditNote').value.trim();
    if (!isIso(date)) return showToast('請選擇有效的日期', 'error');
    if (!ed.item) return showToast('請選擇交易項目', 'error');
    if (!ed.payment) return showToast('請選擇交易方式', 'error');
    if (!(amount > 0)) { Motion.shake($('fxEditAmount')); return showToast('請輸入大於 0 的金額', 'error'); }
    if (decimalsOf(ed.currency) === 0) amount = Math.round(amount);
    if (!rate) { Motion.shake($('fxEditRate')); return showToast('匯率必須大於 0 且不超過 ' + RATE_MAX, 'error'); }

    const orig = ed.original;
    const form = { ledgerId: Number(key), row: orig.row, date: date, item: ed.item, payment: ed.payment, currency: ed.currency, amount: amount, rate: rate, note: note };
    const optimistic = Object.assign({}, orig, form, { twd: round2(amount * rate) });
    delete optimistic.ledgerId;
    const d = fxState.dataById[key];
    if (!d || !Array.isArray(d.records)) return;
    const replace = rec => { d.records = sortRecords(d.records.filter(r => r.row !== orig.row).concat([rec])); };
    const inputSnapshot = { date: date, amount: amountRaw, rate: $('fxEditRate').value, note: note, item: ed.item, payment: ed.payment, currency: ed.currency };

    replace(optimistic);
    beginMutation(key);
    closeModal($('fxRecordModal'));
    if (key === currentKey()) renderDynamic();
    showToast('已修改（同步中…）', 'info');

    run('updateFxRecord', [form], res => {
      if (res && res.record) replace(res.record);
      if (res && res.ledger) { d.ledger = res.ledger; upsertLedgerInList(res.ledger); }
      persistData(key);
      endMutation(key);
      if (key === currentKey() && ui.active) { renderDynamic(); flashRow(orig.row); }
      else updateTripHint();
      showToast('已更新 ' + form.item + ' ' + fmtLocal(form.amount, form.currency), 'success');
    }, err => {
      replace(orig);
      endMutation(key);
      if (key === currentKey() && ui.active) {
        renderDynamic();
        if (!document.querySelector('.modal-backdrop.show')) {
          openRecordModal(orig);
        }
        if ($('fxRecordModal').classList.contains('show') && ui.recordEdit && ui.recordEdit.original.row === orig.row) {
          const e2 = ui.recordEdit;
          e2.item = inputSnapshot.item;
          e2.payment = inputSnapshot.payment;
          e2.currency = inputSnapshot.currency;
          $('fxEditDate').value = inputSnapshot.date;
          $('fxEditAmount').value = inputSnapshot.amount;
          $('fxEditRate').value = inputSnapshot.rate;
          $('fxEditNote').value = inputSnapshot.note;
          renderEditCurrency();
          renderItemChoices('fxEditItemChoices', e2.item, v => { e2.item = v; });
          renderPaymentChoices('fxEditPaymentChoices', paymentListWith(e2.payment), e2.payment, v => { e2.payment = v; });
          updateEditConvert();
        }
      } else {
        updateTripHint();
      }
      showToast('修改失敗，已還原：' + errMsg(err), 'error');
    });
  }

  function openDeleteRecordModal(r) {
    const key = currentKey();
    if (!r || r.isPending) return;
    if (isBusy(key)) {
      showToast('資料同步中，請稍候再刪除', 'info');
      return;
    }
    ui.deleteRecord = { key: key, record: r };
    $('fxDeleteRecordDate').textContent = slash(r.date) || '日期不明';
    $('fxDeleteRecordItem').innerHTML = '<span class="item-inline-icon" aria-hidden="true">' + iconHtml(itemIcon(r.item)) + '</span>' + escHtml(r.item);
    $('fxDeleteRecordAmount').textContent = fmtLocal(r.amount, r.currency);
    $('fxDeleteRecordDetails').textContent = [r.currency === HOME ? '' : '≈ ' + fmtTwd(r.twd), r.payment, r.note].filter(Boolean).join('｜');
    openModal($('fxDeleteRecordModal'));
  }

  function closeDeleteRecordModal() {
    closeModal($('fxDeleteRecordModal'));
  }

  function confirmDeleteRecord() {
    const del = ui.deleteRecord;
    if (!del) return;
    ui.deleteRecord = null;
    const key = del.key;
    const r = del.record;
    const d = fxState.dataById[key];
    if (!d || !Array.isArray(d.records)) return;
    closeModal($('fxDeleteRecordModal'));
    const sel = '.fx-rec[data-row="' + r.row + '"]';
    const leavingRecent = captureRecentRow('fxRecentList', sel);
    const before = d.records.slice();
    d.records = d.records.filter(x => x.row !== r.row);
    beginMutation(key);
    if (key === currentKey()) {
      renderDynamic();
      playRecentRowExit(leavingRecent);
    }
    showToast('已刪除（同步中…）', 'info');

    run('deleteFxRecord', [{ ledgerId: Number(key), row: r.row }], res => {
      if (res && Array.isArray(res.records)) {
        d.records = res.records;
        if ((ui.inflight[key] || 0) > 1) ui.resync[key] = true;
      }
      if (res && res.ledger) { d.ledger = res.ledger; upsertLedgerInList(res.ledger); }
      if (res && res.blankRow !== undefined) d.blankRow = res.blankRow;
      persistData(key);
      endMutation(key);
      if (key === currentKey() && ui.active) renderDynamic();
      else updateTripHint();
      showToast('已刪除 ' + r.item + ' ' + fmtLocal(r.amount, r.currency), 'success');
    }, err => {
      d.records = before;
      endMutation(key);
      if (key === currentKey() && ui.active) {
        renderDynamic();
        const back = document.querySelector('#fxRecentList ' + sel);
        if (back) Motion.expandIn(back);
      } else {
        updateTripHint();
      }
      showToast('刪除失敗，已還原：' + errMsg(err), 'error');
    });
  }

  function activeTripLedger() {
    const today = todayISO();
    const list = (fxState.ledgers || []).filter(l => !l.archived && hasPeriod(l) && l.startDate <= today && today <= l.endDate);
    list.sort((a, b) => (a.startDate < b.startDate ? 1 : -1));
    return list[0] || null;
  }

  function updateTripHint() {
    const el = $('fxTripHint');
    if (!el) return;
    const ledger = activeTripLedger();
    const today = todayISO();
    if (!ledger || LocalCache.getFxHintHiddenDate() === today) {
      el.hidden = true;
      return;
    }
    const key = keyOf(ledger.id);
    const day = daysBetween(ledger.startDate, today) + 1;
    let text = ledger.name + '旅行中，第 ' + day + ' 天';
    const d = getData(key);
    if (d && Array.isArray(d.records)) {
      const todayTotal = allRecords(key).filter(r => r.date === today).reduce((a, r) => a + (Number(r.twd) || 0), 0);
      text += '｜今日 ' + fmtTwd(todayTotal);
    }
    $('fxTripHintText').innerHTML = iconHtml('airplane-tilt') + escHtml(text);
    el.dataset.ledgerId = key;
    el.hidden = false;
  }

  function prefetchHintLedger() {
    const ledger = activeTripLedger();
    if (!ledger || LocalCache.getFxHintHiddenDate() === todayISO()) return;
    const key = keyOf(ledger.id);
    if (isBusy(key) || ui.loadingLedger[key]) return;
    fetchLedger(key, false, { silent: true });
  }

  function goToHintLedger() {
    const el = $('fxTripHint');
    const key = el && el.dataset.ledgerId;
    if (!key) return;
    getData(key);
    fxState.currentId = key;
    fxState.tab = 'entry';
    fxState.view = 'ledger';
    ui.pendingOpen = { key: key, tab: 'entry' };
    window.appSwitchPage('foreign');
  }

  function scheduleIdle(fn, timeout) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(fn, { timeout: timeout || 4000 });
    } else {
      setTimeout(fn, 1200);
    }
  }

  function onEnter() {
    ui.active = true;
    const cached = LocalCache.getFxList();
    if (!(fxState.ledgers || []).length && cached) fxState.ledgers = cached.ledgers;
    const page = $('pageForeign');
    if (ui.pendingOpen) {
      const p = ui.pendingOpen;
      ui.pendingOpen = null;
      openLedger(p.key, { tab: p.tab, instant: true });
    } else if (fxState.view === 'ledger' && currentLedger()) {
      if (page) page.dataset.view = 'ledger';
      renderLedger({ keepForm: false });
      fetchLedger(currentKey(), false, { silent: true });
    } else {
      fxState.view = 'list';
      if (page) page.dataset.view = 'list';
      renderList();
    }
    loadLedgerList(false, { silent: true });
  }

  function onLeave() {
    if (!ui.active) return;
    ui.active = false;
    closeMenu();
    closeCalendar();
    if (ui.detailObserver) ui.detailObserver.disconnect();
    const f = fxState.form;
    const note = $('fxNote');
    if (note) f.note = note.value;
    updateTripHint();
  }

  function onActivate(el, handler) {
    el.addEventListener('click', handler);
    el.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ' ') && e.target.closest('[role="button"]')) {
        e.preventDefault();
        handler(e);
      }
    });
  }

  function recordFromEvent(target) {
    const rowEl = target.closest('.fx-rec[data-row]');
    if (!rowEl) return null;
    const row = Number(rowEl.dataset.row);
    const d = currentData();
    return d && Array.isArray(d.records) ? d.records.find(r => r.row === row) || null : null;
  }

  function init() {
    const page = $('pageForeign');
    if (!page) return;

    const openBtn = $('fxOpenBtn');
    if (openBtn) openBtn.addEventListener('click', () => window.appSwitchPage('foreign'));
    $('fxTripHintGo').addEventListener('click', goToHintLedger);
    $('fxTripHintClose').addEventListener('click', () => {
      LocalCache.saveFxHintHiddenDate(todayISO());
      const el = $('fxTripHint');
      Motion.animate(el, { full: [{ opacity: 1 }, { opacity: 0 }], lite: [{ opacity: 1 }, { opacity: 0 }] }, { duration: Motion.dur('base') })
        .then(() => { el.hidden = true; });
    });

    $('fxListBackBtn').addEventListener('click', () => window.appSwitchPage('bookkeeping'));
    $('fxAddLedgerBtn').addEventListener('click', () => openLedgerModal('create'));
    $('fxListRefreshBtn').addEventListener('click', () => loadLedgerList(true));
    onActivate($('fxListBody'), e => {
      const t = e.target;
      if (t.closest('[data-fx-action="add-ledger"]')) { openLedgerModal('create'); return; }
      if (t.closest('[data-fx-action="reload-list"]')) { loadLedgerList(true); return; }
      const card = t.closest('[data-fx-open]');
      if (card) openLedger(card.dataset.fxOpen);
    });

    $('fxLedgerBackBtn').addEventListener('click', () => {
      setView('list', 'back');
      loadLedgerList(false, { silent: true });
    });
    $('fxLedgerMenuBtn').addEventListener('click', e => { e.stopPropagation(); toggleMenu(); });
    $('fxLedgerMenu').addEventListener('click', e => {
      const item = e.target.closest('[data-fx-menu]');
      if (e.target.closest('#fxLedgerSheetLink')) { closeMenu(); return; }
      if (!item) return;
      closeMenu();
      if (item.dataset.fxMenu === 'edit') openLedgerModal('edit', currentLedger());
      if (item.dataset.fxMenu === 'refresh') fetchLedger(currentKey(), true);
    });
    $('fxTabs').addEventListener('click', e => {
      const btn = e.target.closest('[data-fx-tab]');
      if (btn) switchTab(btn.dataset.fxTab);
    });

    $('fxDate').addEventListener('change', () => {
      fxState.form.date = $('fxDate').value;
      renderDateHint();
      if (!$('fxCalendar').hidden) renderCalendar();
    });
    $('fxCalBtn').addEventListener('click', e => { e.stopPropagation(); toggleCalendar(); });
    $('fxDate').addEventListener('click', e => {
      if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
        e.preventDefault();
        e.stopPropagation();
        toggleCalendar();
      }
    });
    $('fxCalendar').addEventListener('click', e => e.stopPropagation());
    $('fxTodayBtn').addEventListener('click', () => setDate(todayISO()));
    $('fxYesterdayBtn').addEventListener('click', () => setDate(addDays(todayISO(), -1)));
    $('fxNote').addEventListener('input', () => { fxState.form.note = $('fxNote').value; });
    $('fxSubmit').addEventListener('click', submit);

    $('fxPaneEntry').addEventListener('click', e => {
      const t = e.target;
      const cur = t.closest('[data-fx-cur]');
      if (cur) { setCurrency(cur.dataset.fxCur); return; }
      const action = t.closest('[data-fx-action]');
      if (!action) return;
      const a = action.dataset.fxAction;
      if (a === 'more-currency') { ui.moreCurrencies = !ui.moreCurrencies; renderCurrencyChoices(); }
      if (a === 'edit-rate') {
        ui.rateEditing = true;
        renderRateBox();
        const input = $('fxRateInput');
        if (input) try { input.focus(); input.select(); } catch (err) {}
      }
      if (a === 'done-rate') {
        const input = $('fxRateInput');
        if (input && input.value.trim() && !parseRateInput(input.value)) {
          Motion.shake(input);
          showToast('匯率必須大於 0 且不超過 ' + RATE_MAX, 'error');
          return;
        }
        ui.rateEditing = !currentRate();
        renderRateBox();
      }
      if (a === 'reset-rate') {
        fxState.form.rate = rateFor(currentKey(), fxState.form.currency);
        fxState.form.rateManual = false;
        ui.rateEditing = false;
        renderRateBox();
        renderAmount();
      }
      if (a === 'reload-ledger') fetchLedger(currentKey(), true);
    });
    $('fxPaneEntry').addEventListener('input', e => {
      if (e.target.id !== 'fxRateInput') return;
      const v = parseRateInput(e.target.value);
      if (v) {
        fxState.form.rate = v;
        fxState.form.rateManual = v !== rateFor(currentKey(), fxState.form.currency);
      } else {
        fxState.form.rate = null;
      }
      renderAmount();
    });
    $('fxPaneEntry').addEventListener('keydown', e => {
      if (e.target.id === 'fxRateInput' && e.key === 'Enter') {
        e.preventDefault();
        const done = document.querySelector('#fxRateBox [data-fx-action="done-rate"]');
        if (done) done.click();
      }
    });

    const onRecord = e => {
      if (e.target.closest('[data-fx-action="reload-ledger"]')) { fetchLedger(currentKey(), true); return; }
      const rec = recordFromEvent(e.target);
      const act = e.target.closest('[data-fx-rec-act]');
      if (rec && act && act.dataset.fxRecAct === 'delete') openDeleteRecordModal(rec);
      else if (rec) openRecordModal(rec);
      else if (e.target.closest('.fx-rec.is-pending')) showToast('資料同步中，暫時無法修改', 'info');
    };
    onActivate($('fxRecentList'), onRecord);
    onActivate($('fxDetailList'), onRecord);
    $('fxFilterChips').addEventListener('click', e => {
      const chip = e.target.closest('[data-fx-filter]');
      if (!chip) return;
      fxState.filter = chip.dataset.fxFilter;
      ui.detailCount = DETAIL_PAGE_SIZE;
      renderDetail();
    });
    $('fxStats').addEventListener('click', e => {
      if (e.target.closest('[data-fx-action="reload-ledger"]')) fetchLedger(currentKey(), true);
    });

    ModalManager.register('fxLedgerModal', { close: closeLedgerModal, busy: () => Boolean(ui.ledgerModal && ui.ledgerModal.busy) });
    ModalManager.register('fxDeleteLedgerModal', { close: closeDeleteLedgerModal, busy: () => ui.deleteLedgerBusy });
    ModalManager.register('fxRecordModal', { close: closeRecordModal, busy: () => ui.recordBusy });
    ModalManager.register('fxDeleteRecordModal', { close: closeDeleteRecordModal });

    const backdropClose = (id, fn) => {
      $(id).addEventListener('click', e => { if (e.target === e.currentTarget) fn(); });
    };
    backdropClose('fxLedgerModal', closeLedgerModal);
    backdropClose('fxDeleteLedgerModal', closeDeleteLedgerModal);
    backdropClose('fxRecordModal', closeRecordModal);
    backdropClose('fxDeleteRecordModal', closeDeleteRecordModal);

    $('fxLedgerModalCloseBtn').addEventListener('click', closeLedgerModal);
    $('fxLedgerCancelBtn').addEventListener('click', closeLedgerModal);
    $('fxLedgerSubmitBtn').addEventListener('click', submitLedgerModal);
    $('fxArchiveBtn').addEventListener('click', toggleArchive);
    $('fxDeleteLedgerBtn').addEventListener('click', openDeleteLedgerModal);
    $('fxCountryChoices').addEventListener('click', e => {
      const btn = e.target.closest('[data-fx-country]');
      const m = ui.ledgerModal;
      if (!btn || !m) return;
      m.country = btn.dataset.fxCountry;
      const nameInput = $('fxLedgerNameInput');
      if (!m.nameTouched) nameInput.value = m.country;
      renderCountryChoices();
      validateLedgerModal();
    });
    $('fxLedgerNameInput').addEventListener('input', () => {
      const m = ui.ledgerModal;
      if (m) m.nameTouched = $('fxLedgerNameInput').value.trim() !== '' && $('fxLedgerNameInput').value.trim() !== m.country;
      validateLedgerModal();
    });
    $('fxLedgerNameInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); submitLedgerModal(); }
    });
    $('fxStartInput').addEventListener('change', () => {
      const s = $('fxStartInput').value;
      const endInput = $('fxEndInput');
      if (isIso(s) && (!isIso(endInput.value) || endInput.value < s)) endInput.value = s;
      validateLedgerModal();
    });
    $('fxEndInput').addEventListener('change', validateLedgerModal);

    $('fxDeleteLedgerCloseBtn').addEventListener('click', closeDeleteLedgerModal);
    $('fxDeleteLedgerCancelBtn').addEventListener('click', closeDeleteLedgerModal);
    $('fxDeleteLedgerConfirmBtn').addEventListener('click', confirmDeleteLedger);
    $('fxDeleteLedgerInput').addEventListener('input', () => {
      const ledger = findLedger(ui.deleteLedgerId);
      $('fxDeleteLedgerConfirmBtn').disabled = !ledger || $('fxDeleteLedgerInput').value !== ledger.name || ui.deleteLedgerBusy;
    });
    $('fxDeleteLedgerInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); confirmDeleteLedger(); }
    });

    $('fxRecordCloseBtn').addEventListener('click', closeRecordModal);
    $('fxRecordCancelBtn').addEventListener('click', closeRecordModal);
    $('fxRecordSubmitBtn').addEventListener('click', submitRecordModal);
    $('fxEditCurrencyChoices').addEventListener('click', e => {
      const btn = e.target.closest('[data-fx-edit-cur]');
      if (btn) setEditCurrency(btn.dataset.fxEditCur);
    });
    $('fxEditAmount').addEventListener('input', updateEditConvert);
    $('fxEditRate').addEventListener('input', updateEditConvert);

    $('fxDeleteRecordCloseBtn').addEventListener('click', closeDeleteRecordModal);
    $('fxDeleteRecordCancelBtn').addEventListener('click', closeDeleteRecordModal);
    $('fxDeleteRecordConfirmBtn').addEventListener('click', confirmDeleteRecord);

    document.addEventListener('click', e => {
      if (!e.target.closest('.fx-date-wrap')) closeCalendar();
      if (!e.target.closest('.fx-menu-wrap')) closeMenu();
    });
    document.addEventListener('keydown', e => {
      if (e.key !== 'Escape') return;
      const cal = $('fxCalendar');
      if (cal && !cal.hidden) closeCalendar();
      closeMenu();
    });

    const cached = LocalCache.getFxList();
    if (cached) fxState.ledgers = cached.ledgers;
    updateTripHint();
    const kick = () => scheduleIdle(() => {
      if (ui.active) return;
      loadLedgerList(false, { silent: true, prefetchHint: true });
    }, 5000);
    if (document.readyState === 'complete') setTimeout(kick, 800);
    else window.addEventListener('load', () => setTimeout(kick, 800), { once: true });
  }

  init();

  return {
    onEnter: onEnter,
    onLeave: onLeave,
    updateTripHint: updateTripHint,
  };
})();
