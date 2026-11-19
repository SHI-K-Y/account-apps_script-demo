var overviewLoaded = false;
var settlementLoaded = false;
var settingsLoaded = false;

window.__invalidateOverviewFlag = function() {
  overviewLoaded = false;
  settlementLoaded = false;
};

document.querySelectorAll('.nav-item').forEach(function(btn) {
  btn.addEventListener('click', function() {
    var page = btn.dataset.page;
    switchPage(page);
  });
});

/* 頁面切換時的重工作（P05）：View Transitions 要等 update callback 做完才開始拍新畫面、開始動畫，
 * 所以 callback 裡只切 class、用 LocalCache 或骨架做輕量渲染；圖表、長清單交給 PageWork.defer()，
 * 等 transition.ready（動畫已經開始）之後一幀做一件。沒有轉場時（動畫關閉、不支援）立刻執行，行為和以前一樣。
 * 之後的「閒置預先渲染」也可以直接把工作丟進 PageWork.defer()。 */
var PageWork = (function() {
  var queue = [];
  var gate = null;
  var raf = 0;
  function pump() {
    raf = 0;
    if (gate) return;
    var job = queue.shift();
    if (job) {
      try { job(); } catch (e) { console.error(e); }
    }
    if (queue.length) raf = requestAnimationFrame(pump);
  }
  function kick() {
    if (!raf && !gate && queue.length) raf = requestAnimationFrame(pump);
  }
  return {
    /** 轉場開始前呼叫：之後 defer 的工作要等 release() 之後才開始跑。 */
    hold: function() {
      var token = {};
      gate = token;
      return function release() {
        if (gate !== token) return;
        gate = null;
        kick();
      };
    },
    defer: function(fn) {
      if (!gate) { fn(); return; }
      queue.push(fn);
    },
    pending: function() { return queue.length + (gate ? 1 : 0); },
  };
})();

var PAGE_NAV_ORDER = ['settlement', 'bookkeeping', 'overview', 'settings'];

function getPageNavIndex(page) {
  var key = (page === 'creditcard') ? 'settlement'
    : (page === 'search') ? SearchPage.getOrigin()
    : (page === 'foreign') ? 'bookkeeping'
    : page;
  return PAGE_NAV_ORDER.indexOf(key);
}

function getPageTransitionDir(fromPage, toPage) {
  if (!fromPage || fromPage === toPage) return '';
  var isSubPage = function(p) { return p === 'creditcard' || p === 'search' || p === 'foreign'; };
  if (isSubPage(toPage)) return 'forward';
  var fromIdx = getPageNavIndex(fromPage);
  var toIdx = getPageNavIndex(toPage);
  if (isSubPage(fromPage) && fromIdx === toIdx) return 'back';
  if (fromIdx === toIdx) return 'forward';
  return toIdx > fromIdx ? 'forward' : 'back';
}

function playPageEnterFallback(page, dir) {
  var el = document.querySelector('.page-container.active');
  if (!el) return;
  clearTimeout(el._pageEnterTimer);
  el.classList.remove('page-enter-forward', 'page-enter-back');
  void el.offsetWidth;
  el.classList.add(dir === 'back' ? 'page-enter-back' : 'page-enter-forward');
  Motion.revealPageCards(el);
  el._pageEnterTimer = setTimeout(function() {
    el.classList.remove('page-enter-forward', 'page-enter-back');
  }, Motion.dur('slow') + 80);
}

function bounceActiveNavIcon() {
  var icon = document.querySelector('.nav-item.active .nav-icon');
  if (!icon) return;
  Motion.animate(icon, {
    full: [
      { transform: 'scale(1.1) translateY(0)', easing: Motion.ease('out') },
      { transform: 'scale(1.22) translateY(-3px)', offset: 0.4, easing: Motion.ease('spring') },
      { transform: 'scale(1.1) translateY(0)' }
    ]
  }, { duration: Motion.dur('slow') });
}

function switchPage(page) {
  var fromPage = document.body.dataset.page || 'bookkeeping';
  var dir = getPageTransitionDir(fromPage, page);
  var level = Motion.level();
  var nav = document.getElementById('bottomNav');
  var useViewTransition = Boolean(dir) && level !== 'off' && page !== 'search' &&
    typeof document.startViewTransition === 'function';

  if (useViewTransition) {
    var leaving = document.querySelector('.page-container.active');
    document.querySelectorAll('.page-container.vt-page-leaving').forEach(function(p) { p.classList.remove('vt-page-leaving'); });
    if (leaving) leaving.classList.add('vt-page-leaving');
    var release = PageWork.hold();
    var transition = Motion.viewTransition(function() {
      applyPageSwitch(page);
    }, level === 'full' ? 'page-' + dir : 'page-fade');
    var settle = function() {
      if (leaving && !leaving.classList.contains('active')) leaving.classList.remove('vt-page-leaving');
      if (nav) nav.classList.remove('pill-instant');
      bounceActiveNavIcon();
    };
    if (transition) {
      // 動畫一開始（ready）就放行重工作；轉場失敗或被跳過時，最晚在 update callback 完成後放行
      transition.ready.then(release, function() {
        Promise.resolve(transition.updateCallbackDone).then(release, release);
      });
      transition.finished.then(settle, settle);
    } else {
      release();
      settle();
    }
    return;
  }

  applyPageSwitch(page);
  if (dir && level !== 'off') playPageEnterFallback(page, dir);
  if (dir) bounceActiveNavIcon();
}

// 先做完所有寫入（切 class、輕量渲染），最後才讀排版（導覽列指示器的位置、捲回頂端），整個切換只排版一次。
function applyPageSwitch(page) {
  var navPageKey = (page === 'creditcard') ? 'settlement'
    : (page === 'search') ? SearchPage.getOrigin()
    : (page === 'foreign') ? 'bookkeeping'
    : page;
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  var activeNav = document.querySelector('.nav-item[data-page="' + navPageKey + '"]');
  if (activeNav) activeNav.classList.add('active');

  document.querySelectorAll('.page-container').forEach(function(p) { p.classList.remove('active'); });
  var pageMap = {
    'bookkeeping': 'pageBookkeeping',
    'overview': 'pageOverview',
    'settlement': 'pageSettlement',
    'creditcard': 'pageCreditCard',
    'search': 'pageSearch',
    'foreign': 'pageForeign',
    'settings': 'pageSettings',
  };
  var targetPage = document.getElementById(pageMap[page] || 'pageBookkeeping');
  if (targetPage) targetPage.classList.add('active');

  document.body.dataset.page = page;
  Motion.cancelScroll();
  document.querySelectorAll('.head, .overview-head, .settlement-head, .settings-head, .cc-head, .fx-head').forEach(function(h) { h.classList.remove('head-hidden'); });
  closeCalendar('expense');
  closeCalendar('income');
  closeCalendar('st');
  if (page === 'foreign') {
    ForeignPage.onEnter();
  } else {
    ForeignPage.onLeave();
  }

  if (page === 'overview' && !overviewLoaded) {
    loadOverview(false, { defer: PageWork.defer });
  }
  if (page === 'settlement' && !settlementLoaded) {
    loadSettlement(false);
  }
  if (page === 'creditcard') {
    openCreditCardReconciliation();
  }
  if (page === 'search') {
    SearchPage.onEnter();
  } else {
    SearchPage.onLeave();
  }
  if (page === 'settings' && !settingsLoaded) {
    loadSettings(false, { defer: PageWork.defer });
    settingsLoaded = true;
  }

  updateNavPill();
  window.scrollTo({ top: 0 });
}
