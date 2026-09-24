/**
 * 云端 Analyze 冷启动时，这一次请求会等到容器起来再返回。
 * 一轮里第一次分析若超过 FIRST_SEGMENT_WAIT_MS 仍未返回，再显示冷启动条。
 */
globalThis.IH_cloudWait ||= (function () {
  const FIRST_SEGMENT_WAIT_MS = 2000;
  const LABEL_BASE = 'Cold starting';
  const DOT_INTERVAL_MS = 400;

  /** @param {number} [dotIndex] 0→`.` 1→`..` 2→`...`，循环 */
  function status(dotIndex = 0) {
    const i = ((Number(dotIndex) | 0) % 3 + 3) % 3;
    const dots = '.'.repeat(i + 1);
    return { label: `${LABEL_BASE} ${dots}`, detail: '' };
  }

  return {
    FIRST_SEGMENT_WAIT_MS,
    LABEL_BASE,
    DOT_INTERVAL_MS,
    status,
  };
})();
