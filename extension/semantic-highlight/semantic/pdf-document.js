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
    const layer = globalThis.IL_pdfTextLayer;
    /** @type {string} */
    let pageText = '';
    /** @type {{ node: Text, start: number, end: number }[]} */
    let pieces = [];
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
      const data = layer.peek(getData);
      if (!data) return;
      if (data.pageText === textSnapshot) rebind(data);
      activeHooks.onContentMaybeChanged?.();
    }
    window.addEventListener('il-pdf-rerendered', onPdfRerendered);

    /** 同文换节点：只换 pieces 与根，不动 pageText 快照。 */
    function rebind(data) {
      pieces = layer.pieces(data);
      const root = layer.pagesRoot(data);
      if (root) extractRoot = root;
    }

    function applyData(data) {
      pageText = data.pageText;
      textSnapshot = pageText;
      pieces = layer.pieces(data);
      const root = layer.pagesRoot(data);
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

    function clientRectToMountPos(rect) {
      if (!paintMount) throw new Error('paint mount missing');
      return layer.underlinePos(rect, paintMount.getBoundingClientRect(), layer.scaleOf(extractRoot));
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
      applyData(layer.read(getData));
      ensurePaintMount(extractRoot);
      return { root: extractRoot, length: pageText.length };
    }

    /** 正文已在 viewer 拼好；这里只取快照（与网页 collectTextMap 不同）。过期则不写。 */
    async function refreshAsync(isStale) {
      if (isStale?.()) {
        throw new DOMException('The operation was aborted.', 'AbortError');
      }
      return refresh();
    }

    function rebindIfUnchanged() {
      if (!extractRoot?.isConnected) return false;
      const data = layer.peek(getData);
      if (!data || data.pageText !== textSnapshot) return false;
      rebind(data);
      return true;
    }

    /**
     * pageText [o0,o1) → 与各 text 项相交的 Range[]。可跨页：pieces 已是全文坐标。
     * 节点长度可能短于该项跨度（pdf.js 重渲染中途），故按 node.data.length 夹一次。
     * @returns {Range[]}
     */
    function rangesFromOffsets(o0, o1) {
      if (!pageText || o1 <= o0) return [];
      /** @type {Range[]} */
      const out = [];
      for (const p of pieces) {
        const s = Math.max(o0, p.start);
        const e = Math.min(o1, p.end);
        if (s >= e) continue;
        const localStart = s - p.start;
        const clampedEnd = Math.min(e - p.start, p.node.data.length);
        if (clampedEnd <= localStart) continue;
        const range = document.createRange();
        range.setStart(p.node, localStart);
        range.setEnd(p.node, clampedEnd);
        out.push(range);
      }
      return out;
    }

    /**
     * 缩放重渲后 textLayer 会整表替换；内容（pageText）不变时从 getData 取新节点。
     * find.js syncPaintAfterLayout 在 piecesStale 时走此路径。
     * 取不到新数据时回报旧文本（PDF 正文不会真变），让上层只当作节点重排。
     */
    function recollectMap() {
      const data = layer.peek(getData);
      if (data && data.pageText === textSnapshot) return { text: data.pageText, data };
      return { text: pageText };
    }

    function applyRecollected(mapped) {
      if (mapped?.data) rebind(mapped.data);
    }

    function replaceTextAndPieces(text) {
      pageText = text || '';
      textSnapshot = pageText;
    }

    return {
      refresh,
      refreshAsync,
      rebindIfUnchanged,
      release,
      getText: () => pageText,
      getPaintLength: () => pageText.length,
      toPaintOffset: (u) => u,
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
      piecesStale: () => pieces.some((p) => !p.node.isConnected),
      recollectMap,
      applyRecollected,
      replaceTextAndPieces,
      isContentDirty: () => false,
      clearContentDirty: () => {},
    };
  };
})();
