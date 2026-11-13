// 測試共用工具：用模擬的 Apps Script 環境載入 dist/code.gs，資料是合成的測試試算表。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGasRuntime } from '../gas-mock/runtime.mjs';
import { createFixtureWorkbook } from '../gas-mock/fixture.mjs';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const DIST = path.join(ROOT, 'dist');

/** 固定在 2026-11-13 12:00（台北時間）的 Date，讓「今天」「本月」在測試中不會變。 */
function fixedDateClass(startMs) {
  let nowMs = startMs;
  class FixedDate extends Date {
    constructor(...args) { if (args.length === 0) super(nowMs); else super(...args); }
    static now() { return nowMs; }
  }
  FixedDate.advance = ms => { nowMs += ms; };
  return FixedDate;
}

export function createBackend(options) {
  const opts = options || {};
  const files = {};
  ['Index', 'style', 'app', 'assets'].forEach(name => {
    files[name] = () => fs.readFileSync(path.join(DIST, name + '.html'), 'utf8');
  });
  const DateCtor = fixedDateClass(Date.UTC(2026, 10, 13, 4, 0, 0));
  const logs = [];
  const runtime = createGasRuntime(Object.assign({
    workbook: createFixtureWorkbook(),
    files,
    DateCtor,
    log: (...args) => logs.push(args.join(' ')),
  }, opts));
  const fns = runtime.load(fs.readFileSync(path.join(DIST, 'code.gs'), 'utf8'));
  const sheet = name => runtime.spreadsheet.getSheetByName(name);
  return {
    runtime, fns, logs, sheet, DateCtor,
    /** 經由 API 閘道呼叫（與前端相同的路徑）。 */
    call: (action, ...args) => JSON.parse(JSON.stringify(fns.api({ action, args }) ?? null)),
    /** 讀取工作表上一列的值，例如 rowValues('2026.11', 13, 'B', 7)。 */
    rowValues(sheetName, row, startCol, width) {
      const col = startCol.charCodeAt(0) - 64;
      return sheet(sheetName).getRange(row, col, 1, width).getValues()[0];
    },
    post(body) {
      const out = fns.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
      return JSON.parse(out.getContent());
    },
  };
}

export const expenseForm = over => Object.assign({
  month: '2026.11', day: 13, item: '午餐', category: '生活費', payment: '現金', paid: '', amount: '120', note: '測試',
}, over);

export const incomeForm = over => Object.assign({
  month: '2026.11', day: 12, item: '薪資', category: '存款', amount: 5000, note: '',
}, over);
