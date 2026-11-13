const ThemeManager = {
  getSystemTheme: function() {
    try {
      if (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches) {
        return 'dark';
      }
    } catch (e) {}
    return 'light';
  },

  getCurrentTheme: function() {
    return document.documentElement.getAttribute('data-theme') || this.getSystemTheme();
  },

  applyTheme: function(theme) {
    const isDark = theme === 'dark';
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');

    const themeColor = isDark ? '#000000' : '#faf6ef';
    const metaList = document.querySelectorAll('meta[name="theme-color"]');
    if (metaList && metaList.length > 0) {
      metaList.forEach(m => m.setAttribute('content', themeColor));
    }
  },

  init: function() {
    try {
      localStorage.removeItem('theme');
    } catch (e) {}

    this.applyTheme(this.getSystemTheme());

    try {
      if (window.matchMedia) {
        const mql = window.matchMedia('(prefers-color-scheme: dark)');
        const handleChange = (e) => {
          const newTheme = e.matches ? 'dark' : 'light';
          this.applyTheme(newTheme);
        };

        if (mql.addEventListener) {
          mql.addEventListener('change', handleChange);
        } else if (mql.addListener) {
          mql.addListener(handleChange);
        }
      }
    } catch (e) {
      console.warn('Theme matchMedia listener error:', e);
    }
  },

  toggle: function(btn) {
    const current = this.getCurrentTheme();
    const nextTheme = current === 'dark' ? 'light' : 'dark';
    const apply = () => {
      this.applyTheme(nextTheme);
      showToast(nextTheme === 'dark' ? '已切換為深色模式' : '已切換為淺色模式', 'success');
    };
    const level = Motion.level();
    if (level === 'off') {
      apply();
      return;
    }

    if (typeof document.startViewTransition === 'function') {
      const isCircle = level === 'full' && btn && btn.isConnected;
      if (isCircle) btn.style.viewTransitionName = 'theme-toggle';
      const transition = Motion.viewTransition(apply, isCircle ? 'theme-circle' : 'theme-fade');
      if (!transition) {
        if (btn) btn.style.viewTransitionName = '';
        return;
      }
      if (isCircle) {
        const rect = btn.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const radius = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
        transition.ready.then(() => {
          document.documentElement.animate(
            { clipPath: ['circle(0px at ' + x + 'px ' + y + 'px)', 'circle(' + radius + 'px at ' + x + 'px ' + y + 'px)'] },
            { duration: 500, easing: Motion.ease('in-out'), pseudoElement: '::view-transition-new(root)' }
          );
        }).catch(() => {});
      }
      const cleanup = () => { if (btn) btn.style.viewTransitionName = ''; };
      transition.finished.then(cleanup, cleanup);
      return;
    }

    const body = document.body;
    Motion.animate(body, [{ opacity: 1 }, { opacity: 0.2 }], { duration: Motion.dur('fast'), easing: 'ease-in', fill: 'forwards' })
      .then(anim => {
        apply();
        if (anim && anim.cancel) anim.cancel();
        Motion.animate(body, [{ opacity: 0.2 }, { opacity: 1 }], { duration: Motion.dur('base'), easing: 'ease-out' });
      });
  }
};

ThemeManager.init();
