// 零相依的 .xlsx 讀取器：把 Google 試算表匯出的 Excel 檔轉成記憶體中的格子資料，
// 供本機模擬的 SpreadsheetApp 使用（僅開發／測試用，不會部署到 Apps Script）。
import fs from 'node:fs';
import zlib from 'node:zlib';
import { colToNumber } from './format.mjs';

function readZip(file) {
  const buf = fs.readFileSync(file);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx（找不到 zip 目錄）：' + file);
  const count = buf.readUInt16LE(eocd + 10);
  let ptr = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(ptr + 10);
    const compSize = buf.readUInt32LE(ptr + 20);
    const nameLen = buf.readUInt16LE(ptr + 28);
    const extraLen = buf.readUInt16LE(ptr + 30);
    const commentLen = buf.readUInt16LE(ptr + 32);
    const localOffset = buf.readUInt32LE(ptr + 42);
    const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen);
    entries.set(name, { method, compSize, localOffset });
    ptr += 46 + nameLen + extraLen + commentLen;
  }
  return {
    has: name => entries.has(name),
    text(name) {
      const e = entries.get(name);
      if (!e) return '';
      const nameLen = buf.readUInt16LE(e.localOffset + 26);
      const extraLen = buf.readUInt16LE(e.localOffset + 28);
      const start = e.localOffset + 30 + nameLen + extraLen;
      const raw = buf.subarray(start, start + e.compSize);
      return (e.method === 0 ? raw : zlib.inflateRawSync(raw)).toString('utf8');
    },
  };
}

function decodeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function attr(tag, name) {
  const m = tag.match(new RegExp('(?:^|\\s)' + name + '="([^"]*)"'));
  return m ? decodeXml(m[1]) : null;
}

// colToNumber 放在 format.mjs（不依賴 Node），讓模擬環境也能在瀏覽器裡執行；這裡保留匯出以相容既有引用。
export { colToNumber };

const BUILTIN_FORMATS = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%',
  14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM',
  20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm', 37: '#,##0;(#,##0)', 38: '#,##0;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 49: '@',
};

/**
 * 讀取 xlsx，回傳 { sheets: [{ name, hidden, maxRows, maxCols, cells: Map<'r,c', cell> }] }。
 * cell = { v: 值（number|string|boolean）, f: 公式（不含 =）, z: 數字格式 }
 */
export function readXlsx(file) {
  const zip = readZip(file);

  const shared = [];
  const sst = zip.text('xl/sharedStrings.xml');
  const siRe = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m;
  while ((m = siRe.exec(sst))) {
    const body = (m[1] || '').replace(/<rPh[\s\S]*?<\/rPh>/g, '');
    let text = '';
    const tRe = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(body))) text += decodeXml(t[1]);
    shared.push(text);
  }

  const styles = zip.text('xl/styles.xml');
  const numFmts = Object.assign({}, BUILTIN_FORMATS);
  const nfRe = /<numFmt\s[^>]*>/g;
  while ((m = nfRe.exec(styles))) numFmts[Number(attr(m[0], 'numFmtId'))] = attr(m[0], 'formatCode');
  const xfFormats = [];
  const cellXfs = (styles.match(/<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/) || [])[1] || '';
  const xfRe = /<xf\s[^>]*>/g;
  while ((m = xfRe.exec(cellXfs))) xfFormats.push(numFmts[Number(attr(m[0], 'numFmtId')) || 0] || 'General');

  const rels = {};
  const relRe = /<Relationship\s[^>]*>/g;
  const relXml = zip.text('xl/_rels/workbook.xml.rels');
  while ((m = relRe.exec(relXml))) rels[attr(m[0], 'Id')] = attr(m[0], 'Target');

  const sheets = [];
  const wb = zip.text('xl/workbook.xml');
  const sheetRe = /<sheet\s[^>]*>/g;
  while ((m = sheetRe.exec(wb))) {
    const name = attr(m[0], 'name');
    const target = rels[attr(m[0], 'r:id')];
    const xml = zip.text('xl/' + String(target).replace(/^\//, '').replace(/^xl\//, ''));
    sheets.push(parseSheet(xml, name, attr(m[0], 'state') === 'hidden', shared, xfFormats));
  }
  return { sheets };
}

function parseSheet(xml, name, hidden, shared, xfFormats) {
  const cells = new Map();
  let maxRows = 0;
  let maxCols = 0;

  const colRe = /<col\s[^>]*>/g;
  let m;
  const colsBlock = (xml.match(/<cols>([\s\S]*?)<\/cols>/) || [])[1] || '';
  while ((m = colRe.exec(colsBlock))) maxCols = Math.max(maxCols, Number(attr(m[0], 'max')) || 0);

  const dataStart = xml.indexOf('<sheetData');
  const dataEnd = xml.indexOf('</sheetData>');
  const data = dataStart >= 0 && dataEnd > dataStart ? xml.slice(dataStart, dataEnd) : '';
  const sharedFormulas = {};

  const cRe = /<c\s([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  while ((m = cRe.exec(data))) {
    const ref = attr(m[1], 'r');
    if (!ref) continue;
    const rm = ref.match(/^([A-Z]+)(\d+)$/);
    if (!rm) continue;
    const col = colToNumber(rm[1]);
    const row = Number(rm[2]);
    if (row > maxRows) maxRows = row;
    if (col > maxCols) maxCols = col;
    const body = m[2];
    const z = xfFormats[Number(attr(m[1], 's')) || 0] || 'General';
    if (body == null) {
      if (z !== 'General') cells.set(row + ',' + col, { v: '', z });
      continue;
    }
    const type = attr(m[1], 't');
    const vm = body.match(/<v>([\s\S]*?)<\/v>/);
    const fm = body.match(/<f([^>]*?)(?:\/>|>([\s\S]*?)<\/f>)/);
    let v = '';
    if (type === 'inlineStr') {
      const tm = body.match(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/);
      v = tm ? decodeXml(tm[1]) : '';
    } else if (vm) {
      const raw = decodeXml(vm[1]);
      if (type === 's') v = shared[Number(raw)] || '';
      else if (type === 'str' || type === 'e') v = raw;
      else if (type === 'b') v = raw === '1';
      else v = Number(raw);
    }
    const cell = { v };
    if (z !== 'General') cell.z = z;
    if (fm) {
      let formula = fm[2] != null ? decodeXml(fm[2]) : '';
      const si = attr(fm[1], 'si');
      if (si != null) {
        if (formula) sharedFormulas[si] = formula;
        else formula = sharedFormulas[si] || '';
      }
      if (formula) cell.f = formula;
    }
    if (cell.v === '' && !cell.f && !cell.z) continue;
    cells.set(row + ',' + col, cell);
  }

  const rowRe = /<row\s[^>]*r="(\d+)"/g;
  while ((m = rowRe.exec(data))) maxRows = Math.max(maxRows, Number(m[1]));

  return { name, hidden, maxRows: Math.max(maxRows, 1), maxCols: Math.max(maxCols, 26), cells };
}
