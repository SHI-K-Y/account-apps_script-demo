function syncScrollbarWidth() {
  const sbw = Math.max(0, window.innerWidth - document.documentElement.clientWidth);
  document.documentElement.style.setProperty('--sbw', sbw + 'px');
}
syncScrollbarWidth();
window.addEventListener('resize', syncScrollbarWidth, { passive: true });

const MEAL_TIME_SLOTS = [
  { item: '早餐', start: '05:00', end: '10:29' },
  { item: '午餐', start: '10:30', end: '14:29' },
  { item: '點心', start: '14:30', end: '16:59' },
  { item: '晚餐', start: '17:00', end: '21:59' },
];

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
