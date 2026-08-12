/**
 * 正文定根的手动修补管线（Readability 映回之后）。
 * 每个 patch: (root, doc) => Element，按序执行；以后在 `patches` 里追加即可。
 */
(() => {
  /** 同级前方「像正文」的最少字符数（过短视为导航/装饰） */
  const MIN_PRECEDING_CHARS = 200;
  /** 超过此链接密度视为菜单/侧栏，不触发升根 */
  const MAX_PRECEDING_LINK_DENSITY = 0.25;

  /**
   * @param {Element} node
   * @returns {{ chars: number, linkDensity: number }}
   */
  function precedingStats(node) {
    const parent = node.parentElement;
    if (!parent) return { chars: 0, linkDensity: 0 };

    let chars = 0;
    let linkChars = 0;
    for (let sib = parent.firstChild; sib && sib !== node; sib = sib.nextSibling) {
      if (sib.nodeType === Node.TEXT_NODE) {
        chars += sib.textContent.length;
        continue;
      }
      if (sib.nodeType !== Node.ELEMENT_NODE) continue;
      const tag = sib.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT') continue;
      const t = sib.textContent || '';
      chars += t.length;
      if (tag === 'A') linkChars += t.length;
      for (const a of sib.querySelectorAll('a')) {
        linkChars += a.textContent.length;
      }
    }
    return { chars, linkDensity: chars > 0 ? linkChars / chars : 0 };
  }

  /**
   * Readability 误选拖尾簇（脚注/评论等）时：同级前方若有大段低链接密度文本，升到父级。
   * 不假设正文一定比附录长。
   * 经典例：https://www.marxists.org/chinese/marx/capital/08.htm
   * （扁平 br 正文 + 脚注大 span；Readability 定根到 [35] 起的脚注区）
   * @param {Element} root
   * @param {Document} doc
   * @returns {Element}
   */
  function widenIfPrecedingArticleExcluded(root, doc) {
    const body = doc.body;
    if (!body || !root || !body.contains(root)) return root;

    let node = root;
    while (node !== body) {
      const { chars, linkDensity } = precedingStats(node);
      if (chars >= MIN_PRECEDING_CHARS && linkDensity <= MAX_PRECEDING_LINK_DENSITY) {
        const parent = node.parentElement;
        if (!parent) break;
        node = parent;
        continue;
      }
      break;
    }
    return node;
  }

  /** @type {Array<(root: Element, doc: Document) => Element>} */
  const patches = [widenIfPrecedingArticleExcluded];

  /**
   * @param {Element} root
   * @param {Document} doc
   * @returns {Element}
   */
  function applyExtractRootPatches(root, doc) {
    let r = root;
    for (const patch of patches) {
      r = patch(r, doc);
    }
    return r;
  }

  globalThis.IL_applyExtractRootPatches = applyExtractRootPatches;
})();
