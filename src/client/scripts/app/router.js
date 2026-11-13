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
    var transition = Motion.viewTransition(function() {
      applyPageSwitch(page);
    }, level === 'full' ? 'page-' + dir : 'page-fade');
    var settle = function() {
      if (leaving && !leaving.classList.contains('active')) leaving.classList.remove('vt-page-leaving');
      if (nav) nav.classList.remove('pill-instant');
      bounceActiveNavIcon();
    };
    if (transition) transition.finished.then(settle, settle);
    else settle();
    return;
  }

  applyPageSwitch(page);
  if (dir && level !== 'off') playPageEnterFallback(page, dir);
  if (dir) bounceActiveNavIcon();
}

function applyPageSwitch(page) {
  var navPageKey = (page === 'creditcard') ? 'settlement'
    : (page === 'search') ? SearchPage.getOrigin()
    : (page === 'foreign') ? 'bookkeeping'
    : page;
  document.querySelectorAll('.nav-item').forEach(function(n) { n.classList.remove('active'); });
  var activeNav = document.querySelector('.nav-item[data-page="' + navPageKey + '"]');
  if (activeNav) activeNav.classList.add('active');
  updateNavPill();

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
  window.scrollTo({ top: 0 });
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
    loadOverview(false);
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
    loadSettings(false);
    settingsLoaded = true;
  }
}
