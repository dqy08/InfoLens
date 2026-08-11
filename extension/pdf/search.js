/**
 * InfoLens PDF 语义搜索入口：DocumentAdapter + 共享 SemanticFind。
 * 数据：window.__IL_PDF_DATA__（viewer.js 在全部页渲染并拼接文本后提供）。
 * 开浮条与网页 content.js 一致：始终 open（有选区则预填）；关靠 × / Esc，不用 toggle。
 */
(() => {
  if (!globalThis.IL_CONFIG) {
    console.error('[InfoLens][pdf] IL_CONFIG missing');
    return;
  }
  if (typeof globalThis.IL_createPdfDocumentAdapter !== 'function') {
    console.error('[InfoLens][pdf] IL_createPdfDocumentAdapter missing');
    return;
  }
  if (typeof globalThis.IL_createSemanticFind !== 'function') {
    console.error('[InfoLens][pdf] IL_createSemanticFind missing');
    return;
  }

  /** @type {ReturnType<typeof IL_createSemanticFind> | null} */
  let api = null;

  function ensureApi() {
    if (api) return api;
    const doc = globalThis.IL_createPdfDocumentAdapter(() => window.__IL_PDF_DATA__ || null);
    api = globalThis.IL_createSemanticFind(doc, { barTop: '12px' });
    return api;
  }

  function onBarMessage(msg) {
    try {
      const q = typeof msg?.query === 'string' ? msg.query.trim() : '';
      void ensureApi().open(q);
    } catch (err) {
      console.error('[InfoLens][pdf] open bar failed:', err);
    }
  }

  function ready() {
    if (!window.__IL_PDF_DATA__) {
      console.error('[InfoLens][pdf] __IL_PDF_DATA__ missing');
      return;
    }
    try {
      void ensureApi().open();
    } catch (err) {
      console.error('[InfoLens][pdf] init failed:', err);
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type !== 'il-pdf-open-bar') return;
    onBarMessage(msg);
    return false;
  });

  if (window.__IL_PDF_DATA__) {
    ready();
  } else {
    window.addEventListener('il-pdf-ready', ready, { once: true });
  }
})();
