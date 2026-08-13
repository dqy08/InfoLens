/**
 * PDF DocumentAdapter：全页 textLayer 按阅读序拼接的文本；paint offsets = pageText 的 UTF-16 下标（恒等）。
 * 多页 ≈ 网页往下滚：正文是连续 pageText，搜索仍走共享层 32-chunk 窗口。
 * getData() → window.__IL_PDF_DATA__ 或 null。
 */
(() => {
  /**
   * @param {() => null | {
   *   pageText: string,
   *   itemOffsets: { start: number, end: number }[],
   *   textDivs: HTMLElement[],
   *   pagesRoot?: HTMLElement,
   *   textLayerDiv?: HTMLElement,
   * }} getData
   * @param {{ onContentMaybeChanged?: () => void, onScrollRootHint?: (el: Element) => void }} [hooks]
   */
  globalThis.IL_createPdfDocumentAdapter = function IL_createPdfDocumentAdapter(getData, hooks = {}) {
    /** @type {string} */
    let pageText = '';
    /** @type {{ start: number, end: number }[]} */
    let itemOffsets = [];
    /** @type {HTMLElement[]} */
    let textDivs = [];
    /** @type {Element | null} 全页容器（#il-pv-pages），underline 相对此挂载 */
    let extractRoot = null;
    /** @type {HTMLElement | null} */
    let paintMount = null;
    /** @type {Element | null} */
    let paintPosTarget = null;
    let paintPosRestore = null;
    /** @type {ResizeObserver | null} */
    let paintResizeObserver = null;
    let scrollSyncTimer = 0;
    /** 刷新时的 pageText 快照，供 Continue / 身份校验 */
    let textSnapshot = '';
    /** @type {typeof hooks} */
    let activeHooks = hooks;

    /** 缩放全页重渲后：同文换节点，立刻重绑并让 find 重测 overlay */
    function onPdfRerendered() {
      if (!extractRoot) return;
      let data;
      try {
        data = typeof getData === 'function' ? getData() : null;
      } catch {
        return;
      }
      if (!data || !Array.isArray(data.textDivs)) return;
      if (data.pageText === textSnapshot) {
        textDivs = data.textDivs;
        if (Array.isArray(data.itemOffsets)) itemOffsets = data.itemOffsets;
        const root = resolvePagesRoot(data);
        if (root) extractRoot = root;
      }
      activeHooks.onContentMaybeChanged?.();
    }
    window.addEventListener('il-pdf-rerendered', onPdfRerendered);

    function readData() {
      const data = typeof getData === 'function' ? getData() : null;
      if (!data || typeof data.pageText !== 'string') {
        throw new Error('PDF page text missing');
      }
      if (!data.pageText.trim()) {
        throw new Error('PDF page text empty');
      }
      if (!Array.isArray(data.itemOffsets) || !Array.isArray(data.textDivs)) {
        throw new Error('PDF text layer map missing');
      }
      return data;
    }

    function resolvePagesRoot(data) {
      if (data.pagesRoot?.isConnected) return data.pagesRoot;
      const host = document.getElementById('il-pv-pages');
      if (host) return host;
      const layer =
        data.textLayerDiv ||
        data.textDivs[0]?.closest?.('.textLayer') ||
        data.textDivs[0]?.parentElement ||
        null;
      return layer?.closest?.('.il-pv-page') || layer;
    }

    function applyData(data) {
      pageText = data.pageText;
      itemOffsets = data.itemOffsets;
      textDivs = data.textDivs;
      textSnapshot = pageText;
      const root = resolvePagesRoot(data);
      if (!root) throw new Error('PDF pages root missing');
      extractRoot = root;
    }

    function stopLayoutWatch() {
      paintResizeObserver?.disconnect();
      paintResizeObserver = null;
      if (scrollSyncTimer) {
        clearTimeout(scrollSyncTimer);
        scrollSyncTimer = 0;
      }
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
      paintResizeObserver = new ResizeObserver(() => scheduleNotify());
      paintResizeObserver.observe(extractRoot);
      const scrollRoot = findScrollRoot();
      if (scrollRoot && scrollRoot !== document.documentElement && scrollRoot !== document.body) {
        paintResizeObserver.observe(scrollRoot);
      }
      activeHooks.onScrollRootHint?.(scrollRoot);
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
      startLayoutWatch();
      return paintMount;
    }

    /** 与 #il-pv-pages 上 --il-pdf-scale（= viewport.scale）对齐；缺省 1 */
    function pdfScale() {
      const raw = extractRoot
        ? getComputedStyle(extractRoot).getPropertyValue('--il-pdf-scale')
        : '';
      const n = Number.parseFloat(raw);
      return Number.isFinite(n) && n > 0 ? n : 1;
    }

    function clientRectToMountPos(rect) {
      if (!paintMount) throw new Error('paint mount missing');
      const hr = paintMount.getBoundingClientRect();
      // 2 = UNDERLINE_WIDTH；随 scale 变，使蓝线顶边仍贴字底
      const s = pdfScale();
      return {
        x: rect.left - hr.left,
        y: rect.bottom - 2 * s - hr.top,
      };
    }

    function findScrollRoot() {
      return document.getElementById('il-pv-scroll') || document.scrollingElement || document.documentElement;
    }

    function release() {
      window.removeEventListener('il-pdf-rerendered', onPdfRerendered);
      releasePaintMount();
      extractRoot = null;
    }

    function refresh() {
      const data = readData();
      applyData(data);
      ensurePaintMount(extractRoot);
      return { root: extractRoot, length: pageText.length };
    }

    function rebindIfUnchanged() {
      if (!extractRoot?.isConnected) return false;
      let data;
      try {
        data = typeof getData === 'function' ? getData() : null;
      } catch {
        return false;
      }
      if (!data || data.pageText !== textSnapshot) return false;
      itemOffsets = data.itemOffsets || itemOffsets;
      textDivs = data.textDivs || textDivs;
      const root = resolvePagesRoot(data);
      if (root) extractRoot = root;
      return true;
    }

    /**
     * pageText [o0,o1) → 与各 text 项相交的 Range[]（firstChild Text）。
     * 可跨页：itemOffsets 已是全文坐标。
     * @returns {Range[]}
     */
    function rangesFromOffsets(o0, o1) {
      if (!pageText || o1 <= o0) return [];
      /** @type {Range[]} */
      const out = [];
      for (let i = 0; i < itemOffsets.length; i++) {
        const o = itemOffsets[i];
        const s = Math.max(o0, o.start);
        const e = Math.min(o1, o.end);
        if (s >= e) continue;
        const div = textDivs[i];
        if (!div || !div.firstChild || div.firstChild.nodeType !== Node.TEXT_NODE) continue;
        const node = /** @type {Text} */ (div.firstChild);
        const localStart = s - o.start;
        const localEnd = e - o.start;
        const textLen = node.data.length;
        if (localStart >= textLen) continue;
        const clampedEnd = Math.min(localEnd, textLen);
        if (clampedEnd <= localStart) continue;
        try {
          const range = document.createRange();
          range.setStart(node, localStart);
          range.setEnd(node, clampedEnd);
          out.push(range);
        } catch {
          /* skip broken node */
        }
      }
      return out;
    }

    /**
     * 缩放重渲后 textDivs 会整表替换；内容（pageText）不变时从 getData 取新节点。
     * find.js syncPaintAfterLayout 在 piecesStale 时走此路径。
     */
    function recollectMap() {
      let data;
      try {
        data = typeof getData === 'function' ? getData() : null;
      } catch {
        data = null;
      }
      if (data && data.pageText === textSnapshot && Array.isArray(data.textDivs)) {
        return {
          text: data.pageText,
          pieces: [],
          textDivs: data.textDivs,
          itemOffsets: data.itemOffsets,
          pagesRoot: data.pagesRoot,
        };
      }
      return { text: pageText, pieces: [] };
    }

    function applyRecollected(mapped) {
      if (!mapped || !Array.isArray(mapped.textDivs)) return;
      textDivs = mapped.textDivs;
      if (Array.isArray(mapped.itemOffsets)) itemOffsets = mapped.itemOffsets;
      const root = resolvePagesRoot(mapped);
      if (root) extractRoot = root;
    }

    function replaceTextAndPieces(text) {
      pageText = text || '';
      textSnapshot = pageText;
    }

    return {
      refresh,
      rebindIfUnchanged,
      release,
      getText: () => pageText,
      getPaintLength: () => pageText.length,
      toPaintOffset: (u) => u,
      /**
       * textLayer 命中 → pageText 下标。未命中则 null。
       * @param {Node} node
       * @param {number} offset
       * @returns {number | null}
       */
      paintOffsetFromCaret(node, offset) {
        const div =
          node.nodeType === Node.TEXT_NODE ? node.parentElement : node instanceof Element ? node : null;
        if (!div) return null;
        const i = textDivs.indexOf(div);
        if (i < 0) return null;
        const o = itemOffsets[i];
        const local = node.nodeType === Node.TEXT_NODE ? offset : 0;
        return Math.max(o.start, Math.min(o.end, o.start + local));
      },
      rangesFromOffsets,
      isConnected: () => !!extractRoot?.isConnected,
      getRoot: () => extractRoot,
      ensurePaintMount,
      getPaintMount: () => paintMount,
      clientRectToMountPos,
      /**
       * PDF canvas 含字形，红底会蒙字；token/蓝线用 overlay（getClientRects → div）。
       * 比网页 Highlight 贵：重测须增量、避免无谓全量；与 find.js usesTokenOverlay 对应。
       */
      tokenPaintMode: () => 'token-underline',
      findScrollRoot,
      startLayoutWatch,
      stopLayoutWatch,
      scheduleLayoutSync: scheduleNotify,
      piecesStale: () => textDivs.some((d) => !d?.isConnected),
      recollectMap,
      applyRecollected,
      replaceTextAndPieces,
      isContentDirty: () => false,
      clearContentDirty: () => {},
    };
  };
})();
