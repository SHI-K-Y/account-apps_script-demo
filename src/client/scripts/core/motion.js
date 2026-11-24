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

  /** 只重算樣式、不排版：重新觸發 CSS 動畫或轉場時用來取代 void el.offsetWidth。 */
  function flushStyle(el) {
    if (el) void getComputedStyle(el).opacity;
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

  // countUp 每幀改 textContent：跑動期間把寬度鎖在「頭尾兩個數字比較長的那個」，數字變短時容器不會跟著縮，
  // 外面的排版不受影響（數字是 tabular-nums，同樣字數寬度相同；用 ch 估寬度，不必先量測、不會強制排版）。
  // 外層的 contain: layout paint 在 16-motion-prefs.css（.count-num 與各個數字容器）。
  function lockCountWidth(el, a, b) {
    const chars = Math.max(String(a).length, String(b).length);
    el.style.minWidth = 'min(' + chars + 'ch, 100%)';
  }
  function unlockCountWidth(el) {
    if (el.style.minWidth) el.style.minWidth = '';
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
      unlockCountWidth(el);
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
    lockCountWidth(el, format(start), format(target));
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

  /* ---------------------------------------------------------------------------
   * FLIP：高度變化只用 transform／opacity 補間（P05）
   * 以前 expandIn／collapseOut／toggleHidden 直接動 height、padding、border-width，每一幀都要重新排版整頁。
   * 現在排版只在開始（或結束）時變一次，視覺上的「長高／縮短」由後方元素的位移補出來：
   *   - 「後方元素」：同一層後面的兄弟，加上每一層祖先後面的兄弟，直到頁面容器（卡片下方的按鈕、下一張卡片都會跟著動）。
   *   - 位移用獨立的 translate 屬性，不會蓋掉元素本身的 transform（傾斜玻璃、進場動畫、按壓縮放都不受影響）。
   *   - 同一個元素同時被兩段 FLIP 推動時，後來的那段用 composite: 'add' 疊加，各自結束、各自取消都不會跳。
   * 只讀排版（getBoundingClientRect）一次、全部讀完才寫，不會在迴圈裡交錯讀寫。
   * 已知差異：包住清單的卡片本身（背景與邊框）在開始（展開）或結束（收合）時一次變到新高度，
   * 不能像以前那樣逐幀長高——那正是逐幀排版的來源；卡片內、卡片下方的內容仍然連續移動。
   * ------------------------------------------------------------------------- */
  const FLIP_PROP = (() => {
    try { return typeof CSS !== 'undefined' && CSS.supports('translate', '0px 1px') ? 'translate' : 'transform'; } catch (e) { return 'transform'; }
  })();
  const FLIP_BOUNDARY = '.page-container, .modal-card, .modal-backdrop, body';

  function flipValue(y) {
    const v = (Math.abs(y) < 0.05 ? 0 : y).toFixed(2) + 'px';
    return FLIP_PROP === 'translate' ? '0px ' + v : 'translateY(' + v + ')';
  }

  function displayed(node) {
    return node && node.getClientRects().length > 0;
  }

  /** el 在排版中佔的高度（含與下一個元素之間的間距）；元素已在最終位置時量。 */
  function flowSpan(el) {
    const r = el.getBoundingClientRect();
    let next = el.nextElementSibling;
    while (next && !displayed(next)) next = next.nextElementSibling;
    if (next) return next.getBoundingClientRect().top - r.top;
    let prev = el.previousElementSibling;
    while (prev && !displayed(prev)) prev = prev.previousElementSibling;
    if (prev) return r.bottom - prev.getBoundingClientRect().bottom;
    return r.height;
  }

  /** 會因 el 的高度改變而位移、而且位移前後至少有一刻在畫面內的元素。 */
  function flipFollowers(el, span) {
    const out = [];
    const vh = window.innerHeight || document.documentElement.clientHeight;
    const reach = Math.abs(span);
    let node = el;
    while (node && node.parentElement) {
      for (let s = node.nextElementSibling; s; s = s.nextElementSibling) {
        if (!displayed(s)) continue;
        const pos = getComputedStyle(s).position;
        if (pos === 'fixed' || pos === 'absolute') continue;
        const r = s.getBoundingClientRect();
        if (r.top - reach > vh || r.bottom + reach < 0) continue;
        out.push(s);
      }
      const parent = node.parentElement;
      if (parent.matches(FLIP_BOUNDARY)) break;
      node = parent;
    }
    return out;
  }

  /** 讓 nodes 從 from 位移到 to（px，相對於目前排版位置）。keyframes 可以是 [from, to] 或逐格的位移陣列。 */
  function shiftNodes(nodes, offsets, timing) {
    const anims = [];
    nodes.forEach(node => {
      const active = node._lgFlips || (node._lgFlips = new Set());
      const frames = offsets.map(y => ({ [FLIP_PROP]: flipValue(y) }));
      const opts = Object.assign({}, timing);
      if (active.size) opts.composite = 'add';
      let anim = null;
      try { anim = node.animate(frames, opts); } catch (e) { anim = null; }
      if (!anim) return;
      active.add(anim);
      const done = () => { active.delete(anim); };
      anim.finished.then(done, done);
      anims.push(anim);
    });
    return anims;
  }

  function cancelAll(anims) {
    anims.forEach(a => {
      const node = a.effect && a.effect.target;
      if (node && node._lgFlips) node._lgFlips.delete(a);
      try { a.cancel(); } catch (e) {}
    });
  }

  /**
   * 量測一律放到下一個 requestAnimationFrame：呼叫端通常剛改完 DOM（渲染清單、更新金額、顯示提示），
   * 在點擊處理函式裡量會強制同步排版，之後的寫入又讓瀏覽器再排一次。rAF 在這一幀繪製之前執行，
   * 量測就和這一幀本來就要做的排版合併成一次，畫面上也不會先閃出沒有動畫的那一幀。
   */
  function beforePaint(fn) {
    return new Promise(resolve => requestAnimationFrame(() => resolve(fn())));
  }

  function expandIn(el) {
    const lv = level();
    if (!el || !el.isConnected || lv === 'off') return Promise.resolve();
    if (lv === 'lite') {
      el.getAnimations && el.getAnimations().forEach(a => a.cancel());
      return animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: dur('base'), easing: 'ease-out' });
    }
    return beforePaint(() => {
      if (!el.isConnected) return null;
      el.getAnimations && el.getAnimations().forEach(a => a.cancel());
      // 元素已經以最終高度插入（呼叫端剛渲染好）：量出它佔的空間，後方元素從「它還不存在」的位置補間回來
      const span = flowSpan(el);
      const followers = span > 0.5 ? flipFollowers(el, span) : [];
      const timing = { duration: dur('slow'), easing: ease('out') };
      shiftNodes(followers, [-span, 0], timing);
      return animate(el, [
        { opacity: 0, transform: 'translateY(-10px)' },
        { opacity: 1, transform: 'none' }
      ], timing);
    });
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
    // 先量測；元素留在排版裡淡出滑走，後方元素往上補位，全部結束時才移除元素（同一個工作裡取消位移，不會跳一下）
    return beforePaint(() => {
      if (!el.isConnected) return null;
      const span = flowSpan(el);
      const followers = span > 0.5 ? flipFollowers(el, span) : [];
      const slide = animate(el, [
        { transform: 'translateX(0)', opacity: 1 },
        { transform: 'translateX(-56px)', opacity: 0 }
      ], { duration: dur('base'), easing: ease('in-out'), fill: 'forwards' });
      const shifts = shiftNodes(followers, [0, -span], { duration: dur('base'), delay: dur('fast'), easing: ease('out'), fill: 'forwards' });
      const settled = shifts.map(a => a.finished.catch(() => {}));
      return Promise.all([slide].concat(settled)).then(() => {
        el.remove();
        cancelAll(shifts);
      });
    });
  }

  // burst 的顏色：每次送出都 getComputedStyle(documentElement) 會強制重算整頁樣式；改成主題切換時才重新讀
  const burstColorCache = new Map();
  function burstColors(palette) {
    const key = palette.join('|');
    let colors = burstColorCache.get(key);
    if (!colors) {
      const rootStyle = getComputedStyle(document.documentElement);
      colors = palette.map(name => rootStyle.getPropertyValue(name).trim()).filter(Boolean);
      if (colors.length) burstColorCache.set(key, colors);
    }
    return colors;
  }
  function bindColorCacheReset() {
    const reset = () => burstColorCache.clear();
    if (typeof MutationObserver === 'function') {
      new MutationObserver(reset).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    }
    try {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      if (mql.addEventListener) mql.addEventListener('change', reset);
      else if (mql.addListener) mql.addListener(reset);
    } catch (e) {}
  }

  function burst(originEl, palette) {
    if (level() !== 'full' || !originEl) return;
    // 送出時呼叫端剛改完 DOM：位置留到繪製前再量（見 beforePaint）
    requestAnimationFrame(() => { if (originEl.isConnected) burstNow(originEl, palette); });
  }

  function burstNow(originEl, palette) {
    const rect = originEl.getBoundingClientRect();
    if (!rect.width) return;
    const colors = burstColors(palette || []);
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

  /** 用瀏覽器自己算緩動曲線（cubic-bezier 與 linear() 都適用），取 n+1 個點；同一條曲線只算一次。 */
  const easingSamples = new Map();
  function sampleEasing(easing, n) {
    const key = easing + '|' + n;
    if (easingSamples.has(key)) return easingSamples.get(key);
    const out = [];
    let probe = null;
    try {
      probe = document.createElement('div').animate({ opacity: [0, 1] }, { duration: 1000, easing: easing, fill: 'both' });
      probe.pause();
    } catch (e) { probe = null; }
    for (let i = 0; i <= n; i++) {
      let p = i / n;
      if (probe) {
        probe.currentTime = 1000 * i / n;
        const t = probe.effect.getComputedTiming().progress;
        if (typeof t === 'number' && isFinite(t)) p = t;
      }
      out.push(p);
    }
    if (probe) probe.cancel();
    easingSamples.set(key, out);
    return out;
  }

  function scaleYOf(el) {
    const tf = getComputedStyle(el).transform;
    if (!tf || tf === 'none') return 1;
    const m = tf.match(/^matrix\(([^)]+)\)$/);
    if (!m) return 1;
    const v = m[1].split(',').map(Number);
    return isFinite(v[3]) ? v[3] : 1;
  }

  const OPEN_MIN_SCALE = 0.01;
  function stopOpen(el) {
    const run = el._lgOpen;
    if (!run) return null;
    el._lgOpen = null;
    const state = { scale: scaleYOf(el), opacity: parseFloat(getComputedStyle(el).opacity), span: run.span };
    cancelAll(run.anims);
    run.restore();
    return state;
  }

  /**
   * 展開／收合區塊（P05 改成只動 transform／opacity）：
   *   外層 scaleY（transform-origin 在頂端，overflow: hidden 當成會長高的裁切框），
   *   內層 .lg-collapse-inner 反向縮放 1/scale，文字不變形；後方元素依 (scale − 1) × 高度 位移。
   *   彈簧曲線事先取樣成逐格的 keyframes（linear 補間），外層、內層、後方元素用同一組進度，乘起來永遠是 1。
   *   展開時排版一開始就變成最終高度；收合時排版維持到結束才 hidden，兩種情況都只排版一次。
   *   Chrome 與 Safari 都只在合成器上補間 transform／translate／opacity，沒有逐幀排版或重繪。
   */
  function toggleHidden(el, show) {
    if (!el) return Promise.resolve();
    const target = Boolean(show);
    const current = el._lgOpenTarget !== undefined ? el._lgOpenTarget : !el.hidden;
    if (current === target) return Promise.resolve();
    el._lgOpenTarget = target;
    const lv = level();
    const from = stopOpen(el);
    if (lv === 'off' || !el.isConnected) { el.hidden = !target; return Promise.resolve(); }
    if (target) el.hidden = false;
    const fromO = from ? from.opacity : (target ? 0 : 1);
    const toO = target ? 1 : 0;

    const finishWith = (anims, restore, span) => {
      const run = { anims: anims, restore: restore, span: span };
      el._lgOpen = run;
      return Promise.all(anims.map(a => a.finished)).then(() => {
        if (el._lgOpen !== run) return;
        el._lgOpen = null;
        el.hidden = !target;
        cancelAll(anims);
        restore();
      }, () => {});
    };

    if (lv === 'lite') {
      const r = spring('reduced');
      let anim = null;
      try { anim = el.animate([{ opacity: fromO }, { opacity: toO }], { duration: r.duration, easing: r.easing, fill: 'forwards' }); } catch (e) { anim = null; }
      if (!anim) { el.hidden = !target; return Promise.resolve(); }
      return finishWith([anim], () => {}, 0);
    }

    const s = spring('tap');
    // 量測（只讀）：區塊本身的高度與後方元素；之後才寫入
    const span = from && from.span ? from.span : el.offsetHeight;
    const followers = span > 0.5 ? flipFollowers(el, span) : [];
    const inner = el.querySelector(':scope > .lg-collapse-inner');
    // 外層可以縮到 0（後方元素剛好補滿整個高度）；只有內層的反向縮放要避開除以 0
    const fromS = from ? Math.max(0, from.scale) : (target ? 0 : 1);
    const toS = target ? 1 : 0;
    const steps = Math.max(12, Math.ceil(s.duration / 16));
    const curve = sampleEasing(s.easing, steps);
    const scales = curve.map(p => fromS + (toS - fromS) * p);
    if (target) scales[scales.length - 1] = 1;
    const outerFrames = scales.map((k, i) => ({ transform: 'scaleY(' + k.toFixed(4) + ')', opacity: fromO + (toO - fromO) * curve[i] }));
    const innerFrames = scales.map(k => ({ transform: 'scaleY(' + (1 / Math.max(OPEN_MIN_SCALE, k)).toFixed(4) + ')' }));
    const timing = { duration: s.duration, easing: 'linear', fill: target ? 'none' : 'forwards' };

    const prev = { overflow: el.style.overflow, origin: el.style.transformOrigin, innerOrigin: inner ? inner.style.transformOrigin : '' };
    el.style.overflow = 'hidden';
    el.style.transformOrigin = '50% 0';
    if (inner) inner.style.transformOrigin = '50% 0';
    const restore = () => {
      el.style.overflow = prev.overflow;
      el.style.transformOrigin = prev.origin;
      if (inner) inner.style.transformOrigin = prev.innerOrigin;
    };
    const anims = [];
    try {
      anims.push(el.animate(outerFrames, timing));
      if (inner) anims.push(inner.animate(innerFrames, timing));
    } catch (e) {
      cancelAll(anims);
      restore();
      el.hidden = !target;
      return Promise.resolve();
    }
    shiftNodes(followers, scales.map(k => (k - 1) * span), timing).forEach(a => anims.push(a));
    return finishWith(anims, restore, span);
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

  // 寫在靜態 HTML 裡的分段控制：開機第二段掃描一次。
  // 由程式渲染出來的分段控制（偏好設定、預算、提醒的 .pref-segmented，信用卡頁的卡別與繳費狀態）
  // 改由建立它的渲染函式直接呼叫 Motion.segmented(container, itemSel)。
  // P06：以前在 document.body 開了 subtree 的 MutationObserver，任何清單重繪都要經過它；現在已移除。
  const SEGMENTED_STATIC = [
    ['.settings-tabs', '.settings-tab'],
    ['.settings-pay-subnav', '.settings-subtab'],
    ['.recent-date-chips', '.recent-date-chip'],
    ['.quick-combo-type-tabs', '.tab'],
    ['.emoji-popover-tabs', '.emoji-pop-tab']
  ];
  function bindSegmentedStatic() {
    for (let i = 0; i < SEGMENTED_STATIC.length; i++) {
      const it = SEGMENTED_STATIC[i][1];
      document.querySelectorAll(SEGMENTED_STATIC[i][0]).forEach(el => segmented(el, it));
    }
  }

  bindPress();
  bindColorCacheReset();
  bindSpecular();
  bindTriggerCapture();
  initRefraction();
  // 開機第二段才綁（P08）：分頁、篩選晶片的指示器都不在首屏的第一眼範圍，也不用在解析階段建立 ResizeObserver
  BootPhase.later(bindSegmentedStatic);

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
    flushStyle: flushStyle,
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
