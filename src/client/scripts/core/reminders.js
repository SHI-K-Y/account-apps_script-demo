/* =============================================================================
 * RecordReminders — 記帳提醒的判斷規則（不碰畫面）
 * -----------------------------------------------------------------------------
 * 設定存在 settings metadata 的 recordReminders（設定頁「記帳提醒」，後端見 57_settings_reminders.gs）。
 * 每個提醒什麼時候該跳出來：
 *   每天：今天過了設定時間，而今天還沒記這個項目。
 *   每週：今天是勾選的星期之一，過了設定時間，而今天還沒記這個項目。
 *   每月：今天是設定日（超過當月天數時以月底為準）或之後，過了設定時間，而本月還沒記這個項目；
 *         月初就先記好的話不會提醒，設定日當天沒打開記帳簿，之後打開仍會提醒到月底。
 * 紀錄只有「日」沒有時間，所以「有沒有記」以日期判斷：當天（每天／每週）或當月（每月）有沒有這個項目。
 * 跳出卡片與「今日不再顯示」等畫面行為在 app/reminder-prompt.js。
 * ============================================================================= */
const RecordReminders = (function() {
  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
  /** 顯示順序：週一到週日；值是 getDay()。 */
  const WEEKDAYS = [
    { value: 1, label: '一' }, { value: 2, label: '二' }, { value: 3, label: '三' }, { value: 4, label: '四' },
    { value: 5, label: '五' }, { value: 6, label: '六' }, { value: 0, label: '日' },
  ];
  const TYPE_LABELS = { expense: '支出', income: '收入' };

  function toMinutes(text) {
    const m = TIME_RE.exec(String(text || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  }

  function pad(n) { return String(n).padStart(2, '0'); }
  function isoDate(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function daysInMonth(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); }

  function metadata() {
    if (typeof settingsState !== 'undefined' && settingsState.metadata) return settingsState.metadata;
    if (typeof state !== 'undefined' && state.data && state.data.settingsMetadata) return state.data.settingsMetadata;
    return null;
  }

  function clean(r) {
    const out = {
      id: String(r.id || ''),
      enabled: r.enabled !== false,
      type: r.type === 'income' ? 'income' : 'expense',
      item: String(r.item || ''),
      repeat: r.repeat === 'weekly' || r.repeat === 'monthly' ? r.repeat : 'daily',
      time: String(r.time || ''),
      weekdays: Array.isArray(r.weekdays) ? r.weekdays.map(Number).filter(n => n >= 0 && n <= 6) : [],
      monthDay: Number(r.monthDay) || 1,
    };
    return out;
  }

  /** 目前生效的設定：{ enabled, reminders }；沒存過就是空清單。 */
  function config(meta) {
    const saved = (meta !== undefined ? meta : metadata());
    const raw = saved && saved.recordReminders;
    if (!raw || !Array.isArray(raw.reminders)) return { enabled: true, reminders: [] };
    return { enabled: raw.enabled !== false, reminders: raw.reminders.filter(Boolean).map(clean) };
  }

  /**
   * 今天這個提醒「這一輪」的範圍；今天不是提醒日時回傳 null。
   *   scope  'day'（只看今天的紀錄）或 'month'（看本月的紀錄）
   *   dueAt  從什麼時候開始提醒
   */
  function occurrence(r, now) {
    const minutes = toMinutes(r.time);
    if (minutes < 0) return null;
    const at = day => new Date(now.getFullYear(), now.getMonth(), day, Math.floor(minutes / 60), minutes % 60);
    if (r.repeat === 'weekly') {
      return r.weekdays.indexOf(now.getDay()) === -1 ? null : { scope: 'day', dueAt: at(now.getDate()) };
    }
    if (r.repeat === 'monthly') {
      const day = Math.min(Math.max(1, r.monthDay), daysInMonth(now));
      return now.getDate() < day ? null : { scope: 'month', day: day, dueAt: at(day) };
    }
    return { scope: 'day', dueAt: at(now.getDate()) };
  }

  /** records：當月的 { day, item } 清單（{ expense: [...], income: [...] }）。 */
  function isRecorded(r, scope, records, now) {
    const list = (records && records[r.type]) || [];
    const today = now.getDate();
    return list.some(rec => rec && String(rec.item || '').trim() === r.item &&
      (scope === 'month' || parseInt(rec.day, 10) === today));
  }

  /**
   * 單一提醒現在的狀態：
   *   off（總開關或這個提醒關閉）、missing（項目已不存在）、idle（今天不是提醒日）、
   *   pending（還沒到時間）、done（已經記了）、due（該提醒）、unknown（沒有當月紀錄可判斷）
   * ctx：{ now, records, items: { expense, income }, enabled }
   */
  function status(r, ctx) {
    const now = ctx.now || new Date();
    if (ctx.enabled === false || !r.enabled) return { state: 'off' };
    const items = (ctx.items && ctx.items[r.type]) || null;
    if (!r.item || (items && items.indexOf(r.item) === -1)) return { state: 'missing' };
    const occ = occurrence(r, now);
    if (!occ) return { state: 'idle' };
    if (!ctx.records) return { state: 'unknown', scope: occ.scope, dueAt: occ.dueAt };
    if (isRecorded(r, occ.scope, ctx.records, now)) return { state: 'done', scope: occ.scope, dueAt: occ.dueAt };
    if (now < occ.dueAt) return { state: 'pending', scope: occ.scope, dueAt: occ.dueAt };
    return { state: 'due', scope: occ.scope, dueAt: occ.dueAt };
  }

  /**
   * 現在該跳出來的提醒（依開始提醒的時間排序）；同一個項目只留一個。
   * ctx.skip(key)：回傳 true 的項目略過（已關閉或今日不再顯示）。
   */
  function due(ctx) {
    const c = ctx.config || config();
    const seen = {};
    return c.reminders
      .map(r => ({ reminder: r, st: status(r, Object.assign({}, ctx, { enabled: c.enabled })) }))
      .filter(x => x.st.state === 'due' && !(ctx.skip && ctx.skip(itemKey(x.reminder))))
      .sort((a, b) => a.st.dueAt - b.st.dueAt)
      .filter(x => {
        const key = itemKey(x.reminder);
        if (seen[key]) return false;
        seen[key] = true;
        return true;
      })
      .map(x => Object.assign({}, x.reminder, { key: itemKey(x.reminder), scope: x.st.scope, dueAt: x.st.dueAt }));
  }

  function weekdayText(days) {
    const order = WEEKDAYS.map(w => w.value).filter(v => days.indexOf(v) !== -1);
    if (order.length === 7) return '每天';
    if (order.join() === '1,2,3,4,5') return '週一至週五';
    if (order.join() === '6,0') return '週六、週日';
    return '週' + order.map(v => WEEKDAYS.find(w => w.value === v).label).join('、');
  }

  /** 「每天 13:00」「每週一、三 13:00」「每月 5 日 09:00」 */
  function scheduleText(r) {
    if (r.repeat === 'weekly') {
      const w = weekdayText(r.weekdays);
      return (w === '每天' ? w : '每' + w) + ' ' + r.time;
    }
    if (r.repeat === 'monthly') return '每月 ' + r.monthDay + ' 日 ' + r.time;
    return '每天 ' + r.time;
  }

  /** 同一個項目的提醒共用一張卡片；「關閉」「今日不再顯示」也以項目為單位。 */
  function itemKey(r) { return r.type + ':' + r.item; }

  return {
    WEEKDAYS: WEEKDAYS,
    TYPE_LABELS: TYPE_LABELS,
    toMinutes: toMinutes,
    isoDate: isoDate,
    daysInMonth: daysInMonth,
    config: config,
    occurrence: occurrence,
    status: status,
    due: due,
    weekdayText: weekdayText,
    scheduleText: scheduleText,
    itemKey: itemKey,
  };
})();
