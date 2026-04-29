import type { BpeMergeReason, FrontendAnalyzeResult, FrontendToken } from '../api/GLTR_API';
import type { AttributionApiResponse } from './attributionResultCache';
import { getDigitsMergeEnabled } from '../utils/digitsMergeManager';
import {
    getAttentionRawScore,
    mergeAttentionTokensFullyForRendering,
    normalizeTokenScores,
} from '../utils/semanticUtils';

/** 在 `context` 内的半开区间，用于限定「prompt」上的模式匹配范围 */
export type ExcludeRegexMatchRegion = {
    start: number;
    end: number;
};

export type AttributionDisplayOptions = {
    colorRangeMax: number | null;
    /** 已生效的排除配置（未使能时应传 ''）：每行一条正则，在 {@link ExcludeRegexMatchRegion} 内 `g` 匹配 */
    excludePromptPatternsText: string;
    /**
     * 正则仅作用于 `context` 的 `[start, end)` 子串；缺省为 `[0, context.length)`（整段 context 视为 prompt）。
     */
    excludePromptPatternsRegion?: ExcludeRegexMatchRegion;
};

function mapNormedScoresToColorRange(rawScoresNormed: number[], x: number): number[] {
    return rawScoresNormed.map((s) => (s > x ? 1 : s / x));
}

/** 行内注释：此前缀及其后整段不参与正则（见 {@link collectExcludeRegexMatchIntervals}）。 */
const EXCLUDE_REGEX_LINE_COMMENT_MARKER = '#comment#';

/**
 * 每行一条正则（`g` 匹配），在 `region` 限定的 `context` 子串上收集所有匹配区间 `[start, end)`（坐标为全串下标），不合并。
 * 未传 `region` 时等价于 `[0, context.length)`。
 * `excludeMultiline` 宜来自 `textarea.value`（API 值已规范为 `\n` 换行）；不做 `trim`，以免改变正则语义。
 * 行内可先写正则，再接 {@link EXCLUDE_REGEX_LINE_COMMENT_MARKER} 及说明；该标记及之后整段丢弃后再解析。删后为空则跳过（含整行仅注释）。
 * 某行解析为非法正则时跳过该行（不影响其它行），避免抛错导致页面无法重绘。
 * 供 {@link isOffsetSpanFullyExcluded} 与 DAG 预处理共用。
 */
export function collectExcludeRegexMatchIntervals(
    context: string,
    excludeMultiline: string,
    region?: ExcludeRegexMatchRegion
): [number, number][] {
    const r0 = region?.start ?? 0;
    const r1 = region?.end ?? context.length;
    const lo = Math.max(0, Math.min(r0, context.length));
    const hi = Math.max(lo, Math.min(r1, context.length));
    const slice = context.slice(lo, hi);

    const intervals: [number, number][] = [];
    for (const rawLine of excludeMultiline.split('\n')) {
        const cut = rawLine.indexOf(EXCLUDE_REGEX_LINE_COMMENT_MARKER);
        const line = cut === -1 ? rawLine : rawLine.slice(0, cut);
        if (line === '') continue;
        try {
            const re = new RegExp(line, 'g');
            for (const m of slice.matchAll(re)) {
                if (m.index === undefined) continue;
                const abs = lo + m.index;
                intervals.push([abs, abs + m[0].length]);
            }
        } catch {
            // 非法正则：跳过本行，其余行与 UI 仍可用
        }
    }
    return intervals;
}

/** 当且仅当 `[ts, te)` 完全落在某一匹配区间内时返回 true（区间列表不合并，逐段判断）。 */
export function isOffsetSpanFullyExcluded(ts: number, te: number, intervals: [number, number][]): boolean {
    for (const [a, b] of intervals) {
        if (a <= ts && te <= b) return true;
    }
    return false;
}

/**
 * 将归因 API 响应转为 {@link GLTR_Text_Box} 可用的 {@link FrontendAnalyzeResult}（含 rawScoresNormed / attentionRawScores / 可选 colorScores）。
 * 管线：overlap + digit 合并 → {@link normalizeTokenScores}，与语义 attention 一致。
 */
export function buildAttributionDisplayResult(
    context: string,
    response: AttributionApiResponse,
    options: AttributionDisplayOptions
): FrontendAnalyzeResult {
    const tokens = response.token_attribution ?? [];
    const region = options.excludePromptPatternsRegion ?? { start: 0, end: context.length };
    const excludeIntervals = collectExcludeRegexMatchIntervals(
        context,
        options.excludePromptPatternsText,
        region
    );

    const originalTokens: FrontendToken[] = tokens.map((t) => ({
        raw: t.raw,
        offset: t.offset,
        pred_topk: []
    }));

    const effective = tokens.map((t) => {
        const [ts, te] = t.offset;
        const excluded = isOffsetSpanFullyExcluded(ts, te, excludeIntervals);
        return {
            offset: t.offset,
            raw: t.raw,
            score: excluded ? 0 : t.score,
        };
    });

    const merged = mergeAttentionTokensFullyForRendering(effective, context, {
        digitMerge: getDigitsMergeEnabled(),
    });
    const normalized = normalizeTokenScores(merged);

    const digitMergedTokens: FrontendToken[] = normalized.map((t) => {
        const m = (t as { bpe_merged?: BpeMergeReason }).bpe_merged;
        const parts = (t as { bpe_merge_parts?: string[] }).bpe_merge_parts;
        const row: FrontendToken = {
            offset: t.offset,
            raw: t.raw,
            pred_topk: [],
        };
        if (m !== undefined) {
            row.bpe_merged = m;
        }
        if (parts !== undefined) {
            row.bpe_merge_parts = [...parts];
        }
        return row;
    });

    const attentionRawScores = normalized.map((t) => getAttentionRawScore(t));
    const rawScoresNormed = normalized.map((t) => t.score);

    const result = {
        model: response.model ?? null,
        error: null,
        bpe_strings: digitMergedTokens,
        originalTokens,
        bpeBpeMergedTokens: digitMergedTokens.map((t) => ({ ...t })),
        originalText: context
    } as FrontendAnalyzeResult;

    const ext = result as FrontendAnalyzeResult & {
        rawScoresNormed: number[];
        colorScores?: number[];
        attentionRawScores: number[];
    };
    ext.rawScoresNormed = rawScoresNormed;
    ext.attentionRawScores = attentionRawScores;
    if (options.colorRangeMax != null) {
        ext.colorScores = mapNormedScoresToColorRange(rawScoresNormed, options.colorRangeMax);
    }

    return result;
}
