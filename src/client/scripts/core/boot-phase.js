/* =============================================================================
 * BootPhase — 開機分段（P08）：先畫出可以記帳的畫面，其他工作往後排
 * -----------------------------------------------------------------------------
 * 開機流程在 app/bootstrap.js（AppBoot），這裡只提供各模組共用的排程工具；排在 manifest 的第一個，
 * 所有開機模組在頂層就能登記「之後再做」的工作，不用擠在解析階段：
 *
 *   BootPhase.later(fn)   第二段：首屏已經畫好、載入畫面移除之後（例：鍵盤記帳、分段控制、返回頂端鈕）
 *   BootPhase.idle(fn)    第三段：瀏覽器閒置時（requestIdleCallback，最晚 IDLE_TIMEOUT_MS）
 *   BootPhase.ready(fn)   <html> 加上 boot-ready 之後：等那一幀畫出來再一件一件做（各自一個任務），不擠進移除載入畫面的那個任務；
 *                         載入畫面在 boot-ready 後 180ms 才開始淡出，常駐動畫、背景光暈從這時開始播放，看起來沒有延遲
 *   BootPhase.yield()     讓出主執行緒：scheduler.yield()（排在同優先權工作的前面），
 *                         不支援時用 MessageChannel（不受 setTimeout 最短 4ms 的限制），再不行才用 setTimeout 0
 *   BootPhase.nextFrame() 等下一幀畫完（rAF 之後再讓出一次）：首屏先畫出來，樣式與排版在那一幀算，
 *                         不會被下一段的程式強制提早計算、擠成一個長任務
 *
 * 已經過了那一段才登記的工作會立刻執行（例如延後程式在第三段才執行，頂層呼叫 later() 就是馬上做）。
 * 每件工作各自 try/catch：一件出錯不影響後面的工作，錯誤照樣丟到 window 的 error 事件（載入畫面會顯示錯誤）。
 * ============================================================================= */
const BootPhase = (function() {
  const IDLE_TIMEOUT_MS = 1500;
  const IDLE_SLICE_MS = 4;           // 這次閒置時間剩下不到 4ms 就留到下一次閒置
  const queues = { later: [], idle: [] };
  const passed = { later: false, idle: false };

  function report(err) {
    try {
      if (typeof window.reportError === 'function') { window.reportError(err); return; }
    } catch (e) {}
    setTimeout(() => { throw err; }, 0);
  }
  function run(fn) {
    try { fn(); } catch (e) { report(e); }
  }

  let channel = null;
  const pending = [];
  function yieldToMain() {
    if (window.scheduler && typeof window.scheduler.yield === 'function') {
      try { return window.scheduler.yield(); } catch (e) {}
    }
    return new Promise(resolve => {
      if (typeof MessageChannel === 'function') {
        if (!channel) {
          channel = new MessageChannel();
          channel.port1.onmessage = () => { const next = pending.shift(); if (next) next(); };
        }
        pending.push(resolve);
        channel.port2.postMessage(0);
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  // 分頁在背景時不會有下一幀（rAF 停住）：直接讓出一次，開機照常進行；保險起見最多等 100ms
  function nextFrame() {
    if (document.visibilityState === 'hidden') return yieldToMain();
    return new Promise(resolve => {
      let settled = false;
      const go = () => { if (settled) return; settled = true; clearTimeout(timer); yieldToMain().then(resolve); };
      const timer = setTimeout(go, 100);
      requestAnimationFrame(go);
    });
  }

  function onIdle(cb) {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(cb, { timeout: IDLE_TIMEOUT_MS });
    } else {
      // Safari：沒有 requestIdleCallback，等一個繪製之後再做（與 DeferredApp 原本的後備相同）
      setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 0 }), 200);
    }
  }

  function isReady() {
    return document.documentElement.classList.contains('boot-ready');
  }

  // boot-ready 之後的工作：0＝還沒 boot-ready、1＝等第一幀畫完、2＝已經做完（之後登記的立刻執行）
  const readyQueue = [];
  let readyStage = 0;
  async function drainReady() {
    while (readyQueue.length) {
      run(readyQueue.shift());
      if (readyQueue.length) await yieldToMain();
    }
    readyStage = 2;
  }
  window.addEventListener('bootready', () => {
    if (readyStage) return;
    readyStage = 1;
    requestAnimationFrame(() => setTimeout(drainReady, 0));
  }, { once: true });

  /** 第二段：依序執行，每件工作之間讓出主執行緒（使用者的點擊可以插隊）。回傳全部做完的 Promise。 */
  async function flushLater() {
    passed.later = true;
    while (queues.later.length) {
      run(queues.later.shift());
      if (queues.later.length) await yieldToMain();
    }
  }

  /** 第三段：閒置時一件一件做，這次閒置時間用完就排到下一次。回傳全部做完的 Promise。 */
  function flushIdle() {
    passed.idle = true;
    return new Promise(resolve => {
      const step = deadline => {
        do {
          const fn = queues.idle.shift();
          if (!fn) break;
          run(fn);
        } while (queues.idle.length && (deadline.didTimeout || deadline.timeRemaining() > IDLE_SLICE_MS));
        if (queues.idle.length) onIdle(step); else resolve();
      };
      if (queues.idle.length) onIdle(step); else resolve();
    });
  }

  return {
    yield: yieldToMain,
    nextFrame: nextFrame,
    isReady: isReady,
    later: fn => { if (passed.later) run(fn); else queues.later.push(fn); },
    idle: fn => {
      queues.idle.push(fn);
      if (passed.idle && queues.idle.length === 1) flushIdle();
    },
    ready: fn => {
      if (readyStage === 2) run(fn);
      else readyQueue.push(fn);
    },
    onIdle: onIdle,
    /* 以下只給 app/bootstrap.js 用 */
    flushLater: flushLater,
    flushIdle: flushIdle,
    report: report,
  };
})();
