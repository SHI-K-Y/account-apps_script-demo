/**
 * 記帳提醒：打開記帳簿時，若設定的時間已過、卻還沒記下指定項目，就跳出提醒卡片。
 * 設定存在 settings metadata 的 recordReminders（與常用組合、時段建議同一處，跨裝置同步）：
 *   {
 *     enabled: true,
 *     reminders: [
 *       { id: 'rm_…', enabled: true, type: 'expense', item: '午餐', repeat: 'daily',   time: '13:00' },
 *       { id: 'rm_…', enabled: true, type: 'expense', item: '午餐', repeat: 'weekly',  time: '13:00', weekdays: [1, 2, 3, 4, 5] },
 *       { id: 'rm_…', enabled: true, type: 'income',  item: '薪資', repeat: 'monthly', time: '09:00', monthDay: 5, note: '確認加班費' },
 *     ],
 *   }
 * weekdays 用 JavaScript 的 getDay()：0 = 週日 … 6 = 週六。monthDay 超過當月天數時以月底為準。
 * note（備註）選填，可以換行，跳出提醒卡片時一起顯示；沒填就不存這個欄位。
 * 「有沒有記」由前端用當月紀錄判斷（見 src/client/scripts/core/reminders.js）；這裡只負責驗證與儲存。
 */
const RECORD_REMINDER_LIMITS_ = Object.freeze({ MAX_COUNT: 20, NOTE_MAX_LENGTH: 100 });
const RECORD_REMINDER_REPEATS_ = Object.freeze(['daily', 'weekly', 'monthly']);
const RECORD_REMINDER_ID_RE_ = /^[A-Za-z0-9_-]{1,40}$/;

/** 備註：統一換行、去掉頭尾空白，連續空行最多留一行。 */
function normalizeRecordReminderNote_(value, named) {
  const note = String(value == null ? '' : value).replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (note.length > RECORD_REMINDER_LIMITS_.NOTE_MAX_LENGTH) {
    throw new Error(named + '：備註最多 ' + RECORD_REMINDER_LIMITS_.NOTE_MAX_LENGTH + ' 個字。');
  }
  return note;
}

function normalizeRecordReminders_(config, options, existing) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('記帳提醒資料格式錯誤。');
  if (!Array.isArray(config.reminders)) throw new Error('記帳提醒資料格式錯誤。');
  if (config.reminders.length > RECORD_REMINDER_LIMITS_.MAX_COUNT) {
    throw new Error('記帳提醒最多 ' + RECORD_REMINDER_LIMITS_.MAX_COUNT + ' 個。');
  }

  // 已存過、但之後被刪掉的項目：原樣保留不擋（前端會標示「項目已不存在」），新選的項目才檢查。
  const previous = new Set(((existing && existing.reminders) || []).map(function (r) {
    return r ? r.type + '\n' + r.item : '';
  }));
  const usedIds = new Set();
  const stamp = Date.now().toString(36);

  const reminders = config.reminders.map(function (raw, idx) {
    const label = '第 ' + (idx + 1) + ' 個提醒';
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(label + '：資料格式錯誤。');

    const type = raw.type === 'income' ? 'income' : raw.type === 'expense' || raw.type == null ? 'expense' : '';
    if (!type) throw new Error(label + '：類型只能是支出或收入。');
    const item = stripEmoji_(String(raw.item == null ? '' : raw.item).trim());
    if (!item) throw new Error(label + '：請選擇項目。');
    if (!previous.has(type + '\n' + item)) {
      validateOption_(item, (type === 'income' ? options.incomeItems : options.expenseItems) || [], type === 'income' ? '收入項目' : '支出項目');
    }
    const named = label + '（' + item + '）';

    const repeat = String(raw.repeat || '');
    if (RECORD_REMINDER_REPEATS_.indexOf(repeat) === -1) throw new Error(named + '：請選擇每天、每週或每月。');

    const time = String(raw.time == null ? '' : raw.time).trim();
    if (mealSlotMinutes_(time) < 0) throw new Error(named + '：時間格式要是 HH:MM。');

    let id = String(raw.id == null ? '' : raw.id).trim();
    if (!RECORD_REMINDER_ID_RE_.test(id) || usedIds.has(id)) id = 'rm_' + stamp + '_' + idx;
    usedIds.add(id);

    const out = { id: id, enabled: raw.enabled !== false, type: type, item: item, repeat: repeat, time: time };

    if (repeat === 'weekly') {
      const days = Array.isArray(raw.weekdays) ? raw.weekdays : [];
      const clean = [];
      days.forEach(function (d) {
        const n = Number(d);
        if (!Number.isInteger(n) || n < 0 || n > 6) throw new Error(named + '：星期資料格式錯誤。');
        if (clean.indexOf(n) === -1) clean.push(n);
      });
      if (!clean.length) throw new Error(named + '：每週提醒至少要選一天。');
      out.weekdays = clean.sort(function (a, b) { return a - b; });
    } else if (repeat === 'monthly') {
      const day = Number(raw.monthDay);
      if (!Number.isInteger(day) || day < 1 || day > 31) throw new Error(named + '：每月提醒的日期要在 1 到 31 之間。');
      out.monthDay = day;
    }
    const note = normalizeRecordReminderNote_(raw.note, named);
    if (note) out.note = note;
    return out;
  });

  return { enabled: config.enabled !== false, reminders: reminders, updatedAt: Date.now() };
}

function saveRecordReminders_(config) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const meta = getSettingsMetadata_(ss);
    meta.recordReminders = normalizeRecordReminders_(config, readOptions_(ss), meta.recordReminders);

    if (!saveSettingsMetadata_(meta, ss)) {
      throw new Error('記帳提醒儲存失敗，請稍後再試。');
    }

    const updated = readAllOptionsData_(ss, true);
    updateBootSnapshotOptions_(updated);
    return {
      ok: true,
      options: updated.raw,
      simpleOptions: updated.simple,
      metadata: updated.metadata,
    };
  });
}

/** 支出／收入項目改名時，記帳提醒跟著改。 */
function renameRecordReminderOption_(meta, category, oldText, newText) {
  const type = category === 'expenseItems' ? 'expense' : category === 'incomeItems' ? 'income' : '';
  if (!type || !meta.recordReminders || !Array.isArray(meta.recordReminders.reminders)) return;
  meta.recordReminders.reminders.forEach(function (r) {
    if (r && r.type === type && r.item === oldText) r.item = newText;
  });
}
