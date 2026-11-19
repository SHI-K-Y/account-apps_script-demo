/* =============================================================================
 * BudgetView — 預算數字的顯示（記帳頁「今日總花費」卡片、總覽「支出分析」的進度條）
 * -----------------------------------------------------------------------------
 * 數字都由後端算好（src/server/33_budget.gs 的 computeBudgetStatus_），這裡只負責：
 *   - 判斷手上的數字是不是今天算的（本機快取可能是前幾天的）
 *   - 把還在送出中的今天支出先扣掉，讓「今天還能花」立即反應
 *   - 產生 HTML（動態文字一律經過 escHtml）
 * ============================================================================= */
const BudgetView = (function() {
  const FRESH_MS = 10 * 60 * 1000;

  const money = v => '$' + FinanceUtils.format(Math.round(Math.abs(Number(v) || 0)));

  /** 是不是今天算的：日期相同，或剛從後端拿到（出國時瀏覽器日期可能和台北不同）。 */
  function isFresh(budget) {
    if (!budget) return false;
    if (budget.todayISO === getClientToday().todayISO) return true;
    return typeof budget.generatedAt === 'number' && Math.abs(Date.now() - budget.generatedAt) < FRESH_MS;
  }

  function monthLabel(month) {
    const m = Number(String(month || '').slice(5, 7));
    return m ? m + ' 月' : '';
  }

  function categoriesLabel(budget) {
    const cats = (budget && budget.categories) || [];
    return cats.length ? '（' + cats.join('、') + '）' : '';
  }

  /** 還在送出中、屬於今天且會計入每日額度的支出合計。 */
  function pendingToday(budget) {
    const list = window.__activePendingExpenses || [];
    if (!list.length || !budget || !budget.configured) return 0;
    const cats = new Set(budget.categories || []);
    const reserved = new Set((budget.reserves || []).map(r => r.item));
    const excluded = new Set(budget.excludedItems || []);
    return list.reduce((sum, r) => {
      if (r.month !== budget.month || Number(r.day) !== Number(budget.day)) return sum;
      if (!cats.has(r.category) || reserved.has(r.item) || excluded.has(r.item)) return sum;
      return sum + (Number(r.amount) || 0);
    }, 0);
  }

  function openSettings() {
    if (typeof switchPage === 'function') switchPage('settings');
    const tab = document.querySelector('.settings-tab[data-stab="budget"]');
    if (tab && !tab.classList.contains('active')) tab.click();
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('[data-budget-open-settings]');
    if (!btn) return;
    e.preventDefault();
    openSettings();
  });

  function guideHtml(text) {
    return '<button type="button" class="budget-guide" data-budget-open-settings>' +
             '<span>' + escHtml(text) + '</span>' + iconHtml('caret-right') +
           '</button>';
  }

  /* --------------------------- 記帳頁：今日總花費 --------------------------- */

  /**
   * @param el    #todayBudgetLine
   * @param ctx   { budget, month, isToday, isCurrentMonth }
   */
  function renderToday(el, ctx) {
    if (!el) return;
    const card = document.getElementById('todayExpenseCard');
    const b = ctx.budget && ctx.budget.month === ctx.month ? ctx.budget : null;
    let html = '';
    let warn = false;

    if (!b || !isFresh(b)) {
      html = b && ctx.isCurrentMonth && ctx.isToday ? '<span class="budget-line-muted">今天還能花　計算中…</span>' : '';
    } else if (b.mode === 'current') {
      if (!ctx.isToday) {
        html = '';
      } else if (!b.configured) {
        html = guideHtml('設定每月預算，看看今天還能花多少');
      } else if (b.awaitingIncome) {
        html = '<span class="budget-line-muted">本月還沒記錄生活費收入，記一筆後就會算出預算</span>';
      } else if (b.awaitingBalance) {
        html = '<span class="budget-line-muted">讀不到生活費餘額，暫時無法算出預算</span>';
      } else {
        const left = (Number(b.todayLeft) || 0) - pendingToday(b);
        warn = left < 0;
        const main = warn
          ? '<span class="budget-line-main is-over">今天超支 <b>' + money(left) + '</b></span>'
          : '<span class="budget-line-main">今天還能花 <b>' + money(left) + '</b></span>';
        let sub;
        if (b.remaining < 0) {
          sub = '<span class="budget-line-sub is-over">本月已超支 ' + money(b.overspent) + '</span>';
        } else if (b.shortfall > 0) {
          sub = '<span class="budget-line-sub is-over">扣除預留後不足 ' + money(b.shortfall) + '</span>';
        } else {
          sub = '<span class="budget-line-sub">每日額度 ' + money(b.daily) + '・本月剩 ' + money(b.remaining) + '</span>';
        }
        html = main + sub;
      }
    } else if (b.configured && !b.awaitingBalance) {
      const over = b.remaining < 0;
      warn = over;
      html = '<span class="budget-line-sub' + (over ? ' is-over' : '') + '">' +
               escHtml(monthLabel(b.month)) + '預算 ' + money(b.amount) + '・實際 ' + money(b.spent) +
               (b.mode === 'past' ? (over ? '（超支 ' + money(b.overspent) + '）' : '（結餘 ' + money(b.remaining) + '）') : '') +
             '</span>';
    }

    // 每記一筆都會呼叫：內容沒變就不重建（P06）
    ListRender.setHtml(el, html);
    if (el.hidden !== !html) el.hidden = !html;
    if (el.classList.contains('is-over') !== warn) el.classList.toggle('is-over', warn);
    if (card && card.classList.contains('is-budget-over') !== warn) card.classList.toggle('is-budget-over', warn);
  }

  /* --------------------------- 總覽：預算進度條 --------------------------- */

  function excludedNoteHtml(b) {
    const items = b.excludedItems || [];
    if (!items.length) return '';
    const spent = Number(b.excludedSpent) || 0;
    return '<div class="oc-budget-excluded">' +
             '已排除：' + escHtml(items.join('、')) +
             (spent > 0 ? '（本月 ' + money(spent) + (b.source === 'balance' ? '，不算已花，已從生活費餘額扣除）' : '，未計入預算）') : '') +
           '</div>';
  }

  function progressHtml(budget, month) {
    const b = budget && budget.month === month ? budget : null;
    if (!b || (!isFresh(b) && b.mode === 'current')) return '';
    if (!b.configured) {
      if (b.mode === 'past') return '';
      return '<div class="ov-card oc-card oc-budget is-empty">' + UvFx.cardRing + guideHtml(monthLabel(b.month) + '還沒有設定預算，前往設定') + '</div>';
    }
    if (b.awaitingIncome) {
      return '<div class="ov-card oc-card oc-budget is-empty">' + UvFx.cardRing + '<span class="budget-line-muted">' +
               escHtml(monthLabel(b.month)) + '預算來自生活費收入，目前還沒有記錄</span></div>';
    }
    if (b.awaitingBalance) {
      return '<div class="ov-card oc-card oc-budget is-empty">' + UvFx.cardRing + '<span class="budget-line-muted">' +
               escHtml(monthLabel(b.month)) + '預算來自生活費餘額，' + (b.mode === 'future' ? '到這個月份才會算出' : '目前讀不到餘額') + '</span></div>';
    }

    const amount = Number(b.amount) || 0;
    const spent = Number(b.spent) || 0;
    const over = spent > amount;
    const pct = amount > 0 ? Math.min(100, spent / amount * 100) : (spent > 0 ? 100 : 0);
    const showMarker = b.mode === 'current' && amount > 0 && typeof b.expected === 'number';
    const markerPct = showMarker ? Math.max(0, Math.min(100, b.expected / amount * 100)) : 0;

    let pace = '';
    if (showMarker) {
      const diff = Number(b.paceDiff) || 0;
      if (Math.abs(diff) < 1) pace = '<span class="oc-budget-pace">剛好在進度上</span>';
      else if (diff > 0) pace = '<span class="oc-budget-pace is-ahead">比進度超前 ' + money(diff) + '</span>';
      else pace = '<span class="oc-budget-pace is-behind">比進度落後 ' + money(diff) + '</span>';
    }
    const rest = over
      ? '<span class="oc-budget-rest is-over">' + (b.mode === 'past' ? '超支 ' : '已超支 ') + money(b.overspent) + '</span>'
      : '<span class="oc-budget-rest">' + (b.mode === 'past' ? '結餘 ' : '剩 ') + money(b.remaining) + '</span>';
    const label = (b.mode === 'current' ? '本月預算' : monthLabel(b.month) + '預算') + categoriesLabel(b);
    const aria = label + '，已花 ' + money(spent) + '，預算 ' + money(amount) +
      (showMarker ? '，以今天的日期應花到 ' + money(b.expected) : '');

    return '<div class="ov-card oc-card oc-budget' + (over ? ' is-over' : '') + '">' + UvFx.cardRing +
             '<div class="oc-budget-head">' +
               '<span class="oc-stat-label">' + escHtml(label) + '</span>' +
               '<span class="oc-budget-nums"><b>' + money(spent) + '</b> / ' + money(amount) + '</span>' +
             '</div>' +
             '<div class="oc-budget-track" role="img" aria-label="' + escAttr(aria) + '">' +
               '<span class="oc-budget-fill" style="width:' + pct.toFixed(2) + '%"></span>' +
               (showMarker ? '<span class="oc-budget-marker" style="left:' + markerPct.toFixed(2) + '%" title="以今天的日期應花到 ' + escAttr(money(b.expected)) + '"></span>' : '') +
             '</div>' +
             '<div class="oc-budget-foot">' + pace + rest + '</div>' +
             excludedNoteHtml(b) +
           '</div>';
  }

  return {
    isFresh: isFresh,
    renderToday: renderToday,
    progressHtml: progressHtml,
    openSettings: openSettings,
  };
})();
