import type { FrontendAnalyzeResult } from '../../../shared/api/GLTR_API';

/**
 * 从信息密度/分析结果中，将「第 tokenIndex 个展示 token」对应为归因 API 的 context + target_prediction：
 * 下一 token 分布即预测该 token，故 context 为原文中该 token 之前的子串。
 */
export function contextAndTargetFromTokenIndex(
    rd: FrontendAnalyzeResult,
    tokenIndex: number
): { context: string; targetPrediction: string } | null {
    const text = rd.originalText ?? '';
    const tokens = rd.bpe_strings;
    if (!tokens?.length || tokenIndex < 0 || tokenIndex >= tokens.length) return null;
    const tok = tokens[tokenIndex];
    const off = tok?.offset;
    if (!off || off.length < 2) return null;
    const [a, b] = off;
    const context = text.slice(0, a);
    const targetPrediction = tok.raw ?? text.slice(a, b);
    return { context, targetPrediction };
}
