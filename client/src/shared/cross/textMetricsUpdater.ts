import * as d3 from 'd3';
import type { TextStats } from './textStatistics';
import { tr } from '../../shared/lang/i18n-lite';

/** OpenAI 风格 usage，用于在指标区展示后端 tokenizer 计数（与 GLTR 逐 token 统计互补） */
export type ApiTokenUsage = {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
};

function usageTokenLabel(n: unknown): string {
    return typeof n === 'number' && Number.isFinite(n) ? String(n) : '-';
}

function formatApiUsageLine(usage: ApiTokenUsage | null | undefined): string | null {
    if (!usage) return null;
    const total = usageTokenLabel(usage.total_tokens);
    const p = usageTokenLabel(usage.prompt_tokens);
    const c = usageTokenLabel(usage.completion_tokens);
    return `${total} tokens<br/>prompt | completion = ${p} | ${c} tokens`;
}

/** 仅展示后端返回的 usage（如 Chat 页，无 bytes/chars/tokens/surprisal） */
export function updateApiUsageDisplay(
    metricUsage: d3.Selection<any, unknown, any, any>,
    usage: ApiTokenUsage | null | undefined
): void {
    const line = formatApiUsageLine(usage ?? null);
    if (line) {
        metricUsage.html(`<span class="text-metrics-api-usage">${line}</span>`);
    } else {
        metricUsage.text('');
    }
}

/** Chat 页 Ask 旁：单次 completions 的 model + API usage（与 TextInputController 解耦） */
export function updateChatCompletionMetrics(
    metricUsage: d3.Selection<any, unknown, any, any>,
    metricModel: d3.Selection<any, unknown, any, any>,
    modelName: string | null | undefined,
    usage: ApiTokenUsage | null | undefined
): void {
    if (!validateMetricsElements(metricUsage, metricModel)) {
        return;
    }
    updateApiUsageDisplay(metricUsage, usage ?? null);
    updateModel(metricModel, modelName);
}

/**
 * 更新基础指标（bytes, chars, tokens）
 * @param metricBytes bytes 指标元素
 * @param metricChars chars 指标元素
 * @param metricTokens tokens 指标元素
 * @param stats 文本统计数据
 * @param apiUsage 可选：后端 usage（如 completions 的 prompt/completion/total tokens）
 */
export function updateBasicMetrics(
    metricBytes: d3.Selection<any, unknown, any, any>,
    metricChars: d3.Selection<any, unknown, any, any>,
    metricTokens: d3.Selection<any, unknown, any, any>,
    stats: TextStats,
    apiUsage?: ApiTokenUsage | null
): void {
    metricBytes.text(`${stats.byteCount} B`);
    metricChars.text(`${stats.charCount} ${tr('chars')}`);
    const tokensText = `${stats.tokenCount} ${tr('tokens')}`;
    let primaryLine: string;
    if (stats.tokenCount > 0 && stats.byteCount > 0) {
        const bytesPerToken = stats.byteCount / stats.tokenCount;
        primaryLine = `${tokensText} (${bytesPerToken.toFixed(2)} B/t)`;
    } else {
        primaryLine = tokensText;
    }

    const usageLine = formatApiUsageLine(apiUsage ?? null);
    if (usageLine) {
        metricTokens.html(`${primaryLine}<br/><span class="text-metrics-api-usage">${usageLine}</span>`);
    } else {
        metricTokens.text(primaryLine);
    }
}

/**
 * 差分模式配置
 */
export type DiffModeConfig = {
    delta: number | null;
    baseTotalSurprisal: number | null;
};

/**
 * 更新总information指标
 * @param metricTotalSurprisal 总information指标元素
 * @param stats 文本统计数据
 * @param totalSurprisalFormat 格式化函数
 * @param diffMode 差分模式配置（可选），如果提供则显示Δ总surprisal
 */
export function updateTotalSurprisal(
    metricTotalSurprisal: d3.Selection<any, unknown, any, any>,
    stats: TextStats,
    totalSurprisalFormat: (value: number | null) => string,
    diffMode?: DiffModeConfig
): void {
    // 差分模式：显示Δ总information（百分比形式）
    if (diffMode) {
        const { delta, baseTotalSurprisal } = diffMode;
        if (delta !== null && Number.isFinite(delta)) {
            if (baseTotalSurprisal !== null && Number.isFinite(baseTotalSurprisal) && baseTotalSurprisal !== 0) {
                // 计算百分比
                const percentage = (delta / baseTotalSurprisal) * 100;
                const sign = percentage >= 0 ? '+' : '';
                metricTotalSurprisal.text(`Δ${tr('total information')} = ${sign}${percentage.toFixed(2)}%`);
            } else {
                // 如果无法计算百分比，显示无效值
                metricTotalSurprisal.text(`Δ${tr('total information')} = --%`);
            }
        } else {
            metricTotalSurprisal.text(`Δ${tr('total information')} = --%`);
        }
        return;
    }

    // 普通模式：显示总information
    if (stats.totalSurprisal !== null && Number.isFinite(stats.totalSurprisal)) {
        const totalSurprisalText = `${tr('total information')} = ${totalSurprisalFormat(stats.totalSurprisal)} bits`;
        // 计算并添加 bits/Byte 和 bits/token 信息
        if (stats.byteCount > 0 && stats.tokenCount > 0) {
            const bitsPerByte = stats.totalSurprisal / stats.byteCount;
            const bitsPerToken = stats.totalSurprisal / stats.tokenCount;
            metricTotalSurprisal.html(`${totalSurprisalText}<br>${totalSurprisalFormat(bitsPerByte)} bits/Byte, ${totalSurprisalFormat(bitsPerToken)} bits/token`);
        } else if (stats.byteCount > 0) {
            const bitsPerByte = stats.totalSurprisal / stats.byteCount;
            metricTotalSurprisal.html(`${totalSurprisalText}<br>${totalSurprisalFormat(bitsPerByte)} bits/Byte`);
        } else {
            metricTotalSurprisal.text(totalSurprisalText);
        }
    } else {
        metricTotalSurprisal.text(`${tr('total information')} = -- bits`);
    }
}

/**
 * 更新模型名称显示
 * @param metricModel 模型指标元素
 * @param modelName 模型名称
 */
export function updateModel(
    metricModel: d3.Selection<any, unknown, any, any>,
    modelName?: string | null | undefined
): void {
    metricModel.text(`${tr('model')}: ${modelName}`);
}

/**
 * 验证所有必要的指标元素是否存在
 * @param elements 要验证的元素数组
 * @returns 如果所有元素都存在则返回true，否则返回false
 */
export function validateMetricsElements(
    ...elements: d3.Selection<any, unknown, any, any>[]
): boolean {
    return elements.every(el => !el.empty());
}
