// 公式重算：模擬環境不會計算試算表公式，這裡用程式重現記帳簿裡「會隨記帳變動」的那些公式格，
// 讓公開 Demo 的總覽、對帳、國外帳簿數字在訪客新增／修改／刪除紀錄後立刻更新。
//
// 對應的試算表公式（位置與真實的記帳簿相同）：
//   月份工作表
//     S9 / U9 / W9     當月各總類收入      =SUMIF(M:M, 總類, N:N)          X9  = 合計
//     S13 / U13 / W13  當月各總類支出      =SUMIF(D:D, 總類, G:G)          X13 = 合計
//     S17 / U17 / W17  累計各總類收支      = 上個月的同一格 + (收入 − 支出)   X17 = X9 − X13
//     S4               資產總覽            = S17 + U17 + W17
//     S20 現金、U20 Line Pay、W20 信用卡、X20 信用卡已繳、Y20 累計信用卡未繳（= 上個月 Y20 + 本月未繳）
//     I 欄             當日支出總金額      =SUMIF(B:B, 當列日期, G:G)
//   對帳工作表
//     B5 / D5 / F5 / H5 = 結帳日期（H2）所在月份的 S17 / U17 / W17 / Y20
//     C8 = B5+D5+F5    J8 = 實際餘額合計 − H5    I10 = J8 − C8
//   國外交易帳簿
//     G 欄 換算台幣金額 = 交易金額 × 匯率
//
// 由 tools/gas-mock/runtime.mjs 的 recalc 選項呼叫：recalc(spreadsheet)。
import { serialToParts, isDateFormat } from '../gas-mock/format.mjs';

const MONTH_RE = /^\d{4}\.\d{2}$/;
const SETTLEMENT_NAMES = ['對帳系統', '結帳系統'];
const FX_PREFIX = '國外交易記帳簿-';
const FIRST_ROW = 5;
const LAST_ROW = 1004;
const CATEGORIES = [['生活費', 19], ['存款', 21], ['代收代付', 23]]; // 總類 → 欄號（S / U / W）
const MONEY_FORMAT = '$0';

const text = v => (v == null ? '' : String(v).trim());
const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : (Number(String(v == null ? '' : v).replace(/[^0-9.\-]/g, '')) || 0));
const cellValue = (sheet, row, col) => {
  const cell = sheet.cells.get(row + ',' + col);
  return cell ? cell.v : '';
};

/** 直接改格子的值（保留原本的公式與格式），不經過 Range，避免又觸發一次重算。 */
function put(sheet, row, col, value, format) {
  const key = row + ',' + col;
  const cell = sheet.cells.get(key);
  if (cell) { cell.v = value; if (!cell.z && format) cell.z = format; }
  else sheet.cells.set(key, format ? { v: value, z: format } : { v: value });
}

function isLedgerSheet(sheet) {
  return MONTH_RE.test(sheet.name) && text(cellValue(sheet, 4, 3)) === '支出項目' && text(cellValue(sheet, 4, 12)) === '收入項目';
}

function recalcMonth(sheet, carry) {
  // 一次掃過所有格子，把記帳區（B～H、K～O）依列收集起來。
  const rows = new Map();
  for (const [key, cell] of sheet.cells) {
    const comma = key.indexOf(',');
    const row = Number(key.slice(0, comma));
    const col = Number(key.slice(comma + 1));
    if (row < FIRST_ROW || row > LAST_ROW || col < 2 || col > 15 || col === 9) continue;
    if (cell.v === '' || cell.v == null) continue;
    let rec = rows.get(row);
    if (!rec) { rec = {}; rows.set(row, rec); }
    rec[col] = cell.v;
  }

  const income = { 生活費: 0, 存款: 0, 代收代付: 0 };
  const expense = { 生活費: 0, 存款: 0, 代收代付: 0 };
  const daily = new Map();
  let cash = 0, linePay = 0, credit = 0, creditPaid = 0, creditUnpaid = 0;

  rows.forEach(rec => {
    const amount = num(rec[7]);
    if (amount) {
      const category = text(rec[4]);
      if (category in expense) expense[category] += amount;
      const payment = text(rec[5]);
      if (payment === '現金') cash += amount;
      if (/line pay/i.test(payment)) linePay += amount;
      if (payment.includes('信用卡')) {
        credit += amount;
        const paid = text(rec[6]).toUpperCase();
        if (paid === 'O') creditPaid += amount;
        if (paid === 'X') creditUnpaid += amount;
      }
      const day = text(rec[2]);
      if (day) daily.set(day, (daily.get(day) || 0) + amount);
    }
    const incomeAmount = num(rec[14]);
    if (incomeAmount) {
      const category = text(rec[13]);
      if (category in income) income[category] += incomeAmount;
    }
  });

  const balance = {};
  CATEGORIES.forEach(([category, col]) => {
    balance[category] = (carry.balance[category] || 0) + income[category] - expense[category];
    put(sheet, 9, col, income[category], MONEY_FORMAT);
    put(sheet, 13, col, expense[category], MONEY_FORMAT);
    put(sheet, 17, col, balance[category], MONEY_FORMAT);
  });
  const totalIncome = income.生活費 + income.存款 + income.代收代付;
  const totalExpense = expense.生活費 + expense.存款 + expense.代收代付;
  const unpaid = (carry.unpaid || 0) + creditUnpaid;
  put(sheet, 9, 24, totalIncome, MONEY_FORMAT);
  put(sheet, 13, 24, totalExpense, MONEY_FORMAT);
  put(sheet, 17, 24, totalIncome - totalExpense, MONEY_FORMAT);
  put(sheet, 4, 19, balance.生活費 + balance.存款 + balance.代收代付, MONEY_FORMAT);
  put(sheet, 20, 19, cash, MONEY_FORMAT);
  put(sheet, 20, 21, linePay, MONEY_FORMAT);
  put(sheet, 20, 23, credit, MONEY_FORMAT);
  put(sheet, 20, 24, creditPaid, MONEY_FORMAT);
  put(sheet, 20, 25, unpaid, MONEY_FORMAT);

  // I 欄（當日支出總金額）：有日期的列顯示當天合計，其餘維持公式原本的空白字元。
  for (const [key, cell] of sheet.cells) {
    if (!key.endsWith(',9')) continue;
    const row = Number(key.slice(0, key.indexOf(',')));
    if (row < FIRST_ROW || row > LAST_ROW) continue;
    const rec = rows.get(row);
    const day = rec ? text(rec[2]) : '';
    cell.v = day ? (daily.get(day) || 0) : ' ';
  }

  return { balance, unpaid };
}

function monthOfCell(cell) {
  if (!cell || cell.v === '' || cell.v == null) return '';
  if (typeof cell.v === 'number' && isDateFormat(cell.z)) {
    const p = serialToParts(cell.v);
    return p.y + '.' + (p.mo < 10 ? '0' + p.mo : p.mo);
  }
  const m = String(cell.v).match(/^(\d{4})[-/.](\d{1,2})/);
  return m ? m[1] + '.' + (m[2].length < 2 ? '0' + m[2] : m[2]) : '';
}

function recalcSettlement(sheet, results) {
  // 結帳日期所在的月份還沒有工作表時，沿用它之前最近的一個月（真實試算表會顯示 #REF!）。
  const target = monthOfCell(sheet.cells.get('2,8'));
  const months = Array.from(results.keys()).sort();
  let source = null;
  for (let i = months.length - 1; i >= 0 && !source; i--) {
    if (!target || months[i] <= target) source = results.get(months[i]);
  }
  const living = source ? source.balance.生活費 : 0;
  const savings = source ? source.balance.存款 : 0;
  const agency = source ? source.balance.代收代付 : 0;
  const unpaid = source ? source.unpaid : 0;
  put(sheet, 5, 2, living, MONEY_FORMAT);
  put(sheet, 5, 4, savings, MONEY_FORMAT);
  put(sheet, 5, 6, agency, MONEY_FORMAT);
  put(sheet, 5, 8, unpaid, MONEY_FORMAT);

  const ledgerTotal = living + savings + agency;
  let actual = 0;
  [9, 11, 13, 15, 17, 19, 21].forEach(col => { actual += num(cellValue(sheet, 5, col)); });
  put(sheet, 8, 3, ledgerTotal, MONEY_FORMAT);
  put(sheet, 8, 10, actual - unpaid, '[$$]#,##0');
  put(sheet, 10, 9, actual - unpaid - ledgerTotal, '[$$]#,##0');
}

function recalcFx(sheet) {
  for (const [key, cell] of sheet.cells) {
    if (!key.endsWith(',7')) continue;
    const row = Number(key.slice(0, key.indexOf(',')));
    if (row < 3) continue;
    const amount = cellValue(sheet, row, 6);
    cell.v = amount === '' || amount == null ? '' : Math.round(num(amount) * num(cellValue(sheet, row, 10)) * 100) / 100;
  }
}

/**
 * 建立重算函式。
 * @param {object} [opts]
 *   opening  最早一個月之前的期初餘額：{ 生活費, 存款, 代收代付, unpaid }（預設都是 0）
 */
export function createRecalc(opts) {
  const opening = (opts && opts.opening) || {};
  const openingCarry = {
    balance: { 生活費: num(opening.生活費), 存款: num(opening.存款), 代收代付: num(opening.代收代付) },
    unpaid: num(opening.unpaid),
  };

  return function recalc(spreadsheet) {
    const ledgers = spreadsheet.sheets.filter(isLedgerSheet).sort((a, b) => (a.name < b.name ? -1 : 1));
    const results = new Map();
    let carry = openingCarry;
    ledgers.forEach(sheet => {
      // 真實公式是接續「上個月」的工作表；中間缺月份時，這裡改接續前一張存在的月份，數字才不會歸零。
      carry = recalcMonth(sheet, carry);
      results.set(sheet.name, carry);
    });
    spreadsheet.sheets.forEach(sheet => {
      if (SETTLEMENT_NAMES.includes(sheet.name)) recalcSettlement(sheet, results);
      else if (sheet.name.startsWith(FX_PREFIX)) recalcFx(sheet);
    });
  };
}
