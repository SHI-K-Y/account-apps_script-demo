// 公開 Demo 的範例資料：一本完全虛構的記帳簿（人物、金額、備註、銀行與卡片都是編出來的）。
//
// - 版面與真實的記帳簿相同（沿用 tools/gas-mock/fixture.mjs 的工作表建構函式）。
// - 依「今天」產生最近 6 個月的收支，所以不論哪一天打開 Demo，本月都有資料、趨勢圖都有 6 個月。
// - 用固定種子的亂數產生，同一天重新整理看到的內容完全相同。
// - 不依賴 Node 專用 API，瀏覽器裡也能執行。
//
// 這個檔案不得放入任何真實帳務：新增範例請直接在這裡編寫，不要從自己的試算表複製。
import { sheet, monthSheet, fxSheet } from '../gas-mock/fixture.mjs';
import { partsToSerial } from '../gas-mock/format.mjs';
import { cardArt, bankLogo } from './placeholder-art.mjs';

export const DEMO_MONTHS = 6;

/* --------------------------------- 選單與支付方式 --------------------------------- */
const BANKS = [
  { id: 'bank_demo_shanlan', name: '山嵐銀行', colors: ['#1f6f5c', '#0f3d35'] },
  { id: 'bank_demo_haiyue', name: '海悅銀行', colors: ['#2a5db0', '#16306b'] },
  { id: 'bank_demo_qinghe', name: '青禾銀行', colors: ['#3d6b2f', '#1f3a17'] },
];
const CARDS = [
  { id: 'card_demo_cashback', name: '山嵐現金回饋卡', type: 'credit', channels: ['信用卡'], issuer: '山嵐銀行', colors: ['#1f6f5c', '#0f3d35'] },
  { id: 'card_demo_wave', name: '海悅 Wave 信用卡', type: 'credit', channels: ['信用卡', 'Line Pay'], issuer: '海悅銀行', colors: ['#2a5db0', '#16306b'] },
  { id: 'card_demo_debit', name: '青禾簽帳卡', type: 'debit', channels: ['簽帳卡', 'Line Pay'], issuer: '青禾銀行', colors: ['#b5532a', '#6e2a12'] },
];
const CHANNELS = [
  { id: 'ch_linepay', name: 'Line Pay', color: '#06c755' },
  { id: 'ch_credit', name: '信用卡', color: '#2563eb' },
  { id: 'ch_debit', name: '簽帳卡', color: '#ea580c' },
];

const CASH = '現金';
const CC_CASHBACK = '信用卡-山嵐現金回饋卡';
const CC_WAVE = '信用卡-海悅 Wave 信用卡';
const LP_WAVE = 'Line Pay-海悅 Wave 信用卡';
const LP_DEBIT = 'Line Pay-青禾簽帳卡';
const DEBIT = '簽帳卡-青禾簽帳卡';
const TRANSFER_SHANLAN = '轉帳-山嵐銀行';
const TRANSFER_QINGHE = '轉帳-青禾銀行';

const OPTIONS = {
  expenseItems: ['早餐', '午餐', '晚餐', '飲料', '點心', '交通費', '日用品', '娛樂', '電信費', '水電費', '房租', '投資', '代墊款項', '其他'],
  incomeItems: ['薪資', '投資', '代墊款項', '其他'],
  categories: ['生活費', '存款', '代收代付'],
  paymentMethods: [CASH, CC_CASHBACK, CC_WAVE, LP_WAVE, LP_DEBIT, DEBIT, TRANSFER_SHANLAN, TRANSFER_QINGHE],
  countries: [['台灣', 'NTD'], ['日本', 'JPY'], ['韓國', 'KRW'], ['美國', 'USD']],
  fxItems: ['餐飲', '交通費', '住宿', '購物', '門票', '其他'],
};

/** 期初餘額：範例資料最早一個月之前就有的錢。 */
const OPENING = { 生活費: 6400, 存款: 248000, 代收代付: 0, unpaid: 0 };

/* ------------------------------------ 小工具 ------------------------------------ */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad2 = n => (n < 10 ? '0' + n : String(n));
const monthName = (y, m) => y + '.' + pad2(m);
const daysIn = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const weekdayOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();

function shiftMonth(y, m, delta) {
  const index = y * 12 + (m - 1) + delta;
  return { y: Math.floor(index / 12), m: index - Math.floor(index / 12) * 12 + 1 };
}

function shiftDays(date, delta) {
  const d = new Date(Date.UTC(date.y, date.m - 1, date.d + delta));
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/* --------------------------------- 單月收支產生器 --------------------------------- */
/**
 * 產生某個月的支出與收入。
 * @param {number} lastDay  只產生到這一天（本月只到今天，過去的月份是整個月）
 * @param {number} age      距離本月幾個月（0 = 本月）；用來決定信用卡消費繳了沒
 */
function generateMonth(y, m, lastDay, age) {
  const rnd = mulberry32(y * 100 + m);
  const chance = p => rnd() < p;
  const pick = list => list[Math.floor(rnd() * list.length)];
  const between = (min, max, step) => min + Math.floor(rnd() * (Math.floor((max - min) / (step || 1)) + 1)) * (step || 1);
  const expenses = [];
  const incomes = [];

  // 信用卡消費：本月的都還沒繳；上個月下旬的還沒到繳款日；更早的都繳清了。
  const paidCode = (payment, day) => {
    if (!payment.includes('信用卡')) return '';
    if (age === 0) return 'X';
    return age === 1 && day > 22 ? 'X' : 'O';
  };
  const spend = (day, item, category, payment, amount, note) => {
    if (day <= lastDay) expenses.push([day, item, category, payment, paidCode(payment, day), amount, note || '']);
  };
  const earn = (day, item, category, amount, note) => {
    if (day <= lastDay) incomes.push([day, item, category, amount, note || '']);
  };

  const bigPurchase = chance(0.5) ? { day: between(11, 26), amount: between(2400, 8900, 100), note: pick(['藍牙耳機', '冬季外套', '機車保養', '人體工學椅', '行李箱']) } : null;
  const groupBuy = chance(0.6) ? { day: between(9, 21), amount: between(480, 1980, 10), note: pick(['幫同事團購咖啡豆', '代訂聚餐', '代買演唱會門票']) } : null;
  const dividend = m % 3 === 0 ? between(800, 2600, 10) : 0;
  const utilities = m % 2 === 0 ? between(980, 1680, 10) : 0;

  for (let day = 1; day <= lastDay; day++) {
    const weekday = weekdayOf(y, m, day);
    const weekend = weekday === 0 || weekday === 6;

    // 固定收支
    if (day === 1) spend(day, '房租', '生活費', TRANSFER_QINGHE, 12500, m + ' 月房租');
    if (day === 2) spend(day, '交通費', '生活費', DEBIT, 1200, '通勤月票');
    if (day === 5) {
      earn(day, '薪資', '生活費', 31000, '本月生活費額度');
      earn(day, '薪資', '存款', 27000, '本月儲蓄');
    }
    if (day === 6) spend(day, '投資', '存款', TRANSFER_SHANLAN, 6000, '定期定額');
    if (day === 8) spend(day, '電信費', '生活費', CC_CASHBACK, 599, '手機月租');
    if (day === 10) spend(day, '娛樂', '生活費', CC_WAVE, 149, '音樂串流月費');
    if (day === 12) spend(day, '娛樂', '生活費', CC_WAVE, 390, '影音串流月費');
    if (day === 15 && utilities) spend(day, '水電費', '生活費', TRANSFER_QINGHE, utilities, '水電瓦斯');
    if (day === 15 && m % 6 === 1) earn(day, '薪資', '存款', 24000, '績效獎金');
    if (day === 18 && dividend) earn(day, '投資', '存款', dividend, '股利入帳');
    if (bigPurchase && day === bigPurchase.day) spend(day, '其他', '存款', CC_CASHBACK, bigPurchase.amount, bigPurchase.note);
    if (groupBuy && day === groupBuy.day) spend(day, '代墊款項', '代收代付', CC_WAVE, groupBuy.amount, groupBuy.note);
    if (groupBuy && day === groupBuy.day + 3) earn(day, '代墊款項', '代收代付', groupBuy.amount, '同事還款');

    // 日常三餐與零星開銷
    if (chance(weekend ? 0.3 : 0.62)) {
      spend(day, '早餐', '生活費', pick([CASH, CASH, LP_DEBIT]), between(40, 95, 5), pick(['蛋餅＋豆漿', '飯糰', '超商咖啡', '吐司', '']));
    }
    if (chance(0.9)) {
      spend(day, '午餐', '生活費', pick([CASH, LP_WAVE, LP_DEBIT, CC_WAVE]), between(85, 180, 5), pick(['便當', '自助餐', '牛肉麵', '咖哩飯', '', '']));
    }
    if (chance(0.85)) {
      const amount = weekend ? between(180, 620, 10) : between(100, 260, 5);
      spend(day, '晚餐', '生活費', pick([CASH, LP_WAVE, CC_CASHBACK, CC_WAVE]), amount, pick(['拉麵', '滷肉飯', '火鍋', '義大利麵', '水餃', '', '']));
    }
    if (chance(0.38)) spend(day, '飲料', '生活費', pick([CASH, LP_DEBIT]), between(35, 80, 5), pick(['手搖', '拿鐵', '', '']));
    if (chance(0.12)) spend(day, '點心', '生活費', CASH, between(45, 150, 5), pick(['雞蛋糕', '麵包', '']));
    if (chance(0.05)) spend(day, '交通費', '生活費', CC_WAVE, between(150, 360, 5), '計程車');
    if (chance(0.06)) spend(day, '交通費', '生活費', CASH, between(120, 220, 10), '機車加油');
    if (chance(0.08)) {
      spend(day, '日用品', '生活費', pick([CC_CASHBACK, LP_WAVE, CASH]), between(89, 890), pick(['衛生紙、洗衣精', '藥妝店', '超市採買', '清潔用品']));
    }
    if (weekend && chance(0.25)) {
      spend(day, '娛樂', '生活費', pick([CC_CASHBACK, CC_WAVE]), between(280, 1400, 10), pick(['電影', 'KTV', '展覽門票', '桌遊店', '書店']));
    }
  }
  return { expenses, incomes };
}

/* ----------------------------------- 其他工作表 ----------------------------------- */
function settingsSheet() {
  const s = sheet('資料選單設定區');
  s.row(1, 'A', ['日期', '支出項目', '收入項目', '支出總類', '收入總類', '支出方式', '是否已繳']);
  s.set('I1', '國外交易記帳簿資料選單區>').set('L1', '國家').set('M1', '幣別').set('N1', '交易項目');
  for (let i = 0; i < 31; i++) s.set('A' + (i + 2), i + 1);
  OPTIONS.expenseItems.forEach((v, i) => s.set('B' + (i + 2), v));
  OPTIONS.incomeItems.forEach((v, i) => s.set('C' + (i + 2), v));
  OPTIONS.categories.forEach((v, i) => { s.set('D' + (i + 2), v); s.set('E' + (i + 2), v); });
  OPTIONS.paymentMethods.forEach((v, i) => s.set('F' + (i + 2), v));
  s.set('G2', 'O').set('G3', 'X');
  OPTIONS.countries.forEach(([country, currency], i) => { s.set('L' + (i + 2), country); s.set('M' + (i + 2), currency); });
  OPTIONS.fxItems.forEach((v, i) => s.set('N' + (i + 2), v));
  return s.data;
}

/** 對帳工作表。左邊的帳面餘額由 recalc 計算；右邊的實際餘額先填一組「差一點點」的數字當範例。 */
function settlementSheet(today, actuals) {
  const s = sheet('對帳系統');
  s.set('B2', '請輸入結帳日期日期-->').set('H2', partsToSerial(today.y, today.m, today.d), { z: 'yyyy/M/d' });
  s.set('B3', '記帳簿餘額區').set('I3', '實際餘額輸入區');
  s.row(4, 'B', [
    '生活費餘額', '', '存款餘額', '', '代收代付餘額', '', '累計信用卡未繳金額',
    '現金', '', '銀行(山嵐銀行)', '', '銀行(海悅銀行)', '', '銀行(青禾銀行)', '', '銀行(備用帳戶一)', '', '銀行(備用帳戶二)', '', '銀行(備用帳戶三)',
  ]);
  s.set('B5', 0, { z: '$0', f: 'SUM(0)' }).set('C5', '+').set('D5', 0, { z: '$0', f: 'SUM(0)' }).set('E5', '+')
    .set('F5', 0, { z: '$0', f: 'SUM(0)' }).set('H5', 0, { z: '$0', f: 'SUM(0)' });
  ['I', 'K', 'M', 'O', 'Q', 'S', 'U'].forEach((col, i) => s.set(col + '5', actuals[i] == null ? '' : actuals[i], { z: '[$$]#,##0' }));
  ['J', 'L', 'N', 'P', 'R', 'T'].forEach(col => s.set(col + '5', '+'));
  s.set('B7', '=').set('C7', '總餘額').set('I7', '=').set('J7', '總餘額');
  s.set('C8', 0, { z: '$0', f: 'B5+D5+F5' }).set('J8', 0, { z: '[$$]#,##0', f: 'I5+K5+M5+O5+Q5+S5-H5+U5' });
  s.set('B10', '差額(右方總餘額-左方總餘額；+為溢、-為短缺)').set('I10', 0, { z: '[$$]#,##0', f: 'J8-C8' });
  return s.data;
}

/** 一趟虛構的東京行，日期落在兩個多月前。 */
function tripSheet(today) {
  const start = shiftDays(today, -74);
  const day = n => { const d = shiftDays(start, n); return [d.y, d.m, d.d]; };
  const iso = d => d.y + '/' + pad2(d.m) + '/' + pad2(d.d);
  const JPY = 0.21;
  return fxSheet('國外交易記帳簿-東京五日', { period: iso(start) + '~' + iso(shiftDays(start, 4)), country: '日本' }, [
    [day(0), '交通費', CC_CASHBACK, 'NTD', 12800, 1, '機票'],
    [day(0), '交通費', '現金', 'JPY', 3070, JPY, '機場快線'],
    [day(0), '住宿', CC_WAVE, 'JPY', 46800, JPY, '四晚商務旅館'],
    [day(0), '餐飲', '現金', 'JPY', 1180, JPY, '拉麵'],
    [day(1), '門票', CC_WAVE, 'JPY', 3200, JPY, '展望台'],
    [day(1), '餐飲', '現金', 'JPY', 2400, JPY, '迴轉壽司'],
    [day(1), '交通費', '現金', 'JPY', 1000, JPY, '交通卡加值'],
    [day(2), '購物', CC_CASHBACK, 'JPY', 15800, JPY, '藥妝與伴手禮'],
    [day(2), '餐飲', '現金', 'JPY', 3600, JPY, '燒肉'],
    [day(3), '門票', CC_WAVE, 'JPY', 2500, JPY, '美術館'],
    [day(3), '餐飲', CC_WAVE, 'JPY', 5200, JPY, '居酒屋'],
    [day(4), '購物', '現金', 'JPY', 4300, JPY, '機場免稅店'],
  ]);
}

/**
 * 預算設定（隱藏的「_預算設定」工作表，版面同 src/server/33_budget.gs）。
 * 五個月前起每月 30,000，本月起調成 31,000：訪客一打開就看得到「今天還能花」與預算進度條，
 * 切到過去月份則看得到「預算與實際」（有的月份略超、有的略省）。房租與電信費先預留，不影響每日額度。
 */
function budgetSheet(today) {
  const s = sheet('_預算設定', { hidden: true });
  s.row(1, 'A', ['起始月份', '預算來源', '每月預算', '計入總類', '收入項目', '不計入每日額度的項目', '更新時間']);
  const first = shiftMonth(today.y, today.m, -(DEMO_MONTHS - 1));
  const reserves = '房租=12500；電信費=599';
  s.row(2, 'A', [monthName(first.y, first.m), '固定金額', 30000, '生活費', '', reserves]);
  s.row(3, 'A', [monthName(today.y, today.m), '固定金額', 31000, '生活費', '', reserves]);
  return s.data;
}

function settingsMetadata() {
  return {
    emojis: {},
    itemEmojis: {},
    channelColors: Object.fromEntries(CHANNELS.map(ch => [ch.name, ch.color])),
    channels: CHANNELS,
    cards: CARDS.map(c => ({ id: c.id, name: c.name, type: c.type, imageKey: '', channels: c.channels })),
    banks: BANKS.map(b => ({ id: b.id, name: b.name, logoKey: '' })),
    quickCombos: [
      { id: 'qc_demo_lunch', type: 'expense', title: '午餐便當', item: '午餐', category: '生活費', payment: CASH, paid: '', amount: '110', updatedAt: 1 },
      { id: 'qc_demo_drink', type: 'expense', title: '下午手搖', item: '飲料', category: '生活費', payment: LP_DEBIT, paid: '', amount: '60', updatedAt: 1 },
      { id: 'qc_demo_dinner', type: 'expense', title: '晚餐刷卡', item: '晚餐', category: '生活費', payment: CC_WAVE, paid: 'X', amount: '', updatedAt: 1 },
    ],
  };
}

/**
 * 建立 Demo 用的活頁簿。
 * @param {{ y: number, m: number, d: number }} today  訪客當地的今天
 * @returns {{ workbook: { sheets: object[] }, properties: object, opening: object }}
 *   workbook    給 createGasRuntime({ workbook }) 使用
 *   properties  預先寫入的指令碼屬性（支付方式的卡片、銀行與常用組合）
 *   opening     期初餘額，給 createRecalc({ opening }) 使用
 */
export function createDemoWorkbook(today) {
  const months = [];
  const balance = { 生活費: OPENING.生活費, 存款: OPENING.存款, 代收代付: OPENING.代收代付 };
  let unpaid = OPENING.unpaid;

  for (let age = DEMO_MONTHS - 1; age >= 0; age--) {
    const { y, m } = shiftMonth(today.y, today.m, -age);
    const lastDay = age === 0 ? today.d : daysIn(y, m);
    const data = generateMonth(y, m, lastDay, age);
    data.incomes.forEach(r => { balance[r[2]] += r[3]; });
    data.expenses.forEach(r => {
      balance[r[2]] -= r[5];
      if (r[3].includes('信用卡') && r[4] === 'X') unpaid += r[5];
    });
    months.push(monthSheet(monthName(y, m), data.expenses, data.incomes));
  }

  // 實際餘額：帳面總額加上還沒繳的卡費（錢還在戶頭裡），再故意少 126 元，讓對帳頁有差額可看。
  const actualTotal = balance.生活費 + balance.存款 + balance.代收代付 + unpaid - 126;
  const cash = 2350;
  const shanlan = Math.round((actualTotal - cash) * 0.46);
  const qinghe = Math.round((actualTotal - cash) * 0.21);
  const haiyue = actualTotal - cash - shanlan - qinghe;

  const properties = { SETTINGS_METADATA_V2: JSON.stringify(settingsMetadata()) };
  CARDS.forEach(c => {
    properties['IMG_CARD_' + c.id] = cardArt({ title: c.name, issuer: c.issuer, kind: c.type === 'debit' ? 'DEBIT' : 'CREDIT', colors: c.colors });
  });
  BANKS.forEach(b => { properties['IMG_BANK_' + b.id] = bankLogo({ name: b.name, colors: b.colors }); });

  return {
    workbook: {
      sheets: months.concat([
        tripSheet(today),
        fxSheet('國外交易記帳簿-空白頁', {}, []),
        settlementSheet(today, [cash, shanlan, haiyue, qinghe]),
        monthSheet('新版記帳簿空白頁', [], []),
        settingsSheet(),
        budgetSheet(today),
      ]),
    },
    properties,
    opening: Object.assign({}, OPENING),
  };
}
