// 公開 Demo 專用的「歡迎資訊卡 ＋ 使用導覽」（由 sandbox-entry.mjs 掛載，只會出現在 Demo 網站，正式版不受影響）。
//
//   1. 載入畫面結束後跳出資訊卡：這個 Demo 是什麼、怎麼用、GitHub 原始碼連結。
//   2. 按「開始導覽」→ 依序聚光介紹記帳頁的各個區塊；每一步都可以「略過」。
//   3. 同一個分頁只自動出現一次（重新整理＝還原資料時不再打擾），之後可從左下角 DEMO 標籤的「導覽」重新開啟。

export const REPO_URL = 'https://github.com/SHI-K-Y/account-apps_script-demo';
const REPO_LABEL = 'SHI-K-Y/account-apps_script-demo';
const SEEN_KEY = 'DEMO_ONBOARDING_SEEN_V1';

const STEPS = [
  {
    target: '#pageBookkeeping .topbar-actions',
    title: '月份與工具列',
    body: '左邊切換月份；放大鏡搜尋所有交易、飛機是國外旅行帳簿、＋ 新增月份、箭頭重新讀取。',
  },
  {
    target: '#pageBookkeeping .tabs',
    title: '支出／收入',
    body: '先選這筆要記的是支出還是收入。',
  },
  {
    target: '#expensePanel [data-step="item"]',
    title: '點選分類',
    body: '依序點「項目」「總類」「支付方式」；選信用卡時會再問是否已繳。上方的「常用組合」可以一鍵帶入。',
  },
  {
    target: '#expensePanel [data-step="amount"]',
    title: '輸入金額',
    body: '用數字鍵盤輸入金額，下方可以加一句備註。',
  },
  {
    target: '#expenseSubmit',
    title: '確認記帳',
    body: '按下就寫入（Demo 寫在瀏覽器記憶體裡）。總覽、圖表與對帳數字都會跟著更新。',
  },
  {
    target: '#recentExpenses',
    fallback: '#todayExpenseCard',
    title: '最近紀錄',
    body: '剛記的帳會出現在這裡。手機點一下、桌機滑過去，就能修改或刪除。',
  },
  {
    target: '#bottomNav',
    title: '切換頁面',
    body: '對帳：核對帳面與實際餘額。總覽：資產、圖表與信用卡。設定：項目、卡片、常用組合。',
  },
  {
    target: '.demo-badge',
    title: 'Demo 標籤',
    body: '資料只存在這個分頁。按「還原」回到初始範例，按「導覽」可以再看一次這份教學。',
    badge: true,
  },
];

const CSS = `
.demo-ob,.demo-tour{--ob-bg:#fffcf7;--ob-ink:#1c1c1e;--ob-ink-2:#5b5b60;--ob-line:rgba(28,28,30,.1);--ob-soft:#f3ece1;
  --ob-accent:#c93a2c;--ob-accent-ink:#fffcf7;--ob-scrim:rgba(18,16,14,.6);
  font:400 14px/1.6 "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;color:var(--ob-ink);
  -webkit-font-smoothing:antialiased}
html[data-theme="dark"] .demo-ob,html[data-theme="dark"] .demo-tour{--ob-bg:#232326;--ob-ink:#f4efe7;--ob-ink-2:#aaa49b;
  --ob-line:rgba(255,255,255,.1);--ob-soft:#2d2d31;--ob-scrim:rgba(0,0,0,.62)}
.demo-ob *,.demo-tour *{box-sizing:border-box}
.demo-ob button,.demo-tour button{appearance:none;-webkit-appearance:none;font:inherit;cursor:pointer}
.demo-ob :focus-visible,.demo-tour :focus-visible{outline:2px solid var(--ob-accent);outline-offset:2px}

/* ── 歡迎資訊卡 ── */
.demo-ob{position:fixed;inset:0;z-index:2147483000;display:flex;align-items:center;justify-content:center;padding:16px;
  background:var(--ob-scrim);animation:demo-ob-fade .24s ease-out both}
.demo-ob.is-leaving{animation:demo-ob-fade .18s ease-in reverse both}
.demo-ob-card{position:relative;display:flex;flex-direction:column;width:min(440px,100%);max-height:calc(100dvh - 32px);
  border-radius:22px;background:var(--ob-bg);box-shadow:0 30px 80px -20px rgba(0,0,0,.45),0 0 0 1px var(--ob-line);
  overflow:hidden;animation:demo-ob-rise .34s cubic-bezier(.16,1,.3,1) both}
.demo-ob-scroll{overflow-y:auto;overscroll-behavior:contain;padding:24px 22px 8px}
.demo-ob-head{display:flex;align-items:center;gap:12px;margin-bottom:12px}
.demo-ob-logo{flex:none;display:grid;place-items:center;width:44px;height:44px;border-radius:12px;background:var(--ob-accent);
  color:var(--ob-accent-ink);font-weight:700;font-size:22px}
.demo-ob-eyebrow{margin:0;font-size:11px;font-weight:600;letter-spacing:.1em;color:var(--ob-accent)}
.demo-ob-title{margin:0;font-size:21px;font-weight:700;line-height:1.3}
.demo-ob-lead{margin:0 0 18px;color:var(--ob-ink-2)}
.demo-ob-sec{margin:0 0 16px}
.demo-ob-sec h3{margin:0 0 6px;font-size:12px;font-weight:600;letter-spacing:.06em;color:var(--ob-ink-2)}
.demo-ob-list{margin:0;padding:0;list-style:none;display:grid;gap:6px}
.demo-ob-list li{position:relative;padding-left:16px}
.demo-ob-list li::before{content:"";position:absolute;left:3px;top:.68em;width:5px;height:5px;border-radius:50%;background:var(--ob-accent)}
.demo-ob-list b{font-weight:600}
.demo-ob-repo{display:flex;align-items:center;gap:12px;margin:4px 0 14px;padding:12px 14px;border-radius:14px;
  background:var(--ob-soft);color:inherit;text-decoration:none;transition:transform .15s ease}
.demo-ob-repo:hover{transform:translateY(-1px)}
.demo-ob-repo svg{flex:none;width:26px;height:26px;fill:currentColor}
.demo-ob-repo span{display:flex;flex-direction:column;min-width:0}
.demo-ob-repo strong{font-weight:600;overflow-wrap:anywhere}
.demo-ob-repo small{color:var(--ob-ink-2);font-size:12px}
.demo-ob-repo i{margin-left:auto;font-style:normal;color:var(--ob-ink-2)}
.demo-ob-foot{display:flex;gap:10px;padding:12px 22px calc(18px + env(safe-area-inset-bottom));border-top:1px solid var(--ob-line)}
.demo-ob-btn{flex:1;min-height:44px;border:0;border-radius:12px;padding:10px 16px;font-weight:600;
  background:var(--ob-soft);color:var(--ob-ink)}
.demo-ob-btn.is-primary{flex:1.6;background:var(--ob-accent);color:var(--ob-accent-ink)}
.demo-ob-close{position:absolute;top:12px;right:12px;display:grid;place-items:center;width:32px;height:32px;border:0;border-radius:50%;
  background:transparent;color:var(--ob-ink-2);font-size:18px;line-height:1}
.demo-ob-close:hover{background:var(--ob-soft)}

/* ── 聚光導覽 ── */
.demo-tour{position:fixed;inset:0;z-index:2147483000}
.demo-tour-shield{position:absolute;inset:0}
.demo-tour-spot{position:fixed;border-radius:14px;pointer-events:none;box-shadow:0 0 0 200vmax var(--ob-scrim),0 0 0 2px var(--ob-accent);
  transition:top .32s cubic-bezier(.16,1,.3,1),left .32s cubic-bezier(.16,1,.3,1),width .32s cubic-bezier(.16,1,.3,1),height .32s cubic-bezier(.16,1,.3,1)}
.demo-tour-pop{position:fixed;width:min(340px,calc(100vw - 32px));padding:16px 16px 12px;border-radius:16px;background:var(--ob-bg);
  box-shadow:0 18px 50px -12px rgba(0,0,0,.45),0 0 0 1px var(--ob-line);transition:top .32s cubic-bezier(.16,1,.3,1),left .32s cubic-bezier(.16,1,.3,1),opacity .2s}
.demo-tour-pop.is-moving{opacity:.0}
.demo-tour-count{margin:0 0 2px;font-size:11px;font-weight:600;letter-spacing:.08em;color:var(--ob-accent)}
.demo-tour-pop h3{margin:0 0 4px;font-size:16px;font-weight:700}
.demo-tour-pop p{margin:0;color:var(--ob-ink-2)}
.demo-tour-dots{display:flex;gap:5px;margin:12px 0 10px}
.demo-tour-dots span{width:6px;height:6px;border-radius:3px;background:var(--ob-line);transition:width .2s,background .2s}
.demo-tour-dots span.is-on{width:16px;background:var(--ob-accent)}
.demo-tour-actions{display:flex;align-items:center;gap:8px}
.demo-tour-skip{margin-right:auto;min-height:36px;padding:6px 4px;border:0;background:none;color:var(--ob-ink-2);font-weight:500}
.demo-tour-skip:hover{color:var(--ob-ink)}
.demo-tour-nav{min-height:36px;padding:6px 14px;border:0;border-radius:10px;font-weight:600;background:var(--ob-soft);color:var(--ob-ink)}
.demo-tour-nav.is-primary{background:var(--ob-accent);color:var(--ob-accent-ink)}
.demo-tour-nav[hidden]{display:none}

@keyframes demo-ob-fade{from{opacity:0}to{opacity:1}}
@keyframes demo-ob-rise{from{opacity:0;transform:translateY(16px) scale(.98)}to{opacity:1;transform:none}}
@media (prefers-reduced-motion:reduce){
  .demo-ob,.demo-ob-card,.demo-ob.is-leaving{animation:none}
  .demo-tour-spot,.demo-tour-pop{transition:none}
}
`;

const GITHUB_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>';

const reducedMotion = () => !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()));

function readSeen() {
  try { return sessionStorage.getItem(SEEN_KEY) === '1'; } catch (e) { return false; }
}
function markSeen() {
  try { sessionStorage.setItem(SEEN_KEY, '1'); } catch (e) { /* 隱私模式下略過 */ }
}

/** 等載入畫面（boot loader）收起來再出現，避免兩層遮罩疊在一起。 */
function whenAppReady() {
  return new Promise(resolve => {
    const root = document.documentElement;
    const ready = () => root.classList.contains('boot-ready') && !document.getElementById('bootLoader');
    if (ready()) { resolve(); return; }
    const mo = new MutationObserver(() => { if (ready()) { mo.disconnect(); clearTimeout(timer); resolve(); } });
    mo.observe(document.body, { childList: true, subtree: false });
    mo.observe(root, { attributes: true, attributeFilter: ['class'] });
    const timer = setTimeout(() => { mo.disconnect(); resolve(); }, 15000);
  });
}

/** 讓焦點留在對話框裡（Tab / Shift+Tab 循環）。 */
function trapFocus(container, event) {
  if (event.key !== 'Tab') return;
  const items = Array.from(container.querySelectorAll('a[href],button:not([disabled]):not([hidden])'))
    .filter(el => el.offsetParent !== null);
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
}

/**
 * 掛載 Demo 的歡迎資訊卡與導覽。
 * @param {object} [opts]  expandBadge(message?)：展開左下角 DEMO 標籤（導覽最後一步會用到）
 * @returns {{ open: () => void }}  open() 重新顯示資訊卡
 */
export function mountOnboarding(opts) {
  const options = opts || {};
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  let active = null; // 目前顯示中的資訊卡或導覽（同時只會有一個）
  let returnFocus = null;

  function finish() {
    markSeen();
    if (active) { active.destroy(); active = null; }
    if (returnFocus && typeof returnFocus.focus === 'function' && document.contains(returnFocus)) returnFocus.focus();
    returnFocus = null;
  }

  function openWelcome() {
    if (active) active.destroy();
    if (!returnFocus) returnFocus = document.activeElement;
    const el = document.createElement('div');
    el.className = 'demo-ob';
    el.innerHTML =
      '<div class="demo-ob-card" role="dialog" aria-modal="true" aria-labelledby="demoObTitle" aria-describedby="demoObLead">' +
        '<button type="button" class="demo-ob-close" data-act="skip" aria-label="略過介紹">✕</button>' +
        '<div class="demo-ob-scroll">' +
          '<div class="demo-ob-head"><div class="demo-ob-logo" aria-hidden="true">$</div>' +
            '<div><p class="demo-ob-eyebrow">線上試用版 · DEMO</p><h2 class="demo-ob-title" id="demoObTitle">記帳簿</h2></div></div>' +
          '<p class="demo-ob-lead" id="demoObLead">用 Google 試算表當資料庫的個人記帳網頁，手機上三秒記一筆。這一頁是不需要登入的試用版。</p>' +
          '<section class="demo-ob-sec"><h3>關於這個 Demo</h3><ul class="demo-ob-list">' +
            '<li>正式版：<b>Google Apps Script</b> 後端＋網頁前端，資料存在你自己的 Google 試算表。</li>' +
            '<li>Demo 把同一份後端程式搬進瀏覽器執行，操作與正式版相同。</li>' +
            '<li>內建一本<b>完全虛構</b>的範例帳簿：最近六個月的收支、三張卡片、一趟旅行。</li>' +
          '</ul></section>' +
          '<section class="demo-ob-sec"><h3>使用方式</h3><ul class="demo-ob-list">' +
            '<li>自由新增、修改、刪除紀錄，總覽、圖表、對帳數字會即時更新。</li>' +
            '<li>資料只存在這個分頁的記憶體，<b>不會上傳</b>。</li>' +
            '<li>重新整理，或按左下角 DEMO 標籤的「還原」，就回到初始範例資料。</li>' +
          '</ul></section>' +
          '<a class="demo-ob-repo" href="' + REPO_URL + '" target="_blank" rel="noopener noreferrer">' + GITHUB_ICON +
            '<span><strong>' + REPO_LABEL + '</strong><small>GitHub：原始碼、安裝與部署說明</small></span><i aria-hidden="true">↗</i></a>' +
        '</div>' +
        '<div class="demo-ob-foot">' +
          '<button type="button" class="demo-ob-btn" data-act="skip">Skip 略過</button>' +
          '<button type="button" class="demo-ob-btn is-primary" data-act="tour">開始導覽 →</button>' +
        '</div>' +
      '</div>';

    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); finish(); return; }
      trapFocus(el, event);
    };
    el.addEventListener('click', event => {
      const act = event.target.closest && event.target.closest('[data-act]');
      if (act && act.dataset.act === 'skip') finish();
      else if (act && act.dataset.act === 'tour') startTour();
    });
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(el);
    el.querySelector('[data-act="tour"]').focus({ preventScroll: true });

    active = {
      destroy() {
        document.removeEventListener('keydown', onKey, true);
        if (reducedMotion()) { el.remove(); return; }
        el.classList.add('is-leaving');
        setTimeout(() => el.remove(), 180);
      },
    };
  }

  /** 導覽前先回到記帳頁的支出分頁（其他頁面的元素此時是隱藏的）。 */
  function resetToBookkeeping() {
    const page = document.getElementById('pageBookkeeping');
    if (page && !page.classList.contains('active')) {
      const nav = document.getElementById('navBookkeeping');
      if (nav) nav.click();
    }
    const tab = document.querySelector('#pageBookkeeping .tab[data-tab="expense"]');
    if (tab && !tab.classList.contains('active')) tab.click();
  }

  function startTour() {
    if (active) active.destroy();
    resetToBookkeeping();

    const steps = STEPS.slice();
    const el = document.createElement('div');
    el.className = 'demo-tour';
    el.innerHTML =
      '<div class="demo-tour-shield"></div>' +
      '<div class="demo-tour-spot" aria-hidden="true"></div>' +
      '<div class="demo-tour-pop is-moving" role="dialog" aria-modal="true" aria-labelledby="demoTourTitle" aria-describedby="demoTourBody">' +
        '<p class="demo-tour-count" aria-live="polite"></p>' +
        '<h3 id="demoTourTitle"></h3><p id="demoTourBody"></p>' +
        '<div class="demo-tour-dots" aria-hidden="true">' + steps.map(() => '<span></span>').join('') + '</div>' +
        '<div class="demo-tour-actions">' +
          '<button type="button" class="demo-tour-skip" data-act="skip">Skip 略過導覽</button>' +
          '<button type="button" class="demo-tour-nav" data-act="prev">上一步</button>' +
          '<button type="button" class="demo-tour-nav is-primary" data-act="next">下一步</button>' +
        '</div>' +
      '</div>';
    const spot = el.querySelector('.demo-tour-spot');
    const pop = el.querySelector('.demo-tour-pop');
    const count = el.querySelector('.demo-tour-count');
    const title = el.querySelector('#demoTourTitle');
    const body = el.querySelector('#demoTourBody');
    const dots = Array.from(el.querySelectorAll('.demo-tour-dots span'));
    const prevBtn = el.querySelector('[data-act="prev"]');
    const nextBtn = el.querySelector('[data-act="next"]');

    let index = 0;
    let target = null;
    let token = 0;
    let raf = 0;
    // 目標自己改變大小時（例如 DEMO 標籤自動收合）也要跟著重新擺放。
    const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => schedule()) : null;

    const findTarget = step => {
      const pick = selector => {
        const node = selector && document.querySelector(selector);
        if (!node) return null;
        const r = node.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? node : null;
      };
      return pick(step.target) || pick(step.fallback);
    };

    /** 依目標位置擺放聚光框與說明卡：卡片優先放在下方，放不下就放上方，再不行就貼齊畫面底部。 */
    const place = () => {
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const pad = 6;
      let r = target ? target.getBoundingClientRect() : null;
      if (r) {
        const top = Math.max(r.top - pad, 8);
        const bottom = Math.min(r.bottom + pad, vh - 8);
        const left = Math.max(r.left - pad, 8);
        const right = Math.min(r.right + pad, vw - 8);
        r = { top, left, width: Math.max(right - left, 0), height: Math.max(bottom - top, 0), bottom };
        Object.assign(spot.style, { top: r.top + 'px', left: r.left + 'px', width: r.width + 'px', height: r.height + 'px' });
      } else {
        Object.assign(spot.style, { top: vh / 2 + 'px', left: vw / 2 + 'px', width: '0px', height: '0px' });
      }

      const gap = 12;
      const pw = pop.offsetWidth;
      const ph = pop.offsetHeight;
      let top;
      if (!r) top = (vh - ph) / 2;
      else if (r.bottom + gap + ph <= vh - 12) top = r.bottom + gap;
      else if (r.top - gap - ph >= 12) top = r.top - gap - ph;
      else top = vh - ph - 16;
      const center = r ? r.left + r.width / 2 : vw / 2;
      const left = Math.min(Math.max(center - pw / 2, 16), vw - pw - 16);
      pop.style.top = Math.max(top, 12) + 'px';
      pop.style.left = left + 'px';
    };
    const schedule = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(place); };

    /** 捲動到目標並等位置穩定（smooth 捲動沒有結束事件，用連續兩格畫面位置不變來判斷）。 */
    const scrollToTarget = async node => {
      const r = node.getBoundingClientRect();
      const vh = window.innerHeight;
      const room = vh * 0.5; // 留一半畫面給說明卡
      if (r.top >= 70 && r.bottom <= vh - Math.min(room, 220)) return;
      node.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: r.height > room ? 'start' : 'center' });
      let last = null;
      for (let i = 0; i < 40; i++) {
        await frame();
        const now = node.getBoundingClientRect().top;
        if (last !== null && Math.abs(now - last) < 0.5) break;
        last = now;
      }
    };

    const show = async next => {
      const my = ++token;
      index = Math.max(0, Math.min(next, steps.length - 1));
      const step = steps[index];
      if (step.badge && options.expandBadge) options.expandBadge();
      pop.classList.add('is-moving');
      target = findTarget(step);
      if (resizeObserver) { resizeObserver.disconnect(); if (target) resizeObserver.observe(target); }
      if (target) await scrollToTarget(target);
      if (my !== token) return;

      count.textContent = (index + 1) + ' / ' + steps.length;
      title.textContent = step.title;
      body.textContent = step.body;
      dots.forEach((dot, i) => dot.classList.toggle('is-on', i === index));
      prevBtn.hidden = index === 0;
      nextBtn.textContent = index === steps.length - 1 ? '完成' : '下一步';
      place();
      pop.classList.remove('is-moving');
      nextBtn.focus({ preventScroll: true });
    };

    const onKey = event => {
      if (event.key === 'Escape') { event.preventDefault(); finish(); }
      else if (event.key === 'ArrowRight') { event.preventDefault(); nextBtn.click(); }
      else if (event.key === 'ArrowLeft' && index > 0) { event.preventDefault(); show(index - 1); }
      else trapFocus(pop, event);
    };
    el.addEventListener('click', event => {
      const act = event.target.closest && event.target.closest('[data-act]');
      if (!act) return;
      if (act.dataset.act === 'skip') finish();
      else if (act.dataset.act === 'prev') show(index - 1);
      else if (act.dataset.act === 'next') {
        if (index >= steps.length - 1) finish();
        else show(index + 1);
      }
    });
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', schedule);
    document.addEventListener('scroll', schedule, true);
    document.body.appendChild(el);

    active = {
      destroy() {
        token++;
        cancelAnimationFrame(raf);
        if (resizeObserver) resizeObserver.disconnect();
        document.removeEventListener('keydown', onKey, true);
        window.removeEventListener('resize', schedule);
        document.removeEventListener('scroll', schedule, true);
        el.remove();
      },
    };
    show(0);
  }

  const open = () => { returnFocus = document.activeElement; openWelcome(); };

  if (!readSeen()) {
    whenAppReady().then(() => wait(320)).then(() => { if (!active && !readSeen()) openWelcome(); });
  }
  return { open, startTour };
}
