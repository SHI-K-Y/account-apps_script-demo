/* =============================================================================
 * LocalCache — 瀏覽器端快取（P12：先顯示、再更新）
 * -----------------------------------------------------------------------------
 * 大型資料（開機資料、各月紀錄、總覽、對帳、圖表、預算設定、設定 metadata、卡面、國外帳簿）存在 IndexedDB
 * （core/kv-store.js），localStorage 只放小型偏好（項目偏好、選單開關、國外帳簿偏好、提醒「今日不再顯示」）。
 *
 *   - 讀取是同步的：開機時（這個檔案一執行）就把 IndexedDB 整份讀進記憶體，之後的 get* 直接讀記憶體，
 *     回傳複本（呼叫端可以放心修改）；AppBoot 開機第一段之前會等它讀完（最多一小段時間，見 whenReady）。
 *   - 寫入先改記憶體，再合併到下一次閒置時間（requestIdleCallback）一次寫回；同一個鍵在一次閒置內只寫最後一份。
 *     分頁切到背景時立刻寫回。存入時也複製一份，之後呼叫端再修改原物件不會影響快取。
 *   - 記帳後不刪除總覽／對帳／圖表／預算，只標成「過期」（markStale）：畫面照樣先顯示舊資料並標示「更新中」，
 *     拿到新資料（save*）時自動清掉過期標記。status(kind, month) 回傳 { stale, savedAt }。
 *   - 開機資料不重複存最近紀錄：boot 只記 recentMonth，getBoot() 時從 'recent:<月份>' 補回 initialRecent。
 *   - 舊版（P12 以前）存在 localStorage 的資料第一次啟動時搬進 IndexedDB，寫入成功後刪除。
 *     IndexedDB 不能用（隱私模式等）時只放記憶體，舊資料照樣讀得到、也不刪除。
 * ============================================================================= */
const LocalCache = (function() {
  const IDLE_TIMEOUT_MS = 2000;
  const CHARTS_MAX_MONTHS = 3;
  const LEGACY = [
    [/^FAST_BOOKKEEPING_BOOT_V2$/, () => 'boot'],
    [/^FAST_BOOKKEEPING_RECENT_V2_(.+)$/, m => 'recent:' + m[1]],
    [/^FAST_BOOKKEEPING_OVERVIEW_V2$/, () => 'overview'],
    [/^FAST_BOOKKEEPING_SETTLEMENT_V2$/, () => 'settlement'],
    [/^FAST_BOOKKEEPING_CHARTS_V1_(.+)$/, m => 'charts:' + m[1]],
    [/^FAST_BOOKKEEPING_SETTINGS_METADATA_V2$/, () => 'meta'],
    [/^FAST_BOOKKEEPING_CUSTOM_IMAGES_V2$/, () => 'images'],
    [/^FAST_BOOKKEEPING_FX_LIST_V1$/, () => 'fxList'],
    [/^FAST_BOOKKEEPING_FX_LEDGER_V1_(.+)$/, m => 'fxLedger:' + m[1]],
  ];

  const mem = new Map();       // 鍵 → { v: 值, t: 存入時間, s: 是否過期 }
  const touched = new Set();   // 讀完 IndexedDB 之前就寫過／刪過的鍵：讀回來的舊值不蓋掉它
  const dirty = new Map();     // 下一次閒置要寫回的鍵 → entry（undefined 表示刪除）
  let flushQueued = false;
  let persistent = false;
  let ready = false;
  let resolveReady;
  const readyPromise = new Promise(r => { resolveReady = r; });

  const clone = v => {
    if (v == null || typeof v !== 'object') return v;
    try { if (typeof structuredClone === 'function') return structuredClone(v); } catch (e) {}
    return JSON.parse(JSON.stringify(v));
  };
  const hasKv = () => typeof KvStore !== 'undefined' && typeof indexedDB !== 'undefined';

  /* ------------------------------ 記憶體與寫回 ------------------------------ */
  function value(key) { const e = mem.get(key); return e ? clone(e.v) : null; }
  function setEntry(key, entry) {
    touched.add(key);
    if (entry) mem.set(key, entry); else mem.delete(key);
    dirty.set(key, entry || undefined);
    queueFlush();
  }
  function put(key, v) { setEntry(key, { v: clone(v), t: Date.now(), s: false }); }
  function remove(key) { if (mem.has(key) || !ready) setEntry(key, null); }
  function keysWith(prefix) { return Array.from(mem.keys()).filter(k => k.indexOf(prefix) === 0); }

  function queueFlush() {
    if (flushQueued) return;
    flushQueued = true;
    const run = () => { flushQueued = false; flush(); };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
    else setTimeout(run, 200);
  }
  function flush() {
    if (!dirty.size) return Promise.resolve(true);
    const entries = Array.from(dirty.entries());
    dirty.clear();
    if (!hasKv() || (ready && !persistent)) return Promise.resolve(false);
    return KvStore.write(entries);
  }
  try {
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });
  } catch (e) {}

  /* ------------------------------ 開機時讀回、搬移舊資料 ------------------------------ */
  function readLegacy() {
    const found = [];
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        for (const [re, map] of LEGACY) {
          const m = k && k.match(re);
          if (m) { found.push([k, map(m)]); break; }
        }
      }
    } catch (e) {}
    return found;
  }

  function migrateLegacy() {
    const legacy = readLegacy();
    if (!legacy.length) return;
    const adopt = (key, v, t) => {
      if (mem.has(key) || touched.has(key) || v == null) return;
      mem.set(key, { v: v, t: t || 0, s: false });
      if (persistent) dirty.set(key, mem.get(key));
    };
    legacy.forEach(([oldKey, key]) => {
      let v = null;
      try { v = JSON.parse(localStorage.getItem(oldKey)); } catch (e) { v = null; }
      if (key === 'boot' && v && typeof v === 'object') {
        const recent = v.initialRecent && v.initialRecent.month ? v.initialRecent : null;
        if (recent) adopt('recent:' + recent.month, recent, v.cachedAt);
        v = Object.assign({}, v, { recentMonth: recent ? recent.month : null });
        delete v.initialRecent;
      }
      if (key.indexOf('charts:') === 0) { adopt(key, v && v.data, v && v.savedAt); return; }
      adopt(key, v, v && v.savedAt);
    });
    if (!persistent) return;   // IndexedDB 不能用：舊資料留著當唯讀來源
    flush().then(ok => {
      if (!ok) return;
      legacy.forEach(([oldKey]) => { try { localStorage.removeItem(oldKey); } catch (e) {} });
    });
  }

  function hydrate() {
    const done = () => { ready = true; resolveReady(persistent); };
    if (!hasKv()) { migrateLegacy(); done(); return; }
    KvStore.readAll().then(all => {
      persistent = Boolean(all);
      if (all) {
        all.forEach((entry, key) => {
          if (!touched.has(key) && entry && typeof entry === 'object' && 'v' in entry) mem.set(key, entry);
        });
      }
      migrateLegacy();
      done();
    }, () => { migrateLegacy(); done(); });
  }
  hydrate();

  /* ------------------------------ 對外介面 ------------------------------ */
  const STATUS_KEYS = { overview: () => 'overview', settlement: () => 'settlement', budget: () => 'budget', charts: m => 'charts:' + m };

  return {
    /** 讀完 IndexedDB（或超過 timeoutMs）時 resolve；回傳 Promise<boolean>（是否真的讀完）。 */
    whenReady: function(timeoutMs) {
      if (ready) return Promise.resolve(true);
      if (!(timeoutMs > 0)) return readyPromise.then(() => true);
      return Promise.race([readyPromise.then(() => true), new Promise(r => setTimeout(() => r(false), timeoutMs))]);
    },
    isReady: () => ready,
    /** 立刻寫回（測試、離開頁面前用）。 */
    flush: flush,

    getBoot: function() {
      const e = mem.get('boot');
      if (!e) return null;
      const boot = clone(e.v);
      const month = boot.recentMonth || boot.selectedMonth;
      boot.initialRecent = month ? value('recent:' + month) : null;
      delete boot.recentMonth;
      return boot;
    },

    /* 寫回開機資料：最近紀錄分開存在 'recent:<月份>'（不存兩份）。initialRecent 是目前選取的月份時，
     * cachedAt 改成現在（「伺服器內嵌的」與「本機快取的」兩份之間挑新的，見 AppBoot.pickBootData）。 */
    saveBoot: function(data) {
      if (!data) return;
      const recent = data.initialRecent && data.initialRecent.month ? data.initialRecent : null;
      const boot = Object.assign({}, data);
      delete boot.initialRecent;
      const prev = mem.get('boot');
      boot.recentMonth = recent ? recent.month : (prev && prev.v.recentMonth) || null;
      if (recent && data.selectedMonth === recent.month) boot.cachedAt = Date.now();
      if (recent) put('recent:' + recent.month, recent);
      put('boot', boot);
    },

    getRecent: month => (month ? value('recent:' + month) : null),

    saveRecent: function(month, recentData) {
      if (!month || !recentData) return;
      put('recent:' + month, recentData);
      const boot = mem.get('boot');
      if (boot && boot.v.selectedMonth === month) {
        // 只換掉兩個欄位（淺複製，不重新序列化整份開機資料）
        setEntry('boot', { v: Object.assign({}, boot.v, { cachedAt: Date.now(), recentMonth: month }), t: Date.now(), s: false });
      }
    },

    /** 設定變更後各月紀錄的格式可能不同：全部丟掉，下次從伺服器讀。 */
    clearRecents: function() { keysWith('recent:').forEach(remove); },

    getOverview: () => value('overview'),
    saveOverview: data => { if (data) put('overview', data); },

    getSettlement: () => value('settlement'),
    saveSettlement: data => { if (data) put('settlement', data); else remove('settlement'); },

    getBudgetSettings: () => value('budget'),
    saveBudgetSettings: data => { if (data) put('budget', data); },

    getCharts: month => (month ? value('charts:' + month) : null),
    saveCharts: function(month, data) {
      if (!month || !data) return;
      const key = 'charts:' + month;
      put(key, data);
      // 只留最近存的 CHARTS_MAX_MONTHS 個月（剛存的這個一定留著；同一時間存的，留月份比較新的）
      keysWith('charts:').filter(k => k !== key)
        .sort((a, b) => (mem.get(b).t - mem.get(a).t) || (a < b ? 1 : -1))
        .slice(CHARTS_MAX_MONTHS - 1)
        .forEach(remove);
    },

    /** { stale, savedAt } 或 null（沒有快取）。kind：overview／settlement／budget／charts（要給 month）。 */
    status: function(kind, month) {
      const key = STATUS_KEYS[kind] && STATUS_KEYS[kind](month);
      const e = key && mem.get(key);
      return e ? { stale: Boolean(e.s), savedAt: e.t || 0 } : null;
    },

    /* 記帳、對帳、設定變更之後：總覽、對帳、預算與 fromMonth（含）之後的圖表標成過期，不刪除。 */
    markStale: function(fromMonth) {
      const keys = ['overview', 'settlement', 'budget'].concat(
        keysWith('charts:').filter(k => !fromMonth || k.slice(7) >= fromMonth));
      keys.forEach(k => {
        const e = mem.get(k);
        if (e && !e.s) setEntry(k, Object.assign({}, e, { s: true }));
      });
    },
    markChartsStale: function(fromMonth) {
      keysWith('charts:').filter(k => !fromMonth || k.slice(7) >= fromMonth).forEach(k => {
        const e = mem.get(k);
        if (e && !e.s) setEntry(k, Object.assign({}, e, { s: true }));
      });
    },

    getSettingsMetadata: () => value('meta'),

    saveSettingsMetadata: function(meta) {
      if (!meta) return;
      put('meta', meta);
      // 卡面、銀行圖示另外存一份 id → 圖片（自訂圖片可能只在本機有）
      const cur = (mem.get('images') || {}).v || {};
      const imgs = Object.assign({}, cur);
      let changed = false;
      const take = (id, src) => { if (id && src && imgs[id] !== src) { imgs[id] = src; changed = true; } };
      (Array.isArray(meta.cards) ? meta.cards : []).forEach(c => { if (c) take(c.id, c.customImage || c.image); });
      (Array.isArray(meta.banks) ? meta.banks : []).forEach(b => { if (b) take(b.id, b.customLogo || b.logo); });
      if (changed) setEntry('images', { v: imgs, t: Date.now(), s: false });
    },

    /** id → 圖片。回傳的是快取本身（唯讀，不要修改；每畫一張卡片都會呼叫，不複製）。 */
    getCustomImages: () => (mem.get('images') || {}).v || {},

    saveCustomImage: function(id, dataUrl) {
      if (!id) return;
      const imgs = Object.assign({}, (mem.get('images') || {}).v || {});
      if (dataUrl) imgs[id] = dataUrl; else delete imgs[id];
      setEntry('images', { v: imgs, t: Date.now(), s: false });
    },

    getFxList: function() {
      const data = value('fxList');
      return data && Array.isArray(data.ledgers) ? data : null;
    },
    saveFxList: function(ledgers) {
      if (Array.isArray(ledgers)) put('fxList', { ledgers: ledgers, savedAt: Date.now() });
    },
    getFxLedger: function(id) {
      if (id == null) return null;
      const data = value('fxLedger:' + id);
      return data && Array.isArray(data.records) ? data : null;
    },
    saveFxLedger: function(id, data) {
      if (id != null && data) put('fxLedger:' + id, Object.assign({}, data, { savedAt: Date.now() }));
    },
    removeFxLedger: function(id) {
      if (id == null) return;
      remove('fxLedger:' + id);
      const prefs = this.getFxPrefs();
      if (prefs[id]) {
        delete prefs[id];
        this._setJson(this.KEY_FX_PREFS, prefs);
      }
    },

    /* ---------------- 以下是小型偏好：照舊放 localStorage（同步、很小） ---------------- */
    _getJson: function(key) {
      try {
        const raw = localStorage.getItem(key);
        return raw ? JSON.parse(raw) : null;
      } catch (e) { return null; }
    },
    _setJson: function(key, v) {
      try {
        if (v == null) localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(v));
      } catch (e) {}
    },

    KEY_ITEM_PREFS: 'FAST_BOOKKEEPING_ITEM_PREFS_V1',
    getItemPrefs: function() {
      const prefs = this._getJson(this.KEY_ITEM_PREFS);
      return prefs && typeof prefs === 'object' ? prefs : {};
    },
    saveItemPref: function(item, pref) {
      if (!item || !pref) return;
      const prefs = this.getItemPrefs();
      const cur = prefs[item];
      // 沒變就不寫（每記一筆都會呼叫）
      if (cur && cur.payment === pref.payment && cur.category === pref.category) return;
      prefs[item] = { payment: pref.payment, category: pref.category, updatedAt: Date.now() };
      this._setJson(this.KEY_ITEM_PREFS, prefs);
    },
    removeItemPref: function(item) {
      const prefs = this.getItemPrefs();
      if (!(item in prefs)) return;
      delete prefs[item];
      this._setJson(this.KEY_ITEM_PREFS, prefs);
    },

    KEY_QUICK_COMBO_MENU_OPEN: 'FAST_BOOKKEEPING_QUICK_COMBO_MENU_OPEN_V1',
    getQuickComboMenuOpen: function() {
      try { return localStorage.getItem(this.KEY_QUICK_COMBO_MENU_OPEN) === '1'; } catch (e) { return false; }
    },
    saveQuickComboMenuOpen: function(isOpen) {
      try { localStorage.setItem(this.KEY_QUICK_COMBO_MENU_OPEN, isOpen ? '1' : '0'); } catch (e) {}
    },

    KEY_FX_PREFS: 'FAST_BOOKKEEPING_FX_PREFS_V1',
    KEY_FX_HINT_HIDDEN: 'FAST_BOOKKEEPING_FX_HINT_HIDDEN_V1',
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
    },
  };
})();
