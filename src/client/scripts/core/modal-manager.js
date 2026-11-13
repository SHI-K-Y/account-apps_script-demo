const ModalManager = {
  registry: new Map(),

  register(id, options) {
    this.registry.set(id, options);
  },

  isBusy(id) {
    if (document.body.classList.contains('busy')) return true;
    const config = this.registry.get(id);
    if (!config) return false;
    if (typeof config.busy === 'function') {
      try { return Boolean(config.busy()); } catch (e) { return false; }
    }
    if (typeof config.busy === 'string') {
      const btn = document.getElementById(config.busy);
      if (btn && btn.disabled) return true;
    }
    return false;
  },

  close(id) {
    const el = document.getElementById(id);
    if (!el || !el.classList.contains('show')) return false;
    if (this.isBusy(id)) return false;

    const config = this.registry.get(id);
    if (config && typeof config.close === 'function') {
      config.close();
      return true;
    }
    closeModal(el);
    return true;
  },

  handleEscape() {
    const entries = Array.from(this.registry.entries()).reverse();
    for (const [id, config] of entries) {
      const el = document.getElementById(id);
      if (el && el.classList.contains('show')) {
        if (this.isBusy(id)) {
          return false;
        }
        if (config && typeof config.close === 'function') {
          config.close();
          return true;
        }
      }
    }
    return false;
  }
};
