// 安全性測試：API 閘道、存取控制、HTTP API 權杖、文件鎖。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBackend, expenseForm } from './helpers.mjs';

test('閘道只接受登記過的操作，私有函式無法被呼叫', () => {
  const b = createBackend();
  ['getSpreadsheet_', 'setup', 'rebuildAllSummaries', 'constructor', '__proto__', 'toString', '', 42, null].forEach(action => {
    assert.throws(() => b.fns.api({ action, args: [] }), /不支援的操作/);
  });
  assert.throws(() => b.fns.api(null), /請求格式錯誤/);
  assert.throws(() => b.fns.api({ action: 'getInitialData', args: 'x' }), /請求參數格式錯誤/);
  assert.throws(() => b.fns.api({ action: 'getInitialData', args: new Array(20).fill(1) }), /請求參數格式錯誤/);
});

test('瀏覽器可直接呼叫的函式只有進入點與管理工具', () => {
  const b = createBackend();
  const publicNames = Object.keys(b.fns).filter(name => !name.endsWith('_') && !name.startsWith('__')).sort();
  // warmCaches（P11）：時間觸發器的處理函式不能以底線結尾；它自己會擋掉非觸發器、非擁有者的呼叫（見 cache-first.test.mjs）
  assert.deepEqual(publicNames, ['api', 'doGet', 'doPost', 'include', 'onEdit', 'rebuildAllSummaries', 'runDebugCompareChartsSummary', 'setup', 'setupAppIcon', 'warmCaches']);
});

test('管理工具只有擁有者能執行', () => {
  const stranger = createBackend({ activeUserEmail: 'someone@example.com' });
  ['setup', 'setupAppIcon', 'rebuildAllSummaries', 'runDebugCompareChartsSummary'].forEach(name => {
    assert.throws(() => stranger.fns[name](), /只能由試算表擁有者/);
  });
  const anonymous = createBackend({ activeUserEmail: '' });
  assert.throws(() => anonymous.fns.setup(), /只能由試算表擁有者/);
  const owner = createBackend();
  assert.equal(owner.fns.setup().ok, true);
});

test('include() 只能載入固定的幾個檔案', () => {
  const b = createBackend();
  assert.ok(b.fns.include('style').startsWith('<style>'));
  assert.throws(() => b.fns.include('Index'), /不允許載入/);
  assert.throws(() => b.fns.include('../code'), /不允許載入/);
});

test('未設定 ALLOWED_EMAILS：維持原本行為（不額外限制）', () => {
  const b = createBackend({ activeUserEmail: '' });
  assert.ok(b.call('getInitialData', true).months.length);
  assert.match(b.fns.doGet().getContent(), /window\.__INITIAL_DATA__/);
});

test('設定 ALLOWED_EMAILS：名單外與未登入者看不到頁面、也不能呼叫 API', () => {
  const properties = { ALLOWED_EMAILS: 'friend@example.com, Partner@Example.com' };
  for (const email of ['stranger@example.com', '']) {
    const b = createBackend({ properties, activeUserEmail: email });
    assert.throws(() => b.call('getInitialData', true), /沒有存取權限/);
    assert.throws(() => b.call('addExpense', expenseForm({})), /沒有存取權限/);
    const html = b.fns.doGet().getContent();
    assert.match(html, /沒有存取權限/);
    assert.doesNotMatch(html, /__INITIAL_DATA__/, '拒絕頁不可夾帶任何帳務資料');
  }
  const partner = createBackend({ properties, activeUserEmail: 'partner@example.com' });
  assert.ok(partner.call('addExpense', expenseForm({})).ok);
  const owner = createBackend({ properties });
  assert.ok(owner.call('getInitialData', true).months.length, '擁有者不必列在名單內');
});

test('HTTP API：預設關閉', () => {
  const b = createBackend();
  assert.deepEqual(b.post({ token: 'anything', action: 'getInitialData', args: [true] }), { ok: false, error: 'HTTP API 尚未啟用。' });
});

test('HTTP API：權杖驗證、唯讀權杖、錯誤格式', () => {
  const WRITE = 'w'.repeat(32);
  const READ = 'r'.repeat(32);
  const b = createBackend({ properties: { API_TOKEN: WRITE, API_READ_TOKEN: READ } });

  const ok = b.post({ token: WRITE, action: 'addExpense', args: [expenseForm({})] });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.row, 13);

  assert.equal(b.post({ token: READ, action: 'getFullRecords', args: ['2026.11', 'expense', false] }).data.records.length, 9);
  assert.deepEqual(b.post({ token: READ, action: 'addExpense', args: [expenseForm({})] }), { ok: false, error: '這個權杖只能讀取資料。' });
  assert.deepEqual(b.post({ token: 'nope', action: 'getInitialData' }), { ok: false, error: '權杖錯誤。' });
  assert.deepEqual(b.post({ action: 'getInitialData' }), { ok: false, error: '權杖錯誤。' });
  assert.deepEqual(b.post('not json'), { ok: false, error: '請求內容必須是 JSON。' });
  assert.match(b.post({ token: WRITE, action: 'setup' }).error, /不支援的操作/);
  assert.match(b.post({ token: WRITE, action: 'addExpense', args: [expenseForm({ amount: 0 })] }).error, /金額必須是大於 0/);
  assert.equal(b.sheet('2026.11').getRange('B14').getValue(), '', '被拒絕的請求不會寫入資料');
});

test('HTTP API：太短的權杖不生效，連續猜錯會暫時鎖定', () => {
  const short = createBackend({ properties: { API_TOKEN: 'short' } });
  assert.deepEqual(short.post({ token: 'short', action: 'getInitialData' }), { ok: false, error: '權杖錯誤。' });

  const TOKEN = 't'.repeat(24);
  const b = createBackend({ properties: { API_TOKEN: TOKEN } });
  for (let i = 0; i < 10; i++) assert.equal(b.post({ token: 'guess-' + i, action: 'getInitialData' }).error, '權杖錯誤。');
  assert.deepEqual(b.post({ token: TOKEN, action: 'getInitialData' }), { ok: false, error: '驗證失敗次數過多，請稍後再試。' });
});

test('文件鎖可巢狀使用：內層結束時不會提早解鎖', () => {
  const b = createBackend();
  const lock = b.runtime.globals.LockService.getDocumentLock();
  let heldInside = null;
  let heldAfterInner = null;
  b.fns.withDocumentLock_(() => {
    b.fns.withDocumentLock_(() => { heldInside = lock.hasLock(); });
    heldAfterInner = lock.hasLock();
  });
  assert.equal(heldInside, true);
  assert.equal(heldAfterInner, true, '內層結束後外層仍持有鎖');
  assert.equal(lock.hasLock(), false, '最外層結束後才解鎖');
  assert.throws(() => b.fns.withDocumentLock_(() => { throw new Error('boom'); }), /boom/);
  assert.equal(lock.hasLock(), false, '發生例外也會解鎖');
});
