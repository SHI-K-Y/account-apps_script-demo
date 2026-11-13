function openSettingsDeleteConfirm(targetInfo) {
  settingsState.deleteTarget = targetInfo;
  var nameEl = document.getElementById('settingsDeleteTargetName');
  var infoEl = document.getElementById('settingsDeleteTargetInfo');
  if (nameEl) nameEl.textContent = targetInfo.name || '';
  if (infoEl) infoEl.textContent = '所屬分類：' + (targetInfo.label || '選項');

  var modal = document.getElementById('settingsDeleteModal');
  if (modal) openModal(modal);
}

function closeSettingsDeleteConfirm() {
  var modal = document.getElementById('settingsDeleteModal');
  if (modal) closeModal(modal);
  settingsState.deleteTarget = null;
}

ModalManager.register('settingsDeleteModal', {
  close: closeSettingsDeleteConfirm,
  busy: 'settingsDeleteConfirmBtn'
});

var settingsDeleteCloseIconBtn = document.getElementById('settingsDeleteModalCloseIconBtn');
if (settingsDeleteCloseIconBtn) settingsDeleteCloseIconBtn.addEventListener('click', function() { ModalManager.close('settingsDeleteModal'); });
var settingsDeleteCancelBtn = document.getElementById('settingsDeleteCancelBtn');
if (settingsDeleteCancelBtn) settingsDeleteCancelBtn.addEventListener('click', function() { ModalManager.close('settingsDeleteModal'); });
var settingsDeleteModalEl = document.getElementById('settingsDeleteModal');
if (settingsDeleteModalEl) {
  settingsDeleteModalEl.addEventListener('click', function(e) {
    if (e.target === e.currentTarget) ModalManager.close('settingsDeleteModal');
  });
}

var settingsDeleteConfirmBtn = document.getElementById('settingsDeleteConfirmBtn');
if (settingsDeleteConfirmBtn) {
  settingsDeleteConfirmBtn.addEventListener('click', function() {
    var t = settingsState.deleteTarget;
    if (!t) return;

    settingsDeleteConfirmBtn.disabled = true;
    settingsDeleteConfirmBtn.textContent = '刪除中…';
    setLoading(true);

    if (t.mode === 'quickCombo') {
      cancelPendingQuickComboReorder();
      persistQuickCombos(getQuickCombos().filter(function(c) { return c.id !== t.id; }), {
        btn: settingsDeleteConfirmBtn,
        btnLabel: '確認刪除',
        errorPrefix: '刪除失敗：',
        onSuccess: function() {
          closeSettingsDeleteConfirm();
          showToast('已刪除「' + t.name + '」', 'success');
        }
      });
      return;
    }

    if (t.mode === 'itemWithEmoji') {
      Api.server
        .withSuccessHandler(function(result) {
          setLoading(false);
          settingsDeleteConfirmBtn.disabled = false;
          settingsDeleteConfirmBtn.textContent = '確認刪除';
          if (result && result.ok) {
            settingsState.data = result.options;
            if (result.metadata) {
              settingsState.metadata = result.metadata;
              LocalCache.saveSettingsMetadata(result.metadata);
            }
            closeSettingsDeleteConfirm();
            renderSettingsList();
            showToast('已刪除「' + t.name + '」', 'success');
            refreshBookkeepingOptions(result.simpleOptions, result.options, result.metadata);
          }
        })
        .withFailureHandler(function(err) {
          setLoading(false);
          settingsDeleteConfirmBtn.disabled = false;
          settingsDeleteConfirmBtn.textContent = '確認刪除';
          showToast('刪除失敗：' + (err.message || err), 'error');
        })
        .deleteSettingsItemWithEmoji({ category: t.category, row: t.row });

    } else if (t.mode === 'simpleOption') {
      Api.server
        .withSuccessHandler(function(result) {
          setLoading(false);
          settingsDeleteConfirmBtn.disabled = false;
          settingsDeleteConfirmBtn.textContent = '確認刪除';
          if (result && result.ok) {
            settingsState.data = result.options;
            closeSettingsDeleteConfirm();
            renderSettingsList();
            showToast('已刪除「' + t.name + '」', 'success');
            refreshBookkeepingOptions(result.simpleOptions, result.options, result.metadata);
          }
        })
        .withFailureHandler(function(err) {
          setLoading(false);
          settingsDeleteConfirmBtn.disabled = false;
          settingsDeleteConfirmBtn.textContent = '確認刪除';
          showToast('刪除失敗：' + (err.message || err), 'error');
        })
        .deleteSettingsOption(t.category, t.row);

    } else if (t.mode === 'card' || t.mode === 'channel' || t.mode === 'bank') {
      var m = ensureMetadataInitialized();
      if (t.mode === 'card') {
        m.cards = (m.cards || []).filter(function(c) { return c.id !== t.id; });
        LocalCache.saveCustomImage(t.id, null);
      } else if (t.mode === 'channel') {
        m.channels = (m.channels || []).filter(function(ch) { return ch.name !== t.name; });
        delete m.channelColors[t.name];
        (m.cards || []).forEach(function(c) {
          if (Array.isArray(c.channels)) {
            c.channels = c.channels.filter(function(cn) { return cn !== t.name; });
          }
        });
      } else if (t.mode === 'bank') {
        m.banks = (m.banks || []).filter(function(b) { return b.id !== t.id; });
        LocalCache.saveCustomImage(t.id, null);
      }

      persistPaymentSettingsToServer(m, settingsDeleteConfirmBtn, '確認刪除', function() {
        closeSettingsDeleteConfirm();
        showToast('已刪除「' + t.name + '」', 'success');
      });
    }
  });
}

function persistPaymentSettingsToServer(metaObj, btnEl, defaultBtnLabel, onSuccessCallback, extraPayload) {
  if (btnEl) {
    btnEl.disabled = true;
    btnEl.textContent = '同步中…';
  }
  setLoading(true);
  LocalCache.saveSettingsMetadata(metaObj);

  var extra = extraPayload || {};
  var hasRenames = Boolean(
    (Array.isArray(extra.cardRenames) && extra.cardRenames.length > 0) ||
    (Array.isArray(extra.channelRenames) && extra.channelRenames.length > 0)
  );

  Api.server
    .withSuccessHandler(function(result) {
      setLoading(false);
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = defaultBtnLabel;
      }
      if (result && result.ok) {
        settingsState.data = result.options;
        if (result.metadata) {
          settingsState.metadata = result.metadata;
          LocalCache.saveSettingsMetadata(result.metadata);
        }

        if ((result.updatedRowsCount && result.updatedRowsCount > 0) || hasRenames) {
          ccState.recordsByMonth = {};
          LocalCache.invalidateOverview();
          if (typeof window.__invalidateOverviewFlag === 'function') {
            window.__invalidateOverviewFlag();
          }
          try {
            var keysToRemove = [];
            for (var i = 0; i < localStorage.length; i++) {
              var k = localStorage.key(i);
              if (k && k.indexOf(LocalCache.KEY_RECENT_PREFIX) === 0) {
                keysToRemove.push(k);
              }
            }
            keysToRemove.forEach(function(k) { localStorage.removeItem(k); });
          } catch (e) {}
        }

        renderSettingsList();
        refreshBookkeepingOptions(result.simpleOptions, result.options, result.metadata);

        if (result.recent) {
          var targetMonth = result.recent.month || getMonth();
          LocalCache.saveRecent(targetMonth, result.recent);
          if (targetMonth === getMonth()) {
            renderRecent(result.recent);
          }
        }

        if (typeof onSuccessCallback === 'function') onSuccessCallback(result);
      }
    })
    .withFailureHandler(function(err) {
      setLoading(false);
      if (btnEl) {
        btnEl.disabled = false;
        btnEl.textContent = defaultBtnLabel;
      }
      showToast('同步失敗：' + (err.message || err), 'error');
    })
    .savePaymentSettingsConfig({
      currentMonth: getMonth(),
      channels: metaObj.channels || [],
      cards: metaObj.cards || [],
      banks: metaObj.banks || [],
      channelColors: metaObj.channelColors || {},
      cardRenames: extra.cardRenames || [],
      channelRenames: extra.channelRenames || []
    });
}

function refreshBookkeepingOptions(simpleOptions, rawOptions, metadata) {
  if (metadata) {
    settingsState.metadata = metadata;
    LocalCache.saveSettingsMetadata(metadata);
  }
  if (simpleOptions && state.data) {
    state.data.options = simpleOptions;
    if (rawOptions) state.data.settingsOptions = rawOptions;
    if (settingsState.metadata) state.data.settingsMetadata = settingsState.metadata;
    LocalCache.saveBoot(state.data);
    renderAllChoices();
    return;
  }
  Api.server
    .withSuccessHandler(function(data) {
      if (data && state.data) {
        state.data.options = data.options;
        if (data.settingsOptions) state.data.settingsOptions = data.settingsOptions;
        if (data.settingsMetadata) {
          state.data.settingsMetadata = data.settingsMetadata;
          settingsState.metadata = data.settingsMetadata;
          LocalCache.saveSettingsMetadata(data.settingsMetadata);
        }
        LocalCache.saveBoot(state.data);
        renderAllChoices();
      }
    })
    .withFailureHandler(function() {})
    .getInitialData(false);
}
