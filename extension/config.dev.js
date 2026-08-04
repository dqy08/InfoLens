/**
 * Dev 入口变体（源头）：apiBase 打门面 *.workers.dev。
 * 与官方域名同一 Worker；远程 relevance 由门面开关控制，与入口无关。
 * 用 dev-env.sh dev 生成 config.js。除 apiBase 外与 config.prod.js 对齐。
 */
var IL_CONFIG = {
  apiBase: 'https://infolens-api.xiaoyundqy.workers.dev',
  /** 开发入口：服务端可落完整 query/text 日志 */
  privacyMode: false,
  /**
   * SYNC: client/src/shared/core/constants.ts → SEMANTIC_CHUNK_BYTES；算法见 splitTextToChunks.js
   * 已知问题：见 config.prod.js 同名字段注释（与后端 token 截断无联动，密集内容会漏检）。
   */
  chunkBytes: 800,
  /** demo 最多请求的 chunk 数，避免一页打爆本地推理 */
  maxChunks: 32,
  /** SYNC: client/src/shared/core/constants.ts → SEMANTIC_MATCH_THRESHOLD */
  matchThreshold: 0.1,
  /**
   * SYNC 近似：
   * - 站内 τ：signalThresholdDetector（失败回退 P90，见 textStatistics.computeP90）
   * - 站内 pw：visualizationUpdater.ts → pw_score = score×P_pw×matchDegree
   * 扩展无 signal-fit，用该分位作 τ（默认 0.9 ≈ P90）；见 content.js prepareChunkTokens
   */
  pwScorePercentile: 0.9,
  /**
   * DOM 调试：true = 点击抽正文并下划线；再点取消；
   * false = 正常 Find bar + 语义搜索。
   */
  domDebug: false,
  /**
   * 扩展侧跟随策略（站内 demo 已无 Follow UI / 搜索中跟随）：
   * true = 全程跟随最新 chunk；false = 无匹配时跟随，首个匹配后停下并划线。
   */
  followSearching: false,
};
