// 記帳提醒測試：前端判斷「現在該不該提醒」的規則（core/reminders.js 的 RecordReminders），
// 以及後端的儲存／驗證／改名連動（57_settings_reminders.gs）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createBackend, ROOT, DIST } from './helpers.mjs';

/** 在沙盒裡執行 reminders.js，取出 RecordReminders；metadata 模擬 settingsState.metadata。 */
function loadRules(metadata) {
  const ctx = { settingsState: { metadata: metadata || null } };
  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(ROOT, 'src/client/scripts/core/reminders.js'), 'utf8');
  vm.runInContext(src + '\nthis.RecordReminders = RecordReminders;', ctx);
  return ctx.RecordReminders;
}

// 2026-11-13 是星期五
const at = (day, hh, mm) => new Date(2026, 10, day, hh, mm);
const ITEMS = { expense: ['早餐', '午餐', '晚餐', '房租'], income: ['薪資', '其他'] };
const rec = (day, item) => ({ day, item });
const NONE = { expense: [], income: [] };
const lunch = over => Object.assign({ id: 'a', enabled: true, type: 'expense', item: '午餐', repeat: 'daily', time: '13:00' }, over);
const metaOf = (...reminders) => ({ recordReminders: { enabled: true, reminders } });

function stateOf(R, reminder, now, records) {
  const r = R.config(metaOf(reminder)).reminders[0];
  return R.status(r, { now, records, items: ITEMS }).state;
}

test('記帳提醒（前端）：每天——過了時間、今天還沒記才提醒', () => {
  const R = loadRules(null);
  assert.equal(R.config(null).reminders.length, 0, '沒有設定就沒有提醒');

  assert.equal(stateOf(R, lunch(), at(13, 12, 59), NONE), 'pending');
  assert.equal(stateOf(R, lunch(), at(13, 13, 0), NONE), 'due');
  assert.equal(stateOf(R, lunch(), at(13, 21, 0), { expense: [rec(13, '午餐')], income: [] }), 'done');
  assert.equal(stateOf(R, lunch(), at(13, 14, 0), { expense: [rec(12, '午餐'), rec(13, '晚餐')], income: [] }), 'due', '昨天的午餐、今天的晚餐都不算');
  assert.equal(stateOf(R, lunch(), at(13, 14, 0), { expense: [rec('13', ' 午餐 ')], income: [] }), 'done', '日期是字串、項目前後有空白也認得');
  assert.equal(stateOf(R, lunch(), at(13, 14, 0), null), 'unknown', '沒有當月資料就不判斷');
  assert.equal(stateOf(R, lunch({ enabled: false }), at(13, 14, 0), NONE), 'off');
  assert.equal(stateOf(R, lunch({ item: '拉麵' }), at(13, 14, 0), NONE), 'missing', '項目已刪除就不提醒');
});

test('記帳提醒（前端）：每週——只在勾選的星期提醒', () => {
  const R = loadRules(null);
  const weekdays = lunch({ repeat: 'weekly', weekdays: [1, 2, 3, 4, 5] });
  assert.equal(stateOf(R, weekdays, at(13, 13, 30), NONE), 'due', '星期五');
  assert.equal(stateOf(R, weekdays, at(14, 13, 30), NONE), 'idle', '星期六');
  assert.equal(stateOf(R, weekdays, at(13, 13, 30), { expense: [rec(13, '午餐')], income: [] }), 'done');
  const weekend = lunch({ repeat: 'weekly', weekdays: [6, 0] });
  assert.equal(stateOf(R, weekend, at(13, 13, 30), NONE), 'idle');
  assert.equal(stateOf(R, weekend, at(15, 13, 30), NONE), 'due', '星期日');
});

test('記帳提醒（前端）：每月——設定日起看整個月，提醒到月底', () => {
  const R = loadRules(null);
  const rent = lunch({ item: '房租', repeat: 'monthly', monthDay: 5, time: '09:00' });
  assert.equal(stateOf(R, rent, at(4, 23, 0), NONE), 'idle', '還沒到設定日');
  assert.equal(stateOf(R, rent, at(5, 8, 59), NONE), 'pending');
  assert.equal(stateOf(R, rent, at(5, 9, 0), NONE), 'due');
  assert.equal(stateOf(R, rent, at(20, 8, 0), NONE), 'due', '設定日之後打開仍會提醒');
  assert.equal(stateOf(R, rent, at(20, 8, 0), { expense: [rec(2, '房租')], income: [] }), 'done', '月初就先記好也算');

  const endOfMonth = lunch({ item: '房租', repeat: 'monthly', monthDay: 31, time: '10:00' });
  assert.equal(stateOf(R, endOfMonth, at(29, 12, 0), NONE), 'idle', '11 月只有 30 天');
  assert.equal(stateOf(R, endOfMonth, at(30, 10, 0), NONE), 'due', '以月底為準');

  const salary = { id: 's', enabled: true, type: 'income', item: '薪資', repeat: 'monthly', monthDay: 5, time: '09:00' };
  assert.equal(stateOf(R, salary, at(13, 9, 0), { expense: [rec(5, '薪資')], income: [] }), 'due', '收入看收入的紀錄');
  assert.equal(stateOf(R, salary, at(13, 9, 0), { expense: [], income: [rec(5, '薪資')] }), 'done');
});

test('記帳提醒（前端）：due() 排序、同項目合併、總開關與略過', () => {
  const reminders = [
    lunch({ id: 'l1', time: '13:00' }),
    lunch({ id: 'l2', time: '12:00', repeat: 'weekly', weekdays: [5] }),
    { id: 'b', enabled: true, type: 'expense', item: '早餐', repeat: 'daily', time: '10:00' },
    { id: 'd', enabled: true, type: 'expense', item: '晚餐', repeat: 'daily', time: '20:00' },
    { id: 'x', enabled: false, type: 'expense', item: '房租', repeat: 'daily', time: '08:00' },
  ];
  const R = loadRules(metaOf(...reminders));
  const now = at(13, 14, 0);
  const due = R.due({ now, records: NONE, items: ITEMS });
  assert.deepEqual(due.map(r => r.item), ['早餐', '午餐'], '依時間排序；晚餐還沒到、房租停用');
  assert.equal(due[1].id, 'l2', '同一個項目只留最早開始提醒的那條');
  assert.equal(due[1].key, 'expense:午餐');

  assert.deepEqual(R.due({ now, records: NONE, items: ITEMS, skip: key => key === 'expense:早餐' }).map(r => r.item), ['午餐']);
  assert.deepEqual(R.due({ now, records: { expense: [rec(13, '早餐')], income: [] }, items: ITEMS }).map(r => r.item), ['午餐']);

  const off = loadRules({ recordReminders: { enabled: false, reminders } });
  assert.equal(off.due({ now, records: NONE, items: ITEMS }).length, 0, '總開關關閉就不提醒');
});

test('記帳提醒（前端）：排程文字', () => {
  const R = loadRules(null);
  const text = over => R.scheduleText(R.config(metaOf(lunch(over))).reminders[0]);
  assert.equal(text({}), '每天 13:00');
  assert.equal(text({ repeat: 'weekly', weekdays: [5, 1, 2, 3, 4] }), '每週一至週五 13:00');
  assert.equal(text({ repeat: 'weekly', weekdays: [0, 6] }), '每週六、週日 13:00');
  assert.equal(text({ repeat: 'weekly', weekdays: [3, 1] }), '每週一、三 13:00');
  assert.equal(text({ repeat: 'weekly', weekdays: [0, 1, 2, 3, 4, 5, 6] }), '每天 13:00');
  assert.equal(text({ repeat: 'monthly', monthDay: 5, time: '09:00' }), '每月 5 日 09:00');
});

const savedMeta = b => b.call('getSettingsOptions', true).metadata;
const reminder = over => Object.assign({ id: 'rm_a', enabled: true, type: 'expense', item: '午餐', repeat: 'daily', time: '13:00' }, over);

test('記帳提醒（後端）：儲存後寫進設定資料，啟動資料也帶得到', () => {
  const b = createBackend();
  assert.equal(savedMeta(b).recordReminders, undefined, '預設沒有存任何東西');

  const res = b.call('saveRecordReminders', {
    enabled: true,
    reminders: [
      reminder(),
      reminder({ id: 'rm_b', repeat: 'weekly', weekdays: [5, 1, 3, 1], time: '12:30' }),
      reminder({ id: '', type: 'income', item: '薪資', repeat: 'monthly', monthDay: 5, time: '09:00', enabled: false }),
    ],
  });
  assert.equal(res.ok, true);
  const list = res.metadata.recordReminders.reminders;
  assert.deepEqual(list[0], { id: 'rm_a', enabled: true, type: 'expense', item: '午餐', repeat: 'daily', time: '13:00' });
  assert.deepEqual(list[1].weekdays, [1, 3, 5], '星期去重並排序');
  assert.equal(list[2].monthDay, 5);
  assert.equal(list[2].enabled, false);
  assert.match(list[2].id, /^rm_/, '沒有 id 時自動產生');

  assert.equal(savedMeta(b).recordReminders.reminders.length, 3);
  assert.equal(b.call('getInitialData', true).settingsMetadata.recordReminders.reminders.length, 3, '打開頁面時就拿得到設定');

  b.call('saveRecordReminders', { enabled: false, reminders: [reminder()] });
  assert.equal(savedMeta(b).recordReminders.enabled, false);
  assert.equal(savedMeta(b).recordReminders.reminders.length, 1);
  assert.ok(Array.isArray(savedMeta(b).quickCombos), '不影響其他設定');
});

test('記帳提醒（後端）：擋下格式錯誤與不存在的項目', () => {
  const b = createBackend();
  const save = (...list) => b.call('saveRecordReminders', { enabled: true, reminders: list });
  assert.throws(() => b.call('saveRecordReminders', { enabled: true }), /格式錯誤/);
  assert.throws(() => save(reminder({ type: 'transfer' })), /支出或收入/);
  assert.throws(() => save(reminder({ item: '' })), /請選擇項目/);
  assert.throws(() => save(reminder({ item: '拉麵' })), /支出項目/);
  assert.throws(() => save(reminder({ type: 'income', item: '午餐' })), /收入項目/);
  assert.throws(() => save(reminder({ repeat: 'yearly' })), /每天、每週或每月/);
  assert.throws(() => save(reminder({ time: '25:00' })), /HH:MM/);
  assert.throws(() => save(reminder({ time: '' })), /HH:MM/);
  assert.throws(() => save(reminder({ repeat: 'weekly', weekdays: [] })), /至少要選一天/);
  assert.throws(() => save(reminder({ repeat: 'weekly', weekdays: [7] })), /星期/);
  assert.throws(() => save(reminder({ repeat: 'monthly', monthDay: 0 })), /1 到 31/);
  assert.throws(() => save(reminder({ repeat: 'monthly', monthDay: 32 })), /1 到 31/);
  assert.throws(() => save(...Array.from({ length: 21 }, (_, i) => reminder({ id: 'r' + i }))), /最多 20/);
  assert.equal(savedMeta(b).recordReminders, undefined, '失敗時不會寫入');

  const dup = save(reminder({ id: 'same' }), reminder({ id: 'same', time: '20:00' }));
  const ids = dup.metadata.recordReminders.reminders.map(r => r.id);
  assert.notEqual(ids[0], ids[1], '重複的 id 會換一個新的');
});

test('記帳提醒（後端）：項目改名會跟著改，已刪除的項目可以原樣保留', () => {
  const b = createBackend();
  b.call('saveRecordReminders', {
    enabled: true,
    reminders: [reminder(), reminder({ id: 'rm_s', type: 'income', item: '薪資', repeat: 'monthly', monthDay: 5 })],
  });
  const opts = () => b.call('getSettingsOptions', true);
  const lunchRow = opts().expenseItems.find(o => o.value === '午餐').row;
  b.call('saveSettingsItemWithEmoji', { category: 'expenseItems', name: '中餐', row: lunchRow });
  const salaryRow = opts().incomeItems.find(o => o.value === '薪資').row;
  b.call('saveSettingsItemWithEmoji', { category: 'incomeItems', name: '月薪', row: salaryRow });
  assert.deepEqual(savedMeta(b).recordReminders.reminders.map(r => r.item), ['中餐', '月薪']);

  // 「中餐」被刪掉之後，整份提醒照樣能存（舊的那條原樣保留，前端會標示「已不存在」）
  const row2 = opts().expenseItems.find(o => o.value === '中餐').row;
  b.call('deleteSettingsOption', 'expenseItems', row2);
  const res = b.call('saveRecordReminders', { enabled: true, reminders: [reminder({ item: '中餐' }), reminder({ id: 'rm_d', item: '晚餐' })] });
  assert.equal(res.metadata.recordReminders.reminders.length, 2);
});

test('記帳提醒（畫面）：提醒卡片有「前往記帳」「關閉」與下方的「今日不再顯示」', () => {
  const html = fs.readFileSync(path.join(DIST, 'Index.html'), 'utf8');
  const modal = html.slice(html.indexOf('id="reminderModal"'));
  assert.ok(modal.length > 20, '頁面包含提醒卡片');
  const go = modal.indexOf('id="reminderGoBtn"');
  const close = modal.indexOf('id="reminderCloseBtn"');
  const snooze = modal.indexOf('id="reminderSnoozeBtn"');
  assert.ok(go > 0 && close > 0 && snooze > Math.max(go, close), '今日不再顯示在兩個按鈕下方');
  assert.match(html, /data-stab="reminders"/, '設定頁有「記帳提醒」分頁');
});
