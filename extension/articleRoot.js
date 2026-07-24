/**
 * 定根：Chrome 纯文本查看器（body 下仅一个 <pre>）直接用 body；
 * 其余走 Readability（预打标 → clone 上跑算法 → data-il-rid 映回）。
 * Readability 失败抛错，不回退启发式。
 */
(() => {
  const ATTR = 'data-il-rid';

  /** 扩展注入的宿主，不算页面内容子节点 */
  function isExtensionHost(el) {
    const id = el.id;
    return id === 'il-find-root' || id === 'il-overlay-host';
  }

  /**
   * Chrome/WebKit 对 text/plain 等的包装：<body><pre>…</pre></body>
   * @param {Document} doc
   * @returns {Element | null}
   */
  function findPlainTextRoot(doc) {
    const body = doc.body;
    if (!body) return null;
    const kids = [];
    for (const el of body.children) {
      if (!isExtensionHost(el)) kids.push(el);
    }
    if (kids.length === 1 && kids[0].tagName === 'PRE') return body;
    return null;
  }

  function mark(doc) {
    if (!doc.body) return;
    let seq = 0;
    for (const el of doc.body.querySelectorAll('*')) {
      el.setAttribute(ATTR, String(++seq));
    }
  }

  function unmark(doc) {
    if (!doc.body) return;
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
