/* ------------------------------ 大型快取值（P09） ------------------------------
 * CacheService 單值上限 100 KB，超過 put 會丟錯。啟動資料（BOOT_JSON）、月份明細（MONTH_DATA）、
 * 選項（OPTIONS_ALL）資料一多就會超過，所以改成：
 *   JSON → Utilities.gzip → base64 → 每 90 KB 切一塊，用 putAll／getAll 一次存取。
 *   主鍵（manifest）存「L1|版本|塊數」，第 i 塊存在「主鍵#i」，內容是「版本|資料」。
 *   讀取時任一塊遺失、或某一塊的版本和 manifest 不同（寫到一半、被另一次寫入蓋過），一律視為沒命中。
 * 清除時只要刪掉主鍵（既有的 removeAll 呼叫不用改）；殘留的資料塊等 TTL 到期自然消失。
 * 讀取時先猜只有一塊：manifest 和第 0 塊在同一次 getAll 裡拿回來，只有真的切成多塊時才再讀一次。
 */
const LARGE_CACHE_FORMAT_ = 'L1';
const LARGE_CACHE_CHUNK_CHARS_ = 90 * 1024;   // base64 只有 ASCII，字元數＝位元組數
const LARGE_CACHE_MAX_CHUNKS_ = 24;

function largeCacheChunkKey_(key, index) {
  return key + '#' + index;
}

function encodeLargeCacheValue_(value) {
  const blob = Utilities.gzip(Utilities.newBlob(JSON.stringify(value), 'application/json'));
  return Utilities.base64Encode(blob.getBytes());
}

function decodeLargeCacheValue_(data) {
  const blob = Utilities.newBlob(Utilities.base64Decode(data), 'application/x-gzip');
  return JSON.parse(Utilities.ungzip(blob).getDataAsString('UTF-8'));
}

function parseLargeCacheManifest_(text) {
  if (typeof text !== 'string') return null;
  const parts = text.split('|');
  if (parts.length !== 3 || parts[0] !== LARGE_CACHE_FORMAT_) return null;
  const count = Number(parts[2]);
  if (!parts[1] || !Number.isInteger(count) || count < 1 || count > LARGE_CACHE_MAX_CHUNKS_) return null;
  return { version: parts[1], count: count };
}

/**
 * 把一個可能超過 100 KB 的值編碼成要 putAll 的鍵值（manifest＋各資料塊），加進 entries。
 * 讓呼叫端把好幾個值（例如月份明細＋冪等結果）合在同一次 putAll 寫入（P10）。太大時丟錯。
 */
function addLargeCacheEntries_(entries, key, value) {
  const data = encodeLargeCacheValue_(value);
  const count = Math.max(1, Math.ceil(data.length / LARGE_CACHE_CHUNK_CHARS_));
  if (count > LARGE_CACHE_MAX_CHUNKS_) throw new Error('快取值太大：' + key + '（' + data.length + ' 字元）');
  const version = Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
  for (let i = 0; i < count; i++) {
    entries[largeCacheChunkKey_(key, i)] = version + '|' + data.slice(i * LARGE_CACHE_CHUNK_CHARS_, (i + 1) * LARGE_CACHE_CHUNK_CHARS_);
  }
  entries[key] = LARGE_CACHE_FORMAT_ + '|' + version + '|' + count;
  return entries;
}

/** 存一個可能超過 100 KB 的值；成功回傳 true。失敗時刪掉主鍵，避免留下舊版本被當成最新的。 */
function cachePutLarge_(key, value, ttl) {
  const cache = scriptCache_();
  try {
    cache.putAll(addLargeCacheEntries_({}, key, value), ttl || CONFIG.CACHE_TTL);
    return true;
  } catch (e) {
    console.warn('[cache] 無法存入 ' + key + '：' + (e && e.message ? e.message : e));
    try { cache.remove(key); } catch (err) {}
    return false;
  }
}

/**
 * 一次 putAll 寫入好幾個值（P10）：large 是 { 鍵: 物件 }（大型值格式），plain 是 { 鍵: 字串 }。
 * 任何一個大型值編碼失敗或 putAll 失敗，就刪掉所有大型值的主鍵（不留下舊版本），回傳 false；不會丟錯。
 */
function cachePutAllMixed_(large, plain, ttl) {
  const cache = scriptCache_();
  const largeKeys = Object.keys(large || {});
  try {
    const entries = Object.assign({}, plain || {});
    largeKeys.forEach(function (k) { addLargeCacheEntries_(entries, k, large[k]); });
    if (Object.keys(entries).length) cache.putAll(entries, ttl || CONFIG.CACHE_TTL);
    return true;
  } catch (e) {
    console.warn('[cache] 無法存入 ' + largeKeys.concat(Object.keys(plain || {})).join(',') + '：' + (e && e.message ? e.message : e));
    try { if (largeKeys.length) cache.removeAll(largeKeys); } catch (err) {}
    return false;
  }
}

function cacheGetLarge_(key) {
  return cacheGetAllMixed_([key], []).large[key];
}

/**
 * 一次讀回多個大型值與一般值（字串）。回傳 { large: { 鍵: 值或 null }, plain: { 鍵: 字串或 null } }。
 * 只有某個大型值真的切成多塊時，才會有第二次 getAll。
 */
function cacheGetAllMixed_(largeKeys, plainKeys) {
  const large = {};
  const plain = {};
  const keys = (plainKeys || []).slice();
  (largeKeys || []).forEach(function (k) { keys.push(k, largeCacheChunkKey_(k, 0)); });
  let got = {};
  try { got = scriptCache_().getAll(keys) || {}; } catch (e) { got = {}; }
  (plainKeys || []).forEach(function (k) { plain[k] = got[k] != null ? got[k] : null; });

  const manifests = {};
  const more = [];
  (largeKeys || []).forEach(function (k) {
    const m = parseLargeCacheManifest_(got[k]);
    if (!m) return;
    manifests[k] = m;
    for (let i = 1; i < m.count; i++) more.push(largeCacheChunkKey_(k, i));
  });
  if (more.length) {
    try { Object.assign(got, scriptCache_().getAll(more) || {}); } catch (e) {}
  }

  (largeKeys || []).forEach(function (k) {
    large[k] = null;
    const m = manifests[k];
    if (!m) return;
    const prefix = m.version + '|';
    let data = '';
    for (let i = 0; i < m.count; i++) {
      const part = got[largeCacheChunkKey_(k, i)];
      if (typeof part !== 'string' || part.indexOf(prefix) !== 0) return;
      data += part.slice(prefix.length);
    }
    try { large[k] = decodeLargeCacheValue_(data); } catch (e) { large[k] = null; }
  });
  return { large: large, plain: plain };
}

/* -------------------------------- 快取失效 -------------------------------- */

function invalidateOptionsCache_() {
  try {
    var cache = scriptCache_();
    cache.removeAll([CONFIG.CACHE_KEYS.OPTIONS_ALL, CONFIG.CACHE_KEYS.OPTIONS_SIMPLE, 'OPTIONS_SIMPLE', 'OPTIONS_RAW']);
  } catch (e) {}
}

/**
 * 記帳（新增／修改／刪除／標記已繳）之後：清掉這個月份的總覽、圖表與之後月份的月初餘額、月底預估用的歷史明細；
 * 改的是過去的月份時，淨資產快照從那個月起標成過期（F06）。
 * 啟動快取（BOOT_JSON）不在這裡清：讀出來時會用最新的月份明細快取蓋過裡面的清單（P10），
 * 清掉的話下次開頁只能拿 PropertiesService 裡的舊快照，前端還得再背景同步一次（P09 修正）。
 */
function invalidateOverviewAndSettlementCache_(month) {
  if (!month) return;
  try {
    const keys = [CONFIG.CACHE_KEYS.OVERVIEW_PREFIX + month];
    Array.prototype.push.apply(keys, chartsCacheKeysFrom_(month));
    Array.prototype.push.apply(keys, budgetOpeningCacheKeysAfter_(month));
    Array.prototype.push.apply(keys, forecastHistoryCacheKeysAfter_(month));
    scriptCache_().removeAll(keys);
  } catch (e) {}
  markNetWorthDirty_(month);
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
    Array.prototype.push.apply(keys, budgetOpeningCacheKeysAfter_(month));
    Array.prototype.push.apply(keys, forecastHistoryCacheKeysAfter_(month));
    scriptCache_().removeAll(keys);
  } catch (e) {}
  markNetWorthDirty_(month);
}

function invalidateAllCaches_() {
  try {
    const cache = scriptCache_();
    const keys = [
      CONFIG.CACHE_KEYS.BOOT_JSON,
      CONFIG.CACHE_KEYS.MONTHS_LIST,
      CONFIG.CACHE_KEYS.OPTIONS_ALL,
      CONFIG.CACHE_KEYS.OPTIONS_SIMPLE,
      CONFIG.CACHE_KEYS.BUDGET_CONFIG,
      CONFIG.CACHE_KEYS.NET_WORTH,
      CONFIG.CACHE_KEYS.FORECAST_HISTORY_PREFIX + budgetToday_().month,
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
        keys.push(CONFIG.CACHE_KEYS.BUDGET_OPENING_PREFIX + m);
      });
    }
    Array.prototype.push.apply(keys, fxCacheKeys_(readFxLedgerIds_()));
    cache.removeAll(keys);
  } catch (e) {}
}
