/**
 * Webpage DocumentAdapter：正文根、pieces 映回、paint mount、布局监听。
 * Paint offsets = 码点（与历史 content.js 一致）。
 */
(() => {
  /**
   * @param {{ onContentMaybeChanged?: () => void, onScrollRootHint?: (el: Element) => void }} [hooks]
   */
  globalThis.IL_createPageDocumentAdapter = function IL_createPageDocumentAdapter(hooks = {}) {
    /** @type {{ node: Text, start: number, end: number }[]} */
    let pieces = [];
    /** @type {Set<Text>} */
    let pieceNodeSet = new Set();
    let extractedText = '';
    /** @type {ReturnType<typeof globalThis.IL_createTextIndex>} */
    let cpIndex = globalThis.IL_createTextIndex('');
    /** @type {Element | null} */
    let extractRoot = null;
    /** @type {HTMLElement | null} */
    let paintMount = null;
    /** @type {Element | null} */
    let paintPosTarget = null;
    let paintPosRestore = null;
    /** @type {ResizeObserver | null} */
    let paintResizeObserver = null;
    /** @type {MutationObserver | null} */
    let contentMutationObserver = null;
    let contentDirty = false;
    let scrollSyncTimer = 0;
    /** @type {typeof hooks} */
    let activeHooks = hooks;

    function pickArticleRoot() {
      const find = globalThis.IL_findArticleRoot;
      if (typeof find !== 'function') {
        throw new Error('IL_findArticleRoot missing — inject articleRoot.js before content.js');
      }
      return find(document);
    }

    function collectTextMap(root) {
      const fn = globalThis.IL_collectTextMap;
      if (typeof fn !== 'function') {
        throw new Error('IL_collectTextMap missing — inject collectTextMap.js before content.js');
      }
      return fn(root);
    }

    function collectTextMapAsync(root, isStale) {
      const fn = globalThis.IL_collectTextMapAsync;
      if (typeof fn !== 'function') {
        throw new Error('IL_collectTextMapAsync missing — inject collectTextMap.js before content.js');
      }
      return fn(root, isStale);
    }

    function setPieces(newPieces) {
      pieces = newPieces;
      pieceNodeSet = new Set(pieces.map((p) => p.node));
    }

    /** 写入 extractedText 并重建码点索引（仅此处改正文缓存） */
    function setExtractedText(text) {
      extractedText = text || '';
      cpIndex = globalThis.IL_createTextIndex(extractedText);
    }

    function replaceTextAndPieces(text, newPieces) {
      setExtractedText(text);
      setPieces(newPieces);
    }

    /** 最近块级容器；跨块的 Range 会让 getClientRects 多出整块盒子 */
    function nearestBlock(node, cache) {
      let el = node.parentElement;
      while (el) {
        const cached = cache?.get(el);
        if (cached !== undefined) return cached;
        const display = getComputedStyle(el).display;
        if (
          display === 'block' ||
          display === 'flex' ||
          display === 'grid' ||
          display === 'list-item' ||
          display === 'table' ||
          display === 'table-row' ||
          display === 'table-cell' ||
          display === 'flow-root'
        ) {
          cache?.set(el, el);
          return el;
        }
        el = el.parentElement;
      }
      return document.body;
    }

    /**
     * 按块级容器切开，避免单个 Range 跨 <p> 等时 getClientRects 叠出双线。
     * @returns {Range[]}
     */
    function rangesFromOffsets(cp0, cp1) {
      if (!extractedText || cp1 <= cp0) return [];
      const u0 = cpIndex.cpToUtf16(cp0);
      const u1 = cpIndex.cpToUtf16(cp1);
      if (u1 <= u0) return [];

      let i = globalThis.IL_findPieceIndex(pieces, u0);
      if (i < 0) return [];

      const blockCache = new WeakMap();
      /** @type {Range[]} */
      const out = [];
      /** @type {Range | null} */
      let cur = null;
      /** @type {Element | null} */
      let curBlock = null;

      for (; i < pieces.length; i++) {
        const p = pieces[i];
        if (p.start >= u1) break;
        if (!p.node.isConnected) continue;
        const seg0 = Math.max(u0, p.start);
        const seg1 = Math.min(u1, p.end);
        if (seg1 <= seg0) continue;
        if (!/\S/.test(extractedText.slice(seg0, seg1))) {
          if (cur && !cur.collapsed) out.push(cur);
          cur = null;
          curBlock = null;
          continue;
        }

        const block = nearestBlock(p.node, blockCache);
        try {
          if (!cur || block !== curBlock) {
            if (cur && !cur.collapsed) out.push(cur);
            cur = document.createRange();
            cur.setStart(p.node, seg0 - p.start);
            cur.setEnd(p.node, seg1 - p.start);
            curBlock = block;
          } else {
            cur.setEnd(p.node, seg1 - p.start);
          }
        } catch {
          if (cur && !cur.collapsed) out.push(cur);
          cur = null;
          curBlock = null;
        }
      }
      if (cur && !cur.collapsed) out.push(cur);
      return out;
    }

    function findScrollRoot(from) {
      return globalThis.IL_scrollGeometry.findScrollRoot(from ?? extractRoot);
    }

    function stopLayoutWatch() {
      paintResizeObserver?.disconnect();
      paintResizeObserver = null;
      contentMutationObserver?.disconnect();
      contentMutationObserver = null;
      if (scrollSyncTimer) {
        clearTimeout(scrollSyncTimer);
        scrollSyncTimer = 0;
      }
    }

    /**
     * 只关心落在已提取文本节点（pieces）上的变动，忽略正文里跟已提取内容无关的动态。
     */
    function mutationTouchesPieces(record) {
      if (record.type === 'characterData') {
        return pieceNodeSet.has(record.target);
      }
      const changed = [...record.addedNodes, ...record.removedNodes];
      if (changed.some((n) => pieceNodeSet.has(n))) return true;
      return changed.some((n) => n.nodeType === 1 && pieces.some((p) => n.contains(p.node)));
    }

    function scheduleNotify() {
      if (scrollSyncTimer) clearTimeout(scrollSyncTimer);
      scrollSyncTimer = window.setTimeout(() => {
        scrollSyncTimer = 0;
        activeHooks.onContentMaybeChanged?.();
      }, 120);
    }

    function startLayoutWatch(nextHooks) {
      if (nextHooks) activeHooks = nextHooks;
      stopLayoutWatch();
      if (!extractRoot?.isConnected) return;
      const articleRoot = extractRoot;
      paintResizeObserver = new ResizeObserver(() => scheduleNotify());
      paintResizeObserver.observe(articleRoot);
      const scrollRoot = findScrollRoot(articleRoot);
      if (scrollRoot && scrollRoot !== document.documentElement && scrollRoot !== document.body) {
        paintResizeObserver.observe(scrollRoot);
      }
      activeHooks.onScrollRootHint?.(scrollRoot);
      contentMutationObserver = new MutationObserver((records) => {
        if (!records.some(mutationTouchesPieces)) return;
        contentDirty = true;
        scheduleNotify();
      });
      contentMutationObserver.observe(articleRoot, {
        childList: true,
        characterData: true,
        subtree: true,
      });
    }

    function releasePaintMount() {
      stopLayoutWatch();
      if (paintMount) {
        paintMount.remove();
        paintMount = null;
      }
      if (paintPosTarget && paintPosRestore !== null) {
        paintPosTarget.style.position = paintPosRestore;
      }
      paintPosTarget = null;
      paintPosRestore = null;
    }

    /** underline 叠层挂在正文根内；与字同滚动，停稳后再重测坐标 */
    function ensurePaintMount(articleRoot = extractRoot) {
      if (!articleRoot) throw new Error('paint mount root missing');
      if (paintMount?.isConnected && paintMount.parentElement === articleRoot) return paintMount;

      releasePaintMount();

      const st = getComputedStyle(articleRoot);
      if (st.position === 'static') {
        paintPosTarget = articleRoot;
        paintPosRestore = articleRoot.style.position;
        articleRoot.style.position = 'relative';
      }

      const host = document.createElement('div');
      host.id = 'il-overlay-host';
      articleRoot.appendChild(host);
      paintMount = host;
      // 与历史 ensurePaintMount 一致：挂载后立即开布局监听（hooks 已由 find 注入）
      startLayoutWatch();
      return paintMount;
    }

    function clientRectToMountPos(rect) {
      if (!paintMount) throw new Error('paint mount missing');
      const hr = paintMount.getBoundingClientRect();
      return {
        x: rect.left - hr.left,
        y: rect.bottom - 2 - hr.top,
      };
    }

    function release() {
      releasePaintMount();
      extractRoot = null;
    }

    function applyMapped(root, mapped) {
      extractRoot = root;
      ensurePaintMount(root);
      setExtractedText(mapped.text);
      setPieces(mapped.pieces);
      contentDirty = false;
      return { root, length: extractedText.length };
    }

    function refresh() {
      const root = pickArticleRoot();
      return applyMapped(root, collectTextMap(root));
    }

    /** 加载中也能开浮条、输入；抽正文要等 complete，否则搜的是半截 DOM */
    function whenLoaded() {
      if (document.readyState === 'complete') return null;
      return new Promise((resolve) => window.addEventListener('load', resolve, { once: true }));
    }

    /** 分片让出主线程；isStale 为真则丢弃，不改已有 extract。 */
    async function refreshAsync(isStale) {
      await whenLoaded();
      const root = pickArticleRoot();
      const mapped = await collectTextMapAsync(root, isStale);
      if (isStale?.()) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return applyMapped(root, mapped);
    }

    /** Continue：正文未变则重绑 pieces；变了 / 根断开 → false */
    function rebindIfUnchanged() {
      if (!extractRoot?.isConnected) return false;
      const mapped = collectTextMap(extractRoot);
      contentDirty = false;
      if (mapped.text !== extractedText) return false;
      setPieces(mapped.pieces);
      return true;
    }

    function recollectMap() {
      if (!extractRoot) throw new Error('extract root missing');
      return collectTextMap(extractRoot);
    }

    function applyRecollected(mapped, { replaceText = false } = {}) {
      contentDirty = false;
      if (replaceText) {
        replaceTextAndPieces(mapped.text, mapped.pieces);
      } else {
        setPieces(mapped.pieces);
      }
    }

    return {
      refresh,
      refreshAsync,
      rebindIfUnchanged,
      release,
      getText: () => extractedText,
      getPaintLength: () => cpIndex.cpLength,
      toPaintOffset: (u16) => cpIndex.utf16ToCp(u16),
      rangesFromOffsets,
      isConnected: () => !!extractRoot?.isConnected,
      getRoot: () => extractRoot,
      ensurePaintMount,
      getPaintMount: () => paintMount,
      clientRectToMountPos,
      /** 网页：真实 DOM 字在上，CSS Highlight 底色/下划线在字下；勿改 overlay（getClientRects 在重页上极贵） */
      tokenPaintMode: () => 'highlight',
      findScrollRoot,
      startLayoutWatch,
      stopLayoutWatch,
      scheduleLayoutSync: scheduleNotify,
      piecesStale: () => pieces.some((p) => !p.node.isConnected),
      recollectMap,
      applyRecollected,
      replaceTextAndPieces,
      isContentDirty: () => contentDirty,
      clearContentDirty: () => {
        contentDirty = false;
      },
    };
  };
})();
