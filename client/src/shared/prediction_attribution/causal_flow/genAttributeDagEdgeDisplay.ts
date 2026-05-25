/**
 * 建边剪枝：候选池内 max 归一后的 `normalizedScore` 低于该值不连边；
 * decay 开启时再要求 `mutualInformationRatio × normalizedScore` 不低于本值。
 * 与 {@link DAG_EDGE_RENDER_OPACITY_FLOOR} 独立；数值可分别调整。
 */
export const DAG_EDGE_MIN_NORMALIZED_SCORE = 0.1;

/**
 * 焦点传播 / 高亮剪枝：传播后的节点份额、边份额、下游强度低于该阈值的边/节点不参与追因高亮。
 */
export const DAG_MIN_ATTRIBUTION_SHARE = 0.0001;

/**
 * 归一后 `stroke-opacity` 的显示下限（`Math.max(本常数, scaled)`）：弱边被抬高到此值，而非滤掉。
 * 与 {@link DAG_EDGE_MIN_NORMALIZED_SCORE}（低于则剪枝）语义相反。
 */
export const DAG_EDGE_RENDER_OPACITY_FLOOR = 0;

/**
 * 递归链候选节点描边 `stroke-opacity` 下限：`stay / max(stay)` 线性映射到 `[本值, 1]`。
 * 弱 stay 若直接当 opacity，在链上 max(stay) 较大时会接近 0、描边几乎看不见；抬高下限保留相对强弱对比。
 * 与 {@link DAG_EDGE_RENDER_OPACITY_FLOOR}（边）独立。
 */
export const DAG_NODE_STROKE_OPACITY_BASE = 0.3;
