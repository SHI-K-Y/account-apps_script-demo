/* =============================================================================
 * BgGlow — 整頁背景的漂移光暈與呼吸亮度
 * -----------------------------------------------------------------------------
 * 取代原本的兩個 CSS 動畫（每一幀都要重繪、重新光柵化整個視窗，上方毛玻璃也要跟著重算）：
 *   uv-glow-breathe  整個 .uv-glow-bg 動 filter: brightness()，6s ease-in-out infinite alternate
 *   uv-glow-drift    ::before 疊 4 層 radial-gradient，動 background-position，40s linear infinite
 * 現在：
 *   - 底層漸層的呼吸：CSS 兩層漸層（× 最小亮度、× 最大亮度）＋ opacity 交叉淡入淡出（uv-bg-breathe-fade），
 *     完全由合成器執行（見 02-background-header.css）。
 *   - 4 層漂移光暈：畫在 .uv-glow-canvas（約視窗的 1/6，CSS 拉伸滿版）。優先用 OffscreenCanvas＋Web Worker
 *     在背景執行緒以 requestAnimationFrame 繪製，主執行緒完全不參與；不支援或啟動失敗時退回主執行緒繪製。
 *   - 每幀把光暈顏色乘上和 CSS 同步的亮度係數：時間原點取自 uv-bg-breathe-fade 這個 CSS 動畫的 startTime
 *     （document.timeline），兩邊用同一個緩動曲線與週期，漂移也從同一個原點起算（原本兩個動畫同時開始）。
 * 位置公式與原本 CSS 完全相同：
 *   background-size 200% → 圖塊 = 2 倍容器；background-position p → 位移 = (容器 − 圖塊) × p = −容器 × p，
 *   p 由起點線性變到 0；圖塊以 2 倍容器為週期平鋪，每個圖塊各自裁切（和 CSS 一樣）。
 *   前 3 層 circle farthest-corner（半徑 = 圖塊半對角線），第 4 層 ellipse farthest-corner
 *   （半徑 = 圖塊半寬、半高各乘 √2），色標都在 60%，疊放順序第一層在最上面。
 * 開機完成（<html> 加上 boot-ready）才開始繪製，開機期間由載入畫面蓋住（P08）。
 * 主題切換、視窗尺寸變更時重新讀取 CSS 變數並重設 canvas；頁面在背景時停止繪製；
 * 減少動態效果或動畫效果關閉時只畫一張靜態畫面（亮度 1、位置 0%，和原本動畫被移除時一樣）。
 * 偵錯：window.__bgDebug.setTime(ms) 定格在第 ms 毫秒（null 恢復播放）、.mode()、.state()、.restart('main'|'worker')。
 * ============================================================================= */

/** 繪製核心：完全自給自足（不引用外部變數），會被 toString() 後放進 Worker 執行，主執行緒退回時也用同一份。 */
function bgGlowCore() {
  'use strict';
  var BREATHE_MS = 6000;           // uv-bg-breathe-fade：6s ease-in-out infinite alternate
  var DRIFT_MS = 40000;            // 原 uv-glow-drift：40s linear infinite
  var STOP = 0.6;                  // radial-gradient(…, color, transparent 60%)
  var SCALE = 6;                   // canvas 解析度 = 視窗 ÷ 6（光暈是極柔和的漸層，放大後看不出差異）
  // 起點 background-position（800% → 8），終點都是 0% 0%；順序同 CSS background-image（第一層在最上面）
  var LAYERS = [
    { from: [8, 4], ellipse: false },
    { from: [10, -4], ellipse: false },
    { from: [-12, -6], ellipse: false },
    { from: [-6, 8], ellipse: true }
  ];

  /** cubic-bezier 求值（與瀏覽器相同的作法：牛頓法，失敗再二分）。 */
  function bezier(x1, y1, x2, y2) {
    var cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    var cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    function sx(t) { return ((ax * t + bx) * t + cx) * t; }
    function sy(t) { return ((ay * t + by) * t + cy) * t; }
    function dx(t) { return (3 * ax * t + 2 * bx) * t + cx; }
    return function (x) {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      var t = x;
      for (var i = 0; i < 8; i++) {
        var err = sx(t) - x;
        if (Math.abs(err) < 1e-7) return sy(t);
        var d = dx(t);
        if (Math.abs(d) < 1e-6) break;
        t -= err / d;
      }
      var lo = 0, hi = 1;
      t = x;
      for (var j = 0; j < 40; j++) {
        var v = sx(t);
        if (Math.abs(v - x) < 1e-7) break;
        if (v < x) lo = t; else hi = t;
        t = (lo + hi) / 2;
      }
      return sy(t);
    };
  }
  var easeInOut = bezier(0.42, 0, 0.58, 1);

  /** 呼吸進度 0～1（= CSS opacity），t 是動畫開始後的毫秒數；alternate：奇數圈反向，緩動套在反向之後。 */
  function breathe(t) {
    if (!(t > 0)) return 0;
    var i = Math.floor(t / BREATHE_MS);
    var p = (t - i * BREATHE_MS) / BREATHE_MS;
    if (i % 2) p = 1 - p;
    return easeInOut(p);
  }
  function mod(a, n) { var r = a % n; return r < 0 ? r + n : r; }
  /** 某一層在時間 t 的 background-position 百分比（t == null 表示靜態畫面：0% 0%）。 */
  function position(layer, t) {
    if (t == null) return [0, 0];
    var left = 1 - mod(Math.max(0, t), DRIFT_MS) / DRIFT_MS;
    return [layer.from[0] * left, layer.from[1] * left];
  }
  /** 容器 W×H 內需要畫的圖塊左上角（圖塊 2W×2H，以 2W、2H 為週期平鋪）。 */
  function tiles(layer, t, W, H) {
    var p = position(layer, t);
    var ox = mod(-W * p[0], 2 * W);
    var oy = mod(-H * p[1], 2 * H);
    var out = [];
    [ox - 2 * W, ox].forEach(function (x) {
      if (x >= W || x + 2 * W <= 0) return;
      [oy - 2 * H, oy].forEach(function (y) {
        if (y >= H || y + 2 * H <= 0) return;
        out.push([x, y]);
      });
    });
    return out;
  }

  function createPainter(canvas) {
    var ctx = null;
    try { ctx = canvas.getContext('2d'); } catch (e) {}
    if (!ctx) return null;
    var W = 0, H = 0, cw = 0, ch = 0, scene = null;
    function rgba(c, k, a) {
      return 'rgba(' + Math.min(255, c[0] * k) + ',' + Math.min(255, c[1] * k) + ',' + Math.min(255, c[2] * k) + ',' + a + ')';
    }
    function paintTile(layer, x, y, solid, clear) {
      // 只填和視窗重疊的部分；fillRect 本身就把漸層裁在圖塊內，和 CSS 每個圖塊各自裁切一樣
      var x0 = Math.max(x, 0), x1 = Math.min(x + 2 * W, W);
      var y0 = Math.max(y, 0), y1 = Math.min(y + 2 * H, H);
      if (x1 <= x0 || y1 <= y0) return;
      var cx = x + W, cy = y + H, g;
      if (!layer.ellipse) {
        ctx.setTransform(cw / W, 0, 0, ch / H, 0, 0);
        g = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.sqrt(W * W + H * H));
        g.addColorStop(0, solid);
        g.addColorStop(STOP, clear);
        ctx.fillStyle = g;
        ctx.fillRect(x0, y0, x1 - x0, y1 - y0);
      } else {
        var rx = W * Math.SQRT2, ry = H * Math.SQRT2, s = rx / ry;
        ctx.setTransform(cw / W * s, 0, 0, ch / H, cx * cw / W, cy * ch / H);
        g = ctx.createRadialGradient(0, 0, 0, 0, 0, ry);
        g.addColorStop(0, solid);
        g.addColorStop(STOP, clear);
        ctx.fillStyle = g;
        ctx.fillRect((x0 - cx) / s, y0 - cy, (x1 - x0) / s, y1 - y0);
      }
    }
    return {
      resize: function (w, h) {
        W = Math.max(1, w);
        H = Math.max(1, h);
        cw = Math.max(1, Math.ceil(W / SCALE));
        ch = Math.max(1, Math.ceil(H / SCALE));
        if (canvas.width !== cw) canvas.width = cw;
        if (canvas.height !== ch) canvas.height = ch;
      },
      setScene: function (s) { scene = s; },
      ready: function () { return Boolean(scene && cw); },
      /** t：動畫開始後的毫秒數；null 表示靜態畫面。 */
      draw: function (t) {
        if (!scene || !cw) return;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(0, 0, cw, ch);
        var k = t == null ? scene.kStatic : scene.kLo + breathe(t) * (scene.kHi - scene.kLo);
        for (var i = LAYERS.length - 1; i >= 0; i--) {
          var c = scene.colors[i];
          if (!c || !(c[3] > 0)) continue;
          // 漸層終點用「同色透明」：canvas 與 CSS 在透明插值上的作法不同，#0000 會在 canvas 產生灰邊
          var solid = rgba(c, k, c[3]), clear = rgba(c, k, 0);
          var list = tiles(LAYERS[i], t, W, H);
          for (var j = 0; j < list.length; j++) paintTile(LAYERS[i], list[j][0], list[j][1], solid, clear);
        }
      }
    };
  }

  /**
   * 播放控制（Worker 與主執行緒共用）。update() 接受部分狀態：
   *   size: [W, H]（CSS px）、scene: { colors, kLo, kHi, kStatic }、
   *   clock: { origin（epoch 毫秒，CSS 動畫的開始時間）| frozen（定格毫秒）| staticMode }、visible
   */
  function createLoop(painter, raf, onFirstFrame) {
    var clock = null, visible = true, scheduled = false, drew = false, stopped = false;
    function epoch(ts) {
      var now = performance.now();
      if (typeof ts !== 'number' || Math.abs(ts - now) > 1000) ts = now;
      return performance.timeOrigin + ts;
    }
    function timeAt(ep) {
      if (!clock || clock.staticMode) return null;
      if (clock.frozen != null) return clock.frozen;
      return ep - clock.origin;
    }
    function render(ts) {
      if (!clock || !painter.ready()) return;
      painter.draw(timeAt(epoch(ts)));
      if (!drew) { drew = true; if (onFirstFrame) onFirstFrame(); }
    }
    function running() {
      return Boolean(!stopped && clock && !clock.staticMode && clock.frozen == null && visible && painter.ready());
    }
    function frame(ts) {
      scheduled = false;
      if (!running()) return;
      render(ts);
      schedule();
    }
    function schedule() {
      if (scheduled || !running()) return;
      scheduled = true;
      raf(frame);
    }
    return {
      update: function (patch) {
        if (!patch || stopped) return;
        if (patch.size) painter.resize(patch.size[0], patch.size[1]);
        if (patch.scene) painter.setScene(patch.scene);
        if (patch.clock) clock = patch.clock;
        if (typeof patch.visible === 'boolean') visible = patch.visible;
        // 立即畫一次：改尺寸會清空 canvas，等到下一幀才畫會閃一下空白；靜態／定格／背景中也靠這一次
        if (visible || !drew) render();
        schedule();
      },
      running: running,
      stop: function () { stopped = true; }
    };
  }

  return {
    BREATHE_MS: BREATHE_MS, DRIFT_MS: DRIFT_MS, STOP: STOP, SCALE: SCALE, LAYERS: LAYERS,
    bezier: bezier, easeInOut: easeInOut, breathe: breathe, position: position, tiles: tiles,
    createPainter: createPainter, createLoop: createLoop
  };
}

/** Worker 進入點（同樣會被 toString()）。 */
function bgGlowWorker(core) {
  var loop = null;
  self.onmessage = function (e) {
    var d = e.data || {};
    if (d.canvas) {
      var painter = typeof self.requestAnimationFrame === 'function' ? core.createPainter(d.canvas) : null;
      if (!painter) {
        self.postMessage({ type: 'unsupported', reason: typeof self.requestAnimationFrame === 'function' ? 'no-2d' : 'no-raf' });
        return;
      }
      loop = core.createLoop(painter, function (cb) { return self.requestAnimationFrame(cb); }, function () {
        self.postMessage({ type: 'frame' });
      });
    }
    if (loop) loop.update(d);
  };
}

const BgGlow = (function () {
  const core = bgGlowCore();
  if (typeof document === 'undefined' || typeof window === 'undefined') return { core: core };

  const ANIM_NAME = 'uv-bg-breathe-fade';
  const WATCHDOG_MS = 5000;
  const root = document.documentElement;
  const bg = document.querySelector('.uv-glow-bg');
  if (!bg) return { core: core };

  let reduceMql = null;
  try { reduceMql = window.matchMedia('(prefers-reduced-motion: reduce)'); } catch (e) {}

  let canvas = bg.querySelector('canvas.uv-glow-canvas');
  let mode = 'none';          // 'pending'（Worker 啟動中）| 'worker' | 'main'
  let worker = null;
  let workerUrl = '';
  let watchdog = 0;
  let loop = null;            // 主執行緒模式的播放控制
  let debugFrozen = null;
  let reason = '';
  const state = { size: null, scene: null, clock: null, visible: !document.hidden };

  /* ---------- 讀取 CSS ---------- */
  let probe = null;
  let conv = null;
  function toRGBA(str) {
    if (!conv) {
      const c = document.createElement('canvas');
      c.width = c.height = 1;
      conv = c.getContext('2d', { willReadFrequently: true });
    }
    if (!conv) return [0, 0, 0, 0];
    conv.clearRect(0, 0, 1, 1);
    conv.fillStyle = '#0000';
    conv.fillStyle = str;
    conv.fillRect(0, 0, 1, 1);
    const d = conv.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  function readScene() {
    const cs = getComputedStyle(root);
    const num = (name, fallback) => {
      const v = parseFloat(cs.getPropertyValue(name));
      return Number.isFinite(v) ? v : fallback;
    };
    const min = num('--uv-bg-breathe-min', 1);
    const max = num('--uv-bg-breathe-max', 1);
    const gain = num('--uv-bg-gain', 1) || 1;
    if (!probe) {
      probe = document.createElement('i');
      probe.style.cssText = 'display:none;color:var(--uv-gold-1);background-color:var(--uv-gold-2);' +
        'border-top-color:var(--uv-gold-3);border-bottom-color:var(--uv-gold-4)';
      bg.appendChild(probe);
    }
    const ps = getComputedStyle(probe);
    const colors = [ps.color, ps.backgroundColor, ps.borderTopColor, ps.borderBottomColor].map(toRGBA);
    return { colors: colors, kLo: min / gain, kHi: max / gain, kStatic: 1 / gain };
  }
  function readSize() {
    const r = bg.getBoundingClientRect();
    return [r.width || window.innerWidth || 1, r.height || window.innerHeight || 1];
  }

  /* ---------- 時間：跟著 CSS 的 uv-bg-breathe-fade ---------- */
  function findAnim() {
    try {
      const list = bg.getAnimations ? bg.getAnimations({ subtree: true }) : document.getAnimations();
      for (let i = 0; i < list.length; i++) if (list[i].animationName === ANIM_NAME) return list[i];
    } catch (e) {}
    return null;
  }
  function staticMotion() {
    return Boolean(reduceMql && reduceMql.matches) || root.getAttribute('data-motion') === 'off';
  }
  let readyWait = null;
  function readClock() {
    if (staticMotion()) return { staticMode: true };
    if (debugFrozen != null) return { frozen: debugFrozen };
    const a = findAnim();
    if (!a) {
      // 不支援 getAnimations 的舊瀏覽器：CSS 動畫大約在頁面開始時起跑，以導覽開始為原點
      return typeof root.getAnimations === 'function' ? { staticMode: true } : { origin: performance.timeOrigin };
    }
    if (a.playState === 'paused') return { frozen: Number(a.currentTime) || 0 };
    if (a.startTime == null) {
      if (readyWait !== a) {
        readyWait = a;
        a.ready.then(() => { readyWait = null; syncClock(); }, () => { readyWait = null; });
      }
      return { origin: performance.timeOrigin + performance.now() - (Number(a.currentTime) || 0) };
    }
    return { origin: performance.timeOrigin + a.startTime };
  }

  /* ---------- 傳送狀態到 Worker 或主執行緒 ---------- */
  function send(patch) {
    Object.assign(state, patch);
    if (worker) worker.postMessage(patch);
    else if (loop) loop.update(patch);
  }
  function syncClock() { send({ clock: readClock() }); }
  function syncScene() { send({ scene: readScene(), clock: readClock() }); }

  /* ---------- 啟動：Worker 優先，失敗就退回主執行緒 ---------- */
  function freshCanvas() {
    const c = document.createElement('canvas');
    c.className = 'uv-glow-canvas';
    c.width = c.height = 1;
    if (canvas && canvas.parentNode) canvas.parentNode.replaceChild(c, canvas);
    else bg.insertBefore(c, bg.firstChild);
    canvas = c;
    return c;
  }
  function stopWorker() {
    clearTimeout(watchdog);
    if (worker) { try { worker.terminate(); } catch (e) {} }
    worker = null;
    if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (e) {} }
    workerUrl = '';
  }
  function report() {
    const text = mode === 'worker' ? 'Worker（OffscreenCanvas，主執行緒不參與繪製）' : '主執行緒 requestAnimationFrame' + (reason ? '（' + reason + '）' : '');
    try { console.info('[背景光暈] 模式：' + text); } catch (e) {}
  }
  function startMain(why) {
    stopWorker();
    reason = why || '';
    const painter = core.createPainter(canvas);
    mode = 'main';
    if (!painter) { loop = null; reason = '不支援 canvas 2D'; report(); return; }
    loop = core.createLoop(painter, cb => requestAnimationFrame(cb), null);
    loop.update(state);
    report();
  }
  function fallback(why) {
    if (mode !== 'pending' && mode !== 'worker') return;
    stopWorker();
    freshCanvas();    // 已經 transferControlToOffscreen 的 canvas 不能再拿回來畫
    startMain(why);
  }
  function startWorker() {
    let off = null;
    try {
      const src = '"use strict";(' + bgGlowWorker.toString() + ')((' + bgGlowCore.toString() + ')());';
      workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(workerUrl);
    } catch (e) {
      stopWorker();
      startMain('無法建立 Worker');
      return;
    }
    mode = 'pending';
    worker.onerror = e => { if (e && e.preventDefault) e.preventDefault(); fallback('Worker 執行失敗'); };
    worker.onmessage = e => {
      const d = e.data || {};
      if (d.type === 'frame' && mode === 'pending') {
        clearTimeout(watchdog);
        mode = 'worker';
        if (workerUrl) { try { URL.revokeObjectURL(workerUrl); } catch (err) {} workerUrl = ''; }
        report();
      } else if (d.type === 'unsupported') {
        fallback(d.reason === 'no-raf' ? 'Worker 沒有 requestAnimationFrame' : 'Worker 不支援 canvas 2D');
      }
    };
    try {
      off = canvas.transferControlToOffscreen();
      worker.postMessage(Object.assign({ canvas: off }, state), [off]);
    } catch (e) {
      if (off) fallback('無法把 canvas 交給 Worker');
      else { stopWorker(); startMain('無法把 canvas 交給 Worker'); }
      return;
    }
    watchdog = setTimeout(() => fallback('Worker 沒有回應'), WATCHDOG_MS);
  }
  function start(prefer) {
    if (mode !== 'none') { stopWorker(); if (loop) loop.stop(); loop = null; freshCanvas(); }
    if (!canvas) freshCanvas();
    state.size = readSize();
    state.scene = readScene();
    state.clock = readClock();
    state.visible = !document.hidden;
    const canUseWorker = prefer !== 'main' && typeof Worker === 'function' && typeof OffscreenCanvas === 'function' &&
      typeof canvas.transferControlToOffscreen === 'function' && typeof URL !== 'undefined' && typeof Blob === 'function';
    if (canUseWorker) startWorker();
    else startMain(prefer === 'main' ? '手動指定' : '不支援 OffscreenCanvas');
  }

  /* ---------- 事件 ---------- */
  function bind() {
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(entries => {
        const r = entries[entries.length - 1].contentRect;
        if (!r.width || !r.height) return;
        if (state.size && state.size[0] === r.width && state.size[1] === r.height) return;
        send({ size: [r.width, r.height] });
      }).observe(bg);
    } else {
      window.addEventListener('resize', () => send({ size: readSize() }), { passive: true });
    }
    document.addEventListener('visibilitychange', () => {
      send({ visible: !document.hidden, clock: readClock() });
    });
    if (typeof MutationObserver === 'function') {
      new MutationObserver(syncScene).observe(root, { attributes: true, attributeFilter: ['data-theme', 'data-motion'] });
    }
    if (reduceMql) {
      if (reduceMql.addEventListener) reduceMql.addEventListener('change', syncClock);
      else if (reduceMql.addListener) reduceMql.addListener(syncClock);
    }
  }

  // 開機期間載入畫面整個蓋住背景：等 boot-ready（載入畫面開始淡出）才建立 Worker、讀樣式、量尺寸（P08），
  // 不在解析階段強制計算樣式與版面，也不和首屏搶主執行緒
  BootPhase.ready(() => {
    start();
    bind();
  });

  const api = {
    core: core,
    mode: () => mode,
    /** 定格在動畫開始後第 ms 毫秒（CSS 的呼吸動畫也一起定格）；傳 null 恢復播放。 */
    setTime: ms => {
      const a = findAnim();
      if (ms == null) {
        debugFrozen = null;
        if (a && a.playState === 'paused') a.play();
      } else {
        debugFrozen = Math.max(0, Number(ms) || 0);
        if (a) { a.pause(); a.currentTime = debugFrozen; }
      }
      syncClock();
    },
    /** 重新讀取 CSS 動畫的狀態（例如外部直接暫停了所有動畫之後）。 */
    sync: syncScene,
    restart: prefer => start(prefer === 'main' ? 'main' : 'worker'),
    state: () => ({ mode: mode, reason: reason, size: state.size, scene: state.scene, clock: state.clock, visible: state.visible })
  };
  try { window.__bgDebug = api; } catch (e) {}
  return api;
})();
