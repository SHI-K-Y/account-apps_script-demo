// 項目按鈕自訂顏色：後端 itemColors 的儲存／改名／刪除連動與驗證，前端 getItemCategory 的覆蓋邏輯，
// 以及色板（core/icons.js 的 ITEM_COLOR_PALETTE）和後端白名單、CSS 變數三者一致。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createBackend, ROOT } from './helpers.mjs';

const savedMeta = b => b.call('getSettingsOptions', true).metadata;
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 在沙盒裡執行 item-defaults.js＋icons.js；metadata 模擬 settingsState.metadata。 */
function loadIcons(metadata) {
  const ctx = { settingsState: { metadata: metadata || null }, document: { getElementById: () => null } };
  vm.createContext(ctx);
  vm.runInContext(read('src/client/scripts/core/item-defaults.js') + '\n' + read('src/client/scripts/core/icons.js') +
    '\nthis.api = { getItemCategory, getAutoItemCategory, isItemColorKey, ITEM_COLOR_PALETTE };', ctx);
  return ctx.api;
}

test('項目顏色（後端）：新增時帶顏色、改名沿用、改回自動、刪除時一併移除', () => {
  const b = createBackend();
  const added = b.call('saveSettingsItemWithEmoji', { category: 'expenseItems', name: '拉麵', emoji: 'ph:bowl-steam', color: 'entertainment', position: 'top' });
  assert.equal(added.color, 'entertainment');
  assert.equal(added.metadata.itemColors['拉麵'], 'entertainment');
  assert.equal(savedMeta(b).itemColors['拉麵'], 'entertainment', '存進 settings metadata');

  // 只改圖示（沒帶 color）不會清掉顏色
  b.call('saveSettingsItemWithEmoji', { category: 'expenseItems', row: 2, name: '拉麵', emoji: 'ph:bowl-food' });
  assert.equal(savedMeta(b).itemColors['拉麵'], 'entertainment');

  // 改名：顏色跟著新名稱走，舊名稱的設定移除
  b.call('saveSettingsItemWithEmoji', { category: 'expenseItems', row: 2, name: '豚骨拉麵', emoji: 'ph:bowl-food' });
  let meta = savedMeta(b);
  assert.equal(meta.itemColors['豚骨拉麵'], 'entertainment');
  assert.equal(meta.itemColors['拉麵'], undefined);

  // 行內改名（updateSettingsOption）也一樣
  b.call('updateSettingsOption', 'expenseItems', 2, '味噌拉麵');
  meta = savedMeta(b);
  assert.equal(meta.itemColors['味噌拉麵'], 'entertainment');
  assert.equal(meta.itemColors['豚骨拉麵'], undefined);

  // 空字串＝改回自動
  b.call('saveSettingsItemWithEmoji', { category: 'expenseItems', row: 2, name: '味噌拉麵', emoji: 'ph:bowl-food', color: 'salary' });
  assert.equal(savedMeta(b).itemColors['味噌拉麵'], 'salary');
  b.call('saveSettingsItemWithEmoji', { category: 'expenseItems', row: 2, name: '味噌拉麵', emoji: 'ph:bowl-food', color: '' });
  assert.equal(savedMeta(b).itemColors['味噌拉麵'], undefined);

  // 刪除項目時顏色一起移除
  b.call('saveSettingsItemWithEmoji', { category: 'expenseItems', row: 2, name: '味噌拉麵', emoji: 'ph:bowl-food', color: 'finance' });
  const del = b.call('deleteSettingsItemWithEmoji', { category: 'expenseItems', row: 2 });
  assert.equal(del.metadata.itemColors['味噌拉麵'], undefined);
  assert.equal(savedMeta(b).itemColors['味噌拉麵'], undefined);
});

test('項目顏色（後端）：不在色板內的顏色會被拒絕，而且試算表不會被改動', () => {
  const b = createBackend();
  const before = b.sheet('資料選單設定區').getRange('B2').getValue();
  assert.throws(
    () => b.call('saveSettingsItemWithEmoji', { category: 'expenseItems', name: '拉麵', emoji: 'ph:bowl-steam', color: '#ff0000', position: 'top' }),
    /不支援的項目顏色/
  );
  assert.equal(b.sheet('資料選單設定區').getRange('B2').getValue(), before);
  assert.deepEqual(savedMeta(b).itemColors || {}, {});
});

test('項目顏色（前端）：自訂顏色覆蓋自動判斷，含開頭 emoji 的名稱也查得到，不合法的值被忽略', () => {
  const plain = loadIcons(null);
  assert.equal(plain.getItemCategory('早餐'), 'food');
  assert.equal(plain.getItemCategory('火車票'), 'transport');

  const api = loadIcons({ itemColors: { '早餐': 'entertainment', '火車票': 'not-a-color', '咖啡': 'salary' } });
  assert.equal(api.getItemCategory('早餐'), 'entertainment');
  assert.equal(api.getAutoItemCategory('早餐'), 'food', '自動判斷不受自訂顏色影響');
  assert.equal(api.getItemCategory('☕咖啡'), 'salary', '名稱前有 emoji 時用純文字名稱查');
  assert.equal(api.getItemCategory('火車票'), 'transport', '不合法的顏色值回到自動判斷');
  assert.equal(api.isItemColorKey('food'), true);
  assert.equal(api.isItemColorKey('travel'), false, '色相重複的類別不在色板內');
});

test('項目顏色：前端色板、後端白名單與 CSS 變數一致（淺色／深色都有定義）', () => {
  const keys = Array.from(loadIcons(null).ITEM_COLOR_PALETTE, c => c.key);
  assert.ok(keys.length >= 8);
  assert.equal(new Set(keys).size, keys.length, '色板 key 不重複');

  const server = read('src/server/53_settings_items.gs');
  const m = server.match(/const ITEM_COLOR_KEYS_ = \[([^\]]*)\]/);
  assert.ok(m, '後端有 ITEM_COLOR_KEYS_');
  const serverKeys = m[1].split(',').map(s => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
  assert.deepEqual(serverKeys, keys);

  const css = fs.readdirSync(path.join(ROOT, 'src/client/styles')).map(f => read('src/client/styles/' + f)).join('\n');
  const tokens = read('src/client/styles/01-tokens-base.css');
  const choices = read('src/client/styles/04-entry-choices.css');
  keys.forEach(key => {
    ['ink', 'bg', 'bg-selected', 'border'].forEach(part => {
      const count = (css.match(new RegExp('--cat-' + key + '-' + part + '\\s*:', 'g')) || []).length;
      assert.ok(count >= 2, '--cat-' + key + '-' + part + ' 要在淺色與深色主題各有定義（找到 ' + count + ' 個）');
    });
    assert.ok(tokens.includes('--cat-' + key + '-bg:'), key + ' 的底色在 tokens 定義');
    assert.ok(choices.includes('.choice[data-cat="' + key + '"]'), key + ' 有項目按鈕樣式');
  });
});
