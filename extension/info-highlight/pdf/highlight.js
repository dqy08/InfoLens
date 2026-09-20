/**
 * PDF 信息量标记：viewer 提供阅读序全文和 textLayer 节点。
 * token 走 overlay 红线（色块会盖住 canvas 字形；highlightStyle.resolvePaintStyle 把 pdf 上回退成下划线）。
 * 分批分析见 analyzeRun.js。缩放后 textLayer 重建：IL_createPdfZoomIdle 停稳再贴已提交 token。
 */
(() => {
  if (!globalThis.IH_analyzeRun) {
    throw new Error('IH_analyzeRun missing — inject analyzeRun.js before highlight.js');
  }
  const R = globalThis.IH_analyzeRun;
  if (typeof globalThis.IL_createPdfZoomIdle !== 'function') {
    throw new Error('IL_createPdfZoomIdle missing — load text-layer.js first');
  }
  const zoomIdle = globalThis.IL_createPdfZoomIdle();
  let generation = 0;
  let busy = false;
  let enabled = true;
  /** @type {{ mapped: { text: string, pieces: unknown[], root: Element }, segs: { start: number, end: number, text: string }[], next: number, painted: number, tokensBySeg?: unknown[][], skipCache?: boolean } | null} */
  let session = null;

  function extractPdfPage() {
    const data = globalThis.IL_pdfTextLayer.read();
    const pieces = globalThis.IL_pdfTextLayer.pieces(data);
    if (!pieces.length) throw new Error('PDF has no selectable text');
    return { text: data.pageText, pieces, root: globalThis.IL_pdfTextLayer.pagesRoot(data) };
  }

  function clear() {
    zoomIdle.cancel();
    session = null;
    globalThis.IH_clearHighlights();
    globalThis.IH_clearProgress();
    globalThis.IH_clearError();
  }

  function continuePaused() {
    if (busy || !session || !enabled) return;
    void runBatch(generation += 1, session.skipCache);
  }

  async function finish(lastAlignErr, report) {
    await R.afterPaint(
      session,
      lastAlignErr,
      'No tokens mapped onto the PDF text layer',
      () => globalThis.IH_showPaused(continuePaused),
      report,
    );
  }

  function job(myGeneration, work) {
    const still = () => myGeneration === generation;
    busy = true;
    R.reportActionState('analyzing');
    return R.runJob(still, {
      fail(err) {
        clear();
        R.reportActionState('on');
        return globalThis.IH_showError(err?.message || err);
      },
      idle() {
        busy = false;
        if (!still()) return;
        if (!enabled) R.reportActionState('off');
        else if (session) R.reportActionState('on');
      },
    }, work);
  }

  async function runBatch(myGeneration, skipCache) {
    const still = () => myGeneration === generation;
    const skip = !!skipCache;
    await job(myGeneration, async (report) => {
      if (!session) {
        session = await R.beginSession(extractPdfPage(), 'PDF has no text to analyze');
        session.skipCache = skip;
      }
      const end = Math.min(session.next + R.MAX_SEGMENTS_PER_RUN, session.segs.length);
      const lastAlignErr = await R.paintRange(
        session, session.next, end, still, { overlay: true, skipCache: skip }, report,
      );
      if (!still()) return;
      session.next = end;
      await finish(lastAlignErr, report);
    });
  }

  /** 同文换节点：idle 已等过绘制。按时间片贴线。不分析、不改图标。暂停点不动。 */
  async function remount(myGeneration) {
    const still = () => myGeneration === generation;
    let mapped;
    try {
      mapped = extractPdfPage();
    } catch (error) {
      if (!still()) return;
      clear();
      await globalThis.IH_showError(error?.message || error);
      R.reportActionState('on');
      return;
    }
    if (!session || mapped.text !== session.mapped.text) {
      session = null;
      await runBatch(myGeneration, false);
      return;
    }
    const done = session.next;
    await globalThis.IH_bindProgress(mapped, session.segs);
    if (!still()) return;
    if (done === 0) {
      session.mapped = mapped;
      await runBatch(myGeneration, session.skipCache);
      return;
    }
    R.reportActionState('on');
    try {
      globalThis.IH_clearError();
      await R.repaintCommitted(session, mapped, true, still);
      if (!still()) return;
      await finish(undefined, { segments: 0 });
    } catch (error) {
      if (!still()) return;
      clear();
      await globalThis.IH_showError(error?.message || error);
      R.reportActionState('on');
      return;
    }
    if (!still()) return;
    R.reportActionState('on');
  }

  function restart() {
    if (!enabled) return;
    zoomIdle.cancel();
    session = null;
    void runBatch(generation += 1, false);
  }

  function onRerendered() {
    if (!enabled) return;
    const g = generation += 1;
    zoomIdle.schedule(() => {
      if (!enabled || g !== generation) return;
      if (session) return remount(g);
      return runBatch(g, false);
    });
  }

  function toggle() {
    enabled = !enabled;
    if (enabled) {
      restart();
      return;
    }
    generation += 1;
    busy = false;
    clear();
    R.reportActionState('off');
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== 'ih-pdf-toggle' && message?.type !== 'ih-pdf-force') return;
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id !== message.tabId) return;
      if (message.type === 'ih-pdf-force') {
        if (busy) {
          alert(R.FORCE_BUSY_MSG);
        } else {
          enabled = true;
          clear();
          void runBatch(generation += 1, true);
        }
      } else {
        toggle();
      }
      sendResponse({ ok: true });
    });
    return true;
  });

  window.addEventListener('il-pdf-ready', restart);
  window.addEventListener('il-pdf-rerendered', onRerendered);
  if (window.__IL_PDF_DATA__) restart();
})();
