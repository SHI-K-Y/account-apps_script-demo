/* =============================================================================
 * Fmt — 共用的數字格式（P05）
 * -----------------------------------------------------------------------------
 * 各處原本自己呼叫 toLocaleString('zh-TW') 或 new Intl.NumberFormat(...)：每次都要重新建立格式器，
 * countUp 每幀、清單每一列都會跑一次。這裡把格式器依選項快取起來，輸出和原本完全相同
 * （toLocaleString('zh-TW') 就是用預設選項的 Intl.NumberFormat('zh-TW')）。
 *   Fmt.nf(opts)              取得（快取的）Intl.NumberFormat('zh-TW', opts)
 *   Fmt.num(n, opts)          只有數字：12,345
 *   Fmt.money(n, opts)        金額：$12,345、-$80；opts.plus 正數加「+」，opts.digits 最多幾位小數
 * ============================================================================= */
const Fmt = (function() {
  const LOCALE = 'zh-TW';
  const cache = new Map();
  let plain = null;

  function nf(opts) {
    if (!opts) {
      if (!plain) plain = new Intl.NumberFormat(LOCALE);
      return plain;
    }
    const key = Object.keys(opts).sort().map(k => k + '=' + opts[k]).join('&');
    let f = cache.get(key);
    if (!f) {
      f = new Intl.NumberFormat(LOCALE, opts);
      cache.set(key, f);
    }
    return f;
  }

  function num(n, opts) {
    return nf(opts).format(n);
  }

  const digitOpts = {};
  function money(n, opts) {
    const o = opts || {};
    const v = Number(n) || 0;
    const sign = v < 0 ? '-' : (o.plus && v > 0 ? '+' : '');
    let f = plain || nf();
    if (o.digits != null) {
      f = digitOpts[o.digits] || (digitOpts[o.digits] = nf({ maximumFractionDigits: o.digits }));
    }
    return sign + '$' + f.format(Math.abs(v));
  }

  return { nf: nf, num: num, money: money };
})();
