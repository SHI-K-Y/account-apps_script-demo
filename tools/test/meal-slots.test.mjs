// 時段建議測試：後端的儲存／驗證／改名連動，以及前端判斷「現在該建議哪個項目」的邏輯（core/env.js 的 MealSlots）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createBackend, ROOT } from './helpers.mjs';

const slots = (...list) => list.map(([item, start, end]) => ({ item, start, end }));
const savedMeta = b => b.call('getSettingsOptions', true).metadata;

/** 在沙盒裡執行 env.js，取出 MealSlots；metadata 模擬 settingsState.metadata。 */
function loadMealSlots(metadata) {
  const stub = { style: { setProperty() {} }, clientWidth: 0 };
  const ctx = {
    window: { innerWidth: 0, addEventListener() {} },
    document: { documentElement: stub, querySelectorAll: () => [], createElement: () => ({}), head: { appendChild() {} } },
    settingsState: { metadata: metadata || null },
  };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(ROOT, 'src/client/scripts/core/env.js'), 'utf8');
  vm.runInContext(src + '\nthis.MealSlots = MealSlots;', ctx);
  return ctx.MealSlots;
}
const at = (hh, mm) => new Date(2026, 10, 13, hh, mm);
const ITEMS = ['早餐', '午餐', '點心', '晚餐', '宵夜'];

test('時段建議（前端）：沒有設定時沿用原本的預設時段，邊界時間正確', () => {
  const M = loadMealSlots(null);
  assert.equal(M.config().custom, false);
  assert.equal(M.match(at(4, 59), ITEMS), '');
  assert.equal(M.match(at(5, 0), ITEMS), '早餐');
  assert.equal(M.match(at(10, 29), ITEMS), '早餐');
  assert.equal(M.match(at(10, 30), ITEMS), '午餐');
  assert.equal(M.match(at(14, 29), ITEMS), '午餐');
  assert.equal(M.match(at(14, 30), ITEMS), '點心');
  assert.equal(M.match(at(17, 0), ITEMS), '晚餐');
  assert.equal(M.match(at(21, 59), ITEMS), '晚餐');
  assert.equal(M.match(at(22, 0), ITEMS), '');
  assert.equal(M.match(at(12, 0), ['早餐', '晚餐']), '', '項目不存在就不建議');
});

test('時段建議（前端）：自訂時段、跨午夜與停用', () => {
  const M = loadMealSlots({ mealSlots: { enabled: true, slots: slots(['午餐', '11:00', '13:00'], ['宵夜', '22:00', '01:59']) } });
  assert.equal(M.config().custom, true);
  assert.equal(M.match(at(10, 59), ITEMS), '');
  assert.equal(M.match(at(11, 0), ITEMS), '午餐');
  assert.equal(M.match(at(13, 1), ITEMS), '');
  assert.equal(M.match(at(23, 30), ITEMS), '宵夜');
  assert.equal(M.match(at(0, 30), ITEMS), '宵夜');
  assert.equal(M.match(at(2, 0), ITEMS), '');

  const off = loadMealSlots({ mealSlots: { enabled: false, slots: slots(['午餐', '11:00', '13:00']) } });
  assert.equal(off.match(at(12, 0), ITEMS), '');

  const empty = loadMealSlots({ mealSlots: { enabled: true, slots: [] } });
  assert.equal(empty.match(at(12, 0), ITEMS), '', '使用者刪光時段就不建議（不會退回預設值）');
});

test('時段建議（後端）：儲存後寫進設定資料，重新讀取仍在', () => {
  const b = createBackend();
  assert.equal(savedMeta(b).mealSlots, undefined, '預設沒有存任何東西');

  const res = b.call('saveMealSlots', { enabled: true, slots: slots(['午餐', '11:00', '13:30'], ['晚餐', '18:00', '20:00']) });
  assert.equal(res.ok, true);
  assert.deepEqual(res.metadata.mealSlots.slots, slots(['午餐', '11:00', '13:30'], ['晚餐', '18:00', '20:00']));
  assert.equal(savedMeta(b).mealSlots.enabled, true);

  b.call('saveMealSlots', { enabled: false, slots: slots(['午餐', '11:00', '13:30']) });
  assert.equal(savedMeta(b).mealSlots.enabled, false);
  assert.equal(savedMeta(b).mealSlots.slots.length, 1);

  b.call('saveMealSlots', { enabled: true, slots: slots(['晚餐', '22:00', '01:00']) });
  assert.equal(savedMeta(b).mealSlots.slots[0].start, '22:00', '跨午夜可以存');

  b.call('saveMealSlots', { reset: true, slots: [] });
  assert.equal(savedMeta(b).mealSlots, undefined, '恢復預設會移除設定');

  const quick = b.call('saveQuickCombos', [{ type: 'expense', title: '早餐店', item: '早餐', category: '生活費', payment: '現金', paid: '', amount: '65' }]);
  assert.ok(quick.metadata.quickCombos.length, '不影響常用組合');
});

test('時段建議（後端）：擋下格式錯誤、重疊與不存在的項目', () => {
  const b = createBackend();
  const save = list => b.call('saveMealSlots', { enabled: true, slots: list });
  assert.throws(() => b.call('saveMealSlots', { enabled: true }), /格式錯誤/);
  assert.throws(() => save(slots(['', '11:00', '12:00'])), /請選擇支出項目/);
  assert.throws(() => save(slots(['拉麵', '11:00', '12:00'])), /支出項目/);
  assert.throws(() => save(slots(['午餐', '11:0', '12:00'])), /HH:MM/);
  assert.throws(() => save(slots(['午餐', '24:00', '12:00'])), /HH:MM/);
  assert.throws(() => save(slots(['午餐', '12:00', '12:00'])), /不能相同/);
  assert.throws(() => save(slots(['午餐', '11:00', '13:00'], ['晚餐', '13:00', '19:00'])), /重疊/);
  assert.throws(() => save(slots(['晚餐', '21:00', '02:00'], ['早餐', '01:30', '09:00'])), /重疊/);
  assert.throws(() => save(Array.from({ length: 13 }, (_, i) => ({ item: '午餐', start: String(i).padStart(2, '0') + ':00', end: String(i).padStart(2, '0') + ':30' }))), /最多 12/);
  assert.equal(savedMeta(b).mealSlots, undefined, '失敗時不會寫入');
});

test('時段建議（後端）：支出項目改名會跟著改，已刪除的項目可以原樣保留', () => {
  const b = createBackend();
  b.call('saveMealSlots', { enabled: true, slots: slots(['午餐', '11:00', '13:30']) });
  const row = b.call('getSettingsOptions', true).expenseItems.find(o => o.value === '午餐').row;
  b.call('saveSettingsItemWithEmoji', { category: 'expenseItems', name: '中餐', row });
  assert.equal(savedMeta(b).mealSlots.slots[0].item, '中餐');

  // 「中餐」被刪掉之後，其他時段照樣能存（舊的那一列原樣保留，前端會標示「已不存在」）
  const row2 = b.call('getSettingsOptions', true).expenseItems.find(o => o.value === '中餐').row;
  b.call('deleteSettingsOption', 'expenseItems', row2);
  const res = b.call('saveMealSlots', { enabled: true, slots: slots(['中餐', '11:00', '13:30'], ['晚餐', '18:00', '20:00']) });
  assert.equal(res.metadata.mealSlots.slots.length, 2);
});
