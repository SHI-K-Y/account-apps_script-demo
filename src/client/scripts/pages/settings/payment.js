function renderPaymentSettingsModule(container) {
  var m = ensureMetadataInitialized();
  var sub = settingsState.paySubtab || 'cards';

  if (sub === 'cards') {
    var cards = m.cards || [];
    if (!cards.length) {
      container.innerHTML =
        '<div class="settings-empty">' +
          '<div class="settings-empty-icon" aria-hidden="true">' + iconHtml('credit-card') + '</div>' +
          '<div class="settings-empty-text">尚無設定任何卡片，請點擊右上角「新增卡別」</div>' +
        '</div>';
      return;
    }

    var html = '<div class="settings-list-header">' +
                 '<span class="settings-list-title">已設定卡別</span>' +
                 '<span class="settings-list-count">共 ' + cards.length + ' 張卡</span>' +
               '</div>' +
               '<div class="cards-management-grid">';

    cards.forEach(function(c) {
      var imgSrc = getPaymentCardImage(c.name, c.name);
      var isDebit = (c.type === 'debit');
      var chList = Array.isArray(c.channels) ? c.channels : [];
      html += '<div class="card-item-card" data-cid="' + escAttr(c.id) + '">' +
                '<div class="card-item-top">' +
                  '<div class="card-thumb-wrap">' +
                    (imgSrc
                      ? '<img class="card-thumb-img" src="' + escAttr(imgSrc) + '" alt="' + escAttr(c.name) + '" width="58" height="38" decoding="async">'
                      : '<span class="card-thumb-fallback" aria-hidden="true">' + iconHtml('credit-card') + '</span>') +
                  '</div>' +
                  '<div class="card-item-info">' +
                    '<div class="card-item-title-row">' +
                      '<span class="card-item-name">' + escHtml(c.name) + '</span>' +
                      '<span class="card-type-tag ' + (isDebit ? 'debit' : 'credit') + '">' + (isDebit ? '簽帳卡' : '信用卡') + '</span>' +
                    '</div>' +
                  '</div>' +
                  '<div class="settings-item-actions">' +
                    '<button class="settings-action-btn card-edit-trigger" type="button" data-cid="' + escAttr(c.id) + '" title="修改卡別">' +
                      '' + iconHtml('note-pencil', 'regular', 'ic-15') + '' +
                    '</button>' +
                    '<button class="settings-action-btn card-del-trigger" type="button" data-cid="' + escAttr(c.id) + '" title="刪除卡別">' +
                      '' + iconHtml('trash', 'regular', 'ic-15') + '' +
                    '</button>' +
                  '</div>' +
                '</div>' +
                '<div class="card-item-channels-wrap">' +
                  (chList.length
                    ? chList.map(function(chName) {
                        var col = (m.channelColors && m.channelColors[chName]) || '';
                        var dotStyle = col ? ' style="display:inline-block;width:6px;height:6px;border-radius:50%;background:' + escAttr(col) + ';margin-right:4px;"' : '';
                        return '<span class="card-channel-badge"><span' + dotStyle + '></span>' + escHtml(chName) + '</span>';
                      }).join('')
                    : '<span class="card-channel-badge">未綁定通路</span>') +
                '</div>' +
              '</div>';
    });

    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.card-edit-trigger').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var cid = btn.dataset.cid;
        var target = (m.cards || []).find(function(x) { return x.id === cid; });
        if (target) openCardModal(target);
      });
    });

    container.querySelectorAll('.card-del-trigger').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var cid = btn.dataset.cid;
        var target = (m.cards || []).find(function(x) { return x.id === cid; });
        if (target) {
          openSettingsDeleteConfirm({
            mode: 'card',
            id: target.id,
            name: target.name,
            label: '卡別管理'
          });
        }
      });
    });

  } else if (sub === 'channels') {
    var channels = m.channels || [];
    if (!channels.length) {
      container.innerHTML =
        '<div class="settings-empty">' +
          '<div class="settings-empty-icon" aria-hidden="true">' + iconHtml('tag') + '</div>' +
          '<div class="settings-empty-text">尚無支付通路，請點擊右上角「新增通路」</div>' +
        '</div>';
      return;
    }

    var html = '<div class="settings-list-header">' +
                 '<div class="settings-list-title-wrap">' +
                   '<span class="settings-list-title">支付通路群組</span>' +
                   '<span class="settings-order-hint">可使用上下箭頭或拖曳自訂順序</span>' +
                 '</div>' +
                 '<span class="settings-list-count">共 ' + channels.length + ' 個通路</span>' +
               '</div>' +
               '<div class="channels-management-grid" id="channelsSortableGrid">';

    channels.forEach(function(ch, idx) {
      var boundCount = (m.cards || []).filter(function(c) {
        return Array.isArray(c.channels) && c.channels.includes(ch.name);
      }).length;
      var col = ch.color || (m.channelColors && m.channelColors[ch.name]) || '#288465';
      var isFirst = (idx === 0);
      var isLast = (idx === channels.length - 1);

      html += '<div class="channel-item-card" draggable="true" data-idx="' + idx + '" data-chname="' + escAttr(ch.name) + '">' +
                '<div class="channel-item-left">' +
                  '<span class="settings-drag-handle" title="按住拖曳自訂順序" aria-label="拖曳排序">' + iconHtml('dots-six-vertical') + '</span>' +
                  '<span class="settings-item-order">' + (idx + 1) + '</span>' +
                  '<span class="channel-color-dot" style="background:' + escAttr(col) + ';"></span>' +
                  '<div class="channel-item-info">' +
                    '<div class="channel-item-name">' + escHtml(ch.name) + '</div>' +
                    '<div class="channel-item-count">已綁定 ' + boundCount + ' 張卡片</div>' +
                  '</div>' +
                '</div>' +
                '<div class="settings-item-actions">' +
                  '<button class="settings-action-btn settings-move-btn ch-move-up-btn" type="button" data-idx="' + idx + '" title="向前移動一位"' + (isFirst ? ' disabled' : '') + '>' +
                    iconHtml('caret-up') +
                  '</button>' +
                  '<button class="settings-action-btn settings-move-btn ch-move-down-btn" type="button" data-idx="' + idx + '" title="向後移動一位"' + (isLast ? ' disabled' : '') + '>' +
                    iconHtml('caret-down') +
                  '</button>' +
                  '<button class="settings-action-btn ch-edit-trigger" type="button" data-chname="' + escAttr(ch.name) + '" title="修改通路與色彩">' +
                    '' + iconHtml('note-pencil', 'regular', 'ic-15') + '' +
                  '</button>' +
                  '<button class="settings-action-btn ch-del-trigger" type="button" data-chname="' + escAttr(ch.name) + '" title="刪除通路">' +
                    '' + iconHtml('trash', 'regular', 'ic-15') + '' +
                  '</button>' +
                '</div>' +
              '</div>';
    });

    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.ch-move-up-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = Number(btn.dataset.idx);
        if (idx > 0) {
          reorderPaymentChannel(idx, idx - 1);
        }
      });
    });

    container.querySelectorAll('.ch-move-down-btn').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var idx = Number(btn.dataset.idx);
        if (idx < channels.length - 1) {
          reorderPaymentChannel(idx, idx + 1);
        }
      });
    });

    var gridEl = container.querySelector('#channelsSortableGrid');
    if (gridEl) {
      var dragSrcIdx = null;

      gridEl.querySelectorAll('.channel-item-card').forEach(function(cardEl) {
        cardEl.addEventListener('dragstart', function(e) {
          dragSrcIdx = Number(cardEl.dataset.idx);
          cardEl.classList.add('dragging');
          e.dataTransfer.effectAllowed = 'move';
          try {
            e.dataTransfer.setData('text/plain', String(dragSrcIdx));
          } catch (err) {}
        });

        cardEl.addEventListener('dragover', function(e) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          if (!cardEl.classList.contains('dragging')) {
            cardEl.classList.add('drag-over');
          }
        });

        cardEl.addEventListener('dragleave', function() {
          cardEl.classList.remove('drag-over');
        });

        cardEl.addEventListener('drop', function(e) {
          e.preventDefault();
          e.stopPropagation();
          cardEl.classList.remove('drag-over');
          var targetIdx = Number(cardEl.dataset.idx);
          if (dragSrcIdx !== null && targetIdx !== dragSrcIdx && !isNaN(targetIdx)) {
            var from = dragSrcIdx;
            dragSrcIdx = null;
            reorderPaymentChannel(from, targetIdx);
          }
        });

        cardEl.addEventListener('dragend', function() {
          cardEl.classList.remove('dragging');
          gridEl.querySelectorAll('.channel-item-card').forEach(function(el) {
            el.classList.remove('drag-over');
          });
          dragSrcIdx = null;
        });
      });
    }

    container.querySelectorAll('.ch-edit-trigger').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var chName = btn.dataset.chname;
        var target = (m.channels || []).find(function(x) { return x.name === chName; });
        if (target) openChannelModal(target);
      });
    });

    container.querySelectorAll('.ch-del-trigger').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var chName = btn.dataset.chname;
        var target = (m.channels || []).find(function(x) { return x.name === chName; });
        if (target) {
          openSettingsDeleteConfirm({
            mode: 'channel',
            name: target.name,
            label: '支付通路群組'
          });
        }
      });
    });

  } else if (sub === 'banks') {
    var banks = m.banks || [];
    if (!banks.length) {
      container.innerHTML =
        '<div class="settings-empty">' +
          '<div class="settings-empty-icon" aria-hidden="true">' + iconHtml('bank') + '</div>' +
          '<div class="settings-empty-text">尚無設定轉帳銀行，請點擊右上角「新增銀行」</div>' +
        '</div>';
      return;
    }

    var html = '<div class="settings-list-header">' +
                 '<span class="settings-list-title">轉帳銀行清單</span>' +
                 '<span class="settings-list-count">共 ' + banks.length + ' 間銀行</span>' +
               '</div>' +
               '<div class="banks-management-grid">';

    banks.forEach(function(b) {
      var logoSrc = getBankLogo('轉帳-' + b.name, b.name, '轉帳');
      html += '<div class="bank-item-card" data-bid="' + escAttr(b.id) + '">' +
                '<div class="bank-item-left">' +
                  (logoSrc
                    ? '<img class="bank-item-logo-thumb" src="' + escAttr(logoSrc) + '" alt="' + escAttr(b.name) + '" width="32" height="32" decoding="async">'
                    : '<span class="bank-item-logo-fallback" aria-hidden="true">' + iconHtml('bank') + '</span>') +
                  '<div class="bank-item-name">' + escHtml(b.name) + '</div>' +
                '</div>' +
                '<div class="settings-item-actions">' +
                  '<button class="settings-action-btn bank-edit-trigger" type="button" data-bid="' + escAttr(b.id) + '" title="修改銀行">' +
                    '' + iconHtml('note-pencil', 'regular', 'ic-15') + '' +
                  '</button>' +
                  '<button class="settings-action-btn bank-del-trigger" type="button" data-bid="' + escAttr(b.id) + '" title="刪除銀行">' +
                    '' + iconHtml('trash', 'regular', 'ic-15') + '' +
                  '</button>' +
                '</div>' +
              '</div>';
    });

    html += '</div>';
    container.innerHTML = html;

    container.querySelectorAll('.bank-edit-trigger').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var bid = btn.dataset.bid;
        var target = (m.banks || []).find(function(x) { return x.id === bid; });
        if (target) openBankModal(target);
      });
    });

    container.querySelectorAll('.bank-del-trigger').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var bid = btn.dataset.bid;
        var target = (m.banks || []).find(function(x) { return x.id === bid; });
        if (target) {
          openSettingsDeleteConfirm({
            mode: 'bank',
            id: target.id,
            name: target.name,
            label: '轉帳銀行'
          });
        }
      });
    });
  }
}
