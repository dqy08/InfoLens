/**
 * PDF 信息量标记：viewer 提供阅读序全文和 textLayer 节点；缩放重建 textLayer 后，
 * 重新建立映射并从本地分析缓存恢复绘制。
 */
(() => {
  const MAX_SEGMENTS_PER_RUN = 32;
  let generation = 0;
  let busy = false;
  let enabled = true;

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

  async function analyzeSegment(text, segs, index) {
    if (!/\S/.test(segs[index].text)) return [];
    const window = globalThis.IH_segmentWindow(text, segs, index);
    const tokens = await globalThis.IH_analyzeCache.tokens(window.requestText, async (requestText) => {
      const result = (await sendAnalyze(requestText))?.result?.bpe_strings;
      if (!Array.isArray(result)) throw new Error('Analyze returned no tokens');
      return result;
    });
    return globalThis.IH_tokensInSegment(tokens, window);
  }

  function clear() {
    globalThis.IH_clearHighlights();
    globalThis.IH_clearProgress();
    globalThis.IH_clearError();
  }

  async function run(myGeneration) {
    busy = true;
    try {
      const mapped = extractPdfPage();
      const segs = globalThis.IH_splitSegments(mapped.text);
      if (!segs.length) throw new Error('PDF has no text to analyze');
      clear();
      globalThis.IH_bindProgress(mapped, segs);
      globalThis.IH_setProgressSearching(true);
      let painted = 0;
      for (let i = 0; i < segs.length; i++) {
        if (myGeneration !== generation) return;
        const tokens = await analyzeSegment(mapped.text, segs, i);
        if (myGeneration !== generation) return;
        painted += globalThis.IH_paintTokens(tokens, mapped, { append: true, overlay: true });
        globalThis.IH_appendProgress(tokens, segs[i]);
        if ((i + 1) % MAX_SEGMENTS_PER_RUN === 0) await new Promise(requestAnimationFrame);
      }
      if (!painted) throw new Error('No tokens mapped onto the PDF text layer');
    } catch (error) {
      if (myGeneration === generation) {
        clear();
        globalThis.IH_showError(error?.message || error);
      }
    } finally {
      if (myGeneration === generation) {
        globalThis.IH_setProgressSearching(false);
        busy = false;
      }
    }
  }

  function restart() {
    if (!enabled) return;
    const next = ++generation;
    if (busy) busy = false;
    void run(next);
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
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'ih-pdf-toggle') return;
    chrome.tabs.getCurrent((tab) => {
      if (tab?.id === message.tabId) toggle();
    });
  });

  window.addEventListener('il-pdf-ready', restart);
  // The old Range objects point to removed text nodes after zoom, so all highlights
  // must be recreated against the new text layer.
  window.addEventListener('il-pdf-rerendered', restart);
  if (window.__IL_PDF_DATA__) restart();
})();
