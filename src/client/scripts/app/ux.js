/* =============================================================================
 * UX 強化 — 不改變外觀，只補上讓記帳更順、更不容易出錯的行為
 * -----------------------------------------------------------------------------
 *  1. 桌面鍵盤記帳：在記帳頁直接按數字鍵輸入金額、Backspace 刪除、Enter 送出。
 *  2. 連線狀態：斷線／恢復連線時用提示告知（斷線時送出的記帳會立刻回報失敗，不會卡住）。
 *  3. 儲存中離開保護：資料還在寫入試算表時關閉或重新整理頁面，會先跳出確認。
 *  4. 跨日校正：頁面放著過夜後回來，若日期欄還停在「昨天的今天」，自動改成今天，避免記錯日期。
 *  5. 久未使用自動同步：頁面在背景超過 10 分鐘後回到前景，背景同步一次最新資料。
 *  6. 無障礙語意：底部導覽標示目前頁面（aria-current）、支出／收入分頁標示選取狀態（aria-selected）。
 *  7. 返回頂端：記帳頁往下捲動一段距離後，右下角出現圓形按鈕，點一下回到頁面頂端。
 * ============================================================================= */
const UxEnhancements = (function() {
  const STALE_AFTER_MS = 10 * 60 * 1000;
  let lastSeenToday = '';
  let hiddenAt = 0;

  function activeEntryType() {
    return document.body.dataset.mode === 'income' ? 'income' : 'expense';
  }

  /* ---------- 1. 桌面鍵盤記帳 ---------- */
  function isTypingTarget(target) {
    return Boolean(target && target.closest && target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'));
  }

  function hasOpenOverlay() {
    if (document.querySelector('.modal-backdrop.show')) return true;
    const pop = document.getElementById('emojiPickerPopover');
    return Boolean(pop && !pop.hidden);
  }

  function flashKeypadKey(type, label) {
    const pad = document.getElementById(type + 'Keypad');
    if (!pad) return;
    const btn = Array.prototype.find.call(pad.querySelectorAll('.key'), function(el) {
      return el.getAttribute('aria-label') === label;
    });
    if (!btn) return;
    btn.classList.add('is-kbd-active');
    setTimeout(function() { btn.classList.remove('is-kbd-active'); }, 130);
  }

  function onEntryKeydown(e) {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
    if (document.body.dataset.page !== 'bookkeeping') return;
    if (document.body.classList.contains('busy') || hasOpenOverlay() || isTypingTarget(e.target)) return;

    const type = activeEntryType();
    if (/^[0-9]$/.test(e.key)) {
      pressKey(type, e.key);
      flashKeypadKey(type, e.key);
      e.preventDefault();
    } else if (e.key === 'Backspace') {
      pressKey(type, '⌫');
      flashKeypadKey(type, '刪除一位');
      e.preventDefault();
    } else if (e.key === 'Enter') {
      // 焦點在按鈕或連結上時，Enter 交還給該元件本身。
      if (e.target && e.target.closest && e.target.closest('button, a, summary, [role="button"], [role="tab"]')) return;
      if (!state[type].amount) return;
      const submit = document.getElementById(type + 'Submit');
      if (submit && !submit.disabled) {
        submit.click();
        e.preventDefault();
      }
    }
  }

  /* ---------- 2. 連線狀態 ---------- */
  function bindConnectivity() {
    window.addEventListener('offline', function() {
      document.body.dataset.offline = 'true';
      showToast('目前沒有網路連線，恢復連線前無法送出記帳', 'error');
    });
    window.addEventListener('online', function() {
      if (document.body.dataset.offline !== 'true') return;
      delete document.body.dataset.offline;
      showToast('已恢復連線', 'success');
    });
  }

  /* ---------- 3. 儲存中離開保護 ---------- */
  function bindUnloadGuard() {
    window.addEventListener('beforeunload', function(e) {
      if (!Api.pendingWrites()) return;
      e.preventDefault();
      e.returnValue = '';
    });
  }

  /* ---------- 4. 跨日校正 ＋ 5. 久未使用自動同步 ---------- */
  function syncDateAfterRollover() {
    const client = getClientToday();
    if (!lastSeenToday) { lastSeenToday = client.todayISO; return; }
    if (client.todayISO === lastSeenToday) return;

    const previousToday = lastSeenToday;
    lastSeenToday = client.todayISO;
    if (state.data) {
      state.data.todayISO = client.todayISO;
      state.data.currentMonth = client.currentMonth;
    }
    if (getMonth() !== client.currentMonth) {
      // 跨月：新月份的工作表不一定已建立，交給使用者決定，這裡只提醒。
      showToast('已經進入新的月份，記帳前請確認上方的月份與日期', 'info');
      return;
    }
    ['expenseDate', 'incomeDate'].forEach(function(id) {
      const input = document.getElementById(id);
      // 只修正「還停在舊的今天」的欄位；使用者刻意選的其他日期不動。
      if (input && input.value === previousToday) {
        input.value = client.todayISO;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    });
  }

  function refreshIfStale() {
    const wasHiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
    hiddenAt = 0;
    if (wasHiddenFor < STALE_AFTER_MS) return;
    if (!state.data || document.body.classList.contains('busy') || Api.pending() || hasOpenOverlay()) return;
    syncInitialDataInBackground(false);
  }

  function bindReturnToApp() {
    lastSeenToday = getClientToday().todayISO;
    document.addEventListener('visibilitychange', function() {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      syncDateAfterRollover();
      refreshIfStale();
    });
    window.addEventListener('focus', syncDateAfterRollover);
  }

  /* ---------- 6. 無障礙語意 ---------- */
  function syncNavSemantics() {
    document.querySelectorAll('.nav-item').forEach(function(btn) {
      if (btn.classList.contains('active')) btn.setAttribute('aria-current', 'page');
      else btn.removeAttribute('aria-current');
    });
  }

  function syncTabSemantics() {
    document.querySelectorAll('.tab[data-tab]').forEach(function(tab) {
      const selected = tab.classList.contains('active');
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', selected ? 'true' : 'false');
      tab.setAttribute('aria-controls', tab.dataset.tab + 'Panel');
    });
  }

  function bindSemantics() {
    const nav = document.getElementById('bottomNav');
    if (nav) {
      if (!nav.getAttribute('aria-label')) nav.setAttribute('aria-label', '主要頁面');
      // 導覽與分頁的 active 樣式由各自的程式切換；這裡只跟著同步語意屬性。
      new MutationObserver(syncNavSemantics).observe(nav, { attributes: true, attributeFilter: ['class'], subtree: true });
    }
    const tabs = document.querySelector('.tabs[role="tablist"]');
    if (tabs) {
      if (!tabs.getAttribute('aria-label')) tabs.setAttribute('aria-label', '記帳類型');
      new MutationObserver(syncTabSemantics).observe(tabs, { attributes: true, attributeFilter: ['class'], subtree: true });
    }
    syncNavSemantics();
    syncTabSemantics();
  }

  function bindBackToTop() {
    const btn = document.getElementById('backToTopBtn');
    if (!btn) return;
    const SHOW_AFTER = 400;
    let ticking = false;

    function sync() {
      ticking = false;
      // 不在記帳頁時不必讀捲動位置（換頁時讀會強制排版新頁面）
      const show = document.body.dataset.page === 'bookkeeping' &&
        (window.pageYOffset || document.documentElement.scrollTop || 0) > SHOW_AFTER;
      if (btn.classList.contains('is-visible') === show) return;
      btn.classList.toggle('is-visible', show);
      btn.tabIndex = show ? 0 : -1;
    }
    function schedule() {
      if (ticking) return;
      ticking = true;
      window.requestAnimationFrame(sync);
    }

    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    // 換頁時 body[data-page] 會改變：離開記帳頁要立即收起按鈕
    new MutationObserver(schedule).observe(document.body, { attributes: true, attributeFilter: ['data-page'] });

    btn.addEventListener('click', () => {
      const smooth = typeof Motion !== 'undefined' && Motion.enabled();
      if (typeof Motion !== 'undefined') {
        if (Motion.cancelScroll) Motion.cancelScroll();
        Motion.haptic('light');
      }
      window.scrollTo({ top: 0, behavior: smooth ? 'smooth' : 'auto' });
      // 鍵盤使用者：焦點移回頁首，避免焦點停在即將消失的按鈕上
      const title = document.querySelector('#pageBookkeeping .topbar h1');
      if (title && document.activeElement === btn) {
        title.setAttribute('tabindex', '-1');
        title.focus({ preventScroll: true });
      }
    });

    sync();
  }

  function init() {
    document.addEventListener('keydown', onEntryKeydown);
    bindConnectivity();
    bindUnloadGuard();
    bindReturnToApp();
    bindSemantics();
    bindBackToTop();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  return { syncDateAfterRollover: syncDateAfterRollover };
})();
