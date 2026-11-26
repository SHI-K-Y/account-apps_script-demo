// 信用卡對帳頁明細的修改與刪除（視窗、寫入、復原沿用記帳頁的 bookkeeping/record-modals.js，source: 'creditcard'）：
//   1. 後端 expect：修改／刪除前核對那一列還是同一筆，對不上就丟「衝突」、一格都不寫；沒帶時維持原行為；重送照樣冪等
//   2. 前端合併：對帳頁自己的清單（ccState）跟著修改、刪除、復原更新，和後端的整月明細相同；筆數對不上就標成要重讀
//   3. 瀏覽器：修改、刪除、復原（含不是目前月份的紀錄）、列沿用節點、寫入中的月份鎖、衝突後重新讀取、排版
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { ROOT, createBackend, expenseForm, incomeForm, browserTests } from './helpers.mjs';
import { createDevApp } from '../dev-server.mjs';

// 沒有 Chromium 時瀏覽器測試略過（原因會提示安裝方式）；REQUIRE_BROWSER=1 時改為失敗。
const web = await browserTests();
const NO_BROWSER = web.skip;

const MONTH = '2026.11';
const PAST = '2026.10';
const FIXED_NOW = Date.UTC(2026, 10, 13, 4, 0, 0);   // 2026-11-13 12:00 台北
const plain = v => (v === undefined ? v : JSON.parse(JSON.stringify(v)));
const snapshot = (b, name) => JSON.stringify(Array.from(b.sheet(name).cells.entries())
  .filter(([, c]) => c.v !== '' || c.f)
  .sort(([a], [b2]) => (a < b2 ? -1 : a > b2 ? 1 : 0)));
const expensesOf = (b, month) => b.call('getFullRecords', month, 'expense', true).records;
const expectOf = rec => ({
  day: rec.day, item: rec.item, category: rec.category, payment: rec.payment, paid: rec.paid, amount: rec.amount, note: rec.note,
});

/* ------------------------------ 1. 後端核對 ------------------------------ */

test('expect 相符：修改與刪除照常寫入；同一個 opId 重送不會再核對、也不會再刪一筆', () => {
  const b = createBackend();
  const rec = expensesOf(b, MONTH).find(r => r.row === 9);
  const upd = b.call('updateExpense', expenseForm({
    row: 9, day: 5, item: '娛樂', payment: '信用卡-測試二卡', paid: 'X', amount: 2500, note: 'KTV', expect: expectOf(rec), opId: 'cc-upd-0001',
  }));
  assert.equal(upd.record.amount, 2500);
  assert.equal(b.sheet(MONTH).getRange('G9').getValue(), 2500);

  const del = { month: MONTH, row: 9, expect: expectOf(upd.record), opId: 'cc-del-0001' };
  assert.equal(b.call('deleteExpense', del).op, 'delete');
  assert.equal(expensesOf(b, MONTH).length, 7);
  const again = b.call('deleteExpense', del);
  assert.equal(again.replayed, true, '重送拿到上次的結果');
  assert.equal(expensesOf(b, MONTH).length, 7, '沒有多刪一筆');
});

test('expect 不符（列號已位移、內容被改過、那一列是空的）：丟出衝突，工作表與操作紀錄都不變', () => {
  const b = createBackend();
  const list = expensesOf(b, MONTH);
  const at = row => list.find(r => r.row === row);
  b.call('deleteExpense', { month: MONTH, row: 6 });   // 另一台裝置刪掉上面一筆，下方往上遞補
  const before = snapshot(b, MONTH);
  const logBefore = b.sheet('_操作紀錄').getLastRow();

  assert.throws(() => b.call('deleteExpense', { month: MONTH, row: 9, expect: expectOf(at(9)) }), /^Error: 衝突：|衝突：/);
  assert.throws(() => b.call('updateExpense', expenseForm({ row: 9, expect: expectOf(at(9)) })), /衝突：/);
  assert.throws(() => b.call('deleteExpense', { month: MONTH, row: 5, expect: Object.assign(expectOf(at(5)), { amount: 86 }) }), /衝突：/);
  assert.throws(() => b.call('deleteExpense', { month: MONTH, row: 12, expect: expectOf(at(12)) }), /衝突：/, '原本最後一列已經是空的');
  assert.equal(snapshot(b, MONTH), before);
  assert.equal(b.sheet('_操作紀錄').getLastRow(), logBefore);

  // 位移後的正確列號可以刪；沒帶 expect（記帳頁、HTTP API）維持原行為
  assert.equal(b.call('deleteExpense', { month: MONTH, row: 8, expect: expectOf(at(9)) }).op, 'delete');
  assert.equal(b.call('deleteExpense', { month: MONTH, row: 5 }).op, 'delete');
  const inc = b.call('getFullRecords', MONTH, 'income', true).records.find(r => r.row === 5);
  assert.throws(() => b.call('updateIncome', incomeForm({ row: 6, expect: inc })), /衝突：/, '收入同樣核對');
});

/* ------------------------------ 2. 前端合併 ------------------------------ */

function loadSubmit(b, cached) {
  const saved = [];
  const client = {
    console, saved,
    LocalCache: { getRecent: m => (cached ? cached(m) : null), saveRecent: (m, r) => saved.push([m, r]) },
    state: { mutationVersion: 0 },
    ccState: { recordsByMonth: {}, staleMonths: {} },
    Prefetch: { afterMutation() {} },
    getMonth: () => MONTH, renderRecent() {}, loadRecent() {},
  };
  vm.createContext(client);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'src/client/scripts/bookkeeping/submit.js'), 'utf8'), client);
  return client;
}

test('前端合併：不是目前月份、也沒有本機快取時，對帳頁的清單照樣跟著修改、刪除、復原更新', () => {
  const b = createBackend();
  const client = loadSubmit(b);
  client.ccState.recordsByMonth[PAST] = expensesOf(b, PAST);
  const apply = res => {
    client.handleMutationRecentUpdate(res, PAST);
    assert.deepEqual(plain(client.ccState.recordsByMonth[PAST]), expensesOf(b, PAST), res.op + ' 後和後端相同');
    assert.deepEqual(plain(client.ccState.staleMonths), {});
  };
  apply(b.call('updateExpense', expenseForm({ month: PAST, row: 7, day: 20, payment: '信用卡-測試一卡', paid: 'O', amount: 99, opId: 'cc-m-upd-1' })));
  apply(b.call('deleteExpense', { month: PAST, row: 5, opId: 'cc-m-del-1' }));
  apply(b.call('undoRecordOp', { undoOf: 'cc-m-del-1', month: PAST }));
  apply(b.call('undoRecordOp', { undoOf: 'cc-m-upd-1', month: PAST }));
  apply(b.call('addExpense', expenseForm({ month: PAST, day: 25 })));
  apply(b.call('addIncome', incomeForm({ month: PAST, day: 25 })));
});

test('前端合併：對帳頁的清單比後端舊時不硬合併，標成要重新讀取', () => {
  const b = createBackend();
  const client = loadSubmit(b);
  client.ccState.recordsByMonth[PAST] = expensesOf(b, PAST);
  b.call('addExpense', expenseForm({ month: PAST, day: 25 }));   // 另一台裝置新增，這裡不知道
  client.handleMutationRecentUpdate(b.call('deleteExpense', { month: PAST, row: 7 }), PAST);
  assert.equal(client.ccState.recordsByMonth[PAST], undefined);
  assert.equal(client.ccState.staleMonths[PAST], true);
  // 對帳頁還沒讀過的月份不處理
  client.handleMutationRecentUpdate(b.call('deleteExpense', { month: MONTH, row: 5 }), MONTH);
  assert.equal(client.ccState.recordsByMonth[MONTH], undefined);
  assert.equal(client.ccState.staleMonths[MONTH], undefined);
});

/* -------------------------------- 3. 瀏覽器 -------------------------------- */

function shiftedDate(startMs) {
  const offset = startMs - Date.now();
  return class TestDate extends Date {
    constructor(...a) { if (a.length) super(...a); else super(Date.now() + offset); }
    static now() { return Date.now() + offset; }
  };
}

/** 頁面端：固定時鐘；window.__rpcDelay 讓 google.script.run 晚一點回來。 */
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

async function idle(page, extra = 500) {
  await page.waitForFunction(() => window.__rpcInflight === 0, null, { polling: 50, timeout: 30000 });
  await page.waitForTimeout(extra);
}

async function openCreditCard(viewport) {
  const browser = await web.browser();
  const app = createDevApp({ fixture: true, quiet: true, DateCtor: shiftedDate(FIXED_NOW) });
  await new Promise(r => app.server.listen(0, '127.0.0.1', r));
  const context = await browser.newContext({ viewport: viewport || { width: 390, height: 844 }, locale: 'zh-TW', timezoneId: 'Asia/Taipei' });
  await context.addInitScript(pageInit, FIXED_NOW);
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto('http://127.0.0.1:' + app.server.address().port + '/');
  await page.waitForFunction(() => document.documentElement.classList.contains('boot-ready'), null, { timeout: 60000 });
  await idle(page);
  await page.evaluate(() => switchPage('creditcard'));
  await page.waitForSelector('#creditCardContent .cc-tx-item');
  await idle(page, 900);
  return {
    page, errors,
    rows: () => page.evaluate(() => Array.from(document.querySelectorAll('#creditCardContent .cc-tx-item'))
      .map(el => el.dataset.month + '|' + el.dataset.row + '|' + el._ccRecord.item + '|' + el._ccRecord.amount + '|' + el.querySelector('.cc-tx-amount').textContent)),
    total: () => page.evaluate(() => document.querySelector('#creditCardContent .cc-stat-val').textContent),
    /** 不經過頁面狀態直接打後端（模擬另一台裝置） */
    remote: (action, ...args) => page.evaluate(([a, p]) => Api.call(a, ...p), [action, args]),
    sheet: month => page.evaluate(m => Api.call('getFullRecords', m, 'expense', true).then(r => r.records), month),
    act: (month, row, kind) => page.locator(`#creditCardContent .cc-tx-item[data-month="${month}"][data-row="${row}"] .${kind}-btn`).click(),
    toast: () => page.evaluate(() => document.querySelector('.toast').textContent),
    close: async () => { await context.close(); await new Promise(r => app.server.close(r)); },
  };
}

const INITIAL = [
  '2026.11|12|晚餐|320|$320',
  '2026.11|9|娛樂|2860|$2,860',
  '2026.11|5|午餐|85|$85',
  '2026.10|7|午餐|150|$150',
];

test('對帳頁：修改不是目前月份的紀錄，金額與合計立即更新；復原後恢復', { skip: NO_BROWSER }, async () => {
  const s = await openCreditCard();
  try {
    const { page } = s;
    assert.deepEqual(await s.rows(), INITIAL);
    await page.evaluate(() => { window.__nodes = Array.from(document.querySelectorAll('#creditCardContent .cc-tx-item')); });
    await s.act(PAST, 7, 'edit');
    await page.waitForSelector('#editRecordModal.show');
    assert.deepEqual(await page.evaluate(() => [editState.source, editState.month, editState.row, editState.item, editState.payment, editState.paid]),
      ['creditcard', PAST, 7, '午餐', '信用卡-測試一卡', 'O']);
    await page.fill('#editRecordAmount', '180');
    await page.click('#editModalSubmitBtn');
    await idle(page);
    assert.equal((await s.rows())[3], '2026.10|7|午餐|180|$180');
    assert.equal(await s.total(), '$3,445');
    assert.equal((await s.sheet(PAST)).find(r => r.row === 7).amount, 180);
    assert.ok(await page.evaluate(() => Array.from(document.querySelectorAll('#creditCardContent .cc-tx-item')).slice(0, 3).every((el, i) => el === window.__nodes[i])), '其他列沒有重建');

    await page.click('.toast .toast-action');
    await idle(page);
    assert.deepEqual(await s.rows(), INITIAL);
    assert.equal((await s.sheet(PAST)).find(r => r.row === 7).amount, 150);
    assert.deepEqual(await page.evaluate(() => ccState.lockedMonths), {});

    // 改成現金：不再是信用卡消費，從對帳頁移走
    await s.act(PAST, 7, 'edit');
    await page.waitForSelector('#editRecordModal.show');
    await page.evaluate(() => { editState.payment = '現金'; editState.paid = ''; });
    await page.click('#editModalSubmitBtn');
    await idle(page);
    assert.deepEqual(await s.rows(), INITIAL.slice(0, 3));
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('對帳頁：刪除後同月份列號位移、沿用節點、刪除動畫播在那一列；記帳頁同步；復原插回原位', { skip: NO_BROWSER }, async () => {
  const s = await openCreditCard();
  try {
    const { page } = s;
    const original = await s.sheet(MONTH);
    await page.evaluate(() => {
      window.__nodes = Array.from(document.querySelectorAll('#creditCardContent .cc-tx-item'));
      const list = document.querySelector('#creditCardContent .cc-tx-list');
      new MutationObserver(() => { window.__leaving = window.__leaving || list.querySelector('.is-leaving'); })
        .observe(list, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    });
    await s.act(MONTH, 9, 'delete');
    await page.waitForSelector('#deleteConfirmModal.show');
    assert.match(await page.textContent('#deletePreviewDetails'), /信用卡-測試二卡｜未繳｜KTV/);
    await page.click('#deleteModalConfirmBtn');
    await idle(page, 1200);
    assert.deepEqual(await s.rows(), ['2026.11|11|晚餐|320|$320', '2026.11|5|午餐|85|$85', '2026.10|7|午餐|150|$150']);
    assert.equal(await s.total(), '$555');
    const r = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('#creditCardContent .cc-tx-item'));
      const old = window.__nodes;
      return {
        kept: rows[0] === old[0] && rows[1] === old[2] && rows[2] === old[3],
        leaving: window.__leaving === old[1], gone: !old[1].isConnected,
        recent: state.recentState.expense.fullRecords.length,
      };
    });
    assert.deepEqual(r, { kept: true, leaving: true, gone: true, recent: 7 });

    // 位移後的列號正確：標記已繳寫到對的那一筆
    await page.locator('#creditCardContent .cc-tx-item[data-row="11"] .cc-paid-btn').click();
    await idle(page);
    assert.equal((await s.sheet(MONTH)).find(x => x.item === '晚餐' && x.amount === 320).paid, 'X');
    await page.locator('#creditCardContent .cc-tx-item[data-row="11"] .cc-paid-btn').click();
    await idle(page);

    await s.act(MONTH, 5, 'delete');
    await page.waitForSelector('#deleteConfirmModal.show');
    await page.click('#deleteModalConfirmBtn');
    await idle(page, 900);
    await page.click('.toast .toast-action');
    await idle(page);
    assert.deepEqual(await s.rows(), ['2026.11|11|晚餐|320|$320', '2026.11|5|午餐|85|$85', '2026.10|7|午餐|150|$150']);
    assert.deepEqual(await s.sheet(MONTH), original.filter(x => x.row !== 9).map(x => (x.row > 9 ? Object.assign({}, x, { row: x.row - 1 }) : x)));
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('對帳頁：別台裝置已經刪過上面的紀錄時不會刪錯筆，提示衝突並重新讀取', { skip: NO_BROWSER }, async () => {
  const s = await openCreditCard();
  try {
    const { page } = s;
    await s.remote('deleteExpense', { month: MONTH, row: 6, opId: 'remote-del-01' });
    const before = await s.sheet(MONTH);
    await s.act(MONTH, 9, 'delete');
    await page.waitForSelector('#deleteConfirmModal.show');
    await page.click('#deleteModalConfirmBtn');
    await idle(page);
    assert.match(await s.toast(), /衝突：/);
    assert.deepEqual(await s.sheet(MONTH), before, '一筆都沒有刪');
    assert.equal(await page.evaluate(() => document.getElementById('deleteConfirmModal').classList.contains('show')), false);
    assert.deepEqual((await s.rows()).slice(0, 3), ['2026.11|11|晚餐|320|$320', '2026.11|8|娛樂|2860|$2,860', '2026.11|5|午餐|85|$85'], '重新讀取後列號正確');
    await s.act(MONTH, 8, 'delete');
    await page.waitForSelector('#deleteConfirmModal.show');
    await page.click('#deleteModalConfirmBtn');
    await idle(page, 900);
    assert.ok(!(await s.sheet(MONTH)).some(r => r.amount === 2860), '重新讀取後可以刪');
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('對帳頁：刪除寫入中不接受同月份的其他操作，失敗後解鎖', { skip: NO_BROWSER }, async () => {
  const s = await openCreditCard();
  try {
    const { page } = s;
    await page.evaluate(() => { window.__rpcDelay = 1500; });
    await s.act(MONTH, 9, 'delete');
    await page.waitForSelector('#deleteConfirmModal.show');
    await page.click('#deleteModalConfirmBtn');
    const blocked = await page.evaluate(() => {
      const el = sel => document.querySelector('#creditCardContent .cc-tx-item[data-row="12"] ' + sel);
      el('.cc-paid-btn').click();
      const toast = document.querySelector('.toast').textContent;
      closeDeleteModal();
      el('.edit-btn').click();
      return { toast, busy: Object.keys(ccState.busyRows).length, edit: document.getElementById('editRecordModal').classList.contains('show'), locked: ccState.lockedMonths['2026.11'] };
    });
    assert.match(blocked.toast, /正在更新/);
    assert.deepEqual([blocked.busy, blocked.edit, blocked.locked], [0, false, 1]);
    await idle(page, 900);
    assert.deepEqual(await page.evaluate(() => ccState.lockedMonths), {});
    assert.equal((await s.rows()).length, 3);

    // 標記已繳寫入中：同月份不能修改／刪除
    await page.evaluate(() => document.querySelector('#creditCardContent .cc-tx-item[data-row="5"] .cc-paid-btn').click());
    assert.equal(await page.evaluate(() => {
      document.querySelector('#creditCardContent .cc-tx-item[data-row="11"] .delete-btn').click();
      return document.getElementById('deleteConfirmModal').classList.contains('show');
    }), false);
    await idle(page);

    // 後端失敗（非衝突）：視窗留著可以重試，月份解鎖
    await page.evaluate(() => { window.__rpcDelay = 0; });
    await s.act(MONTH, 5, 'edit');
    await page.waitForSelector('#editRecordModal.show');
    await page.evaluate(() => { editState.item = '不存在的項目'; });
    await page.click('#editModalSubmitBtn');
    await idle(page);
    assert.deepEqual(await page.evaluate(() => [document.getElementById('editRecordModal').classList.contains('show'), ccState.lockedMonths, document.getElementById('editModalSubmitBtn').disabled]), [true, {}, false]);
    assert.deepEqual(s.errors, []);
  } finally { await s.close(); }
});

test('對帳頁排版：手機與桌機都不橫向溢出；已繳鈕展開時不蓋到修改／刪除', { skip: NO_BROWSER }, async () => {
  for (const viewport of [{ width: 320, height: 700 }, { width: 390, height: 844 }, { width: 1280, height: 900 }]) {
    const s = await openCreditCard(viewport);
    try {
      const { page } = s;
      const row = page.locator('#creditCardContent .cc-tx-item').nth(1);
      await row.locator('.cc-paid-btn').hover();
      await page.waitForTimeout(500);
      const r = await row.evaluate(el => {
        const card = el.closest('.cc-tx-card').getBoundingClientRect();
        const inside = Array.from(el.querySelectorAll('button')).every(b => {
          const q = b.getBoundingClientRect();
          return q.left >= card.left && q.right <= card.right;
        });
        const hit = Array.from(el.querySelectorAll('.recent-act-btn')).every(b => {
          const q = b.getBoundingClientRect();
          const top = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2);
          return top && top.closest('.recent-act-btn') === b;
        });
        return { inside, hit, overflow: document.documentElement.scrollWidth > window.innerWidth, name: el.querySelector('.cc-tx-main').getBoundingClientRect().width };
      });
      assert.ok(r.inside && r.hit && !r.overflow, viewport.width + '：' + JSON.stringify(r));
      assert.ok(r.name >= 80, viewport.width + '：項目欄至少 80px，實際 ' + r.name);
      assert.deepEqual(s.errors, []);
    } finally { await s.close(); }
  }
});
