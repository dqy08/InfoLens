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
 * 全信心概率阈值 p₁（2 bit，p > 1/4）：surprisal 足够低时视为充分自信、DAG 传导节点（非信息来源）。
 *
 * 硬截断仅经本文件三个 `dag*` 函数进入 Generate & Attribute DAG：
 * - {@link dagCiVisualScaleFromTargetProb} → `genAttributeDagView`：生成节点框/标签不放大（1×）
 * - {@link dagStepDownEffectiveCiRatio} → `genAttributeDagViewLinearArcMode`：`linear-arc-step-down` 无竖直台阶
 * - {@link dagPropagationMiRatio} → `genAttributeDagView` `nodePropagationMiRatio`：递归链满额传导、无 stay 描边
 *
 * 不用于 tooltip 与边上的 CI/MI 展示（仍 {@link computeMutualInformationRatio} / {@link computeConditionalInformationRatio}）。
 */
export const FULL_CONFIDENCE_PROBABILITY_BASELINE = 2 ** -2;

/** 与 p₁ 对应的 surprisal 上界（bit）；surprisal ≤ 此值即满足「充分自信」截断条件。 */
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

/**
 * DAG 生成节点 CI 视觉缩放倍数（约 `[1, 2]`）：语义为 `1 +` 有效 CI。
 * `ciVisualScaleEnabled === false` 或 `p > {@link FULL_CONFIDENCE_PROBABILITY_BASELINE}` 时为 `1×`；
 * 否则为 `1 + {@link computeConditionalInformationRatio}(p)`。
 */
export function dagCiVisualScaleFromTargetProb(
    targetProb: number | undefined,
    ciVisualScaleEnabled: boolean
): number {
    if (!ciVisualScaleEnabled) return 1;
    if (targetProb !== undefined && Number.isFinite(targetProb) && targetProb > FULL_CONFIDENCE_PROBABILITY_BASELINE) {
        return 1;
    }
    return 1 + computeConditionalInformationRatio(targetProb);
}

/**
 * 仅用于 DAG「下台阶」布局的有效 CI（`[0,1]`）：与 {@link computeConditionalInformationRatio} 同源，
 * 但 `p > {@link FULL_CONFIDENCE_PROBABILITY_BASELINE}` 时为 0（与节点「高置信 1×」截断一致）。
 *
 * 不受「关闭 CI 视觉放大」开关影响——该开关只缩节点框，不应关掉按不确定度的竖直落差。
 */
export function dagStepDownEffectiveCiRatio(targetProb: number | undefined): number {
    if (targetProb !== undefined && Number.isFinite(targetProb) && targetProb > FULL_CONFIDENCE_PROBABILITY_BASELINE) {
        return 0;
    }
    return computeConditionalInformationRatio(targetProb);
}

/**
 * DAG 递归归因链的传导系数（`[0,1]`）：与 {@link computeMutualInformationRatio} 同源，
 * 但 `p > {@link FULL_CONFIDENCE_PROBABILITY_BASELINE}` 时截断为 1（纯传导，不衰减预算、不留 stay）。
 * 与节点视觉（不放大）、下台阶（不下沉）的「充分自信」语义保持一致。
 */
export function dagPropagationMiRatio(targetProb: number | undefined): number {
    if (targetProb !== undefined && Number.isFinite(targetProb) && targetProb > FULL_CONFIDENCE_PROBABILITY_BASELINE) {
        return 1;
    }
    return computeMutualInformationRatio(targetProb);
}
