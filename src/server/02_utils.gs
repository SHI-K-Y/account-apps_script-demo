function cellToStr_(val) {
  if (val === null || val === undefined || val === '') return '';
  if (val instanceof Date) {
    const tz = scriptTimeZone_();
    return Utilities.formatDate(val, tz, 'yyyy-MM-dd');
  }
  return String(val).trim();
}

function findNextBlankRow_(sheet, startRow, startCol, numCols) {
  const sheetLastRow = sheet.getLastRow();
  const endRow = Math.min(Math.max(sheetLastRow + 1, startRow), Math.min(CONFIG.MAX_DATA_ROW, sheet.getMaxRows()));
  const rowCount = endRow - startRow + 1;
  if (rowCount <= 0) throw new Error('沒有可寫入的資料列。');

  const values = sheet.getRange(startRow, startCol, rowCount, numCols).getValues();
  for (let i = 0; i < values.length; i++) {
    const empty = values[i].every(value => value === '' || value === null || String(value).trim() === '');
    if (empty) return startRow + i;
  }

  var nextRow = endRow + 1;
  if (nextRow <= Math.min(CONFIG.MAX_DATA_ROW, sheet.getMaxRows())) {
    return nextRow;
  }

  throw new Error(`可用輸入列已滿：${startRow}～${endRow}。`);
}

function normalizeDay_(value, daysInMonth) {
  const day = Number(value);
  if (!Number.isInteger(day) || day < 1 || day > daysInMonth) {
    throw new Error(`日期必須介於 1～${daysInMonth}。`);
  }
  return day;
}

function normalizeAmount_(value) {
  const str = String(value == null ? '' : value).trim();
  const isNegative = str.includes('-') || (str.startsWith('(') && str.endsWith(')'));
  const cleaned = str.replace(/[^0-9.]/g, '');
  const amount = Number(cleaned);
  if (!Number.isFinite(amount) || amount <= 0 || isNegative) {
    throw new Error('金額必須是大於 0 的數字。');
  }
  if (amount > 999999999) {
    throw new Error('金額過大。');
  }
  return amount;
}

function cleanAmount_(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const str = String(value == null ? '' : value).trim();
  if (!str) return 0;
  const isNegative = str.includes('-') || (str.startsWith('(') && str.endsWith(')'));
  const cleaned = str.replace(/[^0-9.]/g, '');
  const num = parseFloat(cleaned);
  if (!Number.isFinite(num)) return 0;
  return isNegative ? -num : num;
}

function normalizePaidCode_(value) {
  const paid = String(value == null ? '' : value).trim().toUpperCase();
  if (!['', 'O', 'X'].includes(paid)) {
    throw new Error('是否已繳只能是 O（已繳）、X（未繳）或空白。');
  }
  return paid;
}

function requiredText_(value, message) {
  const text = String(value == null ? '' : value).trim();
  if (!text) throw new Error(message);
  if (text.length > 100) throw new Error(`${message}內容過長。`);
  return text;
}

function textOrBlank_(value, maxLength) {
  const text = String(value == null ? '' : value).trim();
  return text.slice(0, maxLength);
}

function validateOption_(value, allowedValues, label) {
  if (!allowedValues.includes(value)) {
    throw new Error(`${label}「${value}」不在「資料選單設定區」的選項中。`);
  }
}

function literalText_(value) {
  const text = String(value == null ? '' : value);
  if (/^[=+\-@]/.test(text)) return "'" + text;
  return text;
}
