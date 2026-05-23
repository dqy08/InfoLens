import type { FrontendAnalyzeResult } from '../../shared/api/GLTR_API';
import { calculateSurprisal, calculateSurprisalDensity } from '../../shared/core/Util';
import { extractRealTopkFromTokens } from '../../shared/cross/tokenUtils';

/** 首/末 bin 包含超出范围的值，中间 bin 为 [x0, x1) */
function valueInBinRange(value: number, x0: number, x1: number, binIndex: number, no_bins: number): boolean {
    const isFirstBin = binIndex === 0;
    const isLastBin = binIndex === no_bins - 1;
    if (isFirstBin) return value < x1;
    if (isLastBin) return value >= x0;
    return value >= x0 && value < x1;
}

export type HistogramType = 'token' | 'byte' | 'raw_score_normed';
export type HighlightData = FrontendAnalyzeResult & {
    rawScoresNormed?: number[];
    attentionRawScores?: number[];
    signalProbs?: number[];
    pPwValues?: number[];
    pwScores?: number[];
};

/**
 * 根据直方图 bin 的范围计算需要高亮的 token 索引集合（基于合并后 token 的 surprisal，与直方图数据一致）
 * @param x0 bin 起始值
 * @param x1 bin 结束值
 * @param binIndex bin在bins数组中的索引
 * @param no_bins 直方图的总bin数量
 * @param data 前端分析结果（包含 bpeBpeMergedTokens）
 * @returns 需要高亮的 merged token 索引集合
 */
export function calculateTokenSurprisalHighlights(
    x0: number,
    x1: number,
    binIndex: number,
    no_bins: number,
    data: HighlightData
): Set<number> {
    const highlightedIndices = new Set<number>();
    const bpeBpeMergedTokens = data.bpeBpeMergedTokens;
    if (!bpeBpeMergedTokens?.length) return highlightedIndices;

    const mergedRealTopk = extractRealTopkFromTokens(bpeBpeMergedTokens);
    for (let i = 0; i < bpeBpeMergedTokens.length; i++) {
        const surprisal = calculateSurprisal(mergedRealTopk[i][1]);
        if (!Number.isFinite(surprisal)) continue;
        if (!valueInBinRange(surprisal, x0, x1, binIndex, no_bins)) continue;
        highlightedIndices.add(i);
    }
    return highlightedIndices;
}

/**
 * 根据直方图 bin 的范围计算需要高亮的 token 索引集合（基于信息密度）
 * @param x0 bin 起始值
 * @param x1 bin 结束值
 * @param binIndex bin在bins数组中的索引
 * @param no_bins 直方图的总bin数量
 * @param data 前端分析结果（包含 bpeBpeMergedTokens）
 * @returns 需要高亮的 merged token 索引集合
 */
export function calculateByteSurprisalHighlights(
    x0: number,
    x1: number,
    binIndex: number,
    no_bins: number,
    data: HighlightData
): Set<number> {
    const highlightedIndices = new Set<number>();
    const bpeBpeMergedTokens = data.bpeBpeMergedTokens;
    if (!bpeBpeMergedTokens?.length) return highlightedIndices;

    for (let i = 0; i < bpeBpeMergedTokens.length; i++) {
        const informationDensity = calculateSurprisalDensity(bpeBpeMergedTokens[i]);
        if (!Number.isFinite(informationDensity)) continue;
        if (!valueInBinRange(informationDensity, x0, x1, binIndex, no_bins)) continue;
        highlightedIndices.add(i);
    }
    return highlightedIndices;
}

/**
 * 根据直方图 bin 的范围计算需要高亮的 token 索引集合（基于 raw_score_normed）
 * 使用 rawScoresNormed（与 bpeBpeMergedTokens 对齐），按 bin 范围筛选
 */
export function calculateRawScoreNormedHighlights(
    x0: number,
    x1: number,
    binIndex: number,
    no_bins: number,
    data: HighlightData
): Set<number> {
    const highlightedIndices = new Set<number>();
    const scores = data.rawScoresNormed;
    if (!scores?.length) return highlightedIndices;

    for (let i = 0; i < scores.length; i++) {
        const score = scores[i];
        if (!Number.isFinite(score)) continue;
        if (!valueInBinRange(score, x0, x1, binIndex, no_bins)) continue;
        highlightedIndices.add(i);
    }
    return highlightedIndices;
}

/**
 * 根据直方图类型和 bin 范围计算需要高亮的 token 索引集合
 * @param histogramType 直方图类型
 * @param x0 bin 起始值
 * @param x1 bin 结束值
 * @param binIndex bin在bins数组中的索引
 * @param no_bins 直方图的总bin数量
 * @param data 前端分析结果
 * @returns 需要高亮的 merged token 索引集合和对应的高亮样式
 */
export function calculateHighlights(
    histogramType: HistogramType,
    x0: number,
    x1: number,
    binIndex: number,
    no_bins: number,
    data: HighlightData
): { indices: Set<number>; style: 'border' | 'underline' } {
    if (histogramType === 'byte') {
        return {
            indices: calculateByteSurprisalHighlights(x0, x1, binIndex, no_bins, data),
            style: 'underline'
        };
    }
    if (histogramType === 'raw_score_normed') {
        return {
            indices: calculateRawScoreNormedHighlights(x0, x1, binIndex, no_bins, data),
            style: 'underline'
        };
    }
    return {
        indices: calculateTokenSurprisalHighlights(x0, x1, binIndex, no_bins, data),
        style: 'border'
    };
}

