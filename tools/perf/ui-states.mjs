// 共用的「畫面狀態」清單：逐頁、逐個設定分頁、彈出層與彈窗。
// glass-audit.mjs（毛玻璃盤點與全狀態截圖）、style-diff.mjs（computed style 比對）、css-coverage.mjs（CSS 覆蓋率）共用，
// 三個工具走過的畫面才會一致。
//
// 每個狀態：key＝名稱（截圖檔名）；page＝切到哪一頁；modal＝要開的彈窗 id；open＝在頁面內執行的函式（arg 是它的參數）；
// keep＝這個狀態做完後不用特別收拾（例如 toast 會自己消失）。
import { createDevApp } from '../dev-server.mjs';

export const STATES = [
  { key: 'page-bookkeeping', page: 'bookkeeping' },
  { key: 'page-bookkeeping-income', page: 'bookkeeping', open: () => { const t = document.querySelector('.head .tab[data-tab="income"]'); if (t) t.click(); } },
  { key: 'page-overview', page: 'overview' },
  { key: 'page-settlement', page: 'settlement' },
  { key: 'page-creditcard', page: 'creditcard' },
  { key: 'page-search', page: 'search' },
  { key: 'page-foreign', page: 'foreign' },
  { key: 'page-settings', page: 'settings' },
  { key: 'page-overview-scrolled', page: 'overview', open: () => window.scrollTo(0, 900) },
  { key: 'page-settlement-scrolled', page: 'settlement', open: () => window.scrollTo(0, 700) },
  { key: 'page-bookkeeping-scrolled', page: 'bookkeeping', open: () => { document.querySelector('.head .tab[data-tab="expense"]').click(); window.scrollTo(0, 1400); } },
  ...['expenseItems', 'paymentMethods', 'quickCombos', 'budget', 'mealSlots', 'reminders', 'preferences'].map(t => ({
    key: 'settings-' + t, page: 'settings', arg: t,
    open: tab => { const b = document.querySelector('[data-stab="' + tab + '"]'); if (b) b.click(); },
  })),
  // 彈出層直接畫出來再取消 hidden（用 click 開會被同一次點擊的「點外面關閉」收掉）
  { key: 'pop-calendar', page: 'bookkeeping', open: () => { document.querySelector('.head .tab[data-tab="expense"]').click(); renderCalendar('expense'); document.getElementById('expenseCalendar').hidden = false; } },
  { key: 'pop-recent-calendar', page: 'bookkeeping', open: () => { document.querySelector('.head .tab[data-tab="expense"]').click(); const c = document.getElementById('expenseFilterCalendar'); try { renderCalendar('expenseFilter'); } catch (e) {} c.hidden = false; c.scrollIntoView({ block: 'center' }); } },
  { key: 'pop-fx-menu', page: 'foreign', open: () => { document.getElementById('pageForeign').dataset.view = 'ledger'; document.getElementById('fxLedgerMenu').hidden = false; } },
  { key: 'pop-emoji', page: 'settings', modal: 'itemEditModal', open: () => { const p = document.getElementById('emojiPickerPopover'); if (p) p.hidden = false; } },
  { key: 'toast', page: 'bookkeeping', open: () => showToast('已儲存', 'success'), keep: true },
  // 短暫狀態（約 0.6 秒）：套用常用組合後晶片閃一下、自動帶入支付方式時按鈕閃一下。直接加上 class，動畫定格在第 0 幀比對／截圖
  { key: 'state-flash', page: 'bookkeeping', open: () => {
    document.querySelector('.head .tab[data-tab="expense"]').click();
    document.querySelectorAll('.quick-combo-chip').forEach(c => c.classList.add('just-applied'));
    document.querySelectorAll('#paymentChoices .choice').forEach(c => c.classList.add('auto-applied'));
  } },
];
export const MODALS = ['editRecordModal', 'quickComboModal', 'settingsDeleteModal', 'deleteConfirmModal', 'addMonthModal', 'itemEditModal',
  'cardEditModal', 'channelEditModal', 'bankEditModal', 'reminderModal', 'fxLedgerModal', 'fxRecordModal', 'fxDeleteLedgerModal', 'fxDeleteRecordModal'];
MODALS.forEach(id => STATES.push({ key: 'modal-' + id, page: id.startsWith('fx') ? 'foreign' : 'bookkeeping', modal: id }));

export const VIEWPORT = { width: 390, height: 844 };
export const FIXED_NOW = Date.UTC(2026, 10, 13, 4, 0, 0);   // 2026-11-13 12:00 台北（與 tools/test、perf/run.mjs 相同）
export const sleep = ms => new Promise(r => setTimeout(r, ms));

function shiftedDate(startMs) {
  const offset = startMs - Date.now();
  return class PerfDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(Date.now() + offset); }
    static now() { return Date.now() + offset; }
  };
}

/** 用合成資料啟動本機替身；root 是要量的建置產物資料夾（預設 dist/）。 */
export async function startFixtureApp(root) {
  const app = createDevApp({ fixture: true, quiet: true, DateCtor: shiftedDate(FIXED_NOW), root });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  return { url: 'http://127.0.0.1:' + app.server.address().port + '/', close: () => new Promise(r => app.server.close(r)) };
}

/** 開一個手機大小的 context（固定時鐘、預設偏好）；回傳已經開機完成（boot-ready）的頁面。 */
export async function openBootedPage(browser, url, opts) {
  const o = opts || {};
  const context = await browser.newContext({
    viewport: o.viewport || VIEWPORT, deviceScaleFactor: 2, isMobile: o.isMobile !== false, hasTouch: o.isMobile !== false,
    locale: 'zh-TW', timezoneId: 'Asia/Taipei', colorScheme: o.theme || 'light',
  });
  await context.addInitScript(cfg => {
    const RealDate = Date; const off = cfg.now - RealDate.now();
    class D extends RealDate { constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + off); } static now() { return RealDate.now() + off; } }
    window.Date = D;
    try { localStorage.setItem('FAST_BOOKKEEPING_PREFS_V1', JSON.stringify(cfg.prefs)); } catch (e) {}
  }, { now: FIXED_NOW, prefs: o.prefs || { motion: 'full', autoScroll: true } });
  const page = await context.newPage();
  page.on('pageerror', e => console.warn('  [頁面錯誤] ' + e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.classList.contains('boot-ready'), null, { timeout: 60000 });
  await sleep(o.settleMs == null ? 2500 : o.settleMs);
  return { context, page };
}

/** 從任何狀態回到乾淨的起點，再進入指定狀態。 */
export async function prepare(page, st) {
  await page.evaluate(() => {
    document.querySelectorAll('.modal-backdrop.show').forEach(m => closeModal(m));
    document.querySelectorAll('.calendar-popover, .fx-menu, .emoji-picker-popover').forEach(p => { p.hidden = true; });
  });
  await sleep(700);
  await page.evaluate(p => { if (document.body.dataset.page !== p) switchPage(p); }, st.page);
  await sleep(1200);
  await page.evaluate(() => window.scrollTo(0, 0));
  if (st.modal) { await page.evaluate(id => openModal(document.getElementById(id)), st.modal); await sleep(900); }
  if (st.open) { await page.evaluate(st.open, st.arg); await sleep(900); }
}
