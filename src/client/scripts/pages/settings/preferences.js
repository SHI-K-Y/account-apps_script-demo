var PREF_MOTION_OPTIONS = [
  { value: 'full', label: '完整' },
  { value: 'lite', label: '精簡' },
  { value: 'off', label: '關閉' }
];

function bindPrefSegmented(container, attr, onPick) {
  var buttons = Array.prototype.slice.call(container.querySelectorAll('.pref-seg-btn[' + attr + ']'));
  var pick = function(btn) {
    if (!btn || btn.disabled) return;
    var value = btn.getAttribute(attr);
    onPick(value);
    var again = container.querySelector('.pref-seg-btn[' + attr + '="' + value + '"]');
    if (again) again.focus();
  };
  buttons.forEach(function(btn, idx) {
    btn.addEventListener('click', function() { pick(btn); });
    btn.addEventListener('keydown', function(e) {
      var step = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      for (var i = 1; i <= buttons.length; i++) {
        var next = buttons[(idx + step * i + buttons.length * 2) % buttons.length];
        if (!next.disabled) { pick(next); break; }
      }
    });
  });
}

function renderPreferencesSettings(container) {
  var prefs = Prefs.get();
  var systemReduced = Motion.systemReduced();
  var effective = Motion.level();
  var segHtml = PREF_MOTION_OPTIONS.map(function(opt) {
    var checked = opt.value === effective;
    var disabled = opt.value === 'full' && systemReduced;
    return '<button type="button" role="radio" class="pref-seg-btn' + (checked ? ' is-active' : '') + '"' +
             ' data-motion-value="' + opt.value + '"' +
             ' aria-checked="' + (checked ? 'true' : 'false') + '"' +
             ' tabindex="' + (checked ? '0' : '-1') + '"' +
             (disabled ? ' disabled aria-disabled="true"' : '') + '>' +
             opt.label +
           '</button>';
  }).join('');

  container.innerHTML =
    '<div class="settings-list-header">' +
      '<div class="settings-list-title-wrap">' +
        '<span class="settings-list-title">偏好設定</span>' +
        '<span class="settings-order-hint">只儲存在這台裝置上，不會同步到其他裝置</span>' +
      '</div>' +
    '</div>' +
    '<div class="pref-list">' +
      '<div class="pref-card">' +
        '<div class="pref-card-text">' +
          '<div class="pref-card-title" id="prefMotionTitle">動畫效果</div>' +
          '<div class="pref-card-desc">精簡：只保留淡入淡出；關閉：取消所有過場動畫，捲動改為瞬間跳轉</div>' +
          (systemReduced ? '<div class="pref-card-note">系統已開啟減少動態效果</div>' : '') +
        '</div>' +
        '<div class="pref-segmented" role="radiogroup" aria-labelledby="prefMotionTitle">' + segHtml + '</div>' +
      '</div>' +
      '<div class="pref-card pref-card-row">' +
        '<div class="pref-card-text">' +
          '<div class="pref-card-title" id="prefAutoScrollTitle">記帳時自動捲動到下一步</div>' +
          '<div class="pref-card-desc">選完項目、總類、支付方式後，自動帶到下一個要填的區塊</div>' +
        '</div>' +
        '<button type="button" class="pref-switch' + (prefs.autoScroll ? ' is-on' : '') + '" role="switch"' +
          ' aria-checked="' + (prefs.autoScroll ? 'true' : 'false') + '" aria-labelledby="prefAutoScrollTitle">' +
          '<span class="pref-switch-thumb" aria-hidden="true"></span>' +
        '</button>' +
      '</div>' +
    '</div>';

  // 分段控制由建立它的渲染函式直接啟用（P06：不再靠 body 層級的 MutationObserver 偵測）
  container.querySelectorAll('.pref-segmented').forEach(function(el) { Motion.segmented(el, '.pref-seg-btn'); });
  bindPrefSegmented(container, 'data-motion-value', function(value) { Prefs.set({ motion: value }); });

  var switchBtn = container.querySelector('.pref-switch');
  if (switchBtn) {
    switchBtn.addEventListener('click', function() {
      var nextVal = !Prefs.get().autoScroll;
      if (!nextVal) Motion.cancelScroll();
      Prefs.set({ autoScroll: nextVal });
      var again = container.querySelector('.pref-switch');
      if (again) again.focus();
    });
  }
}

document.addEventListener('prefschange', function() {
  if (settingsState.currentTab !== 'preferences') return;
  var container = document.getElementById('settingsListContainer');
  if (container) renderPreferencesSettings(container);
});
