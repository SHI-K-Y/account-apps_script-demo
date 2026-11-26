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
 *   記帳頁選項按鈕與金額鍵盤的玻璃板：UvFx.glassChip(btn) → <span class="uv-glass-plate">（外框光澤＋滑動光澤）
 *     用在 #expense/incomeItemChoices、#expense/incomeCategoryChoices、#paymentChoices、#paidChoices 的 .choice
 *     與 #expense/incomeKeypad 的 .key（bookkeeping/payment-choices.js、amount.js）。整顆按鈕傾斜、顏色不變。
 *     這些按鈕開機首屏就有五十多顆，每多一個子元素都要多算一次樣式（量過：8 個感應區＋逐字 span 讓首屏多 20ms 以上），
 *     所以不用 8 個感應區：由一個共用的 pointer 監聽算出滑鼠／手指在哪一段，寫進按鈕的 --uv-glass-k 並加上 .is-tilting；
 *     逐字呼吸只在滑鼠第一次移上去時才拆字。
 *
 * 沒有套用效果的地方（例如 .oc-error 卡片、不支援 color-mix 的瀏覽器）這些 span 預設 display: none，
 * 多插一個也不會有副作用。HTML 字串直接串接常數；已經在畫面上的元素用 UvFx.ensure*()（重複呼叫不會重複插入）。
 * ============================================================================= */
const UvFx = (function() {
  const CARD_RING = '<span class="uv-ring" aria-hidden="true"><span></span></span>';
  const BTN_RING = '<span class="uv-btn-ring" aria-hidden="true"><span></span></span>';

  const COMBO_CHIP = '<span class="uv-combo-touch" aria-hidden="true"></span>'.repeat(8) +
    '<span class="uv-combo-plate" aria-hidden="true"><span class="uv-combo-rim"></span><span class="uv-combo-inside"></span></span>';

  // 記帳頁的選項按鈕與金額鍵盤：沿用常用組合的玻璃層，但不畫虹彩底色——
  // 按鈕自己的底色、邊框、選取色維持原樣，玻璃板只疊外框光澤、斜向高光（::before／::after）與滑動光澤（樣式見 20-uiverse-effects.css）。
  const GLASS_PLATE = '<span class="uv-glass-plate" aria-hidden="true"><span class="uv-glass-rim"></span><span class="uv-glass-sheen"></span></span>';

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

  // 玻璃板只解析一次 HTML，之後每顆按鈕複製一份
  let plateTemplate = null;
  function glassPlate() {
    if (!plateTemplate) {
      plateTemplate = document.createElement('template');
      plateTemplate.innerHTML = GLASS_PLATE;
    }
    return plateTemplate.content.cloneNode(true);
  }

  /** 把已經組好內容的按鈕套上玻璃效果：直接寫在按鈕裡的文字包成 .uv-glass-label（文字反向傾斜要用），最前面插入玻璃板。 */
  function glassChip(btn) {
    if (!btn || btn.classList.contains('uv-glass-chip')) return btn;
    btn.classList.add('uv-glass-chip');
    Array.from(btn.childNodes).forEach(node => {
      if (node.nodeType !== 3 || !node.nodeValue.trim()) return;
      const label = document.createElement('span');
      label.className = 'uv-glass-label';
      label.textContent = node.nodeValue;
      btn.replaceChild(label, node);
    });
    btn.insertBefore(glassPlate(), btn.firstChild);
    initGlassPointer();
    return btn;
  }

  // 感應：按鈕寬度切 8 段（同常用組合的 8 個感應區），k = 0–7。滑鼠／觸控筆移動時跟著換段，離開就放平；
  // 觸控只在手指按著時傾斜（同常用組合：滑鼠用 :hover、觸控用 :active）。
  // 寬度用剛進入按鈕、還沒傾斜時量到的位置，按鈕傾斜後分段界線不會跟著移動。
  let pointerBound = false;
  let tilted = null;
  function setTilt(btn, k) {
    if (tilted && tilted !== btn) clearTilt();
    if (!btn) return;
    if (tilted !== btn) {
      tilted = btn;
      btn._uvGlassRect = btn.getBoundingClientRect();
    }
    if (btn._uvGlassK !== k) {
      btn._uvGlassK = k;
      btn.style.setProperty('--uv-glass-k', k);
    }
    btn.classList.add('is-tilting');
  }
  function clearTilt() {
    if (!tilted) return;
    tilted.classList.remove('is-tilting');
    tilted._uvGlassK = null;
    tilted = null;
  }
  function segmentOf(btn, clientX) {
    const r = btn === tilted && btn._uvGlassRect ? btn._uvGlassRect : btn.getBoundingClientRect();
    if (!r.width) return 4;
    return Math.max(0, Math.min(7, Math.floor((clientX - r.left) / r.width * 8)));
  }
  function chipOf(e) {
    const t = e.target;
    const btn = t && t.closest ? t.closest('.uv-glass-chip') : null;
    return btn && !btn.disabled ? btn : null;
  }
  function splitCharsOnce(btn) {
    if (btn._uvGlassChars) return;
    btn._uvGlassChars = true;
    btn.querySelectorAll('.uv-glass-label, .choice-text').forEach(el => fillChars(el, el.textContent));
  }
  function initGlassPointer() {
    if (pointerBound || typeof document === 'undefined' || !document.addEventListener) return;
    pointerBound = true;
    const opts = { passive: true, capture: true };
    document.addEventListener('pointermove', e => {
      if (e.pointerType === 'touch') return;
      const btn = chipOf(e);
      if (!btn) { clearTilt(); return; }
      if (btn !== tilted) splitCharsOnce(btn);
      setTilt(btn, segmentOf(btn, e.clientX));
    }, opts);
    document.addEventListener('pointerdown', e => {
      if (e.pointerType !== 'touch') return;
      const btn = chipOf(e);
      if (btn) setTilt(btn, segmentOf(btn, e.clientX)); else clearTilt();
    }, opts);
    const end = e => {
      if (e.type === 'pointerout') {
        if (e.pointerType === 'touch' || !tilted) return;
        const to = e.relatedTarget;
        if (to && tilted.contains(to)) return;
      } else if (e.pointerType !== 'touch') {
        return;
      }
      clearTilt();
    };
    document.addEventListener('pointerout', end, opts);
    document.addEventListener('pointerup', end, opts);
    document.addEventListener('pointercancel', end, opts);
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
