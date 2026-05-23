import type { FrontendAnalyzeResult, FrontendToken } from '../../shared/api/GLTR_API';
import { calculateSurprisal, calculateSurprisalDensity, countTokenCharacters, getByteLength } from '../core/Util';
import { extractRealTopkFromTokens } from './tokenUtils';

export type TextStats = {
    byteCount: number;
    charCount: number;
    tokenCount: number;
    tokenSurprisals: number[];
    byteSurprisals: number[];
    tokenAverage: number | null;
    tokenP90: number | null;
    byteAverage: number | null;
    totalSurprisal: number | null;
};

/**
 * 差分统计数据（用于模型差分模式）
 */
export type DiffStats = {
    // 基础字段保持不变（使用本列的原始值）
    byteCount: number;
    charCount: number;
    tokenCount: number;
    tokenSurprisals: number[];  // 本列的原始token surprisal
    tokenAverage: number | null;
    // 差分字段
    deltaTotalSurprisal: number | null;  // Δ总surprisal
    deltaByteSurprisals: number[];  // 逐字节的Δ信息密度(bits/Byte)
};

/**
 * 计算平均值
 */
export const computeAverage = (values: number[] | null | undefined): number | null => {
    if (!values || values.length === 0) {
        return null;
    }
    const validValues = values.filter((value) => Number.isFinite(value));
    if (validValues.length === 0) {
        return null;
    }
    const sum = validValues.reduce((acc, value) => acc + value, 0);
    return sum / validValues.length;
};

/**
 * 合并后 BPE token 的逐 token surprisal（与 bpeBpeMergedTokens / bpe_strings 对齐），用于直方图与 surprisal progress。
 * 文本指标仍以 {@link calculateTextStats} 中原始 token 维度为准。
 */
export function calculateMergedTokenSurprisals(bpeBpeMergedTokens: FrontendToken[]): number[] {
    if (!bpeBpeMergedTokens.length) return [];
    const realTopkMerged = extractRealTopkFromTokens(bpeBpeMergedTokens);
    return bpeBpeMergedTokens.map((_, index) => calculateSurprisal(realTopkMerged[index][1]));
}

/** 计算90分位数（p90） */
export const computeP90 = (values: number[] | null | undefined): number | null => {
    if (!values || values.length === 0) {
        return null;
    }
    const sorted = values
        .filter((value) => Number.isFinite(value))
        .slice()
        .sort((a, b) => a - b);
    const n = sorted.length;
    if (n === 0) {
        return null;
    }
    // 90分位数的索引位置：(n-1) * 0.9
    const index = (n - 1) * 0.9;
    const lower = Math.floor(index);
    const upper = Math.ceil(index);
    const weight = index - lower;
    
    if (lower === upper) {
        return sorted[lower];
    }
    // 线性插值
    return sorted[lower] * (1 - weight) + sorted[upper] * weight;
};

/**
 * 计算文本统计信息
 */
export const calculateTextStats = (
    result: FrontendAnalyzeResult,
    originalText: string
): TextStats => {
    const originalTokens = result.originalTokens;
    const bpeBpeMergedTokens = result.bpeBpeMergedTokens;

    const realTopkOriginal = extractRealTopkFromTokens(originalTokens);
    const realTopkMerged = extractRealTopkFromTokens(bpeBpeMergedTokens);

    // 从最后一个 token 的 offset 获取截断后文本的实际长度
    let truncatedTextLength = 0;
    if (originalTokens.length > 0) {
        const lastToken = originalTokens[originalTokens.length - 1];
        truncatedTextLength = lastToken.offset[1];
    }
    
    // 从原始文本中截取实际分析的文本部分
    const truncatedText = originalText.slice(0, truncatedTextLength);
    const safeText = truncatedText;
    
    const byteCount = getByteLength(safeText);
    const charCount = countTokenCharacters(safeText);
    const tokenCount = originalTokens.length;

    const tokenSurprisals: number[] = [];
    const byteSurprisals: number[] = [];
    let totalSurprisal = 0;
    let hasValidTotal = false;

    originalTokens.forEach((token, index) => {
        const prob = realTopkOriginal[index][1];
        const surprisal = calculateSurprisal(prob);
        tokenSurprisals.push(surprisal);
        if (Number.isFinite(surprisal)) {
            totalSurprisal += surprisal;
            hasValidTotal = true;
        }
    });

    bpeBpeMergedTokens.forEach((token) => {
        const tokenText = token.raw;
        const byteCountForToken = getByteLength(tokenText);
        const byteSurprisal = calculateSurprisalDensity(token);
        // 为token的每个字节添加相同的byteSurprisal值
        // 注意：虽然可以使用Array.fill优化，但考虑到token的字节数通常很少（平均几个字节），
        // 使用简单的循环更直观，性能差异可忽略不计
        for (let i = 0; i < byteCountForToken; i++) {
            byteSurprisals.push(byteSurprisal);
        }
    });

    return {
        byteCount,
        charCount,
        tokenCount,
        tokenSurprisals,
        byteSurprisals,
        tokenAverage: computeAverage(tokenSurprisals),
        tokenP90: computeP90(tokenSurprisals),
        byteAverage: computeAverage(byteSurprisals),
        totalSurprisal: hasValidTotal ? totalSurprisal : null
    };
};

/**
 * 计算差分统计数据（Diff列相对于Base列的差异）
 * @param diffStats Diff列的TextStats
 * @param baseStats Base列的TextStats
 * @returns 差分统计数据
 */
export const calculateDiffStats = (
    diffStats: TextStats,
    baseStats: TextStats
): DiffStats => {
    // 计算Δ总surprisal
    const deltaTotalSurprisal = (diffStats.totalSurprisal !== null && baseStats.totalSurprisal !== null)
        ? diffStats.totalSurprisal - baseStats.totalSurprisal
        : null;

    // 计算逐字节的Δ信息密度(bits/Byte)
    const deltaByteSurprisals: number[] = [];
    const minLength = Math.min(diffStats.byteSurprisals.length, baseStats.byteSurprisals.length);
    
    for (let i = 0; i < minLength; i++) {
        const delta = diffStats.byteSurprisals[i] - baseStats.byteSurprisals[i];
        deltaByteSurprisals.push(delta);
    }

    return {
        byteCount: diffStats.byteCount,
        charCount: diffStats.charCount,
        tokenCount: diffStats.tokenCount,
        tokenSurprisals: diffStats.tokenSurprisals,
        tokenAverage: diffStats.tokenAverage,
        deltaTotalSurprisal,
        deltaByteSurprisals
    };
};

