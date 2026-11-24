function getMonthData_(ss, month, forceRefresh) {
  if (!forceRefresh) {
    const cached = getCachedMonthData_(month);
    if (cached) return cached;
  }
  const spreadsheet = ss || getSpreadsheet_();
  const sheet = spreadsheet.getSheetByName(month);
  if (!sheet) {
    throw new Error(`找不到「${month}」工作表。`);
  }
  return readMonthSheetDataFromSheet_(sheet, month);
}

function getCachedMonthData_(month) {
  if (!month) return null;
  return cacheGetLarge_(CONFIG.CACHE_KEYS.MONTH_DATA_PREFIX + month);
}

function saveMonthDataCache_(month, monthData) {
  if (!month || !monthData) return;
  cachePutLarge_(CONFIG.CACHE_KEYS.MONTH_DATA_PREFIX + month, monthData, CONFIG.CACHE_TTL);
}

/**
 * 從工作表讀出整月明細。預設會存進快取；options.save === false 時不存
 * （記帳寫入在鎖內會把明細和冪等結果合在同一次 putAll 存，P10）。
 */
function readMonthSheetDataFromSheet_(sheet, month, options) {
  const save = !(options && options.save === false);
  const maxRows = Math.min(CONFIG.MAX_DATA_ROW, sheet.getMaxRows());
  const lastRow = Math.min(sheet.getLastRow(), maxRows);
  const rowCount = Math.max(0, lastRow - CONFIG.MIN_DATA_ROW + 1);

  if (!rowCount) {
    const emptyData = {
      month: month || sheet.getName(),
      expenses: [],
      incomes: [],
      dailyExpenses: {},
      blankExpenseRows: [CONFIG.MIN_DATA_ROW],
      blankIncomeRows: [CONFIG.MIN_DATA_ROW],
    };
    if (month && save) saveMonthDataCache_(month, emptyData);
    return emptyData;
  }

  const maxCols = Math.min(14, Math.max(7, sheet.getMaxColumns() - 1));
  const values = sheet.getRange(CONFIG.MIN_DATA_ROW, 2, rowCount, maxCols).getValues();

  const expensesChrono = [];
  const incomesChrono = [];
  const blankExpenseRows = [];
  const blankIncomeRows = [];

  for (let i = 0; i < values.length; i++) {
    const row = values[i];
    const rowNum = CONFIG.MIN_DATA_ROW + i;

    const expDayRaw = row[0];
    const expItem = cellToStr_(row[1]);
    const expCat = cellToStr_(row[2]);
    const expPay = cellToStr_(row[3]);
    const expPaid = cellToStr_(row[4]);
    const expAmtRaw = row[5];
    const expNote = cellToStr_(row[6]);

    const hasExpense =
      (expDayRaw !== '' && expDayRaw !== null && String(expDayRaw).trim() !== '') ||
      expItem !== '' ||
      expCat !== '' ||
      expPay !== '' ||
      expPaid !== '' ||
      (expAmtRaw !== '' && expAmtRaw !== null && String(expAmtRaw).trim() !== '') ||
      expNote !== '';

    if (hasExpense) {
      const parsedDay = parseInt(expDayRaw, 10);
      expensesChrono.push({
        row: rowNum,
        day: !isNaN(parsedDay) ? parsedDay : cellToStr_(expDayRaw),
        item: expItem,
        category: expCat,
        payment: expPay,
        paid: expPaid,
        amount: cleanAmount_(expAmtRaw),
        note: expNote,
      });
    } else if (blankExpenseRows.length < 5) {
      blankExpenseRows.push(rowNum);
    }

    if (maxCols >= 14) {
      const incDayRaw = row[9];
      const incItem = cellToStr_(row[10]);
      const incCat = cellToStr_(row[11]);
      const incAmtRaw = row[12];
      const incNote = cellToStr_(row[13]);

      const hasIncome =
        (incDayRaw !== '' && incDayRaw !== null && String(incDayRaw).trim() !== '') ||
        incItem !== '' ||
        incCat !== '' ||
        (incAmtRaw !== '' && incAmtRaw !== null && String(incAmtRaw).trim() !== '') ||
        incNote !== '';

      if (hasIncome) {
        const parsedIncDay = parseInt(incDayRaw, 10);
        incomesChrono.push({
          row: rowNum,
          day: !isNaN(parsedIncDay) ? parsedIncDay : cellToStr_(incDayRaw),
          item: incItem,
          category: incCat,
          amount: cleanAmount_(incAmtRaw),
          note: incNote,
        });
      } else if (blankIncomeRows.length < 5) {
        blankIncomeRows.push(rowNum);
      }
    }
  }

  const nextAfterEnd = CONFIG.MIN_DATA_ROW + rowCount;
  if (blankExpenseRows.length === 0 && nextAfterEnd <= CONFIG.MAX_DATA_ROW) {
    blankExpenseRows.push(nextAfterEnd);
  }
  if (blankIncomeRows.length === 0 && nextAfterEnd <= CONFIG.MAX_DATA_ROW) {
    blankIncomeRows.push(nextAfterEnd);
  }

  const expenses = expensesChrono.reverse();
  const incomes = incomesChrono.reverse();
  const dailyExpenses = computeDailyExpenses_(expenses);

  const monthData = {
    month: month || sheet.getName(),
    expenses,
    incomes,
    dailyExpenses,
    blankExpenseRows,
    blankIncomeRows,
  };

  if (month && save) {
    saveMonthDataCache_(month, monthData);
  }
  return monthData;
}

function computeDailyExpenses_(expenses) {
  const dailyTotals = {};
  for (let i = 0; i < expenses.length; i++) {
    const rec = expenses[i];
    const parsedDay = parseInt(rec.day, 10);
    if (!isNaN(parsedDay)) {
      if (!dailyTotals[parsedDay]) {
        dailyTotals[parsedDay] = { total: 0, count: 0 };
      }
      dailyTotals[parsedDay].total += (Number(rec.amount) || 0);
      dailyTotals[parsedDay].count += 1;
    }
  }
  return dailyTotals;
}

/** @param budget  選用：已經算好的預算狀態（一次執行只算一次，P10）；沒給時在這裡算。 */
function buildRecentPayload_(month, monthData, expLimit, incLimit, budget) {
  const allExpenses = (monthData && monthData.expenses) || [];
  const allIncomes = (monthData && monthData.incomes) || [];
  const expenses = (expLimit && expLimit > 0) ? allExpenses.slice(0, expLimit) : allExpenses;
  const incomes = (incLimit && incLimit > 0) ? allIncomes.slice(0, incLimit) : allIncomes;
  return {
    month,
    expenses,
    incomes,
    fullExpenses: allExpenses,
    fullIncomes: allIncomes,
    dailyExpenses: (monthData && monthData.dailyExpenses) || {},
    budget: budget !== undefined ? budget : budgetStatusForMonth_(month, monthData),
  };
}
