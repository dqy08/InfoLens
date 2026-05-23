import * as d3 from 'd3';
import type { TextStats } from '../cross/textStatistics';
import { calculateTextStats } from '../cross/textStatistics';
import { countTokenCharacters } from '../core/Util';
import type { FrontendAnalyzeResult } from '../../shared/api/GLTR_API';
import {
    updateBasicMetrics,
    updateTotalSurprisal,
    updateModel,
    updateApiUsageDisplay,
    validateMetricsElements,
    type ApiTokenUsage
} from '../cross/textMetricsUpdater';
import { tr } from '../../shared/lang/i18n-lite';

/**
 * 扩展的 Input 事件接口
 * 用于在 input 事件中传递额外的标志信息
 */
export interface ExtendedInputEvent extends Event {
    isMatchingAnalysis?: boolean;
}

export type TextInputControllerOptions = {
    textField: d3.Selection<any, unknown, any, any>;
    textCountValue: d3.Selection<any, unknown, any, any>;
    /** 首页等由 AppStateManager 控制显隐；未传则仅不持有引用 */
    textMetrics?: d3.Selection<any, unknown, any, any>;
    /** 首页等：bytes / chars / tokens / surprisal；Chat 页省略，改用 metricUsage */
    metricBytes?: d3.Selection<any, unknown, any, any>;
    metricChars?: d3.Selection<any, unknown, any, any>;
    metricTokens?: d3.Selection<any, unknown, any, any>;
    metricTotalSurprisal?: d3.Selection<any, unknown, any, any>;
    /** Chat：仅展示 API 返回的 usage（由 chat 页集中调用 updateChatCompletionMetrics 时可不传） */
    metricUsage?: d3.Selection<any, unknown, any, any>;
    metricModel?: d3.Selection<any, unknown, any, any>;
    clearBtn: d3.Selection<any, unknown, any, any>;
    submitBtn: d3.Selection<any, unknown, any, any>;
    saveBtn: d3.Selection<any, unknown, any, any>;
    pasteBtn: d3.Selection<any, unknown, any, any>;
    totalSurprisalFormat: (value: number | null) => string;
    showAlertDialog: (title: string, message: string) => void;
};

export class TextInputController {
    private options: TextInputControllerOptions;

    constructor(options: TextInputControllerOptions) {
        this.options = options;
        this.initialize();
    }

    private initialize(): void {
        // 初始化时检查一次按钮状态
        this.updateButtonStates();

        // Clear 按钮状态完全由 TextInputController 内部管理
        // 使用原生 addEventListener 监听 input 事件，避免被 D3 的 .on() 覆盖
        // 这样可以允许多个监听器共存
        const textFieldNode = this.options.textField.node() as HTMLTextAreaElement | null;
        if (textFieldNode) {
            textFieldNode.addEventListener('input', () => {
                this.updateButtonStates();
            });
        }

        // Clear 按钮点击事件
        this.options.clearBtn.on('click', () => {
            this.handleClear();
        });

        // Paste 按钮点击事件
        this.options.pasteBtn.on('click', async () => {
            await this.handlePaste();
        });
    }

    /**
     * 更新按钮有效性和字符计数（私有方法，仅内部使用）
     * 只负责更新 Clear 按钮状态和字符计数
     * 注意：submitBtn 和 saveBtn 的状态由外部状态系统统一管理
     */
    private updateButtonStates(): void {
        const textValue = this.options.textField.property('value') || '';
        const hasText = textValue.length > 0;
        
        // Clear按钮：只在文本框有内容时有效
        this.options.clearBtn.classed('inactive', !hasText);
        
        // 注意：submitBtn 的状态现在由外部状态系统统一管理，不再在这里设置
        
        if (!this.options.textCountValue.empty()) {
            const charCount = countTokenCharacters(textValue);
            this.options.textCountValue.text(charCount.toString());
        }
    }

    /**
     * 更新文本指标内容（包括模型显示，不控制显示/隐藏，显示/隐藏由 AppStateManager 统一管理）
     * @param stats 统计数据，为 null 时不更新统计内容
     * @param modelName 模型名称，始终显示以反映原始情况
     * @param apiUsage 可选：后端 tokenizer 计数（如 completions 的 usage）
     */
    public updateTextMetrics(
        stats: TextStats | null,
        modelName?: string | null | undefined,
        apiUsage?: ApiTokenUsage | null
    ): void {
        const {
            metricBytes,
            metricChars,
            metricTokens,
            metricTotalSurprisal,
            metricUsage,
            metricModel,
            totalSurprisalFormat
        } = this.options;

        // Chat：仅 model + API usage
        if (metricUsage && !metricUsage.empty()) {
            if (
                !metricModel ||
                metricModel.empty() ||
                !validateMetricsElements(metricUsage, metricModel)
            ) {
                return;
            }
            updateApiUsageDisplay(metricUsage, apiUsage ?? null);
            updateModel(metricModel, modelName);
            return;
        }

        if (
            !metricBytes ||
            !metricChars ||
            !metricTokens ||
            !metricTotalSurprisal ||
            !metricModel ||
            metricModel.empty() ||
            !validateMetricsElements(
                metricBytes,
                metricChars,
                metricTokens,
                metricTotalSurprisal,
                metricModel
            )
        ) {
            return;
        }

        if (stats) {
            updateBasicMetrics(metricBytes, metricChars, metricTokens, stats, apiUsage);
            updateTotalSurprisal(metricTotalSurprisal, stats, totalSurprisalFormat);
        }

        updateModel(metricModel, modelName);
    }

    /**
     * 处理清空文本
     */
    private handleClear(): void {
        const textValue = this.options.textField.property('value') || '';
        if (textValue.length === 0) {
            return;
        }
        this.options.textField.property('value', '');
        // 触发 input 事件，让外部统一处理状态更新
        this.options.textField.node()?.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /**
     * 处理粘贴
     */
    private async handlePaste(): Promise<void> {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                const currentValue = this.options.textField.property('value') || '';
                // 在光标位置插入，如果没有光标或光标在末尾，则追加
                const textarea = this.options.textField.node() as HTMLTextAreaElement;
                if (textarea) {
                    const start = textarea.selectionStart || currentValue.length;
                    const end = textarea.selectionEnd || currentValue.length;
                    const newValue = currentValue.substring(0, start) + text + currentValue.substring(end);
                    this.options.textField.property('value', newValue);
                    // 设置光标位置到粘贴内容的末尾
                    textarea.setSelectionRange(start + text.length, start + text.length);
                } else {
                    this.options.textField.property('value', currentValue + text);
                }
                // 触发 input 事件，让外部统一处理状态更新
                this.options.textField.node()?.dispatchEvent(new Event('input', { bubbles: true }));
            }
        } catch (error) {
            console.error('粘贴失败:', error);
            // 如果clipboard API不可用，提示用户手动粘贴
            this.options.showAlertDialog(tr('Info'), tr('Failed to read clipboard, please paste manually'));
        }
    }

    /**
     * 获取当前文本框的值
     */
    public getTextValue(): string {
        return this.options.textField.property('value') || '';
    }

    /**
     * 设置文本框的值
     * @param value 要设置的文本值
     * @param isMatchingAnalysis 如果为true，表示这是匹配分析结果的文本填入（如加载demo），不会清除hasValidData
     *                           如果为false或未提供，表示这是单方面的文本修改（如用户输入、预填充），会清除hasValidData
     */
    public setTextValue(value: string, isMatchingAnalysis: boolean = false): void {
        this.options.textField.property('value', value);
        // 触发 input 事件，添加标志以区分两种场景
        const event = new Event('input', { bubbles: true }) as ExtendedInputEvent;
        event.isMatchingAnalysis = isMatchingAnalysis;
        this.options.textField.node()?.dispatchEvent(event);
    }
}

/**
 * 计算文本统计信息（便捷函数）
 */
export const calculateTextStatsForController = (
    result: FrontendAnalyzeResult,
    originalText: string
): TextStats => {
    return calculateTextStats(result, originalText);
};

