function buildAndCacheSettingsResult_(sheet, ss) {
  const spreadsheet = ss || (sheet ? sheet.getParent() : getSpreadsheet_());
  invalidateOptionsCache_();
  const updated = readAllOptionsData_(spreadsheet, true);
  updateBootSnapshotOptions_(updated);
  return {
    rawOptions: updated.raw,
    simpleOptions: updated.simple,
    raw: updated.raw,
    simple: updated.simple,
    metadata: updated.metadata,
  };
}

// 項目按鈕可選的顏色（對應前端 core/icons.js 的 ITEM_COLOR_PALETTE，也就是 --cat-<key>-* 色板）
const ITEM_COLOR_KEYS_ = ['food', 'bigexpense', 'entertainment', 'reimburse', 'living', 'transport', 'laundry', 'salary', 'daily', 'finance', 'other'];

function normalizeItemColorKey_(value) {
  const key = String(value == null ? '' : value).trim();
  if (!key || key === 'auto') return '';
  if (ITEM_COLOR_KEYS_.indexOf(key) < 0) throw new Error('不支援的項目顏色：' + key);
  return key;
}

function saveSettingsItemWithEmoji_(categoryOrPayload, valueArg, emojiArg, rowNumberArg, positionArg) {
  return withDocumentLock_(function () {
    let category = categoryOrPayload;
    let value = valueArg;
    let emoji = emojiArg;
    let rowNumber = rowNumberArg;
    let position = positionArg || 'bottom';
    let color;

    if (categoryOrPayload && typeof categoryOrPayload === 'object') {
      category = categoryOrPayload.category;
      value = categoryOrPayload.name !== undefined ? categoryOrPayload.name : categoryOrPayload.value;
      emoji = categoryOrPayload.emoji;
      rowNumber = categoryOrPayload.row !== undefined ? categoryOrPayload.row : categoryOrPayload.rowNumber;
      position = categoryOrPayload.position || positionArg || 'bottom';
      color = categoryOrPayload.color;
    }

    const col = settingsColumnNumber_(category);
    if (!col) throw new Error('不支援的設定類別：' + category);

    const cleanText = stripEmoji_(value);
    if (!cleanText) throw new Error('請輸入有效的選項名稱（純文字）');
    if (cleanText.length > 50) throw new Error('選項名稱不可超過 50 個字');
    // color 沒帶（undefined）＝不動；空字串／'auto'＝改回自動配色；其他值必須是前端色板的 key（先驗證，再寫試算表）
    const colorKey = (color === undefined || color === null) ? null : normalizeItemColorKey_(color);

    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
    if (!sheet) throw new Error('找不到「' + CONFIG.SETTINGS_SHEET + '」工作表。');

    const maxRow = Math.max(sheet.getLastRow(), 2);
    const numRows = maxRow - 1;
    const existing = numRows > 0
      ? sheet.getRange(2, col, numRows, 1).getDisplayValues().map(r => String(r[0] || '').trim())
      : [];

    let oldText = '';
    if (rowNumber && Number(rowNumber) >= 2) {
      const rIdx = Number(rowNumber);
      oldText = String(sheet.getRange(rIdx, col).getDisplayValue() || '').trim();
      for (let i = 0; i < existing.length; i++) {
        if ((i + 2) !== rIdx && existing[i] === cleanText) {
          throw new Error('「' + cleanText + '」已存在於清單中。');
        }
      }
      sheet.getRange(rIdx, col).setValue(literalText_(cleanText));
    } else {
      if (existing.includes(cleanText)) {
        throw new Error('「' + cleanText + '」已存在於清單中。');
      }
      const nonEmptyItems = existing.filter(x => x !== '');
      if (position === 'top') {
        nonEmptyItems.unshift(cleanText);
      } else {
        nonEmptyItems.push(cleanText);
      }
      const writeValues = nonEmptyItems.map(function (item) {
        return [literalText_(item)];
      });
      if (writeValues.length + 1 > sheet.getMaxRows()) {
        sheet.insertRowsAfter(sheet.getMaxRows(), (writeValues.length + 1) - sheet.getMaxRows());
      }
      sheet.getRange(2, col, writeValues.length, 1).setValues(writeValues);
    }

    const meta = getSettingsMetadata_(ss);
    if (!meta.emojis) meta.emojis = {};
    if (!meta.itemColors || typeof meta.itemColors !== 'object') meta.itemColors = {};
    if (oldText && oldText !== cleanText) {
      delete meta.emojis[oldText];
      if (meta.itemColors[oldText] && !meta.itemColors[cleanText]) meta.itemColors[cleanText] = meta.itemColors[oldText];
      delete meta.itemColors[oldText];
      renameQuickComboOption_(meta, category, oldText, cleanText);
      renameMealSlotOption_(meta, category, oldText, cleanText);
      renameRecordReminderOption_(meta, category, oldText, cleanText);
    }
    const cleanEmoji = String(emoji || '').trim();
    if (cleanEmoji) {
      meta.emojis[cleanText] = cleanEmoji;
    }
    meta.itemEmojis = meta.emojis;
    if (colorKey !== null) {
      if (colorKey) meta.itemColors[cleanText] = colorKey;
      else delete meta.itemColors[cleanText];
    }
    saveSettingsMetadata_(meta, ss);

    flushSpreadsheet_();
    const updated = buildAndCacheSettingsResult_(sheet, ss);
    return {
      ok: true,
      category: category,
      value: cleanText,
      emoji: cleanEmoji,
      color: meta.itemColors[cleanText] || '',
      options: updated.rawOptions,
      simpleOptions: updated.simpleOptions,
      metadata: meta,
    };
  });
}

function deleteSettingsOption_(category, rowNumber) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
    if (!sheet) throw new Error('找不到「' + CONFIG.SETTINGS_SHEET + '」工作表。');

    const col = settingsColumnNumber_(category);
    const row = Number(rowNumber);
    if (!Number.isInteger(row) || row < 2) {
      throw new Error('無效的資料列號：' + rowNumber);
    }

    const maxRow = Math.max(sheet.getLastRow(), 2);
    const numRows = maxRow - 1;
    const values = sheet.getRange(2, col, numRows, 1).getDisplayValues();

    const targetIdx = row - 2;
    if (targetIdx < values.length) {
      values.splice(targetIdx, 1);
      values.push(['']);

      const writeValues = values.map(function (r) {
        return [literalText_(r[0])];
      });
      sheet.getRange(2, col, writeValues.length, 1).setValues(writeValues);
    }

    flushSpreadsheet_();
    const updated = buildAndCacheSettingsResult_(sheet, ss);
    return {
      ok: true,
      category: category,
      row: row,
      options: updated.rawOptions,
      simpleOptions: updated.simpleOptions,
      metadata: updated.metadata,
    };
  });
}

function deleteSettingsItemWithEmoji_(categoryOrPayload, rowNumberArg) {
  let category = categoryOrPayload;
  let rowNumber = rowNumberArg;
  if (categoryOrPayload && typeof categoryOrPayload === 'object') {
    category = categoryOrPayload.category;
    rowNumber = categoryOrPayload.row !== undefined ? categoryOrPayload.row : categoryOrPayload.rowNumber;
  }
  const ss = getSpreadsheet_();
  const sheet = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
  const col = settingsColumnNumber_(category);
  let deletedText = '';
  if (sheet && col && rowNumber >= 2) {
    deletedText = String(sheet.getRange(Number(rowNumber), col).getDisplayValue() || '').trim();
  }
  const res = deleteSettingsOption_(category, rowNumber);
  if (deletedText) {
    const meta = getSettingsMetadata_(ss);
    const hasEmoji = Boolean(meta.emojis && meta.emojis[deletedText]);
    const hasColor = Boolean(meta.itemColors && meta.itemColors[deletedText]);
    if (hasEmoji) {
      delete meta.emojis[deletedText];
      meta.itemEmojis = meta.emojis;
    }
    if (hasColor) delete meta.itemColors[deletedText];
    if (hasEmoji || hasColor) saveSettingsMetadata_(meta, ss);
    res.metadata = meta;
  }
  return res;
}

function addSettingsOption_(category, value, position) {
  return saveSettingsItemWithEmoji_(category, value, '', null, position);
}

function updateSettingsOption_(category, row, value) {
  return saveSettingsItemWithEmoji_(category, value, '', row);
}

function reorderSettingsOptions_(category, orderedValues) {
  return withDocumentLock_(function () {
    if (!category) throw new Error('未指定設定類別。');
    if (!Array.isArray(orderedValues) || orderedValues.length === 0) {
      throw new Error('無效的排序資料。');
    }

    const col = settingsColumnNumber_(category);
    if (!col) throw new Error('不支援的設定類別：' + category);

    const ss = getSpreadsheet_();
    const sheet = ss.getSheetByName(CONFIG.SETTINGS_SHEET);
    if (!sheet) throw new Error('找不到「' + CONFIG.SETTINGS_SHEET + '」工作表。');

    const cleanList = [];
    const seen = new Set();
    orderedValues.forEach(function (v) {
      const t = stripEmoji_(v);
      if (t && !seen.has(t)) {
        seen.add(t);
        cleanList.push(t);
      }
    });

    if (cleanList.length === 0) {
      throw new Error('排序清單不得為空。');
    }

    const maxRow = Math.max(sheet.getLastRow(), 2);
    const numRows = maxRow - 1;
    const clearCount = Math.max(numRows, cleanList.length, 30);
    sheet.getRange(2, col, clearCount, 1).clearContent();

    if (cleanList.length + 1 > sheet.getMaxRows()) {
      sheet.insertRowsAfter(sheet.getMaxRows(), (cleanList.length + 1) - sheet.getMaxRows());
    }

    const writeValues = cleanList.map(function (item) {
      return [literalText_(item)];
    });
    sheet.getRange(2, col, writeValues.length, 1).setValues(writeValues);

    flushSpreadsheet_();
    const updated = buildAndCacheSettingsResult_(sheet, ss);

    return {
      ok: true,
      category: category,
      options: updated.rawOptions,
      simpleOptions: updated.simpleOptions,
      metadata: updated.metadata,
    };
  });
}

function readSettingColumn_(sheet, colIndex) {
  if (!sheet || !colIndex) return [];
  var lastRow = Math.max(2, Math.min(1000, sheet.getLastRow()));
  var numRows = Math.max(1, lastRow - 1);
  var vals = sheet.getRange(2, colIndex, numRows, 1).getDisplayValues();
  var items = [];
  for (var i = 0; i < vals.length; i++) {
    var v = String(vals[i][0] || '').trim();
    if (v) {
      items.push({ row: i + 2, value: v });
    }
  }
  return items;
}

function readAllSettingColumns_(sheet) {
  var ss = resolveSpreadsheet_(sheet) || getSpreadsheet_();
  return readAllOptionsData_(ss, true).raw;
}

function toSimpleOptions_(rawOpts) {
  var simple = {};
  if (!rawOpts || typeof rawOpts !== 'object') return simple;
  Object.keys(rawOpts).forEach(function (key) {
    var arr = Array.isArray(rawOpts[key]) ? rawOpts[key] : [];
    var seen = new Set();
    var list = [];
    arr.forEach(function (entry) {
      var val = (entry && typeof entry === 'object') ? String(entry.value || '').trim() : String(entry || '').trim();
      if (val && !seen.has(val)) {
        seen.add(val);
        list.push(val);
      }
    });
    simple[key] = list;
  });
  return simple;
}

function formatMonth_(date, timeZone) {
  var d = (date instanceof Date) ? date : new Date();
  var tz = timeZone || DEFAULT_TIME_ZONE_;
  return Utilities.formatDate(d, tz, 'yyyy.MM');
}

function invalidateOptionCaches_() {
  invalidateOptionsCache_();
}
