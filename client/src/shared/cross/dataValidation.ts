import type { FrontendToken } from '../../shared/api/GLTR_API';
import { codePointLength, sliceTextByCodePointOffsets } from './mergeTokenSpans';

/**
 * 验证值是否为合法的 real_topk 元组
 */
export const isValidRealTopkTuple = (value: unknown): value is [number, number] => {
    return Array.isArray(value)
        && value.length === 2
        && value.every((item) => typeof item === 'number' && Number.isFinite(item));
};

/**
 * 验证 token 的概率数据
 */
export const validateTokenProbabilities = (
    tokens: Array<{ real_topk?: [number, number] }>
): string | null => {
    if (!Array.isArray(tokens) || tokens.length === 0) {
        return null;
    }
    for (let i = 0; i < tokens.length; i++) {
        const tuple = tokens[i]?.real_topk;
        if (!isValidRealTopkTuple(tuple)) {
            return `Token #${i} 缺少合法 real_topk 数据，已取消本次处理。`;
        }
    }
    return null;
};

/**
 * 验证值是否为合法的 pred_topk 条目
 */
export const isValidPredTopkEntry = (value: unknown): value is [string, number] => {
    return Array.isArray(value)
        && value.length === 2
        && typeof value[0] === 'string'
        && typeof value[1] === 'number'
        && Number.isFinite(value[1]);
};

/**
 * 验证 token 的预测数据
 * 注意：pred_topk 可以为空数组（例如内存优化策略跳过 TopK 计算时），这是正常情况
 */
export const validateTokenPredictions = (
    tokens: Array<{ pred_topk?: [string, number][] }>
): string | null => {
    if (!Array.isArray(tokens) || tokens.length === 0) {
        return '返回数据缺少 token 序列，已取消本次处理。';
    }
    for (let i = 0; i < tokens.length; i++) {
        const list = tokens[i]?.pred_topk;
        // pred_topk 必须存在且为数组类型（允许为空数组）
        if (!Array.isArray(list)) {
            return `Token #${i} 缺少合法 pred_topk 数组，已取消本次处理。`;
        }
        // 只有当 pred_topk 不为空时，才验证其内容格式
        if (list.length > 0) {
            for (let j = 0; j < list.length; j++) {
                if (!isValidPredTopkEntry(list[j])) {
                    return `Token #${i} 的 pred_topk 项 #${j} 格式非法，已取消本次处理。`;
                }
            }
        }
    }
    return null;
};

/**
 * 格式化 token 预览文本（用于错误消息）
 */
export const formatTokenPreview = (text: string): string => {
    if (!text) {
        return '[空]';
    }

    const chars = Array.from(text);
    if (chars.length <= 12) {
        return text;
    }

    const head = chars.slice(0, 6).join('');
    const tail = chars.slice(-3).join('');
    return `${head}…${tail}`;
};

/**
 * 验证 token 数据的一致性（offset 和 raw 是否匹配）。
 * 正宽区间（end > start）：raw 须与原文按码点切片一致。
 * 零宽区间（end === start）：不校验 raw（后端可能用非空 raw 携带解码器态，如续写慢路径）。
 */
export const validateTokenConsistency = (
    bpeStrings: Array<{ offset?: [number, number]; raw?: string }>,
    originalText: string,
    options: { allowOverlap?: boolean } = {}
): string | null => {
    const { allowOverlap = false } = options;
    if (!Array.isArray(bpeStrings) || bpeStrings.length === 0) {
        return null;
    }

    if (typeof originalText !== 'string') {
        return '响应缺少原始文本，无法校验 token 数据，已取消本次 demo。';
    }

    const totalChars = codePointLength(originalText);

    for (let i = 0; i < bpeStrings.length; i++) {
        const token = bpeStrings[i];
        if (!token) {
            return `Token #${i} 数据缺失，已取消本次 demo。`;
        }

        const offset = token.offset;
        if (!Array.isArray(offset) || offset.length !== 2) {
            return `Token #${i} 缺少合法 offset，已取消本次 demo。`;
        }

        const [start, end] = offset;
        if (!Number.isInteger(start) || !Number.isInteger(end)) {
            return `Token #${i} 的 offset (${start}, ${end}) 不是整数，已取消本次 demo。`;
        }

        if (start < 0 || end < start || end > totalChars) {
            return `Token #${i} 的 offset (${start}, ${end}) 超出原文范围，已取消本次 demo。`;
        }

        if (!allowOverlap && i > 0) {
            const prevOffset = bpeStrings[i - 1]?.offset;
            if (Array.isArray(prevOffset) && prevOffset.length === 2) {
                const prevEnd = prevOffset[1];
                if (Number.isInteger(prevEnd) && start < prevEnd) {
                    return `Token #${i} 的 offset (${start}, ${end}) 与 Token #${i - 1} 重叠，已取消本次 demo。`;
                }
            }
        }

        if (start < end) {
            const expected = sliceTextByCodePointOffsets(originalText, start, end);
            const raw = token.raw ?? '';
            if (expected !== raw) {
                const previewExpected = formatTokenPreview(expected);
                const previewRaw = formatTokenPreview(raw);
                return `Token #${i} 数据异常：offset(${start}, ${end}) 对应原文 "${previewExpected}"，但 raw 为 "${previewRaw}"。请重新分析或修复数据。`;
            }
        }
    }

    return null;
};

