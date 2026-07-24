/**
 * 等待 smooth scroll 结束。返回取消函数。
 *
 * 仅靠 `scrollend` 不够：无位移时浏览器常不触发该事件，会空等到 maxWait。
 * 语义：滚动已结束，或确认未产生滚动。
 */
export function waitForSmoothScrollEnd(
    target: Window | HTMLElement,
    onDone: () => void,
    maxWaitMs = 5000
): () => void {
    let settled = false;

    const getTop = () =>
        target === window ? window.scrollY : (target as HTMLElement).scrollTop;
    const startTop = getTop();

    const settle = () => {
        if (settled) return;
        settled = true;
        dispose();
        onDone();
    };

    const onScrollEnd = () => settle();

    const dispose = () => {
        window.clearTimeout(timeoutId);
        target.removeEventListener('scrollend', onScrollEnd);
    };

    target.addEventListener('scrollend', onScrollEnd, { once: true });

    // 两帧后位置仍未变 → scrollTo 未产生运动，scrollend 不会来
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (Math.abs(getTop() - startTop) < 1) settle();
        });
    });

    const timeoutId = window.setTimeout(settle, maxWaitMs);

    return () => {
        settled = true;
        dispose();
    };
}
