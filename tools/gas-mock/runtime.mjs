// 本機模擬的 Apps Script 執行環境：SpreadsheetApp / CacheService / PropertiesService /
// LockService / Utilities / Session / HtmlService。只實作本專案後端用到的 API。
// 用途：(1) npm run dev 的本機預覽  (2) npm test 的後端測試  (3) 公開 Demo 網站（在訪客的瀏覽器裡執行）。
// 不會部署到 Apps Script。這個檔案不可使用 Node 專用的 API（fs、Buffer…），瀏覽器裡也要能跑。
import { formatValue, isDateFormat, serialToParts, partsToSerial, colToNumber } from './format.mjs';

const CACHE_MAX_BYTES = 100 * 1024;
const PROP_MAX_BYTES = 9 * 1024;
const DEFAULT_DATE_FORMAT = 'yyyy/M/d';

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder();
const hasBuffer = typeof Buffer !== 'undefined';

function byteLength(str) {
  return utf8Encoder.encode(String(str)).length;
}

function toByteArray(data) {
  if (data == null) return [];
  if (typeof data === 'string') return Array.from(utf8Encoder.encode(data));
  return Array.from(data, b => b & 0xff);
}

function base64ToBytes(text) {
  if (hasBuffer) return Array.from(Buffer.from(String(text), 'base64'));
  return Array.from(atob(String(text).replace(/[^A-Za-z0-9+/=]/g, '')), ch => ch.charCodeAt(0));
}

function bytesToBase64(data) {
  const bytes = toByteArray(data);
  if (hasBuffer) return Buffer.from(bytes).toString('base64');
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function isDate(v) {
  return Object.prototype.toString.call(v) === '[object Date]';
}

function parseA1(a1, sheet) {
  const text = String(a1).replace(/\$/g, '').toUpperCase();
  const [a, b] = text.split(':');
  const parse = part => {
    const m = String(part || '').match(/^([A-Z]*)(\d*)$/);
    if (!m) throw new Error('無法解析範圍：' + a1);
    return { col: m[1] ? colToNumber(m[1]) : 0, row: m[2] ? Number(m[2]) : 0 };
  };
  const s = parse(a);
  const e = b === undefined ? s : parse(b);
  const row = s.row || 1;
  const col = s.col || 1;
  const endRow = e.row || sheet.getMaxRows();
  const endCol = e.col || sheet.getMaxColumns();
  return { row, col, numRows: endRow - row + 1, numCols: endCol - col + 1 };
}

/**
 * 建立一組模擬服務。
 * @param {object} opts
 *   workbook  readXlsx() 的結果（會被就地修改）
 *   files     HtmlService 可讀取的檔案：{ Index: '<html>…', style: '…' }
 *   DateCtor  後端程式看到的 Date（測試時可換成固定時間的版本）
 *   timeZone / tzOffsetMinutes  試算表時區（預設 Asia/Taipei, +480）
 *   recalc    選用：function (spreadsheet)。模擬環境不會計算試算表公式；提供這個函式時，
 *             每次「寫入後的第一次讀取」之前會先呼叫它，讓它把公式格的值更新成最新結果
 *             （公開 Demo 用它讓總覽、對帳等數字隨著記帳即時變動，見 tools/demo/recalc.mjs）。
 */
export function createGasRuntime(opts) {
  const options = opts || {};
  const DateCtor = options.DateCtor || Date;
  const timeZone = options.timeZone || 'Asia/Taipei';
  const tzOffsetMs = (options.tzOffsetMinutes == null ? 480 : options.tzOffsetMinutes) * 60000;
  const files = options.files || {};
  const log = options.log || (() => {});
  const stats = { reads: 0, writes: 0, cacheHits: 0, cacheMisses: 0 };

  // 公式重算：寫入時只做記號，等到下一次讀取才重算一次。
  const recalc = typeof options.recalc === 'function' ? options.recalc : null;
  let recalcPending = Boolean(recalc);
  let recalcRunning = false;
  const touch = () => { if (recalc) recalcPending = true; };
  const settle = () => {
    if (!recalcPending || recalcRunning) return;
    recalcRunning = true;
    try { recalc(spreadsheet); } finally { recalcRunning = false; recalcPending = false; }
  };

  const serialToDate = serial => {
    const p = serialToParts(serial);
    return new DateCtor(Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - tzOffsetMs);
  };
  const dateToSerial = date => {
    const d = new Date(date.getTime() + tzOffsetMs);
    return partsToSerial(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds());
  };

  /* ------------------------------ Spreadsheet ------------------------------ */
  let nextSheetId = 1000;

  class MockSheet {
    constructor(ss, data) {
      this.ss = ss;
      this.name = data.name;
      this.hidden = Boolean(data.hidden);
      this.maxRows = data.maxRows;
      this.maxCols = data.maxCols;
      this.cells = data.cells;
      this.sheetId = data.sheetId != null ? data.sheetId : nextSheetId++;
      this.frozenRows = 0;
    }
    getName() { return this.name; }
    setName(name) {
      if (this.ss.sheets.some(s => s !== this && s.name === name)) throw new Error('已有名為「' + name + '」的工作表。');
      this.name = String(name);
      touch();
      return this;
    }
    getSheetId() { return this.sheetId; }
    getParent() { return this.ss; }
    getIndex() { return this.ss.sheets.indexOf(this) + 1; }
    getMaxRows() { return this.maxRows; }
    getMaxColumns() { return this.maxCols; }
    getLastRow() {
      let last = 0;
      for (const [key, cell] of this.cells) {
        if (cell.v === '' && !cell.f) continue;
        const row = Number(key.slice(0, key.indexOf(',')));
        if (row > last) last = row;
      }
      return last;
    }
    isSheetHidden() { return this.hidden; }
    showSheet() { this.hidden = false; return this; }
    hideSheet() { this.hidden = true; return this; }
    setFrozenRows(n) { this.frozenRows = n; return this; }
    insertRowsAfter(_after, howMany) { this.maxRows += Number(howMany) || 0; return this; }
    copyTo(ss) {
      const cells = new Map();
      for (const [key, cell] of this.cells) cells.set(key, Object.assign({}, cell));
      let name = '「' + this.name + '」的副本';
      let n = 1;
      while (ss.sheets.some(s => s.name === name)) name = '「' + this.name + '」的副本 ' + (++n);
      const copy = new MockSheet(ss, { name, hidden: this.hidden, maxRows: this.maxRows, maxCols: this.maxCols, cells });
      ss.sheets.push(copy);
      touch();
      return copy;
    }
    getRange(a, b, c, d) {
      if (typeof a === 'string') {
        const r = parseA1(a, this);
        return new MockRange(this, r.row, r.col, r.numRows, r.numCols);
      }
      return new MockRange(this, Number(a), Number(b), c == null ? 1 : Number(c), d == null ? 1 : Number(d));
    }
    getRangeList(a1List) {
      const ranges = a1List.map(a1 => this.getRange(a1));
      return {
        getRanges: () => ranges,
        setValue(v) { ranges.forEach(r => r.setValue(v)); return this; },
        clearContent() { ranges.forEach(r => r.clearContent()); return this; },
      };
    }
    _cell(row, col) { return this.cells.get(row + ',' + col); }
    _write(row, col, input) {
      touch();
      const key = row + ',' + col;
      const prev = this.cells.get(key);
      const z = prev && prev.z;
      const next = z ? { v: '', z } : { v: '' };
      const done = () => {
        if (next.v === '' && !next.f && !next.z) this.cells.delete(key);
        else this.cells.set(key, next);
      };
      if (input === null || input === undefined || input === '') return done();
      if (isDate(input)) {
        next.v = dateToSerial(input);
        if (!isDateFormat(next.z)) next.z = DEFAULT_DATE_FORMAT;
        return done();
      }
      if (typeof input === 'number' || typeof input === 'boolean') { next.v = input; return done(); }
      const text = String(input);
      if (text[0] === "'") { next.v = text.slice(1); return done(); }
      if (text[0] === '=' && text.length > 1) {
        next.f = text.slice(1);
        const dm = text.match(/^=DATE\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)$/i);
        if (dm) {
          next.v = partsToSerial(Number(dm[1]), Number(dm[2]), Number(dm[3]));
          if (!isDateFormat(next.z)) next.z = DEFAULT_DATE_FORMAT;
        }
        return done();
      }
      if (next.z === '@') { next.v = text; return done(); }
      if (/^-?\d+(\.\d+)?$/.test(text.trim())) { next.v = Number(text); return done(); }
      const dateMatch = text.trim().match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/);
      if (dateMatch) {
        next.v = partsToSerial(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]));
        if (!isDateFormat(next.z)) next.z = DEFAULT_DATE_FORMAT;
        return done();
      }
      next.v = text;
      return done();
    }
  }

  class MockRange {
    constructor(sheet, row, col, numRows, numCols) {
      if (!(row >= 1) || !(col >= 1) || !(numRows >= 1) || !(numCols >= 1)) {
        throw new Error('範圍的座標或大小無效：' + [row, col, numRows, numCols].join(','));
      }
      if (row + numRows - 1 > sheet.maxRows || col + numCols - 1 > sheet.maxCols) {
        throw new Error('範圍超出工作表「' + sheet.name + '」的大小：' + [row, col, numRows, numCols].join(','));
      }
      this.sheet = sheet; this.row = row; this.col = col; this.numRows = numRows; this.numCols = numCols;
    }
    getSheet() { return this.sheet; }
    getRow() { return this.row; }
    getColumn() { return this.col; }
    getNumRows() { return this.numRows; }
    getNumColumns() { return this.numCols; }
    _map(fn) {
      const out = new Array(this.numRows);
      for (let r = 0; r < this.numRows; r++) {
        const rowVals = new Array(this.numCols);
        for (let c = 0; c < this.numCols; c++) rowVals[c] = fn(this.sheet._cell(this.row + r, this.col + c));
        out[r] = rowVals;
      }
      return out;
    }
    getValues() {
      settle();
      stats.reads++;
      return this._map(cell => {
        if (!cell) return '';
        if (typeof cell.v === 'number' && isDateFormat(cell.z)) return serialToDate(cell.v);
        return cell.v;
      });
    }
    getValue() { return this.getValues()[0][0]; }
    getDisplayValues() {
      settle();
      stats.reads++;
      return this._map(cell => (cell ? formatValue(cell.v, cell.z) : ''));
    }
    getDisplayValue() { return this.getDisplayValues()[0][0]; }
    getFormulaR1C1() {
      const cell = this.sheet._cell(this.row, this.col);
      if (!cell || !cell.f) return '';
      return cell.r1c1 || '=' + cell.f;
    }
    getFormula() {
      const cell = this.sheet._cell(this.row, this.col);
      return cell && cell.f ? '=' + cell.f : '';
    }
    setValues(values) {
      if (!Array.isArray(values) || values.length !== this.numRows) {
        throw new Error('資料列數 (' + (values && values.length) + ') 與範圍列數 (' + this.numRows + ') 不符。');
      }
      stats.writes++;
      for (let r = 0; r < this.numRows; r++) {
        if (!Array.isArray(values[r]) || values[r].length !== this.numCols) {
          throw new Error('資料欄數 (' + (values[r] && values[r].length) + ') 與範圍欄數 (' + this.numCols + ') 不符。');
        }
        for (let c = 0; c < this.numCols; c++) this.sheet._write(this.row + r, this.col + c, values[r][c]);
      }
      return this;
    }
    setValue(value) {
      stats.writes++;
      for (let r = 0; r < this.numRows; r++) {
        for (let c = 0; c < this.numCols; c++) this.sheet._write(this.row + r, this.col + c, value);
      }
      return this;
    }
    setFormula(formula) { return this.setValue(String(formula)); }
    setFormulaR1C1(formula) {
      this.setValue(String(formula));
      const cell = this.sheet._cell(this.row, this.col);
      if (cell && cell.f) cell.r1c1 = String(formula);
      return this;
    }
    clearContent() {
      stats.writes++;
      for (let r = 0; r < this.numRows; r++) {
        for (let c = 0; c < this.numCols; c++) this.sheet._write(this.row + r, this.col + c, '');
      }
      return this;
    }
    setNumberFormat(fmt) {
      // 整欄／整列的格式只套用到已有內容的格子，避免在模擬資料裡塞滿空格子。
      const sparse = this.numRows * this.numCols > 5000;
      for (let r = 0; r < this.numRows; r++) {
        for (let c = 0; c < this.numCols; c++) {
          const key = (this.row + r) + ',' + (this.col + c);
          const cell = this.sheet.cells.get(key);
          if (cell) cell.z = fmt;
          else if (!sparse) this.sheet.cells.set(key, { v: '', z: fmt });
        }
      }
      return this;
    }
    setFontWeight() { return this; }
    copyTo(target, opts) {
      const contentsOnly = Boolean(opts && opts.contentsOnly);
      for (let r = 0; r < this.numRows; r++) {
        for (let c = 0; c < this.numCols; c++) {
          const src = this.sheet._cell(this.row + r, this.col + c);
          const key = (target.row + r) + ',' + (target.col + c);
          if (!src) { target.sheet.cells.delete(key); continue; }
          const copy = Object.assign({}, src);
          if (contentsOnly) { delete copy.f; delete copy.r1c1; }
          target.sheet.cells.set(key, copy);
        }
      }
      touch();
      return this;
    }
  }

  class MockSpreadsheet {
    constructor(workbook) {
      this.id = 'mock-spreadsheet-id';
      this.name = '記帳簿（本機模擬）';
      this.sheets = (workbook.sheets || []).map(data => new MockSheet(this, data));
      this.active = this.sheets[0] || null;
    }
    getId() { return this.id; }
    getName() { return this.name; }
    getUrl() { return 'https://docs.google.com/spreadsheets/d/' + this.id + '/edit'; }
    getSpreadsheetTimeZone() { return timeZone; }
    getSheets() { return this.sheets.slice(); }
    getNumSheets() { return this.sheets.length; }
    getSheetByName(name) { return this.sheets.find(s => s.name === name) || null; }
    insertSheet(name, index) {
      if (this.getSheetByName(name)) throw new Error('已有名為「' + name + '」的工作表。');
      const sheet = new MockSheet(this, { name: String(name), hidden: false, maxRows: 1000, maxCols: 26, cells: new Map() });
      const at = index == null ? this.sheets.length : Math.max(0, Math.min(this.sheets.length, Number(index)));
      this.sheets.splice(at, 0, sheet);
      this.active = sheet;
      return sheet;
    }
    deleteSheet(sheet) {
      const i = this.sheets.indexOf(sheet);
      if (i < 0) throw new Error('找不到要刪除的工作表。');
      this.sheets.splice(i, 1);
      touch();
    }
    setActiveSheet(sheet) { this.active = sheet; return sheet; }
    getActiveSheet() { return this.active; }
    moveActiveSheet(pos) {
      const i = this.sheets.indexOf(this.active);
      if (i < 0) return;
      this.sheets.splice(i, 1);
      this.sheets.splice(Math.max(0, Math.min(this.sheets.length, Number(pos) - 1)), 0, this.active);
    }
  }

  const spreadsheet = new MockSpreadsheet(options.workbook || { sheets: [] });

  const SpreadsheetApp = {
    getActiveSpreadsheet: () => spreadsheet,
    openById: id => {
      if (id !== spreadsheet.id) throw new Error('找不到試算表：' + id);
      return spreadsheet;
    },
    flush: () => {},
  };

  /* --------------------------- Cache / Properties --------------------------- */
  const cacheStore = new Map();
  const scriptCache = {
    get(key) {
      const hit = cacheStore.get(String(key));
      if (hit === undefined) { stats.cacheMisses++; return null; }
      stats.cacheHits++;
      return hit;
    },
    getAll(keys) {
      const out = {};
      keys.forEach(k => { if (cacheStore.has(String(k))) out[k] = cacheStore.get(String(k)); });
      return out;
    },
    put(key, value) {
      if (String(key).length > 250) throw new Error('Argument too large: key');
      if (byteLength(value) > CACHE_MAX_BYTES) throw new Error('Argument too large: value');
      cacheStore.set(String(key), String(value));
    },
    putAll(map) { Object.keys(map).forEach(k => this.put(k, map[k])); },
    remove(key) { cacheStore.delete(String(key)); },
    removeAll(keys) { keys.forEach(k => cacheStore.delete(String(k))); },
  };
  const CacheService = { getScriptCache: () => scriptCache };

  const propStore = new Map(Object.entries(options.properties || {}));
  const scriptProperties = {
    getProperty: key => (propStore.has(String(key)) ? propStore.get(String(key)) : null),
    setProperty(key, value) {
      if (byteLength(value) > PROP_MAX_BYTES) throw new Error('Argument too large: value');
      propStore.set(String(key), String(value));
      return this;
    },
    setProperties(map, deleteOthers) {
      if (deleteOthers) propStore.clear();
      Object.keys(map).forEach(k => this.setProperty(k, map[k]));
      return this;
    },
    deleteProperty(key) { propStore.delete(String(key)); return this; },
    getProperties: () => Object.fromEntries(propStore),
    getKeys: () => Array.from(propStore.keys()),
  };
  const PropertiesService = { getScriptProperties: () => scriptProperties };

  /* --------------------------------- 其他服務 -------------------------------- */
  let lockDepth = 0;
  const lock = {
    waitLock() { lockDepth++; },
    tryLock() { lockDepth++; return true; },
    releaseLock() { lockDepth = Math.max(0, lockDepth - 1); },
    hasLock: () => lockDepth > 0,
  };
  const LockService = { getDocumentLock: () => lock, getScriptLock: () => lock };

  function wallParts(date, tz) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz || timeZone, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const out = {};
    fmt.formatToParts(date).forEach(p => { out[p.type] = p.value; });
    return out;
  }

  const Utilities = {
    formatDate(date, tz, format) {
      const p = wallParts(date, tz);
      return String(format).replace(/yyyy|MM|dd|HH|mm|ss|M|d|H/g, token => {
        switch (token) {
          case 'yyyy': return p.year;
          case 'MM': return p.month;
          case 'dd': return p.day;
          case 'HH': return p.hour;
          case 'mm': return p.minute;
          case 'ss': return p.second;
          case 'M': return String(Number(p.month));
          case 'd': return String(Number(p.day));
          case 'H': return String(Number(p.hour));
          default: return token;
        }
      });
    },
    parseDate(text, _tz, format) {
      if (format !== 'yyyy-MM-dd HH:mm:ss') throw new Error('模擬環境的 parseDate 只支援 yyyy-MM-dd HH:mm:ss');
      const m = String(text).match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
      if (!m) throw new Error('無法解析日期：' + text);
      return new DateCtor(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) - tzOffsetMs);
    },
    formatString(template, ...args) {
      let i = 0;
      return String(template).replace(/%(0?)(\d*)d|%s/g, (token, zero, width) => {
        const arg = args[i++];
        if (token === '%s') return String(arg);
        const text = String(Math.trunc(Number(arg)));
        return width ? text.padStart(Number(width), zero ? '0' : ' ') : text;
      });
    },
    newBlob(data) {
      const bytes = toByteArray(data);
      return { getBytes: () => bytes.slice(), getDataAsString: () => utf8Decoder.decode(Uint8Array.from(bytes)) };
    },
    base64Decode: base64ToBytes,
    base64Encode: bytesToBase64,
    sleep: () => {},
  };

  const user = email => ({ getEmail: () => email });
  const Session = {
    getScriptTimeZone: () => timeZone,
    getActiveUser: () => user(options.activeUserEmail == null ? 'owner@example.com' : options.activeUserEmail),
    getEffectiveUser: () => user(options.effectiveUserEmail == null ? 'owner@example.com' : options.effectiveUserEmail),
  };

  const ScriptApp = {
    getService: () => ({ getUrl: () => options.serviceUrl || '/' }),
    getScriptId: () => 'mock-script-id',
  };

  /* -------------------------------- HtmlService ------------------------------ */
  function readFile(name) {
    if (!Object.prototype.hasOwnProperty.call(files, name)) throw new Error('找不到 HTML 檔案：' + name);
    return typeof files[name] === 'function' ? files[name]() : files[name];
  }
  function htmlOutput(content) {
    const out = {
      content, title: '', metaTags: {}, faviconUrl: '', xFrame: null,
      getContent: () => out.content,
      setContent(c) { out.content = c; return out; },
      setTitle(t) { out.title = t; return out; },
      getTitle: () => out.title,
      addMetaTag(name, value) { out.metaTags[name] = value; return out; },
      setXFrameOptionsMode(mode) { out.xFrame = mode; return out; },
      setFaviconUrl(url) { out.faviconUrl = url; return out; },
      setSandboxMode: () => out,
    };
    return out;
  }
  let scriptletEvaluator = null;
  const HtmlService = {
    XFrameOptionsMode: { ALLOWALL: 'ALLOWALL', DEFAULT: 'DEFAULT' },
    SandboxMode: { IFRAME: 'IFRAME' },
    createHtmlOutputFromFile: name => htmlOutput(readFile(name)),
    createHtmlOutput: content => htmlOutput(String(content == null ? '' : content)),
    createTemplateFromFile(name) {
      const source = readFile(name);
      const template = {
        evaluate() {
          const vars = {};
          Object.keys(template).forEach(k => { if (k !== 'evaluate') vars[k] = template[k]; });
          const html = source.replace(/<\?(!=|=)?([\s\S]*?)\?>/g, (_, kind, code) => {
            if (!scriptletEvaluator) throw new Error('尚未載入後端程式，無法執行範本。');
            const value = scriptletEvaluator(kind ? '(' + code + ')' : code, vars);
            if (!kind) return '';
            const text = value == null ? '' : String(value);
            return kind === '!=' ? text : text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
          });
          return htmlOutput(html);
        },
      };
      return template;
    },
  };

  const ContentService = {
    MimeType: { JSON: 'application/json', TEXT: 'text/plain' },
    createTextOutput(text) {
      const out = {
        content: String(text == null ? '' : text), mimeType: 'text/plain',
        getContent: () => out.content,
        setMimeType(type) { out.mimeType = type; return out; },
        getMimeType: () => out.mimeType,
      };
      return out;
    },
  };

  const DriveApp = {
    Access: { ANYONE_WITH_LINK: 'ANYONE_WITH_LINK' },
    Permission: { VIEW: 'VIEW' },
    getFileById: () => ({ setTrashed: () => {} }),
    createFile: () => ({ getId: () => 'mock-file-id', setSharing: () => {} }),
  };

  const Logger = { log: (...args) => log('[Logger]', ...args) };
  const consoleProxy = {
    log: (...a) => log('[console.log]', ...a),
    warn: (...a) => log('[console.warn]', ...a),
    error: (...a) => log('[console.error]', ...a),
    info: (...a) => log('[console.info]', ...a),
  };

  const globals = {
    SpreadsheetApp, CacheService, PropertiesService, LockService, Utilities, Session, ScriptApp,
    HtmlService, ContentService, DriveApp, Logger, console: consoleProxy, Date: DateCtor,
    // 測試時可注入固定的亂數來源，讓產生的 ID 可重現。
    Math: options.random ? Object.assign(Object.create(Math), { random: options.random }) : Math,
  };

  /**
   * 載入後端原始碼（一或多個 .gs 的內容），回傳所有頂層函式：{ doGet, addExpense, … }。
   * 另外附上 __eval(原始碼) 供測試讀取頂層常數。
   */
  function load(source) {
    const names = new Set();
    const re = /^function\s+([A-Za-z_$][\w$]*)\s*\(/gm;
    let m;
    while ((m = re.exec(source))) names.add(m[1]);
    const exportsCode = Array.from(names).map(n => JSON.stringify(n) + ': ' + n).join(',\n');
    const body = source +
      '\n;function __evalScriptlet__(__src, __vars) { with (__vars || {}) { return eval(__src); } }' +
      '\nreturn { __eval: __evalScriptlet__,\n' + exportsCode + '\n};';
    const paramNames = Object.keys(globals);
    // eslint-disable-next-line no-new-func
    const factory = new Function(...paramNames, body);
    const api = factory(...paramNames.map(n => globals[n]));
    scriptletEvaluator = api.__eval;
    return api;
  }

  return {
    globals, load, spreadsheet, stats,
    cache: cacheStore, properties: propStore,
    clearCache: () => cacheStore.clear(),
    /** 把整本試算表（值／公式／格式）輸出成可比較的純物件。 */
    snapshot() {
      return spreadsheet.sheets.map(sheet => {
        const cells = {};
        Array.from(sheet.cells.keys()).sort().forEach(key => {
          const c = sheet.cells.get(key);
          if (c.v === '' && !c.f && !c.z) return;
          cells[key] = [c.v, c.f || '', c.z || ''];
        });
        return { name: sheet.name, hidden: sheet.hidden, maxRows: sheet.maxRows, maxCols: sheet.maxCols, cells };
      });
    },
  };
}
