/**
 * Dev 入口变体（源头）：apiBase 打门面 *.workers.dev。
 * 与官方域名同一 Worker。用 dev-env.sh dev 生成 config.js。
 * 除 apiBase / reportUsage 外与 config.prod.js 对齐。
 */
var IH_CONFIG = {
  apiBase: 'https://infolens-api.xiaoyundqy.workers.dev',
  /** 开发入口：服务端可落完整 text 日志 */
  privacyMode: false,
  /** 不上报 install/update/用量，避免污染线上统计 */
  reportUsage: false,
};
