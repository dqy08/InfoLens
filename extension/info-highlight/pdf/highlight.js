/**
 * PDF 信息量标记：viewer 提供阅读序全文和 textLayer 节点。
 * 与网页 content.js 相同：32 段一批，Paused / Continue。
 * 缩放重建 textLayer 后：正文不变则换新节点，已分析段从缓存画回，暂停点保留。
 */
(() => {
  /** SYNC: content.js → MAX_SEGMENTS_PER_RUN */
  const MAX_SEGMENTS_PER_RUN = 32;
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

  function sendAnalyze(text) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'ih-analyze', text }, (response) => {
        if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
        if (!response?.ok) return reject(new Error(response?.error || 'Analyze failed'));
        resolve(response.data);
      });
    });
  }

  function releaseLocalEngine() {
    chrome.runtime.sendMessage({ type: 'ih-local-unload' }, () => {
      void chrome.runtime.lastError;
    });
  }

  async function fetchTokens(text) {
    const tokens = (await sendAnalyze(text))?.result?.bpe_strings;
    if (!Array.isArray(tokens)) throw new Error('Analyze returned no tokens');
    return tokens;
  }

  async function analyzeSegment(text, segs, index) {
    if (!/\S/.test(segs[index].text)) return [];
    const window = globalThis.IH_segmentWindow(text, segs, index);
    const tokens = await fetchTokens(window.requestText);
    return globalThis.IH_tokensInSegment(tokens, window);
  }

  function clear() {
    session = null;
    globalThis.IH_clearHighlights();
    globalThis.IH_clearProgress();
    globalThis.IH_clearError();
  }

  /** @returns {Promise<Error | undefined>} */
  async function paintSegments(myGeneration, from, to) {
    const { mapped, segs } = session;
    let lastAlignErr;
    for (let i = from; i < to; i++) {
      if (myGeneration !== generation) return;
      let tokens;
      try {
        tokens = await analyzeSegment(mapped.text, segs, i);
      } catch (err) {
        if (myGeneration !== generation) return;
        if (!String(err?.message || err).includes('token offset align failed')) throw err;
        console.warn('[Info Highlight] skip segment', i, err);
        lastAlignErr = err;
        continue;
      }
      if (myGeneration !== generation) return;
      session.painted += globalThis.IH_paintTokens(tokens, mapped, { append: true, overlay: true });
      globalThis.IH_appendProgress(tokens, segs[i]);
    }
    return lastAlignErr;
  }

  function finishBatch(lastAlignErr) {
    globalThis.IH_setProgressSearching(false);
    if (!session.painted) throw lastAlignErr || new Error('No tokens mapped onto the PDF text layer');
    if (session.next < session.segs.length) {
      globalThis.IH_showPaused(continuePaused);
    }
  }

  function continuePaused() {
    if (busy || !session || !enabled) return;
    void runBatch(generation += 1);
  }

  async function guarded(myGeneration, work) {
    busy = true;
    globalThis.IH_clearError();
    globalThis.IH_setProgressSearching(true);
    try {
      await work();
      if (myGeneration !== generation) return;
    } catch (error) {
      if (myGeneration !== generation) return;
      clear();
      globalThis.IH_showError(error?.message || error);
    } finally {
      if (myGeneration === generation) {
        busy = false;
        releaseLocalEngine();
      }
    }
  }

  async function runBatch(myGeneration) {
    await guarded(myGeneration, async () => {
      if (!session) {
        const mapped = extractPdfPage();
        const segs = globalThis.IH_splitSegments(mapped.text);
        if (!segs.length) throw new Error('PDF has no text to analyze');
        globalThis.IH_clearHighlights();
        globalThis.IH_bindProgress(mapped, segs);
        session = { mapped, segs, next: 0, painted: 0 };
      }
      const start = session.next;
      const end = Math.min(start + MAX_SEGMENTS_PER_RUN, session.segs.length);
      const lastAlignErr = await paintSegments(myGeneration, start, end);
      if (myGeneration !== generation) return;
      session.next = end;
      finishBatch(lastAlignErr);
    });
  }

  /** 同文换节点：把已提交的段画回新 textLayer，暂停点不动。 */
  async function remount(myGeneration) {
    let mapped;
    try {
      mapped = extractPdfPage();
    } catch (error) {
      if (myGeneration !== generation) return;
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
    await guarded(myGeneration, async () => {
      const lastAlignErr = await paintSegments(myGeneration, 0, done);
      if (myGeneration !== generation) return;
      finishBatch(lastAlignErr);
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
    releaseLocalEngine();
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
