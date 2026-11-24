/* =============================================================================
 * BudgetSettings — 設定頁的「預算」分頁
 * -----------------------------------------------------------------------------
 * 資料存在試算表的「_預算設定」工作表（後端見 src/server/55_settings_budget.gs）。
 * 每個月份可以有自己的設定；沒有單獨設定的月份沿用之前最近的那一個。
 * 只能設定本月或之後的月份，過去月份不會被回溯改動。
 * ============================================================================= */
const BudgetSettings = (function() {
  const SOURCES = [
    { value: 'fixed', label: '固定金額' },
    { value: 'income', label: '生活費收入' },
    { value: 'balance', label: '生活費餘額' },
    { value: 'off', label: '停用' },
  ];
  const MONTHS_AHEAD = 12;

  const st = {
    data: null,      // getBudgetSettings 的結果（P12：先用本機快取／預取的，再背景更新）
    fetched: false,  // 這份資料是不是這次開啟後從伺服器拿到的（或剛預取的）
    loading: false,
    error: '',
    month: '',
    draft: null,
    saving: false,
    confirmDelete: false,
    confirmTimer: 0,
  };

  const money = v => '$' + FinanceUtils.format(Math.round(Number(v) || 0));

  function options() {
    const simple = (state.data && state.data.options) || {};
    const raw = settingsState.data || {};
    const list = key => (Array.isArray(simple[key]) && simple[key].length)
      ? simple[key]
      : (raw[key] || []).map(o => o && o.value).filter(Boolean);
    return {
      expenseCategories: list('expenseCategories'),
      expenseItems: list('expenseItems'),
      incomeItems: list('incomeItems'),
    };
  }

  function shiftMonth(month, delta) {
    const y = Number(month.slice(0, 4));
    const m = Number(month.slice(5, 7));
    const index = y * 12 + (m - 1) + delta;
    const ny = Math.floor(index / 12);
    const nm = index - ny * 12 + 1;
    return ny + '.' + (nm < 10 ? '0' + nm : nm);
  }

  function versions() { return (st.data && st.data.versions) || []; }

  function versionFor(month) {
    let found = null;
    versions().forEach(v => { if (v.month <= month) found = v; });
    return found;
  }

  function ownVersion(month) {
    return versions().filter(v => v.month === month)[0] || null;
  }

  function makeDraft(month) {
    const v = versionFor(month);
    const cats = options().expenseCategories;
    if (!v) {
      return { source: 'fixed', amount: '', categories: cats.indexOf('生活費') !== -1 ? ['生活費'] : cats.slice(0, 1), incomeItems: [], reserves: [], excludedItems: [] };
    }
    return {
      source: v.source,
      amount: v.source === 'fixed' ? String(v.amount) : '',
      categories: v.categories && v.categories.length ? v.categories.slice() : (cats.indexOf('生活費') !== -1 ? ['生活費'] : []),
      incomeItems: (v.incomeItems || []).slice(),
      reserves: (v.reserves || []).map(r => ({ item: r.item, amount: String(r.amount) })),
      excludedItems: (v.excludedItems || []).slice(),
    };
  }

  function selectMonth(month) {
    st.month = month;
    st.draft = makeDraft(month);
    st.confirmDelete = false;
  }

  function load(container) {
    st.loading = true;
    st.error = '';
    const hadData = Boolean(st.data);
    const done = hadData ? SyncStatus.begin('settings') : function() {};
    Api.call('getBudgetSettings', false)
      .then(data => {
        done();
        st.loading = false;
        st.fetched = true;
        LocalCache.saveBudgetSettings(data);
        const changed = !hadData || JSON.stringify(st.data) !== JSON.stringify(data);
        st.data = data;
        if (!st.month || st.month < data.currentMonth) selectMonth(data.currentMonth);
        else st.draft = st.draft || makeDraft(st.month);
        // 背景更新拿到一樣的資料：不重畫（使用者可能正在輸入）
        if (changed && settingsState.currentTab === 'budget') render(container);
      })
      .catch(err => {
        done();
        st.loading = false;
        if (hadData) return;   // 畫面上的舊資料照樣可以用
        st.error = (err && err.message) || '發生未知錯誤';
        if (settingsState.currentTab === 'budget') render(container);
      });
  }

  /** 還沒有資料時先拿本機快取（開機或記帳後預取的，P12）。本月已經換了就不用舊的。 */
  function adoptCached() {
    if (st.data) return;
    const cached = LocalCache.getBudgetSettings();
    if (!cached || cached.currentMonth !== getClientToday().currentMonth) return;
    st.data = cached;
    st.fetched = Prefetch.isFresh('budget');
    if (!st.month || st.month < cached.currentMonth) selectMonth(cached.currentMonth);
  }

  /* ----------------------------------- 畫面 ----------------------------------- */

  function statusHtml(s) {
    if (!s || !s.configured) {
      return '<div class="pref-card budget-status"><div class="pref-card-title">本月尚未設定預算</div>' +
               '<div class="pref-card-desc">設定後，記帳頁會顯示「今天還能花」，總覽的支出分析會出現預算進度條。</div></div>';
    }
    if (s.awaitingIncome) {
      return '<div class="pref-card budget-status"><div class="pref-card-title">本月預算來自生活費收入</div>' +
               '<div class="pref-card-desc">目前還沒有記錄符合條件的收入，記一筆後就會算出預算。</div></div>';
    }
    if (s.awaitingBalance) {
      return '<div class="pref-card budget-status"><div class="pref-card-title">本月預算來自生活費餘額</div>' +
               '<div class="pref-card-desc">讀不到本月工作表的「累計生活費總收支」，請確認月份工作表已建立、公式沒有錯誤。</div></div>';
    }
    const left = Number(s.todayLeft) || 0;
    const title = '<div class="pref-card-title">本月預算 ' + money(s.amount) + '</div>';
    return '<div class="pref-card budget-status">' +
             (Number(s.excludedSpent) > 0
               ? InfoTip.withTitle(title, 'budgetTip-excluded', '另有排除項目 ' + money(s.excludedSpent) + '（' + (s.excludedItems || []).join('、') + '）' + (s.source === 'balance' ? '不算已花，已從生活費餘額扣除' : '未計入預算'))
               : title) +
             '<div class="budget-status-grid">' +
               '<span><small>已花</small>' + money(s.spent) + '</span>' +
               '<span class="' + (s.remaining < 0 ? 'is-over' : '') + '"><small>' + (s.remaining < 0 ? '已超支' : '剩餘') + '</small>' + money(Math.abs(s.remaining)) + '</span>' +
               '<span><small>每日額度</small>' + money(s.daily) + '</span>' +
               '<span class="' + (left < 0 ? 'is-over' : '') + '"><small>' + (left < 0 ? '今天超支' : '今天還能花') + '</small>' + money(Math.abs(left)) + '</span>' +
             '</div>' +
           '</div>';
  }

  function monthSelectHtml() {
    const current = st.data.currentMonth;
    const months = [];
    for (let i = 0; i < MONTHS_AHEAD; i++) months.push(shiftMonth(current, i));
    versions().forEach(v => { if (v.month >= current && months.indexOf(v.month) === -1) months.push(v.month); });
    months.sort();
    const opts = months.map(m => {
      const tag = m === current ? '（本月）' : (ownVersion(m) ? '（已單獨設定）' : '');
      return '<option value="' + escAttr(m) + '"' + (m === st.month ? ' selected' : '') + '>' + escHtml(m + tag) + '</option>';
    }).join('');

    const own = ownVersion(st.month);
    const inherit = versionFor(st.month);
    let note;
    if (own) note = '這個月份有單獨的設定，儲存後會覆蓋它。';
    else if (inherit) note = '目前沿用 ' + inherit.month + ' 起的設定；儲存後會從這個月份起改用新設定。';
    else note = '目前沒有設定；儲存後會從這個月份起生效。';

    return '<div class="pref-card">' +
             '<div class="pref-card-text">' +
               InfoTip.withTitle('<label class="pref-card-title" for="budgetMonthSelect">套用月份</label>', 'budgetTip-month',
                 '修改只影響所選月份與之後，過去月份的預算不會被改動。之後若有月份另外設定過，會保留那個月份自己的設定。') +
               '<div class="pref-card-note">' + escHtml(note) + '</div>' +
             '</div>' +
             '<select id="budgetMonthSelect" class="month-select budget-month-select">' + opts + '</select>' +
           '</div>';
  }

  function sourceHtml(d) {
    const seg = SOURCES.map(opt => {
      const on = d.source === opt.value;
      return '<button type="button" role="radio" class="pref-seg-btn' + (on ? ' is-active' : '') + '" data-budget-source="' + opt.value + '"' +
               ' aria-checked="' + (on ? 'true' : 'false') + '" tabindex="' + (on ? '0' : '-1') + '">' + opt.label + '</button>';
    }).join('');
    let desc = '';
    if (d.source === 'fixed') desc = '每個月固定一個金額。';
    if (d.source === 'balance') desc = '以總覽的「生活費・目前餘額」當作預算：本月剩餘就是目前餘額，平均分配到剩下的天數。';
    if (d.source === 'off') desc = '從所選月份起不使用預算。';
    return '<div class="pref-card">' +
             '<div class="pref-card-text">' +
               '<div class="pref-card-title" id="budgetSourceTitle">預算來源</div>' +
               (desc ? '<div class="pref-card-desc">' + escHtml(desc) + '</div>' : '') +
             '</div>' +
             '<div class="pref-segmented" role="radiogroup" aria-labelledby="budgetSourceTitle">' + seg + '</div>' +
           '</div>';
  }

  function chipsHtml(list, selected, attr, disabled) {
    if (!list.length) return '<div class="pref-card-desc">（尚無選項）</div>';
    const off = disabled || {};
    return '<div class="budget-chips">' + list.map(name => {
      const on = selected.indexOf(name) !== -1;
      const why = off[name];
      return '<button type="button" class="budget-chip' + (on ? ' is-on' : '') + '" ' + attr + '="' + escAttr(name) + '" aria-pressed="' + (on ? 'true' : 'false') + '"' +
               (why ? ' disabled title="' + escAttr(why) + '"' : '') + '>' +
               (on ? iconHtml('check', 'regular', 'ic-13') : '') + '<span>' + escHtml(name) + '</span>' +
             '</button>';
    }).join('') + '</div>';
  }

  function amountHtml(d) {
    if (d.source === 'fixed') {
      return '<div class="pref-card">' +
               '<label class="pref-card-title" for="budgetAmountInput">每月預算</label>' +
               '<div class="budget-amount-wrap"><span aria-hidden="true">$</span>' +
                 '<input id="budgetAmountInput" class="text-input budget-amount-input" type="text" inputmode="decimal" autocomplete="off" maxlength="12" placeholder="例如 30000" value="' + escAttr(d.amount) + '">' +
               '</div>' +
               '<div class="pref-card-desc">可以填 0，表示這個月不打算花計入預算的錢。</div>' +
             '</div>';
    }
    if (d.source === 'income') {
      return '<div class="pref-card">' +
               '<div class="pref-card-text">' +
                 InfoTip.withTitle('<div class="pref-card-title">算進預算的收入項目</div>', 'budgetTip-income', '預設為全選', { side: true }) +
               '</div>' +
               chipsHtml(options().incomeItems, d.incomeItems, 'data-budget-income') +
             '</div>';
    }
    return '';
  }

  function categoriesHtml(d) {
    return '<div class="pref-card">' +
             '<div class="pref-card-text">' +
               '<div class="pref-card-title">計入預算的總類</div>' +
             '</div>' +
             chipsHtml(options().expenseCategories, d.categories, 'data-budget-category') +
           '</div>';
  }

  function reservesHtml(d) {
    const items = options().expenseItems.filter(name => d.excludedItems.indexOf(name) === -1);
    const used = d.reserves.map(r => r.item);
    const rows = d.reserves.map((r, i) => {
      const opts = items.filter(name => name === r.item || used.indexOf(name) === -1)
        .map(name => '<option value="' + escAttr(name) + '"' + (name === r.item ? ' selected' : '') + '>' + escHtml(name) + '</option>').join('');
      return '<div class="budget-reserve-row">' +
               '<select class="month-select budget-reserve-item" data-budget-reserve-item="' + i + '" aria-label="不計入每日額度的項目">' + opts + '</select>' +
               '<div class="budget-amount-wrap is-compact"><span aria-hidden="true">$</span>' +
                 '<input class="text-input budget-reserve-amount" type="text" inputmode="decimal" autocomplete="off" maxlength="12" placeholder="預留金額" data-budget-reserve-amount="' + i + '" value="' + escAttr(r.amount) + '" aria-label="' + escAttr((r.item || '') + ' 的預留金額') + '">' +
               '</div>' +
               '<button type="button" class="icon-btn budget-reserve-remove" data-budget-reserve-remove="' + i + '" title="移除" aria-label="移除 ' + escAttr(r.item || '') + '">' + iconHtml('x') + '</button>' +
             '</div>';
    }).join('');
    const canAdd = items.some(name => used.indexOf(name) === -1);
    return '<div class="pref-card">' +
             '<div class="pref-card-text">' +
               InfoTip.withTitle('<div class="pref-card-title">不計入每日額度的項目</div>', 'budgetTip-reserve',
                 '例如房租、電信費。月初就先從預算扣掉「預留金額」，付款時在預留範圍內的部分不算進當天的花費，付多的部分才算；這些支出照樣算進本月已花。') +
             '</div>' +
             (rows ? '<div class="budget-reserve-list">' + rows + '</div>' : '') +
             (canAdd ? '<button type="button" class="budget-add-reserve" data-budget-reserve-add>' + iconHtml('plus', 'regular', 'ic-14') + '新增項目</button>' : '') +
           '</div>';
  }

  function excludedHtml(d) {
    const disabled = {};
    d.reserves.forEach(r => { disabled[r.item] = '已設為「不計入每日額度」，請先移除'; });
    return '<div class="pref-card">' +
             '<div class="pref-card-text">' +
               '<div class="pref-card-title">排除項目</div>' +
             '</div>' +
             chipsHtml(options().expenseItems, d.excludedItems, 'data-budget-exclude', disabled) +
           '</div>';
  }

  function historyHtml() {
    const list = versions();
    if (!list.length) return '';
    const applying = versionFor(st.data.currentMonth);
    const rows = list.slice().reverse().map(v => {
      const what = v.source === 'off' ? '停用'
        : v.source === 'balance' ? '生活費餘額'
        : (v.source === 'income' ? '生活費收入' + (v.incomeItems && v.incomeItems.length ? '（' + v.incomeItems.join('、') + '）' : '') : money(v.amount));
      const extra = v.source === 'off' ? '' : (v.categories || []).join('、') +
        ((v.reserves || []).length ? '・預留 ' + v.reserves.map(r => r.item + ' ' + money(r.amount)).join('、') : '') +
        ((v.excludedItems || []).length ? '・排除 ' + v.excludedItems.join('、') : '');
      return '<li class="budget-history-row' + (v === applying ? ' is-current' : '') + '">' +
               '<span class="budget-history-month">' + escHtml(v.month) + ' 起' + (v === applying ? '<em>本月適用</em>' : '') + '</span>' +
               '<span class="budget-history-what">' + escHtml(what) + '</span>' +
               (extra ? '<span class="budget-history-extra">' + escHtml(extra) + '</span>' : '') +
             '</li>';
    }).join('');
    return '<div class="pref-card">' +
             '<div class="pref-card-title">設定紀錄</div>' +
             '<ul class="budget-history">' + rows + '</ul>' +
           '</div>';
  }

  function render(container) {
    if (!container) return;
    bind(container);
    const header = '<div class="settings-list-header"><div class="settings-list-title-wrap">' +
                     '<span class="settings-list-title">預算</span>' +
                   '</div></div>';

    adoptCached();
    if (!st.data) {
      if (st.error) {
        container.innerHTML = header +
          '<div class="settings-empty"><div class="settings-empty-icon" aria-hidden="true">' + iconHtml('warning') + '</div>' +
          '<div class="settings-empty-text">載入失敗：' + escHtml(st.error) + '</div>' +
          '<button type="button" class="settings-add-btn" data-budget-retry>重試</button></div>';
        return;
      }
      container.innerHTML = header + '<div class="overview-skeleton"><div class="skel-block skel-row"></div><div class="skel-block skel-row"></div><div class="skel-block skel-row"></div></div>';
      if (!st.loading) load(container);
      return;
    }

    const d = st.draft || (st.draft = makeDraft(st.month));
    const own = ownVersion(st.month);
    const body = d.source === 'off' ? '' : amountHtml(d) + categoriesHtml(d) + reservesHtml(d) + excludedHtml(d);
    container.innerHTML = header +
      '<div class="pref-list budget-settings">' +
        statusHtml(st.data.status) +
        monthSelectHtml() +
        sourceHtml(d) +
        body +
        '<div class="budget-actions">' +
          (own ? '<button type="button" class="budget-delete-btn' + (st.confirmDelete ? ' is-confirm' : '') + '" data-budget-delete>' +
                   (st.confirmDelete ? '再按一次確認移除' : '移除這個月份的設定') + '</button>' : '<span></span>') +
          '<button type="button" class="settings-add-btn budget-save-btn" data-budget-save' + (st.saving ? ' disabled' : '') + '>' +
            iconHtml(st.saving ? 'spinner-gap' : 'check', 'regular', 'ic-16' + (st.saving ? ' spinner' : '')) +
            (st.saving ? '儲存中…' : '儲存 ' + escHtml(st.month) + ' 起的預算') +
          '</button>' +
        '</div>' +
        historyHtml() +
      '</div>';
    // 分段控制由建立它的渲染函式直接啟用（P06）
    container.querySelectorAll('.pref-segmented').forEach(el => Motion.segmented(el, '.pref-seg-btn'));
    // 記帳之後預算狀態（已花、今天還能花）會變：快取標成過期時也重新讀
    const cacheStatus = LocalCache.status('budget');
    if ((!st.fetched || (cacheStatus && cacheStatus.stale)) && !st.loading) load(container);
  }

  /* ----------------------------------- 操作 ----------------------------------- */

  function toggle(list, value) {
    const i = list.indexOf(value);
    if (i === -1) list.push(value);
    else list.splice(i, 1);
  }

  function buildForm() {
    const d = st.draft;
    return {
      month: st.month,
      source: d.source,
      amount: d.amount,
      categories: d.categories.slice(),
      incomeItems: d.incomeItems.slice(),
      reserves: d.reserves.map(r => ({ item: r.item, amount: r.amount })),
      excludedItems: d.excludedItems.slice(),
    };
  }

  function applyResult(res, container, message) {
    st.data = res;
    st.fetched = true;
    st.saving = false;
    st.confirmDelete = false;
    st.draft = makeDraft(st.month);
    // 記帳頁的「今天還能花」立即更新；之後月份的圖表快取作廢（過去月份不受影響）。
    if (res.status && typeof getMonth === 'function' && getMonth() === res.status.month) {
      state.budget = res.status;
      updateTodayExpenseUI();
    }
    LocalCache.markChartsStale(res.currentMonth);
    LocalCache.saveBudgetSettings(res);
    if (typeof window.__invalidateOverviewFlag === 'function') window.__invalidateOverviewFlag();
    render(container);
    showToast(message, 'success');
  }

  function save(container) {
    if (st.saving) return;
    const d = st.draft;
    if (d.source === 'fixed' && !String(d.amount).trim()) {
      showToast('請輸入每月預算', 'error');
      const input = container.querySelector('#budgetAmountInput');
      if (input) input.focus();
      return;
    }
    if (d.source !== 'off' && !d.categories.length) return showToast('請至少選擇一個計入預算的總類', 'error');
    const missing = d.reserves.filter(r => !String(r.amount).trim())[0];
    if (d.source !== 'off' && missing) return showToast('請輸入「' + missing.item + '」的預留金額', 'error');

    st.saving = true;
    render(container);
    Api.call('saveBudgetSettings', buildForm())
      .then(res => applyResult(res, container, '已儲存 ' + st.month + ' 起的預算'))
      .catch(err => {
        st.saving = false;
        render(container);
        showToast('儲存失敗：' + ((err && err.message) || err), 'error');
      });
  }

  function remove(container) {
    if (st.saving) return;
    if (!st.confirmDelete) {
      st.confirmDelete = true;
      clearTimeout(st.confirmTimer);
      st.confirmTimer = setTimeout(() => {
        st.confirmDelete = false;
        if (settingsState.currentTab === 'budget') render(container);
      }, 4000);
      render(container);
      return;
    }
    clearTimeout(st.confirmTimer);
    st.saving = true;
    render(container);
    Api.call('deleteBudgetSettings', st.month)
      .then(res => applyResult(res, container, '已移除 ' + st.month + ' 的預算設定'))
      .catch(err => {
        st.saving = false;
        st.confirmDelete = false;
        render(container);
        showToast('移除失敗：' + ((err && err.message) || err), 'error');
      });
  }

  function bind(container) {
    if (container._budgetBound) return;
    container._budgetBound = true;

    container.addEventListener('click', e => {
      if (settingsState.currentTab !== 'budget' || !st.draft) {
        if (e.target.closest('[data-budget-retry]')) { st.error = ''; render(container); }
        return;
      }
      const d = st.draft;
      const t = e.target.closest('[data-budget-source], [data-budget-category], [data-budget-income], [data-budget-exclude], [data-budget-reserve-add], [data-budget-reserve-remove], [data-budget-save], [data-budget-delete], [data-budget-retry]');
      if (!t) return;
      if (t.hasAttribute('data-budget-source')) {
        d.source = t.getAttribute('data-budget-source');
        render(container);
        const again = container.querySelector('[data-budget-source="' + d.source + '"]');
        if (again) again.focus();
      } else if (t.hasAttribute('data-budget-category')) {
        toggle(d.categories, t.getAttribute('data-budget-category'));
        render(container);
      } else if (t.hasAttribute('data-budget-income')) {
        toggle(d.incomeItems, t.getAttribute('data-budget-income'));
        render(container);
      } else if (t.hasAttribute('data-budget-exclude')) {
        toggle(d.excludedItems, t.getAttribute('data-budget-exclude'));
        render(container);
      } else if (t.hasAttribute('data-budget-reserve-add')) {
        const used = d.reserves.map(r => r.item);
        const next = options().expenseItems.filter(name => used.indexOf(name) === -1 && d.excludedItems.indexOf(name) === -1)[0];
        if (next) d.reserves.push({ item: next, amount: '' });
        render(container);
        const inputs = container.querySelectorAll('[data-budget-reserve-amount]');
        if (inputs.length) inputs[inputs.length - 1].focus();
      } else if (t.hasAttribute('data-budget-reserve-remove')) {
        d.reserves.splice(Number(t.getAttribute('data-budget-reserve-remove')), 1);
        render(container);
      } else if (t.hasAttribute('data-budget-save')) {
        save(container);
      } else if (t.hasAttribute('data-budget-delete')) {
        remove(container);
      } else if (t.hasAttribute('data-budget-retry')) {
        st.error = '';
        render(container);
      }
    });

    container.addEventListener('keydown', e => {
      const btn = e.target.closest && e.target.closest('[data-budget-source]');
      if (btn) {
        const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
        if (!step) return;
        e.preventDefault();
        const values = SOURCES.map(s => s.value);
        const next = values[(values.indexOf(btn.getAttribute('data-budget-source')) + step + values.length) % values.length];
        const target = container.querySelector('[data-budget-source="' + next + '"]');
        if (target) target.click();
        return;
      }
      if (e.key === 'Enter' && e.target.matches && e.target.matches('#budgetAmountInput, [data-budget-reserve-amount]')) {
        e.preventDefault();
        save(container);
      }
    });

    container.addEventListener('input', e => {
      if (!st.draft) return;
      const t = e.target;
      if (t.id === 'budgetAmountInput') st.draft.amount = t.value;
      else if (t.hasAttribute && t.hasAttribute('data-budget-reserve-amount')) {
        const r = st.draft.reserves[Number(t.getAttribute('data-budget-reserve-amount'))];
        if (r) r.amount = t.value;
      }
    });

    container.addEventListener('change', e => {
      if (!st.draft) return;
      const t = e.target;
      if (t.id === 'budgetMonthSelect') {
        selectMonth(t.value);
        render(container);
      } else if (t.hasAttribute && t.hasAttribute('data-budget-reserve-item')) {
        const r = st.draft.reserves[Number(t.getAttribute('data-budget-reserve-item'))];
        if (r) r.item = t.value;
        render(container);
      }
    });
  }

  return {
    render: render,
    /** 重新讀取（設定頁的重新整理）：畫面上的資料留著，下次畫的時候背景更新。 */
    invalidate: function() {
      st.fetched = false;
      st.error = '';
      st.draft = null;
    },
  };
})();
