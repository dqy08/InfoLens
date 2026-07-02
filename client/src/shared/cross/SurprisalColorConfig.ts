import * as d3 from "d3";
import { isFiniteNumber } from "../core/Util";
import { REFERENCE_MAX_SURPRISAL_BITS } from "./surprisalMath";

/**
 * 惊讶度颜色配置模块
 * 统一管理文本渲染和直方图的红色颜色配置
 */

// ==========================================
// 常量定义
// ==========================================

/** Token surprisal 的最大值，用于颜色映射（默认上限，可被调用方传入的可选 max 覆盖） */
const TOKEN_SURPRISAL_MAX = REFERENCE_MAX_SURPRISAL_BITS;

/** Byte surprisal 的最大值，用于颜色映射 */
const BYTE_SURPRISAL_MAX = 6;

/**
 * Chat 页 token 底色映射上限（bits 或 bits/Byte，取决于 classic/density），
 * 与 {@link getTokenSurprisalColor} / {@link getByteSurprisalColor} 的可选 max 参数同一机制，仅收窄动态范围。
 */
export const CHAT_SURPRISAL_COLOR_MAP_MAX = 2;

/** Token–query semantic similarity 的最大值，用于直方图颜色映射 */
const SEMANTIC_SIMILARITY_MAX = 1;

/** Minimap 颜色因子：用于放大颜色强度，因为平均后的byte surprisal密度会过小，需要放大以在minimap中更明显 */
export const MINIMAP_COLOR_FACTOR = 1.3;

/**
 * Semantic minimap 颜色因子：用于减弱语义 chunk match 颜色强度
 * （语义模式下颜色往往会偏“深”，因此通过因子让整体更浅）
 */
export const SEMANTIC_MINIMAP_COLOR_FACTOR = 0.4;

/** 红色 #ff4740，用于 surprisal 与语义匹配度 */
const SURPRISAL_RED_RGB = "255, 71, 64";
export const SURPRISAL_MAX_ALPHA = 0.7;

/** 直方图渐变最浅色 alpha 下限（10% 区间），供直方图使用方配置 */
export const HISTOGRAM_MIN_ALPHA = 0.1 * SURPRISAL_MAX_ALPHA;

/**
 * 根据归一化值获取对应的颜色（输入值应在[0,1]区间）
 * @param normalizedValue 归一化后的值，范围[0,1]
 * @param minAlpha alpha 下限，默认不限制
 * @param maxAlpha 归一化值为 1 时的 alpha 上限，默认 {@link SURPRISAL_MAX_ALPHA}
 */
export function getSurprisalColorNormalized(
    normalizedValue: number,
    minAlpha?: number,
    maxAlpha: number = SURPRISAL_MAX_ALPHA
): string {
    const clampedValue = Math.max(0, Math.min(1, normalizedValue));
    let alpha = clampedValue * maxAlpha;
    if (minAlpha != null) alpha = Math.max(minAlpha, alpha);
    return `rgba(${SURPRISAL_RED_RGB}, ${alpha})`;
}

/**
 * 将值线性映射到 [0, 1] 区间（value < 0 → 0，value >= maxValue → 1）
 * @param value 原始值
 * @param maxValue 最大值
 * @returns 归一化后的值，范围 [0, 1]
 */
function normalizeTo_01(value: number, maxValue: number): number {
    if (value < 0) {
        return 0;
    } else if (value >= maxValue) {
        return 1;
    } else {
        return value / maxValue; // 线性映射到[0, 1]
    }
}

/**
 * 根据token惊讶度值获取对应的颜色（线性映射，不取整）
 * @param surprisal token惊讶度值，默认按 [0, TOKEN_SURPRISAL_MAX] 映射到 [0, 1]
 * @param minAlpha alpha 下限，默认不限制
 * @param maxSurprisalForMap 可选：映射上限（bits），用于 Chat 等场景收窄动态范围
 * @param maxAlpha 归一化值为 1 时的 alpha 上限，默认 {@link SURPRISAL_MAX_ALPHA}
 */
export function getTokenSurprisalColor(
    surprisal: number,
    minAlpha?: number,
    maxSurprisalForMap?: number,
    maxAlpha?: number
): string {
    const max = maxSurprisalForMap ?? TOKEN_SURPRISAL_MAX;
    const normalizedValue = normalizeTo_01(surprisal, max);
    return getSurprisalColorNormalized(normalizedValue, minAlpha, maxAlpha);
}

/**
 * 根据byte密度惊讶度值获取对应的颜色（线性映射，不取整）
 * @param byteSurprisal byte密度惊讶度值（bits/Byte）
 * @param colorFactor 颜色因子，用于调整颜色强度（如 minimap）。默认为1
 * @param minAlpha alpha 下限，默认不限制
 * @param maxByteSurprisalForMap 可选：映射上限（bits/Byte），与 {@link getTokenSurprisalColor} 的第三参同理
 * @param maxAlpha 归一化值为 1 时的 alpha 上限，默认 {@link SURPRISAL_MAX_ALPHA}
 */
export function getByteSurprisalColor(
    byteSurprisal: number,
    colorFactor: number = 1,
    minAlpha?: number,
    maxByteSurprisalForMap?: number,
    maxAlpha?: number
): string {
    const max = maxByteSurprisalForMap ?? BYTE_SURPRISAL_MAX;
    const normalizedValue = normalizeTo_01(byteSurprisal * colorFactor, max);
    return getSurprisalColorNormalized(normalizedValue, minAlpha, maxAlpha);
}

/**
 * 根据 rawScoreNormed 获取颜色（用于语义匹配度染色）
 * @param rawScoreNormed 归一化分数，范围 [0, 1]
 * @param minAlpha alpha 下限，默认不限制
 */
export function getSemanticSimilarityColor(rawScoreNormed: number, minAlpha?: number): string {
    if (!isFiniteNumber(rawScoreNormed)) return 'transparent';
    const normalizedValue = normalizeTo_01(rawScoreNormed, SEMANTIC_SIMILARITY_MAX);
    return getSurprisalColorNormalized(normalizedValue, minAlpha);
}

// ==========================================
// 差分模式颜色配置 (Diff Mode)
// ==========================================

/**
 * 根据归一化值获取对应的差分颜色（输入值应在[-1,1]区间）
 * @param normalizedValue 归一化后的值，范围[-1,1]，-1对应最大负差分（绿色），1对应最大正差分（红色），0对应完全透明
 * @returns 颜色字符串（rgba格式，从透明到不透明）
 */
export function getDiffColorNormalized(normalizedValue: number): string {
    // 设计逻辑：选用中等亮度的颜色，保证红绿两色在视觉深度上的一致性，且在白底和黑底上都有良好的对比度
    
    // 确保输入值在[-1,1]范围内
    const clampedValue = Math.max(-1, Math.min(1, normalizedValue));
    
    // 根据值的正负和大小进行插值
    if (clampedValue === 0) {
        // 中性色：完全透明
        return "rgba(0, 0, 0, 0)";
    } else if (clampedValue > 0) {
        // 红色 (226, 74, 74) - Ant Design Red-5（惊讶度增加，新模型更差）
        // 正值：从透明红色到不透明红色
        const startColor = "rgba(226, 74, 74, 0)"; // 完全透明的红色
        const endColor = "rgba(226, 74, 74, 1)";   // 完全不透明的红色
        
        const colorInterpolator = d3.interpolate(startColor, endColor);
        return colorInterpolator(clampedValue);
    } else {
        // 绿色 (115, 209, 61) - Ant Design Green-5（惊讶度降低，新模型更好）
        // 负值：从透明绿色到不透明绿色
        const startColor = "rgba(115, 209, 61, 0)"; // 完全透明的绿色
        const endColor = "rgba(115, 209, 61, 1)";   // 完全不透明的绿色
        
        const colorInterpolator = d3.interpolate(startColor, endColor);
        return colorInterpolator(Math.abs(clampedValue)); // 使用绝对值，因为clampedValue是负数
    }
}

/**
 * 根据差分值获取对应的颜色（线性映射，不取整）
 * @param diff 差分值，范围通常在[-10, 10]
 * @returns 颜色字符串（rgba格式）
 */
export function getDiffColor(diff: number): string {
    // 将diff值映射到[-1, 1]范围，其中-10对应-1，10对应1
    const threshold = 10;
    let normalizedValue: number;
    if (diff <= -threshold) {
        normalizedValue = -1;
    } else if (diff >= threshold) {
        normalizedValue = 1;
    } else {
        normalizedValue = diff / threshold; // 线性映射到[-1, 1]
    }

    // 调用归一化版本来计算颜色
    return getDiffColorNormalized(normalizedValue);
}
