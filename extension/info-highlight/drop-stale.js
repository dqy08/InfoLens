/**
 * 注入清单第一份：扩展重载后旧脚本还占着 window，但 chrome.runtime 已作废。
 * 作废则清掉全局，后面的 ||= 才会重新挂上。
 * 重载会换隔离世界，本文件清不到旧世界；那种情况由 background 拒绝再注入、请用户刷新。
 */
(() => {
  const api = window.__IH_DEMO__;
  try {
    if (typeof api?.isLive === 'function' && api.isLive()) return;
  } catch {
    /* 作废 */
  }
  try {
    globalThis.IH_tokenTip?.clear();
  } catch {
    /* 作废 */
  }
  delete window.__IH_DEMO__;
  delete globalThis.IH_analyzeRun;
  delete globalThis.IL_overlay;
  delete globalThis.IH_tokenTip;
})();
