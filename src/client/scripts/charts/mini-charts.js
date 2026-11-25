const MiniCharts = (function() {
  const tracked = new Set();
  let resizeObserver = null;
  let docListenerBound = false;

  function reducedMotion() {
    return Motion.level() !== 'full';
  }

  function fmtCompact(n) {
    const abs = Math.abs(Number(n) || 0);
    const sign = n < 0 ? '-' : '';
    const short = v => String(v >= 10 ? Math.round(v) : Math.round(v * 10) / 10);
    if (abs >= 1e6) return sign + short(abs / 1e6) + 'M';
    if (abs >= 1e3) return sign + short(abs / 1e3) + 'k';
    return sign + Math.round(abs);
  }

  /** 刻度一律包含 0；min 是負的時候往下延伸（累計餘額可能是負的）。 */
  function niceScale(max, min) {
    const low = min < 0 ? min : 0;
    if (!(max > 0) && !low) return { min: 0, max: 100, ticks: [0, 50, 100] };
    const raw = (Math.max(0, max) - low) / 3;
    const pow = Math.pow(10, Math.floor(Math.log10(raw)));
    const f = raw / pow;
    const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
    const step = nice * pow;
    const top = Math.ceil(Math.max(0, max) / step - 1e-9) * step;
    // 負的部分很小時只往下留一點空間，不為了它多畫一整格
    const bottom = !low ? 0 : (-low < step / 2 ? low - step * 0.06 : Math.floor(low / step + 1e-9) * step);
    const ticks = [];
    for (let v = Math.ceil(bottom / step - 1e-9) * step; v <= top + step / 2; v += step) ticks.push(Math.round(v * 100) / 100 || 0);
    return { min: bottom, max: top, ticks: ticks };
  }

  function r1(v) { return Math.round(v * 10) / 10; }

  function barPath(x, y, w, h) {
    const r = Math.max(0, Math.min(4, w / 2, h));
    return 'M' + r1(x) + ',' + r1(y + h) +
      'V' + r1(y + r) +
      'Q' + r1(x) + ',' + r1(y) + ' ' + r1(x + r) + ',' + r1(y) +
      'H' + r1(x + w - r) +
      'Q' + r1(x + w) + ',' + r1(y) + ' ' + r1(x + w) + ',' + r1(y + r) +
      'V' + r1(y + h) + 'Z';
  }

  function xTickIndexes(n, step) {
    const all = [];
    for (let i = 0; i < n; i++) all.push(i);
    if (n <= 8 || step >= 22) return all;
    const days = step >= 7 ? [1, 5, 10, 15, 20, 25] : [1, 10, 20];
    const picks = days.filter(d => d <= n - 2).map(d => d - 1);
    picks.push(n - 1);
    return picks;
  }

  function measure(el) {
    const w = Math.round(el.clientWidth);
    el.__mcWidth = w;
    return w > 0 ? w : 320;
  }

  function getResizeObserver() {
    if (resizeObserver || typeof ResizeObserver === 'undefined') return resizeObserver;
    resizeObserver = new ResizeObserver(entries => {
      entries.forEach(entry => {
        const el = entry.target;
        if (!el.isConnected || typeof el.__mcRender !== 'function') return;
        const w = Math.round(el.clientWidth);
        if (w > 0 && Math.abs(w - (el.__mcWidth || 0)) >= 4) el.__mcRender();
      });
    });
    return resizeObserver;
  }

  function bindDocListener() {
    if (docListenerBound) return;
    docListenerBound = true;
    document.addEventListener('pointerdown', e => {
      tracked.forEach(el => {
        if (typeof el.__mcHide === 'function' && !el.contains(e.target)) el.__mcHide();
      });
    }, { passive: true });
  }

  function track(el, renderFn) {
    el.__mcRender = renderFn;
    if (!tracked.has(el)) {
      tracked.add(el);
      const observer = getResizeObserver();
      if (observer) observer.observe(el);
    }
    bindDocListener();
  }

  function releaseDetached() {
    tracked.forEach(el => {
      if (el.isConnected) return;
      if (resizeObserver) resizeObserver.unobserve(el);
      el.__mcRender = null;
      el.__mcHide = null;
      tracked.delete(el);
    });
  }

  function svgOpen(W, H, cfg, animate, extraClass) {
    return '<svg class="mc-svg' + (extraClass ? ' ' + extraClass : '') + (animate ? ' mc-anim' : '') + '"' +
      ' viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="' + escAttr(cfg.ariaLabel || '') + '">';
  }

  function gridAndYAxis(scale, x1, x2, y) {
    let s = '';
    scale.ticks.forEach(t => {
      const ty = r1(y(t));
      s += '<line class="mc-grid' + (t === 0 ? ' is-base' : '') + '" x1="' + x1 + '" x2="' + x2 + '" y1="' + ty + '" y2="' + ty + '"/>';
      s += '<text class="mc-axis-text" x="' + (x1 - 6) + '" y="' + (ty + 3.5) + '" text-anchor="end">' + escHtml(fmtCompact(t)) + '</text>';
    });
    return s;
  }

  function xLabels(cfg, layout, highlightIndex) {
    let s = '';
    // tickMinPx：從最後一格往前每隔幾格標一個（月份軸）；沒給時是一個月裡的日期（1、5、10…）
    const every = cfg.tickMinPx ? Math.max(1, Math.ceil(cfg.tickMinPx / layout.step)) : 0;
    const ticks = every
      ? cfg.labels.map((_, i) => i).filter(i => (layout.n - 1 - i) % every === 0)
      : xTickIndexes(layout.n, layout.step);
    ticks.forEach(i => {
      s += '<text class="mc-axis-text mc-x-text' + (i === highlightIndex ? ' is-highlight' : '') + '"' +
        ' x="' + r1(layout.padL + layout.step * (i + 0.5)) + '" y="' + (layout.H - 6) + '" text-anchor="middle">' +
        escHtml(cfg.labels[i]) + '</text>';
    });
    return s;
  }

  function computeLayout(el, cfg, maxValue, padTop, minValue) {
    const W = measure(el);
    const H = cfg.height || 190;
    const n = cfg.labels.length;
    const scale = niceScale(maxValue, minValue);
    const yLabelW = Math.max.apply(null, scale.ticks.map(t => fmtCompact(t).length)) * 6.2 + 4;
    const padL = Math.round(yLabelW + 8);
    const padR = 6;
    const padT = padTop;
    const padB = 22;
    const plotW = Math.max(10, W - padL - padR);
    const plotH = H - padT - padB;
    const step = plotW / Math.max(1, n);
    const baseY = padT + plotH;
    const y = v => baseY - ((Math.max(scale.min, v) - scale.min) / (scale.max - scale.min)) * plotH;
    return { W, H, n, scale, padL, padR, padT, padB, plotW, plotH, step, baseY, y };
  }

  function indexFromEvent(svg, evt, layout) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return -1;
    const x = (evt.clientX - rect.left) * (layout.W / rect.width);
    const i = Math.floor((x - layout.padL) / layout.step);
    return Math.max(0, Math.min(layout.n - 1, i));
  }

  function placeTooltip(el, tip, html, xUnits, yUnits, layout) {
    tip.innerHTML = html;
    tip.hidden = false;
    const k = el.clientWidth ? el.clientWidth / layout.W : 1;
    const x = xUnits * k;
    const y = yUnits * k;
    const cw = el.clientWidth;
    const tw = tip.offsetWidth;
    const th = tip.offsetHeight;
    let left = Math.max(2, Math.min(cw - tw - 2, x - tw / 2));
    const rect = el.getBoundingClientRect();
    const vw = window.innerWidth || document.documentElement.clientWidth;
    if (rect.left + left < 4) left = 4 - rect.left;
    if (rect.left + left + tw > vw - 4) left = vw - 4 - tw - rect.left;
    let top = y - th - 10;
    if (top < -8 || rect.top + top < 4) top = y + 12;
    tip.style.transform = 'translate(' + Math.round(left) + 'px,' + Math.round(top) + 'px)';
  }

  function bindPointer(el, svg, layout, handlers) {
    let active = false;
    let moved = false;
    let startIdx = -1;
    let wasSelected = false;

    svg.addEventListener('pointerdown', e => {
      if (e.button > 0) return;
      const i = indexFromEvent(svg, e, layout);
      if (i < 0) return;
      active = true;
      moved = false;
      startIdx = i;
      if (handlers.mode === 'pick') return;
      wasSelected = el.__mcSelected === i;
      if (e.pointerType !== 'mouse') {
        try { svg.setPointerCapture(e.pointerId); } catch (err) {}
      }
      handlers.select(i);
    });
    svg.addEventListener('pointermove', e => {
      if (!active || handlers.mode === 'pick') return;
      if (e.pointerType === 'mouse' && !(e.buttons & 1)) return;
      const i = indexFromEvent(svg, e, layout);
      if (i >= 0 && i !== el.__mcSelected) {
        moved = true;
        handlers.select(i);
      }
    });
    svg.addEventListener('pointerup', e => {
      if (!active) return;
      active = false;
      const i = indexFromEvent(svg, e, layout);
      if (handlers.mode === 'pick') {
        if (i === startIdx && typeof handlers.onPick === 'function') handlers.onPick(i);
        return;
      }
      if (!moved && wasSelected && i === startIdx) handlers.clear();
    });
    svg.addEventListener('pointercancel', () => { active = false; });
  }

  function bars(el, cfg) {
    const draw = animate => {
      const series = cfg.series || [];
      const n = cfg.labels.length;
      const emptyFrom = cfg.emptyFrom == null ? n : cfg.emptyFrom;
      const hl = cfg.highlightIndex == null ? -1 : cfg.highlightIndex;
      let max = 0;
      series.forEach(ser => ser.values.forEach((v, i) => { if (i < emptyFrom && v > max) max = v; }));
      if (cfg.avg > max) max = cfg.avg;
      const L = computeLayout(el, cfg, max, cfg.valueLabels ? 22 : 14);

      let s = svgOpen(L.W, L.H, cfg, animate, cfg.onPick ? 'mc-pickable' : 'mc-scrub');
      if (cfg.band && hl >= 0) {
        s += '<rect class="mc-band" x="' + r1(L.padL + L.step * hl + 1) + '" y="2" width="' + r1(Math.max(0, L.step - 2)) +
          '" height="' + r1(L.baseY - 2) + '" rx="8"/>';
      }
      s += gridAndYAxis(L.scale, L.padL, L.W - L.padR, L.y);

      const groupW = L.step * (series.length > 1 ? 0.72 : 0.66);
      const gap = series.length > 1 ? Math.min(3, groupW * 0.1) : 0;
      const barW = Math.max(1.5, (groupW - gap * (series.length - 1)) / Math.max(1, series.length));
      const groupTops = [];

      for (let i = 0; i < n; i++) {
        const x0 = L.padL + L.step * i + (L.step - groupW) / 2;
        groupTops[i] = L.baseY;
        if (i >= emptyFrom) {
          s += '<rect class="mc-future" x="' + r1(x0) + '" y="' + r1(L.baseY - 2) + '" width="' + r1(groupW) + '" height="2" rx="1"/>';
          continue;
        }
        s += '<g class="mc-group' + (i === hl ? ' is-highlight' : '') + (hl >= 0 && i !== hl && cfg.band ? ' is-dim' : '') +
          '" data-i="' + i + '" style="--i:' + i + '">';
        series.forEach((ser, k) => {
          const v = Number(ser.values[i]) || 0;
          if (v <= 0) return;
          const top = L.y(v);
          groupTops[i] = Math.min(groupTops[i], top);
          s += '<path class="mc-bar ' + (ser.className || '') + '" d="' + barPath(x0 + k * (barW + gap), top, barW, L.baseY - top) + '"/>';
        });
        s += '</g>';
        const vl = cfg.valueLabels && cfg.valueLabels[i];
        if (vl && vl.text) {
          s += '<text class="mc-value-text ' + (vl.className || '') + '" x="' + r1(L.padL + L.step * (i + 0.5)) +
            '" y="' + r1(groupTops[i] - 5) + '" text-anchor="middle">' + escHtml(vl.text) + '</text>';
        }
      }

      if (cfg.avg > 0) {
        const ay = r1(L.y(cfg.avg));
        s += '<line class="mc-avg" x1="' + L.padL + '" x2="' + (L.W - L.padR) + '" y1="' + ay + '" y2="' + ay + '"/>';
        s += '<text class="mc-avg-text" x="' + (L.W - L.padR) + '" y="' + (ay - 5) + '" text-anchor="end">' + escHtml(cfg.avgLabel || '') + '</text>';
      }
      s += xLabels(cfg, L, hl);
      s += '</svg><div class="mc-tooltip" aria-live="polite" hidden></div>';
      el.innerHTML = s;

      const svg = el.querySelector('svg');
      const tip = el.querySelector('.mc-tooltip');
      el.__mcSelected = -1;
      const clear = () => {
        el.__mcSelected = -1;
        tip.hidden = true;
        svg.querySelectorAll('.mc-group.is-selected').forEach(g => g.classList.remove('is-selected'));
      };
      const select = i => {
        if (i >= emptyFrom || typeof cfg.tooltip !== 'function') { clear(); return; }
        el.__mcSelected = i;
        svg.querySelectorAll('.mc-group.is-selected').forEach(g => g.classList.remove('is-selected'));
        const g = svg.querySelector('.mc-group[data-i="' + i + '"]');
        if (g) g.classList.add('is-selected');
        placeTooltip(el, tip, cfg.tooltip(i), L.padL + L.step * (i + 0.5), groupTops[i], L);
      };
      el.__mcHide = clear;
      bindPointer(el, svg, L, { mode: cfg.onPick ? 'pick' : 'scrub', select, clear, onPick: cfg.onPick });
    };
    track(el, () => draw(false));
    draw(Boolean(cfg.animate) && !reducedMotion());
  }

  /* 折線圖。選項（預設值維持原本的樣子）：
   *   negative  允許負值：y 軸往下延伸，0 的那條線仍是基準線
   *   endDots   每條線最後一點畫一個圓點
   *   reveal    線條另外放在 .mc-reveal 裁切窗裡，進場時由左往右揭開——裁切窗與內容往相反方向 translate，
   *             線條看起來不動、只有可見範圍變大，全程只動 transform（合成器執行，不重繪 SVG）。
   *             沒有 reveal 時是原本的 stroke-dashoffset 描線。 */
  function lines(el, cfg) {
    const draw = animate => {
      const series = cfg.series || [];
      let max = 0;
      let min = 0;
      series.forEach(ser => ser.values.forEach(v => {
        if (v == null) return;
        if (v > max) max = v;
        if (cfg.negative && v < min) min = v;
      }));
      const L = computeLayout(el, cfg, max, 14, min);
      const px = i => L.padL + L.step * (i + 0.5);
      const zeroY = r1(L.y(0));

      let marks = '';
      series.slice().reverse().forEach((ser, revIdx) => {
        const isPrimary = revIdx === series.length - 1;
        let d = '';
        let first = -1;
        let last = -1;
        ser.values.forEach((v, i) => {
          if (v == null) return;
          d += (last === i - 1 && last >= 0 ? 'L' : 'M') + r1(px(i)) + ',' + r1(L.y(v));
          if (first < 0) first = i;
          last = i;
        });
        if (!d) return;
        if (ser.area && first >= 0) {
          marks += '<path class="mc-area ' + (ser.className || '') + '" d="' + d + 'L' + r1(px(last)) + ',' + zeroY + 'L' + r1(px(first)) + ',' + zeroY + 'Z"/>';
        }
        marks += '<path class="mc-line ' + (ser.className || '') + '" d="' + d + '"' + (isPrimary && !cfg.reveal ? ' pathLength="1"' : '') + '/>';
        if (cfg.endDots) {
          marks += '<circle class="mc-dot ' + (ser.className || '') + '" cx="' + r1(px(last)) + '" cy="' + r1(L.y(ser.values[last])) + '" r="4"/>';
        }
      });

      let s = svgOpen(L.W, L.H, cfg, animate && !cfg.reveal, 'mc-scrub');
      s += gridAndYAxis(L.scale, L.padL, L.W - L.padR, L.y);
      const cursorLayer = '<g class="mc-cursor"></g>';
      if (!cfg.reveal) s += marks + cursorLayer;
      s += xLabels(cfg, L, cfg.highlightIndex == null ? -1 : cfg.highlightIndex);
      s += '</svg>';
      if (cfg.reveal) {
        const layer = inner => '<svg class="mc-svg" viewBox="0 0 ' + L.W + ' ' + L.H + '" aria-hidden="true">' + inner + '</svg>';
        s += '<div class="mc-reveal' + (animate ? ' is-playing' : '') + '"><div class="mc-reveal-in">' + layer(marks) + '</div></div>' +
          '<div class="mc-overlay">' + layer(cursorLayer) + '</div>';
      }
      s += '<div class="mc-tooltip" aria-live="polite" hidden></div>';
      el.innerHTML = s;

      const svg = el.querySelector('svg');
      const tip = el.querySelector('.mc-tooltip');
      const cursor = el.querySelector('.mc-cursor');
      el.__mcSelected = -1;
      const clear = () => {
        el.__mcSelected = -1;
        tip.hidden = true;
        cursor.innerHTML = '';
      };
      const select = i => {
        const points = series.map(ser => ser.values[i]).filter(v => v != null);
        if (!points.length || typeof cfg.tooltip !== 'function') { clear(); return; }
        el.__mcSelected = i;
        const x = r1(px(i));
        let c = '<line class="mc-cursor-line" x1="' + x + '" x2="' + x + '" y1="' + L.padT + '" y2="' + L.baseY + '"/>';
        series.forEach(ser => {
          const v = ser.values[i];
          if (v != null) c += '<circle class="mc-dot ' + (ser.className || '') + '" cx="' + x + '" cy="' + r1(L.y(v)) + '" r="3.5"/>';
        });
        cursor.innerHTML = c;
        placeTooltip(el, tip, cfg.tooltip(i), px(i), L.y(Math.max.apply(null, points)), L);
      };
      el.__mcHide = clear;
      bindPointer(el, svg, L, { mode: 'scrub', select, clear });
    };
    track(el, () => draw(false));
    draw(Boolean(cfg.animate) && !reducedMotion());
  }

  function donut(el, cfg) {
    const R = 72;
    const SW = 26;
    const C = 2 * Math.PI * R;
    const slices = cfg.slices || [];
    const total = slices.reduce((a, sl) => a + Math.max(0, sl.value), 0);
    const gap = slices.length > 1 ? 1.6 : 0;
    const animate = Boolean(cfg.animate) && !reducedMotion();

    let s = svgOpen(200, 200, cfg, animate, 'mc-donut');
    s += '<circle class="mc-track" cx="100" cy="100" r="' + R + '" fill="none" stroke-width="' + SW + '"/>';
    s += '<g transform="rotate(-90 100 100)">';
    let acc = 0;
    slices.forEach((sl, i) => {
      const len = total > 0 ? Math.max(0, sl.value) / total * C : 0;
      const drawLen = Math.max(0.6, len - gap);
      const mid = (acc + len / 2) / C * Math.PI * 2;
      const style = 'stroke-dasharray:' + r1(drawLen) + ' ' + r1(C - drawLen) + ';stroke-dashoffset:' + r1(-acc) +
        ';--mc-c:' + r1(C) + ';--dx:' + r1(Math.cos(mid) * 6) + 'px;--dy:' + r1(Math.sin(mid) * 6) + 'px' +
        ';--mc-delay:' + Math.round(acc / C * 400) + 'ms;--mc-dur:' + Math.max(60, Math.round(len / C * 400)) + 'ms';
      s += '<circle class="mc-slice ' + (sl.className || '') + '" data-i="' + i + '" cx="100" cy="100" r="' + R +
        '" fill="none" stroke-width="' + SW + '" style="' + style + '"/>';
      acc += len;
    });
    s += '</g>';
    s += '<text class="mc-center-main" x="100" y="100" text-anchor="middle"></text>';
    s += '<text class="mc-center-sub" x="100" y="121" text-anchor="middle"></text>';
    s += '</svg>';
    el.innerHTML = s;

    const svg = el.querySelector('svg');
    const mainEl = svg.querySelector('.mc-center-main');
    const subEl = svg.querySelector('.mc-center-sub');
    const setCenter = c => {
      const main = (c && c.main) || '';
      mainEl.textContent = main;
      mainEl.style.fontSize = (main.length > 10 ? 15 : main.length > 8 ? 18 : 21) + 'px';
      subEl.textContent = (c && c.sub) || '';
    };
    setCenter(cfg.center);

    svg.addEventListener('click', e => {
      const slice = e.target.closest('.mc-slice');
      if (slice && typeof cfg.onSlice === 'function') cfg.onSlice(Number(slice.dataset.i));
    });

    return {
      setFocus: function(i) {
        const has = i != null && i >= 0;
        svg.classList.toggle('has-focus', has);
        svg.querySelectorAll('.mc-slice').forEach(c => c.classList.toggle('is-focus', has && Number(c.dataset.i) === i));
        setCenter(has && typeof cfg.centerFor === 'function' ? cfg.centerFor(i) : cfg.center);
      }
    };
  }

  return { donut, bars, lines, releaseDetached, fmtCompact };
})();
