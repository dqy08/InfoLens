/**
 * Demo 业务逻辑模块
 * 负责 Demo 的渲染、持久化、同步等核心业务逻辑
 */

import type { AnalysisData, AnalyzeResponse } from '../../shared/api/GLTR_API';
import type { TextInputController } from '../../shared/controllers/textInputController';
import type { DemoManager } from '../../shared/ui/demoManager';
import type { AppState } from '../analysis/appStateManager';
import { LocalDemoCache } from '../../shared/storage/localDemoCache';
import URLHandler from '../../shared/core/URLHandler';
import { getDemoName } from '../../shared/core/pathUtils';

/**
 * Demo 渲染选项
 */
export interface DemoRenderOptions {
    disableAnimation?: boolean;
    isNewDemo?: boolean;
}

/**
 * Demo 业务逻辑依赖
 */
export interface DemoBusinessDependencies {
    textInputController: TextInputController;
    demoManager: DemoManager | null;
    localDemoCache: LocalDemoCache;
    updateFromRequest: (data: AnalyzeResponse, disableAnimation: boolean, options?: { enableSave?: boolean }) => void;
    updateAppState: (updates: Partial<AppState>) => void;
    ensureSystemStarted: () => void;
    updateFileNameDisplay: (filename: string | null) => void;
}

/**
 * Demo 业务逻辑管理器
 */
export class DemoBusinessLogic {
    private deps: DemoBusinessDependencies;

    constructor(deps: DemoBusinessDependencies) {
        this.deps = deps;
    }

    /**
     * 更新 demoManager 引用
     */
    setDemoManager(demoManager: DemoManager | null): void {
        this.deps.demoManager = demoManager;
    }

    /**
     * 清除 URL 中的 demo 参数
     */
    clearDemoUrlParam(): void {
        const currentParams = URLHandler.parameters;
        delete currentParams['demo'];
        URLHandler.updateUrl(currentParams, false);
    }

    /**
     * 滚动到顶部
     */
    scrollToTop(): void {
        requestAnimationFrame(() => {
            const rightPanel = document.querySelector('.right_panel') as HTMLElement;
            if (rightPanel) {
                rightPanel.scrollTop = 0;
            }
        });
    }

    /**
     * 统一渲染 Demo 数据（本地和服务器共用）
     * 负责更新状态、渲染 UI 和滚动
     * 
     * @param data 要渲染的数据
     * @param source 数据来源：'local' | 'server'（用于判断是否需要显示文件名等本地文件特殊处理）
     * @param filename 文件名（本地文件）或路径（服务器文件，用于提取文件名）
     * @param options 渲染选项
     */
    renderDemo(
        data: AnalysisData,
        source: 'local' | 'server',
        filename?: string,
        options: DemoRenderOptions = {}
    ): void {
        const { disableAnimation = true, isNewDemo = true } = options;

        // 1. 先渲染 UI 并重新设置 hasValidData = true（基于已有的分析结果）
        this.deps.updateFromRequest(data, disableAnimation, { enableSave: false });
        // 2. 然后设置文本值（匹配分析结果的文本填入，不会清除hasValidData）
        this.deps.textInputController.setTextValue(data.request.text, true);

        // 3. 提取并保存文件名
        let currentFileName: string | null = null;
        if (source === 'local' && filename) {
            // 本地文件：直接使用文件名
            currentFileName = filename;
            this.deps.updateFileNameDisplay(filename);
            // 清除 demo 高亮（本地文件不在 demo 列表中）
            this.deps.demoManager?.highlightDemo(null);
        } else {
            // 非本地文件：清除文件名显示
            this.deps.updateFileNameDisplay(null);
            if (source === 'server' && filename) {
                // 服务器文件：使用工具函数提取文件名（不含扩展名），并添加 .json
                const name = getDemoName(filename);
                currentFileName = `${name}.json`;
            }
        }

        // 4. 更新数据来源状态并重置保存标志，同时保存文件名
        this.deps.updateAppState({
            dataSource: source,
            isSavedToLocal: false,
            isSavedToServer: false,
            currentFileName
        });

        // 5. 确保系统已启动
        this.deps.ensureSystemStarted();

        // 6. 如果是新 demo，滚动到顶部
        if (isNewDemo) {
            this.scrollToTop();
        }
    }
}

