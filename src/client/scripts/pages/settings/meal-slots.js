/* =============================================================================
 * MealSlotSettings — 設定頁的「時段建議」分頁
 * -----------------------------------------------------------------------------
 * 記帳頁在日期是「今天」時，會依現在時間預先選好支出項目並標上「建議」。
 * 這裡讓使用者開關這個功能、調整每個時段對應的項目與起訖時間。
 * 設定存在 settings metadata 的 mealSlots（跨裝置同步，後端見 56_settings_meal_slots.gs），
 * 判斷邏輯與預設值在 core/env.js 的 MealSlots。
 * ============================================================================= */
const MealSlotSettings = (function() {
  const MAX_SLOTS = 12;

  const st = {
    draft: null,   // { enabled, slots: [{ item, start, end }] }
    baseline: '',  // 最後一次儲存（或載入）時的 JSON，用來判斷有沒有未儲存的變更
    saving: false,
    confirmReset: false,
    confirmTimer: 0,
  };

  function expenseItems() {
    const simple = (state.data && state.data.options) || {};
    if (Array.isArray(simple.expenseItems) && simple.expenseItems.length) return simple.expenseItems;
    const raw = (settingsState.data && settingsState.data.expenseItems) || [];
    return raw.map(o => o && o.value).filter(Boolean);
  }

  function snapshot(d) {
    return JSON.stringify({ enabled: d.enabled, slots: d.slots.map(s => [s.item, s.start, s.end]) });
  }

  function makeDraft() {
    const c = MealSlots.config();
    const items = expenseItems();
    // 預設值裡不存在的項目（例如沒有「點心」）不列出來，避免一儲存就被擋下
    const slots = c.custom ? c.slots : c.slots.filter(s => items.indexOf(s.item) !== -1);
    return { enabled: c.enabled, slots: slots.map(s => ({ item: s.item, start: s.start, end: s.end })) };
  }

  function ensureDraft() {
    if (!st.draft) {
      st.draft = makeDraft();
      st.baseline = snapshot(st.draft);
    }
    return st.draft;
  }

  function isDirty() { return Boolean(st.draft) && snapshot(st.draft) !== st.baseline; }

  /* ---------------------------------- 檢查 ---------------------------------- */

  function minuteSet(slot) {
    const s = MealSlots.toMinutes(slot.start);
    const e = MealSlots.toMinutes(slot.end);
    if (s < 0 || e < 0 || s === e) return null;
    const out = [];
    const length = ((e - s + 1440) % 1440) + 1;
    for (let i = 0; i < length; i++) out.push((s + i) % 1440);
    return out;
  }

  /** 每個時段的問題：{ error: 會擋下儲存, warn: 只是提醒 } */
  function issues(d) {
    const items = expenseItems();
    const owner = new Array(1440);
    return d.slots.map((slot, idx) => {
      if (!slot.item) return { error: '請選擇支出項目' };
      const s = MealSlots.toMinutes(slot.start);
      const e = MealSlots.toMinutes(slot.end);
      if (s < 0 || e < 0) return { error: '請填寫開始與結束時間' };
      if (s === e) return { error: '開始與結束時間不能相同' };
      let clash = -1;
      minuteSet(slot).forEach(m => {
        if (owner[m] === undefined) owner[m] = idx;
        else if (clash === -1) clash = owner[m];
      });
      if (clash !== -1) return { error: '與「' + (d.slots[clash].item || '第 ' + (clash + 1) + ' 個時段') + '」的時段重疊' };
      if (items.indexOf(slot.item) === -1) return { warn: '「' + slot.item + '」已不在支出項目中，這個時段不會有建議' };
      if (s > e) return { note: '跨午夜：' + slot.start + ' 到隔天 ' + slot.end };
      return {};
    });
  }

  /* ---------------------------------- 畫面 ---------------------------------- */

  function timelineHtml(d) {
    const segs = [];
    d.slots.forEach((slot, idx) => {
      const s = MealSlots.toMinutes(slot.start);
      const e = MealSlots.toMinutes(slot.end);
      if (s < 0 || e < 0 || s === e || !slot.item) return;
      const parts = s < e ? [[s, e + 1]] : [[s, 1440], [0, e + 1]];
      parts.forEach(p => {
        segs.push('<span class="meal-tl-seg tone-' + (idx % 6) + '" style="left:' + (p[0] / 14.4).toFixed(3) + '%;width:' + ((p[1] - p[0]) / 14.4).toFixed(3) + '%" title="' +
                  escAttr(slot.item + ' ' + slot.start + '–' + slot.end) + '"></span>');
      });
    });
    const now = new Date();
    const nowPct = ((now.getHours() * 60 + now.getMinutes()) / 14.4).toFixed(3);
    return '<div class="meal-tl' + (d.enabled ? '' : ' is-off') + '" data-meal-tl aria-hidden="true">' +
             '<div class="meal-tl-track">' + segs.join('') + '<span class="meal-tl-now" style="left:' + nowPct + '%"></span></div>' +
             '<div class="meal-tl-ticks"><span>0</span><span>6</span><span>12</span><span>18</span><span>24</span></div>' +
           '</div>';
  }

  function slotRowHtml(slot, idx, issue, used) {
    const items = expenseItems();
    let list = items.filter(name => name === slot.item || used.indexOf(name) === -1);
    if (slot.item && items.indexOf(slot.item) === -1) list = [slot.item].concat(list);
    const opts = (slot.item ? '' : '<option value="" selected>選擇項目</option>') +
      list.map(name => '<option value="' + escAttr(name) + '"' + (name === slot.item ? ' selected' : '') + '>' + escHtml(name) + '</option>').join('');
    const label = slot.item || ('第 ' + (idx + 1) + ' 個時段');
    return '<li class="meal-slot-row' + (issue.error ? ' has-error' : '') + '">' +
             '<span class="meal-slot-dot tone-' + (idx % 6) + '" aria-hidden="true"></span>' +
             '<select class="month-select meal-slot-item" data-meal-item="' + idx + '" aria-label="第 ' + (idx + 1) + ' 個時段的項目">' + opts + '</select>' +
             '<div class="meal-slot-times">' +
               '<input class="text-input meal-slot-time" type="time" step="60" required data-meal-start="' + idx + '" value="' + escAttr(slot.start) + '" aria-label="' + escAttr(label) + ' 開始時間">' +
               '<span class="meal-slot-sep" aria-hidden="true">–</span>' +
               '<input class="text-input meal-slot-time" type="time" step="60" required data-meal-end="' + idx + '" value="' + escAttr(slot.end) + '" aria-label="' + escAttr(label) + ' 結束時間">' +
             '</div>' +
             '<button type="button" class="icon-btn meal-slot-remove" data-meal-remove="' + idx + '" title="移除" aria-label="移除 ' + escAttr(label) + '">' + iconHtml('x') + '</button>' +
             '<div class="meal-slot-msg" data-meal-msg="' + idx + '"' + msgAttrs(issue) + '>' + escHtml(msgText(issue)) + '</div>' +
           '</li>';
  }

  function msgText(issue) { return issue.error || issue.warn || issue.note || ''; }
  function msgClass(issue) { return issue.error ? 'is-error' : issue.warn ? 'is-warn' : 'is-note'; }
  function msgAttrs(issue) {
    return ' data-tone="' + msgClass(issue) + '"' + (msgText(issue) ? '' : ' hidden');
  }

  function actionsHtml(d, hasError, dirty) {
    const custom = MealSlots.config().custom;
    return (custom
        ? '<button type="button" class="budget-delete-btn' + (st.confirmReset ? ' is-confirm' : '') + '" data-meal-reset>' +
            (st.confirmReset ? '再按一次確認恢復預設' : '恢復預設時段') + '</button>'
        : '<span class="meal-dirty-note">目前使用預設時段</span>') +
      (dirty ? '<span class="meal-dirty-note is-dirty">尚未儲存</span>' : '') +
      '<button type="button" class="settings-add-btn budget-save-btn" data-meal-save' + (st.saving || hasError || !dirty ? ' disabled' : '') + '>' +
        iconHtml(st.saving ? 'spinner-gap' : 'check', 'regular', 'ic-16' + (st.saving ? ' spinner' : '')) +
        (st.saving ? '儲存中…' : '儲存') +
      '</button>';
  }

  /** 只更新會隨時間欄位變動的部分（時間軸、每列提示、儲存按鈕），不重建輸入框，打字時游標不會跳走。 */
  function patch(container) {
    const d = st.draft;
    const list = issues(d);
    const tl = container.querySelector('[data-meal-tl]');
    if (tl) tl.outerHTML = timelineHtml(d);
    list.forEach((issue, idx) => {
      const el = container.querySelector('[data-meal-msg="' + idx + '"]');
      if (!el) return;
      el.textContent = msgText(issue);
      el.hidden = !msgText(issue);
      el.setAttribute('data-tone', msgClass(issue));
      if (issue.error) el.setAttribute('role', 'alert'); else el.removeAttribute('role');
      const row = el.closest('.meal-slot-row');
      if (row) row.classList.toggle('has-error', Boolean(issue.error));
    });
    const actions = container.querySelector('[data-meal-actions]');
    if (actions) actions.innerHTML = actionsHtml(d, list.some(i => i.error), isDirty());
  }

  /** 新時段預設接在最後一個時段之後一小時。 */
  function nextSlot(d) {
    const used = d.slots.map(s => s.item);
    const item = expenseItems().filter(name => used.indexOf(name) === -1)[0] || '';
    const last = d.slots[d.slots.length - 1];
    const lastEnd = last ? MealSlots.toMinutes(last.end) : -1;
    const start = lastEnd >= 0 ? (lastEnd + 1) % 1440 : 12 * 60;
    const end = (start + 59) % 1440;
    const fmt = m => String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
    return { item: item, start: fmt(start), end: fmt(end) };
  }

  function render(container) {
    if (!container) return;
    bind(container);
    const d = ensureDraft();
    const list = issues(d);
    const hasError = list.some(i => i.error);
    const dirty = isDirty();
    const used = d.slots.map(s => s.item);

    const rows = d.slots.map((slot, idx) => slotRowHtml(slot, idx, list[idx], used)).join('');
    const canAdd = d.slots.length < MAX_SLOTS;

    container.innerHTML =
      '<div class="settings-list-header">' +
        '<div class="settings-list-title-wrap">' +
          '<span class="settings-list-title">時段建議</span>' +
        '</div>' +
      '</div>' +
      '<div class="pref-list meal-settings">' +
        '<div class="pref-card pref-card-row">' +
          '<div class="pref-card-text">' +
            '<div class="pref-card-title" id="mealEnabledTitle">依時間自動建議記帳項目</div>' +
          '</div>' +
          '<button type="button" class="pref-switch' + (d.enabled ? ' is-on' : '') + '" role="switch" data-meal-toggle' +
            ' aria-checked="' + (d.enabled ? 'true' : 'false') + '" aria-labelledby="mealEnabledTitle">' +
            '<span class="pref-switch-thumb" aria-hidden="true"></span>' +
          '</button>' +
        '</div>' +
        '<div class="pref-card' + (d.enabled ? '' : ' is-muted') + '">' +
          '<div class="pref-card-text">' +
            InfoTip.withTitle('<div class="pref-card-title">時段</div>', 'mealTip-slots',
              '時段之間不能重疊；開始時間晚於結束時間代表跨午夜（例如 22:00–01:59 宵夜）') +
          '</div>' +
          timelineHtml(d) +
          (rows ? '<ul class="meal-slot-list">' + rows + '</ul>' : '<div class="meal-slot-empty">尚未設定任何時段</div>') +
          (canAdd ? '<button type="button" class="budget-add-reserve" data-meal-add>' + iconHtml('plus', 'regular', 'ic-14') + '新增時段</button>' : '') +
        '</div>' +
        '<div class="budget-actions meal-actions" data-meal-actions>' + actionsHtml(d, hasError, dirty) + '</div>' +
      '</div>';
  }

  /* ---------------------------------- 操作 ---------------------------------- */

  function rerender(container, focusSelector) {
    render(container);
    if (focusSelector) {
      const el = container.querySelector(focusSelector);
      if (el) el.focus();
    }
  }

  function applyResult(res, container, message) {
    st.saving = false;
    st.confirmReset = false;
    if (res && res.ok) {
      settingsState.data = res.options;
      refreshBookkeepingOptions(res.simpleOptions, res.options, res.metadata);
    }
    st.draft = null;
    ensureDraft();
    if (settingsState.currentTab === 'mealSlots') render(container);
    showToast(message, 'success');
  }

  function send(container, payload, message) {
    st.saving = true;
    render(container);
    Api.call('saveMealSlots', payload)
      .then(res => applyResult(res, container, message))
      .catch(err => {
        st.saving = false;
        st.confirmReset = false;
        if (settingsState.currentTab === 'mealSlots') render(container);
        showToast('儲存失敗：' + ((err && err.message) || err), 'error');
      });
  }

  function save(container) {
    if (st.saving || !st.draft) return;
    const firstError = issues(st.draft).map((i, idx) => i.error ? '第 ' + (idx + 1) + ' 個時段：' + i.error : '').filter(Boolean)[0];
    if (firstError) return showToast(firstError, 'error');
    send(container, { enabled: st.draft.enabled, slots: st.draft.slots }, '時段建議已儲存');
  }

  function reset(container) {
    if (st.saving) return;
    if (!st.confirmReset) {
      st.confirmReset = true;
      clearTimeout(st.confirmTimer);
      st.confirmTimer = setTimeout(() => {
        st.confirmReset = false;
        if (settingsState.currentTab === 'mealSlots') render(container);
      }, 4000);
      render(container);
      return;
    }
    clearTimeout(st.confirmTimer);
    send(container, { reset: true, slots: [] }, '已恢復預設時段');
  }

  function bind(container) {
    if (container._mealSlotsBound) return;
    container._mealSlotsBound = true;

    container.addEventListener('click', e => {
      if (settingsState.currentTab !== 'mealSlots' || !st.draft) return;
      const t = e.target.closest('[data-meal-toggle], [data-meal-add], [data-meal-remove], [data-meal-save], [data-meal-reset]');
      if (!t || st.saving) return;
      const d = st.draft;
      if (t.hasAttribute('data-meal-toggle')) {
        d.enabled = !d.enabled;
        rerender(container, '[data-meal-toggle]');
      } else if (t.hasAttribute('data-meal-add')) {
        if (d.slots.length >= MAX_SLOTS) return;
        d.slots.push(nextSlot(d));
        rerender(container, '[data-meal-item="' + (d.slots.length - 1) + '"]');
      } else if (t.hasAttribute('data-meal-remove')) {
        d.slots.splice(Number(t.getAttribute('data-meal-remove')), 1);
        rerender(container, d.slots.length ? '[data-meal-remove="' + Math.min(Number(t.getAttribute('data-meal-remove')), d.slots.length - 1) + '"]' : '[data-meal-add]');
      } else if (t.hasAttribute('data-meal-save')) {
        save(container);
      } else if (t.hasAttribute('data-meal-reset')) {
        reset(container);
      }
    });

    // 項目下拉選單：選完就整個重繪（其他列可選的項目會跟著變）。
    // 時間欄位：只更新草稿與衍生的提示，不重建輸入框。
    const onEdit = e => {
      if (settingsState.currentTab !== 'mealSlots' || !st.draft || st.saving) return;
      const t = e.target;
      if (!t || !t.hasAttribute) return;
      const d = st.draft;
      if (t.hasAttribute('data-meal-item')) {
        if (e.type !== 'change') return;
        const idx = Number(t.getAttribute('data-meal-item'));
        if (d.slots[idx]) d.slots[idx].item = t.value;
        rerender(container, '[data-meal-item="' + idx + '"]');
        return;
      }
      const field = t.hasAttribute('data-meal-start') ? 'start' : t.hasAttribute('data-meal-end') ? 'end' : '';
      if (!field) return;
      const slot = d.slots[Number(t.getAttribute('data-meal-' + field))];
      if (!slot || slot[field] === t.value) return;
      slot[field] = t.value;
      patch(container);
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
