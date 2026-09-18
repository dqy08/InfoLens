/**
 * 工具栏蓝点：吸引用户点一次。
 * 安装与每次升级时亮起；点工具栏、扩展菜单项、或打开选项页才灭。与选项页未看提示无关。
 * 打点图：default_icon 的 16/32 把 .png 换成 -dot.png。
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
