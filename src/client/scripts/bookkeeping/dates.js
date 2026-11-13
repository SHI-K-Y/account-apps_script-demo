function getDaysInMonth(month) {
  if (!month) return 31;
  const parts = String(month).split(/[.\-\/]/);
  const year = parseInt(parts[0], 10);
  const monthNum = parseInt(parts[1], 10);
  if (isNaN(year) || isNaN(monthNum) || monthNum < 1 || monthNum > 12) return 31;
  return new Date(year, monthNum, 0).getDate();
}

function setDatesForMonth(month) {
  if (!month || !month.includes('.')) return;
  const [year, monthNumber] = month.split('.').map(Number);
  const days = getDaysInMonth(month);
  const min = `${year}-${pad(monthNumber)}-01`;
  const max = `${year}-${pad(monthNumber)}-${pad(days)}`;
  const client = getClientToday();
  ['expenseDate', 'incomeDate'].forEach(id => {
    const input = document.getElementById(id);
    if (input) {
      input.min = min;
      input.max = max;
      input.value = (month === client.currentMonth && client.todayISO.startsWith(`${month.replace('.', '-')}-`))
        ? client.todayISO
        : min;
    }
  });
  ['expenseFilterDate', 'incomeFilterDate'].forEach(id => {
    const filterInput = document.getElementById(id);
    if (filterInput) {
      filterInput.min = min;
      filterInput.max = max;
    }
  });
  updateTodayExpenseUI();
}

function setToday(inputId) {
  const client = getClientToday();
  const month = getMonth();
  if (month === client.currentMonth) {
    const input = document.getElementById(inputId);
    input.value = client.todayISO;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const type = inputId.replace('Date', '');
    const calEl = document.getElementById(type + 'Calendar');
    if (calEl && !calEl.hidden) renderCalendar(type);
  } else {
    showToast('目前不是本月分頁，請直接選該月份的日期。', 'error');
  }
}

function setYesterday(inputId) {
  const client = getClientToday();
  const [cy, cm, cd] = client.todayISO.split('-').map(Number);
  const yesterday = new Date(cy, cm - 1, cd - 1);
  const yYear = yesterday.getFullYear();
  const yMonth = yesterday.getMonth() + 1;
  const yDay = yesterday.getDate();
  const yesterdayISO = `${yYear}-${pad(yMonth)}-${pad(yDay)}`;
  const yesterdayMonth = `${yYear}.${pad(yMonth)}`;
  const currentMonth = getMonth();

  if (currentMonth === yesterdayMonth) {
    const input = document.getElementById(inputId);
    input.value = yesterdayISO;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    const type = inputId.replace('Date', '');
    const calEl = document.getElementById(type + 'Calendar');
    if (calEl && !calEl.hidden) renderCalendar(type);
  } else {
    showToast(`昨天（${yesterdayMonth}.${pad(yDay)}）非本月分頁，請切換至 ${yesterdayMonth}。`, 'error');
  }
}

function initCalendarPicker(type) {
  bindCalendarPickerEvents({
    inputId: type + 'Date',
    btnId: type + 'CalBtn',
    calId: type + 'Calendar',
    onToggle: () => toggleCalendar(type),
    onInputChange: () => {
      const calEl = document.getElementById(type + 'Calendar');
      if (calEl && !calEl.hidden) renderCalendar(type);
    }
  });
}

function toggleCalendar(type) {
  const calEl = document.getElementById(type + 'Calendar');
  if (!calEl) return;
  ['expense', 'income', 'st', 'expenseFilter', 'incomeFilter'].forEach(t => {
    if (t !== type) closeCalendar(t);
  });

  if (calEl.hidden) {
    renderCalendar(type);
    calEl.hidden = false;
  } else {
    calEl.hidden = true;
  }
}

function closeCalendar(type) {
  const calEl = document.getElementById(type + 'Calendar');
  if (calEl) calEl.hidden = true;
}

function renderCalendar(type) {
  const calEl = document.getElementById(type + 'Calendar');
  const input = document.getElementById(type + 'Date');
  if (!calEl || !input) return;

  const monthStr = getMonth();
  const [year, monthNum] = monthStr.split('.').map(Number);

  const clientToday = getClientToday();
  const currentVal = input.value || '';
  const currentDayNum = currentVal.startsWith(`${year}-${pad(monthNum)}-`)
    ? Number(currentVal.split('-')[2])
    : null;

  calEl.innerHTML = '';

  const header = document.createElement('div');
  header.className = 'cal-header';

  const titleBox = document.createElement('div');
  titleBox.className = 'cal-title-box';
  const title = document.createElement('span');
  title.className = 'cal-title';
  title.textContent = `${year} 年 ${monthNum} 月`;
  titleBox.appendChild(title);

  if (monthStr === clientToday.currentMonth) {
    const badge = document.createElement('span');
    badge.className = 'cal-badge';
    badge.textContent = '本月';
    titleBox.appendChild(badge);
  }

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'cal-close-btn';
  closeBtn.innerHTML = iconHtml('x');
  closeBtn.setAttribute('aria-label', '關閉日曆');
  closeBtn.addEventListener('click', () => closeCalendar(type));

  header.appendChild(titleBox);
  header.appendChild(closeBtn);
  calEl.appendChild(header);

  calEl.appendChild(buildCalendarGrid({
    year,
    monthNum,
    currentDayNum,
    todayISO: clientToday.todayISO,
    onSelectDay: (day) => selectCalendarDay(type, day)
  }));

  const footer = document.createElement('div');
  footer.className = 'cal-footer';

  const quickBox = document.createElement('div');
  quickBox.className = 'cal-quick-actions';

  const todayBtn = document.createElement('button');
  todayBtn.type = 'button';
  todayBtn.className = 'cal-quick-btn';
  todayBtn.textContent = '今天';
  todayBtn.addEventListener('click', () => {
    setToday(type + 'Date');
    closeCalendar(type);
  });
  quickBox.appendChild(todayBtn);

  const yesterdayBtn = document.createElement('button');
  yesterdayBtn.type = 'button';
  yesterdayBtn.className = 'cal-quick-btn';
  yesterdayBtn.textContent = '昨天';
  yesterdayBtn.addEventListener('click', () => {
    setYesterday(type + 'Date');
    closeCalendar(type);
  });
  quickBox.appendChild(yesterdayBtn);

  const info = document.createElement('span');
  info.className = 'cal-selected-info';
  info.textContent = currentDayNum ? `已選 ${monthNum}月${currentDayNum}日` : '';

  footer.appendChild(quickBox);
  footer.appendChild(info);
  calEl.appendChild(footer);
}

function selectCalendarDay(type, day) {
  const monthStr = getMonth();
  const [year, monthNum] = monthStr.split('.').map(Number);
  const formattedDate = `${year}-${pad(monthNum)}-${pad(day)}`;
  const input = document.getElementById(type + 'Date');
  input.value = formattedDate;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  closeCalendar(type);
}

function getMonth() {
  return document.getElementById('monthSelect').value;
}

function getDay(inputId) {
  const value = document.getElementById(inputId).value;
  if (!value) return null;
  return Number(value.split('-')[2]);
}
