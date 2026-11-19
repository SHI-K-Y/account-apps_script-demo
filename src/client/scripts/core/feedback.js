function setLoading(isLoading) {
  document.body.classList.toggle('busy', isLoading);
  if (!isLoading) RefreshSpin.stopAll();
}

function showServerError(error) {
  setLoading(false);
  const message = error && error.message ? error.message : String(error || '發生未知錯誤');
  showToast(message, 'error');
  console.error(error);
}

const TOAST_DURATION = 2800;
const TOAST_ICONS = { success: 'check', error: 'x', info: 'info' };

function showToast(message, type = '') {
  const toast = document.getElementById('toast');
  if (!toast) return;
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
  // 收起後的 toast 是 display: none（06-today-recent.css）：先以收起狀態出現、算一次樣式，再加 .show，淡入才有起點
  clearTimeout(toast._parkTimer);
  if (!wasShown && !toast.classList.contains('is-animating')) {
    toast.classList.add('is-animating');
    void toast.offsetWidth;
  }
  toast.className = `toast show ${type}`;
  toast.style.setProperty('--toast-ms', TOAST_DURATION + 'ms');

  progressEl.style.animation = 'none';
  void progressEl.offsetWidth;
  progressEl.style.animation = '';

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
  }, TOAST_DURATION);
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
