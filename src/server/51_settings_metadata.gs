function getDefaultSettingsMetadata_() {
  return {
    emojis: {},
    itemEmojis: {},
    itemColors: {},
    channelColors: {
      'Line Pay': '#06c755',
      '信用卡': '#2563eb',
      '簽帳卡': '#ea580c',
      '悠活支付': '#d97706',
      '青禾電子支付': '#0d9488',
    },
    channels: [
      { id: 'ch_linepay', name: 'Line Pay', color: '#06c755' },
      { id: 'ch_credit', name: '信用卡', color: '#2563eb' },
      { id: 'ch_debit', name: '簽帳卡', color: '#ea580c' },
      { id: 'ch_yohopay', name: '悠活支付', color: '#d97706' },
      { id: 'ch_qinghe', name: '青禾電子支付', color: '#0d9488' },
    ],
    cards: [
      { id: 'card_shanlan_debit', name: '山嵐簽帳卡', type: 'debit', imageKey: 'shanlanDebit', channels: ['Line Pay', '簽帳卡'] },
      { id: 'card_haiyue_wave', name: '海悅 wave 信用卡', type: 'credit', imageKey: 'haiyueWave', channels: ['Line Pay', '信用卡', '悠活支付'] },
      { id: 'card_haiyue_debit', name: '海悅簽帳卡', type: 'debit', imageKey: 'haiyueDebit', channels: ['Line Pay', '簽帳卡'] },
      { id: 'card_qinghe_evercard', name: '青禾 evercard 信用卡', type: 'credit', imageKey: 'qingheEvercard', channels: ['Line Pay', '信用卡', '悠活支付', '青禾電子支付'] },
      { id: 'card_beichen_megamart', name: '北辰聯名卡', type: 'credit', imageKey: 'beichenMegamart', channels: ['信用卡'] },
    ],
    banks: [
      { id: 'bank_shanlan', name: '山嵐銀行', logoKey: 'shanlan' },
      { id: 'bank_haiyue', name: '海悅銀行', logoKey: 'haiyue' },
      { id: 'bank_beichen', name: '北辰銀行', logoKey: 'beichen' },
      { id: 'bank_qinghe', name: '青禾銀行', logoKey: 'qinghe' },
      { id: 'bank_yunshan', name: '雲杉銀行', logoKey: 'yunshan' },
    ],
    quickCombos: [],
  };
}

/* ------------------------- 舊版試算表儲存格的一次性遷移（P11） -------------------------
 * 很舊的版本把 metadata 存在「資料選單設定區」的 O1:Q1。清掉之後在指令碼屬性寫 LEGACY_META_CLEANED=1，
 * 之後不再讀試算表（以前每次讀 metadata 都要開試算表看一次這三格）。
 */
let legacyMetaCleanedMemo_ = false;

function isLegacyMetaCleaned_() {
  if (legacyMetaCleanedMemo_) return true;
  try {
    legacyMetaCleanedMemo_ = scriptProps_().getProperty(CONFIG.PROP_KEYS.LEGACY_META_CLEANED) === '1';
  } catch (e) {}
  return legacyMetaCleanedMemo_;
}

function markLegacyMetaCleaned_() {
  scriptProps_().setProperty(CONFIG.PROP_KEYS.LEGACY_META_CLEANED, '1');
  legacyMetaCleanedMemo_ = true;
}

/** 清掉 O1:Q1 的舊 metadata（只做一次）。呼叫前要確定裡面的資料已經存進指令碼屬性。 */
function cleanLegacySheetMetadataCells_(ss) {
  if (isLegacyMetaCleaned_()) return;
  try {
    const targetSs = ss || getSpreadsheet_();
    const sheet = targetSs.getSheetByName(CONFIG.SETTINGS_SHEET);
    if (!sheet) return; // 找不到工作表不算完成，下次再試
    if (sheet.getMaxColumns() >= 15) {
      const vals = sheet.getRange('O1:Q1').getDisplayValues()[0];
      const hasLegacyJson = vals.some(v => {
        const s = String(v || '').trim();
        return s.startsWith('{') || s.includes('base64') || s.length > 100;
      });
      if (hasLegacyJson) {
        sheet.getRange('O1:Q1').clearContent();
      }
    }
    markLegacyMetaCleaned_();
  } catch (e) {}
}

/** 從 O1:Q1 讀舊版 metadata（還沒遷移、指令碼屬性裡也沒有 metadata 時才會用到）。 */
function readLegacySheetMetadata_(ss) {
  const targetSs = ss || getSpreadsheet_();
  const sheet = targetSs.getSheetByName(CONFIG.SETTINGS_SHEET);
  if (!sheet || sheet.getMaxColumns() < 16) return null;
  const cellVal = String(sheet.getRange('P1').getDisplayValue() || '').trim();
  const meta = cellVal && cellVal.startsWith('{') ? JSON.parse(cellVal) : null;
  if (meta && sheet.getMaxColumns() >= 17) {
    const imgVal = String(sheet.getRange('Q1').getDisplayValue() || '').trim();
    if (imgVal && imgVal.startsWith('{')) {
      const imgMap = JSON.parse(imgVal);
      if (Array.isArray(meta.cards)) {
        meta.cards.forEach(c => {
          if (c && c.id && imgMap[c.id]) {
            c.customImage = imgMap[c.id];
            c.image = imgMap[c.id];
          }
        });
      }
      if (Array.isArray(meta.banks)) {
        meta.banks.forEach(b => {
          if (b && b.id && imgMap[b.id]) {
            b.customLogo = imgMap[b.id];
            b.logo = imgMap[b.id];
          }
        });
      }
    }
  }
  return meta;
}

/* ------------------------------ 圖片（指令碼屬性，P11） ------------------------------
 * 每張卡片／每家銀行的自訂圖片各存一個屬性（IMG_CARD_<id>／IMG_BANK_<id>），
 * 另外用 SETTINGS_IMAGE_INDEX 記下目前存了哪些圖片鍵，讀取時只讀索引裡、而且 metadata 用得到的鍵，
 * 不用 getProperties() 把所有屬性（含啟動快照等）整包讀回來。
 */
function isImagePropKey_(key) {
  return String(key).indexOf('IMG_CARD_') === 0 || String(key).indexOf('IMG_BANK_') === 0;
}

/** 目前存了哪些圖片鍵。舊版沒有索引時用 getKeys()（只有鍵名）建立一次。 */
function readImageIndex_(props) {
  const indexKey = CONFIG.PROP_KEYS.SETTINGS_IMAGE_INDEX;
  try {
    const raw = props.getProperty(indexKey);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) return list.filter(isImagePropKey_);
    }
  } catch (e) {}
  const keys = (props.getKeys() || []).filter(isImagePropKey_).sort();
  try { props.setProperty(indexKey, JSON.stringify(keys)); } catch (e) {}
  return keys;
}

/** 讀出 metadata 用得到的圖片，回傳 { 鍵: 圖片 }。 */
function readMetadataImages_(props, meta) {
  const index = new Set(readImageIndex_(props));
  const out = {};
  const want = [];
  (meta.cards || []).forEach(c => { if (c && c.id) want.push('IMG_CARD_' + c.id); });
  (meta.banks || []).forEach(b => { if (b && b.id) want.push('IMG_BANK_' + b.id); });
  want.forEach(key => {
    if (!index.has(key) || Object.prototype.hasOwnProperty.call(out, key)) return;
    const value = props.getProperty(key);
    if (value) out[key] = value;
  });
  return out;
}

/** 拿掉卡片／銀行的自訂圖片（啟動快照的精簡版用）；不改動傳入的物件。 */
function stripMetadataImages_(meta) {
  if (!meta || typeof meta !== 'object') return meta;
  const strip = (list, fields) => (Array.isArray(list) ? list.map(item => {
    if (!item || typeof item !== 'object') return item;
    const copy = Object.assign({}, item);
    fields.forEach(f => { delete copy[f]; });
    return copy;
  }) : list);
  return Object.assign({}, meta, {
    cards: strip(meta.cards, ['customImage', 'image']),
    banks: strip(meta.banks, ['customLogo', 'logo']),
  });
}

function normalizeCardsMetadataList_(cards) {
  if (!Array.isArray(cards)) return [];
  const mergedMap = new Map();
  const result = [];

  cards.forEach(c => {
    if (!c || !c.name) return;
    const rawName = String(c.name).trim();
    const isGhostHaiyue = (c.id === 'card_haiyue_credit' || rawName === '海悅信用卡' || rawName === '海悅 wave 卡');
    const normName = isGhostHaiyue ? '海悅 wave 信用卡' : rawName;
    const normId = isGhostHaiyue ? 'card_haiyue_wave' : (c.id || ('card_' + (result.length + 1)));
    const key = normName.toLowerCase();

    if (mergedMap.has(key)) {
      const existing = mergedMap.get(key);
      const chSet = new Set(Array.isArray(existing.channels) ? existing.channels : []);
      if (Array.isArray(c.channels)) {
        c.channels.forEach(ch => { if (ch) chSet.add(ch); });
      }
      existing.channels = Array.from(chSet);
      if (!existing.customImage && (c.customImage || c.image)) {
        existing.customImage = c.customImage || c.image;
        existing.image = existing.customImage;
      }
      if (!existing.imageKey && c.imageKey) {
        existing.imageKey = c.imageKey;
      }
    } else {
      const copy = Object.assign({}, c, {
        id: normId,
        name: normName,
        channels: Array.isArray(c.channels) ? Array.from(new Set(c.channels.filter(Boolean))) : [],
      });
      mergedMap.set(key, copy);
      result.push(copy);
    }
  });

  return result;
}

function resolveSpreadsheet_(ssOrSheet) {
  if (ssOrSheet && typeof ssOrSheet === 'object') {
    if (typeof ssOrSheet.getSheetByName === 'function') return ssOrSheet;
    if (typeof ssOrSheet.getParent === 'function') return ssOrSheet.getParent();
  }
  return null;
}

function buildDefaultSettingsMetadata_() {
  return getDefaultSettingsMetadata_();
}

/** metadata 本體：先讀單一鍵，沒有時讀分塊（_CHUNKS＋_0、_1…）；新舊兩種鍵名都看。只讀需要的鍵（P11）。 */
function readSettingsMetadataProps_(props) {
  const read = function (base) {
    const raw = props.getProperty(base);
    if (raw) return JSON.parse(raw);
    const count = parseInt(props.getProperty(base + '_CHUNKS'), 10) || 0;
    if (!count) return null;
    let combined = '';
    for (let i = 0; i < count; i++) combined += (props.getProperty(base + '_' + i) || '');
    return combined ? JSON.parse(combined) : null;
  };
  return read(CONFIG.PROP_KEYS.SETTINGS_METADATA) || read('SETTINGS_METADATA');
}

function getSettingsMetadata_(ssOrForce) {
  const ss = resolveSpreadsheet_(ssOrForce);
  const props = scriptProps_();
  let meta = null;
  let fromSheet = false;

  try { meta = readSettingsMetadataProps_(props); } catch (e) { meta = null; }

  if (!meta && !isLegacyMetaCleaned_()) {
    try {
      meta = readLegacySheetMetadata_(ss);
      fromSheet = Boolean(meta);
    } catch (e) { meta = null; }
  }

  const def = getDefaultSettingsMetadata_();
  if (!meta || typeof meta !== 'object') {
    cleanLegacySheetMetadataCells_(ss);
    return def;
  }

  meta.emojis = (meta.emojis && typeof meta.emojis === 'object') ? meta.emojis : (meta.itemEmojis || {});
  meta.itemEmojis = meta.emojis;
  meta.itemColors = (meta.itemColors && typeof meta.itemColors === 'object' && !Array.isArray(meta.itemColors)) ? meta.itemColors : {};
  meta.channelColors = Object.assign({}, def.channelColors, meta.channelColors || {});
  meta.channels = Array.isArray(meta.channels) && meta.channels.length ? meta.channels : def.channels;
  meta.cards = Array.isArray(meta.cards) ? meta.cards : def.cards;
  meta.banks = Array.isArray(meta.banks) ? meta.banks : def.banks;
  meta.quickCombos = Array.isArray(meta.quickCombos) ? meta.quickCombos : [];

  let images = {};
  try { images = readMetadataImages_(props, meta); } catch (e) { images = {}; }
  meta.cards.forEach(c => {
    const storedImg = c && c.id ? images['IMG_CARD_' + c.id] : '';
    if (storedImg) {
      c.customImage = storedImg;
      c.image = storedImg;
    }
  });
  meta.banks.forEach(b => {
    const storedLogo = b && b.id ? images['IMG_BANK_' + b.id] : '';
    if (storedLogo) {
      b.customLogo = storedLogo;
      b.logo = storedLogo;
    }
  });

  meta.cards = normalizeCardsMetadataList_(meta.cards);

  if (fromSheet) {
    // 舊版資料只在試算表裡：先存進指令碼屬性，存成功才清掉儲存格（saveSettingsMetadata_ 會清並標記完成）
    saveSettingsMetadata_(meta, ss);
  } else {
    cleanLegacySheetMetadataCells_(ss);
  }
  return meta;
}

function splitUtf8Chunks_(text, maxBytes) {
  const chunks = [];
  let start = 0;
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const isLeadSurrogate = code >= 0xD800 && code <= 0xDBFF;
    const size = code < 0x80 ? 1 : (code < 0x800 ? 2 : (isLeadSurrogate ? 4 : 3));
    if (bytes + size > maxBytes) {
      chunks.push(text.slice(start, i));
      start = i;
      bytes = 0;
    }
    bytes += size;
    if (isLeadSurrogate) i++;
  }
  chunks.push(text.slice(start));
  return chunks;
}

function saveSettingsMetadata_(meta, ss) {
  if (!meta || typeof meta !== 'object') return false;
  let saved = false;

  meta.cards = normalizeCardsMetadataList_(meta.cards || []);

  const compactMeta = Object.assign({}, meta, {
    emojis: meta.emojis || meta.itemEmojis || {},
    itemEmojis: meta.emojis || meta.itemEmojis || {},
    channelColors: meta.channelColors || {},
    channels: (meta.channels || []).map(ch => ({
      id: ch.id || '',
      name: ch.name || '',
      color: ch.color || '',
    })),
    cards: [],
    banks: [],
    quickCombos: Array.isArray(meta.quickCombos) ? meta.quickCombos : [],
  });

  const imgPropsToSave = {};
  const activeImgKeys = new Set();

  if (Array.isArray(meta.cards)) {
    meta.cards.forEach(c => {
      if (!c || !c.name) return;
      const imgData = c.customImage || c.image || '';
      if (imgData && c.id) {
        const propKey = 'IMG_CARD_' + c.id;
        activeImgKeys.add(propKey);
        if (String(imgData).length <= 8500) {
          imgPropsToSave[propKey] = String(imgData);
        }
      }
      compactMeta.cards.push({
        id: c.id || '',
        name: c.name,
        type: c.type || 'credit',
        imageKey: c.imageKey || '',
        channels: Array.isArray(c.channels) ? c.channels : [],
      });
    });
  }

  if (Array.isArray(meta.banks)) {
    meta.banks.forEach(b => {
      if (!b || !b.name) return;
      const logoData = b.customLogo || b.logo || '';
      if (logoData && b.id) {
        const propKey = 'IMG_BANK_' + b.id;
        activeImgKeys.add(propKey);
        if (String(logoData).length <= 8500) {
          imgPropsToSave[propKey] = String(logoData);
        }
      }
      compactMeta.banks.push({
        id: b.id || '',
        name: b.name,
        logoKey: b.logoKey || '',
      });
    });
  }

  const compactStr = JSON.stringify(compactMeta);

  try {
    const props = scriptProps_();
    // 只讀鍵名（P11）：不用 getProperties() 把所有屬性的值都讀回來
    const existingKeys = new Set(props.getKeys() || []);
    const metaKey = CONFIG.PROP_KEYS.SETTINGS_METADATA;
    const readCount = function (key) {
      return existingKeys.has(key) ? (parseInt(props.getProperty(key), 10) || 0) : 0;
    };

    const staleImgKeys = [];
    const keptImgKeys = new Set(Object.keys(imgPropsToSave));
    existingKeys.forEach(function (k) {
      if (!isImagePropKey_(k)) return;
      if (activeImgKeys.has(k)) keptImgKeys.add(k);
      else staleImgKeys.push(k);
    });

    const batchProps = {};
    const staleKeys = [];

    const chunks = splitUtf8Chunks_(compactStr, 7500);
    const oldChunkCount = readCount(metaKey + '_CHUNKS');

    if (chunks.length === 1) {
      batchProps[metaKey] = compactStr;
      for (let i = 0; i < oldChunkCount; i++) {
        staleKeys.push(metaKey + '_' + i);
      }
      if (existingKeys.has(metaKey + '_CHUNKS')) staleKeys.push(metaKey + '_CHUNKS');
    } else {
      if (existingKeys.has(metaKey)) staleKeys.push(metaKey);
      chunks.forEach(function (chunk, i) {
        batchProps[metaKey + '_' + i] = chunk;
      });
      batchProps[metaKey + '_CHUNKS'] = String(chunks.length);
      for (let i = chunks.length; i < oldChunkCount; i++) {
        staleKeys.push(metaKey + '_' + i);
      }
    }

    if (existingKeys.has('SETTINGS_METADATA')) staleKeys.push('SETTINGS_METADATA');
    if (existingKeys.has('SETTINGS_METADATA_CHUNKS')) {
      const oldLegacyChunks = readCount('SETTINGS_METADATA_CHUNKS');
      for (let i = 0; i < oldLegacyChunks; i++) {
        staleKeys.push('SETTINGS_METADATA_' + i);
      }
      staleKeys.push('SETTINGS_METADATA_CHUNKS');
    }

    Object.assign(batchProps, imgPropsToSave);
    batchProps[CONFIG.PROP_KEYS.SETTINGS_IMAGE_INDEX] = JSON.stringify(Array.from(keptImgKeys).sort());

    props.setProperties(batchProps);

    staleImgKeys.concat(staleKeys).forEach(function (key) {
      if (existingKeys.has(key)) props.deleteProperty(key);
    });
    saved = true;
  } catch (e) {}

  // 存成功才清舊儲存格：舊版資料若只在儲存格裡，存失敗時不能先刪掉
  if (saved) cleanLegacySheetMetadataCells_(ss);
  return saved;
}
