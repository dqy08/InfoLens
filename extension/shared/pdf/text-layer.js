/**
 * viewer.js 发布的 window.__IL_PDF_DATA__ 的消费端：形状校验、textLayer → pieces、
 * 以及 overlay 相对 --il-pdf-scale 的几何。viewer 是唯一生产者，读法与几何常量只此一份。
 */
globalThis.IL_pdfTextLayer = (() => {
  /** 蓝导航线线高；线顶贴字底靠它上移。SYNC: content.css → .il-chunk-underline height */
  const UNDERLINE_WIDTH = 2;

  const defaultGetData = () => window.__IL_PDF_DATA__ || null;

  /**
   * @param {() => unknown} [getData]
   * @returns {{ pageText: string, itemOffsets: { start: number, end: number }[], textDivs: HTMLElement[], pagesRoot?: HTMLElement, textLayerDiv?: HTMLElement }}
   */
  function read(getData = defaultGetData) {
    const data = getData();
    // 文案被 find.js isPdfNoTextError 逐字匹配，改前先看那里
    if (!data || typeof data.pageText !== 'string') throw new Error('PDF page text missing');
    if (!data.pageText.trim()) throw new Error('PDF page text empty');
    if (!Array.isArray(data.itemOffsets) || !Array.isArray(data.textDivs)) {
      throw new Error('PDF text layer map missing');
    }
    return data;
  }

  /** 读不到就当没有；供缩放重渲等「拿不到就跳过」的路径用。 */
  function peek(getData = defaultGetData) {
    try {
      return read(getData);
    } catch {
      return null;
    }
  }

  /** 全页容器（#il-pv-pages）；overlay 相对它定位。 */
  function pagesRoot(data) {
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

  /**
   * itemOffsets × textDivs → pieces（与网页 collectTextMap 同形）。start/end 是 pageText 的
   * UTF-16 下标，可跨页。只留 firstChild 确为文本节点的项。
   * @returns {{ node: Text, start: number, end: number }[]}
   */
  function pieces(data) {
    const out = [];
    for (let i = 0; i < data.itemOffsets.length; i++) {
      const o = data.itemOffsets[i];
      const node = data.textDivs[i]?.firstChild;
      if (node?.nodeType !== Node.TEXT_NODE || o.end <= o.start) continue;
      out.push({ node, start: o.start, end: o.end });
    }
    return out;
  }

  /** 与 pagesRoot 上 --il-pdf-scale（= viewport.scale）对齐；缺省 1。 */
  function scaleOf(root) {
    const raw = root ? getComputedStyle(root).getPropertyValue('--il-pdf-scale') : '';
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }

  /** 字的 clientRect → 下划线相对挂载点的位置；线高随 scale，故上移也随 scale。 */
  function underlinePos(rect, hostRect, scale) {
    return {
      x: rect.left - hostRect.left,
      y: rect.bottom - UNDERLINE_WIDTH * scale - hostRect.top,
    };
  }

  return { UNDERLINE_WIDTH, read, peek, pagesRoot, pieces, scaleOf, underlinePos };
})();

/**
 * 缩放会连发 il-pdf-rerendered。停稳后再等一帧绘制，再跑 overlay。
 * 每个查看器页自己 create 一份，互不影响。
 */
globalThis.IL_createPdfZoomIdle = function IL_createPdfZoomIdle() {
  const IDLE_MS = 200;
  let timer = 0;
  let seq = 0;

  function waitForPaint() {
    return new Promise((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve, 0));
    });
  }

  function cancel() {
    seq += 1;
    if (!timer) return;
    clearTimeout(timer);
    timer = 0;
  }

  /**
   * @param {() => void | Promise<void>} run
   */
  function schedule(run) {
    cancel();
    const mine = seq;
    timer = setTimeout(() => {
      timer = 0;
      void (async () => {
        await waitForPaint();
        if (mine !== seq) return;
        await run();
      })();
    }, IDLE_MS);
  }

  return { IDLE_MS, schedule, cancel };
};
