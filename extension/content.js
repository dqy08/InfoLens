/**
 * InfoLens semantic find — webpage entry.
 * Validates: article extract ↔ DOM map, API call, token paint, chunk underline.
 *
 * IL_CONFIG.domDebug：点击后只抽正文并下划线，便于目测提取范围（不唤起 Find bar）。
 */
(() => {
  // 已注入过：直接 reopen
  if (window.__IL_SEMANTIC_DEMO__) {
    window.__IL_SEMANTIC_DEMO__.open();
    return;
  }

  if (!globalThis.IL_CONFIG) {
    throw new Error('IL_CONFIG missing — inject config.js before content.js');
  }
  if (typeof globalThis.IL_createPageDocumentAdapter !== 'function') {
    throw new Error('IL_createPageDocumentAdapter missing — inject semantic/page-document.js before content.js');
  }
  if (typeof globalThis.IL_createSemanticFind !== 'function') {
    throw new Error('IL_createSemanticFind missing — inject semantic/find.js before content.js');
  }

  const doc = globalThis.IL_createPageDocumentAdapter();
  const api = globalThis.IL_createSemanticFind(doc, { barTop: '12px' });
  window.__IL_SEMANTIC_DEMO__ = api;
  void api.open();
})();
