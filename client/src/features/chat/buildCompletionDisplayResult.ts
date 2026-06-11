import type { TokenWithOffset } from '../../shared/api/generatedSchemas';
import type { FrontendAnalyzeResult, FrontendToken } from '../../shared/api/GLTR_API';
import { getDigitsMergeEnabled } from '../../shared/cross/digitsMergeManager';
import { cloneFrontendToken, mergeTokensForRendering } from '../../shared/cross/tokenUtils';
import {
    validateTokenConsistency,
    validateTokenProbabilities,
    validateTokenPredictions
} from '../../shared/cross/dataValidation';

function normalizeServerTokens(raw: TokenWithOffset[]): FrontendToken[] {
    return raw.map((t) => ({
        offset: t.offset,
        raw: t.raw,
        real_topk: t.real_topk ?? undefined,
        pred_topk: Array.isArray(t.pred_topk) ? t.pred_topk : []
    })) as FrontendToken[];
}

/**
 * 使用后端 info_radar.bpe_strings（续写段逐 token 的 offset/raw/real_topk/pred_topk）构建 GLTR 数据。
 * 校验失败时抛错，由调用方展示。
 */
function buildFromServerBpeStrings(
    completionText: string,
    modelName: string | null | undefined,
    serverBpe: TokenWithOffset[]
): FrontendAnalyzeResult {
    const safeText = completionText;

    const tokensRaw = normalizeServerTokens(serverBpe);
    const predErr = validateTokenPredictions(tokensRaw);
    if (predErr) throw new Error(predErr);
    const probErr = validateTokenProbabilities(tokensRaw);
    if (probErr) throw new Error(probErr);
    const consErr = validateTokenConsistency(tokensRaw, safeText, { allowOverlap: true });
    if (consErr) throw new Error(consErr);

    const originalTokens = tokensRaw.map((t) => cloneFrontendToken(t));
    const bpeBpeMergedTokens = mergeTokensForRendering(originalTokens, safeText, {
        digitMerge: getDigitsMergeEnabled(),
    });
    const mergedErr = validateTokenConsistency(bpeBpeMergedTokens, safeText);
    if (mergedErr) throw new Error(mergedErr);

    return {
        model: modelName ?? null,
        error: null,
        originalTokens,
        bpeBpeMergedTokens,
        bpe_strings: bpeBpeMergedTokens,
        originalText: safeText
    };
}

/**
 * 将 completions 结果转为 GLTR_Text_Box 所需数据结构（仅续写段；offset 与后端一致，不经平移）。
 * 实际 prompt 由 Chat 页 segments 区的 input 段单独展示。
 * 续写非空时**必须**提供有效 `info_radar.bpe_strings`。
 */
export function buildCompletionDisplayResult(
    completionText: string,
    modelName: string | null | undefined,
    serverBpeStrings?: TokenWithOffset[] | null
): FrontendAnalyzeResult {
    const safeText = completionText;
    const end = Array.from(safeText).length;

    if (end === 0) {
        return {
            model: modelName ?? null,
            bpe_strings: [],
            originalTokens: [],
            bpeBpeMergedTokens: [],
            error: null,
            originalText: ''
        };
    }

    if (!serverBpeStrings || serverBpeStrings.length === 0) {
        throw new Error('Response missing info_radar.bpe_strings');
    }

    return buildFromServerBpeStrings(safeText, modelName, serverBpeStrings);
}
