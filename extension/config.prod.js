/**
 * 上架默认配置（源头）。pack.sh 会拷成包内 config.js；本地用 dev-env.sh prod 生成。
 * 挂到 globalThis（background importScripts / content 注入顺序加载）。
 */
var IL_CONFIG = {
  apiBase: 'https://dqy08-infolens.hf.space',
  /**
   * SYNC: client/src/shared/core/constants.ts → SEMANTIC_CHUNK_BYTES；算法见 splitTextToChunks.js
   * 已知问题：与后端 SEMANTIC_RUNTIME_CONFIGS 的 max_token_length（300~1000 token，按平台）无联动。
   * 数字/标点/代码等 token 密度高的内容，800 字节可能超出后端 token 限，被静默截断（仅日志提示），
   * 导致该 chunk 的相关度判断只基于截断后的前缀 —— 后果是漏检，非误报。无法靠调大固定 token 数根治。
   */
  chunkBytes: 800,
  /** demo 最多请求的 chunk 数，避免一页打爆本地推理 */
  maxChunks: 32,
  /** SYNC: client/src/shared/core/constants.ts → SEMANTIC_MATCH_THRESHOLD */
  matchThreshold: 0.1,
  /** SYNC: analysis 默认 hybrid（前端组合 count→fill_blank，非后端枚举值） */
  submode: 'hybrid',
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
