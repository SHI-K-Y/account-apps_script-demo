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
 *
 * 沒有套用效果的地方（例如 .oc-error 卡片、不支援 color-mix 的瀏覽器）這些 span 預設 display: none，
 * 多插一個也不會有副作用。HTML 字串直接串接常數；已經在畫面上的元素用 UvFx.ensure*()（重複呼叫不會重複插入）。
 * ============================================================================= */
const UvFx = (function() {
  const CARD_RING = '<span class="uv-ring" aria-hidden="true"><span></span></span>';
  const BTN_RING = '<span class="uv-btn-ring" aria-hidden="true"><span></span></span>';

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
    ensureCardRing: el => ensure(el, 'uv-ring', CARD_RING),
    ensureBtnRing: el => ensure(el, 'uv-btn-ring', BTN_RING)
  };
})();
