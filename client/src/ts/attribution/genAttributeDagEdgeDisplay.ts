/**
 * DAG 边最终 `stroke-opacity`（`normalizedScore × mutualInformationRatio`）的下限：
 * 小于该值的边不进入图中展示。
 *
 * 与同数值在 `genAttributeDagPreprocess.ts` 池内前缀选取里 `relativeFloor = 常数 × topFrac` 复用：
 * max 归一后首条 `normalizedScore === 1`，故低于该相对份额的条目不可能在 MI≤1 下达到本阈值，属提前筛除。
 */
export const DAG_EDGE_MIN_DISPLAY_OPACITY = 0.1;
