const LocalCache = {
  KEY_BOOT: 'FAST_BOOKKEEPING_BOOT_V2',
  KEY_RECENT_PREFIX: 'FAST_BOOKKEEPING_RECENT_V2_',
  KEY_OVERVIEW: 'FAST_BOOKKEEPING_OVERVIEW_V2',
  KEY_SETTLEMENT: 'FAST_BOOKKEEPING_SETTLEMENT_V2',

  getBoot: function() {
    try {
      const raw = localStorage.getItem(this.KEY_BOOT);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  saveBoot: function(data) {
    if (!data) return;
    try {
      localStorage.setItem(this.KEY_BOOT, JSON.stringify(data));
      if (data.initialRecent && data.initialRecent.month) {
        this.saveRecent(data.initialRecent.month, data.initialRecent);
      }
    } catch (e) {}
  },

  getRecent: function(month) {
    if (!month) return null;
    try {
      const raw = localStorage.getItem(this.KEY_RECENT_PREFIX + month);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  saveRecent: function(month, recentData) {
    if (!month || !recentData) return;
    try {
      localStorage.setItem(this.KEY_RECENT_PREFIX + month, JSON.stringify(recentData));
      const boot = this.getBoot();
      if (boot && boot.selectedMonth === month) {
        boot.initialRecent = recentData;
        boot.cachedAt = Date.now();
        localStorage.setItem(this.KEY_BOOT, JSON.stringify(boot));
      }
    } catch (e) {}
  },

  getOverview: function() {
    try {
      const raw = localStorage.getItem(this.KEY_OVERVIEW);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  saveOverview: function(data) {
    if (!data) return;
    try {
      localStorage.setItem(this.KEY_OVERVIEW, JSON.stringify(data));
    } catch (e) {}
  },

  invalidateOverview: function(month) {
    try {
      localStorage.removeItem(this.KEY_OVERVIEW);
      localStorage.removeItem(this.KEY_SETTLEMENT);
    } catch (e) {}
    this.invalidateCharts(month);
  },

  KEY_CHARTS_PREFIX: 'FAST_BOOKKEEPING_CHARTS_V1_',
  CHARTS_MAX_MONTHS: 3,

  _chartsKeys: function() {
    const keys = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (k && k.indexOf(this.KEY_CHARTS_PREFIX) === 0) keys.push(k);
      }
    } catch (e) {}
    return keys;
  },

  getCharts: function(month) {
    if (!month) return null;
    try {
      const raw = localStorage.getItem(this.KEY_CHARTS_PREFIX + month);
      const wrapped = raw ? JSON.parse(raw) : null;
      return wrapped && wrapped.data ? wrapped.data : null;
    } catch (e) { return null; }
  },

  saveCharts: function(month, data) {
    if (!month || !data) return;
    try {
      localStorage.setItem(this.KEY_CHARTS_PREFIX + month, JSON.stringify({ savedAt: Date.now(), data: data }));
      const entries = this._chartsKeys().map(k => {
        let savedAt = 0;
        try { savedAt = (JSON.parse(localStorage.getItem(k)) || {}).savedAt || 0; } catch (e) {}
        return { key: k, savedAt: savedAt };
      });
      entries.sort((a, b) => b.savedAt - a.savedAt);
      entries.slice(this.CHARTS_MAX_MONTHS).forEach(e => localStorage.removeItem(e.key));
    } catch (e) {}
  },

  invalidateCharts: function(fromMonth) {
    try {
      const prefix = this.KEY_CHARTS_PREFIX;
      this._chartsKeys().forEach(k => {
        if (!fromMonth || k.slice(prefix.length) >= fromMonth) localStorage.removeItem(k);
      });
    } catch (e) {}
  },

  getSettlement: function() {
    try {
      const raw = localStorage.getItem(this.KEY_SETTLEMENT);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  saveSettlement: function(data) {
    try {
      if (!data) {
        localStorage.removeItem(this.KEY_SETTLEMENT);
      } else {
        localStorage.setItem(this.KEY_SETTLEMENT, JSON.stringify(data));
      }
    } catch (e) {}
  },

  KEY_ITEM_PREFS: 'FAST_BOOKKEEPING_ITEM_PREFS_V1',

  getItemPrefs: function() {
    try {
      const prefs = JSON.parse(localStorage.getItem(this.KEY_ITEM_PREFS));
      return prefs && typeof prefs === 'object' ? prefs : {};
    } catch (e) { return {}; }
  },

  saveItemPref: function(item, pref) {
    if (!item || !pref) return;
    try {
      const prefs = this.getItemPrefs();
      prefs[item] = { payment: pref.payment, category: pref.category, updatedAt: Date.now() };
      localStorage.setItem(this.KEY_ITEM_PREFS, JSON.stringify(prefs));
    } catch (e) {}
  },

  removeItemPref: function(item) {
    try {
      const prefs = this.getItemPrefs();
      delete prefs[item];
      localStorage.setItem(this.KEY_ITEM_PREFS, JSON.stringify(prefs));
    } catch (e) {}
  },

  KEY_QUICK_COMBO_MENU_OPEN: 'FAST_BOOKKEEPING_QUICK_COMBO_MENU_OPEN_V1',

  getQuickComboMenuOpen: function() {
    try {
      return localStorage.getItem(this.KEY_QUICK_COMBO_MENU_OPEN) === '1';
    } catch (e) { return false; }
  },

  saveQuickComboMenuOpen: function(isOpen) {
    try {
      localStorage.setItem(this.KEY_QUICK_COMBO_MENU_OPEN, isOpen ? '1' : '0');
    } catch (e) {}
  },

  KEY_SETTINGS_METADATA: 'FAST_BOOKKEEPING_SETTINGS_METADATA_V2',
  KEY_CUSTOM_IMAGES: 'FAST_BOOKKEEPING_CUSTOM_IMAGES_V2',

  getSettingsMetadata: function() {
    try {
      const raw = localStorage.getItem(this.KEY_SETTINGS_METADATA);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  saveSettingsMetadata: function(meta) {
    if (!meta) return;
    try {
      localStorage.setItem(this.KEY_SETTINGS_METADATA, JSON.stringify(meta));
      const imgs = Object.assign({}, this.getCustomImages());
      if (Array.isArray(meta.cards)) {
        meta.cards.forEach(c => {
          if (c && c.id && (c.customImage || c.image)) {
            imgs[c.id] = c.customImage || c.image;
          }
        });
      }
      if (Array.isArray(meta.banks)) {
        meta.banks.forEach(b => {
          if (b && b.id && (b.customLogo || b.logo)) {
            imgs[b.id] = b.customLogo || b.logo;
          }
        });
      }
      localStorage.setItem(this.KEY_CUSTOM_IMAGES, JSON.stringify(imgs));
    } catch (e) {}
  },

  getCustomImages: function() {
    try {
      const raw = localStorage.getItem(this.KEY_CUSTOM_IMAGES);
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  },

  saveCustomImage: function(id, dataUrl) {
    if (!id) return;
    try {
      const imgs = this.getCustomImages();
      if (dataUrl) {
        imgs[id] = dataUrl;
      } else {
        delete imgs[id];
      }
      localStorage.setItem(this.KEY_CUSTOM_IMAGES, JSON.stringify(imgs));
    } catch (e) {}
  },

  KEY_FX_LIST: 'FAST_BOOKKEEPING_FX_LIST_V1',
  KEY_FX_LEDGER_PREFIX: 'FAST_BOOKKEEPING_FX_LEDGER_V1_',
  KEY_FX_PREFS: 'FAST_BOOKKEEPING_FX_PREFS_V1',
  KEY_FX_HINT_HIDDEN: 'FAST_BOOKKEEPING_FX_HINT_HIDDEN_V1',

  _getJson: function(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  },

  _setJson: function(key, value) {
    try {
      if (value == null) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {}
  },

  getFxList: function() {
    const data = this._getJson(this.KEY_FX_LIST);
    return data && Array.isArray(data.ledgers) ? data : null;
  },

  saveFxList: function(ledgers) {
    if (!Array.isArray(ledgers)) return;
    this._setJson(this.KEY_FX_LIST, { ledgers: ledgers, savedAt: Date.now() });
  },

  getFxLedger: function(id) {
    if (id == null) return null;
    const data = this._getJson(this.KEY_FX_LEDGER_PREFIX + id);
    return data && Array.isArray(data.records) ? data : null;
  },

  saveFxLedger: function(id, data) {
    if (id == null || !data) return;
    this._setJson(this.KEY_FX_LEDGER_PREFIX + id, Object.assign({}, data, { savedAt: Date.now() }));
  },

  removeFxLedger: function(id) {
    if (id == null) return;
    this._setJson(this.KEY_FX_LEDGER_PREFIX + id, null);
    const prefs = this.getFxPrefs();
    if (prefs[id]) {
      delete prefs[id];
      this._setJson(this.KEY_FX_PREFS, prefs);
    }
  },

  getFxPrefs: function() {
    const prefs = this._getJson(this.KEY_FX_PREFS);
    return prefs && typeof prefs === 'object' ? prefs : {};
  },

  saveFxPref: function(id, patch) {
    if (id == null || !patch) return;
    const prefs = this.getFxPrefs();
    prefs[id] = Object.assign({}, prefs[id] || {}, patch, { updatedAt: Date.now() });
    this._setJson(this.KEY_FX_PREFS, prefs);
  },

  getFxHintHiddenDate: function() {
    try { return localStorage.getItem(this.KEY_FX_HINT_HIDDEN) || ''; } catch (e) { return ''; }
  },

  saveFxHintHiddenDate: function(iso) {
    try { localStorage.setItem(this.KEY_FX_HINT_HIDDEN, iso || ''); } catch (e) {}
  }
};
