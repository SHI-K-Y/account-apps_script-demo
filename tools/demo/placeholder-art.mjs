// 虛構的卡面與銀行標誌（SVG，直接內嵌成 data URI）。
// 公開 Demo 與公開原始碼都只使用這裡產生的圖，不含任何真實的卡片或銀行圖檔。
// 不依賴 Node 專用 API，瀏覽器裡也能執行。

const PALETTES = [
  ['#1f6f5c', '#0f3d35'], ['#2a5db0', '#16306b'], ['#b5532a', '#6e2a12'], ['#5b4bb3', '#2c2466'],
  ['#0e7c86', '#07434a'], ['#a8324a', '#5c1526'], ['#3d6b2f', '#1f3a17'], ['#8a6a1f', '#4a370c'],
];

function hash(text) {
  let h = 2166136261;
  const s = String(text);
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

const escapeXml = text => String(text == null ? '' : text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// 連單引號、括號也一併編碼，這樣產生的網址不論放進 JS 字串、HTML 屬性或 CSS url() 都不需要再跳脫。
const toDataUri = svg => 'data:image/svg+xml,' + encodeURIComponent(svg.replace(/\n\s*/g, ''))
  .replace(/[!'()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());

export function paletteFor(seed) {
  return PALETTES[hash(seed) % PALETTES.length];
}

/**
 * 卡面。
 * @param {object} o  title（卡名）、issuer（發卡銀行）、kind（'CREDIT' / 'DEBIT'）、colors（[亮, 暗]，預設依 title 挑色）
 */
export function cardArt(o) {
  const opts = o || {};
  const title = opts.title || 'DEMO CARD';
  const [c1, c2] = opts.colors || paletteFor(title);
  const id = 'g' + hash(title).toString(36);
  const font = 'font-family="system-ui,\'PingFang TC\',\'Noto Sans TC\',\'Microsoft JhengHei\',sans-serif"';
  return toDataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 428 270" role="img" aria-label="${escapeXml(title)}">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
      </linearGradient>
    </defs>
    <rect width="428" height="270" rx="22" fill="url(#${id})"/>
    <circle cx="372" cy="56" r="120" fill="#fff" opacity=".07"/>
    <circle cx="300" cy="290" r="150" fill="#fff" opacity=".05"/>
    <rect x="34" y="92" width="52" height="40" rx="7" fill="#f3d58a"/>
    <path d="M34 106h52M34 118h52M54 92v40M68 92v40" stroke="#b8923a" stroke-width="1.5" fill="none"/>
    <text x="34" y="54" ${font} font-size="22" font-weight="700" fill="#fff">${escapeXml(opts.issuer || 'DEMO BANK')}</text>
    <text x="34" y="186" ${font} font-size="26" font-weight="700" fill="#fff">${escapeXml(title)}</text>
    <text x="34" y="232" ${font} font-size="17" letter-spacing="3" fill="#fff" opacity=".8">•••• DEMO</text>
    <text x="394" y="232" ${font} font-size="15" font-weight="700" text-anchor="end" fill="#fff" opacity=".85">${escapeXml(opts.kind || 'CREDIT')}</text>
  </svg>`);
}

/**
 * 銀行標誌（方形圓角色塊＋一個字）。
 * @param {object} o  name（銀行名稱，取第一個字當標誌）、colors
 */
export function bankLogo(o) {
  const opts = o || {};
  const name = opts.name || 'B';
  const [c1, c2] = opts.colors || paletteFor(name);
  const id = 'b' + hash(name).toString(36);
  const glyph = Array.from(String(opts.glyph || name))[0] || 'B';
  return toDataUri(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" role="img" aria-label="${escapeXml(name)}">
    <defs>
      <linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="${c1}"/><stop offset="1" stop-color="${c2}"/>
      </linearGradient>
    </defs>
    <rect width="128" height="128" rx="28" fill="url(#${id})"/>
    <text x="64" y="64" font-family="system-ui,'PingFang TC','Noto Sans TC','Microsoft JhengHei',sans-serif" font-size="64" font-weight="700" text-anchor="middle" dominant-baseline="central" fill="#fff">${escapeXml(glyph)}</text>
  </svg>`);
}
