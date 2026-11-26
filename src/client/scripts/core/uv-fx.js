/* =============================================================================
 * UvFx — 常駐裝飾動畫的「合成器圖層」標記（P02）
 * -----------------------------------------------------------------------------
 * 無限循環的動畫只能動 transform／opacity（CLAUDE.md），所以原本畫在 ::after 上、每幀改漸層角度
 * 或 background-position 的效果，改成「靜態遮罩容器＋只做 transform 的子元素」。偽元素不能有子元素，
 * 這些容器只能是真實元素，由建立元件的程式在建立時一起寫進 HTML：
 *
 *   卡片旋轉光環：UvFx.cardRing  → <span class="uv-ring">（靜態環形遮罩）裡的 <span>（rotate）
 *     用在 #todayExpenseCard（pages/bookkeeping.html 直接寫在標記裡）、總覽 .ov-hero／.ov-card、
 *     國外帳簿 .fx-stat-card。樣式見 styles/20-uiverse-effects.css。
 *   送出鈕外框流光：UvFx.btnRing → <span class="uv-btn-ring">（2px 外框遮罩）裡的 <span>（translateX）
 *     用在所有 .submit-btn。
 *   常用組合的虹彩玻璃板：UvFx.comboChip → 8 個感應區 <span class="uv-combo-touch"> ＋ 玻璃板 <span class="uv-combo-plate">
 *     用在記帳頁的 .quick-combo-chip（bookkeeping/quick-combos.js；空白的「＋ 建立常用組合」不用）。
 *     感應區必須是按鈕的前 8 個子元素：樣式用 :nth-child(1…8):hover ~ * 判斷滑鼠在哪一段，不需要 JS 監聽。
 *   記帳頁選項按鈕與金額鍵盤的玻璃板：UvFx.glassChip(btn) → 同樣 8 個感應區 ＋ <span class="uv-glass-plate">
 *     用在 #expense/incomeItemChoices、#expense/incomeCategoryChoices、#paymentChoices、#paidChoices 的 .choice
 *     與 #expense/incomeKeypad 的 .key（bookkeeping/payment-choices.js、amount.js）。整顆按鈕傾斜、顏色不變。
 *
 * 沒有套用效果的地方（例如 .oc-error 卡片、不支援 color-mix 的瀏覽器）這些 span 預設 display: none，
 * 多插一個也不會有副作用。HTML 字串直接串接常數；已經在畫面上的元素用 UvFx.ensure*()（重複呼叫不會重複插入）。
 * ============================================================================= */
const UvFx = (function() {
  const CARD_RING = '<span class="uv-ring" aria-hidden="true"><span></span></span>';
  const BTN_RING = '<span class="uv-btn-ring" aria-hidden="true"><span></span></span>';

  // 記帳頁的選項按鈕與金額鍵盤：沿用常用組合的 8 個感應區與玻璃層，但不畫虹彩底色——
  // 按鈕自己的底色、邊框、選取色維持原樣，玻璃板只疊外框光澤、斜向高光與滑動光澤（樣式見 20-uiverse-effects.css）。
  const TOUCH = '<span class="uv-combo-touch" aria-hidden="true"></span>'.repeat(8);
  const GLASS_CHIP = TOUCH +
    '<span class="uv-glass-plate" aria-hidden="true"><span class="uv-glass-rim"><span></span></span><span class="uv-glass-sheen"></span></span>';
  const COMBO_CHIP = TOUCH +
    '<span class="uv-combo-plate" aria-hidden="true"><span class="uv-combo-rim"></span><span class="uv-combo-inside"></span></span>';

  // 逐字包 span（滑鼠移上去時逐字呼吸）。textContent 不變。
  // 一般中文、英數字一個字元就是一個字；只有含 emoji、組合符號（ZWJ、變體選擇符、附加符號）的文字才用 Intl.Segmenter 切，
  // 組合式 emoji 才不會被拆開。Segmenter 建立很貴，整頁共用一個。
  const NEEDS_SEGMENTER = /[\uD800-\uDFFF\u0300-\u036F\u200D\u20D0-\u20FF\uFE00-\uFE0F]/;
  let segmenter;
  function graphemes(text) {
    if (!NEEDS_SEGMENTER.test(text)) return Array.from(text);
    if (segmenter === undefined) {
      segmenter = typeof Intl === 'object' && Intl.Segmenter ? new Intl.Segmenter('zh-Hant', { granularity: 'grapheme' }) : null;
    }
    return segmenter ? Array.from(segmenter.segment(text), part => part.segment) : Array.from(text);
  }
  function fillChars(el, text) {
    const frag = document.createDocumentFragment();
    graphemes(String(text == null ? '' : text)).forEach((ch, i) => {
      const span = document.createElement('span');
      span.className = 'uv-combo-ch';
      span.style.setProperty('--n', i);
      span.textContent = ch;
      frag.appendChild(span);
    });
    el.textContent = '';
    el.appendChild(frag);
    return el;
  }

  // 感應區＋玻璃板只解析一次 HTML，之後每顆按鈕複製一份
  let glassTemplate = null;
  function glassLayers() {
    if (!glassTemplate) {
      glassTemplate = document.createElement('template');
      glassTemplate.innerHTML = GLASS_CHIP;
    }
    return glassTemplate.content.cloneNode(true);
  }

  /** 把已經組好內容的按鈕套上玻璃效果：直接寫在按鈕裡的文字包成 .uv-glass-label，.choice-text 逐字拆開，最後在最前面插入感應區＋玻璃板。 */
  function glassChip(btn) {
    if (!btn || btn.classList.contains('uv-glass-chip')) return btn;
    btn.classList.add('uv-glass-chip');
    Array.from(btn.childNodes).forEach(node => {
      if (node.nodeType !== 3 || !node.nodeValue.trim()) return;
      const label = document.createElement('span');
      label.className = 'uv-glass-label';
      btn.replaceChild(fillChars(label, node.nodeValue), node);
    });
    btn.querySelectorAll('.choice-text').forEach(el => fillChars(el, el.textContent));
    btn.insertBefore(glassLayers(), btn.firstChild);
    return btn;
  }

  function ensure(el, cls, html) {
    if (!el || !el.insertAdjacentHTML) return el;
    for (let c = el.firstElementChild; c; c = c.nextElementSibling) {
      if (c.classList.contains(cls)) return el;
    }
    el.insertAdjacentHTML('afterbegin', html);
    return el;
  }

  return {
    cardRing: CARD_RING,
    btnRing: BTN_RING,
    comboChip: COMBO_CHIP,
    glassChip: glassChip,
    fillChars: fillChars,
    ensureCardRing: el => ensure(el, 'uv-ring', CARD_RING),
    ensureBtnRing: el => ensure(el, 'uv-btn-ring', BTN_RING)
  };
})();
