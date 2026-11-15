/* =============================================================================
 * InfoTip — 標題旁的 info 說明提示框（設定頁共用）
 * -----------------------------------------------------------------------------
 * 點 info 按鈕展開提示框；再點一次、點其他地方或按 Esc 收起，同時只開一個。
 * 事件掛在 document 上，頁面重新繪製（innerHTML）後不需要重新綁定，
 * 重繪時提示框會自然收起。樣式在 styles/25-info-tip.css。
 * ============================================================================= */
const InfoTip = (function() {
  /**
   * 只有按鈕與提示框（不含標題）。
   * opts.side：提示框顯示在 icon 右側（適合很短的說明）
   * opts.under：提示框顯示在 icon 正下方，左右會夾在定位容器內不溢出（icon 不在行首時使用）
   * opts.label：按鈕的 aria-label，預設「說明」
   * opts.bubbleAttrs：額外加在提示框上的屬性字串（例如給 patch() 找元素用的 data-*）
   */
  function html(id, text, opts) {
    const o = opts || {};
    return '<span class="info-tip' + (o.side ? ' is-side' : '') + (o.under ? ' is-under' : '') + '">' +
             '<button type="button" class="info-tip-btn" data-info-tip aria-label="' + escAttr(o.label || '說明') + '"' +
               ' aria-expanded="false" aria-controls="' + escAttr(id) + '">' + iconHtml('info') + '</button>' +
             '<span class="info-tip-bubble" id="' + escAttr(id) + '" role="tooltip"' + (o.bubbleAttrs ? ' ' + o.bubbleAttrs : '') + ' hidden>' +
               escHtml(text) +
             '</span>' +
           '</span>';
  }

  /** 標題＋按鈕排成一列；提示框對齊整列寬度，窄螢幕不會溢出。 */
  function withTitle(titleHtml, id, text, opts) {
    return '<div class="info-tip-row">' + titleHtml + html(id, text, opts) + '</div>';
  }

  /** is-under：以定位容器為基準，把提示框放到 icon 正下方，超出容器時往內推。 */
  function placeUnder(btn, bubble) {
    const box = bubble.offsetParent;
    if (!box) return;
    const boxRect = box.getBoundingClientRect();
    const btnRect = btn.getBoundingClientRect();
    const maxLeft = Math.max(0, box.clientWidth - bubble.offsetWidth);
    const left = Math.min(Math.max(0, btnRect.left - boxRect.left), maxLeft);
    bubble.style.left = left + 'px';
    bubble.style.top = (btnRect.bottom - boxRect.top + 6) + 'px';
    // 小箭頭指向 icon 中央
    bubble.style.setProperty('--tip-arrow-x', (btnRect.left + btnRect.width / 2 - boxRect.left - left) + 'px');
  }

  function setOpen(btn, open) {
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
    const bubble = document.getElementById(btn.getAttribute('aria-controls'));
    if (!bubble) return;
    bubble.hidden = !open;
    if (open && btn.parentElement.classList.contains('is-under')) placeUnder(btn, bubble);
  }

  function closeAll(except) {
    document.querySelectorAll('.info-tip-btn[aria-expanded="true"]').forEach(btn => {
      if (btn !== except) setOpen(btn, false);
    });
  }

  document.addEventListener('click', e => {
    const btn = e.target.closest && e.target.closest('[data-info-tip]');
    if (btn) {
      closeAll(btn);
      setOpen(btn, btn.getAttribute('aria-expanded') !== 'true');
    } else if (!e.target.closest || !e.target.closest('.info-tip')) {
      closeAll();
    }
  });

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const open = document.querySelector('.info-tip-btn[aria-expanded="true"]');
    if (!open) return;
    closeAll();
    open.focus();
  });

  // 版面改變（旋轉、手機網址列收合）時重新對齊 icon，不直接收起
  window.addEventListener('resize', () => {
    document.querySelectorAll('.info-tip.is-under > .info-tip-btn[aria-expanded="true"]').forEach(btn => {
      const bubble = document.getElementById(btn.getAttribute('aria-controls'));
      if (bubble) placeUnder(btn, bubble);
    });
  });

  return { html: html, withTitle: withTitle, closeAll: closeAll };
})();
