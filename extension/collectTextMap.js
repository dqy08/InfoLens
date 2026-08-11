/**
 * 从正文根收集可见文本节点与 UTF-16 偏移（与高亮 pieces 同源）。
 * 只提当前可呈现节点：提取 ≡ 可见 ≡ 可画。
 */
(() => {
  /**
   * @param {Element} root
   * @returns {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root: Element }}
   */
  function collectTextMap(root) {
    const out = [];
    let text = '';
    /** 同父节点可见性只算一次（一篇正文大量文本节点共享父元素） */
    const visCache = new WeakMap();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' || tag === 'TEXTAREA' || tag === 'SVG') {
          return NodeFilter.FILTER_REJECT;
        }
        if (p.closest('#il-find-root, #il-overlay-host, #il-out-of-scope-mask, [data-il-underline]')) {
          return NodeFilter.FILTER_REJECT;
        }
        // 折叠/hidden/MathML annotation 等不可见文本不送语义；
        // 公式只剩 MathML 摊平字符（如 dmodel=512），不用 alttext/LaTeX。
        let visible = visCache.get(p);
        if (visible === undefined) {
          visible = typeof p.checkVisibility === 'function' ? p.checkVisibility() : true;
          visCache.set(p, visible);
        }
        if (!visible) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    let n;
    while ((n = walker.nextNode())) {
      const value = n.nodeValue;
      const start = text.length;
      text += value;
      out.push({ node: n, start, end: text.length });
    }
    return { text, pieces: out, root };
  }

  globalThis.IL_collectTextMap = collectTextMap;
})();
