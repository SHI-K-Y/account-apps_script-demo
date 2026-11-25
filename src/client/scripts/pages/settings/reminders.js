/* =============================================================================
 * ReminderSettings — 設定頁的「記帳提醒」分頁
 * -----------------------------------------------------------------------------
 * 每個提醒：支出或收入的哪個項目、每天／每週幾／每月幾號、幾點後還沒記就提醒，
 * 以及選填的備註（跳出提醒卡片時一起顯示）。
 * 設定存在 settings metadata 的 recordReminders（跨裝置同步，後端見 57_settings_reminders.gs），
 * 判斷規則在 core/reminders.js，跳出卡片在 app/reminder-prompt.js。
 * ============================================================================= */
const ReminderSettings = (function() {
  const MAX_REMINDERS = 20;
  const NOTE_MAX_LENGTH = 100; // 與後端 RECORD_REMINDER_LIMITS_.NOTE_MAX_LENGTH 一致
  const REPEAT_OPTIONS = [
    { value: 'daily', label: '每天' },
    { value: 'weekly', label: '每週' },
    { value: 'monthly', label: '每月' },
  ];
  const TYPE_OPTIONS = [
    { value: 'expense', label: '支出' },
    { value: 'income', label: '收入' },
  ];

  const st = {
    draft: null,   // { enabled, reminders: [...] }
    baseline: '',  // 最後一次儲存（或載入）時的 JSON，用來判斷有沒有未儲存的變更
    saving: false,
  };

  const isTab = () => settingsState.currentTab === 'reminders';

  function itemsOf(type) {
    const simple = (state.data && state.data.options) || {};
    const key = type === 'income' ? 'incomeItems' : 'expenseItems';
    if (Array.isArray(simple[key]) && simple[key].length) return simple[key];
    const raw = (settingsState.data && settingsState.data[key]) || [];
    return raw.map(o => o && o.value).filter(Boolean);
  }

  function snapshot(d) {
    return JSON.stringify({
      enabled: d.enabled,
      reminders: d.reminders.map(r => [r.id, r.enabled, r.type, r.item, r.repeat, r.time,
        r.repeat === 'weekly' ? r.weekdays.slice().sort() : null, r.repeat === 'monthly' ? r.monthDay : null, r.note.trim()]),
    });
  }

  function ensureDraft() {
    if (!st.draft) {
      const c = RecordReminders.config();
      st.draft = { enabled: c.enabled, reminders: c.reminders.map(r => Object.assign({}, r, { weekdays: r.weekdays.slice() })) };
      st.baseline = snapshot(st.draft);
    }
    return st.draft;
  }

  function isDirty() { return Boolean(st.draft) && snapshot(st.draft) !== st.baseline; }

  function newId() { return 'rm_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  function fmtMinutes(m) {
    return String(Math.floor(m / 60) % 24).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }

  /** 新提醒的預設：先挑「時段建議」裡還沒設提醒的餐別，時間是該時段結束時；沒有就挑第一個支出項目、21:00。 */
  function nextReminder(d) {
    const used = d.reminders.filter(r => r.type === 'expense').map(r => r.item);
    const items = itemsOf('expense');
    const slot = MealSlots.config().slots.find(s => items.indexOf(s.item) !== -1 && used.indexOf(s.item) === -1);
    const item = slot ? slot.item : (items.find(name => used.indexOf(name) === -1) || items[0] || '');
    const end = slot ? MealSlots.toMinutes(slot.end) : -1;
    return {
      id: newId(), enabled: true, type: 'expense', item: item, repeat: 'daily',
      time: end >= 0 ? fmtMinutes(end + 1) : '21:00', weekdays: [1, 2, 3, 4, 5], monthDay: 1, note: '',
    };
  }

  /* ---------------------------------- 檢查 ---------------------------------- */

  /** 每個提醒的問題：{ error: 會擋下儲存, warn / note: 只是提醒 } */
  function issue(r) {
    if (!r.item) return { error: '請選擇項目' };
    if (RecordReminders.toMinutes(r.time) < 0) return { error: '請填寫提醒時間' };
    if (r.repeat === 'weekly' && !r.weekdays.length) return { error: '每週提醒至少要選一天' };
    if (itemsOf(r.type).indexOf(r.item) === -1) {
      return { warn: '「' + r.item + '」已不在' + RecordReminders.TYPE_LABELS[r.type] + '項目中，這個提醒不會出現' };
    }
    if (r.repeat === 'monthly' && r.monthDay > 28) return { note: '當月沒有 ' + r.monthDay + ' 日時，以月底為準' };
    return {};
  }

  function summaryText(r) {
    if (!r.item || RecordReminders.toMinutes(r.time) < 0 || (r.repeat === 'weekly' && !r.weekdays.length)) return '';
    const scope = r.repeat === 'monthly' ? '這個月' : '當天';
    const when = r.repeat === 'monthly' ? RecordReminders.scheduleText(r) + ' 起' : RecordReminders.scheduleText(r) + ' 後';
    return when + '，' + scope + '還沒記「' + r.item + '」就提醒';
  }

  /** 依目前的紀錄，這個提醒現在會不會出現。 */
  function statusInfo(r, d) {
    const s = RecordReminders.status(r, {
      now: new Date(),
      enabled: d.enabled,
      records: ReminderPrompt.currentRecords(),
      items: ReminderPrompt.optionItems() || { expense: itemsOf('expense'), income: itemsOf('income') },
    });
    switch (s.state) {
      case 'off': return { text: d.enabled ? '這個提醒已停用' : '記帳提醒已關閉', tone: 'muted' };
      case 'idle': return r.repeat === 'monthly'
        ? { text: '本月 ' + Math.min(r.monthDay, RecordReminders.daysInMonth(new Date())) + ' 日起才會提醒', tone: 'muted' }
        : { text: '今天不是提醒日', tone: 'muted' };
      case 'pending': return { text: '今天 ' + r.time + ' 後還沒記才會提醒', tone: 'muted' };
      case 'done': return { text: (s.scope === 'month' ? '本月' : '今天') + '已經記過「' + r.item + '」，不會提醒', tone: 'done' };
      case 'due': return ReminderPrompt.isSnoozed(RecordReminders.itemKey(r))
        ? { text: '今天已選擇「不再顯示」，明天起恢復提醒', tone: 'muted' }
        : { text: '還沒記，現在打開記帳簿會跳出提醒', tone: 'due' };
      default: return { text: '', tone: 'muted' };
    }
  }

  /* ---------------------------------- 畫面 ---------------------------------- */

  function segHtml(options, current, attr, idx, label) {
    return '<div class="pref-segmented rmd-seg" role="radiogroup" aria-label="' + escAttr(label) + '">' +
      options.map(o => {
        const on = o.value === current;
        return '<button type="button" role="radio" class="pref-seg-btn' + (on ? ' is-active' : '') + '"' +
          ' ' + attr + '="' + idx + '" data-value="' + o.value + '"' +
          ' aria-checked="' + (on ? 'true' : 'false') + '" tabindex="' + (on ? '0' : '-1') + '">' + o.label + '</button>';
      }).join('') +
    '</div>';
  }

  function itemSelectHtml(r, idx) {
    const items = itemsOf(r.type);
    const list = r.item && items.indexOf(r.item) === -1 ? [r.item].concat(items) : items;
    const opts = (r.item ? '' : '<option value="" selected>選擇項目</option>') +
      list.map(name => '<option value="' + escAttr(name) + '"' + (name === r.item ? ' selected' : '') + '>' + escHtml(name) + '</option>').join('');
    return '<select class="month-select rmd-item" data-rmd-item="' + idx + '" aria-label="第 ' + (idx + 1) + ' 個提醒的項目">' + opts + '</select>';
  }

  function scheduleExtraHtml(r, idx) {
    if (r.repeat === 'weekly') {
      return '<div class="rmd-weekdays" role="group" aria-label="每週哪幾天提醒">' +
        RecordReminders.WEEKDAYS.map(w => {
          const on = r.weekdays.indexOf(w.value) !== -1;
          return '<button type="button" class="rmd-day' + (on ? ' is-on' : '') + '" data-rmd-day="' + idx + '" data-value="' + w.value + '"' +
            ' aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="星期' + w.label + '">' + w.label + '</button>';
        }).join('') +
      '</div>';
    }
    if (r.repeat === 'monthly') {
      let opts = '';
      for (let day = 1; day <= 31; day++) opts += '<option value="' + day + '"' + (day === r.monthDay ? ' selected' : '') + '>' + day + ' 日</option>';
      return '<label class="rmd-monthday">' +
        '<span class="rmd-field-label">每月</span>' +
        '<select class="month-select rmd-monthday-select" data-rmd-monthday="' + idx + '" aria-label="每月幾號提醒">' + opts + '</select>' +
      '</label>';
    }
    return '';
  }

  function msgText(i) { return i.error || i.warn || i.note || ''; }
  function msgTone(i) { return i.error ? 'error' : i.warn ? 'warn' : 'note'; }

  function rowHtml(r, idx, d) {
    const iss = issue(r);
    const info = statusInfo(r, d);
    const label = r.item || ('第 ' + (idx + 1) + ' 個提醒');
    return '<li class="rmd-row' + (r.enabled ? '' : ' is-off') + (iss.error ? ' has-error' : '') + '">' +
      '<div class="rmd-line rmd-line-what">' +
        '<button type="button" class="pref-switch rmd-switch' + (r.enabled ? ' is-on' : '') + '" role="switch" data-rmd-enabled="' + idx + '"' +
          ' aria-checked="' + (r.enabled ? 'true' : 'false') + '" aria-label="啟用 ' + escAttr(label) + ' 提醒">' +
          '<span class="pref-switch-thumb" aria-hidden="true"></span>' +
        '</button>' +
        segHtml(TYPE_OPTIONS, r.type, 'data-rmd-type', idx, label + ' 的類型') +
        itemSelectHtml(r, idx) +
        '<button type="button" class="icon-btn rmd-remove" data-rmd-remove="' + idx + '" title="移除" aria-label="移除 ' + escAttr(label) + ' 提醒">' + iconHtml('x') + '</button>' +
      '</div>' +
      '<div class="rmd-line rmd-line-when">' +
        segHtml(REPEAT_OPTIONS, r.repeat, 'data-rmd-repeat', idx, label + ' 的重複方式') +
        '<label class="rmd-time">' +
          '<span class="rmd-field-label">時間</span>' +
          '<input class="text-input rmd-time-input" type="time" step="60" required data-rmd-time="' + idx + '" value="' + escAttr(r.time) + '"' +
            ' aria-label="' + escAttr(label) + ' 幾點後還沒記就提醒">' +
        '</label>' +
        InfoTip.html('rmdTip-' + idx, summaryText(r), { under: true, label: label + ' 提醒說明', bubbleAttrs: 'data-rmd-summary="' + idx + '"' }) +
      '</div>' +
      scheduleExtraHtml(r, idx) +
      '<label class="note-field">' +
        '<span class="note-field-label">備註 (選填)</span>' +
        '<textarea class="note-input note-field-input" rows="2" maxlength="' + NOTE_MAX_LENGTH + '" data-rmd-note="' + idx + '"' +
          ' aria-label="' + escAttr(label) + ' 提醒的備註">' + escHtml(r.note) + '</textarea>' +
      '</label>' +
      '<div class="rmd-msg" data-rmd-msg="' + idx + '" data-tone="' + msgTone(iss) + '"' + (msgText(iss) ? (iss.error ? ' role="alert"' : '') : ' hidden') + '>' + escHtml(msgText(iss)) + '</div>' +
      '<div class="rmd-status" data-rmd-status="' + idx + '" data-tone="' + info.tone + '"' + (info.text && !iss.error && !iss.warn ? '' : ' hidden') + '>' +
        '<span class="rmd-status-dot" aria-hidden="true"></span><span data-rmd-status-text>' + escHtml(info.text) + '</span>' +
      '</div>' +
    '</li>';
  }

  function actionsHtml(hasError, dirty) {
    return (dirty ? '<span class="meal-dirty-note is-dirty">尚未儲存</span>' : '') +
      '<button type="button" class="settings-add-btn budget-save-btn" data-rmd-save' + (st.saving || hasError || !dirty ? ' disabled' : '') + '>' +
        iconHtml(st.saving ? 'spinner-gap' : 'check', 'regular', 'ic-16' + (st.saving ? ' spinner' : '')) +
        (st.saving ? '儲存中…' : '儲存') +
      '</button>';
  }

  function render(container) {
    if (!container) return;
    bind(container);
    const d = ensureDraft();
    const hasError = d.reminders.some(r => issue(r).error);
    const rows = d.reminders.map((r, idx) => rowHtml(r, idx, d)).join('');
    const canAdd = d.reminders.length < MAX_REMINDERS;

    container.innerHTML =
      '<div class="settings-list-header">' +
        '<div class="settings-list-title-wrap">' +
          '<span class="settings-list-title">記帳提醒</span>' +
        '</div>' +
      '</div>' +
      '<div class="pref-list rmd-settings">' +
        '<div class="pref-card pref-card-row">' +
          '<div class="pref-card-text">' +
            '<div class="pref-card-title" id="rmdEnabledTitle">打開記帳簿時提醒還沒記的帳</div>' +
          '</div>' +
          '<button type="button" class="pref-switch' + (d.enabled ? ' is-on' : '') + '" role="switch" data-rmd-master' +
            ' aria-checked="' + (d.enabled ? 'true' : 'false') + '" aria-labelledby="rmdEnabledTitle">' +
            '<span class="pref-switch-thumb" aria-hidden="true"></span>' +
          '</button>' +
        '</div>' +
        '<div class="pref-card' + (d.enabled ? '' : ' is-muted') + '">' +
          '<div class="pref-card-text">' +
            '<div class="pref-card-title">提醒</div>' +
          '</div>' +
          (rows ? '<ul class="rmd-list">' + rows + '</ul>' : '<div class="meal-slot-empty">尚未設定任何提醒</div>') +
          (canAdd ? '<button type="button" class="budget-add-reserve" data-rmd-add>' + iconHtml('plus', 'regular', 'ic-14') + '新增提醒</button>' : '') +
        '</div>' +
        '<div class="budget-actions meal-actions" data-rmd-actions>' + actionsHtml(hasError, isDirty()) + '</div>' +
      '</div>';
    // 分段控制由建立它的渲染函式直接啟用（P06）
    container.querySelectorAll('.pref-segmented').forEach(el => Motion.segmented(el, '.pref-seg-btn'));
  }

  /** 只更新會隨時間欄位變動的部分，不重建輸入框，打字時游標不會跳走。 */
  function patch(container, idx) {
    const d = st.draft;
    const r = d.reminders[idx];
    if (r) {
      const iss = issue(r);
      const info = statusInfo(r, d);
      const sum = container.querySelector('[data-rmd-summary="' + idx + '"]');
      if (sum) sum.textContent = summaryText(r);
      const msg = container.querySelector('[data-rmd-msg="' + idx + '"]');
      if (msg) {
        msg.textContent = msgText(iss);
        msg.hidden = !msgText(iss);
        msg.setAttribute('data-tone', msgTone(iss));
        if (iss.error) msg.setAttribute('role', 'alert'); else msg.removeAttribute('role');
        const row = msg.closest('.rmd-row');
        if (row) row.classList.toggle('has-error', Boolean(iss.error));
      }
      const stEl = container.querySelector('[data-rmd-status="' + idx + '"]');
      if (stEl) {
        stEl.setAttribute('data-tone', info.tone);
        stEl.hidden = !(info.text && !iss.error && !iss.warn);
        const txt = stEl.querySelector('[data-rmd-status-text]');
        if (txt) txt.textContent = info.text;
      }
    }
    const actions = container.querySelector('[data-rmd-actions]');
    if (actions) actions.innerHTML = actionsHtml(d.reminders.some(x => issue(x).error), isDirty());
  }

  /* ---------------------------------- 操作 ---------------------------------- */

  function rerender(container, focusSelector) {
    render(container);
    if (focusSelector) {
      const el = container.querySelector(focusSelector);
      if (el) el.focus();
    }
  }

  function save(container) {
    if (st.saving || !st.draft) return;
    const firstError = st.draft.reminders
      .map((r, idx) => { const e = issue(r).error; return e ? '第 ' + (idx + 1) + ' 個提醒：' + e : ''; })
      .filter(Boolean)[0];
    if (firstError) return showToast(firstError, 'error');

    const payload = {
      enabled: st.draft.enabled,
      reminders: st.draft.reminders.map(r => {
        const out = { id: r.id, enabled: r.enabled, type: r.type, item: r.item, repeat: r.repeat, time: r.time };
        if (r.repeat === 'weekly') out.weekdays = r.weekdays.slice();
        if (r.repeat === 'monthly') out.monthDay = r.monthDay;
        if (r.note.trim()) out.note = r.note.trim();
        return out;
      }),
    };
    st.saving = true;
    render(container);
    Api.call('saveRecordReminders', payload)
      .then(res => {
        st.saving = false;
        if (res && res.ok) {
          settingsState.data = res.options;
          refreshBookkeepingOptions(res.simpleOptions, res.options, res.metadata);
        }
        st.draft = null;
        if (isTab()) render(container);
        showToast('記帳提醒已儲存', 'success');
      })
      .catch(err => {
        st.saving = false;
        if (isTab()) render(container);
        showToast('儲存失敗：' + ((err && err.message) || err), 'error');
      });
  }

  function pickRadio(container, btn) {
    const d = st.draft;
    const idx = Number(btn.getAttribute(btn.hasAttribute('data-rmd-type') ? 'data-rmd-type' : 'data-rmd-repeat'));
    const r = d.reminders[idx];
    if (!r) return;
    const value = btn.getAttribute('data-value');
    if (btn.hasAttribute('data-rmd-type')) {
      if (r.type === value) return;
      r.type = value;
      const items = itemsOf(value);
      r.item = items[0] || '';
      rerender(container, '[data-rmd-type="' + idx + '"][data-value="' + value + '"]');
    } else {
      if (r.repeat === value) return;
      r.repeat = value;
      if (value === 'weekly' && !r.weekdays.length) r.weekdays = [1, 2, 3, 4, 5];
      rerender(container, '[data-rmd-repeat="' + idx + '"][data-value="' + value + '"]');
    }
  }

  function bind(container) {
    if (container._remindersBound) return;
    container._remindersBound = true;

    container.addEventListener('click', e => {
      if (!isTab() || !st.draft || st.saving) return;
      const t = e.target.closest('[data-rmd-master], [data-rmd-enabled], [data-rmd-type], [data-rmd-repeat], [data-rmd-day], [data-rmd-add], [data-rmd-remove], [data-rmd-save]');
      if (!t) return;
      const d = st.draft;
      if (t.hasAttribute('data-rmd-master')) {
        d.enabled = !d.enabled;
        rerender(container, '[data-rmd-master]');
      } else if (t.hasAttribute('data-rmd-enabled')) {
        const idx = Number(t.getAttribute('data-rmd-enabled'));
        if (d.reminders[idx]) d.reminders[idx].enabled = !d.reminders[idx].enabled;
        rerender(container, '[data-rmd-enabled="' + idx + '"]');
      } else if (t.hasAttribute('data-rmd-type') || t.hasAttribute('data-rmd-repeat')) {
        pickRadio(container, t);
      } else if (t.hasAttribute('data-rmd-day')) {
        const idx = Number(t.getAttribute('data-rmd-day'));
        const r = d.reminders[idx];
        const value = Number(t.getAttribute('data-value'));
        if (!r) return;
        const at = r.weekdays.indexOf(value);
        if (at === -1) r.weekdays.push(value); else r.weekdays.splice(at, 1);
        rerender(container, '[data-rmd-day="' + idx + '"][data-value="' + value + '"]');
      } else if (t.hasAttribute('data-rmd-add')) {
        if (d.reminders.length >= MAX_REMINDERS) return;
        d.reminders.push(nextReminder(d));
        rerender(container, '[data-rmd-item="' + (d.reminders.length - 1) + '"]');
      } else if (t.hasAttribute('data-rmd-remove')) {
        const idx = Number(t.getAttribute('data-rmd-remove'));
        d.reminders.splice(idx, 1);
        rerender(container, d.reminders.length ? '[data-rmd-remove="' + Math.min(idx, d.reminders.length - 1) + '"]' : '[data-rmd-add]');
      } else if (t.hasAttribute('data-rmd-save')) {
        save(container);
      }
    });

    // 單選按鈕組：方向鍵切換（與偏好設定相同的操作方式）
    container.addEventListener('keydown', e => {
      if (!isTab() || !st.draft || st.saving) return;
      const btn = e.target.closest && e.target.closest('.pref-seg-btn[data-rmd-type], .pref-seg-btn[data-rmd-repeat]');
      if (!btn) return;
      const step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      const group = Array.prototype.slice.call(btn.parentNode.querySelectorAll('.pref-seg-btn'));
      const next = group[(group.indexOf(btn) + step + group.length) % group.length];
      if (next) pickRadio(container, next);
    });

    // 下拉選單：選完整個重繪；時間與備註：只更新草稿與衍生的提示，不重建輸入框。
    const onEdit = e => {
      if (!isTab() || !st.draft || st.saving) return;
      const t = e.target;
      if (!t || !t.hasAttribute) return;
      const d = st.draft;
      if (t.hasAttribute('data-rmd-item') || t.hasAttribute('data-rmd-monthday')) {
        if (e.type !== 'change') return;
        const isItem = t.hasAttribute('data-rmd-item');
        const idx = Number(t.getAttribute(isItem ? 'data-rmd-item' : 'data-rmd-monthday'));
        const r = d.reminders[idx];
        if (!r) return;
        if (isItem) r.item = t.value; else r.monthDay = Number(t.value) || 1;
        rerender(container, '[' + (isItem ? 'data-rmd-item' : 'data-rmd-monthday') + '="' + idx + '"]');
        return;
      }
      const field = t.hasAttribute('data-rmd-time') ? 'time' : t.hasAttribute('data-rmd-note') ? 'note' : '';
      if (!field) return;
      const idx = Number(t.getAttribute('data-rmd-' + field));
      const r = d.reminders[idx];
      if (!r || r[field] === t.value) return;
      r[field] = t.value;
      patch(container, idx);
    };
    container.addEventListener('input', onEdit);
    container.addEventListener('change', onEdit);
  }

  return {
    render: render,
    /** 重新讀取設定或其他裝置改過時：沒有未儲存的變更才丟掉草稿。 */
    invalidate: function() {
      if (!isDirty()) st.draft = null;
    },
  };
})();
