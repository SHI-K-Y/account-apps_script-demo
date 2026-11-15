/* =============================================================================
 * ReminderPrompt — 打開記帳簿時跳出「午餐尚未記帳」提醒卡片
 * -----------------------------------------------------------------------------
 * 什麼時候該提醒由 core/reminders.js 的 RecordReminders 判斷，這裡負責：
 *   - 時機：啟動資料同步完成後檢查一次（避免用舊的快取誤判）；頁面從背景回到前景時再檢查一次。
 *     頁面一直開著時不會中途跳出來。
 *   - 前往記帳：切到記帳頁的支出／收入、日期設為今天、選好提醒的項目。
 *   - 關閉：這次開啟期間不再出現；重新整理或重新開啟後仍會提醒。
 *   - 今日不再顯示：記在這台裝置，今天之內都不再出現，隔天自動恢復。
 *   - 同時有多個提醒時一次顯示一張，處理完一張再顯示下一張。
 * 「關閉」「今日不再顯示」以項目為單位（同一個項目有多條提醒規則時共用一張卡片）。
 * ============================================================================= */
const ReminderPrompt = (function() {
  const RETRY_MS = 400;

  const st = {
    started: false,
    bound: false,
    syncing: 0,
    wantCheck: false,   // 有一次檢查在等條件（資料、載入畫面、其他視窗）
    waitTimer: 0,
    closed: new Set(),  // 這次開啟期間按過「關閉」或「前往記帳」：key@日期
    current: null,
    queue: [],
  };

  const $ = id => document.getElementById(id);
  const todayISO = () => getClientToday().todayISO;
  const sessionKey = key => key + '@' + todayISO();

  /* ------------------------------- 資料來源 ------------------------------- */

  function optionItems() {
    const o = state.data && state.data.options;
    if (!o || o === DEFAULT_OPTIONS_FALLBACK) return null;
    return { expense: o.expenseItems || [], income: o.incomeItems || [] };
  }

  /** 本月的完整紀錄 { expense, income }；還沒有完整的當月資料時回傳 null（無法判斷就不提醒）。 */
  function currentRecords() {
    const month = getClientToday().currentMonth;
    if (!state.data || !Array.isArray(state.data.months) || state.data.months.indexOf(month) === -1) return null;

    const rs = state.recentState;
    if (getMonth() === month && rs && Array.isArray(rs.expense.fullRecords) && Array.isArray(rs.income.fullRecords)) {
      return { expense: rs.expense.fullRecords, income: rs.income.fullRecords };
    }

    const hasFull = d => Boolean(d && d.month === month && Array.isArray(d.fullExpenses) && Array.isArray(d.fullIncomes));
    const cached = LocalCache.getRecent(month);
    const src = hasFull(cached) ? cached : hasFull(state.data.initialRecent) ? state.data.initialRecent : null;
    if (!src) return null;
    const pending = list => (list || []).filter(r => r && r.month === month);
    return {
      expense: pending(window.__activePendingExpenses).concat(src.fullExpenses),
      income: pending(window.__activePendingIncomes).concat(src.fullIncomes),
    };
  }

  function isSnoozed(key) {
    return LocalCache.getReminderSnooze(todayISO()).indexOf(key) !== -1;
  }

  /** 現在該跳出的提醒；資料還不夠判斷時回傳 null。 */
  function dueNow() {
    const items = optionItems();
    const records = currentRecords();
    if (!items || !records) return null;
    return RecordReminders.due({
      now: new Date(),
      records: records,
      items: items,
      skip: key => st.closed.has(sessionKey(key)) || isSnoozed(key),
    });
  }

  /* --------------------------------- 時機 --------------------------------- */

  function isOpen() {
    const el = $('reminderModal');
    return Boolean(el && el.classList.contains('show'));
  }

  /** 還不適合跳出來：載入畫面還在、正在處理中、其他視窗開著。 */
  function blocked() {
    if (window.__boot && !window.__boot.finished) return true;
    if (document.body.classList.contains('busy')) return true;
    return Boolean(document.querySelector('.modal-backdrop.show'));
  }

  function requestCheck() {
    if (!st.started) return;
    st.wantCheck = true;
    if (st.syncing > 0) return; // 同步結束時會再呼叫
    clearTimeout(st.waitTimer);
    st.waitTimer = setTimeout(attempt, 300);
  }

  function attempt() {
    if (!st.wantCheck || st.syncing > 0) return;
    if (document.visibilityState === 'hidden') return; // 回到前景時會再檢查
    if (isOpen()) { st.wantCheck = false; refresh(); return; }
    if (blocked()) { st.waitTimer = setTimeout(attempt, RETRY_MS); return; }
    const list = dueNow();
    if (list === null) return; // 當月資料還沒到：資料更新時再試
    st.wantCheck = false;
    if (list.length) open(list);
  }

  /* --------------------------------- 卡片 --------------------------------- */

  function describe(r) {
    const kind = RecordReminders.TYPE_LABELS[r.type] || '';
    return r.scope === 'month'
      ? '這個月還沒有「' + r.item + '」的' + kind + '紀錄'
      : '今天 ' + r.time + ' 後還沒有「' + r.item + '」的' + kind + '紀錄';
  }

  function paint(animate) {
    const r = st.current;
    if (!r) return;
    $('reminderModalTitle').textContent = r.item + '尚未記帳';
    $('reminderModalKicker').textContent = '記帳提醒 · ' + RecordReminders.scheduleText(r);
    $('reminderModalDesc').textContent = describe(r);
    const icon = $('reminderModalIcon');
    if (icon) icon.dataset.type = r.type;
    const more = $('reminderModalMore');
    if (more) {
      more.hidden = !st.queue.length;
      more.textContent = st.queue.length
        ? '還有 ' + st.queue.length + ' 項尚未記帳：' + st.queue.map(q => q.item).join('、')
        : '';
    }
    const card = $('reminderCard');
    if (card) card.classList.toggle('has-more', st.queue.length > 0);
    if (animate && card) {
      Motion.animate(card.querySelector('.reminder-header'), {
        full: [{ opacity: 0, transform: 'translateX(18px)' }, { opacity: 1, transform: 'none' }],
        lite: [{ opacity: 0 }, { opacity: 1 }],
      }, { duration: Motion.dur('base'), easing: Motion.ease('out') });
    }
  }

  function focusPrimary() {
    setTimeout(() => {
      const go = $('reminderGoBtn');
      if (go && isOpen()) go.focus({ preventScroll: true });
    }, 60);
  }

  function open(list) {
    const el = $('reminderModal');
    if (!el) return;
    st.queue = list.slice();
    st.current = st.queue.shift();
    paint(false);
    openModal(el);
    Motion.haptic('light');
    focusPrimary();
  }

  function hide() {
    st.current = null;
    st.queue = [];
    const el = $('reminderModal');
    if (el) closeModal(el);
  }

  /** 處理完目前這張：還有下一張就換上，沒有就收起來。 */
  function advance() {
    st.current = st.queue.shift() || null;
    if (!st.current) { hide(); return; }
    paint(true);
    focusPrimary();
  }

  /** 卡片開著時資料更新（例如背景同步帶回其他裝置記的帳）：已經記了的就拿掉。 */
  function refresh() {
    if (!isOpen() || !st.current) return;
    const list = dueNow();
    if (!list) return;
    const keys = new Set(list.map(r => r.key));
    st.queue = st.queue.filter(r => keys.has(r.key));
    if (keys.has(st.current.key)) paint(false);
    else advance();
  }

  function onClose() {
    if (st.current) st.closed.add(sessionKey(st.current.key));
    advance();
  }

  function onSnooze() {
    const r = st.current;
    if (!r) { hide(); return; }
    st.closed.add(sessionKey(r.key)); // 這台裝置無法儲存時，至少這次開啟期間不再出現
    const keys = LocalCache.getReminderSnooze(todayISO());
    if (keys.indexOf(r.key) === -1) keys.push(r.key);
    LocalCache.saveReminderSnooze(todayISO(), keys);
    showToast('今天不會再提醒「' + r.item + '」', 'info');
    advance();
  }

  function onGo() {
    const r = st.current;
    if (!r) { hide(); return; }
    st.closed.add(sessionKey(r.key));
    hide();
    goRecord(r);
  }

  /* ------------------------------- 前往記帳 ------------------------------- */

  function whenOnBookkeeping(fn) {
    if (document.body.dataset.page === 'bookkeeping') { fn(); return; }
    switchPage('bookkeeping');
    const startedAt = Date.now();
    const tick = () => {
      // 換頁可能走 View Transition，真正切過去要等下一幀以後
      if (document.body.dataset.page === 'bookkeeping' || Date.now() - startedAt > 1500) fn();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function goRecord(r) {
    whenOnBookkeeping(() => {
      const client = getClientToday();
      // 提醒判斷的是本月，記帳也記到本月今天
      const select = $('monthSelect');
      if (select && getMonth() !== client.currentMonth && state.data.months.indexOf(client.currentMonth) !== -1) {
        select.value = client.currentMonth;
        select.dispatchEvent(new Event('change', { bubbles: true }));
      }
      const tab = document.querySelector('.tab[data-tab="' + r.type + '"]');
      if (tab && !tab.classList.contains('active')) tab.click();
      const dateInput = $(r.type + 'Date');
      if (dateInput && dateInput.value !== client.todayISO) setToday(r.type + 'Date');

      if (r.type === 'income') {
        state.income.item = r.item;
        renderIncomeChoices();
      } else {
        selectExpenseItem(r.item);
      }

      // 自動捲動開著：跟自己點選項目一樣帶到下一步；關著：捲到項目區，讓人看到已經選好
      setTimeout(() => {
        if (Prefs.get().autoScroll) onUserPick(r.type, 'item');
        else goToEntryStep(r.type, 'item', { reason: 'pick' });
      }, 120);
    });
  }

  /* --------------------------------- 綁定 --------------------------------- */

  function bind() {
    if (st.bound) return;
    st.bound = true;
    ModalManager.register('reminderModal', { close: onClose });
    const on = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };
    on('reminderCloseBtn', onClose);
    on('reminderSnoozeBtn', onSnooze);
    on('reminderGoBtn', onGo);
    const modal = $('reminderModal');
    if (modal) modal.addEventListener('click', e => { if (e.target === e.currentTarget) onClose(); });

    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      // 久未使用時 UxEnhancements 會開始背景同步；晚一拍再檢查，requestCheck 會等同步結束
      setTimeout(requestCheck, 0);
    });
  }

  return {
    /** 啟動流程跑完時呼叫一次（app/bootstrap.js）。 */
    start: function() {
      st.started = true;
      bind();
      requestCheck();
    },
    /** 背景同步開始／結束（app/bootstrap.js）：同步中先不判斷，結束後用最新資料檢查。 */
    syncStarted: function() { st.syncing += 1; },
    syncFinished: function() {
      st.syncing = Math.max(0, st.syncing - 1);
      if (st.syncing === 0 && st.wantCheck) requestCheck();
    },
    /** 記帳列表的資料換新時（bookkeeping/recent.js）。 */
    onRecordsChanged: function() {
      if (isOpen()) refresh();
      else if (st.wantCheck) requestCheck();
    },
    currentRecords: currentRecords,
    optionItems: optionItems,
    isSnoozed: isSnoozed,
  };
})();
