function getSettlementData_(targetDate) {
  const ss = getSpreadsheet_();
  const sheet = getSettlementSheet_(ss);

  let grid = sheet.getRange(2, 2, 9, 20).getDisplayValues();
  let currentH2Display = (grid[0] && grid[0][6]) ? String(grid[0][6]).trim() : '';
  let currentNorm = normalizeDateSlash_(currentH2Display);
  let targetNorm = targetDate ? normalizeDateSlash_(targetDate) : '';

  if (targetNorm && targetNorm !== currentNorm) {
    withDocumentLock_(function () {
      setH2Date_(sheet, targetNorm);
      flushSpreadsheet_();
      grid = sheet.getRange(2, 2, 9, 20).getDisplayValues();
      currentH2Display = (grid[0] && grid[0][6]) ? String(grid[0][6]).trim() : targetNorm;
    });
  } else if (!currentNorm && !targetNorm) {
    const tz = DEFAULT_TIME_ZONE_;
    const todaySlash = Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd');
    withDocumentLock_(function () {
      setH2Date_(sheet, todaySlash);
      flushSpreadsheet_();
      grid = sheet.getRange(2, 2, 9, 20).getDisplayValues();
      currentH2Display = (grid[0] && grid[0][6]) ? String(grid[0][6]).trim() : todaySlash;
    });
  }

  const row4 = grid[2] || [];
  const row5 = grid[3] || [];
  const totalLedger = safeCellVal_(grid[6] && grid[6][1]);
  const totalActual = safeCellVal_(grid[6] && grid[6][8]);
  const difference = safeCellVal_(grid[8] && grid[8][7]);

  const dateStr = normalizeDateSlash_(currentH2Display) || targetNorm || currentH2Display;

  return {
    settlementDate: dateStr,
    ledger: {
      livingBalance: safeCellVal_(row5[0]),
      savingsBalance: safeCellVal_(row5[2]),
      agencyBalance: safeCellVal_(row5[4]),
      creditCardUnpaid: safeCellVal_(row5[6]),
      total: totalLedger,
    },
    actual: {
      cash: safeCellVal_(row5[7]),
      bankShanlan: safeCellVal_(row5[9]),
      bankBeichen: safeCellVal_(row5[11]),
      bankAurora: safeCellVal_(row5[13]),
      bankHaiyue: safeCellVal_(row5[15]),
      bankYunshan: safeCellVal_(row5[17]),
      bankQinghe: safeCellVal_(row5[19]),
      total: totalActual,
    },
    difference: difference,
    actualLabels: {
      cash: safeCellVal_(row4[7]),
      bankShanlan: safeCellVal_(row4[9]),
      bankBeichen: safeCellVal_(row4[11]),
      bankAurora: safeCellVal_(row4[13]),
      bankHaiyue: safeCellVal_(row4[15]),
      bankYunshan: safeCellVal_(row4[17]),
      bankQinghe: safeCellVal_(row4[19]),
    },
  };
}

function safeCellVal_(v) {
  if (!v || String(v).trim().startsWith('#')) return '0';
  return v !== null && v !== undefined && String(v).trim() !== '' ? v : '0';
}

function normalizeDateSlash_(dateVal) {
  if (!dateVal) return '';
  if (dateVal instanceof Date) {
    const tz = DEFAULT_TIME_ZONE_;
    return Utilities.formatDate(dateVal, tz, 'yyyy/MM/dd');
  }
  const str = String(dateVal).trim();
  const match = str.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (match) {
    return (
      match[1] +
      '/' +
      Utilities.formatString('%02d', Number(match[2])) +
      '/' +
      Utilities.formatString('%02d', Number(match[3]))
    );
  }
  return '';
}

function setH2Date_(sheet, dateVal) {
  if (!dateVal) {
    sheet.getRange('H2').clearContent();
    return;
  }
  const norm = normalizeDateSlash_(dateVal);
  sheet.getRange('H2').setValue(norm || String(dateVal));
}

function updateSettlementDate_(dateStr) {
  return withDocumentLock_(function () {
    return getSettlementData_(dateStr);
  });
}

function updateSettlementActual_(form) {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const sheet = getSettlementSheet_(ss);

    if (form.date) {
      const currentH2 = normalizeDateSlash_(sheet.getRange('H2').getDisplayValue());
      const targetH2 = normalizeDateSlash_(form.date);
      if (targetH2 && targetH2 !== currentH2) {
        setH2Date_(sheet, targetH2);
      }
    }

    function parseNumField(key) {
      if (form[key] === undefined || form[key] === null || String(form[key]).trim() === '') return 0;
      const val = Number(String(form[key]).replace(/[^0-9.\-]/g, ''));
      return Number.isFinite(val) ? val : 0;
    }

    const row5ActualValues = [[
      parseNumField('cash'),
      '+',
      parseNumField('bankShanlan'),
      '+',
      parseNumField('bankBeichen'),
      '+',
      parseNumField('bankAurora'),
      '+',
      parseNumField('bankHaiyue'),
      '+',
      parseNumField('bankYunshan'),
      '+',
      parseNumField('bankQinghe'),
    ]];

    sheet.getRange(5, 9, 1, 13).setValues(row5ActualValues);
    flushSpreadsheet_();

    return getSettlementData_(form.date);
  });
}

function clearSettlementActual_() {
  return withDocumentLock_(function () {
    const ss = getSpreadsheet_();
    const sheet = getSettlementSheet_(ss);

    sheet.getRangeList(['I5', 'K5', 'M5', 'O5', 'Q5', 'S5', 'U5']).clearContent();

    var tz = DEFAULT_TIME_ZONE_;
    var todayStr = Utilities.formatDate(new Date(), tz, 'yyyy/MM/dd');
    setH2Date_(sheet, todayStr);

    flushSpreadsheet_();
    return getSettlementData_(todayStr);
  });
}
