function buildCalendarGrid({ year, monthNum, currentDayNum, todayISO, onSelectDay }) {
  const fragment = document.createDocumentFragment();

  const weekdaysEl = document.createElement('div');
  weekdaysEl.className = 'cal-weekdays';
  const weekdayNames = ['日', '一', '二', '三', '四', '五', '六'];
  weekdayNames.forEach((w, idx) => {
    const span = document.createElement('span');
    span.textContent = w;
    if (idx === 0 || idx === 6) span.className = 'cal-weekend';
    weekdaysEl.appendChild(span);
  });
  fragment.appendChild(weekdaysEl);

  const totalDays = new Date(year, monthNum, 0).getDate();
  const firstDayOfWeek = new Date(year, monthNum - 1, 1).getDay();

  const gridEl = document.createElement('div');
  gridEl.className = 'cal-grid';

  for (let i = 0; i < firstDayOfWeek; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-day empty';
    gridEl.appendChild(empty);
  }

  for (let day = 1; day <= totalDays; day++) {
    const dayBtn = document.createElement('button');
    dayBtn.type = 'button';
    dayBtn.className = 'cal-day';
    dayBtn.textContent = String(day);

    const thisDateISO = `${year}-${pad(monthNum)}-${pad(day)}`;
    if (thisDateISO === todayISO) {
      dayBtn.classList.add('today');
      dayBtn.title = '今天';
    }
    if (day === currentDayNum) {
      dayBtn.classList.add('selected');
    }

    dayBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      onSelectDay(day);
    });

    gridEl.appendChild(dayBtn);
  }
  fragment.appendChild(gridEl);

  return fragment;
}

function bindCalendarPickerEvents({ inputId, btnId, calId, onToggle, onInputChange }) {
  const input = document.getElementById(inputId);
  const btn = document.getElementById(btnId);
  const calEl = document.getElementById(calId);

  if (btn) {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      onToggle();
    });
  }

  if (input) {
    input.addEventListener('click', e => {
      const isDesktopPointer = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
      if (isDesktopPointer) {
        e.stopPropagation();
        onToggle();
      }
    });

    if (onInputChange) {
      input.addEventListener('change', () => {
        onInputChange();
      });
    }
  }

  if (calEl) {
    calEl.addEventListener('click', e => {
      e.stopPropagation();
    });
  }
}

function getClientToday() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  return {
    todayISO: `${year}-${pad(month)}-${pad(day)}`,
    currentMonth: `${year}.${pad(month)}`,
  };
}
