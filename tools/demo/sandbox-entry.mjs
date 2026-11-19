// 公開 Demo 的瀏覽器端進入點（由 tools/demo/build-demo.mjs 打包後內嵌到 docs/index.html 的 <head>）。
//
// 在主程式載入之前做四件事：
//   1. 清掉上一次瀏覽留在 localStorage 的資料快取，確保「重新整理就還原」。
//   2. 在記憶體裡啟動後端（真正的 dist/code.gs ＋ 虛構的範例活頁簿）。
//   3. 提供 google.script.run 的替身：前端的 Api 層完全不用改，呼叫會直接進到記憶體裡的後端。
//   4. 顯示「Demo 模式」提示，並攔下通往 Google 試算表的連結（Demo 沒有真實的試算表）。
//   5. 第一次開啟時跳出歡迎資訊卡與使用導覽（onboarding.mjs，只存在 Demo）。
import { createDemoBackend } from './sandbox.mjs';
import { mountOnboarding } from './onboarding.mjs';
import SERVER_SOURCE from 'demo:server-source';

const STORAGE_PREFIX = 'FAST_BOOKKEEPING_';
// 純粹的介面偏好（動畫效果、自動捲動）保留，其餘以這個前綴開頭的都是資料快取，一律清掉。
const KEEP_KEYS = new Set(['FAST_BOOKKEEPING_PREFS_V1']);
const LATENCY_MS = [90, 220]; // 模擬一點點網路延遲，讓讀取中、送出中的動畫看得到

function clearDataCaches() {
  try {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) keys.push(localStorage.key(i));
    keys.forEach(key => {
      if (key && key.indexOf(STORAGE_PREFIX) === 0 && !KEEP_KEYS.has(key)) localStorage.removeItem(key);
    });
  } catch (e) { /* 隱私模式下可能無法存取 localStorage，略過即可 */ }
}

function createScriptRun(backend) {
  const delay = () => LATENCY_MS[0] + Math.random() * (LATENCY_MS[1] - LATENCY_MS[0]);
  const runner = state => new Proxy({}, {
    get(_, prop) {
      if (prop === 'withSuccessHandler') return fn => runner(Object.assign({}, state, { ok: fn }));
      if (prop === 'withFailureHandler') return fn => runner(Object.assign({}, state, { fail: fn }));
      if (prop === 'withUserObject') return obj => runner(Object.assign({}, state, { user: obj }));
      if (typeof prop !== 'string') return undefined;
      return (...args) => {
        setTimeout(() => {
          let result;
          try {
            result = backend.invoke(prop, args);
          } catch (e) {
            const err = new Error(e && e.message ? e.message : String(e));
            err.name = (e && e.name) || 'Error';
            if (state.fail) state.fail(err, state.user);
            else console.error('[demo] ' + prop + ' 失敗：', err);
            return;
          }
          if (state.ok) state.ok(result, state.user);
        }, delay());
      };
    },
  });
  return runner({});
}

/* ----------------------------------- 提示介面 ----------------------------------- */
// 左下角的小標籤：剛載入與有訊息時展開說明，幾秒後自動收合成「DEMO」，點一下可再展開。
const BADGE_CSS = `
.demo-badge{position:fixed;left:12px;bottom:calc(96px + env(safe-area-inset-bottom));z-index:2147482000;
  display:flex;align-items:center;gap:8px;max-width:calc(100vw - 24px);padding:5px;border-radius:999px;
  font:500 13px/1.3 "Noto Sans TC","PingFang TC","Microsoft JhengHei",system-ui,sans-serif;color:#fffcf7;background:rgba(28,28,30,.9);
  box-shadow:0 6px 24px rgba(0,0,0,.22);-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px)}
html[data-theme="dark"] .demo-badge{color:#1c1c1e;background:rgba(250,246,239,.94)}
.demo-badge button{appearance:none;-webkit-appearance:none;border:0;border-radius:999px;min-height:30px;padding:4px 12px;cursor:pointer;
  font:inherit;font-weight:600;color:inherit;background:rgba(255,255,255,.16);white-space:nowrap}
html[data-theme="dark"] .demo-badge button{background:rgba(28,28,30,.1)}
.demo-badge button:focus-visible{outline:2px solid currentColor;outline-offset:2px}
.demo-badge .demo-tag{font-size:11px;letter-spacing:.08em;background:#c93a2c;color:#fffcf7}
html[data-theme="dark"] .demo-badge .demo-tag{background:#c93a2c}
.demo-badge .demo-text{min-width:0}
.demo-badge.is-collapsed{padding:0;background:none;box-shadow:none;-webkit-backdrop-filter:none;backdrop-filter:none}
.demo-badge.is-collapsed .demo-text,.demo-badge.is-collapsed .demo-reset,.demo-badge.is-collapsed .demo-guide{display:none}
.demo-badge.is-collapsed .demo-tag{min-height:26px;box-shadow:0 4px 14px rgba(0,0,0,.25)}
@media (min-width:900px){.demo-badge{bottom:16px}}
`;

function mountBadge(onGuide) {
  const DEFAULT_TEXT = '範例資料，重新整理即還原';
  const COLLAPSE_MS = 7000;
  const style = document.createElement('style');
  style.textContent = BADGE_CSS;
  document.head.appendChild(style);

  const badge = document.createElement('div');
  badge.className = 'demo-badge';
  badge.innerHTML = '<button type="button" class="demo-tag" aria-expanded="true" title="這是線上試用版：資料只存在這個分頁">DEMO</button>' +
    '<span class="demo-text" role="status"></span>' +
    '<button type="button" class="demo-guide" title="再看一次介紹與使用導覽">導覽</button>' +
    '<button type="button" class="demo-reset" title="清除你在這個分頁做的所有修改">還原</button>';
  const tag = badge.querySelector('.demo-tag');
  const label = badge.querySelector('.demo-text');
  label.textContent = DEFAULT_TEXT;

  let timer = 0;
  const setCollapsed = collapsed => {
    badge.classList.toggle('is-collapsed', collapsed);
    tag.setAttribute('aria-expanded', String(!collapsed));
    if (collapsed) label.textContent = DEFAULT_TEXT;
  };
  const expand = message => {
    label.textContent = message || DEFAULT_TEXT;
    setCollapsed(false);
    clearTimeout(timer);
    timer = setTimeout(() => setCollapsed(true), COLLAPSE_MS);
  };

  tag.addEventListener('click', () => {
    if (badge.classList.contains('is-collapsed')) expand();
    else { clearTimeout(timer); setCollapsed(true); }
  });
  badge.querySelector('.demo-guide').addEventListener('click', () => { if (onGuide) onGuide(); });
  badge.querySelector('.demo-reset').addEventListener('click', () => location.reload());
  document.body.appendChild(badge);
  expand();
  return expand;
}

function interceptSheetLinks(flash) {
  document.addEventListener('click', event => {
    const link = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!link || !/^https?:\/\/docs\.google\.com\//.test(link.href)) return;
    event.preventDefault();
    event.stopPropagation();
    flash('Demo 沒有連結真實的 Google 試算表');
  }, true);
}

/* ------------------------------------- 啟動 ------------------------------------- */
clearDataCaches();

const backend = createDemoBackend({ serverSource: SERVER_SOURCE });

window.google = {
  script: {
    run: createScriptRun(backend),
    host: { close() {} },
    url: { getLocation(cb) { cb({ hash: location.hash, parameter: {}, parameters: {} }); } },
  },
};
window.__DEMO__ = { backend, today: backend.today };
window.__DEMO_INITIAL_DATA__ = backend.initialData();

const onReady = () => {
  let onboarding = null;
  const flash = mountBadge(() => onboarding && onboarding.open());
  interceptSheetLinks(flash);
  onboarding = mountOnboarding({ expandBadge: () => flash() });
};
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', onReady, { once: true });
else onReady();
