import {
    collectExcludeRegexMatchIntervals,
    isOffsetSpanFullyExcluded,
} from '../core/attributionDisplayModel';
import type { NodeAggregatedEntry } from './genAttributeDagIntervalResolve';
import type { TokenGenStep } from './tokenGenAttributionRunner';
import { getAttentionRawScore } from '../../cross/semanticUtils';
import { DAG_EDGE_MIN_NORMALIZED_SCORE } from './genAttributeDagEdgeDisplay';

/** 与 DAG 节点 id 一致：来自 API `token_attribution` 几何（按 offset 去重，独立于 exclude/归一化）。 */
export type PromptTokenSpan = {
    offset: [number, number];
    raw: string;
    /** tokenizer 词表 id（/api/tokenize 返回）；DAG 几何不依赖此字段。 */
    token_id?: number;
};

/** 每步在 exclude 之后按 `score` 降序取前 N 条作为候选池，避免长上下文长尾稀释。 */
// 经验值，最后能筛选出大概一半的归因数
const DAG_EDGE_TOP_N = 10;

/** DAG 边 Top-P：候选池内累计份额默认上限（{@link phase2RankAndSparsify}）。 */
export const DAG_EDGE_TOP_P_COVERAGE_DEFAULT = 0.7;
const DAG_EDGE_TOP_P_COVERAGE_MIN = 0.05;
const DAG_EDGE_TOP_P_COVERAGE_MAX = 1;

export function clampDagEdgeTopPCoverage(n: number): number {
    if (!Number.isFinite(n)) return DAG_EDGE_TOP_P_COVERAGE_DEFAULT;
    return Math.min(DAG_EDGE_TOP_P_COVERAGE_MAX, Math.max(DAG_EDGE_TOP_P_COVERAGE_MIN, n));
}

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
 * 在候选池已按 `score` 降序、池内 max 归一（`score` 即 `normalizedScore`）的前提下，按遍历顺序取前缀，直到：
 * - `normalizedScore < {@link DAG_EDGE_MIN_NORMALIZED_SCORE}`，或
 * - 累计达到给定阈值（默认 {@link DAG_EDGE_TOP_P_COVERAGE_DEFAULT}；候选池内 Top-P，非整步全量 token 的分母）。
 */
function selectTokenAttributionByCumulativeShare<T extends { score: number; poolMassFrac: number }>(
    normalized: Array<T>,
    cumulativeShareThreshold: number,
): Array<T> {
    if (normalized.length === 0) return [];
    if (!(normalized[0]!.poolMassFrac > 0)) return [];

    let cum = 0;
    const picked: Array<T> = [];
    for (const t of normalized) {
        if (!(t.poolMassFrac > 0)) {
            break;
        }
        const normalizedScore = t.score;
        if (normalizedScore < DAG_EDGE_MIN_NORMALIZED_SCORE) {
            break;
        }
        picked.push(t);
        cum += t.poolMassFrac;
        if (cum >= cumulativeShareThreshold) {
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

/**
 * 在 `intervalCtx` 上收集排除区间（全串下标）；正则全文由调用方提供（Gen Attribute 页与控件一致）。
 * 与 {@link excludeNodeAggregatedEntries} 须传入同一套 `excludePromptPatternsText` / `excludeGeneratedPatternsText`。
 */
export function collectGenAttrDagExcludeIntervals(
    intervalCtx: string,
    promptRegionEnd: number,
    excludePromptPatternsText: string,
    excludeGeneratedPatternsText: string,
): [number, number][] {
    const pe = promptRegionEnd;
    return [
        ...collectExcludeRegexMatchIntervals(intervalCtx, excludePromptPatternsText, {
            start: 0,
            end: pe,
        }),
        ...collectExcludeRegexMatchIntervals(intervalCtx, excludeGeneratedPatternsText, {
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
 * @param excludePromptPatternsText prompt 区 `[0, promptRegionEnd)` 上使用的排除正则全文（勾选关时传 `''`）。
 * @param excludeGeneratedPatternsText 已生成后缀区上使用的排除正则全文（勾选关时传 `''`）。
 */
export function excludeNodeAggregatedEntries(
    step: TokenGenStep,
    entries: NodeAggregatedEntry[],
    excludeIntervalContext: string | undefined,
    excludePromptPatternsText: string,
    excludeGeneratedPatternsText: string,
): NodeAggregatedEntry[] {
    if (!entries.length) return [];

    const pe = step.promptRegionEnd;
    const intervalCtx = excludeIntervalContext ?? step.context;
    const excludeIntervals = collectGenAttrDagExcludeIntervals(
        intervalCtx,
        pe,
        excludePromptPatternsText,
        excludeGeneratedPatternsText,
    );
    return entries.map((t) => {
        const [ts, te] = t.offset;
        const excluded = isOffsetSpanFullyExcluded(ts, te, excludeIntervals);
        return {
            ...t,
            score: excluded ? 0 : t.score,
        };
    });
}

/** Top-N 候选池 → 池内归一 → β 截断与累计 Top-P；`cumulativeShare` 未传用 {@link DAG_EDGE_TOP_P_COVERAGE_DEFAULT}。 */
export function phase2RankAndSparsify<T extends { score: number }>(
    entries: T[],
    options?: { cumulativeShare?: number },
): Array<T & { score: number; rawScore: number; poolMassFrac: number }> {
    if (!entries.length) return [];
    const topNPool = selectTopNByScore(entries, DAG_EDGE_TOP_N);
    const normalized = normalizeTopNPoolForDagSparse(topNPool);
    const threshold =
        options?.cumulativeShare !== undefined
            ? clampDagEdgeTopPCoverage(options.cumulativeShare)
            : DAG_EDGE_TOP_P_COVERAGE_DEFAULT;
    return selectTokenAttributionByCumulativeShare(normalized, threshold);
}
