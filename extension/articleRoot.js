/**
 * 定根：text/plain 整页即正文；其余走 Readability（预打标 → clone → data-il-rid 映回）。
 * Readability 失败抛错，不回退启发式。
 */
(() => {
  const ATTR = 'data-il-rid';

  /**
   * 浏览器对 text/plain（.txt / .py raw 等）的原生查看器：整页即正文。
   * @param {Document} doc
   * @returns {Element | null}
   */
  function findPlainTextRoot(doc) {
    if (!doc.body) return null;
    if (doc.contentType === 'text/plain') return doc.body;
    return null;
  }

  function mark(doc) {
    if (!doc.body) return;
    let seq = 0;
    // body 本身也要打标：Readability 退到合成根时映回 page/body
    doc.body.setAttribute(ATTR, String(++seq));
    for (const el of doc.body.querySelectorAll('*')) {
      el.setAttribute(ATTR, String(++seq));
    }
  }

  function unmark(doc) {
    if (!doc.body) return;
    doc.body.removeAttribute(ATTR);
    for (const el of doc.body.querySelectorAll(`[${ATTR}]`)) {
      el.removeAttribute(ATTR);
    }
  }

  /**
   * @param {Document} doc
   * @returns {Element}
   */
  function findArticleRoot(doc) {
    if (!doc?.body) {
      throw new Error('document.body missing');
    }

    const plain = findPlainTextRoot(doc);
    if (plain) return plain;

    if (typeof Readability !== 'function') {
      throw new Error('Readability missing — inject vendor/Readability.js first');
    }

    mark(doc);
    try {
      const clone = doc.cloneNode(true);
      const reader = new Readability(clone);
      const parsed = reader.parse();
      if (!parsed) {
        throw new Error('Readability: parse failed');
      }
      const rid = reader._ilArticleRootRid;
      if (rid == null || rid === '') {
        throw new Error('Readability: no mappable article root');
      }
      const root = doc.querySelector(`[${ATTR}="${CSS.escape(String(rid))}"]`);
      if (!root) {
        throw new Error(`Readability: live root not found (rid=${rid})`);
      }
      return root;
    } finally {
      unmark(doc);
    }
  }

  globalThis.IL_findArticleRoot = findArticleRoot;
})();
