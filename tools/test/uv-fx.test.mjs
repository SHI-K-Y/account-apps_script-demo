// 合成器圖層標記（P02）：送出鈕外框流光與卡片旋轉光環改由真實元素（core/uv-fx.js）負責，
// 建立元件時沒有插入就完全看不到效果。這裡檢查每個建立點都有帶上標記。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, browserTests } from './helpers.mjs';

// 沒有 Chromium 時略過（原因會提示安裝方式）；REQUIRE_BROWSER=1 時改為失敗。瀏覽器由 browserTests() 在檔案結束時關閉。
const web = await browserTests();

const CLIENT = path.join(ROOT, 'src', 'client');
const read = rel => fs.readFileSync(path.join(CLIENT, rel), 'utf8');

function walk(dir, ext) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full, ext));
    else if (e.name.endsWith(ext)) out.push(full);
  }
  return out;
}
const rel = f => path.relative(CLIENT, f);
const lineOf = (text, i) => text.slice(0, i).split('\n').length;

test('UvFx：每個 .submit-btn 一建立就帶著外框流光圖層（.uv-btn-ring）', () => {
  const missing = [];
  for (const f of walk(CLIENT, '.html')) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/<button\b[^>]*\bclass="(?:[^"]*\s)?submit-btn(?:\s[^"]*)?"[^>]*>/g)) {
      if (!text.startsWith('<span class="uv-btn-ring" aria-hidden="true"><span></span></span>', m.index + m[0].length)) missing.push(rel(f) + ':' + lineOf(text, m.index));
    }
  }
  for (const f of walk(path.join(CLIENT, 'scripts'), '.js')) {
    const text = fs.readFileSync(f, 'utf8');
    for (const m of text.matchAll(/<button\b[^>]*\bclass="(?:[^"]*\s)?submit-btn(?:\s[^"]*)?"[^>]*>/g)) {
      if (!/^'\s*\+\s*UvFx\.btnRing\b/.test(text.slice(m.index + m[0].length))) missing.push(rel(f) + ':' + lineOf(text, m.index));
    }
  }
  assert.deepEqual(missing, []);
});

test('UvFx：會套旋轉光環的卡片一建立就帶著 .uv-ring', () => {
  const html = read('pages/bookkeeping.html');
  assert.match(html, /id="todayExpenseCard">\s*<span class="uv-ring" aria-hidden="true"><span><\/span><\/span>/);

  // 總覽頁（含支出分析與預算卡）與國外帳簿統計頁：所有 .ov-hero／.ov-card／.fx-stat-card（.oc-error 不套光環）
  const files = ['scripts/pages/overview.js', 'scripts/charts/overview-charts.js', 'scripts/budget/budget-view.js', 'scripts/pages/foreign.js'];
  const missing = [];
  let found = 0;
  for (const f of files) {
    const text = read(f);
    // class 屬性一路取到引號為止（budget-view 的 is-over 是 '...oc-budget' + (…) + '">' 這種接法）
    for (const m of text.matchAll(/<div class="([^"']*)/g)) {
      const classes = m[1].split(/\s+/);
      if (!classes.some(c => c === 'ov-hero' || c === 'ov-card' || c === 'fx-stat-card') || classes.includes('oc-error')) continue;
      found++;
      // 開始標籤結束（第一個 >）之後，緊接著就要串上 UvFx.cardRing
      const rest = text.slice(m.index);
      const close = rest.indexOf('>');
      if (!/^'\s*\+\s*UvFx\.cardRing\b/.test(rest.slice(close + 1))) missing.push(f + ':' + lineOf(text, m.index));
    }
  }
  assert.ok(found >= 15, '找到的卡片建立點太少（' + found + '），比對的寫法可能已經改變');
  assert.deepEqual(missing, []);
});

test('UvFx：helper 重複呼叫不會插入第二個圖層', () => {
  const src = read('scripts/core/uv-fx.js');
  const UvFx = new Function(src + '\nreturn UvFx;')();
  const made = [];
  const el = {
    firstElementChild: null,
    insertAdjacentHTML(pos, html) {
      assert.equal(pos, 'afterbegin');
      made.push(html);
      const cls = html.match(/class="([^"]+)"/)[1];
      this.firstElementChild = { classList: { contains: c => c === cls }, nextElementSibling: this.firstElementChild };
    },
  };
  UvFx.ensureCardRing(el);
  UvFx.ensureCardRing(el);
  UvFx.ensureBtnRing(el);
  UvFx.ensureBtnRing(el);
  assert.deepEqual(made, [UvFx.cardRing, UvFx.btnRing]);
  assert.match(UvFx.cardRing, /^<span class="uv-ring" aria-hidden="true"><span><\/span><\/span>$/);
  assert.match(UvFx.btnRing, /^<span class="uv-btn-ring" aria-hidden="true"><span><\/span><\/span>$/);
});

// 記帳頁的項目、總類、支付方式（含轉帳）、是否已繳、金額鍵盤：套上常用組合同款的玻璃板（UvFx.glassChip），
// 顏色不變；彈窗與其他頁面的選項不套。

test('UvFx：記帳頁的選項按鈕與金額鍵盤帶著玻璃板，文字不變；滑鼠移動時依位置傾斜；彈窗裡的選項不套', { skip: web.skip }, async () => {
  const { createDevApp } = await import('../dev-server.mjs');
  // 先拿到瀏覽器再開伺服器：啟動失敗時沒有東西要收；之後任何一步失敗都在 finally 關掉頁面與伺服器。
  const browser = await web.browser();
  const app = createDevApp({ fixture: true, quiet: true });
  let page = null;
  try {
    await new Promise((resolve, reject) => { app.server.once('error', reject); app.server.listen(0, '127.0.0.1', resolve); });
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await page.goto('http://127.0.0.1:' + app.server.address().port + '/');
    await page.waitForSelector('#expenseItemChoices .choice');
    // 選一張信用卡，「是否已繳」才會出現
    await page.evaluate(() => {
      const credit = Array.from(document.querySelectorAll('#paymentChoices .choice')).find(b => isCreditCardPayment(b.dataset.value));
      credit.click();
    });
    await page.waitForSelector('#paidChoices .choice');
    const report = await page.evaluate(() => {
      const ids = ['expenseItemChoices', 'incomeItemChoices', 'expenseCategoryChoices', 'incomeCategoryChoices', 'paymentChoices', 'paidChoices', 'expenseKeypad', 'incomeKeypad'];
      const bad = [];
      const counts = {};
      ids.forEach(id => {
        const buttons = document.querySelectorAll('#' + id + ' :is(.choice, .key)');
        counts[id] = buttons.length;
        buttons.forEach(b => {
          const first = b.firstElementChild;
          if (!b.classList.contains('uv-glass-chip') || !first || !first.classList.contains('uv-glass-plate')) bad.push(id + ':' + b.textContent);
          if (b.querySelector('.uv-combo-touch, .uv-combo-ch')) bad.push(id + ' 首屏不該有感應區或逐字 span：' + b.textContent);
          if (b.querySelectorAll('.uv-glass-plate').length !== 1) bad.push(id + ' 重複：' + b.textContent);
        });
      });
      const texts = Array.from(document.querySelectorAll('#paidChoices .choice')).map(b => b.textContent);
      const keys = Array.from(document.querySelectorAll('#expenseKeypad .key')).map(b => b.getAttribute('aria-label') + '=' + b.textContent);
      const modal = document.querySelectorAll('#editItemChoices .uv-glass-chip, #comboItemChoices .uv-glass-chip, .date-quick-btns .uv-glass-chip').length;
      return { bad, counts, texts, keys, modal };
    });
    assert.deepEqual(report.bad, []);
    Object.entries(report.counts).forEach(([id, n]) => assert.ok(n > 0, id + ' 沒有按鈕'));
    assert.deepEqual(report.texts, ['已繳', '未繳']);
    assert.deepEqual(report.keys.slice(0, 3), ['1=1', '2=2', '3=3']);
    assert.ok(report.keys.includes('null=清除金額'));
    assert.equal(report.modal, 0);

    // 滑鼠在按鈕左端 → 第 0 段（往左傾）、右端 → 第 7 段；第一次移上去才拆字；移開後放平
    const key = page.locator('#expenseKeypad .key[aria-label="5"]');
    await key.scrollIntoViewIfNeeded();
    const box = await key.boundingBox();
    // 開機畫面淡出之後滑鼠才碰得到按鈕
    await page.waitForFunction(([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return Boolean(el && el.closest('#expenseKeypad'));
    }, [box.x + 4, box.y + box.height / 2], { timeout: 60000 });
    const probe = () => key.evaluate(b => [b.classList.contains('is-tilting'), b.style.getPropertyValue('--uv-glass-k'), b.querySelectorAll('.uv-combo-ch').length, b.textContent].join('|'));
    await page.mouse.move(box.x + 2, box.y + box.height / 2);
    await page.mouse.move(box.x + 4, box.y + box.height / 2);
    assert.equal(await probe(), 'true|0|1|5');
    await page.mouse.move(box.x + box.width - 3, box.y + box.height / 2);
    assert.equal(await probe(), 'true|7|1|5');
    await page.mouse.move(2, 2);
    assert.match(await probe(), /^false\|/);
  } finally {
    if (page) await page.close().catch(() => {});
    if (app.server.listening) await new Promise(r => app.server.close(() => r()));
  }
});
