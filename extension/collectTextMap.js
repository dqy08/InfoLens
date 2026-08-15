/**
 * 从正文根收集可见文本节点与 UTF-16 偏移（与高亮 pieces 同源）。
 * 只提当前可呈现节点：提取 ≡ 可见 ≡ 可画。
 */
(() => {
  /**
   * 在 background 任务里跑 work（省略则空让一次）。
   * 计算必须放进回调：await 之后的续跑是微任务，仍会挡住绘制 / 输入。
   */
  function yieldToMain(work) {
    return globalThis.scheduler.postTask(work || (() => {}), { priority: 'background' });
  }
  globalThis.IL_yieldToMain = yieldToMain;

  function createCollector(root) {
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
        if (p.closest('#il-find-root, #il-overlay-host, #il-scope-divider-host, #il-scope-divider, [data-il-underline]')) {
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
    return {
      step() {
        const n = walker.nextNode();
        if (!n) return false;
        const value = n.nodeValue;
        const start = text.length;
        text += value;
        out.push({ node: n, start, end: text.length });
        return true;
      },
      result() {
        return { text, pieces: out, root };
      },
    };
  }

  /**
   * @param {Element} root
   * @returns {{ text: string, pieces: Array<{ node: Text, start: number, end: number }>, root: Element }}
   */
  function collectTextMap(root) {
    const c = createCollector(root);
    while (c.step()) {}
    return c.result();
  }

  const YIELD_MS = 8;

  /**
   * 与 collectTextMap 同结果；每 YIELD_MS 让出主线程，开栏期间可打字。
   * @param {Element} root
   * @param {() => boolean} [isStale]
   */
  async function collectTextMapAsync(root, isStale) {
    const c = createCollector(root);
    for (;;) {
      const done = await yieldToMain(() => {
        if (isStale?.()) {
          throw new DOMException('The operation was aborted.', 'AbortError');
        }
        const t0 = performance.now();
        while (c.step()) {
          if (isStale?.()) {
            throw new DOMException('The operation was aborted.', 'AbortError');
          }
          if (performance.now() - t0 >= YIELD_MS) return false;
        }
        return true;
      });
      if (done) break;
    }
    return c.result();
  }

  globalThis.IL_collectTextMap = collectTextMap;
  globalThis.IL_collectTextMapAsync = collectTextMapAsync;
})();
