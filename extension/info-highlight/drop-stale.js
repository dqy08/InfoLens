/**
 * 注入清单第一份：扩展重载后旧脚本还占着 window，但 chrome.runtime 已作废。
 * 作废则清掉全局，后面的 ||= 才会重新挂上。
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
