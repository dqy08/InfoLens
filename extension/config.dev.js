/**
 * Dev 入口变体（源头）：apiBase 打门面 *.workers.dev。
 * 与官方域名同一 Worker；远程 relevance 由门面开关控制，与入口无关。
 * 用 dev-env.sh dev 生成 config.js。除 apiBase 外与 config.prod.js 对齐。
 */
var IL_CONFIG = {
  apiBase: 'https://infolens-api.xiaoyundqy.workers.dev',
  /** 开发入口：服务端可落完整 query/text 日志 */
  privacyMode: false,
  /** SYNC: client/src/shared/core/constants.ts → SEMANTIC_MATCH_THRESHOLD */
  matchThreshold: 0.1,
  /**
   * DOM 调试：true = 点击抽正文并下划线；再点取消；
   * false = 正常 Find bar + 语义搜索。
   */
  domDebug: false,
};