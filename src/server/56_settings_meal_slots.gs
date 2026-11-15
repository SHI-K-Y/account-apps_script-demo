/**
 * 時段建議：記帳頁依「現在時間」自動預選支出項目（例如 11:00 打開就先選好「午餐」）。
 * 設定存在 settings metadata 的 mealSlots（與常用組合同一處，跨裝置同步）：
 *   { enabled: true, slots: [{ item: '午餐', start: '10:30', end: '14:29' }, …] }
 * 沒有存過時，前端使用內建預設值（見 src/client/scripts/core/env.js 的 MealSlots）。
 * 時段可以跨午夜（例如 22:00–01:59 宵夜）；時段之間不可重疊。
 */
const MEAL_SLOT_LIMITS_ = Object.freeze({ MAX_COUNT: 12 });
const MEAL_SLOT_TIME_RE_ = /^([01]\d|2[0-3]):([0-5]\d)$/;

function mealSlotMinutes_(text) {
  const m = MEAL_SLOT_TIME_RE_.exec(String(text == null ? '' : text).trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
}

/** 時段涵蓋的每一分鐘（含起訖）；起 > 訖 代表跨午夜。 */
function mealSlotMinuteList_(start, end) {
  const out = [];
  const length = ((end - start + 1440) % 1440) + 1;
  for (let i = 0; i < length; i++) out.push((start + i) % 1440);
  return out;
}

function normalizeMealSlots_(config, options, existing) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('時段建議資料格式錯誤。');
  if (!Array.isArray(config.slots)) throw new Error('時段建議資料格式錯誤。');
  if (config.slots.length > MEAL_SLOT_LIMITS_.MAX_COUNT) {
    throw new Error('時段最多 ' + MEAL_SLOT_LIMITS_.MAX_COUNT + ' 個。');
  }

  // 已存過、但之後被刪掉的項目：原樣保留不擋（前端會標示「項目已不存在」），新選的項目才檢查。
  const previousItems = new Set(((existing && existing.slots) || []).map(function (s) { return s && s.item; }));
  const owner = new Array(1440);
  const slots = config.slots.map(function (raw, idx) {
    const label = '第 ' + (idx + 1) + ' 個時段';
    if (!raw || typeof raw !== 'object') throw new Error(label + '：資料格式錯誤。');
    const item = stripEmoji_(String(raw.item == null ? '' : raw.item).trim());
    if (!item) throw new Error(label + '：請選擇支出項目。');
    if (!previousItems.has(item)) validateOption_(item, options.expenseItems || [], '支出項目');

    const start = mealSlotMinutes_(raw.start);
    const end = mealSlotMinutes_(raw.end);
    if (start < 0 || end < 0) throw new Error(label + '（' + item + '）：時間格式要是 HH:MM。');
    if (start === end) throw new Error(label + '（' + item + '）：開始與結束時間不能相同。');

    mealSlotMinuteList_(start, end).forEach(function (minute) {
      if (owner[minute] === undefined) { owner[minute] = idx; return; }
      const other = config.slots[owner[minute]];
      throw new Error('「' + item + '」與「' + stripEmoji_(String(other.item)) + '」的時段重疊了，請調整時間。');
    });
    return { item: item, start: String(raw.start).trim(), end: String(raw.end).trim() };
  });

  return { enabled: config.enabled !== false, slots: slots, updatedAt: Date.now() };
}

function saveMealSlots_(config) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const meta = getSettingsMetadata_(ss);
    if (config.reset === true) {
      delete meta.mealSlots; // 恢復預設：前端改用內建的預設時段
    } else {
      meta.mealSlots = normalizeMealSlots_(config, readOptions_(ss), meta.mealSlots);
    }

    if (!saveSettingsMetadata_(meta, ss)) {
      throw new Error('時段建議儲存失敗，請稍後再試。');
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

/** 支出項目改名時，時段建議跟著改。 */
function renameMealSlotOption_(meta, category, oldText, newText) {
  if (category !== 'expenseItems' || !meta.mealSlots || !Array.isArray(meta.mealSlots.slots)) return;
  meta.mealSlots.slots.forEach(function (slot) {
    if (slot && slot.item === oldText) slot.item = newText;
  });
}
