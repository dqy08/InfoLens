/**
 * 浏览器不让注入的页面。这是关于 Chrome 的事实，不是某个插件的策略——新版禁哪些，两边一起改。
 */
globalThis.IL_isRestrictedUrl = function IL_isRestrictedUrl(url) {
  if (!url) return true;
  let u;
  try {
    u = new URL(url);
  } catch {
    return true;
  }
  const proto = u.protocol;
  if (
    proto === 'chrome:' ||
    proto === 'chrome-extension:' ||
    proto === 'chrome-search:' ||
    proto === 'chrome-untrusted:' ||
    proto === 'devtools:' ||
    proto === 'edge:' ||
    proto === 'about:' ||
    proto === 'view-source:'
  ) {
    return true;
  }
  // Web Store：主 frame 常无法注入
  if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
  if (u.hostname === 'chromewebstore.google.com') return true;
  return false;
};
