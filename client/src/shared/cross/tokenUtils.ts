import type { AnalyzeResponse, FrontendToken } from '../../shared/api/GLTR_API';
import {
    type DigitMergePipelineOptions,
    digitMergeIndexGroupsByText,
    dropEmptyZeroWidthTokens,
    flattenMergePartsForDigitGroup,
    mergeSequentialOverlap,
    mergeSourcePartsForOverlapPair,
    sliceTextByCodePointOffsets,
} from './mergeTokenSpans';

export type DigitMergeResult = {
    digitMergedTokens: FrontendToken[];
    /** 输出 token i 对应的输入 token 索引列表（长度 1 表示未合并） */
    mergeGroups: number[][];
};

export type CloneTokenOptions = {
    keepMergedFlag?: boolean;
};

/**
 * 克隆 real_topk 元组
 */
export const cloneRealTopk = (tuple: [number, number] | null | undefined): [number, number] | undefined => {
    if (Array.isArray(tuple) && tuple.length === 2 && tuple.every((item) => typeof item === 'number')) {
        return [tuple[0], tuple[1]];
    }
    return undefined;
};

/**
 * 克隆 pred_topk 数组
 */
export const clonePredTopk = (list: [string, number][] | null | undefined): [string, number][] => {
    if (!Array.isArray(list)) {
        return [];
    }
    return list.map((item) => {
        const tokenText = typeof item?.[0] === 'string' ? item[0] : '';
        const prob = typeof item?.[1] === 'number' && Number.isFinite(item[1]) ? item[1] : 0;
        return [tokenText, prob] as [string, number];
    });
};

/**
 * 克隆 FrontendToken
 */
export const cloneFrontendToken = (token: FrontendToken, options: CloneTokenOptions = {}): FrontendToken => {
    const cloned: FrontendToken = {
        offset: [token.offset[0], token.offset[1]],
        raw: token.raw,
        real_topk: cloneRealTopk(token.real_topk),
        pred_topk: clonePredTopk(token.pred_topk)
    };
    if (options.keepMergedFlag !== false && typeof token.bpe_merged === 'string') {
        cloned.bpe_merged = token.bpe_merged;
    }
    if (options.keepMergedFlag !== false && Array.isArray(token.bpe_merge_parts)) {
        cloned.bpe_merge_parts = [...token.bpe_merge_parts];
    }
    return cloned;
};

/**
 * 获取 token 的概率值
 */
export const getTokenProbability = (token: FrontendToken): number => {
    const tuple = token.real_topk;
    if (Array.isArray(tuple) && tuple.length === 2 && typeof tuple[1] === 'number') {
        return tuple[1];
    }
    return 0;
};

/**
 * BPE Overlap 合并：将 offset 重叠的 token 合并。
 * 重叠多来自 tokenizer 与字边界不对齐（如 CJK）：表层 raw/offset 可能看起来交叉或「重复」，底层仍是各不相同的分词位置。
 * 合并后 `raw` 取原文切片；`real_topk` 概率按独立近似 **相乘**（语义 token_attention 则对原始梯度 **求和** 后 **再** 全局归一化，见 semanticUtils）。
 *
 * 先去掉零宽且 raw 为空的 token；其余零宽由 {@link mergeSequentialOverlap} 按 offset 与下一 token 是否覆盖该点统一合并。
 */
export const mergeBpeOverlapTokens = (tokens: FrontendToken[], originalText: string): FrontendToken[] => {
    const prepared = dropEmptyZeroWidthTokens(tokens);
    return mergeSequentialOverlap(prepared, {
        getOffset: (t) => t.offset,
        cloneForStep: (t) => cloneFrontendToken(t),
        sliceMergedRaw: (start, end) => sliceTextByCodePointOffsets(originalText, start, end),
        mergeOverlappingPair: (current, next, mergedOffset, mergedRaw) => {
            const mergedParts = mergeSourcePartsForOverlapPair(originalText, current, next);
            current.offset[0] = mergedOffset[0];
            current.offset[1] = mergedOffset[1];
            current.raw = mergedRaw;
            current.bpe_merge_parts = mergedParts;
            const combinedProb = getTokenProbability(current) * getTokenProbability(next);
            current.real_topk = [0, combinedProb];
            current.pred_topk = [];
            current.bpe_merged = 'overlap';
            return current;
        },
    });
};

/**
 * BPE Digit 合并：按原文码点上的「0/1 个 ASCII 空格 + 连续 ASCII 数字」段合并 token，与分词切法无关（overlap 后 offset 须与原文一致）。
 * 概率合并：real_topk 与各子 token 概率相乘（与 overlap 合并一致，独立近似）。
 */
export const mergeBpeDigitTokens = (tokens: FrontendToken[], originalText: string): DigitMergeResult => {
    const mergeGroups = digitMergeIndexGroupsByText(originalText, tokens);
    const digitMergedTokens = mergeGroups.map((group) => {
        if (group.length === 1) {
            return tokens[group[0]!]!;
        }
        const first = tokens[group[0]!]!;
        const last = tokens[group[group.length - 1]!]!;
        const mergedRaw = sliceTextByCodePointOffsets(originalText, first.offset[0], last.offset[1]);
        const mergedProb = group.reduce((p, idx) => p * getTokenProbability(tokens[idx]!), 1);
        return {
            offset: [first.offset[0], last.offset[1]] as [number, number],
            raw: mergedRaw,
            real_topk: [0, mergedProb] as [number, number],
            pred_topk: [],
            bpe_merged: 'digit' as const,
            bpe_merge_parts: flattenMergePartsForDigitGroup(group, tokens),
        };
    });
    return { digitMergedTokens, mergeGroups };
};

/**
 * 按 mergeGroups 对一组并行分数数组同时求和（digit merge 后对齐分数数组）
 */
export const digitMergeWithScores = (
    tokens: FrontendToken[],
    scoreArrays: (number | undefined)[][],
    originalText: string
): { digitMergedTokens: FrontendToken[]; mergedScoreArrays: (number | undefined)[][] } => {
    const { digitMergedTokens, mergeGroups } = mergeBpeDigitTokens(tokens, originalText);
    const mergedScoreArrays = scoreArrays.map((arr) =>
        mergeGroups.map((group) => group.reduce((sum, idx) => sum + (arr[idx] ?? 0), 0))
    );
    return { digitMergedTokens, mergedScoreArrays };
};

/**
 * 合并 token 用于渲染：先做 BPE Overlap 合并，可选再做 BPE Digit 合并
 */
export const mergeTokensForRendering = (
    tokens: FrontendToken[],
    originalText: string,
    options: DigitMergePipelineOptions = {}
): FrontendToken[] => {
    const overlapMerged = mergeBpeOverlapTokens(tokens, originalText);
    if (options.digitMerge === false) {
        return overlapMerged;
    }
    const { digitMergedTokens } = mergeBpeDigitTokens(overlapMerged, originalText);
    return digitMergedTokens;
};

/**
 * 从 token 数组中提取 real_topk 元组
 */
export const extractRealTopkFromTokens = (tokens: FrontendToken[] | null | undefined): [number, number][] => {
    if (!Array.isArray(tokens)) {
        return [];
    }
    return tokens.map((token) => {
        const tuple = token.real_topk;
        return [tuple[0], tuple[1]];
    });
};

/**
 * 创建原始数据的快照（用于保存 demo）
 */
export const createRawSnapshot = (response: AnalyzeResponse): AnalyzeResponse => {
    const requestClone: AnalyzeResponse['request'] = {
        text: response.request.text
    };
    const originalResult = response.result;
    const tokensForSave = originalResult.bpe_strings.map((token) =>
        cloneFrontendToken(token as FrontendToken, { keepMergedFlag: false })
    );
    // 确保 model 字段在最前面
    const resultClone: AnalyzeResponse['result'] = {
        model: originalResult.model,
        ...originalResult,
        bpe_strings: tokensForSave
    };
    return {
        request: requestClone,
        result: resultClone
    };
};

