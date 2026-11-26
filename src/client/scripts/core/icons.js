const ICON_NAME_RE = /^[a-z0-9-]+$/;
const ICON_VALUE_PREFIX = 'ph:';

/* 圖示字型：頁面只內嵌專案用到的圖示（建置時產生的 <style id="phosphorSubset">，字型裁成子集後以 data URI 內嵌）。
 * 若要顯示的圖示不在其中（例如舊資料存了已移出清單的圖示、或用到沒有內嵌的 fill 粗細），就補載完整的 Phosphor 樣式表。
 * 補載的樣式表（@import 到 icons 層）插在子集「前面」：子集的 @font-face 帶 unicode-range、又比較晚定義，子集內的字元仍然用內嵌字型，
 * 不會因為補載的完整字型還在下載（font-display: block）而讓已經顯示的圖示暫時空白。 */
const IconFont = (function() {
  let known = null;
  let fullRequested = false;

  function readKnown() {
    const set = new Set();
    const el = document.getElementById('phosphorSubset');
    if (!el || !el.sheet) return null;
    const visit = function(rules) {
      for (let i = 0; i < rules.length; i++) {
        if (rules[i].cssRules && !rules[i].selectorText) { visit(rules[i].cssRules); continue; }
        const m = /\.(ph(?:-fill)?)\.ph-([a-z0-9-]+)::?before/.exec(rules[i].selectorText || '');
        if (m) set.add(m[1] + ':' + m[2]);
      }
    };
    try { visit(el.sheet.cssRules); } catch (e) { return null; }
    return set.size ? set : null;
  }

  function loadFull() {
    if (fullRequested) return;
    fullRequested = true;
    const el = document.getElementById('phosphorSubset');
    const cdn = el && el.dataset.cdn;
    if (!cdn) return;
    // 放進 icons 層（@layer，見 partials/head.html）：沒分層的樣式表會蓋過整個主樣式表
    const style = document.createElement('style');
    style.dataset.iconFallback = '';
    style.textContent = ['regular', 'fill'].map(function(weight) {
      return '@import url("' + cdn + weight + '/style.css") layer(icons);';
    }).join('\n');
    el.parentNode.insertBefore(style, el);
  }

  function ensure(name, weight) {
    if (fullRequested) return;
    if (!known) known = readKnown();
    const base = weight === 'fill' ? 'ph-fill' : 'ph';
    if (known && !known.has(base + ':' + name)) loadFull();
  }

  return { ensure: ensure, loadFull: loadFull };
})();

function iconHtml(name, weight = 'regular', extraClass = '') {
  const n = ICON_NAME_RE.test(name || '') ? name : 'tag';
  IconFont.ensure(n, weight);
  const base = weight === 'fill' ? 'ph-fill' : 'ph';
  return '<i class="' + base + ' ph-' + n + (extraClass ? ' ' + extraClass : '') + '" aria-hidden="true" data-icon="' + n + '"></i>';
}

function iconEl(name, weight = 'regular', extraClass = '') {
  const t = document.createElement('template');
  t.innerHTML = iconHtml(name, weight, extraClass);
  return t.content.firstElementChild;
}

function setIcon(el, name, weight = 'regular') {
  if (!el) return;
  el.innerHTML = iconHtml(name, weight);
}

function readIconName(el) {
  const i = el ? el.querySelector('[data-icon]') : null;
  return i ? (i.dataset.icon || '') : '';
}

function emojiToIconName(emoji) {
  const key = String(emoji || '').replace(/\uFE0F/g, '').trim();
  if (!key) return '';
  return (typeof EMOJI_TO_ICON !== 'undefined' && EMOJI_TO_ICON[key]) || '';
}

function resolveIconName(value) {
  const v = String(value == null ? '' : value).trim();
  if (!v) return '';
  if (v.indexOf(ICON_VALUE_PREFIX) === 0) {
    const n = v.slice(ICON_VALUE_PREFIX.length).trim();
    return ICON_NAME_RE.test(n) ? n : 'tag';
  }
  if (ICON_NAME_RE.test(v)) return v;
  return emojiToIconName(v) || 'tag';
}

const LEADING_EMOJI_RE = /^(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}]\uFE0F?\u200D?)+/u;
function splitLeadingEmoji(name) {
  const str = String(name == null ? '' : name).trim();
  try {
    const m = str.match(LEADING_EMOJI_RE);
    if (m) return { lead: m[0], rest: str.slice(m[0].length).trim() };
  } catch (e) {}
  return { lead: '', rest: str };
}

function itemDisplayName(name) {
  const parts = splitLeadingEmoji(name);
  return parts.rest || parts.lead || '';
}

function guessItemIcon(str) {
  if (/早|晨/.test(str)) return 'egg';
  if (/午/.test(str)) return 'bowl-food';
  if (/晚|夜宵|宵夜/.test(str)) return 'cooking-pot';
  if (/點心|甜點|下午茶|蛋糕|零食|餅乾/.test(str)) return 'cookie';
  if (/飲|茶|咖啡|拿鐵|手搖|水/.test(str)) return 'pint-glass';
  if (/食|餐|吃|飯|麵|肉|料理|火鍋|便當|美食/.test(str)) return 'fork-knife';
  if (/運動|健身|跑步|球|瑜珈/.test(str)) return 'barbell';
  if (/交通|車|捷運|公車|高鐵|火車|機車|油|停車|計程車|uber|過路費|悠遊卡/.test(str)) return 'car';
  if (/水電|瓦斯|水費|電費|天然氣/.test(str)) return 'lightbulb';
  if (/電信|電話|網路|手機|通訊|網速|寬頻/.test(str)) return 'device-mobile';
  if (/房租|租金|套房|雅房|住宿|民宿|飯店/.test(str)) return 'house';
  if (/洗衣|洗衣精|洗衣服/.test(str)) return 'washing-machine';
  if (/烘衣|衣服|服飾|褲|鞋|穿搭|衣物/.test(str)) return 't-shirt';
  if (/日用品|家用品|雜貨|消耗品|衛生紙|沐浴|洗髮|生活用品/.test(str)) return 'spray-bottle';
  if (/日常|開銷|超市|採買|全聯|家樂福|美佳量販|量販/.test(str)) return 'shopping-cart';
  if (/大項|非日常|奢|精品|家電|3c|電腦|筆電|買車/.test(str)) return 'shopping-bag';
  if (/娛樂|遊戲|電影|動漫|ktv|唱歌|玩|展覽|玩具|電玩/.test(str)) return 'game-controller';
  if (/醫|藥|看病|診所|保健|健康|牙醫|健保/.test(str)) return 'pill';
  if (/學|書|課|補習|學費|考試|培訓/.test(str)) return 'books';
  if (/寵物|貓|狗|飼料|毛孩/.test(str)) return 'paw-print';
  if (/旅遊|旅行|機票|出國|景點|門票/.test(str)) return 'airplane-tilt';
  if (/代墊|墊付|墊款|報銷|報帳/.test(str)) return 'receipt';
  if (/代收|代付|代買|代購/.test(str)) return 'handshake';
  if (/轉移|轉帳|匯款|還款/.test(str)) return 'arrows-left-right';
  if (/投資|股票|基金|虛擬幣|理財|etf|證券/.test(str)) return 'chart-line-up';
  if (/薪資|薪水|工資|獎金|外快|兼職|收入/.test(str)) return 'money';
  if (/存款|儲蓄|銀行|利息/.test(str)) return 'bank';
  if (/家裡|家庭|孝親|家用/.test(str)) return 'house-line';
  if (/禮|紅包|禮物|送禮/.test(str)) return 'gift';
  if (/其他/.test(str)) return 'package';
  return 'tag';
}

function getCustomItemIconValue(name) {
  if (typeof settingsState === 'undefined' || !settingsState.metadata) return '';
  const customMap = settingsState.metadata.itemEmojis || settingsState.metadata.emojis;
  return (customMap && name && customMap[name]) || '';
}

function getItemIcon(name) {
  if (!name) return '';
  const str = String(name).trim();
  const parts = splitLeadingEmoji(str);
  const clean = parts.rest || str;

  const custom = getCustomItemIconValue(str) || (clean !== str ? getCustomItemIconValue(clean) : '');
  if (custom) return resolveIconName(custom);

  if (parts.lead) {
    const fromLead = emojiToIconName(parts.lead);
    if (fromLead) return fromLead;
  }

  if (ITEM_ICON_MAP[clean]) return ITEM_ICON_MAP[clean];

  return guessItemIcon(clean);
}

function itemIconLabelHtml(name, iconClass) {
  const icon = getItemIcon(name);
  return (icon ? '<span class="' + (iconClass || 'item-inline-icon') + '" aria-hidden="true">' + iconHtml(icon) + '</span>' : '') +
    escHtml(itemDisplayName(name));
}

/* 項目按鈕的自訂顏色：只能從現有的類別色板挑（同一組 --cat-<key>-* 變數，淺色／深色模式各有一套），
 * 存在 settings metadata 的 itemColors（項目名稱 → 色板 key）；沒設定就照名稱自動判斷。
 * 色相重複的類別（travel≈transport、home≈food、medical≈bigexpense、study≈daily、pet≈finance、sport≈transport）不另列。 */
const ITEM_COLOR_PALETTE = [
  { key: 'food', label: '杏橙' },
  { key: 'bigexpense', label: '玫瑰' },
  { key: 'entertainment', label: '薰衣草' },
  { key: 'reimburse', label: '葡萄紫' },
  { key: 'living', label: '靛藍' },
  { key: 'transport', label: '天空藍' },
  { key: 'laundry', label: '湖水青' },
  { key: 'salary', label: '薄荷綠' },
  { key: 'daily', label: '青草綠' },
  { key: 'finance', label: '金黃' },
  { key: 'other', label: '石墨灰' },
];
const ITEM_COLOR_KEYS = ITEM_COLOR_PALETTE.map(function(c) { return c.key; });

function isItemColorKey(key) {
  return ITEM_COLOR_KEYS.indexOf(key) >= 0;
}

function getCustomItemColor(name) {
  if (!name || typeof settingsState === 'undefined' || !settingsState.metadata) return '';
  const map = settingsState.metadata.itemColors;
  const key = map && map[name];
  return isItemColorKey(key) ? key : '';
}

function getItemCategory(name) {
  if (!name) return 'default';
  const str = String(name).trim();
  return getCustomItemColor(str) || getCustomItemColor(splitLeadingEmoji(str).rest) || getAutoItemCategory(str);
}

// 依名稱自動判斷的類別色（不看自訂顏色）
function getAutoItemCategory(name) {
  if (!name) return 'default';
  const str = String(name).trim();

  let cleanStr = str;
  try {
    cleanStr = str.replace(/^[\p{Extended_Pictographic}\p{Emoji_Presentation}\s]+/u, '').trim();
  } catch (e) {}
  const target = cleanStr || str;

  if (ITEM_CATEGORY_MAP[target]) {
    return ITEM_CATEGORY_MAP[target];
  }

  if (/早|晨|午|晚|夜宵|宵夜|點心|甜點|下午茶|蛋糕|零食|餅乾|飲|茶|咖啡|拿鐵|手搖|水|食|餐|吃|飯|麵|肉|料理|火鍋|便當|美食/.test(target)) {
    return 'food';
  }
  if (/運動|健身|跑步|球|瑜珈/.test(target)) {
    return 'sport';
  }
  if (/交通|車|捷運|公車|高鐵|火車|機車|油|停車|計程車|uber|過路費|悠遊卡/.test(target)) {
    return 'transport';
  }
  if (/洗衣|洗衣精|洗衣服|烘衣|衣服|服飾|褲|鞋|穿搭|衣物/.test(target)) {
    return 'laundry';
  }
  if (/水電|瓦斯|水費|電費|天然氣|電信|電話|網路|手機|通訊|網速|寬頻|房租|租金|套房|雅房|住宿|民宿|飯店/.test(target)) {
    return 'living';
  }
  if (/日用品|家用品|雜貨|消耗品|衛生紙|沐浴|洗髮|生活用品|日常|開銷|超市|採買|全聯|家樂福|美佳量販|量販/.test(target)) {
    return 'daily';
  }
  if (/大項|非日常|奢|精品|家電|3c|電腦|筆電|買車/.test(target)) {
    return 'bigexpense';
  }
  if (/娛樂|遊戲|電影|動漫|ktv|唱歌|玩|展覽|玩具|電玩/.test(target)) {
    return 'entertainment';
  }
  if (/醫|藥|看病|診所|保健|健康|牙醫|健保/.test(target)) {
    return 'medical';
  }
  if (/學|書|課|補習|學費|考試|培訓/.test(target)) {
    return 'study';
  }
  if (/寵物|貓|狗|飼料|毛孩/.test(target)) {
    return 'pet';
  }
  if (/旅遊|旅行|機票|出國|景點|門票/.test(target)) {
    return 'travel';
  }
  if (/代墊|墊付|墊款/.test(target)) {
    return 'reimburse';
  }
  if (/代收|代付|代買|代購|轉移|轉帳|匯款|還款|投資|股票|基金|虛擬幣|理財|etf|證券|存款|儲蓄|銀行|利息/.test(target)) {
    return 'finance';
  }
  if (/薪資|薪水|工資|獎金|外快|兼職|收入/.test(target)) {
    return 'salary';
  }
  if (/家裡|家庭|孝親|家用/.test(target)) {
    return 'home';
  }
  if (/其他/.test(target)) {
    return 'other';
  }

  return 'default';
}

function escHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escAttr(str) {
  return escHtml(str);
}
