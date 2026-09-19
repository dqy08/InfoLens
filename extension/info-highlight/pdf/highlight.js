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
  let skipCache = false;
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

  async function runBatch(myGeneration) {
    const still = () => myGeneration === generation;
    await job(myGeneration, async (report) => {
      if (!session) {
        session = await R.beginSession(extractPdfPage(), 'PDF has no text to analyze');
      }
      const end = Math.min(session.next + R.MAX_SEGMENTS_PER_RUN, session.segs.length);
      const lastAlignErr = await R.paintRange(
        session, session.next, end, still, { overlay: true, skipCache }, report,
      );
      if (!still()) return;
      session.next = end;
      await finish(lastAlignErr, report);
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
      await globalThis.IH_showError(error?.message || error);
      R.reportActionState('on');
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
    await globalThis.IH_bindProgress(mapped, session.segs);
    if (done === 0) {
      await runBatch(myGeneration);
      return;
    }
    await job(myGeneration, async (report) => {
      const lastAlignErr = await R.paintRange(
        session, 0, done, still, { overlay: true }, report,
      );
      if (!still()) return;
      await finish(lastAlignErr, report);
    });
  }

  function restart() {
    if (!enabled) return;
    skipCache = false;
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
          skipCache = true;
          clear();
          void runBatch(generation += 1);
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
