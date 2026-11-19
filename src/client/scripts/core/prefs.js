const Prefs = {
  KEY: 'FAST_BOOKKEEPING_PREFS_V1',
  DEFAULTS: { motion: 'full', autoScroll: true },
  _cache: null,

  get: function() {
    if (this._cache) return this._cache;
    let saved = {};
    try {
      const raw = localStorage.getItem(this.KEY);
      saved = raw ? (JSON.parse(raw) || {}) : {};
    } catch (e) { saved = {}; }
    this._cache = {
      motion: ['full', 'lite', 'off'].includes(saved.motion) ? saved.motion : this.DEFAULTS.motion,
      autoScroll: typeof saved.autoScroll === 'boolean' ? saved.autoScroll : this.DEFAULTS.autoScroll,
    };
    return this._cache;
  },

  set: function(patch) {
    this._cache = Object.assign({}, this.get(), patch || {});
    try {
      localStorage.setItem(this.KEY, JSON.stringify(this._cache));
    } catch (e) {}
    Motion.sync();
    try {
      document.dispatchEvent(new CustomEvent('prefschange', { detail: this._cache }));
    } catch (e) {}
    return this._cache;
  },

  // P04 移除了效能分級：清掉舊版留下的分級紀錄，以及偏好設定裡的 perf 欄位（其他欄位原樣保留）。
  cleanupLegacy: function() {
    try {
      localStorage.removeItem('FAST_BOOKKEEPING_' + 'PERF_V1');
      const raw = localStorage.getItem(this.KEY);
      const saved = raw ? JSON.parse(raw) : null;
      if (saved && typeof saved === 'object' && Object.prototype.hasOwnProperty.call(saved, 'perf')) {
        delete saved.perf;
        localStorage.setItem(this.KEY, JSON.stringify(saved));
        this._cache = null;
      }
    } catch (e) {}
  }
};
Prefs.cleanupLegacy();
