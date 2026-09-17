/**
 * 本机 init popup 坐标：夹到最后聚焦的宿主窗口内，避免 Chrome
 * 「Bounds must be ≥50% on screen」。不申请 system.display。
 */
globalThis.IH_initWindowBounds ||= (function () {
  const MARGIN = 8;

  /**
   * @param {{ left?: number, top?: number, width?: number, height?: number } | null | undefined} host
   * @param {number} width
   * @param {number} height
   * @returns {{ left: number, top: number } | null} 无宿主几何时省略 left/top，交给浏览器放。
   */
  function clampPopupToHost(host, width, height) {
    if (
      !host
      || !Number.isFinite(host.left)
      || !Number.isFinite(host.top)
      || !(host.width > 0)
      || !(host.height > 0)
      || !Number.isFinite(width)
      || !Number.isFinite(height)
      || !(width > 0)
      || !(height > 0)
    ) {
      return null;
    }
    return {
      left: clampAxis(host.left, host.width, width, MARGIN),
      top: clampAxis(host.top, host.height, height, MARGIN),
    };
  }

  function clampAxis(origin, hostSize, popupSize, margin) {
    if (hostSize < popupSize) return Math.round(origin);
    const centered = origin + (hostSize - popupSize) / 2;
    const inset = Math.min(Math.max(margin, 0), (hostSize - popupSize) / 2);
    const min = origin + inset;
    const max = origin + hostSize - popupSize - inset;
    return Math.round(Math.min(Math.max(centered, min), max));
  }

  function isBoundsError(err) {
    const msg = String(err?.message || err || '');
    if (!msg) return false;
    return /\bbounds\b/i.test(msg) && (/50\s*%/i.test(msg) || /on\s*screen/i.test(msg));
  }

  return { clampPopupToHost, isBoundsError };
})();
