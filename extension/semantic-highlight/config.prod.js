/**
 * 上架默认配置（源头）。pack.sh 会拷成包内 config.js；本地用 dev-env.sh prod 生成。
 * 挂到 globalThis（background importScripts / content 注入顺序加载）。
 */
var IL_CONFIG = {
  apiBase: 'https://api.info-lens.app',
  /** 正式入口：服务端不落 query/text 与明文 IP */
  privacyMode: true,
  /** SYNC: client/src/shared/core/constants.ts → SEMANTIC_MATCH_THRESHOLD */
  matchThreshold: 0.1,
  /**
   * DOM 调试：true = 点击抽正文并下划线；再点取消；
   * false = 正常 Find bar + 语义搜索。
   */
  domDebug: false,
};
