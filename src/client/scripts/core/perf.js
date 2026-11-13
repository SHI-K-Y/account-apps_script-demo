/* =============================================================================
 * Perf — 動畫效能調度中心
 * -----------------------------------------------------------------------------
 * 目標：所有動畫都保留、軌跡與時長不變，只調整「多久更新一次」與「看不到時要不要跑」。
 *
 * 一、裝置分級（<html data-perf="high|mid|low">）
 *   - 開機先用裝置提示（deviceMemory、省流量模式）與上次的實測結果決定等級；
 *   - 執行期間用 requestAnimationFrame 抽樣量測實際幀率，持續掉幀就自動降一級並記住；
 *   - 連續幾次使用都很順，下次開啟會自動試著升回一級；
 *   - 使用者也可以在「偏好設定 → 效能模式」手動指定。
 *
 * 二、氛圍動畫（ambient）治理 —— 只針對「無限循環的裝飾動畫」：
 *   high：完全原樣播放（60/120fps），只有離開畫面或切到背景時暫停（肉眼看不到差別）。
 *   mid ：依動畫速度設定更新頻率上限（10～30fps，見 RATES）；捲動、彈窗開啟、頁面轉場時暫時停住。
 *   low ：更新頻率上限更低（5～20fps）；另外按住/點擊時也先讓出效能；關閉 SVG 折射（靜態效果）。
 *   ※ 更新頻率上限是用 steps() 取樣原本的動畫曲線：路徑、速度、時長、緩動完全一樣，
 *     只是畫面重繪次數變少 —— 背景一變，所有毛玻璃（backdrop-filter）都要重算模糊，
 *     這是本系統最吃 GPU 的地方，降低背景的更新次數等於直接減少整頁的模糊計算。
 *
 * 三、未來新增動畫的規則（照做就會自動被調度，不用改這支程式）：
 *   1. 一次性的動畫（點擊回饋、進場、彈窗）：照常用 Motion.animate()，只動 transform / opacity。
 *   2. 無限循環的裝飾動畫：@keyframes 名稱用「ambient-」開頭（例：ambient-sparkle），
 *      緩慢飄移類用「ambient-slow-」開頭（可降得更多）；或把名稱與頻率加進下方 RATES。
 *      緩動曲線照常寫在 animation-timing-function 即可。
 *   3. 用 JS 建立的無限循環動畫：const a = el.animate(frames, {...});
 *      Perf.adopt(a, { rate: { mid: 30, low: 20 } });
 *      （緩動請寫在 keyframe 內、整體 easing 保持 linear，才能套用更新頻率上限）
 *   4. 只在特定等級要調整的樣式：:root[data-perf="low"] .xxx { ... }
 *   5. 盡量不要做「無限循環 + 動 background-position / background-size / 漸層角度 / box-shadow」，
 *      這些每幀都要重繪；若一定要用，請用 ambient- 命名讓 Perf 調度（離屏暫停、低階裝置降頻）。
 * ============================================================================= */
const Perf = (function() {
  const STORE_KEY = 'FAST_BOOKKEEPING_PERF_V1';
  const ORDER = ['low', 'mid', 'high'];
  const TIERS = {
    high: { refract: true,  holds: ['hidden', 'offscreen'] },
    mid:  { refract: true,  holds: ['hidden', 'offscreen', 'scroll', 'modal', 'vt'] },
    low:  { refract: false, holds: ['hidden', 'offscreen', 'scroll', 'modal', 'vt', 'interact'] }
  };
  const LABELS = { high: '高畫質', mid: '平衡', low: '省電' };
  // 目前專案中的無限循環裝飾動畫（載入中的轉圈圈不算，維持原樣），以及各自在 mid / low 的更新頻率上限。
  // 依「動得多快」決定：動得越慢，降低更新頻率越看不出來。high 一律不設上限（完全原樣）。
  //   背景呼吸：亮度只在 0.98～1.02 之間變化，5fps 時每步亮度差 < 0.2%，肉眼無法分辨。
  //   背景流光：巨大柔和的漸層光暈，10fps 時每步位移遠小於光暈本身的漸層寬度。
  //   分頁星點：每秒只移動 6px，10fps 時每步 0.6px。
  // 背景與分頁列刻意對齊在同一個時間格（0.1s / 0.05s），讓它們在同一幀一起更新，
  // 毛玻璃只需重算一次模糊，而不是各更新各的、模糊被觸發好幾次。
  const RATES = {
    'uv-glow-breathe':  { mid: 10, low: 5 },
    'uv-glow-drift':    { mid: 20, low: 10 },
    'uv-tab-stars-ltr': { mid: 20, low: 10 },
    'uv-tab-stars-rtl': { mid: 20, low: 10 },
    'uv-tab-glow':      { mid: 20, low: 10 },
    'uv-btn-ring':      { mid: 30, low: 20 },
    'uv-btn-stars':     { mid: 20, low: 10 },
    'uv-btn-pulse':     { mid: 30, low: 20 },
    'uv-card-spin':     { mid: 30, low: 20 }
  };
  const DEFAULT_RATE = { mid: 30, low: 20 };       // ambient-* 預設
  const SLOW_RATE = { mid: 20, low: 10 };          // ambient-slow-* （緩慢飄移類）
  const AMBIENT_NAMES = new Set(Object.keys(RATES));
  const isAmbientName = name => Boolean(name) && (AMBIENT_NAMES.has(name) || name.indexOf('ambient-') === 0);
  function rateOf(anim) {
    if (anim._perfRate) return anim._perfRate;
    const name = anim.animationName || '';
    return RATES[name] || (name.indexOf('ambient-slow-') === 0 ? SLOW_RATE : DEFAULT_RATE);
  }

  const root = document.documentElement;
  const tracked = new Set();
  const globalHolds = new Set();
  const targets = new Map();
  const listeners = [];
  let current = '';
  let refractSupported = null;
  let io = null;

  function readStore() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeStore(patch) {
    const next = Object.assign(readStore(), patch || {});
    try { localStorage.setItem(STORE_KEY, JSON.stringify(next)); } catch (e) {}
    return next;
  }

  // 只採用「明確偏弱」的硬體訊號；不確定時先給 high，由實測決定要不要降。
  function hintTier() {
    let mem = 0;
    let cores = 0;
    let saveData = false;
    try { mem = Number(navigator.deviceMemory) || 0; } catch (e) {}
    try { cores = Number(navigator.hardwareConcurrency) || 0; } catch (e) {}
    try { saveData = Boolean(navigator.connection && navigator.connection.saveData); } catch (e) {}
    if (saveData || (mem && mem <= 2) || (cores && cores <= 2)) return 'low';
    if (mem && mem <= 4) return 'mid';
    return 'high';
  }
  function preference() {
    try { const p = Prefs.get().perf; return TIERS[p] ? p : 'auto'; } catch (e) { return 'auto'; }
  }
  function autoTier() {
    const s = readStore();
    return TIERS[s.tier] ? s.tier : hintTier();
  }
  function resolveTier() {
    const p = preference();
    return p === 'auto' ? autoTier() : p;
  }
  function cfg() { return TIERS[current] || TIERS.high; }
  function holdApplies(reason) { return cfg().holds.indexOf(reason) !== -1; }

  /* ---------- 單一動畫的暫停/播放與更新頻率 ---------- */
  function shouldRun(anim) {
    if (anim._perfHolds && anim._perfHolds.size) return false;
    for (const r of globalHolds) { if (holdApplies(r)) return false; }
    return true;
  }
  function applyPlayState(anim) {
    if (!tracked.has(anim)) return;
    try {
      const run = shouldRun(anim);
      if (run) {
        if (anim._perfPaused && anim.playState === 'paused') anim.play();
        anim._perfPaused = false;
      } else if (anim.playState === 'running') {
        anim.pause();
        anim._perfPaused = true;
      }
    } catch (e) {}
  }
  function applyRate(anim) {
    if (!anim._perfRateOk) return;
    try {
      const effect = anim.effect;
      if (!effect || typeof effect.updateTiming !== 'function') return;
      const dur = Number(effect.getComputedTiming().duration) || 0;
      const fps = current === 'high' ? 0 : (rateOf(anim)[current] || 0);
      const easing = fps && dur > 0
        ? 'steps(' + Math.max(2, Math.round(dur / 1000 * fps)) + ', jump-end)'
        : 'linear';
      if (anim._perfEasing === easing || (!anim._perfEasing && easing === 'linear')) return;
      effect.updateTiming({ easing: easing });
      anim._perfEasing = easing;
    } catch (e) {}
  }

  function release(anim) {
    if (!tracked.delete(anim)) return;
    const el = anim._perfTarget;
    const set = el && targets.get(el);
    if (set) {
      set.delete(anim);
      if (!set.size) { targets.delete(el); if (io) io.unobserve(el); }
    }
  }
  function adopt(anim, options) {
    if (!anim || tracked.has(anim) || anim.playState === 'idle') return anim;
    if (options && options.rate) anim._perfRate = options.rate;
    tracked.add(anim);
    anim._perfHolds = anim._perfHolds || new Set();
    try {
      // CSS 動畫的緩動寫在 keyframe 上、整體 easing 是 linear，可安全套 steps() 取樣；
      // JS 動畫若整體 easing 不是 linear，就只做暫停、不動更新頻率，避免改掉原本曲線。
      const orig = anim.effect && anim.effect.getTiming ? anim.effect.getTiming().easing : 'linear';
      anim._perfRateOk = !orig || orig === 'linear';
    } catch (e) { anim._perfRateOk = false; }
    try { anim.addEventListener('cancel', () => release(anim)); } catch (e) {}
    const el = anim.effect && anim.effect.target;
    if (el && el.nodeType === 1) {
      anim._perfTarget = el;
      let set = targets.get(el);
      if (!set) { set = new Set(); targets.set(el, set); if (io) io.observe(el); }
      set.add(anim);
      if (el._perfOffscreen) anim._perfHolds.add('offscreen');
    }
    applyRate(anim);
    applyPlayState(anim);
    return anim;
  }
  function prune() {
    tracked.forEach(a => {
      const el = a._perfTarget;
      if (a.playState === 'idle' || (el && !el.isConnected)) release(a);
    });
  }

  /* ---------- 自動偵測新出現的氛圍動畫 ---------- */
  function scan(scope) {
    let list = [];
    try {
      list = scope && scope !== document && scope.getAnimations
        ? scope.getAnimations({ subtree: true })
        : (document.getAnimations ? document.getAnimations() : []);
    } catch (e) { return; }
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      if (isAmbientName(a.animationName)) adopt(a);
    }
  }
  const scanQueue = new Set();
  let scanRaf = 0;
  function flushScan() {
    scanRaf = 0;
    scanQueue.forEach(el => { if (el.isConnected) scan(el); });
    scanQueue.clear();
    prune();
  }

  /* ---------- 全域暫停條件 ---------- */
  function setHold(reason, on) {
    const had = globalHolds.has(reason);
    if (on === had) return;
    if (on) globalHolds.add(reason); else globalHolds.delete(reason);
    tracked.forEach(applyPlayState);
  }

  function bindHolds() {
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(entries => {
        for (let i = 0; i < entries.length; i++) {
          const en = entries[i];
          const off = !en.isIntersecting;
          en.target._perfOffscreen = off;
          const set = targets.get(en.target);
          if (!set) continue;
          set.forEach(a => {
            if (off) a._perfHolds.add('offscreen'); else a._perfHolds.delete('offscreen');
            applyPlayState(a);
          });
        }
      }, { rootMargin: '120px 0px' });
      targets.forEach((set, el) => io.observe(el));
    }

    document.addEventListener('visibilitychange', () => setHold('hidden', document.hidden));

    let scrollTimer = 0;
    window.addEventListener('scroll', () => {
      maybeProbeOnScroll();
      if (!holdApplies('scroll')) return;
      setHold('scroll', true);
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => setHold('scroll', false), 400);
    }, { passive: true });

    let interactTimer = 0;
    document.addEventListener('pointerdown', () => {
      if (!holdApplies('interact')) return;
      clearTimeout(interactTimer);
      setHold('interact', true);
    }, { passive: true, capture: true });
    const endInteract = () => {
      clearTimeout(interactTimer);
      interactTimer = setTimeout(() => setHold('interact', false), 450);
    };
    ['pointerup', 'pointercancel'].forEach(t => document.addEventListener(t, endInteract, { passive: true, capture: true }));

    if (typeof MutationObserver === 'function') {
      const modals = document.querySelectorAll('.modal-backdrop');
      const checkModal = () => {
        let open = false;
        for (let i = 0; i < modals.length; i++) { if (modals[i].classList.contains('show')) { open = true; break; } }
        setHold('modal', open);
      };
      const mo = new MutationObserver(checkModal);
      modals.forEach(m => mo.observe(m, { attributes: true, attributeFilter: ['class'] }));
      new MutationObserver(() => setHold('vt', Boolean(root.dataset.vt)))
        .observe(root, { attributes: true, attributeFilter: ['data-vt'] });
      if (document.body) {
        new MutationObserver(() => scheduleProbe(700))
          .observe(document.body, { attributes: true, attributeFilter: ['data-page'] });
      }
    }

    document.addEventListener('animationstart', e => {
      if (!isAmbientName(e.animationName) || !e.target || e.target.nodeType !== 1) return;
      scanQueue.add(e.target);
      if (!scanRaf) scanRaf = requestAnimationFrame(flushScan);
    }, true);
  }

  /* ---------- 執行期幀率量測與自動調整 ---------- */
  const session = { bad: 0, excellent: 0, probes: 0, downgraded: false, lastProbe: 0 };
  const MAX_PROBES = 24;
  let probing = false;
  let probeTimer = 0;

  function measure(ms) {
    if (probing || document.hidden || preference() !== 'auto' || session.probes >= MAX_PROBES) return;
    probing = true;
    session.probes++;
    session.lastProbe = performance.now();
    const intervals = [];
    let start = 0;
    let last = 0;
    const step = ts => {
      if (document.hidden) { probing = false; return; }
      if (!start) { start = ts; last = ts; requestAnimationFrame(step); return; }
      intervals.push(ts - last);
      last = ts;
      if (ts - start < ms) { requestAnimationFrame(step); return; }
      probing = false;
      evaluate(intervals, ts - start);
    };
    requestAnimationFrame(step);
  }
  function evaluate(intervals, span) {
    if (intervals.length < 15 || span <= 0) return;
    const sorted = intervals.slice().sort((a, b) => a - b);
    // 取第 20 百分位當作螢幕刷新間隔（60Hz ≈ 16.7ms、120Hz ≈ 8.3ms）
    const refresh = Math.min(17.5, Math.max(6.5, sorted[Math.floor(sorted.length * 0.2)]));
    const ratio = intervals.length / (span / refresh);
    let longCount = 0;
    for (let i = 0; i < intervals.length; i++) { if (intervals[i] > refresh * 2.5) longCount++; }
    const longRatio = longCount / intervals.length;
    const bad = ratio < 0.72 || longRatio > 0.12;
    const excellent = ratio > 0.93 && longRatio < 0.02;
    if (bad) session.bad++; else if (excellent) session.excellent++;
    if (session.bad >= 2) stepDown();
  }
  function stepDown() {
    const idx = ORDER.indexOf(current);
    session.bad = 0;
    session.excellent = 0;
    if (idx <= 0 || preference() !== 'auto') return;
    const next = ORDER[idx - 1];
    const store = readStore();
    const patch = { tier: next, goodSessions: 0, at: Date.now() };
    // 剛升級就又卡頓 → 一週內不再自動升級，避免來回切換
    if (store.upgradedAt && Date.now() - store.upgradedAt < 86400000) patch.noUpgradeUntil = Date.now() + 7 * 86400000;
    writeStore(patch);
    session.downgraded = true;
    apply(next, 'auto-down');
  }
  function onSessionEnd() {
    if (preference() !== 'auto' || session.downgraded) return;
    const idx = ORDER.indexOf(current);
    if (idx < 0 || idx >= ORDER.length - 1) return;
    const store = readStore();
    if (store.noUpgradeUntil && Date.now() < store.noUpgradeUntil) return;
    if (session.excellent >= 3 && session.bad === 0) {
      const good = (store.goodSessions || 0) + 1;
      if (good >= 2) writeStore({ tier: ORDER[idx + 1], goodSessions: 0, upgradedAt: Date.now() });
      else writeStore({ goodSessions: good });
    } else if (session.bad > 0) {
      writeStore({ goodSessions: 0 });
    }
  }
  function scheduleProbe(delay) {
    if (preference() !== 'auto') return;
    clearTimeout(probeTimer);
    probeTimer = setTimeout(() => measure(2500), delay || 0);
  }
  function maybeProbeOnScroll() {
    if (probing || preference() !== 'auto') return;
    if (performance.now() - session.lastProbe < 15000) return;
    measure(2000);
  }

  /* ---------- 套用等級 ---------- */
  function apply(tier, reason) {
    if (!TIERS[tier]) tier = 'high';
    const changed = tier !== current;
    current = tier;
    root.setAttribute('data-perf', tier);
    if (refractSupported !== null) root.classList.toggle('lg-can-refract', refractSupported && cfg().refract);
    tracked.forEach(a => { applyRate(a); applyPlayState(a); });
    if (!changed) return;
    listeners.forEach(fn => { try { fn(tier, reason); } catch (e) {} });
    try { document.dispatchEvent(new CustomEvent('perfchange', { detail: { tier: tier, reason: reason || '' } })); } catch (e) {}
  }
  function sync() { apply(resolveTier(), 'pref'); }

  function setRefractSupport(ok) {
    refractSupported = Boolean(ok);
    root.classList.toggle('lg-can-refract', refractSupported && cfg().refract);
  }

  function init() {
    bindHolds();
    scan(document);
    setHold('hidden', document.hidden);
    window.addEventListener('pagehide', onSessionEnd);
    const boot = () => { scheduleProbe(2500); setTimeout(() => measure(2500), 9000); };
    if (document.readyState === 'complete') boot();
    else window.addEventListener('load', boot, { once: true });
  }

  apply(resolveTier(), 'boot');
  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });

  return {
    tier: () => current,
    label: t => LABELS[t || current] || '',
    preference: preference,
    autoTier: autoTier,
    sync: sync,
    adopt: adopt,
    setHold: setHold,
    setRefractSupport: setRefractSupport,
    registerAmbient: (name, rate) => { if (!name) return; AMBIENT_NAMES.add(String(name)); if (rate) RATES[name] = rate; scan(document); },
    onChange: fn => { if (typeof fn === 'function') listeners.push(fn); },
    probe: () => measure(2500),
    debug: () => ({ tier: current, preference: preference(), tracked: tracked.size, holds: Array.from(globalHolds), session: Object.assign({}, session), store: readStore() })
  };
})();
