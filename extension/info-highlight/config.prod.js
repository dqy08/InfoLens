/**
 * 上架默认配置（源头）。pack.sh 会拷成包内 config.js；本地用 dev-env.sh prod 生成。
 * 挂到 globalThis（background importScripts）。
 */
var IH_CONFIG = {
  apiBase: 'https://api.info-lens.app',
  /** 正式入口：服务端不落 text 与明文 IP */
  privacyMode: true,
  /** 安装/更新/分析轮次用量上报 */
  reportUsage: true,
};
