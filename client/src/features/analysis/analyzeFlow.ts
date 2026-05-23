/**
 * 分析流程模块
 * 负责处理 Analyze 和 Analyze & Upload 流程
 */

import * as d3 from 'd3';
import type { TextAnalysisAPI, AnalyzeResponse } from '../../shared/api/GLTR_API';
import type { TextInputController } from '../../shared/controllers/textInputController';
import type { DemoManager } from '../../shared/ui/demoManager';
import type { AppStateManager } from './appStateManager';
import type { VisualizationUpdater } from './visualizationUpdater';
import type { DemoBusinessLogic } from '../demo/demoBusinessLogic';
import type { ServerStorage } from '../../shared/storage/demoStorage';
import type { GLTR_Text_Box } from '../../shared/vis/GLTR_Text_Box';
import { showAlertDialog } from '../../shared/ui/dialog';
import { handleServerDemoSave } from '../../shared/controllers/serverDemoController';
// 国际化
import { tr } from '../../shared/lang/i18n-lite';
import { playAnalysisCompleteSound } from '../../shared/cross/soundNotification';

/**
 * 分析进度回调
 */
export type AnalyzeProgressCallback = (step: number, totalSteps: number, stage: string, percentage?: number) => void;

/**
 * 分析流程依赖
 */
export interface AnalyzeFlowDependencies {
    api: TextAnalysisAPI;
    textInputController: TextInputController;
    demoManager: DemoManager | null;
    appStateManager: AppStateManager;
    visualizationUpdater: VisualizationUpdater;
    demoBusinessLogic: DemoBusinessLogic;
    serverStorage: ServerStorage;
    lmf: GLTR_Text_Box;
    modelName: string;
    enableDemo: boolean;
    showToast: (message: string, type: 'success' | 'error') => void;
    updateFileNameDisplay: (filename: string | null) => void;
}

/**
 * Analyze & Upload 任务
 */
export interface AnalyzeUploadTask {
    name: string;
    path: string;
    text: string;
}

/**
 * 分析流程管理器
 */
export class AnalyzeFlowManager {
    private deps: AnalyzeFlowDependencies;

    constructor(deps: AnalyzeFlowDependencies) {
        this.deps = deps;
    }

    /**
     * 更新 demoManager 引用
     */
    setDemoManager(demoManager: DemoManager | null): void {
        this.deps.demoManager = demoManager;
    }

    /**
     * 更新分析进度显示
     */
    updateAnalyzeProgress(step: number, totalSteps: number, stage: string, percentage?: number): void {
        // 根据是否有百分比来决定显示格式
        const progressText = percentage !== undefined && percentage !== null
            ? `Step ${step}/${totalSteps}:\t ${stage} ${percentage}%`
            : `Step ${step}/${totalSteps}:\t ${stage}`;

        d3.select('#analyze_progress')
            .text(progressText)
            .style('display', 'inline-block');
    }

    /**
     * 滚动到顶部
     */
    private scrollToTop(): void {
        requestAnimationFrame(() => {
            const rightPanel = document.querySelector('.right_panel') as HTMLElement;
            if (rightPanel) {
                rightPanel.scrollTop = 0;
            }
        });
    }

    /**
     * 执行单次 Analyze
     * 
     * @param text 要分析的文本
     * @param enableAnimation 是否启用动画
     * @returns 分析结果
     */
    async runAnalyze(text: string, enableAnimation: boolean = true): Promise<AnalyzeResponse | null> {
        // 仅当文本与输入框不同时写入（如 Analyze & Upload 弹窗中的文本），保证输入框与分析内容一致。
        // 相同则跳过，避免触发 input 导致 clearDataOnTextChange，从而保留语义直方图（仅语义时点击 Analyze 的 bug 修复）
        const currentText = this.deps.textInputController.getTextValue();
        if (currentText !== text) {
            this.deps.textInputController.setTextValue(text);
        }

        // 分析前滚动到顶部
        this.scrollToTop();

        // 重置为新分析状态（数据来源为null，保存标志为false，清除文件名）
        this.deps.appStateManager.updateState({
            dataSource: null,
            isSavedToLocal: false,
            isSavedToServer: false,
            currentFileName: null
        });

        this.deps.appStateManager.setIsAnalyzing(true);
        this.deps.appStateManager.setGlobalLoading(true);
        this.deps.demoManager?.highlightDemo(null);

        // 清除URL中的demo参数（手动分析时）
        this.deps.demoBusinessLogic.clearDemoUrlParam();
        
        // 清除文件名显示（手动分析时，与远程demo行为一致）
        this.deps.updateFileNameDisplay(null);

        // 立即显示文本内容
        d3.select('#all_result').style('opacity', 1).style('display', null);
        this.deps.lmf.setTextOnly(text);
        this.deps.visualizationUpdater.updateHistogramVisibilityForPending('infoDensity', text);

        try {
            const data = await this.deps.api.analyze(
                this.deps.modelName,
                text,
                null,
                true,  // 启用流式响应
                (step: number, totalSteps: number, stage: string, percentage?: number) => {
                    // 更新UI进度显示
                    this.updateAnalyzeProgress(step, totalSteps, stage, percentage);
                }
            );

            this.deps.visualizationUpdater.updateFromRequest(data, !enableAnimation, { enableSave: true });
            
            // 分析完成，播放提示音
            playAnalysisCompleteSound();
            
            return data;
        } catch (error) {
            console.error('Analyze failed:', error);
            this.deps.appStateManager.setIsAnalyzing(false);
            this.deps.appStateManager.setGlobalLoading(false);
            this.deps.appStateManager.updateState({ hasValidData: false });
            this.deps.visualizationUpdater.rerenderHistograms();
            const message = error instanceof Error ? error.message : tr('Analysis failed');
            showAlertDialog(tr('Error'), `${tr('Analysis failed')}: ${message}`);
            return null;
        }
    }

    /**
     * 执行 Analyze -> Upload 串行流程
     * 
     * @param task 任务信息
     */
    async runAnalyzeAndUpload(task: AnalyzeUploadTask): Promise<void> {
        const textValue = task.text || '';

        // 执行分析
        const analyzeResult = await this.runAnalyze(textValue, true);
        if (!analyzeResult) {
            // 分析失败，已经在 runAnalyze 中处理了错误
            return;
        }

        // 分析成功，执行上传
        try {
            await handleServerDemoSave({
                api: this.deps.api,
                currentData: this.deps.visualizationUpdater.getCurrentData(),
                rawApiResponse: this.deps.visualizationUpdater.getRawApiResponse(),
                textFieldValue: textValue,
                enableDemo: this.deps.enableDemo,
                demoManager: this.deps.demoManager,
                presetSaveInfo: {
                    name: task.name,
                    path: task.path
                },
                serverStorage: this.deps.serverStorage,
                showSuccessToast: false,  // 由调用者自行处理成功提示
                onSaveStart: () => {
                    this.deps.appStateManager.updateState({ isSaving: true });
                },
                onSaveSuccess: () => {
                    this.deps.appStateManager.updateState({ 
                        isSaving: false,
                        isSavedToServer: true 
                    });
                    this.deps.showToast(tr('Demo "{name}" analyzed and uploaded successfully!').replace('{name}', task.name), 'success');
                },
                onSaveComplete: () => {
                    this.deps.appStateManager.updateState({ isSavedToServer: true });
                },
                onSaveError: () => {
                    // 保存失败后，恢复按钮状态（数据来源仍然是server）
                    this.deps.appStateManager.updateState({ isSaving: false });
                    this.deps.appStateManager.updateButtonStates();
                },
                setGlobalLoading: (loading: boolean) => this.deps.appStateManager.setGlobalLoading(loading),
                showToast: this.deps.showToast
            });
        } catch (error) {
            // handleServerDemoSave 已处理提示，这里确保所有状态恢复
            this.deps.appStateManager.setGlobalLoading(false);
            // 保存失败，但数据来源仍然是server（因为分析已经成功）
            this.deps.appStateManager.updateState({ isSaving: false });
            this.deps.appStateManager.updateButtonStates();
            console.error('Upload failed in runAnalyzeAndUpload:', error);
        }
    }
}

// 重新导出 buildFolderOptions 以便向后兼容
export { buildFolderOptions } from '../demo/demoPathUtils';

