function invalidateOptionsCache_() {
  try {
    var cache = scriptCache_();
    cache.removeAll([CONFIG.CACHE_KEYS.OPTIONS_ALL, 'OPTIONS_SIMPLE', 'OPTIONS_RAW']);
  } catch (e) {}
}

function invalidateOverviewAndSettlementCache_(month) {
  try {
    const cache = scriptCache_();
    const keys = [CONFIG.CACHE_KEYS.BOOT_JSON];
    if (month) {
      keys.push(CONFIG.CACHE_KEYS.OVERVIEW_PREFIX + month);
      Array.prototype.push.apply(keys, chartsCacheKeysFrom_(month));
    }
    cache.removeAll(keys);
  } catch (e) {}
}

/** 清掉單一月份的所有快取（明細、總覽、圖表、版面判斷）與啟動快取。 */
function invalidateMonthCaches_(month) {
  try {
    const keys = [
      CONFIG.CACHE_KEYS.BOOT_JSON,
      CONFIG.CACHE_KEYS.MONTH_DATA_PREFIX + month,
      CONFIG.CACHE_KEYS.OVERVIEW_PREFIX + month,
      CONFIG.CACHE_KEYS.SHEET_LAYOUT_PREFIX + month,
    ];
    Array.prototype.push.apply(keys, chartsCacheKeysFrom_(month));
    scriptCache_().removeAll(keys);
  } catch (e) {}
}

function invalidateAllCaches_() {
  try {
    const cache = scriptCache_();
    const keys = [
      CONFIG.CACHE_KEYS.BOOT_JSON,
      CONFIG.CACHE_KEYS.MONTHS_LIST,
      CONFIG.CACHE_KEYS.OPTIONS_ALL,
      CONFIG.CACHE_KEYS.BUDGET_CONFIG,
    ];
    const props = scriptProps_();
    const monthsStr = props.getProperty(CONFIG.PROP_KEYS.MONTHS_SNAPSHOT);
    if (monthsStr) {
      const months = JSON.parse(monthsStr);
      months.forEach(function (m) {
        keys.push(CONFIG.CACHE_KEYS.MONTH_DATA_PREFIX + m);
        keys.push(CONFIG.CACHE_KEYS.OVERVIEW_PREFIX + m);
        keys.push(CONFIG.CACHE_KEYS.CHARTS_PREFIX + m);
        keys.push(CONFIG.CACHE_KEYS.SHEET_LAYOUT_PREFIX + m);
      });
    }
    Array.prototype.push.apply(keys, fxCacheKeys_(readFxLedgerIds_()));
    cache.removeAll(keys);
  } catch (e) {}
}
