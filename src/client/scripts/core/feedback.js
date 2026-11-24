function setLoading(isLoading) {
  document.body.classList.toggle('busy', isLoading);
  if (!isLoading) RefreshSpin.stopAll();
}

/* SyncStatus（P12）：頁面先用本機快取畫好、背景向伺服器取新資料時，在標題旁顯示「更新中」（不遮畫面、不擋操作）。
 *   const done = SyncStatus.begin('overview');  …  done();
 * 同一頁可以同時有好幾件，全部結束才隱藏；150ms 內就結束的不顯示。樣式在 styles/21-ux-enhancements.css。 */
const SyncStatus = (function() {
  const SHOW_DELAY_MS = 150;
  const PAGES = { overview: 'pageOverview', settlement: 'pageSettlement', creditcard: 'pageCreditCard', settings: 'pageSettings', foreign: 'pageForeign' };
  const counts = Object.create(null);

  function pillFor(page) {
    const root = PAGES[page] && document.getElementById(PAGES[page]);
    if (!root) return null;
    const host = page === 'foreign'
      ? root.querySelector(root.dataset.view === 'ledger' ? '#fxLedgerTitle' : '#fxListTitle')
      : root.querySelector('.topbar h1');
    if (!host) return null;
    let pill = host.querySelector('.sync-pill');
    if (!pill) {
      pill = document.createElement('span');
      pill.className = 'sync-pill';
      pill.setAttribute('role', 'status');
      pill.innerHTML = '<span class="sync-pill-dot" aria-hidden="true"></span><span class="sync-pill-text">更新中</span>';
      host.appendChild(pill);
    }
    return pill;
  }

  function begin(page) {
    counts[page] = (counts[page] || 0) + 1;
    const pill = pillFor(page);
    if (pill && counts[page] === 1) {
      clearTimeout(pill._syncTimer);
      pill._syncTimer = setTimeout(() => { if (counts[page]) pill.classList.add('is-on'); }, SHOW_DELAY_MS);
    }
    let ended = false;
    return function end() {
      if (ended) return;
      ended = true;
      counts[page] = Math.max(0, (counts[page] || 0) - 1);
      if (counts[page] || !pill) return;
      clearTimeout(pill._syncTimer);
      pill.classList.remove('is-on');
    };
  }

  return { begin: begin, active: page => (counts[page] || 0) > 0 };
})();

function showServerError(error) {
  setLoading(false);
  const message = error && error.message ? error.message : String(error || '發生未知錯誤');
  showToast(message, 'error');
  console.error(error);
}

const TOAST_DURATION = 2800;
// 帶「復原」按鈕的提示（F05）顯示多久；進度條跟著這個時間跑完
const UNDO_TOAST_MS = 5000;
const TOAST_ICONS = { success: 'check', error: 'x', info: 'info' };

/**
 * showToast(message, type, opts)
 *   opts.duration  顯示多久（毫秒，預設 TOAST_DURATION）
 *   opts.action    { label, onClick }：在提示右側加一個按鈕（例如「復原」），按一次就失效；下一則提示沒有 action 時移除
 */
function showToast(message, type = '', opts) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  const options = opts || {};
  const duration = options.duration > 0 ? options.duration : TOAST_DURATION;
  let iconBox = toast.querySelector('.toast-icon');
  let msgEl = toast.querySelector('.toast-msg');
  let progressEl = toast.querySelector('.toast-progress');
  if (!iconBox || !msgEl || !progressEl) {
    toast.textContent = '';
    iconBox = document.createElement('i');
    iconBox.className = 'toast-icon';
    iconBox.setAttribute('aria-hidden', 'true');
    msgEl = document.createElement('span');
    msgEl.className = 'toast-msg';
    progressEl = document.createElement('span');
    progressEl.className = 'toast-progress';
    progressEl.setAttribute('aria-hidden', 'true');
    toast.append(iconBox, msgEl, progressEl);
  }

  const wasShown = toast.classList.contains('show');
  msgEl.textContent = message;
  iconBox.innerHTML = iconHtml(TOAST_ICONS[type] || TOAST_ICONS.info);
  toast.style.setProperty('--toast-ms', duration + 'ms');

  let actionEl = toast.querySelector('.toast-action');
  if (options.action && typeof options.action.onClick === 'function') {
    if (!actionEl) {
      actionEl = document.createElement('button');
      actionEl.type = 'button';
      actionEl.className = 'toast-action';
      toast.insertBefore(actionEl, progressEl);
    }
    const onClick = options.action.onClick;
    actionEl.textContent = options.action.label || '復原';
    actionEl.disabled = false;
    actionEl.hidden = false;
    actionEl.onclick = () => {
      actionEl.onclick = null;
      actionEl.disabled = true;
      onClick();
    };
  } else if (actionEl) {
    actionEl.onclick = null;
    actionEl.hidden = true;
  }

  // 收起後的 toast 是 display: none（06-today-recent.css）：先以收起狀態出現、算一次樣式，再加 .show，淡入才有起點。
  // 這一次重算放到繪製前的 requestAnimationFrame：呼叫端（送出、刪除）通常剛改完 DOM，
  // 在這裡算會強制同步排版，rAF 裡則和這一幀本來就要做的排版合併。
  clearTimeout(toast._parkTimer);
  toast._type = type + (options.action ? ' has-action' : '');
  const reveal = () => { toast.className = `toast show ${toast._type}`; };
  if (toast._revealRaf) {
    // 已排定在下一幀顯示：那一次會用最新的類型
  } else if (!wasShown && !toast.classList.contains('is-animating')) {
    toast.classList.add('is-animating');
    toast._revealRaf = requestAnimationFrame(() => {
      toast._revealRaf = 0;
      Motion.flushStyle(toast);
      reveal();
    });
  } else {
    reveal();
  }

  // 已經在顯示：進度條換成同內容的另一組 keyframes 重跑（16-motion-prefs.css），不必強制重算樣式
  if (wasShown) progressEl.classList.toggle('is-alt');

  if (wasShown) {
    Motion.animate(msgEl, [{ opacity: 0.25 }, { opacity: 1 }], { duration: Motion.dur('base'), easing: 'ease-out' });
    Motion.animate(iconBox, {
      full: [{ opacity: 0.25, transform: 'scale(0.6)' }, { opacity: 1, transform: 'scale(1)' }],
      lite: [{ opacity: 0.25 }, { opacity: 1 }]
    }, { duration: Motion.dur('slow'), easing: Motion.ease('spring') });
  }

  if (type === 'success') Motion.haptic('light');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    // 淡出期間保留 .is-animating，轉場結束後才停放（display: none，連同毛玻璃一起移除）
    toast.classList.add('is-animating');
    toast.classList.remove('show');
    toast._parkTimer = setTimeout(() => toast.classList.remove('is-animating'), Motion.dur('base') + 80);
    const btn = toast.querySelector('.toast-action');
    if (btn) btn.onclick = null; // 時間到就不能再復原
  }, duration);
}

/**
 * 帶「復原」按鈕的成功提示（F05）：顯示 UNDO_TOAST_MS，按下去執行 undo()。
 *   undo() 回傳 Promise（或值）：成功時顯示它回傳的文字（預設「已復原」），失敗時顯示錯誤（例如另一台裝置改過的衝突）。
 * 呼叫端決定怎麼復原：已送出的寫入用 undoLedgerOps（bookkeeping/submit.js）依 opId 復原；
 * 還在佇列、沒送出的寫入直接從佇列移除即可。
 */
function showUndoToast(message, undo) {
  showToast(message, 'success', {
    duration: UNDO_TOAST_MS,
    action: {
      label: '復原',
      onClick: () => {
        // 一次伺服器執行通常 0.3–2 秒，偶爾更久：「復原中」留到結果回來（結果的提示會取代它）
        showToast('復原中…', 'info', { duration: 15000 });
        Promise.resolve()
          .then(undo)
          .then(text => showToast(typeof text === 'string' && text ? text : '已復原', 'success'))
          .catch(err => {
            showToast((err && err.message) || '復原失敗，請稍後再試一次', 'error');
            console.error(err);
          });
      }
    }
  });
}

function pad(value) {
  return String(value).padStart(2, '0');
}

try {
  if (window.parent && window.parent !== window) {
    var iframes = window.parent.document.querySelectorAll('iframe');
    for (var k = 0; k < iframes.length; k++) {
      iframes[k].style.height = '100%';
      iframes[k].style.minHeight = '100%';
    }
  }
} catch (e) {}

window.addEventListener('mouseenter', function() {
  try { window.focus(); } catch (e) {}
}, { passive: true });
