const Motion = (function() {
  let reduceMql = null;
  try { reduceMql = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) {}

  const HAPTIC_PATTERNS = { light: 10, success: [15, 40, 15], error: [30, 50, 30] };
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End', ' ']);
  const HEADER_SELECTOR = '.head, .overview-head, .settlement-head, .settings-head, .cc-head, .fx-head';
  const HEADER_SAFE_ZONE = 35;

  function systemReduced() {
    return Boolean(reduceMql && reduceMql.matches);
  }

  function level() {
    const pref = Prefs.get().motion;
    if (pref === 'off') return 'off';
    if (systemReduced()) return 'lite';
    return pref === 'lite' ? 'lite' : 'full';
  }

  function enabled() {
    return level() !== 'off';
  }

  function sync() {
    document.documentElement.setAttribute('data-motion', level());
  }

  function getFinalFrame(frames) {
    if (!frames) return null;
    if (Array.isArray(frames)) return frames.length ? frames[frames.length - 1] : null;
    const result = {};
    Object.keys(frames).forEach(prop => {
      const val = frames[prop];
      result[prop] = Array.isArray(val) ? val[val.length - 1] : val;
    });
    return result;
  }

  function applyFinalState(el, frames, options) {
    const fill = options && typeof options === 'object' ? options.fill : '';
    if (fill !== 'forwards' && fill !== 'both') return;
    const final = getFinalFrame(frames);
    if (!final) return;
    Object.keys(final).forEach(prop => {
      if (prop === 'offset' || prop === 'easing' || prop === 'composite') return;
      try { el.style[prop] = final[prop]; } catch (e) {}
    });
  }

  function animate(el, keyframes, options) {
    if (!el) return Promise.resolve(null);
    const lv = level();
    let frames = keyframes;
    if (keyframes && !Array.isArray(keyframes) && ('full' in keyframes || 'lite' in keyframes)) {
      frames = lv === 'full' ? keyframes.full : (keyframes.lite || null);
      if (lv === 'off') frames = keyframes.lite || keyframes.full;
    }
    if (lv === 'off' || !frames || typeof el.animate !== 'function') {
      if (frames) applyFinalState(el, frames, options);
      return Promise.resolve(null);
    }
    try {
      const anim = el.animate(frames, options);
      return anim.finished.then(() => anim, () => anim);
    } catch (e) {
      applyFinalState(el, frames, options);
      return Promise.resolve(null);
    }
  }

  function haptic(type) {
    try {
      if (typeof navigator.vibrate === 'function') {
        navigator.vibrate(HAPTIC_PATTERNS[type] || HAPTIC_PATTERNS.light);
      }
    } catch (e) {}
  }

  let scrollJob = null;

  function getScrollY() {
    return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
  }

  function getBottomCover(viewportHeight) {
    const nav = document.getElementById('bottomNav');
    if (!nav) return 0;
    const rect = nav.getBoundingClientRect();
    if (!rect.height) return 0;
    return Math.max(0, viewportHeight - rect.top);
  }

  function getPageHeader(el) {
    const page = el.closest('.page-container') || document;
    return page.querySelector(HEADER_SELECTOR);
  }

  function getHeaderBottom(header) {
    if (!header) return 0;
    const stickyTop = parseFloat(getComputedStyle(header).top) || 0;
    return stickyTop + header.offsetHeight;
  }

  function planScroll(el, align) {
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const rect = el.getBoundingClientRect();
    const y = getScrollY();
    const header = getPageHeader(el);
    const marginTop = parseFloat(getComputedStyle(el).scrollMarginTop) || 12;
    const visibleBottom = viewportHeight - getBottomCover(viewportHeight) - 8;
    const headerShown = header && !header.classList.contains('head-hidden');
    const headerReserve = getHeaderBottom(header) + 8;
    const visibleTop = headerShown ? Math.max(marginTop, header.getBoundingClientRect().bottom + 8) : marginTop;

    if (rect.top >= visibleTop && rect.bottom <= visibleBottom) return { visible: true };

    let top;
    if (align === 'end') {
      top = y + rect.bottom - visibleBottom;
    } else {
      top = y + rect.top - marginTop;
      const firstRow = el.querySelector('.choice, .amount-preview, .key, textarea');
      if (firstRow) {
        const rowBottomAfter = firstRow.getBoundingClientRect().bottom - (top - y);
        if (rowBottomAfter > visibleBottom) top += rowBottomAfter - visibleBottom;
      }
    }
    if (header && (top < y || top <= HEADER_SAFE_ZONE) && align !== 'end') {
      top = y + rect.top - Math.max(marginTop, headerReserve);
    }

    const maxTop = Math.max(0, document.documentElement.scrollHeight - viewportHeight);
    top = Math.round(Math.min(Math.max(top, 0), maxTop));
    if (Math.abs(top - y) < 2) return { visible: true };
    return { visible: false, top: top };
  }

  function cancelScroll() {
    const job = scrollJob;
    if (!job) return;
    scrollJob = null;
    clearTimeout(job.timer);
    cancelAnimationFrame(job.raf);
    job.unbind();
    if (job.scrolling) {
      try { window.scrollTo(window.pageXOffset || 0, getScrollY()); } catch (e) {}
    }
    job.resolve(false);
  }

  function playGlow(el, color, frames, options) {
    if (el._motionGlow) { el._motionGlow.remove(); el._motionGlow = null; }
    const layer = document.createElement('span');
    layer.className = 'motion-glow';
    layer.setAttribute('aria-hidden', 'true');
    layer.style.background = color;
    el.appendChild(layer);
    el._motionGlow = layer;
    return animate(layer, frames, options).then(() => {
      layer.remove();
      if (el._motionGlow === layer) el._motionGlow = null;
    });
  }

  function playArriveHint(el) {
    if (level() === 'off') return;
    const glow = getComputedStyle(el).getPropertyValue('--step-glow').trim() || 'rgba(219, 70, 55, 0.12)';
    playGlow(el, glow, {
      full: [
        { opacity: 0, transform: 'scale(0.98)' },
        { opacity: 1, transform: 'scale(1)', offset: 0.35 },
        { opacity: 0, transform: 'scale(1.01)' }
      ],
      lite: [{ opacity: 0 }, { opacity: 1, offset: 0.35 }, { opacity: 0 }]
    }, { duration: 600, easing: 'ease-out' });
  }

  function playErrorHint(el) {
    const lv = level();
    clearTimeout(el._motionErrorTimer);
    el.classList.remove('step-error-static');
    if (lv === 'off') {
      el.classList.add('step-error-static');
      el._motionErrorTimer = setTimeout(() => el.classList.remove('step-error-static'), 1500);
      return;
    }
    const tint = getComputedStyle(el).getPropertyValue('--step-error').trim() || 'rgba(219, 70, 55, 0.18)';
    playGlow(el, tint, {
      full: [{ opacity: 0 }, { opacity: 1, offset: 0.3 }, { opacity: 0 }],
      lite: [{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 0.75 }, { opacity: 0 }]
    }, { duration: lv === 'full' ? 700 : 900, easing: 'ease-out' });
    shake(el);
  }

  function scrollToSection(el, opts) {
    const options = opts || {};
    cancelScroll();
    if (!el) return Promise.resolve(false);

    return new Promise(resolve => {
      const job = { timer: 0, raf: 0, scrolling: false, reason: options.reason || '', resolve: resolve, unbind: function() {} };
      scrollJob = job;

      const onUserInput = e => {
        if (e.type === 'keydown' && !SCROLL_KEYS.has(e.key)) return;
        if (scrollJob === job) cancelScroll();
      };
      const listenOpts = { passive: true, capture: true };
      window.addEventListener('touchstart', onUserInput, listenOpts);
      window.addEventListener('wheel', onUserInput, listenOpts);
      window.addEventListener('keydown', onUserInput, true);
      job.unbind = () => {
        window.removeEventListener('touchstart', onUserInput, listenOpts);
        window.removeEventListener('wheel', onUserInput, listenOpts);
        window.removeEventListener('keydown', onUserInput, true);
      };

      const finish = () => {
        if (scrollJob !== job) return;
        scrollJob = null;
        job.unbind();
        const effect = options.effect || 'arrive';
        if (effect === 'arrive') playArriveHint(el);
        else if (effect === 'error') playErrorHint(el);
        if (typeof options.onArrive === 'function') options.onArrive();
        resolve(true);
      };

      const run = () => {
        if (scrollJob !== job) return;
        if (!el.isConnected || el.hidden || !el.getClientRects().length) {
          scrollJob = null;
          job.unbind();
          resolve(false);
          return;
        }
        const plan = planScroll(el, options.align);
        if (plan.visible) {
          finish();
          return;
        }
        const smooth = enabled();
        job.scrolling = true;
        window.scrollTo({ top: plan.top, behavior: smooth ? 'smooth' : 'auto' });
        if (!smooth) {
          job.raf = requestAnimationFrame(finish);
          return;
        }
        const startedAt = performance.now();
        let lastY = getScrollY();
        let stableFrames = 0;
        const watch = () => {
          if (scrollJob !== job) return;
          const y = getScrollY();
          stableFrames = Math.abs(y - lastY) < 0.5 ? stableFrames + 1 : 0;
          lastY = y;
          if (Math.abs(y - plan.top) < 2 || stableFrames >= 8 || performance.now() - startedAt > 1500) {
            job.scrolling = false;
            finish();
            return;
          }
          job.raf = requestAnimationFrame(watch);
        };
        job.raf = requestAnimationFrame(watch);
      };

      const delay = options.delay == null ? 220 : options.delay;
      const waitDelay = new Promise(r => { job.timer = setTimeout(r, delay); });
      const waitExtra = Promise.resolve(options.after).catch(() => {});
      Promise.all([waitDelay, waitExtra]).then(run);
    });
  }

  const tokenCache = {};
  function token(name, fallback) {
    if (tokenCache[name] !== undefined) return tokenCache[name];
    let val = '';
    try { val = getComputedStyle(document.documentElement).getPropertyValue('--' + name).trim(); } catch (e) {}
    if (val) tokenCache[name] = val;
    return val || fallback;
  }
  const DUR_FALLBACK = { fast: 140, base: 240, slow: 420 };
  function dur(name) {
    const raw = token('dur-' + name, '');
    const num = parseFloat(raw);
    if (!num) return DUR_FALLBACK[name] || 240;
    return /ms$/.test(raw) ? num : (/s$/.test(raw) ? num * 1000 : num);
  }
  function ease(name) {
    const fallback = { out: 'cubic-bezier(0.16, 1, 0.3, 1)', spring: 'cubic-bezier(0.34, 1.56, 0.64, 1)', 'in-out': 'cubic-bezier(0.65, 0, 0.35, 1)' };
    return token('ease-' + name, fallback[name] || 'ease-out');
  }

  function shake(el) {
    return animate(el, {
      full: [
        { transform: 'translateX(0)' },
        { transform: 'translateX(-6px)' },
        { transform: 'translateX(6px)' },
        { transform: 'translateX(-4px)' },
        { transform: 'translateX(3px)' },
        { transform: 'translateX(0)' }
      ]
    }, { duration: 300, easing: ease('in-out') });
  }

  function pop(el, peak) {
    const top = peak || 1.06;
    return animate(el, {
      full: [
        { transform: 'scale(1)', easing: ease('out') },
        { transform: 'scale(' + top + ')', offset: 0.4, easing: ease('spring') },
        { transform: 'scale(1)' }
      ]
    }, { duration: dur('slow') });
  }

  function ripple(target, point) {
    const lv = level();
    if (lv === 'off' || !target || !target.isConnected) return Promise.resolve();
    const rect = target.getBoundingClientRect();
    if (!rect.width || !rect.height) return Promise.resolve();
    const hasPoint = point && point.detail !== 0 && (point.clientX || point.clientY);
    const x = hasPoint ? point.clientX - rect.left : rect.width / 2;
    const y = hasPoint ? point.clientY - rect.top : rect.height / 2;
    const size = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y)) * 2;
    const layer = document.createElement('span');
    layer.className = 'motion-ripple-layer';
    layer.setAttribute('aria-hidden', 'true');
    const dot = document.createElement('span');
    dot.className = 'motion-ripple';
    dot.style.width = dot.style.height = size + 'px';
    dot.style.left = (x - size / 2) + 'px';
    dot.style.top = (y - size / 2) + 'px';
    layer.appendChild(dot);
    target.appendChild(layer);
    return animate(dot, {
      full: [{ transform: 'scale(0)', opacity: 1 }, { transform: 'scale(1)', opacity: 0 }],
      lite: [{ transform: 'scale(1)', opacity: 0.8 }, { transform: 'scale(1)', opacity: 0 }]
    }, { duration: lv === 'full' ? 520 : dur('base'), easing: ease('out') }).then(() => layer.remove());
  }

  function countUp(el, from, to, opts) {
    if (!el) return Promise.resolve();
    const options = opts || {};
    const format = options.format || (v => FinanceUtils.format(Math.round(v)));
    const target = Number(to) || 0;
    const running = Boolean(el._countRaf);
    if (el._countRaf) cancelAnimationFrame(el._countRaf);
    el._countRaf = 0;
    const start = running && typeof el._countCurrent === 'number' ? el._countCurrent : (Number(from) || 0);
    el._countTarget = target;
    const finish = () => {
      el._countRaf = 0;
      el._countCurrent = target;
      el.textContent = format(target);
    };
    const lv = level();
    if (lv === 'off' || start === target) {
      finish();
      return Promise.resolve();
    }
    if (lv === 'lite') {
      finish();
      return animate(el, [{ opacity: 0.35 }, { opacity: 1 }], { duration: dur('base'), easing: 'ease-out' });
    }
    const duration = options.duration || 600;
    const t0 = performance.now();
    el._countCurrent = start;
    el.textContent = format(start);
    return new Promise(resolve => {
      const step = now => {
        const p = Math.min(1, (now - t0) / duration);
        const eased = 1 - Math.pow(1 - p, 3);
        el._countCurrent = start + (target - start) * eased;
        el.textContent = format(el._countCurrent);
        if (p < 1) {
          el._countRaf = requestAnimationFrame(step);
        } else {
          finish();
          resolve();
        }
      };
      el._countRaf = requestAnimationFrame(step);
    });
  }

  function staggerIn(elements, opts) {
    const options = opts || {};
    if (level() === 'off') return;
    const list = Array.prototype.slice.call(elements || [], 0, options.max || 12);
    const step = options.stagger == null ? 30 : options.stagger;
    const distance = options.distance == null ? 8 : options.distance;
    list.forEach((el, i) => {
      animate(el, {
        full: [{ opacity: 0, transform: 'translateY(' + distance + 'px)' }, { opacity: 1, transform: 'none' }],
        lite: [{ opacity: 0 }, { opacity: 1 }]
      }, { duration: dur('base'), delay: i * step, easing: ease('out'), fill: 'backwards' });
    });
  }

  function revealCards(container, selector) {
    if (!container || level() === 'off') return;
    animate(container, [{ opacity: 0 }, { opacity: 1 }], { duration: dur('base'), easing: 'ease-out' });
    const sel = selector || '.ov-hero, .ov-card, .overview-month-badge, .ov-section-title, .settings-item, .settings-empty';
    const found = Array.prototype.filter.call(container.querySelectorAll(sel), el => {
      const parent = el.parentElement && el.parentElement.closest(sel);
      return !parent || !container.contains(parent);
    });
    const list = found.length ? found : Array.prototype.slice.call(container.children);
    staggerIn(list, { max: 8, stagger: 40, distance: 12 });
  }

  function expandIn(el) {
    const lv = level();
    if (!el || !el.isConnected || lv === 'off') return Promise.resolve();
    el.getAnimations && el.getAnimations().forEach(a => a.cancel());
    if (lv === 'lite') return animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: dur('base'), easing: 'ease-out' });
    const cs = getComputedStyle(el);
    const h = el.offsetHeight;
    const prevOverflow = el.style.overflow;
    el.style.overflow = 'hidden';
    return animate(el, [
      { height: '0px', paddingTop: '0px', paddingBottom: '0px', opacity: 0, transform: 'translateY(-10px)' },
      { height: h + 'px', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, opacity: 1, transform: 'none' }
    ], { duration: dur('slow'), easing: ease('out') }).then(() => { el.style.overflow = prevOverflow; });
  }

  function collapseOut(el) {
    if (!el) return Promise.resolve();
    const lv = level();
    el.style.pointerEvents = 'none';
    if (lv === 'off' || !el.isConnected) {
      el.remove();
      return Promise.resolve();
    }
    if (lv === 'lite') {
      return animate(el, [{ opacity: 1 }, { opacity: 0 }], { duration: dur('base'), easing: 'ease-out', fill: 'forwards' })
        .then(() => el.remove());
    }
    const cs = getComputedStyle(el);
    const h = el.offsetHeight;
    el.style.overflow = 'hidden';
    const slide = animate(el, [
      { transform: 'translateX(0)', opacity: 1 },
      { transform: 'translateX(-56px)', opacity: 0 }
    ], { duration: dur('base'), easing: ease('in-out'), fill: 'forwards' });
    const collapse = animate(el, [
      { height: h + 'px', paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom, borderTopWidth: cs.borderTopWidth },
      { height: '0px', paddingTop: '0px', paddingBottom: '0px', borderTopWidth: '0px' }
    ], { duration: dur('base'), delay: dur('fast'), easing: ease('out'), fill: 'forwards' });
    return Promise.all([slide, collapse]).then(() => el.remove());
  }

  function burst(originEl, palette) {
    if (level() !== 'full' || !originEl) return;
    const rect = originEl.getBoundingClientRect();
    if (!rect.width) return;
    const rootStyle = getComputedStyle(document.documentElement);
    const colors = (palette || []).map(name => rootStyle.getPropertyValue(name).trim()).filter(Boolean);
    if (!colors.length) return;
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const layer = document.createElement('div');
    layer.className = 'motion-burst-layer';
    layer.setAttribute('aria-hidden', 'true');
    const count = 8 + Math.floor(Math.random() * 5);
    const jobs = [];
    for (let i = 0; i < count; i++) {
      const p = document.createElement('span');
      p.className = 'motion-particle' + (i % 3 === 0 ? ' is-square' : '');
      p.style.left = cx + 'px';
      p.style.top = cy + 'px';
      p.style.background = colors[i % colors.length];
      layer.appendChild(p);
      const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 1.5;
      const dist = 36 + Math.random() * 48;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist;
      const spin = Math.round((Math.random() - 0.5) * 360);
      jobs.push({ p, dx, dy, spin });
    }
    document.body.appendChild(layer);
    Promise.all(jobs.map(job => animate(job.p, [
      { transform: 'translate(0, 0) scale(1) rotate(0deg)', opacity: 1 },
      { transform: 'translate(' + job.dx + 'px, ' + job.dy + 'px) scale(0.9) rotate(' + job.spin + 'deg)', opacity: 1, offset: 0.55 },
      { transform: 'translate(' + (job.dx * 1.1) + 'px, ' + (job.dy + 26) + 'px) scale(0.4) rotate(' + job.spin + 'deg)', opacity: 0 }
    ], { duration: 600, easing: ease('out') }))).then(() => layer.remove());
  }

  let vtToken = 0;
  function viewTransition(update, kind) {
    if (level() === 'off' || typeof document.startViewTransition !== 'function') {
      update();
      return null;
    }
    const root = document.documentElement;
    const myToken = ++vtToken;
    root.dataset.vt = kind || 'default';
    let transition = null;
    try {
      transition = document.startViewTransition(update);
    } catch (e) {
      delete root.dataset.vt;
      update();
      return null;
    }
    const cleanup = () => { if (vtToken === myToken) delete root.dataset.vt; };
    transition.finished.then(cleanup, cleanup);
    transition.ready.catch(() => {});
    if (transition.updateCallbackDone) transition.updateCallbackDone.catch(() => {});
    return transition;
  }


  function spring(name) {
    const key = name === 'snappy' || name === 'reduced' ? name : 'tap';
    const fallbackEase = { tap: 'cubic-bezier(0.2, 0.85, 0.3, 1)', snappy: 'cubic-bezier(0.25, 0.95, 0.3, 1.02)', reduced: 'cubic-bezier(0.2, 0, 0, 1)' };
    const fallbackDur = { tap: 480, snappy: 650, reduced: 150 };
    const easing = key === 'reduced' ? token('lg-ease-reduced', fallbackEase.reduced) : token('lg-spring-' + key, fallbackEase[key]);
    const raw = token('lg-dur-' + key, '');
    const num = parseFloat(raw);
    const duration = num ? (/ms$/.test(raw) ? num : (/s$/.test(raw) ? num * 1000 : num)) : fallbackDur[key];
    return { easing: easing, duration: duration };
  }

  function currentScale(el, slot) {
    let value = '1 1';
    try {
      const raw = getComputedStyle(el).scale;
      if (raw && raw !== 'none') {
        const parts = raw.split(/\s+/);
        value = parts[0] + ' ' + (parts[1] || parts[0]);
      }
    } catch (e) {}
    const prev = el[slot];
    if (prev && typeof prev.cancel === 'function') prev.cancel();
    el[slot] = null;
    return value;
  }

  const PRESS_SELECTOR = [
    '.topbar-btn-group .icon-btn', '.overview-head .icon-btn', '.fx-head .icon-btn', '.cc-back-btn',
    '.nav-item', '.head .tab', '.fx-head .tab', '.submit-btn', '.modal-btn', '.sr-submit-btn',
    '.settings-tab', '.settings-subtab', '.settings-add-btn', '.settings-top-add-btn', '.settings-action-btn',
    '.settings-emoji-pick-btn', '.settings-save-btn', '.settings-cancel-btn', '.pref-seg-btn',
    '.sheet-link-btn', '.st-clear-btn', '.st-submit-btn', '.st-adjust-btn', '.cc-card-tab', '.cc-filter-btn', '.cc-paid-btn', '.cc-batch-paid-btn',
    '.oc-chip', '.oc-retry', '.oc-seg button',
    '.sr-chip', '.sr-primary-btn', '.sr-stop-btn', '.sr-clear-btn', '.sr-more-toggle', '.sr-bars-toggle', '.sr-recent-chip-main',
    '.fx-add-btn', '.fx-chip', '.fx-cur-more-btn', '.fx-link-btn', '.fx-manage-btn',
    '.recent-date-chip', '.recent-act-btn', '.load-full-btn', '.add-month-btn', '.quick-combo-toggle', '.recent-filter-clear',
    '.card-upload-btn', '.item-modal-pick-btn', '.channel-quick-select-btn', '.quick-combo-no-amount-btn', '.today-expense-back-btn'
  ].join(', ');
  const ROW_PRESS_SELECTOR = [
    '.settings-item', '.recent-item', '.fx-rec', '.cc-tx-item', '.fx-ledger-card',
    '.choice', '.quick-combo-chip', '.key'
  ].join(', ');
  let pressed = null;

  function pressTo(el, target, isRelease, pointerType) {
    const lv = level();
    if (lv === 'off') return;
    const from = currentScale(el, '_lgPressAnim');
    const pointer = pointerType === 'mouse' || pointerType === 'pen';
    let opts;
    if (lv === 'lite') {
      opts = { duration: spring('reduced').duration, easing: spring('reduced').easing, fill: isRelease ? 'none' : 'forwards' };
    } else if (isRelease) {
      const s = spring('tap');
      opts = { duration: pointer ? Math.round(s.duration * 0.7) : s.duration, easing: s.easing, fill: 'none' };
    } else {
      opts = { duration: pointer ? 90 : dur('fast'), easing: ease('out'), fill: 'forwards' };
    }
    const frames = [{ scale: from }, { scale: target }];
    let anim = null;
    try { anim = typeof el.animate === 'function' ? el.animate(frames, opts) : null; } catch (e) { anim = null; }
    el._lgPressAnim = anim;
    if (anim && isRelease) {
      anim.finished.then(() => { if (el._lgPressAnim === anim) el._lgPressAnim = null; }, () => {});
    }
  }

  function releasePress() {
    const cur = pressed;
    if (!cur) return;
    pressed = null;
    cur.el.classList.remove('is-lg-pressed');
    if (cur.scaled) pressTo(cur.el, '1 1', true, cur.type);
  }

  function bindPress() {
    document.addEventListener('pointerdown', e => {
      if (e.button !== 0) return;
      const target = e.target && e.target.closest ? e.target : null;
      let el = target ? target.closest(PRESS_SELECTOR) : null;
      let scaled = true;
      if (!el && target) { el = target.closest(ROW_PRESS_SELECTOR); scaled = false; }
      if (!el || el.disabled) return;
      releasePress();
      pressed = { el: el, type: e.pointerType, scaled: scaled };
      el.classList.add('is-lg-pressed');
      if (!scaled) return;
      const pointer = e.pointerType === 'mouse' || e.pointerType === 'pen';
      const peak = level() === 'lite' ? (pointer ? 1.015 : 1.03) : (pointer ? 1.02 : 1.04);
      pressTo(el, peak + ' ' + peak, false, e.pointerType);
    }, { passive: true, capture: true });
    ['pointerup', 'pointercancel'].forEach(type => {
      document.addEventListener(type, releasePress, { passive: true, capture: true });
    });
    document.addEventListener('pointerleave', releasePress, { passive: true });
    window.addEventListener('blur', releasePress);
  }

  const SPECULAR_SELECTOR = '.topbar-btn-group, .overview-head .icon-btn, .fx-head .icon-btn, .cc-back-btn, .bottom-nav';
  function bindSpecular() {
    let mql = null;
    try { mql = window.matchMedia('(hover: hover) and (pointer: fine)'); } catch (e) {}
    if (!mql) return;
    let current = null;
    let raf = 0;
    let lastEvent = null;
    const clear = el => {
      if (!el) return;
      el.style.removeProperty('--lg-x');
      el.style.removeProperty('--lg-y');
    };
    const flush = () => {
      raf = 0;
      const e = lastEvent;
      if (!e) return;
      const el = e.target && e.target.closest ? e.target.closest(SPECULAR_SELECTOR) : null;
      if (el !== current) { clear(current); current = el; }
      if (!el || !mql.matches || level() !== 'full') return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      el.style.setProperty('--lg-x', (((e.clientX - rect.left) / rect.width) * 100).toFixed(1) + '%');
      el.style.setProperty('--lg-y', (((e.clientY - rect.top) / rect.height) * 100).toFixed(1) + '%');
    };
    document.addEventListener('pointermove', e => {
      if (e.pointerType !== 'mouse' && e.pointerType !== 'pen') return;
      lastEvent = e;
      if (!raf) raf = requestAnimationFrame(flush);
    }, { passive: true });
    document.addEventListener('pointerleave', () => { clear(current); current = null; }, { passive: true });
  }

  function liquidStretch(el, dx, width) {
    const lv = level();
    if (!el || lv === 'off' || !dx) return Promise.resolve();
    if (lv === 'lite') {
      currentScale(el, '_lgStretchAnim');
      return animate(el, { lite: [{ opacity: 0.2 }, { opacity: 1 }] }, { duration: spring('reduced').duration, easing: spring('reduced').easing });
    }
    const from = currentScale(el, '_lgStretchAnim');
    const k = Math.min(0.32, 0.12 + (Math.abs(dx) / Math.max(width || 1, 1)) * 0.1);
    const stretched = (1 + k).toFixed(3) + ' ' + (1 - k * 0.3).toFixed(3);
    const s = spring('snappy');
    let anim = null;
    try {
      anim = el.animate([
        { scale: from, easing: ease('out') },
        { scale: stretched, offset: 0.28, easing: s.easing },
        { scale: '1 1' }
      ], { duration: s.duration });
    } catch (e) { anim = null; }
    el._lgStretchAnim = anim;
    if (!anim) return Promise.resolve();
    return anim.finished.then(() => { if (el._lgStretchAnim === anim) el._lgStretchAnim = null; }, () => {});
  }

  // 選中分頁的指示器：多數分頁列畫在 ::before；記帳頁的分頁列是真實元素 .tabs-indicator（星點與光暈是它的子元素）。
  // 兩者都由容器的 .is-lg-moving 觸發 lgIndicatorStretch（lite 是 motionLiteFadeIn）。
  // 真實元素正在播時直接把那段動畫倒回開頭；沒在播時加上 class 就會開始，兩種情況都不必強制重新排版。
  function replayIndicator(tabs) {
    if (!tabs || level() === 'off') return;
    const indicator = tabs.querySelector(':scope > .tabs-indicator');
    if (indicator) {
      const moving = tabs.classList.contains('is-lg-moving') && indicator.getAnimations
        ? indicator.getAnimations().filter(a => a.animationName === 'lgIndicatorStretch' || a.animationName === 'motionLiteFadeIn')
        : [];
      if (moving.length) moving.forEach(a => { a.currentTime = 0; a.play(); });
      else tabs.classList.add('is-lg-moving');
    } else {
      tabs.classList.remove('is-lg-moving');
      void tabs.offsetWidth;
      tabs.classList.add('is-lg-moving');
    }
    clearTimeout(tabs._lgMoveTimer);
    tabs._lgMoveTimer = setTimeout(() => tabs.classList.remove('is-lg-moving'), spring('snappy').duration + 60);
  }
  function watchIndicator(target, attr, getTabs) {
    if (!target || typeof MutationObserver !== 'function') return;
    let last = target.getAttribute(attr);
    new MutationObserver(() => {
      const now = target.getAttribute(attr);
      if (now === last) return;
      last = now;
      const tabs = getTabs();
      if (tabs && tabs.offsetWidth) replayIndicator(tabs);
    }).observe(target, { attributes: true, attributeFilter: [attr] });
  }

  let lastTrigger = null;
  function bindTriggerCapture() {
    const remember = e => {
      const el = e.target && e.target.closest ? e.target.closest('button, a, select, [role="button"], .choice, .settings-item') : null;
      if (el) lastTrigger = { el: el, t: performance.now() };
    };
    document.addEventListener('pointerdown', remember, { passive: true, capture: true });
    document.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') remember(e); }, true);
  }
  function consumeTrigger(container) {
    const rec = lastTrigger;
    lastTrigger = null;
    if (!rec || performance.now() - rec.t > 800) return null;
    const el = rec.el;
    if (!el || !el.isConnected || (container && container.contains(el))) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return el;
  }

  function flipFrom(card, origin) {
    const to = card.getBoundingClientRect();
    const from = origin.getBoundingClientRect();
    if (!to.width || !to.height) return null;
    const dx = (from.left + from.width / 2) - (to.left + to.width / 2);
    const dy = (from.top + from.height / 2) - (to.top + to.height / 2);
    const s = Math.max(0.3, Math.min(1, Math.max(from.width / to.width, from.height / to.height)));
    return 'translate(' + dx.toFixed(1) + 'px, ' + dy.toFixed(1) + 'px) scale(' + s.toFixed(3) + ')';
  }

  function takeCardState(card) {
    const cs = getComputedStyle(card);
    const state = { transform: cs.transform === 'none' ? 'none' : cs.transform, opacity: cs.opacity };
    if (card._lgSheetAnim) { card._lgSheetAnim.cancel(); card._lgSheetAnim = null; }
    return state;
  }

  function sheetIn(backdrop, card) {
    const lv = level();
    if (!card || lv === 'off') return;
    const running = Boolean(card._lgSheetAnim);
    const origin = consumeTrigger(backdrop);
    if (origin || !running) card._lgOrigin = origin;
    if (lv === 'lite') {
      const start = running ? takeCardState(card) : { transform: 'scale(0.97)', opacity: '0' };
      card.classList.add('is-lg-flip');
      const r = spring('reduced');
      const anim = card.animate([start, { transform: 'none', opacity: 1 }], { duration: Math.max(r.duration, 180), easing: r.easing });
      card._lgSheetAnim = anim;
      anim.finished.then(() => { if (card._lgSheetAnim === anim) { card._lgSheetAnim = null; card.classList.remove('is-lg-flip'); } }, () => {});
      return;
    }
    if (!origin && !running) return;
    const start = running ? takeCardState(card) : null;
    card.classList.add('is-lg-flip');
    const inverse = start ? start.transform : flipFrom(card, origin);
    if (!inverse) { card.classList.remove('is-lg-flip'); return; }
    const s = spring('tap');
    const frames = start
      ? [{ transform: start.transform, opacity: start.opacity }, { transform: 'none', opacity: 1 }]
      : [{ transform: inverse, opacity: 0 }, { opacity: 1, offset: 0.3 }, { transform: 'none', opacity: 1 }];
    let anim = null;
    try { anim = card.animate(frames, { duration: s.duration, easing: s.easing }); } catch (e) { anim = null; }
    card._lgSheetAnim = anim;
    if (!anim) { card.classList.remove('is-lg-flip'); return; }
    anim.finished.then(() => {
      if (card._lgSheetAnim === anim) { card._lgSheetAnim = null; card.classList.remove('is-lg-flip'); }
    }, () => {});
  }

  function sheetOut(backdrop, card) {
    const lv = level();
    if (!card || lv === 'off') return;
    const origin = card._lgOrigin;
    const usable = origin && origin.isConnected && origin.getBoundingClientRect().width > 0;
    const running = Boolean(card._lgSheetAnim);
    if (lv === 'lite' || (!usable && !running)) {
      if (running) { takeCardState(card); card.classList.remove('is-lg-flip'); }
      return;
    }
    const start = takeCardState(card);
    card.classList.add('is-lg-flip');
    const prevTransform = card.style.transform;
    card.style.transform = 'none';
    const inverse = usable ? flipFrom(card, origin) : null;
    card.style.transform = prevTransform;
    if (!inverse) { card.classList.remove('is-lg-flip'); return; }
    const total = Math.min(dur('slow'), spring('tap').duration);
    let anim = null;
    try {
      anim = card.animate([
        { transform: start.transform, opacity: start.opacity },
        { opacity: 1, offset: 0.55 },
        { transform: inverse, opacity: 0 }
      ], { duration: total, easing: ease('in-out'), fill: 'forwards' });
    } catch (e) { anim = null; }
    card._lgSheetAnim = anim;
    if (!anim) { card.classList.remove('is-lg-flip'); return; }
    anim.finished.then(() => {
      if (card._lgSheetAnim !== anim) return;
      card._lgSheetAnim = null;
      setTimeout(() => {
        if (card._lgSheetAnim) return;
        anim.cancel();
        card.classList.remove('is-lg-flip');
      }, 40);
    }, () => {});
  }

  function initRefraction() {
    let ok = false;
    try {
      ok = Boolean(navigator.userAgentData) &&
        typeof CSS !== 'undefined' && CSS.supports('backdrop-filter', 'url(#lg-refract)') &&
        Boolean(document.getElementById('lg-refract'));
    } catch (e) { ok = false; }
    // 所有裝置一律依瀏覽器支援度決定，不分級
    document.documentElement.classList.toggle('lg-can-refract', ok);
  }

  function flipList(container, itemSel, keyFn, mutate) {
    const play = level() === 'full' && container && container.isConnected;
    const first = new Map();
    if (play) {
      container.querySelectorAll(itemSel).forEach(el => { first.set(keyFn(el), el.getBoundingClientRect().top); });
    }
    mutate();
    if (!play || !first.size) return;
    const s = spring('tap');
    container.querySelectorAll(itemSel).forEach(el => {
      const before = first.get(keyFn(el));
      if (before === undefined) return;
      const delta = before - el.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) return;
      try {
        el.animate([{ transform: 'translateY(' + delta.toFixed(1) + 'px)' }, { transform: 'none' }], { duration: s.duration, easing: s.easing });
      } catch (e) {}
    });
  }

  function toggleHidden(el, show) {
    if (!el) return Promise.resolve();
    const target = Boolean(show);
    const current = el._lgOpenTarget !== undefined ? el._lgOpenTarget : !el.hidden;
    if (current === target) return Promise.resolve();
    el._lgOpenTarget = target;
    const lv = level();
    let startH = null;
    let startOpacity = null;
    if (el._lgOpenAnim) {
      const cs = getComputedStyle(el);
      startH = parseFloat(cs.height);
      startOpacity = parseFloat(cs.opacity);
      el._lgOpenAnim.cancel();
      el._lgOpenAnim = null;
    }
    if (lv === 'off' || !el.isConnected) { el.hidden = !target; return Promise.resolve(); }
    if (target) el.hidden = false;
    const full = el.scrollHeight;
    const fromH = startH !== null ? startH : (target ? 0 : full);
    const toH = target ? full : 0;
    const fromO = startOpacity !== null ? startOpacity : (target ? 0 : 1);
    const toO = target ? 1 : 0;
    const s = lv === 'lite' ? spring('reduced') : spring('tap');
    const frames = lv === 'lite'
      ? [{ opacity: fromO }, { opacity: toO }]
      : [{ height: fromH + 'px', opacity: fromO }, { height: toH + 'px', opacity: toO }];
    const prevOverflow = el.style.overflow;
    el.style.overflow = 'hidden';
    let anim = null;
    try { anim = el.animate(frames, { duration: s.duration, easing: s.easing }); } catch (e) { anim = null; }
    if (!anim) { el.style.overflow = prevOverflow; el.hidden = !target; return Promise.resolve(); }
    el._lgOpenAnim = anim;
    return anim.finished.then(() => {
      if (el._lgOpenAnim !== anim) return;
      el._lgOpenAnim = null;
      el.style.overflow = prevOverflow;
      el.hidden = !target;
    }, () => {});
  }

  const PAGE_CARD_SELECTOR = '.ov-hero, .ov-card, .st-date-card, .st-diff-card, .cc-tx-card, .settings-list-container, .sr-sum-card, .sr-group, .fx-ledger-card, .fx-stat-card, .card';
  function revealPageCards(page) {
    if (!page || level() === 'off') return;
    const found = Array.prototype.filter.call(page.querySelectorAll(PAGE_CARD_SELECTOR), el => {
      const parent = el.parentElement && el.parentElement.closest(PAGE_CARD_SELECTOR);
      return el.offsetHeight > 0 && (!parent || !page.contains(parent));
    });
    staggerIn(found, { max: 6, stagger: 25, distance: 6 });
  }

  const SEGMENTED_ACTIVE = '.active, .is-active';
  function segmented(container, itemSel) {
    if (!container || container._lgSeg || !itemSel) return;
    container._lgSeg = true;
    container.classList.add('lg-seg');
    let lastEl = null;
    let lastX = null;
    let lastY = null;
    let lastW = null;
    let lastH = null;
    let raf = 0;
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule(false)) : null;

    function measure(fromSelection) {
      raf = 0;
      if (!container.isConnected) return;
      let act = null;
      const items = container.querySelectorAll(itemSel);
      for (let i = 0; i < items.length; i++) { if (items[i].matches(SEGMENTED_ACTIVE)) { act = items[i]; break; } }
      const w = act ? act.offsetWidth : 0;
      if (!act || !w) return;
      const x = act.offsetLeft;
      const y = act.offsetTop;
      const h = act.offsetHeight;
      if (x === lastX && y === lastY && w === lastW && h === lastH) { lastEl = act; return; }
      const moved = lastX !== null && lastEl !== act && fromSelection;
      container.style.setProperty('--lg-ind-x', x + 'px');
      container.style.setProperty('--lg-ind-y', y + 'px');
      container.style.setProperty('--lg-ind-w', w + 'px');
      container.style.setProperty('--lg-ind-h', h + 'px');
      const first = lastX === null;
      lastX = x; lastY = y; lastW = w; lastH = h; lastEl = act;
      if (first) {
        void container.offsetWidth;
        container.classList.add('lg-seg-on');
      } else if (moved) {
        replayIndicator(container);
      }
    }
    function schedule(fromSelection) {
      if (fromSelection) container._lgSegSel = true;
      if (raf) return;
      raf = requestAnimationFrame(() => { const s = container._lgSegSel; container._lgSegSel = false; measure(s); });
    }
    function observeItems() {
      if (!ro) return;
      ro.disconnect();
      ro.observe(container);
      container.querySelectorAll(itemSel).forEach(el => ro.observe(el));
    }

    if (typeof MutationObserver === 'function') {
      new MutationObserver(records => {
        let rebuilt = false;
        let selection = false;
        for (let i = 0; i < records.length; i++) {
          if (records[i].type === 'childList') rebuilt = true; else selection = true;
        }
        if (rebuilt) observeItems();
        schedule(selection || rebuilt);
      }).observe(container, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    }
    observeItems();
    schedule(false);
  }

  const SEGMENTED_REGISTRY = [
    ['.settings-tabs', '.settings-tab'],
    ['.settings-pay-subnav', '.settings-subtab'],
    ['.pref-segmented', '.pref-seg-btn'],
    ['.cc-card-tabs', '.cc-card-tab'],
    ['.cc-status-filters', '.cc-filter-btn'],
    ['.recent-date-chips', '.recent-date-chip'],
    ['.quick-combo-type-tabs', '.tab'],
    ['.emoji-popover-tabs', '.emoji-pop-tab']
  ];
  // 效能：任何列表重繪都會觸發 body 的 MutationObserver；先用一次合併選擇器快速排除不含分段控制的節點，
  // 避免每個新增節點都跑 8 次 querySelectorAll。
  const SEGMENTED_ANY = SEGMENTED_REGISTRY.map(r => r[0]).join(', ');
  function bindSegmentedAuto() {
    const scan = root => {
      if (!root || root.nodeType !== 1) return;
      if (!(root.matches && root.matches(SEGMENTED_ANY)) && !(root.querySelector && root.querySelector(SEGMENTED_ANY))) return;
      for (let i = 0; i < SEGMENTED_REGISTRY.length; i++) {
        const c = SEGMENTED_REGISTRY[i][0];
        const it = SEGMENTED_REGISTRY[i][1];
        if (root.matches && root.matches(c)) segmented(root, it);
        if (root.querySelectorAll) root.querySelectorAll(c).forEach(el => segmented(el, it));
      }
    };
    scan(document.body);
    if (typeof MutationObserver !== 'function') return;
    new MutationObserver(records => {
      for (let i = 0; i < records.length; i++) {
        const added = records[i].addedNodes;
        for (let j = 0; j < added.length; j++) scan(added[j]);
      }
    }).observe(document.body, { childList: true, subtree: true });
  }

  bindPress();
  bindSpecular();
  bindTriggerCapture();
  initRefraction();
  if (document.body) bindSegmentedAuto();
  else document.addEventListener('DOMContentLoaded', bindSegmentedAuto, { once: true });

  if (reduceMql) {
    const onChange = () => {
      sync();
      try { document.dispatchEvent(new CustomEvent('prefschange', { detail: Prefs.get() })); } catch (e) {}
    };
    if (reduceMql.addEventListener) reduceMql.addEventListener('change', onChange);
    else if (reduceMql.addListener) reduceMql.addListener(onChange);
  }

  sync();

  return {
    level: level,
    enabled: enabled,
    systemReduced: systemReduced,
    sync: sync,
    animate: animate,
    scrollToSection: scrollToSection,
    cancelScroll: cancelScroll,
    haptic: haptic,
    dur: dur,
    ease: ease,
    shake: shake,
    pop: pop,
    ripple: ripple,
    countUp: countUp,
    staggerIn: staggerIn,
    revealCards: revealCards,
    expandIn: expandIn,
    collapseOut: collapseOut,
    burst: burst,
    viewTransition: viewTransition,
    spring: spring,
    liquidStretch: liquidStretch,
    replayIndicator: replayIndicator,
    watchIndicator: watchIndicator,
    segmented: segmented,
    flipList: flipList,
    toggleHidden: toggleHidden,
    revealPageCards: revealPageCards,
    sheetIn: sheetIn,
    sheetOut: sheetOut,
  };
})();
