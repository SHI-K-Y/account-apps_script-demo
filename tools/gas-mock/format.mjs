// 試算表數字／日期格式的精簡實作，讓模擬的 getDisplayValues() 與真實試算表的顯示結果相近。

const DAY_MS = 86400000;
const EPOCH_OFFSET_DAYS = 25569; // 1970-01-01 在試算表序號中的值

export function serialToParts(serial) {
  const ms = Math.round((Number(serial) - EPOCH_OFFSET_DAYS) * DAY_MS);
  const d = new Date(ms);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(),
  };
}

export function partsToSerial(y, mo, d, h = 0, mi = 0, s = 0) {
  return Date.UTC(y, mo - 1, d, h, mi, s) / DAY_MS + EPOCH_OFFSET_DAYS;
}

/** 欄位字母 → 欄號（A → 1、AA → 27）。 */
export function colToNumber(letters) {
  let n = 0;
  for (let i = 0; i < letters.length; i++) n = n * 26 + (letters.charCodeAt(i) - 64);
  return n;
}

function stripLiterals(fmt) {
  return fmt.replace(/"[^"]*"/g, '').replace(/\[[^\]]*\]/g, '').replace(/\\./g, '').replace(/_./g, '').replace(/\*./g, '');
}

export function isDateFormat(fmt) {
  if (!fmt || fmt === 'General' || fmt === '@') return false;
  const bare = stripLiterals(fmt);
  return /[ymdhs]/i.test(bare) && !/[0#]/.test(bare);
}

function splitSections(fmt) {
  const out = [];
  let cur = '';
  let inQuote = false;
  for (let i = 0; i < fmt.length; i++) {
    const ch = fmt[i];
    if (ch === '"') inQuote = !inQuote;
    if (ch === ';' && !inQuote) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function pad(n, len) {
  return String(n).padStart(len, '0');
}

function formatDate(serial, fmt) {
  const p = serialToParts(serial);
  let out = '';
  let i = 0;
  let lastWasHour = false;
  const hasAmPm = /AM\/PM/i.test(fmt);
  while (i < fmt.length) {
    const ch = fmt[i];
    if (ch === '"') {
      const end = fmt.indexOf('"', i + 1);
      out += fmt.slice(i + 1, end < 0 ? fmt.length : end);
      i = end < 0 ? fmt.length : end + 1;
      continue;
    }
    if (ch === '[') { const end = fmt.indexOf(']', i); i = end < 0 ? fmt.length : end + 1; continue; }
    if (ch === '\\') { out += fmt[i + 1] || ''; i += 2; continue; }
    if (/AM\/PM/i.test(fmt.slice(i, i + 5))) { out += p.h < 12 ? 'AM' : 'PM'; i += 5; continue; }
    const lower = ch.toLowerCase();
    if ('ymdhs'.indexOf(lower) !== -1) {
      let j = i;
      while (j < fmt.length && fmt[j].toLowerCase() === lower) j++;
      const len = j - i;
      if (lower === 'y') out += len <= 2 ? pad(p.y % 100, 2) : String(p.y);
      else if (lower === 'd') out += len === 1 ? String(p.d) : pad(p.d, 2);
      else if (lower === 'h') {
        const hour = hasAmPm ? ((p.h + 11) % 12) + 1 : p.h;
        out += len === 1 ? String(hour) : pad(hour, 2);
      } else if (lower === 's') out += len === 1 ? String(p.s) : pad(p.s, 2);
      else {
        const nextIsSeconds = /^[^a-z]*s/i.test(fmt.slice(j));
        const isMinute = ch === 'm' && (lastWasHour || nextIsSeconds);
        const val = isMinute ? p.mi : p.mo;
        out += len === 1 ? String(val) : pad(val, 2);
      }
      lastWasHour = lower === 'h';
      i = j;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

function generalNumber(num) {
  if (Number.isInteger(num)) return String(num);
  return String(Number(num.toPrecision(10)));
}

function formatNumeric(num, section) {
  let prefix = '';
  let suffix = '';
  let pattern = '';
  let i = 0;
  const push = text => { if (pattern) suffix += text; else prefix += text; };
  while (i < section.length) {
    const ch = section[i];
    if (ch === '"') {
      const end = section.indexOf('"', i + 1);
      push(section.slice(i + 1, end < 0 ? section.length : end));
      i = end < 0 ? section.length : end + 1;
    } else if (ch === '[') {
      const end = section.indexOf(']', i);
      const inner = section.slice(i + 1, end < 0 ? section.length : end);
      if (inner[0] === '$') push(inner.slice(1).split('-')[0]);
      i = end < 0 ? section.length : end + 1;
    } else if (ch === '\\') { push(section[i + 1] || ''); i += 2; }
    else if (ch === '_') { push(' '); i += 2; }
    else if (ch === '*') { i += 2; }
    else if ('0#?,.'.indexOf(ch) !== -1) { pattern += ch; i++; }
    else if (ch === '%') { pattern += '%'; i++; }
    else { push(ch); i++; }
  }
  if (!pattern) return prefix + suffix;
  const percent = pattern.indexOf('%') !== -1;
  const core = pattern.replace(/%/g, '');
  const dot = core.indexOf('.');
  const intPart = dot < 0 ? core : core.slice(0, dot);
  const decPart = dot < 0 ? '' : core.slice(dot + 1);
  const decimals = decPart.replace(/[^0#?]/g, '').length;
  const minInt = (intPart.match(/0/g) || []).length;
  const grouping = intPart.indexOf(',') !== -1;
  let value = Math.abs(num) * (percent ? 100 : 1);
  let fixed = value.toFixed(decimals);
  let [intStr, decStr] = fixed.split('.');
  intStr = intStr.padStart(Math.max(minInt, 1), '0');
  if (minInt === 0 && intStr === '0' && decimals > 0) intStr = '';
  if (grouping) intStr = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return prefix + intStr + (decimals ? '.' + decStr : '') + (percent ? '%' : '') + suffix;
}

/** 依數字格式回傳顯示文字（對應 Range.getDisplayValue）。 */
export function formatValue(value, fmt) {
  if (value === '' || value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value !== 'number') return String(value);
  if (!fmt || fmt === 'General' || fmt === '@') return generalNumber(value);
  if (isDateFormat(fmt)) return formatDate(value, fmt);
  const sections = splitSections(fmt);
  if (value < 0 && sections.length > 1) return formatNumeric(value, sections[1]);
  if (value === 0 && sections.length > 2) return formatNumeric(value, sections[2]);
  return (value < 0 ? '-' : '') + formatNumeric(value, sections[0]);
}
