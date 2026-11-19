// 合成的測試用試算表：版面與真實的記帳簿相同，但內容是固定的假資料。
// 這個檔案會隨原始碼公開：金額、日期、備註都必須是編出來的，不可以從真實的試算表照抄（同步時會比對）。
// 自動化測試用它（結果可重現、不含個人帳務）；專案根目錄沒有 .xlsx 時，本機預覽也會用它。
import { partsToSerial, colToNumber } from './format.mjs';

export function sheet(name, opts) {
  const o = opts || {};
  const cells = new Map();
  const api = {
    data: { name, hidden: Boolean(o.hidden), maxRows: o.maxRows || 1000, maxCols: o.maxCols || 26, cells },
    /** set('B5', 值, { f: 公式, z: 格式 }) */
    set(a1, v, extra) {
      const m = a1.match(/^([A-Z]+)(\d+)$/);
      const cell = Object.assign({ v: v == null ? '' : v }, extra || {});
      cells.set(Number(m[2]) + ',' + colToNumber(m[1]), cell);
      return api;
    },
    row(rowNumber, startCol, values, extra) {
      const start = colToNumber(startCol);
      values.forEach((v, i) => {
        if (v === '' || v == null) return;
        cells.set(rowNumber + ',' + (start + i), Object.assign({ v }, typeof v === 'number' ? (extra || {}) : {}));
      });
      return api;
    },
  };
  return api;
}

const MONEY = { z: '$0' };

export function monthSheet(name, expenses, incomes, opts) {
  const [year, month] = name.split('.').map(Number);
  const s = sheet(name, Object.assign({ maxRows: 1004 }, opts));
  s.set('A1', partsToSerial(year, month, 1), { z: 'yyyy/mm' });
  s.set('B2', '手動輸入區').set('B3', '支出').set('K3', '收入');
  s.row(4, 'B', ['日期', '支出項目', '支出總類', '支出方式', '是否已繳', '支出金額', '備註欄', '當日支出總金額']);
  s.row(4, 'K', ['日期', '收入項目', '收入總類', '收入金額', '備註欄']);
  (expenses || []).forEach((e, i) => s.row(5 + i, 'B', e, MONEY));
  (incomes || []).forEach((r, i) => s.row(5 + i, 'K', r, MONEY));
  // 「當日支出總金額」整欄都有公式，所以真實工作表的最後一列永遠是 1004。
  for (let r = 5; r <= 1004; r++) s.set('I' + r, r - 5 < (expenses || []).length ? 0 : ' ', { f: 'IF(ISBLANK(B' + r + ')," ",SUMIF(B:B,B' + r + ',G:G))', z: '$0' });

  const sum = (rows, idx, pred) => rows.filter(pred).reduce((a, r) => a + (Number(r[idx]) || 0), 0);
  const exp = expenses || [];
  const inc = incomes || [];
  const overview = [
    [3, 'S', '資產總覽', 4, 12345],
    [8, 'S', '當月生活費總收入', 9, sum(inc, 3, r => r[2] === '生活費')],
    [8, 'U', '當月存款總收入', 9, sum(inc, 3, r => r[2] === '存款')],
    [8, 'W', '當月代收代付總收入', 9, sum(inc, 3, r => r[2] === '代收代付')],
    [8, 'X', '當月總收入', 9, sum(inc, 3, () => true)],
    [12, 'S', '當月生活費總之出', 13, sum(exp, 5, r => r[2] === '生活費')],
    [12, 'U', '當月存款總之出', 13, sum(exp, 5, r => r[2] === '存款')],
    [12, 'W', '當月代收代付總之出', 13, sum(exp, 5, r => r[2] === '代收代付')],
    [12, 'X', '當月總之出', 13, sum(exp, 5, () => true)],
    [16, 'S', '累計生活費總收支', 17, 5000],
    [16, 'U', '累計存款總收支', 17, 7000],
    [16, 'W', '累計代收代付總收支', 17, 345],
    [16, 'X', '當月總收支', 17, sum(inc, 3, () => true) - sum(exp, 5, () => true)],
    [19, 'S', '本月現金總支出', 20, sum(exp, 5, r => r[3] === '現金')],
    [19, 'U', '本月 Line Pay 總支出', 20, sum(exp, 5, r => /Line Pay/.test(r[3]))],
    [19, 'W', '本月信用卡總支出', 20, sum(exp, 5, r => /信用卡/.test(r[3]))],
    [19, 'X', '本月信用卡支出已繳金額', 20, sum(exp, 5, r => /信用卡/.test(r[3]) && r[4] === 'O')],
    [19, 'Y', '累計信用卡支出未繳金額', 20, sum(exp, 5, r => /信用卡/.test(r[3]) && r[4] === 'X')],
  ];
  overview.forEach(([labelRow, col, label, valueRow, value]) => {
    s.set(col + labelRow, label);
    s.set(col + valueRow, value, { z: '$0', f: 'SUM(0)' });
  });
  return s.data;
}

function settingsSheet() {
  const s = sheet('資料選單設定區');
  s.row(1, 'A', ['日期', '支出項目', '收入項目', '支出總類', '收入總類', '支出方式', '是否已繳']);
  s.set('I1', '國外交易記帳簿資料選單區>').set('L1', '國家').set('M1', '幣別').set('N1', '交易項目');
  const expenseItems = ['早餐', '午餐', '晚餐', '飲料', '交通費', '娛樂', '房租', '其他'];
  const incomeItems = ['存款', '家裡', '薪資', '其他'];
  const categories = ['存款', '生活費', '代收代付'];
  const payments = ['現金', '信用卡-測試一卡', '信用卡-測試二卡', '簽帳卡-測試簽帳卡', 'Line Pay-測試一卡', '轉帳-測試銀行'];
  const countries = [['台灣', 'NTD'], ['日本', 'JPY'], ['韓國', 'KRW'], ['美國', 'USD']];
  const fxItems = ['餐飲', '交通費', '住宿', '購物', '其他'];
  for (let i = 0; i < 31; i++) s.set('A' + (i + 2), i + 1);
  expenseItems.forEach((v, i) => s.set('B' + (i + 2), v));
  incomeItems.forEach((v, i) => s.set('C' + (i + 2), v));
  categories.forEach((v, i) => { s.set('D' + (i + 2), v); s.set('E' + (i + 2), v); });
  payments.forEach((v, i) => s.set('F' + (i + 2), v));
  s.set('G2', 'O').set('G3', 'X');
  countries.forEach(([c, cur], i) => { s.set('L' + (i + 2), c); s.set('M' + (i + 2), cur); });
  fxItems.forEach((v, i) => s.set('N' + (i + 2), v));
  return s.data;
}

function settlementSheet() {
  const s = sheet('對帳系統');
  s.set('B2', '請輸入結帳日期日期-->').set('H2', partsToSerial(2026, 11, 9), { z: 'yyyy/M/d' });
  s.set('B3', '記帳簿餘額區').set('I3', '實際餘額輸入區');
  s.row(4, 'B', ['生活費餘額', '', '存款餘額', '', '代收代付餘額', '', '累計信用卡未繳金額', '現金', '', '銀行(山嵐銀行)', '', '銀行(北辰)', '', '銀行(晨光 Aurora)', '', '銀行(海悅)', '', '銀行(雲杉)', '', '銀行(青禾 )']);
  s.set('B5', 5000, { z: '$0', f: 'SUM(0)' }).set('C5', '+').set('D5', 7000, { z: '$0', f: 'SUM(0)' }).set('E5', '+')
    .set('F5', 345, { z: '$0', f: 'SUM(0)' }).set('H5', 900, { z: '$0', f: 'SUM(0)' });
  ['I', 'K', 'M', 'O', 'Q', 'S', 'U'].forEach(col => s.set(col + '5', '', { z: '[$$]#,##0' }));
  ['J', 'L', 'N', 'P', 'R', 'T'].forEach(col => s.set(col + '5', '+'));
  s.set('B7', '=').set('C7', '總餘額').set('I7', '=').set('J7', '總餘額');
  s.set('C8', 12345, { z: '$0', f: 'B5+D5+F5' }).set('J8', -900, { z: '[$$]#,##0', f: 'I5+K5+M5+O5+Q5+S5-H5+U5' });
  s.set('B10', '差額(右方總餘額-左方總餘額；+為溢、-為短缺)').set('I10', -13245, { z: '[$$]#,##0', f: 'J8-C8' });
  return s.data;
}

export function fxSheet(name, opts, records) {
  const s = sheet(name, opts);
  s.set('B1', '國外交易日常紀錄簿').set('E1', '日期：').set('F1', (opts && opts.period) || '').set('H1', '國家：').set('I1', (opts && opts.country) || '');
  s.row(2, 'B', ['日期', '交易項目', '交易方式', '幣別', '交易金額(當地金額)', '換算台幣金額', '備註']);
  s.set('J2', '匯率').set('L3', '各國匯率參考表');
  [['台灣', 'NTD', 1], ['日本', 'JPY', 0.21], ['韓國', 'KRW', 0.024], ['美國', 'USD', 32]].forEach(([c, cur, rate], i) => {
    s.set('L' + (4 + i), c).set('M' + (4 + i), cur).set('N' + (4 + i), rate);
  });
  for (let r = 3; r <= 60; r++) {
    const rec = (records || [])[r - 3];
    s.set('B' + r, rec ? partsToSerial(rec[0][0], rec[0][1], rec[0][2]) : '', { f: 'IF(C' + r + '="","", IF(B' + r + '="", TODAY(), B' + r + '))', z: 'yyyy/M/d' });
    if (rec) {
      s.set('C' + r, rec[1]).set('D' + r, rec[2]).set('E' + r, rec[3]).set('F' + r, rec[4], { z: '#,##0.00' }).set('H' + r, rec[6] || '');
    }
    s.set('G' + r, rec ? Math.round(rec[4] * rec[5] * 100) / 100 : '', { f: 'if(F' + r + '="","",F' + r + '*J' + r + ')', z: '#,##0.00' });
    s.set('J' + r, rec ? rec[5] : '', { f: 'IF(E' + r + '="","",VLOOKUP(E' + r + ',$M$4:$N$21,2,FALSE))' });
  }
  return s.data;
}

/**
 * 額外的合成支出（P06 的長清單量測與測試用）：照固定規則產生，內容全是編出來的。
 * 日期落在 1～12 日（不碰「今天」13 日，今日總花費不受影響），依日期排序後接在原本的 8 筆後面。
 */
export function syntheticExpenses(count) {
  const items = ['早餐', '午餐', '晚餐', '飲料', '交通費', '娛樂', '其他'];
  const payments = [['現金', ''], ['信用卡-測試一卡', 'X'], ['Line Pay-測試一卡', ''], ['信用卡-測試二卡', 'O'], ['簽帳卡-測試簽帳卡', '']];
  const notes = ['', '', '合成資料', '', '量測用'];
  const out = [];
  for (let i = 0; i < count; i++) {
    const pay = payments[i % payments.length];
    out.push([1 + (i % 12), items[(i * 3) % items.length], '生活費', pay[0], pay[1], 40 + ((i * 37) % 460), notes[i % notes.length]]);
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * 建立一本測試用的活頁簿（結構同 readXlsx() 的回傳值）。
 * opts.extraExpenses：2026.11 額外加幾筆合成支出（預設 0，維持原本的 8 筆）。
 */
export function createFixtureWorkbook(opts) {
  const extra = syntheticExpenses(Math.max(0, Number(opts && opts.extraExpenses) || 0));
  const nov = monthSheet('2026.11', [
    [1, '午餐', '生活費', '信用卡-測試一卡', 'X', 85, ''],
    [1, '晚餐', '生活費', '現金', '', 175, ''],
    [2, '午餐', '生活費', '現金', '', 110, ''],
    [2, '其他', '存款', '轉帳-測試銀行', '', 10000, '筆電分期'],
    [5, '娛樂', '生活費', '信用卡-測試二卡', 'X', 2860, 'KTV'],
    [6, '交通費', '生活費', 'Line Pay-測試一卡', '', 140, ''],
    [8, '飲料', '生活費', '現金', '', 65, '珍奶'],
    [9, '晚餐', '生活費', '信用卡-測試一卡', 'O', 320, '拉麵'],
  ].concat(extra), [
    [3, '其他', '生活費', 3000, '租屋補助'],
    [5, '薪資', '存款', 52000, '十一月薪資'],
  ]);
  const oct = monthSheet('2026.10', [
    [3, '早餐', '生活費', '現金', '', 55, ''],
    [15, '房租', '生活費', '轉帳-測試銀行', '', 12000, '十月房租'],
    [20, '午餐', '生活費', '信用卡-測試一卡', 'O', 150, '便當'],
  ], [
    [5, '薪資', '存款', 52000, '十月薪資'],
  ], { hidden: true });
  const template = monthSheet('新版記帳簿空白頁', [], []);

  const legacy = sheet('2024.10', { hidden: true, maxRows: 700, maxCols: 80 });
  legacy.set('B2', '舊版記帳簿').row(4, 'B', ['日期', '項目', '金額']);

  return {
    sheets: [
      legacy.data, oct, nov,
      fxSheet('國外交易記帳簿-韓國', { period: '2025/03/10~2025/03/16', country: '韓國' }, [
        [[2025, 3, 10], '交通費', '信用卡-測試一卡', 'NTD', 12600, 1, '機票'],
        [[2025, 3, 11], '餐飲', '現金', 'KRW', 12000, 0.024, '烤肉'],
        [[2025, 3, 12], '購物', '信用卡-測試二卡', 'KRW', 56000, 0.024, ''],
      ]),
      fxSheet('國外交易記帳簿-空白頁', {}, []),
      settlementSheet(), template, settingsSheet(),
    ],
  };
}
