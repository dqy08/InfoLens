/**
 * 进度图横轴上的段几何：从 Range 里取可视矩形、换成文档 Y、再按段增量铺线。
 * 取 Range 的方式两边不同（码点 → DOM），由调用方传入；铺线规则必须同一份。
 *
 * 后一段从上一线终点起：空隙并进本段，重叠归前一段。
 */
globalThis.IL_progressAxis = (() => {
  /** 段内第一块 / 最后一块可视矩形。空白 Range 跳过。 */
  function visibleRectsInRanges(ranges) {
    let first = null;
    let last = null;
    for (const range of ranges) {
      if (!/\S/.test(range.toString())) continue;
      for (const r of range.getClientRects()) {
        if (r.width < 1 || r.height < 1) continue;
        if (!first) first = r;
        last = r;
      }
    }
    return { first, last };
  }

  /** @returns {null | { y0: number, y1: number }} */
  function contentYFromRects(startRect, endRect, scrollRoot) {
    if (!startRect && !endRect) return null;
    const geo = globalThis.IL_scrollGeometry;
    if (!geo) throw new Error('IL_scrollGeometry missing — inject scrollGeometry.js first');
    const top = startRect || endRect;
    const bot = endRect || startRect;
    let y0 = geo.contentYFromClientY(top.top, scrollRoot);
    let y1 = geo.contentYFromClientY(bot.bottom, scrollRoot);
    if (y1 < y0) {
      const t = y0;
      y0 = y1;
      y1 = t;
    }
    return { y0, y1 };
  }

  /**
   * 块在滚动内容中的 Y（起止）；cache 按 chunk.start，布局未变可复用。
   * @param {{ start: number, end: number }} chunk
   * @param {Element | null} scrollRoot
   * @param {Map<number, { y0: number, y1: number }>} cache
   * @param {(cp0: number, cp1: number) => Iterable<Range>} rangesFromCp
   * @returns {null | { y0: number, y1: number }}
   */
  function measureChunkContentY(chunk, scrollRoot, cache, rangesFromCp) {
    const hit = cache.get(chunk.start);
    if (hit) return hit;
    const { first, last } = visibleRectsInRanges(rangesFromCp(chunk.start, chunk.end));
    const row = contentYFromRects(first, last, scrollRoot);
    if (row) cache.set(chunk.start, row);
    return row;
  }

  /** 后一段从上一线终点起：空隙并进本段，重叠归前一段。 */
  function axisYFromPrev(cy, prevY1) {
    if (!cy) return null;
    const y0 = prevY1 != null ? prevY1 : cy.y0;
    return { y0, y1: Math.max(y0, cy.y1) };
  }

  function tileProgressRows(rows) {
    let prevY1 = null;
    return rows.map(({ chunk, cy }) => {
      const axisY = axisYFromPrev(cy, prevY1);
      prevY1 = axisY.y1;
      return { chunk, cy, axisY };
    });
  }

  return { measureChunkContentY, tileProgressRows };
})();
