/**
 * 滚动容器与「文档 Y」的换算：正文可能在窗口里滚，也可能在某个内层面板里滚，
 * 两种情形下 clientY ↔ 内容 Y、视口范围、滚到某个 Y 的算法都不同。
 * 这些是关于页面的事实（与画什么无关），两插件必须给出同一个答案。
 *
 * 轴（axis）= 正文根在滚动内容里的 Y 跨度，进度图的横轴就是它。
 */
globalThis.IL_scrollGeometry = (() => {
  function isWindowScrollRoot(scrollRoot) {
    return (
      scrollRoot === document.scrollingElement ||
      scrollRoot === document.documentElement ||
      scrollRoot === document.body
    );
  }

  function isScrollableEl(el) {
    if (!(el instanceof Element)) return false;
    const st = getComputedStyle(el);
    const y = st.overflowY;
    const x = st.overflowX;
    const canY =
      (y === 'auto' || y === 'scroll' || y === 'overlay') && el.scrollHeight > el.clientHeight + 1;
    const canX =
      (x === 'auto' || x === 'scroll' || x === 'overlay') && el.scrollWidth > el.clientWidth + 1;
    return canY || canX;
  }

  /** 自 from 向上找最近的可滚容器；没有则退回窗口滚动根。 */
  function findScrollRoot(from) {
    let node = from instanceof Element ? from : from?.parentElement;
    while (node && node !== document.documentElement) {
      if (isScrollableEl(node)) return node;
      node = node.parentElement;
    }
    return document.scrollingElement || document.documentElement;
  }

  function contentYFromClientY(clientY, scrollRoot) {
    if (!scrollRoot || isWindowScrollRoot(scrollRoot)) return window.scrollY + clientY;
    const panel = /** @type {HTMLElement} */ (scrollRoot);
    return clientY - panel.getBoundingClientRect().top + panel.scrollTop;
  }

  /** 视口顶/底在滚动内容中的 Y */
  function viewportContentY(scrollRoot) {
    if (!scrollRoot || isWindowScrollRoot(scrollRoot)) {
      return { top: window.scrollY, bottom: window.scrollY + window.innerHeight };
    }
    const panel = /** @type {HTMLElement} */ (scrollRoot);
    return { top: panel.scrollTop, bottom: panel.scrollTop + panel.clientHeight };
  }

  /**
   * @returns {null | { y0: number, y1: number, span: number, scrollRoot: Element }}
   */
  function axisYRange(root, scrollRoot) {
    if (!root?.isConnected) return null;
    const rect = root.getBoundingClientRect();
    const y0 = contentYFromClientY(rect.top, scrollRoot);
    const y1 = contentYFromClientY(rect.bottom, scrollRoot);
    if (!(y1 > y0)) return null;
    return { y0, y1, span: y1 - y0, scrollRoot };
  }

  function xFromContentY(y, x0, x1, axis) {
    return x0 + ((x1 - x0) * (y - axis.y0)) / axis.span;
  }

  function contentYFromX(x, x0, x1, axis) {
    if (!(x1 > x0)) return axis.y0;
    const t = Math.max(0, Math.min(1, (x - x0) / (x1 - x0)));
    return axis.y0 + t * axis.span;
  }

  /** 把内容 Y 摆到视口 ratio 处所需的 scrollTop；夹在可滚范围内。 */
  function scrollTopAtContentY(contentY, scrollRoot, viewportYRatio) {
    if (isWindowScrollRoot(scrollRoot)) {
      const ideal = contentY - window.innerHeight * viewportYRatio;
      const maxScroll = Math.max(
        0,
        (document.scrollingElement || document.documentElement).scrollHeight - window.innerHeight
      );
      return { target: window, top: Math.max(0, Math.min(ideal, maxScroll)) };
    }
    const panel = /** @type {HTMLElement} */ (scrollRoot);
    const maxScroll = Math.max(0, panel.scrollHeight - panel.clientHeight);
    return {
      target: panel,
      top: Math.max(0, Math.min(contentY - panel.clientHeight * viewportYRatio, maxScroll)),
    };
  }

  return {
    isWindowScrollRoot,
    isScrollableEl,
    findScrollRoot,
    contentYFromClientY,
    viewportContentY,
    axisYRange,
    xFromContentY,
    contentYFromX,
    scrollTopAtContentY,
  };
})();
