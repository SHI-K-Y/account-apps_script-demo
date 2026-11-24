function createNewMonthSheet_(targetMonth) {
  return withDocumentLock_(function () {
    const rawMonth = String(targetMonth || '').trim();
    validateMonthFormat_(rawMonth);

    const parts = rawMonth.split('.');
    const year = parseInt(parts[0], 10);
    const monthNumber = parseInt(parts[1], 10);
    if (isNaN(year) || isNaN(monthNumber) || monthNumber < 1 || monthNumber > 12) {
      throw new Error(`月份數值錯誤，必須介於 01～12。`);
    }

    const ss = getSpreadsheet_();

    if (ss.getSheetByName(rawMonth)) {
      throw new Error(`「${rawMonth}」工作表已存在，無須重複建立。`);
    }

    const templateSheet = ss.getSheetByName(CONFIG.TEMPLATE_SHEET);
    if (!templateSheet) {
      throw new Error(`找不到範本「${CONFIG.TEMPLATE_SHEET}」工作表。`);
    }

    const newSheet = templateSheet.copyTo(ss).setName(rawMonth);
    if (newSheet.isSheetHidden()) {
      newSheet.showSheet();
    }

    const a1Range = newSheet.getRange('A1');
    try {
      a1Range.setFormula(`=DATE(${year}, ${monthNumber}, 1)`);
      flushSpreadsheet_();
      a1Range.copyTo(a1Range, { contentsOnly: true });
    } catch (e) {
      const tz = DEFAULT_TIME_ZONE_;
      const monthStr = String(monthNumber).padStart(2, '0');
      const safeDate = Utilities.parseDate(`${year}-${monthStr}-01 12:00:00`, tz, 'yyyy-MM-dd HH:mm:ss');
      a1Range.setValue(safeDate);
    }
    a1Range.setNumberFormat('yyyy/mm');

    const allSheets = ss.getSheets();
    let latestMonth = '';
    let latestSheet = null;
    let targetTemplateSheet = null;

    for (let i = 0; i < allSheets.length; i++) {
      const s = allSheets[i];
      const name = s.getName();
      if (name === rawMonth) continue;
      if (CONFIG.MONTH_PATTERN.test(name)) {
        if (!latestMonth || name > latestMonth) {
          latestMonth = name;
          latestSheet = s;
        }
      }
      if (name === CONFIG.TEMPLATE_SHEET) {
        targetTemplateSheet = s;
      }
    }

    if (latestSheet) {
      const targetPos = latestSheet.getIndex() + (newSheet.getIndex() > latestSheet.getIndex() ? 1 : 0);
      ss.setActiveSheet(newSheet);
      ss.moveActiveSheet(targetPos);
    } else if (targetTemplateSheet) {
      const targetPos = targetTemplateSheet.getIndex() - (newSheet.getIndex() < targetTemplateSheet.getIndex() ? 0 : 1);
      ss.setActiveSheet(newSheet);
      ss.moveActiveSheet(Math.max(1, targetPos));
    }

    flushSpreadsheet_();
    const cache = scriptCache_();
    cache.remove(CONFIG.CACHE_KEYS.MONTHS_LIST);
    cache.remove(CONFIG.CACHE_KEYS.BOOT_JSON);
    scriptProps_().deleteProperty(CONFIG.PROP_KEYS.MONTHS_SNAPSHOT);

    const updatedMonths = getMonthsList_(ss, true);

    const emptyMonthData = {
      month: rawMonth,
      expenses: [],
      incomes: [],
      dailyExpenses: {},
      blankExpenseRows: [CONFIG.MIN_DATA_ROW],
      blankIncomeRows: [CONFIG.MIN_DATA_ROW],
    };
    saveMonthDataCache_(rawMonth, emptyMonthData);
    markSummaryDirty_(rawMonth);

    try {
      const props = scriptProps_();
      const rawStr = props.getProperty(CONFIG.PROP_KEYS.BOOT_SNAPSHOT);
      if (rawStr) {
        const boot = JSON.parse(rawStr);
        boot.months = updatedMonths;
        boot.selectedMonth = rawMonth;
        boot.initialRecent = buildBootRecent_(rawMonth, emptyMonthData);
        boot.cachedAt = Date.now();
        saveBootSnapshot_(boot, { snapshotOnly: true });
      }
    } catch (e) {}

    return {
      ok: true,
      month: rawMonth,
      months: updatedMonths,
      recent: buildRecentPayload_(rawMonth, emptyMonthData, 8, 8),
    };
  });
}
