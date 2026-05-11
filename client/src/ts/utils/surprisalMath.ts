/**
 * 惊讶度与信息量的数学基础模块。
 * 颜色映射相关常量见 {@link SurprisalColorConfig}。
 */

/**
 * 零信心概率基准 p₀：surprisal log₂(1/p₀) 视作单 token 的绝对信息量参照。
 * 超过此值视为模型已无法有效预测，各处可视化统一在此封顶。
 * 此处为 18 bit，大致对应模型的词表大小256K时的平均token概率。
 */
export const ZERO_CONFIDENCE_PROBABILITY_BASELINE = 2 ** -18;

/** 与 p₀ 对应的参照 surprisal 上界（bit）；同时作为 token 着色标尺上限。 */
export const REFERENCE_MAX_SURPRISAL_BITS = Math.log2(1 / ZERO_CONFIDENCE_PROBABILITY_BASELINE);

/**
 * 全信心概率阈值 p₁：surprisal 低于对应 bit 数时视作模型已充分自信，视觉上不放大节点。
 * 此处为 3 bit，对应概率 > 1/8（约 12.5%）。
 */
export const FULL_CONFIDENCE_PROBABILITY_BASELINE = 2 ** -3;

/** 与 p₁ 对应的 surprisal 下界（bit）；低于此值的节点 ciVisualScale 截断为 1×。 */
export const REFERENCE_NO_SURPRISAL_BITS = Math.log2(1 / FULL_CONFIDENCE_PROBABILITY_BASELINE);

function clamp01(n: number): number {
    return Math.min(1, Math.max(0, n));
}

/**
 * 互信息率 α：在参照熵 log₂(1/p₀) 下，将「前文与目标 token 的可对齐程度」
 * (log₂(1/p₀) − log₂(1/p)) / log₂(1/p₀) = log₂(p/p₀) / log₂(1/p₀) clamp 到 [0,1]。
 * 低 surprisal → 高 α；仅用于本步入边透明度，不参与边筛选。缺省 `target_prob` 时返回 1（兼容旧缓存）。
 */
export function computeMutualInformationRatio(targetProb: number | undefined): number {
    if (targetProb === undefined) return 1;
    if (!Number.isFinite(targetProb) || targetProb <= 0) return 0;
    return clamp01(
        Math.log2(targetProb / ZERO_CONFIDENCE_PROBABILITY_BASELINE) / REFERENCE_MAX_SURPRISAL_BITS
    );
}

/**
 * 条件信息量比率 CI：surprisal/max = (−log₂ p) / log₂(1/p₀) clamp 到 [0,1]，
 * 与 {@link computeMutualInformationRatio} 对称（同 p 下 CI + MI = 1）。
 * 缺省 `target_prob` 时返回 0；非法或 p≤0 时返回 1。
 */
export function computeConditionalInformationRatio(targetProb: number | undefined): number {
    if (targetProb === undefined) return 0;
    if (!Number.isFinite(targetProb) || targetProb <= 0) return 1;
    return clamp01(-Math.log2(targetProb) / REFERENCE_MAX_SURPRISAL_BITS);
}
