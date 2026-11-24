/* KvStore — IndexedDB 的極簡 key-value 包裝（P12）：LocalCache 的大型資料存這裡，localStorage 只放小型偏好。
 * 值用結構化複製存取（不經 JSON），所有操作都是非同步、失敗時回傳 null／false（隱私模式、被封鎖時照常運作，只是不保存）。
 * 開機時 partials/boot-loader.html 已經先開好資料庫、讀好整份（window.__kvEarly），第一次 readAll() 直接用它。
 *   KvStore.readAll()      → Promise<Map<key, value> | null>
 *   KvStore.write(entries) → Promise<boolean>；entries 是 [key, value] 陣列，value 為 undefined 表示刪除，同一個交易寫完 */
const KvStore = (function() {
  const DB_NAME = 'FAST_BOOKKEEPING_V1';
  const STORE = 'kv';
  let early = typeof window !== 'undefined' && window.__kvEarly ? window.__kvEarly : null;
  let opening = early ? early.then(r => (r && r.db) || null) : null;
  function open() {
    if (opening) return opening;
    opening = new Promise(resolve => {
      let req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { resolve(null); return; }
      req.onupgradeneeded = () => { try { req.result.createObjectStore(STORE); } catch (e) {} };
      req.onsuccess = () => { const db = req.result; db.onversionchange = () => { db.close(); opening = null; }; resolve(db); };
      req.onerror = () => resolve(null);
    });
    return opening;
  }
  function run(mode, body) {
    return open().then(db => db && new Promise(resolve => {
      let tx;
      try { tx = db.transaction(STORE, mode); } catch (e) { resolve(null); return; }
      let out;
      try { out = body(tx.objectStore(STORE)); } catch (e) { try { tx.abort(); } catch (x) {} resolve(null); return; }
      tx.oncomplete = () => resolve(out ? out() : true);
      tx.onerror = tx.onabort = () => resolve(null);
    }));
  }
  function readNow() {
    return run('readonly', store => {
      const keys = store.getAllKeys();
      const values = store.getAll();
      return () => new Map(keys.result.map((k, i) => [k, values.result[i]]));
    });
  }
  return {
    readAll: function() {
      const pre = early;
      early = null;
      return pre ? pre.then(r => (r && r.keys ? new Map(r.keys.map((k, i) => [k, r.values[i]])) : readNow())) : readNow();
    },
    write: entries => (entries.length ? run('readwrite', store => {
      entries.forEach(([k, v]) => { if (v === undefined) store.delete(k); else store.put(v, k); });
    }).then(Boolean) : Promise.resolve(true)),
  };
})();
