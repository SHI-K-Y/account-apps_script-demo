(function bindPressFeedback() {
  const SELECTOR = '.choice, .quick-combo-chip, .key';
  const keyOf = el => el.dataset.value || el.dataset.comboId || '';
  document.addEventListener('click', e => {
    const btn = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
    if (!btn || btn.disabled) return;
    const parent = btn.parentElement;
    const key = keyOf(btn);
    const isKey = btn.classList.contains('key');
    const point = { clientX: e.clientX, clientY: e.clientY, detail: e.detail };
    if (!isKey) Motion.haptic('light');
    requestAnimationFrame(() => {
      let el = btn;
      if (!el.isConnected) {
        el = (key && parent && parent.isConnected)
          ? Array.prototype.find.call(parent.querySelectorAll(SELECTOR), x => keyOf(x) === key)
          : null;
      }
      if (!el) return;
      Motion.ripple(el, el === btn ? point : null);
      if (isKey) return;
      Motion.pop(el);
      const emoji = el.querySelector('.choice-emoji, .quick-combo-chip-emoji');
      if (emoji) {
        Motion.animate(emoji, {
          full: [
            { transform: 'translateY(0)', easing: Motion.ease('out') },
            { transform: 'translateY(-5px) scale(1.12)', offset: 0.4, easing: Motion.ease('spring') },
            { transform: 'translateY(0)' }
          ]
        }, { duration: Motion.dur('slow') });
      }
    });
  }, true);
})();

(function bindChipPop() {
  const SELECTOR = '.sr-chip, .fx-chip, .oc-chip, .recent-date-chip, .card-type-radio-label, .channel-pill-checkbox, .oc-seg button';
  document.addEventListener('click', e => {
    const btn = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
    if (!btn || btn.disabled) return;
    requestAnimationFrame(() => { if (btn.isConnected) Motion.pop(btn, 1.05); });
  }, true);
})();

// 效能：卡片旋轉光環、送出按鈕星點等無限循環裝飾動畫，捲出畫面時暫停、回到畫面時接續播放，
// 現在統一由上方的 Perf 處理（對所有 ambient 動畫生效，未來新增的也自動適用）。

const RefreshSpin = (function() {
  const SELECTOR = '#refreshBtn, #overviewRefreshBtn, #settlementRefreshBtn, #ccRefreshBtn, #settingsRefreshBtn, #fxListRefreshBtn';
  const active = new Set();

  function currentAngle(el) {
    const tf = getComputedStyle(el).transform;
    if (!tf || tf === 'none') return 0;
    const m = tf.match(/matrix\(([^)]+)\)/);
    if (!m) return 0;
    const v = m[1].split(',').map(Number);
    const deg = Math.atan2(v[1], v[0]) * 180 / Math.PI;
    return deg < 0 ? deg + 360 : deg;
  }

  function start(btn) {
    if (!btn) return;
    clearTimeout(btn._spinSafety);
    if (btn._spinStop) { btn._spinStop.cancel(); btn._spinStop = null; }
    btn.classList.add('is-spinning');
    btn.setAttribute('aria-busy', 'true');
    active.add(btn);
    btn._spinSafety = setTimeout(() => stop(btn), 20000);
  }

  function stop(btn) {
    if (!btn || !active.has(btn)) return;
    active.delete(btn);
    clearTimeout(btn._spinSafety);
    btn.removeAttribute('aria-busy');
    const angle = currentAngle(btn);
    btn.classList.remove('is-spinning');
    if (Motion.level() !== 'full' || typeof btn.animate !== 'function') return;
    const end = 360 * Math.ceil((angle + 160) / 360);
    try {
      const anim = btn.animate(
        [{ transform: 'rotate(' + angle + 'deg)' }, { transform: 'rotate(' + end + 'deg)' }],
        { duration: Motion.dur('slow') * 1.6, easing: Motion.ease('out') }
      );
      btn._spinStop = anim;
      anim.finished.then(() => { if (btn._spinStop === anim) btn._spinStop = null; }, () => {});
    } catch (e) {}
  }

  function stopAll() {
    Array.from(active).forEach(stop);
  }

  document.addEventListener('click', e => {
    const btn = e.target && e.target.closest ? e.target.closest(SELECTOR) : null;
    if (btn && !btn.disabled) start(btn);
  }, true);

  return { start: start, stop: stop, stopAll: stopAll };
})();

function markModalAnimating(el) {
  clearTimeout(el._modalAnimTimer);
  el.classList.add('is-animating');
  el._modalAnimTimer = setTimeout(() => el.classList.remove('is-animating'), Motion.dur('slow') + 80);
}

function openModal(el) {
  if (!el) return;
  markModalAnimating(el);
  el.classList.add('show');
  Motion.sheetIn(el, el.querySelector('.modal-card'));
}

function closeModal(el) {
  if (!el) return Promise.resolve();
  if (!el.classList.contains('show')) return Promise.resolve();
  markModalAnimating(el);
  el.classList.remove('show');
  Motion.sheetOut(el, el.querySelector('.modal-card'));
  const wait = Motion.enabled() ? Motion.dur('slow') : 0;
  return new Promise(resolve => setTimeout(resolve, wait));
}
