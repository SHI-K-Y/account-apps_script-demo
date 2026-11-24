function batchUpdateMonthSheetPaymentColumn_(sheet, cardRenameMap, channelRenameMap, bankRenameMap) {
  var bankMap = bankRenameMap || {};
  var lastRow = Math.min(CONFIG.MAX_DATA_ROW, sheet.getLastRow());
  if (lastRow < CONFIG.MIN_DATA_ROW) {
    return 0;
  }
  var rowCount = lastRow - CONFIG.MIN_DATA_ROW + 1;
  var colEValues = sheet.getRange(CONFIG.MIN_DATA_ROW, 5, rowCount, 1).getDisplayValues();
  var updatedColE = [];
  var changedRowsCount = 0;

  var cardRenameLowerMap = {};
  Object.keys(cardRenameMap).forEach(function (oldK) {
    cardRenameLowerMap[oldK.trim().toLowerCase()] = cardRenameMap[oldK];
  });

  var channelRenameLowerMap = {};
  Object.keys(channelRenameMap).forEach(function (oldCh) {
    channelRenameLowerMap[oldCh.trim().toLowerCase()] = channelRenameMap[oldCh];
  });

  var bankRenameLowerMap = {};
  Object.keys(bankMap).forEach(function (oldBank) {
    bankRenameLowerMap[oldBank.trim().toLowerCase()] = bankMap[oldBank];
  });

  for (var i = 0; i < rowCount; i++) {
    var origVal = String(colEValues[i][0] || '');
    var trimmed = origVal.trim();
    if (!trimmed) {
      updatedColE.push(['']);
      continue;
    }

    var newVal = origVal;
    var isRowChanged = false;
    var dashMatch = trimmed.match(/[-－—–]/);

    if (dashMatch && dashMatch.index !== undefined) {
      var idx = dashMatch.index;
      var chPart = trimmed.slice(0, idx).trim();
      var cardPart = trimmed.slice(idx + 1).trim();

      var newCh = chPart;
      var newCard = cardPart;

      if (Object.prototype.hasOwnProperty.call(channelRenameMap, chPart)) {
        newCh = channelRenameMap[chPart];
        isRowChanged = true;
      } else if (Object.prototype.hasOwnProperty.call(channelRenameLowerMap, chPart.toLowerCase())) {
        newCh = channelRenameLowerMap[chPart.toLowerCase()];
        isRowChanged = true;
      }

      if (Object.prototype.hasOwnProperty.call(cardRenameMap, cardPart)) {
        newCard = cardRenameMap[cardPart];
        isRowChanged = true;
      } else if (Object.prototype.hasOwnProperty.call(cardRenameLowerMap, cardPart.toLowerCase())) {
        newCard = cardRenameLowerMap[cardPart.toLowerCase()];
        isRowChanged = true;
      }

      if (newCh === '轉帳') {
        if (Object.prototype.hasOwnProperty.call(bankMap, newCard)) {
          newCard = bankMap[newCard];
          isRowChanged = true;
        } else if (Object.prototype.hasOwnProperty.call(bankRenameLowerMap, newCard.toLowerCase())) {
          newCard = bankRenameLowerMap[newCard.toLowerCase()];
          isRowChanged = true;
        }
      }

      if (isRowChanged) {
        newVal = literalText_(newCh + '-' + newCard);
      }
    } else {
      if (Object.prototype.hasOwnProperty.call(cardRenameMap, trimmed)) {
        newVal = literalText_(cardRenameMap[trimmed]);
        isRowChanged = true;
      } else if (Object.prototype.hasOwnProperty.call(cardRenameLowerMap, trimmed.toLowerCase())) {
        newVal = literalText_(cardRenameLowerMap[trimmed.toLowerCase()]);
        isRowChanged = true;
      }
    }

    if (isRowChanged && newVal !== origVal) {
      updatedColE.push([newVal]);
      changedRowsCount++;
    } else {
      updatedColE.push([literalText_(origVal)]);
    }
  }

  if (changedRowsCount > 0) {
    sheet.getRange(CONFIG.MIN_DATA_ROW, 5, rowCount, 1).setValues(updatedColE);
  }

  return changedRowsCount;
}

function savePaymentSettingsConfig_(configPayload) {
  return withDocumentLock_(function () {
    if (!configPayload || typeof configPayload !== 'object') {
      throw new Error('無效的支付方式設定資料。');
    }

    var ss = getSpreadsheet_();
    var settings = getSettingsSheet_(ss);

    var existingMeta = getSettingsMetadata_(ss) || getDefaultSettingsMetadata_();
    var cardRenameMap = {};
    var channelRenameMap = {};

    var existingCardIdMap = {};
    var existingCardImgMap = {};
    (existingMeta.cards || []).forEach(function (c) {
      if (c && c.id) {
        if (c.name) existingCardIdMap[String(c.id)] = stripEmoji_(c.name);
        if (c.customImage || c.image) existingCardImgMap[String(c.id)] = c.customImage || c.image;
      }
    });

    if (Array.isArray(configPayload.cardRenames)) {
      configPayload.cardRenames.forEach(function (rn) {
        if (!rn) return;
        var oName = stripEmoji_(rn.oldName || '');
        var nName = stripEmoji_(rn.newName || '');
        if (oName && nName && oName !== nName) {
          cardRenameMap[oName] = nName;
        }
      });
    }

    if (Array.isArray(configPayload.cards)) {
      configPayload.cards.forEach(function (c) {
        if (!c || !c.id || !c.name) return;
        var cid = String(c.id);
        var newName = stripEmoji_(c.name);
        var oldName = existingCardIdMap[cid];
        if (oldName && newName && oldName !== newName) {
          cardRenameMap[oldName] = newName;
        }
        if (!c.customImage && !c.image && existingCardImgMap[cid]) {
          c.customImage = existingCardImgMap[cid];
          c.image = existingCardImgMap[cid];
        }
      });
    }

    var existingChannelIdMap = {};
    (existingMeta.channels || []).forEach(function (ch) {
      if (ch && ch.id && ch.name) {
        existingChannelIdMap[String(ch.id)] = stripEmoji_(ch.name);
      }
    });

    if (Array.isArray(configPayload.channelRenames)) {
      configPayload.channelRenames.forEach(function (rn) {
        if (!rn) return;
        var oCh = stripEmoji_(rn.oldName || '');
        var nCh = stripEmoji_(rn.newName || '');
        if (oCh && nCh && oCh !== nCh) {
          channelRenameMap[oCh] = nCh;
        }
      });
    }

    if (Array.isArray(configPayload.channels)) {
      configPayload.channels.forEach(function (ch) {
        if (!ch || !ch.id || !ch.name) return;
        var chId = String(ch.id);
        var newChName = stripEmoji_(ch.name);
        var oldChName = existingChannelIdMap[chId];
        if (oldChName && newChName && oldChName !== newChName) {
          channelRenameMap[oldChName] = newChName;
        }
      });
    }

    var bankRenameMap = {};
    var existingBankIdMap = {};
    (existingMeta.banks || []).forEach(function (b) {
      if (b && b.id && b.name) existingBankIdMap[String(b.id)] = stripEmoji_(b.name);
    });
    if (Array.isArray(configPayload.banks)) {
      configPayload.banks.forEach(function (b) {
        if (!b || !b.id || !b.name) return;
        var oldBankName = existingBankIdMap[String(b.id)];
        var newBankName = stripEmoji_(b.name);
        if (oldBankName && newBankName && oldBankName !== newBankName) {
          bankRenameMap[oldBankName] = newBankName;
        }
      });
    }

    var quickCombos = (existingMeta.quickCombos || []).map(function (combo) {
      if (!combo || !combo.payment) return combo;
      var payment = renamePaymentValue_(combo.payment, cardRenameMap, channelRenameMap, bankRenameMap);
      return payment === combo.payment ? combo : Object.assign({}, combo, { payment: payment });
    });

    var channels = Array.isArray(configPayload.channels) ? configPayload.channels : (existingMeta.channels || []);
    var cards = normalizeCardsMetadataList_(Array.isArray(configPayload.cards) ? configPayload.cards : (existingMeta.cards || []));
    var banks = Array.isArray(configPayload.banks) ? configPayload.banks : (existingMeta.banks || []);
    var channelColors = Object.assign({}, existingMeta.channelColors || {}, configPayload.channelColors || {});
    var emojisMap = configPayload.itemEmojis || configPayload.emojis || existingMeta.itemEmojis || existingMeta.emojis || {};

    channels.forEach(function (ch) {
      if (ch && ch.name && ch.color) {
        channelColors[stripEmoji_(ch.name)] = ch.color;
      }
    });

    var pmList = ['現金'];

    channels.forEach(function (ch) {
      var chName = stripEmoji_(ch && ch.name ? ch.name : (ch || ''));
      if (!chName || chName === '現金' || chName === '轉帳') return;
      cards.forEach(function (card) {
        if (!card || !card.name) return;
        var cardChannels = Array.isArray(card.channels) ? card.channels : [];
        if (cardChannels.indexOf(chName) !== -1) {
          var cardName = stripEmoji_(card.name);
          if (cardName) {
            var combinedName = chName + '-' + cardName;
            if (pmList.indexOf(combinedName) === -1) {
              pmList.push(combinedName);
            }
          }
        }
      });
    });

    banks.forEach(function (b) {
      var bName = stripEmoji_(b && b.name ? b.name : (b || ''));
      if (bName) {
        var transferName = '轉帳-' + bName;
        if (pmList.indexOf(transferName) === -1) {
          pmList.push(transferName);
        }
      }
    });

    var colIndex = 6;
    var maxRows = Math.max(100, settings.getMaxRows());
    var colFValues = settings.getRange(2, colIndex, maxRows - 1, 1).getDisplayValues();
    var lastRowWithData = 1;
    for (var i = colFValues.length - 1; i >= 0; i--) {
      if (String(colFValues[i][0] || '').trim() !== '') {
        lastRowWithData = i + 2;
        break;
      }
    }

    var clearCount = Math.max(lastRowWithData - 1, pmList.length, 30);
    if (clearCount > 0) {
      settings.getRange(2, colIndex, clearCount, 1).clearContent();
    }

    if (pmList.length > 0) {
      if (pmList.length + 1 > settings.getMaxRows()) {
        settings.insertRowsAfter(settings.getMaxRows(), (pmList.length + 1) - settings.getMaxRows());
      }
      var writeValues = pmList.map(function (item) {
        return [literalText_(item)];
      });
      settings.getRange(2, colIndex, writeValues.length, 1).setValues(writeValues);
    }

    var updatedMeta = Object.assign({}, existingMeta, {
      channels: channels,
      cards: cards,
      banks: banks,
      channelColors: channelColors,
      itemEmojis: emojisMap,
      emojis: emojisMap,
      quickCombos: quickCombos,
      updatedAt: Date.now(),
    });
    saveSettingsMetadata_(updatedMeta, ss);

    var hasCardRenames = Object.keys(cardRenameMap).length > 0;
    var hasChannelRenames = Object.keys(channelRenameMap).length > 0;
    var hasBankRenames = Object.keys(bankRenameMap).length > 0;
    var updatedMonthsCount = 0;
    var updatedRowsCount = 0;
    var affectedMonths = [];

    var allMonths = getMonthsList_(ss, false);
    if ((hasCardRenames || hasChannelRenames || hasBankRenames) && Array.isArray(allMonths) && allMonths.length > 0) {
      allMonths.forEach(function (monthName) {
        var mSheet = ss.getSheetByName(monthName);
        if (!mSheet) return;
        var changedInSheet = batchUpdateMonthSheetPaymentColumn_(mSheet, cardRenameMap, channelRenameMap, bankRenameMap);
        if (changedInSheet > 0) {
          updatedMonthsCount++;
          updatedRowsCount += changedInSheet;
          affectedMonths.push(monthName);
        }
      });
    }

    var updatedFxRowsCount = 0;
    if (hasCardRenames || hasChannelRenames || hasBankRenames) {
      updatedFxRowsCount = batchUpdateFxPaymentColumns_(ss, cardRenameMap, channelRenameMap, bankRenameMap);
    }

    flushSpreadsheet_();

    markSummaryDirty_(affectedMonths);

    if (affectedMonths.length > 0) {
      try {
        var cache = scriptCache_();
        var keysToRemove = [CONFIG.CACHE_KEYS.BOOT_JSON];
        affectedMonths.forEach(function (m) {
          keysToRemove.push(CONFIG.CACHE_KEYS.MONTH_DATA_PREFIX + m);
          keysToRemove.push(CONFIG.CACHE_KEYS.OVERVIEW_PREFIX + m);
        });
        cache.removeAll(keysToRemove);
      } catch (e) {}
    }

    invalidateOptionCaches_();
    var updated = readAllOptionsData_(ss, true);
    updateBootSnapshotOptions_(updated);

    var tz = DEFAULT_TIME_ZONE_;
    var currentMonth = (configPayload.currentMonth && allMonths.indexOf(configPayload.currentMonth) !== -1)
      ? configPayload.currentMonth
      : (allMonths && allMonths.length ? allMonths[0] : formatMonth_(new Date(), tz));

    var recent = null;
    if (currentMonth && allMonths.indexOf(currentMonth) !== -1) {
      try {
        recent = getRecentRecords_(currentMonth, 8, 8, true);
      } catch (e) {}
    }

    return {
      ok: true,
      options: updated.raw,
      simpleOptions: updated.simple,
      metadata: updated.metadata,
      updatedMonthsCount: updatedMonthsCount,
      updatedRowsCount: updatedRowsCount,
      updatedFxRowsCount: updatedFxRowsCount,
      recent: recent,
    };
  });
}

function updateBootSnapshotOptions_(updatedOptions) {
  try {
    const current = readBootForUpdate_();
    const boot = current.boot;
    if (!boot) return;
    boot.options = updatedOptions.simple;
    boot.settingsOptions = updatedOptions.raw;
    if (updatedOptions.metadata) boot.settingsMetadata = updatedOptions.metadata;
    if (current.inCache) {
      boot.cachedAt = Date.now();
      saveBootSnapshot_(boot);
    } else {
      saveBootSnapshot_(boot, { snapshotOnly: true });
    }
  } catch (e) {}
}
