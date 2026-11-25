/**
 * 預算設定：設定頁的讀取、儲存與移除（工作表版面見 33_budget.gs）。
 * 只能設定本月或之後的月份，過去月份的預算不會被回溯改動。
 *
 * 「不計入每日額度的項目」的備註不放進「_預算設定」（版面不動），存在 settings metadata 的 budgetReserveNotes：
 *   { '房租': '每月 5 日轉帳給房東', … }
 * 以項目為單位，各月份的設定共用；沒有任何月份的設定用到的項目，儲存時一併清掉。前端直接從 metadata 讀（隨啟動資料帶著）。
 */
const BUDGET_MAX_LIST_ = 20;
const BUDGET_NOTE_MAX_LENGTH_ = 100;
const BUDGET_MAX_AMOUNT_ = 999999999;
const BUDGET_NAME_FORBIDDEN_ = /[=；;、,，\n]/;

/**
 * 設定頁的預算資料。先查快取（P11）：預算設定、本月明細、本月月初餘額一次 getAll 讀回，全部命中就不開試算表。
 */
function getBudgetSettings_(forceRefresh) {
  const isForce = Boolean(forceRefresh);
  const today = budgetToday_();
  let prefetched = null;
  let config = null;
  if (!isForce) {
    const K = CONFIG.CACHE_KEYS;
    const openingKey = K.BUDGET_OPENING_PREFIX + today.month;
    const got = cacheGetAllMixed_([K.MONTH_DATA_PREFIX + today.month], [K.BUDGET_CONFIG, openingKey]);
    prefetched = { monthData: got.large[K.MONTH_DATA_PREFIX + today.month], openingJson: got.plain[openingKey] };
    try {
      const parsed = got.plain[K.BUDGET_CONFIG] ? JSON.parse(got.plain[K.BUDGET_CONFIG]) : null;
      if (parsed && Array.isArray(parsed.versions)) config = parsed;
    } catch (e) { config = null; }
  }
  if (!config) config = readBudgetConfig_(null, isForce);
  return {
    todayISO: today.iso,
    currentMonth: today.month,
    versions: config.versions,
    status: currentBudgetStatus_(null, config, today, isForce, prefetched),
  };
}

/**
 * 本月的預算狀態。ss 可以是 null：明細與月初餘額都在快取時不開試算表。
 * @param prefetched  選用：{ monthData, openingJson }（已經從快取讀回的）
 */
function currentBudgetStatus_(ss, config, today, forceRefresh, prefetched) {
  let monthData = (!forceRefresh && prefetched && prefetched.monthData) || null;
  if (!monthData && !forceRefresh && !prefetched) monthData = getCachedMonthData_(today.month);
  if (!monthData) {
    try {
      const spreadsheet = ss || getSpreadsheet_();
      if (spreadsheet.getSheetByName(today.month)) monthData = getMonthData_(spreadsheet, today.month, true);
    } catch (e) {}
  }
  const version = resolveBudgetVersion_(config, today.month);
  let extras = null;
  try {
    const opening = !forceRefresh && version && version.source === 'balance' ? parseBudgetOpeningCache_(prefetched && prefetched.openingJson) : undefined;
    extras = opening !== undefined ? { scheduled: scheduledForMonth_(today.month), openingBalance: opening } : budgetExtras_(ss, version, today.month, forceRefresh);
  } catch (e) {}
  return computeBudgetStatus_(version, today.month, monthData, today, extras);
}

function assertBudgetMonth_(month, today) {
  validateMonthFormat_(month);
  if (month < today.month) {
    throw new Error('只能設定本月（' + today.month + '）或之後的月份，過去月份的預算不會被更改。');
  }
}

function budgetAmountOrThrow_(value, label) {
  const text = String(value == null ? '' : value).replace(/[,\s]/g, '');
  if (!text) throw new Error('請輸入' + label + '。');
  const num = Number(text);
  if (!Number.isFinite(num) || num < 0) throw new Error(label + '必須是 0 以上的數字。');
  if (num > BUDGET_MAX_AMOUNT_) throw new Error(label + '過大。');
  return Math.round(num * 100) / 100;
}

function budgetNameList_(values, allowed, label) {
  if (values != null && !Array.isArray(values)) throw new Error(label + '格式錯誤。');
  const seen = new Set();
  const out = [];
  (values || []).forEach(function (raw) {
    const name = stripEmoji_(String(raw == null ? '' : raw).trim());
    if (!name || seen.has(name)) return;
    if (BUDGET_NAME_FORBIDDEN_.test(name)) throw new Error(label + '「' + name + '」含有不支援的符號。');
    validateOption_(name, allowed, label);
    seen.add(name);
    out.push(name);
  });
  if (out.length > BUDGET_MAX_LIST_) throw new Error(label + '最多 ' + BUDGET_MAX_LIST_ + ' 個。');
  return out;
}

/** 驗證表單並轉成一個設定版本。 */
function parseBudgetForm_(form, options, today) {
  const month = String(form.month || '').trim();
  assertBudgetMonth_(month, today);
  const source = budgetSourceKey_(form.source);
  if (!source) throw new Error('預算來源只能是固定金額、生活費收入、生活費餘額或停用。');

  const version = { month: month, source: source, amount: 0, categories: [], incomeItems: [], reserves: [], excludedItems: [] };
  if (source === 'off') return version;

  if (source === 'fixed') version.amount = budgetAmountOrThrow_(form.amount, '每月預算');
  version.categories = budgetNameList_(form.categories, options.expenseCategories || [], '支出總類');
  if (!version.categories.length) throw new Error('請至少選擇一個計入預算的總類。');
  if (source === 'income') version.incomeItems = budgetNameList_(form.incomeItems, options.incomeItems || [], '收入項目');

  if (form.reserves != null && !Array.isArray(form.reserves)) throw new Error('不計入每日額度的項目格式錯誤。');
  const reserveItems = budgetNameList_((form.reserves || []).map(function (r) { return r && r.item; }), options.expenseItems || [], '支出項目');
  version.reserves = reserveItems.map(function (item) {
    const match = form.reserves.filter(function (r) { return r && stripEmoji_(String(r.item).trim()) === item; })[0];
    return { item: item, amount: budgetAmountOrThrow_(match.amount, '「' + item + '」的預留金額') };
  });

  version.excludedItems = budgetNameList_(form.excludedItems, options.expenseItems || [], '支出項目');
  const clash = version.excludedItems.filter(function (item) { return reserveItems.indexOf(item) !== -1; })[0];
  if (clash) {
    throw new Error('「' + clash + '」不能同時是「不計入每日額度」和「排除」的項目，請擇一。');
  }
  return version;
}

/** 表單裡有帶 note 的預留項目 → { 項目: 備註 }；沒帶 note 的項目不列（保留原本的備註）。 */
function parseBudgetReserveNotes_(form, version) {
  const notes = {};
  version.reserves.forEach(function (r) {
    const match = form.reserves.filter(function (x) { return x && stripEmoji_(String(x.item).trim()) === r.item; })[0];
    if (match.note == null) return;
    notes[r.item] = multilineNote_(match.note, BUDGET_NOTE_MAX_LENGTH_, '「' + r.item + '」');
  });
  return notes;
}

/**
 * 套用備註的修改，並清掉已經沒有任何設定用到的項目。有變動才寫入，並回傳更新後的選項資料（沒變動回傳 null）。
 * 沒有帶備註、也沒存過備註時只讀一次 metadata。
 */
function saveBudgetReserveNotes_(ss, versions, edits) {
  const meta = getSettingsMetadata_(ss);
  const merged = Object.assign({}, meta.budgetReserveNotes, edits);
  const used = new Set();
  versions.forEach(function (v) { v.reserves.forEach(function (r) { used.add(r.item); }); });
  const notes = {};
  Object.keys(merged).sort().forEach(function (item) {
    if (merged[item] && used.has(item)) notes[item] = merged[item];
  });
  if (JSON.stringify(notes) === JSON.stringify(meta.budgetReserveNotes || {})) return null;

  meta.budgetReserveNotes = notes;
  if (!saveSettingsMetadata_(meta, ss)) throw new Error('預算備註儲存失敗，請稍後再試。');
  const updated = readAllOptionsData_(ss, true);
  updateBootSnapshotOptions_(updated);
  return { options: updated.raw, simpleOptions: updated.simple, metadata: updated.metadata };
}

/* ------------------------------ 試算表讀寫 ------------------------------ */

function getOrCreateBudgetSheet_(ss) {
  const existing = ss.getSheetByName(CONFIG.BUDGET_SHEET);
  if (existing) return existing;
  const sheet = ss.insertSheet(CONFIG.BUDGET_SHEET, ss.getNumSheets());
  sheet.getRange(1, 1, 1, BUDGET_HEADERS_.length)
    .setValues([BUDGET_HEADERS_.slice()])
    .setFontWeight('bold');
  sheet.setFrozenRows(1);
  sheet.getRange('A:A').setNumberFormat('@');
  sheet.getRange('G2:G').setNumberFormat('yyyy-mm-dd hh:mm:ss');
  sheet.hideSheet();
  return sheet;
}

function budgetVersionToRow_(v) {
  return [
    String(v.month),
    literalText_(BUDGET_SOURCES_[v.source]),
    v.source === 'fixed' ? v.amount : '',
    literalText_(v.categories.join(BUDGET_LIST_SEP_)),
    literalText_(v.incomeItems.join(BUDGET_LIST_SEP_)),
    literalText_(formatBudgetReserves_(v.reserves)),
    v.updatedAt ? new Date(v.updatedAt) : '',
    literalText_((v.excludedItems || []).join(BUDGET_LIST_SEP_)),
  ];
}

/** 整張表依起始月份重寫（列數很少），多出來的舊列清掉。 */
function writeBudgetVersions_(ss, versions) {
  const sheet = getOrCreateBudgetSheet_(ss);
  const width = BUDGET_HEADERS_.length;
  const oldCount = Math.max(0, sheet.getLastRow() - 1);
  // 標題列每次都重寫：舊版建立的工作表沒有「排除項目」欄，這樣會自動補上。
  sheet.getRange(1, 1, 1, width).setValues([BUDGET_HEADERS_.slice()]);
  const rows = versions.slice().sort(function (a, b) { return a.month < b.month ? -1 : 1; }).map(budgetVersionToRow_);
  if (rows.length) {
    if (sheet.getMaxRows() < rows.length + 1) {
      sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
    }
    sheet.getRange(2, 1, rows.length, 1).setNumberFormat('@');
    sheet.getRange(2, 1, rows.length, width).setValues(rows);
  }
  if (oldCount > rows.length) {
    sheet.getRange(rows.length + 2, 1, oldCount - rows.length, width).clearContent();
  }
}

/** @param noteEdits  選用：parseBudgetReserveNotes_ 的結果。備註有變動時回應多帶 settings（更新後的選項與 metadata）。 */
function saveBudgetVersionsAndRespond_(ss, versions, today, noteEdits) {
  const settings = saveBudgetReserveNotes_(ss, versions, noteEdits || {});
  writeBudgetVersions_(ss, versions);
  const config = { versions: versions.slice().sort(function (a, b) { return a.month < b.month ? -1 : 1; }) };
  saveBudgetConfigCache_(config);
  const res = {
    ok: true,
    todayISO: today.iso,
    currentMonth: today.month,
    versions: config.versions,
    status: currentBudgetStatus_(ss, config, today),
  };
  if (settings) res.settings = settings;
  return res;
}

/* -------------------------------- API -------------------------------- */

function saveBudgetSettings_(form) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const today = budgetToday_();
    const version = parseBudgetForm_(form, readOptions_(ss), today);
    const noteEdits = parseBudgetReserveNotes_(form, version);
    version.updatedAt = Date.now();
    const config = readBudgetConfig_(ss, true);
    const versions = config.versions.filter(function (v) { return v.month !== version.month; });
    versions.push(version);
    return saveBudgetVersionsAndRespond_(ss, versions, today, noteEdits);
  });
}

/** 移除某個月份（本月或之後）的那一列，該月改回沿用前一個設定。 */
function deleteBudgetSettings_(month) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const today = budgetToday_();
    const target = String(month || '').trim();
    assertBudgetMonth_(target, today);
    const config = readBudgetConfig_(ss, true);
    const versions = config.versions.filter(function (v) { return v.month !== target; });
    if (versions.length === config.versions.length) {
      throw new Error('「' + target + '」沒有單獨的預算設定。');
    }
    return saveBudgetVersionsAndRespond_(ss, versions, today);
  });
}
