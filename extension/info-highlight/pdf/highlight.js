/**
 * PDF 信息量标记：viewer 提供阅读序全文和 textLayer 节点。
 * 分批分析见 analyzeRun.js。缩放重建 textLayer 后：正文不变则换新节点，已分析段从缓存画回，暂停点保留。
 */
(() => {
  if (!globalThis.IH_analyzeRun) {
    throw new Error('IH_analyzeRun missing — inject analyzeRun.js before highlight.js');
  }
  const R = globalThis.IH_analyzeRun;
  let generation = 0;
  let busy = false;
  let enabled = true;
  /** @type {{ mapped: { text: string, pieces: unknown[], root: Element }, segs: { start: number, end: number, text: string }[], next: number, painted: number } | null} */
  let session = null;

  function extractPdfPage() {
    const data = globalThis.IL_pdfTextLayer.read();
    const pieces = globalThis.IL_pdfTextLayer.pieces(data);
    if (!pieces.length) throw new Error('PDF has no selectable text');
    return { text: data.pageText, pieces, root: globalThis.IL_pdfTextLayer.pagesRoot(data) };
  }

  function clear() {
    session = null;
    globalThis.IH_clearHighlights();
    globalThis.IH_clearProgress();
    globalThis.IH_clearError();
  }

  function continuePaused() {
    if (busy || !session || !enabled) return;
    void runBatch(generation += 1);
  }

  function finish(lastAlignErr) {
    R.afterPaint(
      session,
      lastAlignErr,
      'No tokens mapped onto the PDF text layer',
      () => globalThis.IH_showPaused(continuePaused),
    );
  }

  function job(myGeneration, work) {
    const still = () => myGeneration === generation;
    busy = true;
    return R.runJob(still, {
      fail(err) {
        clear();
        globalThis.IH_showError(err?.message || err);
      },
      idle() { busy = false; },
    }, work);
  }

  async function runBatch(myGeneration) {
    const still = () => myGeneration === generation;
    await job(myGeneration, async () => {
      if (!session) {
        session = R.beginSession(extractPdfPage(), 'PDF has no text to analyze');
      }
      const end = Math.min(session.next + R.MAX_SEGMENTS_PER_RUN, session.segs.length);
      const lastAlignErr = await R.paintRange(session, session.next, end, still, { overlay: true });
      if (!still()) return;
      session.next = end;
      finish(lastAlignErr);
    });
  }

  /** 同文换节点：把已提交的段画回新 textLayer，暂停点不动。 */
  async function remount(myGeneration) {
    const still = () => myGeneration === generation;
    let mapped;
    try {
      mapped = extractPdfPage();
    } catch (error) {
      if (!still()) return;
      clear();
      globalThis.IH_showError(error?.message || error);
      return;
    }
    if (!session || mapped.text !== session.mapped.text) {
      session = null;
      await runBatch(myGeneration);
      return;
    }
    session.mapped = mapped;
    session.painted = 0;
    const done = session.next;
    globalThis.IH_clearHighlights();
    globalThis.IH_bindProgress(mapped, session.segs);
    if (done === 0) {
      await runBatch(myGeneration);
      return;
    }
    await job(myGeneration, async () => {
      const lastAlignErr = await R.paintRange(session, 0, done, still, { overlay: true });
      if (!still()) return;
      finish(lastAlignErr);
    });
  }

  function restart() {
    if (!enabled) return;
    session = null;
    void runBatch(generation += 1);
  }

  function onRerendered() {
    if (!enabled) return;
    const myGeneration = generation += 1;
    if (session) void remount(myGeneration);
    else void runBatch(myGeneration);
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
    R.releaseLocalEngine();
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'ih-pdf-toggle') return;
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id === message.tabId) toggle();
    });
  });

  window.addEventListener('il-pdf-ready', restart);
  window.addEventListener('il-pdf-rerendered', onRerendered);
  if (window.__IL_PDF_DATA__) restart();
})();
