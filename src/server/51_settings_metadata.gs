function getDefaultSettingsMetadata_() {
  return {
    emojis: {},
    itemEmojis: {},
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

function cleanLegacySheetMetadataCells_(ss) {
  try {
    const targetSs = ss || getSpreadsheet_();
    const sheet = targetSs.getSheetByName(CONFIG.SETTINGS_SHEET);
    if (!sheet || sheet.getMaxColumns() < 15) return;
    const vals = sheet.getRange('O1:Q1').getDisplayValues()[0];
    const hasLegacyJson = vals.some(v => {
      const s = String(v || '').trim();
      return s.startsWith('{') || s.includes('base64') || s.length > 100;
    });
    if (hasLegacyJson) {
      sheet.getRange('O1:Q1').clearContent();
    }
  } catch (e) {}
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

function getSettingsMetadata_(ssOrForce) {
  const ss = resolveSpreadsheet_(ssOrForce);
  let meta = null;
  let props = null;
  let allProps = {};

  try {
    props = scriptProps_();
    allProps = props.getProperties() || {};
    const primaryKey = CONFIG.PROP_KEYS.SETTINGS_METADATA;
    const raw = allProps[primaryKey] || allProps['SETTINGS_METADATA'];
    if (raw) {
      meta = JSON.parse(raw);
    } else {
      const chunksKey = allProps[primaryKey + '_CHUNKS']
        ? primaryKey
        : (allProps['SETTINGS_METADATA_CHUNKS'] ? 'SETTINGS_METADATA' : null);
      if (chunksKey) {
        const count = parseInt(allProps[chunksKey + '_CHUNKS'], 10) || 0;
        let combined = '';
        for (let i = 0; i < count; i++) {
          combined += (allProps[chunksKey + '_' + i] || '');
        }
        if (combined) meta = JSON.parse(combined);
      }
    }
  } catch (e) {}

  if (!meta) {
    try {
      const targetSs = ss || getSpreadsheet_();
      const sheet = targetSs.getSheetByName(CONFIG.SETTINGS_SHEET);
      if (sheet && sheet.getMaxColumns() >= 16) {
        const cellVal = String(sheet.getRange('P1').getDisplayValue() || '').trim();
        if (cellVal && cellVal.startsWith('{')) {
          meta = JSON.parse(cellVal);
        }
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
        cleanLegacySheetMetadataCells_(targetSs);
      }
    } catch (e) {
      cleanLegacySheetMetadataCells_(ss);
    }
  } else {
    cleanLegacySheetMetadataCells_(ss);
  }

  const def = getDefaultSettingsMetadata_();
  if (!meta || typeof meta !== 'object') {
    return def;
  }

  meta.emojis = (meta.emojis && typeof meta.emojis === 'object') ? meta.emojis : (meta.itemEmojis || {});
  meta.itemEmojis = meta.emojis;
  meta.channelColors = Object.assign({}, def.channelColors, meta.channelColors || {});
  meta.channels = Array.isArray(meta.channels) && meta.channels.length ? meta.channels : def.channels;
  meta.cards = Array.isArray(meta.cards) ? meta.cards : def.cards;
  meta.banks = Array.isArray(meta.banks) ? meta.banks : def.banks;
  meta.quickCombos = Array.isArray(meta.quickCombos) ? meta.quickCombos : [];

  if (allProps) {
    meta.cards.forEach(c => {
      if (c && c.id) {
        const storedImg = allProps['IMG_CARD_' + c.id];
        if (storedImg) {
          c.customImage = storedImg;
          c.image = storedImg;
        }
      }
    });
    meta.banks.forEach(b => {
      if (b && b.id) {
        const storedLogo = allProps['IMG_BANK_' + b.id];
        if (storedLogo) {
          b.customLogo = storedLogo;
          b.logo = storedLogo;
        }
      }
    });
  }

  meta.cards = normalizeCardsMetadataList_(meta.cards);
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
    const existingProps = props.getProperties() || {};
    const metaKey = CONFIG.PROP_KEYS.SETTINGS_METADATA;

    Object.keys(existingProps).forEach(k => {
      if ((k.startsWith('IMG_CARD_') || k.startsWith('IMG_BANK_')) && !activeImgKeys.has(k)) {
        props.deleteProperty(k);
      }
    });

    const batchProps = {};
    const staleKeys = [];

    const chunks = splitUtf8Chunks_(compactStr, 7500);
    const oldChunkCount = parseInt(existingProps[metaKey + '_CHUNKS'], 10) || 0;

    if (chunks.length === 1) {
      batchProps[metaKey] = compactStr;
      for (let i = 0; i < oldChunkCount; i++) {
        staleKeys.push(metaKey + '_' + i);
      }
      if (existingProps[metaKey + '_CHUNKS']) staleKeys.push(metaKey + '_CHUNKS');
    } else {
      if (existingProps[metaKey]) staleKeys.push(metaKey);
      chunks.forEach(function (chunk, i) {
        batchProps[metaKey + '_' + i] = chunk;
      });
      batchProps[metaKey + '_CHUNKS'] = String(chunks.length);
      for (let i = chunks.length; i < oldChunkCount; i++) {
        staleKeys.push(metaKey + '_' + i);
      }
    }

    if (existingProps['SETTINGS_METADATA']) staleKeys.push('SETTINGS_METADATA');
    if (existingProps['SETTINGS_METADATA_CHUNKS']) {
      const oldLegacyChunks = parseInt(existingProps['SETTINGS_METADATA_CHUNKS'], 10) || 0;
      for (let i = 0; i < oldLegacyChunks; i++) {
        staleKeys.push('SETTINGS_METADATA_' + i);
      }
      staleKeys.push('SETTINGS_METADATA_CHUNKS');
    }

    Object.assign(batchProps, imgPropsToSave);

    props.setProperties(batchProps);

    staleKeys.forEach(function (key) {
      props.deleteProperty(key);
    });
    saved = true;
  } catch (e) {}

  cleanLegacySheetMetadataCells_(ss);
  return saved;
}
