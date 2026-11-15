function syncScrollbarWidth() {
  const sbw = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  document.documentElement.style.setProperty('--sbw', sbw + 'px');
}
syncScrollbarWidth();
window.addEventListener('resize', syncScrollbarWidth, { passive: true });

/* 時段建議：記帳頁依現在時間自動預選支出項目。
   使用者的設定存在 settings metadata 的 mealSlots（設定頁「時段建議」，後端見 56_settings_meal_slots.gs）；
   沒有存過就用下面的預設值。起始時間大於結束時間代表跨午夜（例如 22:00–01:59）。 */
const MealSlots = (function() {
  const DEFAULTS = [
    { item: '早餐', start: '05:00', end: '10:29' },
    { item: '午餐', start: '10:30', end: '14:29' },
    { item: '點心', start: '14:30', end: '16:59' },
    { item: '晚餐', start: '17:00', end: '21:59' },
  ];
  const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

  function toMinutes(text) {
    const m = TIME_RE.exec(String(text || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : -1;
  }

  function contains(slot, minutes) {
    const s = toMinutes(slot && slot.start);
    const e = toMinutes(slot && slot.end);
    if (s < 0 || e < 0 || s === e) return false;
    return s < e ? (minutes >= s && minutes <= e) : (minutes >= s || minutes <= e);
  }

  function metadata() {
    if (typeof settingsState !== 'undefined' && settingsState.metadata) return settingsState.metadata;
    if (typeof state !== 'undefined' && state.data && state.data.settingsMetadata) return state.data.settingsMetadata;
    return null;
  }

  /** 目前生效的設定：{ enabled, slots, custom }（custom＝使用者存過，不是預設值）。 */
  function config() {
    const meta = metadata();
    const saved = meta && meta.mealSlots;
    if (saved && Array.isArray(saved.slots)) {
      return { enabled: saved.enabled !== false, slots: saved.slots.map(s => Object.assign({}, s)), custom: true };
    }
    return { enabled: true, slots: DEFAULTS.map(s => Object.assign({}, s)), custom: false };
  }

  /** 某個時間點該建議的項目；停用、沒有符合的時段或項目已不存在時回傳 ''。 */
  function match(date, items) {
    const c = config();
    if (!c.enabled) return '';
    const minutes = date.getHours() * 60 + date.getMinutes();
    const slot = c.slots.find(s => contains(s, minutes));
    return slot && Array.isArray(items) && items.includes(slot.item) ? slot.item : '';
  }

  return { DEFAULTS, toMinutes, contains, config, match };
})();

(function applyAppIcon() {
  try {
    if (typeof APP_ICON_BASE64 === 'undefined' || !APP_ICON_BASE64) return;
    var iconRaw = String(APP_ICON_BASE64).replace(/\s+/g, '');
    var href = iconRaw.indexOf('data:') === 0 ? iconRaw
      : 'data:' + (iconRaw.indexOf('/9j/') === 0 ? 'image/jpeg'
        : iconRaw.indexOf('UklGR') === 0 ? 'image/webp' : 'image/png') + ';base64,' + iconRaw;
    [['icon', ''], ['apple-touch-icon', '180x180']].forEach(function(def) {
      document.querySelectorAll('link[rel="' + def[0] + '"]').forEach(function(n) { n.remove(); });
      var link = document.createElement('link');
      link.rel = def[0];
      if (def[1]) link.sizes = def[1];
      link.href = href;
      document.head.appendChild(link);
    });
  } catch (e) {  }
})();
