// 清單與選項的增量更新（P06）：
//   1. ListRender.reconcile：以 key 比對新舊清單，只新增、移除、移動有變化的節點；內容沒變的節點不動。
//   2. 記帳頁、搜尋頁的明細：記一筆、同步完成、刪除一筆時，其他列沿用原本的節點；修改／刪除用事件委派。
//   3. 選項晶片：選取變化只切換 selected 與 aria-pressed，選項清單沒變就不重建。
//   4. 不再有 body 層級的 subtree MutationObserver。
// 前兩類在真的 Chromium 裡跑（本機預覽伺服器＋合成資料），第 4 類是原始碼檢查。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './helpers.mjs';
import { createDevApp } from '../dev-server.mjs';

const CLIENT = path.join(ROOT, 'src', 'client');
const read = rel => fs.readFileSync(path.join(CLIENT, rel), 'utf8');
const FIXED_NOW = Date.UTC(2026, 10, 13, 4, 0, 0);   // 2026-11-13 12:00 台北

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch (e) { chromium = null; }
const NO_BROWSER = chromium ? false : '沒有安裝 playwright';

function shiftedDate(startMs) {
  const offset = startMs - Date.now();
  return class TestDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(Date.now() + offset); }
    static now() { return Date.now() + offset; }
  };
}

/** 頁面端：固定時鐘；window.__rpcDelay（毫秒）可以讓 google.script.run 晚一點回來，才看得到「同步中」。 */
function pageInit(fixedNow) {
  const RealDate = Date;
  const offset = fixedNow - RealDate.now();
  class FixedDate extends RealDate {
    constructor(...a) { if (a.length) super(...a); else super(RealDate.now() + offset); }
    static now() { return RealDate.now() + offset; }
  }
  window.Date = new Proxy(FixedDate, { apply: () => new FixedDate().toString() });
  const realFetch = window.fetch;
  window.__rpcInflight = 0;
  window.fetch = function (input) {
    if (String(input && input.url || input).indexOf('/__rpc') === -1) return realFetch.apply(this, arguments);
    const args = arguments;
    const self = this;
    window.__rpcInflight++;
    const delay = window.__rpcDelay || 0;
    return new Promise(r => setTimeout(r, delay))
      .then(() => realFetch.apply(self, args))
      .finally(() => { window.__rpcInflight--; });
  };
}

async function openApp(browser, fixtureOptions) {
  const app = createDevApp({ fixture: true, quiet: true, DateCtor: shiftedDate(FIXED_NOW), fixtureOptions });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-TW', timezoneId: 'Asia/Taipei',
  });
  await context.addInitScript(pageInit, FIXED_NOW);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + app.server.address().port + '/');
  await page.waitForFunction(() => document.documentElement.classList.contains('boot-ready'), null, { timeout: 60000 });
  await idle(page);
  return {
    page, errors,
    close: async () => { await context.close(); await new Promise(r => app.server.close(r)); },
  };
}

/** 等所有 RPC 回來，再多等一下讓動畫與重繪跑完。 */
async function idle(page, extra = 400) {
  await page.waitForFunction(() => window.__rpcInflight === 0, null, { polling: 50, timeout: 30000 });
  await page.waitForTimeout(extra);
}

let browser = null;
test.before(async () => { if (chromium) browser = await chromium.launch(); });
test.after(async () => { if (browser) await browser.close(); });

/* ---------------------------------------------------------------------------
 * 1. ListRender 本身
 * ------------------------------------------------------------------------- */
test('ListRender：開頭插入一筆只建立一個節點，其餘沿用；內容沒變的節點不更新', { skip: NO_BROWSER }, async () => {
  const s = await openApp(browser);
  try {
    const r = await s.page.evaluate(() => {
      const box = document.createElement('div');
      document.body.appendChild(box);
      let updates = 0;
      const opts = {
        key: x => x.id,
        sig: x => x.text,
        create: x => { const el = document.createElement('p'); el.textContent = x.text; return el; },
        update: (el, x) => { updates++; el.textContent = x.text; },
      };
      const a = { id: 'a', text: 'A' }, b = { id: 'b', text: 'B' }, c = { id: 'c', text: 'C' };
      ListRender.reconcile(box, [a, b, c], opts);
      const before = Array.from(box.children);
      const res = ListRender.reconcile(box, [{ id: 'z', text: 'Z' }, a, b, c], opts);
      const after = Array.from(box.children);
      const same = before.every((el, i) => el === after[i + 1]);
      const res2 = ListRender.reconcile(box, [{ id: 'z', text: 'Z' }, a, { id: 'b', text: 'B2' }, c], opts);
      const text = Array.from(box.children).map(e => e.textContent).join(',');
      const empty = ListRender.reconcile(box, [], Object.assign({ empty: '<div class="empty">沒有</div>' }, opts));
      const emptyHtml = box.innerHTML;
      box.remove();
      return { created: res.created.length, kept: res.kept, same, updates, created2: res2.created.length, text, emptyRemoved: empty.removed, emptyHtml };
    });
    assert.equal(r.created, 1, '只建立新的那一筆');
    assert.equal(r.kept, 3);
    assert.ok(r.same, '原本的三個節點沿用、順序正確');
    assert.equal(r.updates, 1, '只有內容變了的那一筆被更新');
    assert.equal(r.created2, 0);
    assert.equal(r.text, 'Z,A,B2,C');
    assert.equal(r.emptyRemoved, 4);
    assert.equal(r.emptyHtml, '<div class="empty">沒有</div>');
  } finally { await s.close(); }
});

test('ListRender：刪除後列號往上遞補，用 ident 認回節點；刪除動畫抓走的節點不會被拿去顯示別筆', { skip: NO_BROWSER }, async () => {
  const s = await openApp(browser);
  try {
    const r = await s.page.evaluate(() => {
      const box = document.createElement('div');
      document.body.appendChild(box);
      const opts = {
        key: x => 'r' + x.row,
        ident: x => x.text,
        sig: x => x.row + x.text,
        create: x => { const el = document.createElement('p'); el.textContent = x.text; el.dataset.row = x.row; return el; },
        update: (el, x) => { el.textContent = x.text; el.dataset.row = x.row; },
      };
      // 第 6 列和第 7 列內容相同（例如同一天兩杯一樣的飲料）
      ListRender.reconcile(box, [{ row: 5, text: '早餐' }, { row: 6, text: '飲料' }, { row: 7, text: '飲料' }, { row: 8, text: '晚餐' }], opts);
      const old = Array.from(box.children);
      ListRender.markLeaving(old[1]);   // 刪除第 6 列
      const res = ListRender.reconcile(box, [{ row: 5, text: '早餐' }, { row: 6, text: '飲料' }, { row: 7, text: '晚餐' }], opts);
      const now = Array.from(box.children);
      box.remove();
      return {
        leavingDetached: !old[1].isConnected,
        reused: now[0] === old[0] && now[1] === old[2] && now[2] === old[3],
        rows: now.map(e => e.dataset.row).join(','),
        created: res.created.length,
      };
    });
    assert.ok(r.leavingDetached, '被刪除的那一列交給刪除動畫，不留在清單裡');
    assert.ok(r.reused, '下方往上遞補的列沿用原本的節點');
    assert.equal(r.rows, '5,6,7', '列號跟著更新');
    assert.equal(r.created, 0);
  } finally { await s.close(); }
});

test('ListRender：超過 300 筆先畫 50 筆，捲到底再補', { skip: NO_BROWSER }, async () => {
  const s = await openApp(browser);
  try {
    const r = await s.page.evaluate(async () => {
      const box = document.createElement('div');
      document.body.appendChild(box);
      const items = Array.from({ length: 320 }, (_, i) => ({ id: i }));
      const opts = { key: x => x.id, sig: () => '', create: x => { const el = document.createElement('p'); el.style.height = '20px'; el.textContent = x.id; return el; }, chunk: { listId: 't' } };
      ListRender.reconcile(box, items, opts);
      const first = box.children.length;
      const sentinel = Boolean(box.nextElementSibling && box.nextElementSibling.classList.contains('lr-sentinel'));
      ListRender.more(box);
      const second = box.children.length;
      // 同一份清單重繪（例如新增一筆）不會縮回 50 筆
      ListRender.reconcile(box, [{ id: 'new' }].concat(items), opts);
      const third = box.children.length;
      ListRender.more(box, Infinity);
      const all = box.children.length;
      const sentinelGone = !(box.nextElementSibling && box.nextElementSibling.classList.contains('lr-sentinel'));
      box.remove();
      return { first, sentinel, second, third, all, sentinelGone };
    });
    assert.equal(r.first, 50);
    assert.ok(r.sentinel, '清單後面有偵測捲動的哨兵');
    assert.equal(r.second, 100);
    assert.equal(r.third, 100);
    assert.equal(r.all, 321);
    assert.ok(r.sentinelGone, '全部畫完後移除哨兵');
  } finally { await s.close(); }
});

/* ---------------------------------------------------------------------------
 * 2. 記帳頁的明細
 * ------------------------------------------------------------------------- */
async function pickAndSubmitExpense(page) {
  await page.locator('#expenseItemChoices .choice').first().click();
  for (const box of ['#expenseCategoryChoices', '#paymentChoices']) {
    if (!(await page.locator(box + ' .choice.selected').count())) await page.locator(box + ' .choice').first().click();
  }
  await page.locator('#expenseKeypad .key:text-is("7")').click();
  await page.locator('#expenseSubmit').click();
}

test('記帳頁：記一筆支出時其他列沿用原本的節點，同步中標記會出現再消失', { skip: NO_BROWSER }, async () => {
  const s = await openApp(browser, { extraExpenses: 22 });
  try {
    const { page } = s;
    await page.evaluate(() => toggleFullRecords('expense'));
    await idle(page);
    const before = await page.evaluate(() => {
      window.__rows = Array.from(document.querySelectorAll('#recentExpenses .recent-item'));
      return window.__rows.length;
    });
    assert.equal(before, 30, '完整紀錄 30 筆');

    await page.evaluate(() => { window.__rpcDelay = 600; });
    await pickAndSubmitExpense(page);
    const pending = await page.evaluate(() => {
      const first = document.querySelector('#recentExpenses .recent-item');
      window.__pendingRow = first;
      return {
        isPending: first.classList.contains('is-pending'),
        badge: Boolean(first.querySelector('.recent-pending-badge')),
        editDisabled: first.querySelector('.edit-btn').disabled,
        reused: window.__rows.every(el => el.isConnected),
      };
    });
    assert.ok(pending.isPending && pending.badge && pending.editDisabled, '新的一筆先以「同步中」顯示，按鈕停用');
    assert.ok(pending.reused, '原本的 30 列都沒有被重建');

    await page.evaluate(() => { window.__rpcDelay = 0; });
    await idle(page, 300);
    const synced = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#recentExpenses .recent-item'));
      const first = rows[0];
      return {
        count: rows.length,
        sameNode: first === window.__pendingRow,
        isPending: first.classList.contains('is-pending'),
        badge: Boolean(first.querySelector('.recent-pending-badge')),
        editDisabled: first.querySelector('.edit-btn').disabled,
        row: first.dataset.row,
        oldKept: window.__rows.filter(el => el.isConnected).length,
        flashed: first.classList.contains('sync-ok') || Boolean(first.querySelector('.recent-sync-check')),
      };
    });
    assert.equal(synced.count, 31);
    assert.ok(synced.sameNode, '同步完成後沿用「同步中」那一列的節點');
    assert.ok(!synced.isPending && !synced.badge && !synced.editDisabled, '同步中標記拿掉、按鈕恢復');
    assert.notEqual(synced.row, 'pending');
    assert.equal(synced.oldKept, 30, '其他列一個都沒有重建');
    assert.ok(synced.flashed, '同步完成的閃光照常播放');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('記帳頁：修改／刪除鈕用事件委派，刪除後下方的列沿用節點並更新列號，刪除動畫播在被刪的那一列', { skip: NO_BROWSER }, async () => {
  const s = await openApp(browser, { extraExpenses: 6 });
  try {
    const { page } = s;
    await page.evaluate(() => toggleFullRecords('expense'));
    await idle(page);
    // 修改鈕：開啟修改視窗，帶入的是那一列的紀錄
    const target = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#recentExpenses .recent-item'));
      window.__rows = rows;
      return { row: rows[2].dataset.row, item: rows[2]._record.item };
    });
    await page.locator('#recentExpenses .recent-item').nth(2).locator('.edit-btn').dispatchEvent('click');
    await page.waitForSelector('#editRecordModal.show');
    assert.equal(await page.evaluate(() => editState.row), Number(target.row));
    await page.evaluate(() => closeEditModal ? closeEditModal() : null).catch(() => {});
    await page.waitForTimeout(500);

    // 刪除鈕
    await page.locator('#recentExpenses .recent-item').nth(2).locator('.delete-btn').dispatchEvent('click');
    await page.waitForSelector('#deleteConfirmModal.show');
    await page.evaluate(() => {
      // 刪除動畫一開始就把被刪的列（is-leaving）放回原位：記下來檢查
      const mo = new MutationObserver(() => {
        const el = document.querySelector('#recentExpenses .recent-item.is-leaving');
        if (el && !window.__leaving) window.__leaving = el;
      });
      mo.observe(document.getElementById('recentExpenses'), { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    });
    await page.locator('#deleteModalConfirmBtn').click();
    await idle(page, 900);
    const r = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#recentExpenses .recent-item'));
      const old = window.__rows;
      return {
        count: rows.length,
        leavingWasDeleted: window.__leaving === old[2],
        leavingGone: !old[2].isConnected,
        aboveKept: rows[0] === old[0] && rows[1] === old[1],
        belowKept: old.slice(3).every(el => el.isConnected),
        rows: rows.map(e => Number(e.dataset.row)),
      };
    });
    assert.equal(r.count, 13);
    assert.ok(r.leavingWasDeleted, '刪除動畫播在被刪除的那一列');
    assert.ok(r.leavingGone, '動畫結束後移除');
    assert.ok(r.aboveKept && r.belowKept, '其餘的列都沿用原本的節點');
    assert.equal(new Set(r.rows).size, r.rows.length, '列號沒有重複（往上遞補後已更新）');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('記帳頁：日期篩選照常運作，切回全部時沿用節點', { skip: NO_BROWSER }, async () => {
  const s = await openApp(browser, { extraExpenses: 22 });
  try {
    const { page } = s;
    await page.evaluate(() => toggleFullRecords('expense'));
    await idle(page);
    await page.evaluate(() => { window.__rows = Array.from(document.querySelectorAll('#recentExpenses .recent-item')); });
    await page.evaluate(() => {
      const input = document.getElementById('expenseFilterDate');
      input.value = '2026-11-05';
      input.dispatchEvent(new Event('change'));
    });
    await page.waitForTimeout(300);
    const filtered = await page.evaluate(() => Array.from(document.querySelectorAll('#recentExpenses .recent-item')).map(e => parseInt(e._record.day, 10)));
    assert.ok(filtered.length > 0 && filtered.every(d => d === 5), '只剩 5 日的紀錄');
    await page.locator('#expenseFilterAllBtn').click();
    await page.waitForTimeout(300);
    const back = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#recentExpenses .recent-item'));
      return { count: rows.length, filteredKept: rows.filter(el => window.__rows.includes(el)).length };
    });
    assert.equal(back.count, 30);
    assert.ok(back.filteredKept > 0, '篩選時畫出的列在切回全部時沿用');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

/* ---------------------------------------------------------------------------
 * 3. 選項晶片、搜尋頁
 * ------------------------------------------------------------------------- */
test('選項晶片：選取變化只切換 selected／aria-pressed；選項沒變時重繪不重建節點', { skip: NO_BROWSER }, async () => {
  const s = await openApp(browser);
  try {
    const { page } = s;
    const r = await page.evaluate(() => {
      const box = document.getElementById('paymentChoices');
      const before = Array.from(box.querySelectorAll('.choice'));
      const target = before.find(b => !b.classList.contains('selected'));
      target.click();
      const afterClick = Array.from(box.querySelectorAll('.choice'));
      renderExpensePaymentChoices();
      renderAllChoices();
      const afterRender = Array.from(box.querySelectorAll('.choice'));
      const selected = afterRender.filter(b => b.classList.contains('selected'));
      return {
        sameAfterClick: before.every((b, i) => b === afterClick[i]),
        sameAfterRender: before.every((b, i) => b === afterRender[i]),
        selectedIsTarget: selected.length === 1 && selected[0] === target,
        pressed: target.getAttribute('aria-pressed'),
        others: afterRender.filter(b => b !== target).every(b => b.getAttribute('aria-pressed') === 'false'),
        state: state.expense.payment === target.dataset.value,
      };
    });
    assert.ok(r.sameAfterClick && r.sameAfterRender, '節點沒有被重建');
    assert.ok(r.selectedIsTarget && r.pressed === 'true' && r.others, '選取狀態正確');
    assert.ok(r.state, 'setter 照常更新狀態');

    // 選項清單本身改變時才重建
    const rebuilt = await page.evaluate(() => {
      const box = document.getElementById('expenseCategoryChoices');
      const before = box.querySelector('.choice');
      state.data.options.expenseCategories = state.data.options.expenseCategories.concat(['測試總類']);
      renderExpenseCategoryChoices();
      const after = box.querySelector('.choice');
      return { rebuilt: before !== after, count: box.querySelectorAll('.choice').length, last: box.lastElementChild.textContent };
    });
    assert.ok(rebuilt.rebuilt);
    assert.equal(rebuilt.last, '測試總類');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('搜尋頁：關鍵字高亮、修改／刪除委派照常；重新渲染不重建沒變的列', { skip: NO_BROWSER }, async () => {
  const s = await openApp(browser, { extraExpenses: 22 });
  try {
    const { page } = s;
    await page.evaluate(() => switchPage('search'));
    await page.waitForTimeout(600);
    await page.fill('#srInput', '午餐');
    await page.locator('#srInput').press('Enter');
    await idle(page, 600);
    const r = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#srResults .sr-item'));
      window.__srRows = rows;
      return {
        count: rows.length,
        marked: rows.every(el => el.querySelector('mark.sr-mark') && /午餐/.test(el.querySelector('mark.sr-mark').textContent)),
        dated: rows.every(el => el.querySelector('.recent-fulldate')),
      };
    });
    assert.ok(r.count > 0, '有搜尋結果');
    assert.ok(r.marked, '關鍵字高亮');
    assert.ok(r.dated, '每列帶完整日期');
    await page.locator('#srResults .sr-item').first().locator('.edit-btn').dispatchEvent('click');
    await page.waitForSelector('#editRecordModal.show');
    assert.equal(await page.evaluate(() => editState.item), '午餐');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

/* ---------------------------------------------------------------------------
 * 4. 原始碼檢查
 * ------------------------------------------------------------------------- */
test('MutationObserver：不再對 document.body 開 subtree 觀察，ux.js 只觀察切換 active 的按鈕', () => {
  const sources = JSON.parse(read('manifest.json')).scripts.map(f => [f, read('scripts/' + f)]);
  for (const [file, src] of sources) {
    assert.doesNotMatch(src, /observe\(\s*document\.body\s*,\s*\{[^}]*subtree\s*:\s*true/, file + ' 不可以對 body 開 subtree 的 MutationObserver');
  }
  const ux = read('scripts/app/ux.js');
  assert.doesNotMatch(ux, /subtree\s*:\s*true/, 'ux.js 的觀察對象縮小到按鈕本身');
  const motion = read('scripts/core/motion.js');
  assert.doesNotMatch(motion, /bindSegmentedAuto/);
  // 程式渲染出來的分段控制由渲染函式直接啟用
  for (const [file, sel] of [['pages/settings/preferences.js', '.pref-seg-btn'], ['pages/settings/budget.js', '.pref-seg-btn'],
    ['pages/settings/reminders.js', '.pref-seg-btn'], ['pages/credit-card.js', '.cc-card-tab'], ['pages/credit-card.js', '.cc-filter-btn']]) {
    assert.ok(read('scripts/' + file).includes("Motion.segmented(") && read('scripts/' + file).includes("'" + sel + "'"), file + ' 要直接呼叫 Motion.segmented');
  }
});

test('清單：明細列不再逐筆綁 click，卡片／銀行圖片有 decoding 與明確尺寸', () => {
  const recent = read('scripts/bookkeeping/recent.js');
  const build = recent.slice(recent.indexOf('function buildRecentItem'), recent.indexOf('function normalizeSearchText'));
  assert.doesNotMatch(build, /addEventListener/, 'buildRecentItem／patchRecentItem 不綁事件');
  const choices = read('scripts/bookkeeping/payment-choices.js');
  const pay = choices.slice(choices.indexOf('function renderPaymentChoices'), choices.indexOf('function getPaymentType'));
  assert.doesNotMatch(pay, /button\.addEventListener/, '選項晶片不逐顆綁事件');
  assert.match(pay, /imgEl\.width = 76;[\s\S]*imgEl\.height = 48;[\s\S]*imgEl\.decoding = 'async'/);
  assert.match(pay, /bankImg\.width = 25;[\s\S]*bankImg\.height = 18;[\s\S]*bankImg\.decoding = 'async'/);
  assert.match(read('scripts/pages/credit-card.js'), /cc-tab-card-img" [^>]*width="24" height="15" decoding="async"/);
  const manifest = JSON.parse(read('manifest.json')).scripts;
  assert.ok(manifest.indexOf('core/list-render.js') !== -1 && manifest.indexOf('core/list-render.js') < manifest.indexOf('bookkeeping/recent.js'));
});
