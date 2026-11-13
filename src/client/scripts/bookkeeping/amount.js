function buildKeypad(containerId, type) {
  const container = document.getElementById(containerId);
  const keys = ['1','2','3','4','5','6','7','8','9','00','0','⌫'];
  keys.forEach(key => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'key' + (key === '⌫' ? ' special' : '');
    if (key === '⌫') button.innerHTML = iconHtml('backspace'); else button.textContent = key;
    button.setAttribute('aria-label', key === '⌫' ? '刪除一位' : key);
    button.addEventListener('click', () => pressKey(type, key));
    container.appendChild(button);
  });
  const clear = document.createElement('button');
  clear.type = 'button';
  clear.className = 'key special wide';
  clear.textContent = '清除金額';
  clear.addEventListener('click', () => {
    const hadValue = Boolean(state[type].amount);
    state[type].amount = '';
    renderAmount(type, hadValue ? 'clear' : null);
  });
  container.appendChild(clear);
}

function pressKey(type, key) {
  const before = state[type].amount || '';
  let value = before;
  let overflow = false;
  if (key === '⌫') {
    value = value.slice(0, -1);
  } else if (key === '00') {
    if (!value) value = '0';
    else if (value !== '0') value += '00';
  } else {
    if (value === '0') value = '';
    if (value.length < 9) value += key;
    else overflow = true;
  }
  state[type].amount = value;
  const change = value === before ? null : (key === '⌫' ? 'remove' : 'add');
  renderAmount(type, change);
  if (overflow) rejectAmountOverflow(type);
}

function rejectAmountOverflow(type) {
  Motion.haptic('error');
  const box = document.getElementById(type + 'LiveBox');
  const num = document.getElementById(type + 'LiveAmount');
  if (Motion.level() === 'full') {
    Motion.shake(box);
  } else if (num) {
    const red = getComputedStyle(document.documentElement).getPropertyValue('--exp').trim() || '#db4637';
    Motion.animate(num, { lite: [{ color: red, offset: 0 }] }, { duration: Motion.dur('slow'), easing: 'ease-out' });
  }
}

function renderLiveAmount(el, text, change) {
  const token = (el._amtToken || 0) + 1;
  el._amtToken = token;
  clearTimeout(el._amtTimer);
  const prevText = el.dataset.amountText != null ? el.dataset.amountText : el.textContent;
  el.dataset.amountText = text;

  const paint = t => {
    el.getAnimations && el.getAnimations().forEach(a => a.cancel());
    el.textContent = '';
    Array.from(t).forEach(ch => {
      const span = document.createElement('span');
      span.className = 'amt-ch';
      span.textContent = ch;
      el.appendChild(span);
    });
  };
  const digitsOf = t => t.replace(/\D/g, '').replace(/^0+/, '').length;
  const level = Motion.level();

  if (!change || level === 'off') {
    paint(text);
    return;
  }

  if (change === 'add') {
    paint(text);
    const added = Math.max(1, digitsOf(text) - digitsOf(prevText));
    const digitSpans = Array.prototype.filter.call(el.children, sp => /\d/.test(sp.textContent));
    digitSpans.slice(-added).forEach(sp => {
      Motion.animate(sp, {
        full: [{ transform: 'translateY(60%)', opacity: 0 }, { transform: 'none', opacity: 1 }],
        lite: [{ opacity: 0 }, { opacity: 1 }]
      }, { duration: Motion.dur('base'), easing: Motion.ease('out') });
    });
    return;
  }

  if (change === 'remove') {
    paint(prevText);
    const last = el.lastElementChild;
    if (last) {
      Motion.animate(last, {
        full: [{ transform: 'none', opacity: 1 }, { transform: 'translateY(-60%)', opacity: 0 }],
        lite: [{ opacity: 1 }, { opacity: 0 }]
      }, { duration: Motion.dur('fast'), easing: Motion.ease('out'), fill: 'forwards' });
    }
    el._amtTimer = setTimeout(() => { if (el._amtToken === token) paint(text); }, Motion.dur('fast'));
    return;
  }

  if (change === 'clear') {
    Motion.animate(el, {
      full: [{ transform: 'scale(1)', opacity: 1 }, { transform: 'scale(0.6)', opacity: 0 }],
      lite: [{ opacity: 1 }, { opacity: 0 }]
    }, { duration: Motion.dur('base'), easing: Motion.ease('in-out'), fill: 'forwards' }).then(() => {
      if (el._amtToken !== token) return;
      paint(text);
      Motion.animate(el, [{ opacity: 0 }, { opacity: 1 }], { duration: Motion.dur('fast'), easing: 'ease-out' });
    });
    return;
  }

  paint(text);
}

function renderAmount(type, change) {
  const raw = state[type].amount;
  const value = Number(raw || 0);
  const formatted = new Intl.NumberFormat('zh-TW').format(value);

  const barAmount = document.getElementById(type + 'Amount');
  if (barAmount) barAmount.textContent = formatted;

  const liveAmount = document.getElementById(type + 'LiveAmount');
  if (liveAmount) renderLiveAmount(liveAmount, formatted, change);

  const liveBox = document.getElementById(type + 'LiveBox');
  if (liveBox) {
    liveBox.classList.toggle('has-value', Boolean(raw && value > 0));
  }
  scheduleStepProgress(type);
}

const FinanceUtils = {
  parse: function(val) {
    if (val == null) return 0;
    if (typeof val === 'number') return Number.isFinite(val) ? val : 0;
    const str = String(val).trim();
    if (!str) return 0;
    const isNeg = str.includes('-') || (str.startsWith('(') && str.endsWith(')'));
    const cleaned = str.replace(/[^0-9.]/g, '');
    const num = parseFloat(cleaned);
    if (!Number.isFinite(num)) return 0;
    return isNeg ? -num : num;
  },

  format: function(val, opts) {
    const options = opts || {};
    const num = typeof val === 'number' ? val : this.parse(val);
    const absFormatted = Math.abs(num).toLocaleString('zh-TW');
    if (options.signed) {
      const prefix = num > 0 ? '+' : (num < 0 ? '-' : '');
      return prefix + absFormatted;
    }
    return (num < 0 ? '-' : '') + absFormatted;
  },

  formatSigned: function(val) {
    return this.format(val, { signed: true });
  }
};

const parseAmount = (val) => FinanceUtils.parse(val);
const formatAmount = (val, opts) => FinanceUtils.format(val, opts);
const ovParseNum = (val) => FinanceUtils.parse(val);
const ovFmt = (num) => FinanceUtils.format(num);
const ovFmtSigned = (num) => FinanceUtils.formatSigned(num);
