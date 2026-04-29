import {
    readStoredEffectiveExcludeGeneratedPatternsText,
    readStoredEffectiveExcludePromptPatternsText,
} from './attributionExcludePromptPatternsStorage';
import {
    collectExcludeRegexMatchIntervals,
    isOffsetSpanFullyExcluded,
} from './attributionDisplayModel';
import type { NodeAggregatedEntry } from './genAttributeDagIntervalResolve';
import type { TokenGenStep } from './tokenGenAttributionRunner';
import { getAttentionRawScore } from '../utils/semanticUtils';

/** 与 DAG 节点 id 一致：来自 API `token_attribution` 几何（按 offset 去重，独立于 exclude/归一化）。 */
export type PromptTokenSpan = {
    offset: [number, number];
    raw: string;
};

/** 每步在 exclude 之后按 `score` 降序取前 N 条作为候选池，避免长上下文长尾稀释。 */
// 经验值，最后能筛选出大概一半的归因数
const DAG_EDGE_TOP_N = 10;
// todo: 用户配置归因力度
/** 候选池内累计份额阈值（Top-P），用于保留主要解释力。 */
const DAG_EDGE_CUMULATIVE_SHARE = 0.7;
/** 候选池内相对最强条目的下限系数：池内 L1 份额小于该比例×首条份额时停止。 */
// topShare 的线有最大的透明度，所以这里对应的是最小的透明度是最大透明度的比例
const DAG_EDGE_RELATIVE_TOP_SHARE_FLOOR_BETA = 0.1;

/**
 * 按 `score` 降序排序后取前 min(N, length) 项。
 * 会 **原地** `sort` 输入数组（与池内 `poolMassFrac` 次序一致，调用方无需再按份额排序）。
 */
function selectTopNByScore<T extends { score: number }>(effective: T[], n: number): T[] {
    effective.sort((a, b) => b.score - a.score);
    return effective.slice(0, Math.min(n, effective.length));
}

/** Top-N 候选池内一行：max 归一后的 `score`、rawScore，以及池内正质量上的 L1 份额 `poolMassFrac`（仅预处理内部使用）。 */
type DagPoolNormRow<T> = T & { score: number; rawScore: number; poolMassFrac: number };

/** 候选池内 max 归一、rawScore、以及各条目在池内 Σscore 上的 L1 份额（保留其余字段如 nodeId）。 */
function normalizeTopNPoolForDagSparse<T extends { score: number }>(tokens: T[]): Array<DagPoolNormRow<T>> {
    const max = Math.max(0, ...tokens.map((t) => t.score).filter(Number.isFinite));
    const positiveMass = tokens.map((t) => {
        const s = t.score;
        return Number.isFinite(s) ? Math.max(0, s) : 0;
    });
    const massSum = positiveMass.reduce((a, v) => a + v, 0);
    return tokens.map((t, i) => {
        const rawScore = getAttentionRawScore(t);
        const poolMassFrac = massSum > 0 ? positiveMass[i]! / massSum : 0;
        const scoreNorm = max <= 0 ? t.score : t.score / max;
        return { ...t, score: scoreNorm, rawScore, poolMassFrac };
    });
}

/**
 * 在候选池已按 `score` 降序、池内归一保持该顺序的前提下，按遍历顺序取前缀，直到：
 * - 池内 L1 份额小于 β×首条份额（分布形状截断），或
 * - 累计达到 {@link DAG_EDGE_CUMULATIVE_SHARE}（候选池内 Top-P，非整步全量 token 的分母）。
 * （池内份额与 `score` 单调一致，无需再排序。）
 */
function selectTokenAttributionByCumulativeShare<T extends { poolMassFrac: number }>(
    normalized: Array<T>,
): Array<T> {
    if (normalized.length === 0) return [];

    const topFrac = normalized[0]?.poolMassFrac ?? 0;
    if (!(topFrac > 0)) return [];
    const relativeFloor = DAG_EDGE_RELATIVE_TOP_SHARE_FLOOR_BETA * topFrac;

    let cum = 0;
    const picked: Array<T> = [];
    for (const t of normalized) {
        const frac = t.poolMassFrac;
        if (!(frac > 0)) {
            break;
        }
        if (frac < relativeFloor) {
            break;
        }
        picked.push(t);
        cum += frac;
        if (cum >= DAG_EDGE_CUMULATIVE_SHARE) {
            break;
        }
    }

    return picked;
}

/**
 * 第 0 步：从 API 原始 `token_attribution` 按 offset 去重得到 prompt spans，供 DAG `setPromptTokenSpans`（配合 `context` 全文测量布局）。
 * 与 {@link excludeNodeAggregatedEntries} / {@link phase2RankAndSparsify} 无关（不 exclude、不归一化）。
 */
export function extractPromptTokenSpans(step: TokenGenStep): PromptTokenSpan[] {
    const ta = step.response.token_attribution;
    if (!ta?.length) return [];

    const byKey = new Map<string, PromptTokenSpan>();
    for (const t of ta) {
        const k = `${t.offset[0]}_${t.offset[1]}`;
        if (!byKey.has(k)) {
            byKey.set(k, { offset: t.offset, raw: t.raw });
        }
    }
    return [...byKey.values()];
}

/** 与 {@link excludeNodeAggregatedEntries} 使用同一套 prompt / 生成区与 storage 文本，在 `intervalCtx` 上收集排除区间（全串下标）。 */
export function collectGenAttrDagExcludeIntervals(
    intervalCtx: string,
    promptRegionEnd: number,
): [number, number][] {
    const pe = promptRegionEnd;
    return [
        ...collectExcludeRegexMatchIntervals(intervalCtx, readStoredEffectiveExcludePromptPatternsText(), {
            start: 0,
            end: pe,
        }),
        ...collectExcludeRegexMatchIntervals(intervalCtx, readStoredEffectiveExcludeGeneratedPatternsText(), {
            start: pe,
            end: intervalCtx.length,
        }),
    ];
}

/**
 * 对齐聚合之后、Top-N 之前：在 **prompt 区** / **已生成后缀区** 分别匹配两套 exclude 模式，按**节点区间** `[ts, te)` 判定是否整段落入排除区间，
 * 命中则该条 `score` 置 0。与 piece 级 exclude 相比，合并型 piece 拆到多节点后可分别命中/不命中。
 *
 * @param excludeIntervalContext 取匹配区间所用的全文（与 DAG 节点 offset 同源）。流式场景传**当前已写出的累积串**
 *（如 `steps[last].context + steps[last].token`），使跨多 token 才闭合的正则与下标一致；缺省为 `step.context`。
 */
export function excludeNodeAggregatedEntries(
    step: TokenGenStep,
    entries: NodeAggregatedEntry[],
    excludeIntervalContext?: string,
): NodeAggregatedEntry[] {
    if (!entries.length) return [];

    const pe = step.promptRegionEnd;
    const intervalCtx = excludeIntervalContext ?? step.context;
    const excludeIntervals = collectGenAttrDagExcludeIntervals(intervalCtx, pe);
    return entries.map((t) => {
        const [ts, te] = t.offset;
        const excluded = isOffsetSpanFullyExcluded(ts, te, excludeIntervals);
        return {
            ...t,
            score: excluded ? 0 : t.score,
        };
    });
}

/**
 * 预处理阶段 2（展示单元级，纯函数）：Top-N 候选池 → 池内 max 归一 & L1 份额 → β 截断 & cumulative Top-P。
 * 输入为「按节点聚合后的条目」（带 `nodeId`）；所有额外字段会透传到输出，
 * 输出 `score` 为池内 max 归一后的强度，`poolMassFrac` 为池内 L1 份额（供下游 `scoreShare`）。
 */
export function phase2RankAndSparsify<T extends { score: number }>(
    entries: T[],
): Array<T & { score: number; rawScore: number; poolMassFrac: number }> {
    if (!entries.length) return [];
    const topNPool = selectTopNByScore(entries, DAG_EDGE_TOP_N);
    const normalized = normalizeTopNPoolForDagSparse(topNPool);
    return selectTokenAttributionByCumulativeShare(normalized);
}
