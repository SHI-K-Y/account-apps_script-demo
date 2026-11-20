// 清單的增量更新（P06）：以 key 比對新舊清單，只新增、移除、移動有變化的節點。
//
//   ListRender.reconcile(container, items, {
//     key(item, i)      每筆的識別（例如「月份｜類型｜列號」或 tempId）；重複的 key 會自動加上序號
//     內容比對（二選一）：
//       sig(item, i, ident)  內容簽章字串：和節點上次的簽章相同就完全不動
//       same(el, item)       直接比對欄位（不組字串，最省）：回傳 true 表示節點內容已經是這一筆，不必更新
//     ident(item)       （選用）內容識別字串：key 對不上時，用它把「只是列號位移」的舊節點認回來
//                       （紀錄沒有固定 ID，刪除一筆後下方的列號會往上遞補；有 ident 才不會整段重建）。
//                       只對 key 對不上的那幾筆才計算。
//     identEq(el, item) （選用）key 對上時確認節點顯示的是不是同一筆內容（直接比對欄位）；沒給時比 ident 字串
//     create(item, i, ident)  建立節點；或改給 html(item, i) 回傳單一根元素的 HTML 字串
//     update(el, item, i, ident)  （選用）內容改變時就地更新；沒給時直接換成新節點
//     place(el, item, i)   （選用）每次都會呼叫的輕量處理（例如把最新的 record 掛回節點）
//     empty             清單為空時顯示的 HTML（字串）
//     chunk             （選用）{ threshold: 300, first: 50, step: 50, listId }：超過 threshold 筆時先畫 first 筆，
//                       捲動接近底部再每次補 step 筆；listId 改變時重新從 first 開始
//   })
//   → { created: [新節點…], removed: 數量, kept: 數量, total: 實際畫出的筆數 }
//
// 節點上記著它目前顯示的那一筆（el._lrItem），identEq／same 用它和新資料比對。
// 呼叫端用 created 決定進場動畫只播給「新出現」的節點；沿用的節點不重播。
// 被刪除動畫抓走的節點（markLeaving）不會被重複利用，讓 collapseOut 播的一定是被刪掉的那一筆。
const ListRender = (() => {
  const CHUNK_DEFAULT = { threshold: 300, first: 50, step: 50 };
  let tpl = null;

  function fromHtml(html) {
    if (!tpl) tpl = document.createElement('template');
    tpl.innerHTML = html;
    const el = tpl.content.firstElementChild;
    if (el) el.remove();
    tpl.innerHTML = '';
    return el;
  }

  function makeNode(opts, item, i, ident) {
    if (opts.create) return opts.create(item, i, ident);
    return fromHtml(opts.html(item, i));
  }

  /**
   * 同一段 HTML（例如項目圖示＋名稱）重複出現時，只解析一次，之後複製 DocumentFragment。
   * 快取有上限，超過就整個清掉重來（搜尋高亮之類每列都不同的字串不會讓它無限長大）。
   */
  const fragCache = new Map();
  const FRAG_CACHE_MAX = 300;
  function fragment(html) {
    let tplEl = fragCache.get(html);
    if (!tplEl) {
      if (fragCache.size >= FRAG_CACHE_MAX) fragCache.clear();
      tplEl = document.createElement('template');
      tplEl.innerHTML = html;
      fragCache.set(html, tplEl);
    }
    return tplEl.content.cloneNode(true);
  }

  /** 刪除動畫抓住的節點：接下來的 reconcile 不會再拿它來顯示別筆紀錄。 */
  function markLeaving(el) {
    if (el) el._lrLeaving = true;
  }

  function uniqueKeys(items, keyFn) {
    const keys = items.map((item, i) => String(keyFn(item, i)));
    const seen = new Set(keys);
    if (seen.size === keys.length) return keys;   // 一般情況：沒有重複，不必再加序號
    const count = new Map();
    return keys.map(base => {
      const n = count.get(base) || 0;
      count.set(base, n + 1);
      return n ? base + '#' + n : base;
    });
  }

  function chunkLimit(container, total, chunk) {
    if (!chunk) return total;
    const c = Object.assign({}, CHUNK_DEFAULT, chunk);
    if (total <= c.threshold) {
      container._lrChunk = null;
      return total;
    }
    const prev = container._lrChunk;
    const id = c.listId == null ? '' : String(c.listId);
    const shown = prev && prev.id === id ? Math.max(prev.shown, c.first) : c.first;
    container._lrChunk = { id: id, shown: Math.min(total, shown), step: c.step };
    return container._lrChunk.shown;
  }

  /** 分段渲染的哨兵放在容器後面（不是子節點），清單本身的 :first-child、children 索引都不受影響。 */
  function syncSentinel(container, hasMore) {
    let s = container._lrSentinel;
    if (!hasMore) {
      if (s) {
        if (container._lrObserver) container._lrObserver.disconnect();
        s.remove();
        container._lrSentinel = null;
      }
      return;
    }
    if (!s) {
      s = document.createElement('div');
      s.className = 'lr-sentinel';
      s.setAttribute('aria-hidden', 'true');
      container._lrSentinel = s;
    }
    if (s.previousSibling !== container || !s.isConnected) container.after(s);
    if (typeof IntersectionObserver !== 'function') {
      // 沒有 IntersectionObserver：下一幀直接補完
      requestAnimationFrame(() => more(container, Infinity));
      return;
    }
    if (!container._lrObserver) {
      container._lrObserver = new IntersectionObserver(entries => {
        if (entries.some(e => e.isIntersecting)) more(container);
      }, { rootMargin: '0px 0px 800px 0px' });
    }
    container._lrObserver.disconnect();
    container._lrObserver.observe(s);
  }

  function more(container, count) {
    const c = container._lrChunk;
    const last = container._lrLast;
    if (!c || !last || !container.isConnected) return;
    c.shown = Math.min(last.items.length, c.shown + (count || c.step));
    reconcile(container, last.items, last.opts, true);
  }

  function reconcile(container, items, opts, fromChunk) {
    const list = Array.isArray(items) ? items : [];
    const o = opts || {};
    const out = { created: [], removed: 0, kept: 0, total: 0 };
    if (!container) return out;
    container._lrLast = { items: list, opts: o };

    if (!list.length) {
      container._lrChunk = null;
      syncSentinel(container, false);
      const html = o.empty || '';
      const node = container.firstElementChild;
      if (!(container.children.length === 1 && node && node._lrEmpty === html)) {
        out.removed = container.children.length;
        container.innerHTML = html;
        if (container.firstElementChild) container.firstElementChild._lrEmpty = html;
      }
      return out;
    }

    const limit = fromChunk ? Math.min(list.length, container._lrChunk ? container._lrChunk.shown : list.length)
      : chunkLimit(container, list.length, o.chunk);
    const shown = limit < list.length ? list.slice(0, limit) : list;
    const keys = uniqueKeys(shown, o.key);
    const n = shown.length;
    const hasIdent = typeof o.ident === 'function';
    // ident 字串只在需要時才算（多數重繪 key 都對得上，用不到）
    const itemIdents = hasIdent ? new Array(n) : null;
    const identOfItem = i => (itemIdents[i] === undefined ? (itemIdents[i] = String(o.ident(shown[i]))) : itemIdents[i]);
    const identOfEl = el => (el._lrIdent === undefined ? (el._lrIdent = String(o.ident(el._lrItem))) : el._lrIdent);
    const sameIdent = (el, i) => (o.identEq ? o.identEq(el, shown[i]) : identOfEl(el) === identOfItem(i));

    const byKey = new Map();
    const stale = [];
    for (let node = container.firstChild; node; node = node.nextSibling) {
      if (node.nodeType === 1 && node._lrKey != null && !node._lrLeaving && !byKey.has(node._lrKey)) byKey.set(node._lrKey, node);
      else stale.push(node);
    }
    const claimed = new Set();
    const nodes = new Array(n);
    let unmatched = 0;

    // 1. key 與內容都對得上
    for (let i = 0; i < n; i++) {
      const el = byKey.get(keys[i]);
      if (el && (!hasIdent || sameIdent(el, i))) { nodes[i] = el; claimed.add(el); } else unmatched++;
    }
    if (hasIdent && unmatched) {
      // 2. 內容對得上（列號位移、同步中 → 已同步）
      const pool = new Map();
      byKey.forEach(el => {
        if (claimed.has(el)) return;
        const id = identOfEl(el);
        const arr = pool.get(id);
        if (arr) arr.push(el); else pool.set(id, [el]);
      });
      if (pool.size) {
        for (let i = 0; i < n; i++) {
          if (nodes[i]) continue;
          const arr = pool.get(identOfItem(i));
          while (arr && arr.length) {
            const el = arr.shift();
            if (claimed.has(el)) continue;
            nodes[i] = el; claimed.add(el);
            break;
          }
        }
        // 3. 只有 key 對得上（同一筆被修改）
        for (let i = 0; i < n; i++) {
          if (nodes[i]) continue;
          const el = byKey.get(keys[i]);
          if (el && !claimed.has(el)) { nodes[i] = el; claimed.add(el); }
        }
      }
    }

    // 4. 更新內容有變的節點、建立新節點
    const dropped = [];
    // create／update／sig 的第三、四個參數：已經算過的 ident 才傳（沒算過就是 undefined，呼叫端需要時自己算）
    const identArg = i => (hasIdent ? itemIdents[i] : undefined);
    for (let i = 0; i < n; i++) {
      let el = nodes[i];
      const item = shown[i];
      let sig;
      if (el) {
        let changed;
        if (o.same) {
          changed = !o.same(el, item);
        } else {
          sig = o.sig ? String(o.sig(item, i, identArg(i))) : '';
          changed = el._lrSig !== sig;
        }
        if (!changed) out.kept++;
        else if (o.update) o.update(el, item, i, identArg(i));
        else { dropped.push(el); el = null; }
      }
      if (!el) {
        el = makeNode(o, item, i, identArg(i));
        if (!o.same && sig === undefined) sig = o.sig ? String(o.sig(item, i, identArg(i))) : '';
        out.created.push(el);
      }
      // 節點改顯示另一個資料物件：ident 換成這一筆的（還沒算過就留待下次需要時再算）
      if (hasIdent && el._lrItem !== item) el._lrIdent = itemIdents[i];
      el._lrKey = keys[i];
      if (sig !== undefined) el._lrSig = sig;
      el._lrItem = item;
      if (o.place) o.place(el, item, i);
      nodes[i] = el;
    }

    // 5. 移除沒用到的節點，再依序擺放（多數情況只有開頭插入一筆或中間少一筆，移動次數很少）
    stale.forEach(n => { n.remove(); out.removed++; });
    byKey.forEach(el => { if (!claimed.has(el)) { el.remove(); out.removed++; } });
    dropped.forEach(el => { el.remove(); out.removed++; });
    let ref = container.firstChild;
    for (let i = 0; i < nodes.length; i++) {
      const el = nodes[i];
      if (el === ref) ref = ref.nextSibling;
      else container.insertBefore(el, ref);
    }
    out.total = nodes.length;
    syncSentinel(container, nodes.length < list.length);
    return out;
  }

  /**
   * 選項晶片：只有選項清單本身改變（用內容比對）才需要重建。
   * 回傳 true 表示 sig 和上次相同，可以只切換選取狀態。
   */
  function sameSig(container, sig) {
    if (!container) return false;
    const same = container._lrChoiceSig === sig && container.childElementCount > 0;
    container._lrChoiceSig = sig;
    return same;
  }

  /** 選取狀態：只切換 selected class 與 aria-pressed，其餘不動。 */
  function syncSelected(container, isSelected, itemSel) {
    if (!container) return;
    const list = container.querySelectorAll(itemSel || '.choice');
    for (let i = 0; i < list.length; i++) {
      const btn = list[i];
      const on = Boolean(isSelected(btn));
      if (btn.classList.contains('selected') !== on) btn.classList.toggle('selected', on);
      const pressed = on ? 'true' : 'false';
      if (btn.getAttribute('aria-pressed') !== pressed) btn.setAttribute('aria-pressed', pressed);
    }
  }

  /** 文字有變才寫入（textContent／innerHTML 即使值相同也會重建子節點）。 */
  function setText(el, text) {
    if (el && el.textContent !== text) el.textContent = text;
  }
  function setHtml(el, html) {
    if (el && el._lrHtml !== html) { el.innerHTML = html; el._lrHtml = html; }
  }

  return {
    reconcile: reconcile,
    markLeaving: markLeaving,
    fromHtml: fromHtml,
    fragment: fragment,
    more: more,
    sameSig: sameSig,
    syncSelected: syncSelected,
    setText: setText,
    setHtml: setHtml,
  };
})();
