const Prefs = {
  KEY: 'FAST_BOOKKEEPING_PREFS_V1',
  DEFAULTS: { motion: 'full', autoScroll: true, perf: 'auto' },
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
      perf: ['auto', 'high', 'mid', 'low'].includes(saved.perf) ? saved.perf : this.DEFAULTS.perf,
    };
    return this._cache;
  },

  set: function(patch) {
    this._cache = Object.assign({}, this.get(), patch || {});
    try {
      localStorage.setItem(this.KEY, JSON.stringify(this._cache));
    } catch (e) {}
    Motion.sync();
    Perf.sync();
    try {
      document.dispatchEvent(new CustomEvent('prefschange', { detail: this._cache }));
    } catch (e) {}
    return this._cache;
  }
};
