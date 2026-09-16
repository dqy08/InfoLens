/**
 * 本机 backend（源头）。用 dev-env.sh dev 生成 config.js。
 * 除 apiBase 外与 config.prod.js 对齐。
 */
var IH_CONFIG = {
  apiBase: 'http://localhost:5001',
  /** 开发入口：服务端可落完整 text 日志 */
  privacyMode: false,
};
