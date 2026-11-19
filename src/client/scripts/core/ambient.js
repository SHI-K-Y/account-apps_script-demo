/* =============================================================================
 * Ambient — 常駐（無限循環）動畫的暫停／繼續
 * -----------------------------------------------------------------------------
 * 所有裝置一律看到完整、高畫質的動畫：不分級、不降幀、不在捲動或開彈窗時停住。
 * 這支程式只做兩件「肉眼看不到」的事：
 *   1. 分頁切到背景（visibilitychange）時暫停所有常駐動畫，回到前景時從原本的位置繼續。
 *   2. 元素捲出畫面（IntersectionObserver，上下各預留 120px）時暫停它身上的常駐動畫，
 *      進入預留範圍（還沒真的出現在畫面上）時就先繼續播放。
 *
 * 新增動畫的規則（P01–P03 確立）：
 *   1. 無限循環的動畫只能動 transform（translate／scale／rotate）與 opacity。
 *      filter、background-position、background-size、box-shadow、漸層角度、寬高、top／left 一律不行；
 *      要做流光、旋轉光環這類效果，就加一個子元素去轉它（見 core/uv-fx.js 與 20-uiverse-effects.css）。
 *      tools/test/motion-lint.test.mjs 會檢查所有 CSS 的 @keyframes，違規就讓 npm test 失敗。
 *   2. CSS 的無限循環裝飾動畫：@keyframes 名稱用「ambient-」開頭（例：ambient-sparkle），
 *      或把名稱加進下方的 NAMES；出現在頁面上時就會自動被這支程式管理，不用寫任何 JS。
 *   3. 用 JS 建立的無限循環動畫：
 *        const a = el.animate(frames, { duration: 4000, iterations: Infinity });
 *        Ambient.register(a);
 *      register 之後就套用上面兩條暫停規則；動畫 cancel() 或元素移出 DOM 時會自動放掉。
 *      （motion-lint 只看 CSS，JS 動畫的 keyframes 同樣只能動 transform／opacity，請自行遵守。）
 *   4. 一次性的動畫（點擊回饋、進場、彈窗）照常用 Motion.animate()，不用登記。
 *   5. 「動畫效果」偏好（完整／精簡／關閉）與系統的「減少動態效果」由 core/motion.js 處理，和這裡無關。
 * ============================================================================= */
const Ambient = (function() {
  // 目前專案中的無限循環裝飾動畫（載入中的轉圈圈不算）。
  //   整頁背景光暈由 core/background.js 繪製、自己處理暫停，不在這裡。
  //   分頁星點／光暈、送出鈕外框、卡片光環都只動 transform（P02，見 core/uv-fx.js）。
  const NAMES = new Set([
    'uv-tab-stars-ltr',
    'uv-tab-stars-rtl',
    'uv-tab-glow',
    'uv-btn-ring',
    'uv-btn-stars',
    'uv-btn-pulse',
    'uv-card-spin'
  ]);
  const isAmbientName = name => Boolean(name) && (NAMES.has(name) || String(name).indexOf('ambient-') === 0);

  const tracked = new Set();
  const targets = new Map();       // 元素 → 身上被管理的動畫
  const offscreen = new WeakSet(); // 目前在預留範圍外的元素
  let hidden = false;
  let io = null;

  function shouldRun(anim) {
    if (hidden) return false;
    const el = anim._ambTarget;
    return !(el && offscreen.has(el));
  }
  function applyPlayState(anim) {
    if (!tracked.has(anim)) return;
    try {
      if (shouldRun(anim)) {
        // 只恢復「我們自己暫停的」動畫；其他程式主動 pause() 的不要動
        if (anim._ambPaused && anim.playState === 'paused') anim.play();
        anim._ambPaused = false;
      } else if (anim.playState === 'running') {
        anim.pause();
        anim._ambPaused = true;
      }
    } catch (e) {}
  }

  function release(anim) {
    if (!tracked.delete(anim)) return;
    const el = anim._ambTarget;
    const set = el && targets.get(el);
    if (set) {
      set.delete(anim);
      if (!set.size) { targets.delete(el); if (io) io.unobserve(el); }
    }
  }
  function register(anim) {
    if (!anim || tracked.has(anim) || anim.playState === 'idle') return anim;
    tracked.add(anim);
    try { anim.addEventListener('cancel', () => release(anim)); } catch (e) {}
    const el = anim.effect && anim.effect.target;
    if (el && el.nodeType === 1) {
      anim._ambTarget = el;
      let set = targets.get(el);
      if (!set) { set = new Set(); targets.set(el, set); if (io) io.observe(el); }
      set.add(anim);
    }
    applyPlayState(anim);
    return anim;
  }
  function prune() {
    tracked.forEach(a => {
      const el = a._ambTarget;
      if (a.playState === 'idle' || (el && !el.isConnected)) release(a);
    });
  }

  /* ---------- 自動接手新出現的 CSS 常駐動畫 ---------- */
  function scan(scope) {
    let list = [];
    try {
      list = scope && scope !== document && scope.getAnimations
        ? scope.getAnimations({ subtree: true })
        : (document.getAnimations ? document.getAnimations() : []);
    } catch (e) { return; }
    for (let i = 0; i < list.length; i++) {
      if (isAmbientName(list[i].animationName)) register(list[i]);
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

  function setHidden(on) {
    on = Boolean(on);
    if (on === hidden) return;
    hidden = on;
    tracked.forEach(applyPlayState);
  }

  function init() {
    if (typeof IntersectionObserver === 'function') {
      io = new IntersectionObserver(entries => {
        for (let i = 0; i < entries.length; i++) {
          const en = entries[i];
          if (en.isIntersecting) offscreen.delete(en.target); else offscreen.add(en.target);
          const set = targets.get(en.target);
          if (set) set.forEach(applyPlayState);
        }
      }, { rootMargin: '120px 0px' });
      targets.forEach((set, el) => io.observe(el));
    }
    document.addEventListener('visibilitychange', () => setHidden(document.hidden));
    document.addEventListener('animationstart', e => {
      if (!isAmbientName(e.animationName) || !e.target || e.target.nodeType !== 1) return;
      scanQueue.add(e.target);
      if (!scanRaf) scanRaf = requestAnimationFrame(flushScan);
    }, true);
    scan(document);
    setHidden(document.hidden);
  }

  if (document.body) init();
  else document.addEventListener('DOMContentLoaded', init, { once: true });

  return {
    register: register,
    // 登記一個 CSS @keyframes 名稱（不用 ambient- 開頭時），立即接手畫面上已經在跑的同名動畫
    registerName: name => { if (!name) return; NAMES.add(String(name)); scan(document); },
    debug: () => ({ tracked: tracked.size, hidden: hidden })
  };
})();
