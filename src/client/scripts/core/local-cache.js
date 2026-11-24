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

  /* 寫回開機資料（P08：內容沒變就不寫）。結果與以前相同：開機資料＋該月的最近紀錄；
   * initialRecent 是目前選取的月份時，開機資料的 cachedAt 改成現在（以前經由 saveRecent 再寫一次）。
   * cachedAt 只用來在「伺服器內嵌的」與「本機快取的」兩份之間挑新的；內容相同時挑哪一份都一樣，所以不為了它重寫。 */
  saveBoot: function(data) {
    if (!data) return;
    try {
      const recent = data.initialRecent && data.initialRecent.month ? data.initialRecent : null;
      const stamped = recent && data.selectedMonth === recent.month;
      const text = JSON.stringify(Object.assign({}, data, stamped ? { cachedAt: 0 } : null));
      const prevRaw = localStorage.getItem(this.KEY_BOOT);
      let prev = null;
      if (prevRaw && stamped) {
        try { const p = JSON.parse(prevRaw); p.cachedAt = 0; prev = JSON.stringify(p); } catch (e) { prev = null; }
      } else {
        prev = prevRaw;
      }
      if (prev !== text) {
        localStorage.setItem(this.KEY_BOOT, stamped ? JSON.stringify(Object.assign({}, data, { cachedAt: Date.now() })) : text);
      }
      if (recent) this._setIfChanged(this.KEY_RECENT_PREFIX + recent.month, JSON.stringify(recent));
    } catch (e) {}
  },

  /** 內容和已存的一樣就不寫（localStorage 寫入是同步的，大的 JSON 會卡主執行緒）。回傳是否有寫入。 */
  _setIfChanged: function(key, text) {
    try {
      if (localStorage.getItem(key) === text) return false;
      localStorage.setItem(key, text);
      return true;
    } catch (e) { return false; }
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
      // 內容沒變就不寫（P08）：卡面、銀行圖示也是從同一份 metadata 來的，已經存過了
      if (!this._setIfChanged(this.KEY_SETTINGS_METADATA, JSON.stringify(meta))) return;
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
  },

  /* 記帳提醒「今日不再顯示」：{ date, keys }，日期不是今天就視為沒有（隔天自動恢復）。 */
  KEY_REMINDER_SNOOZE: 'FAST_BOOKKEEPING_REMINDER_SNOOZE_V1',

  getReminderSnooze: function(todayISO) {
    const data = this._getJson(this.KEY_REMINDER_SNOOZE);
    return data && data.date === todayISO && Array.isArray(data.keys) ? data.keys.slice() : [];
  },

  saveReminderSnooze: function(todayISO, keys) {
    this._setJson(this.KEY_REMINDER_SNOOZE, { date: todayISO, keys: Array.isArray(keys) ? keys : [] });
  }
};
