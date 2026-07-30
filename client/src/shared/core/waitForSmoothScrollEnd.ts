/**
 * 等到滚动到达 expectedTop，或 scrollend，或超时。返回取消函数。
 *
 * - 已在目标附近：立即结束（无位移时 scrollend 常不触发）
 * - 滚动中：位置接近目标，或浏览器 scrollend → 结束
 * - 不靠「两帧未动」猜测；超时只作兜底
 */
export function waitForSmoothScrollEnd(
    target: Window | HTMLElement,
    expectedTop: number,
    onDone: () => void,
    maxWaitMs = 2000
): () => void {
    let settled = false;
    let timeoutId = 0;

    const getTop = () =>
        target === window ? window.scrollY : (target as HTMLElement).scrollTop;

    const settle = () => {
        if (settled) return;
        settled = true;
        dispose();
        onDone();
    };

    const check = () => {
        if (Math.abs(getTop() - expectedTop) < 1) settle();
    };

    const onScrollEnd = () => settle();

    const dispose = () => {
        if (timeoutId) window.clearTimeout(timeoutId);
        target.removeEventListener('scroll', check);
        target.removeEventListener('scrollend', onScrollEnd);
    };

    target.addEventListener('scroll', check, { passive: true });
    target.addEventListener('scrollend', onScrollEnd, { once: true });
    check();
    if (!settled) timeoutId = window.setTimeout(settle, maxWaitMs);

    return () => {
        settled = true;
        dispose();
    };
}
