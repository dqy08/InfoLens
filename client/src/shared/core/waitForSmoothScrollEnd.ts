/** 等待 smooth scroll 结束：`scrollend` + 超时兜底。返回取消函数。 */
export function waitForSmoothScrollEnd(
    target: Window | HTMLElement,
    onDone: () => void,
    maxWaitMs = 5000
): () => void {
    let settled = false;
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
    const timeoutId = window.setTimeout(settle, maxWaitMs);

    return () => {
        settled = true;
        dispose();
    };
}
