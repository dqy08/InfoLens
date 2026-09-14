/**
 * 工具栏安装打点。商店仅新安装；unpacked Reload 也打（方便本地看）；升级暂不打。
 * 点图标后清掉。打点图：default_icon 的 16/32 把 .png 换成 -dot.png。
 */
function IL_actionIcons(dotted) {
  const src = chrome.runtime.getManifest().action.default_icon;
  if (!dotted) return src;
  return {
    16: src['16'].replace(/\.png$/, '-dot.png'),
    32: src['32'].replace(/\.png$/, '-dot.png'),
  };
}

globalThis.IL_setActionIconDotted = function IL_setActionIconDotted(dotted) {
  void chrome.action.setIcon({ path: IL_actionIcons(dotted) });
};

globalThis.IL_maybeShowInstallDot = function IL_maybeShowInstallDot(details) {
  const unpacked = !('update_url' in chrome.runtime.getManifest());
  if (details.reason === 'install' || (unpacked && details.reason === 'update')) {
    IL_setActionIconDotted(true);
  }
};
