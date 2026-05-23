/**
 * 应用状态管理模块
 * 负责集中管理应用状态和状态驱动的按钮状态更新
 */

import * as d3 from 'd3';

/**
 * 应用状态对象
 */
export interface AppState {
    isAnalyzing: boolean;
    isGlobalLoading: boolean;
    isSaving: boolean;  // 是否正在保存
    isSemanticSearching: boolean;  // 语义搜索进行中
    lastSearchedQuery: string | null;  // 上次成功搜索的 query，用于在输入未变化时保持 Search 按钮灰色
    hasValidData: boolean;  // 是否有有效数据
    // 以下字段仅用于按钮状态控制
    dataSource: 'local' | 'server' | null;  // 数据来源：null表示新分析的内容
    isSavedToLocal: boolean;  // 是否已保存到本地
    isSavedToServer: boolean;  // 是否已保存到服务器
    currentFileName: string | null;  // 当前文件名（本地或服务器）
}

/**
 * 按钮状态管理依赖
 */
export interface ButtonStateDependencies {
    submitBtn: d3.Selection<HTMLElement, unknown, HTMLElement, unknown>;
    saveBtn: d3.Selection<HTMLElement, unknown, HTMLElement, unknown>;
    saveLocalBtn: d3.Selection<HTMLElement, unknown, HTMLElement, unknown>;
    textField: d3.Selection<HTMLElement, unknown, HTMLElement, unknown>;
    textMetrics: d3.Selection<HTMLElement, unknown, HTMLElement, unknown>;
    semanticSearchBtn?: d3.Selection<HTMLElement, unknown, HTMLElement, unknown>;
    /** 获取当前语义搜索输入框的 query，用于判断是否与上次搜索一致 */
    getSemanticSearchQuery?: () => string;
    /** 翻译函数，用于 Search/Stop 按钮文案 */
    tr?: (key: string) => string;
}

/**
 * 应用状态管理器
 */
export class AppStateManager {
    private state: AppState;
    private deps: ButtonStateDependencies;

    constructor(deps: ButtonStateDependencies) {
        this.state = {
            isAnalyzing: false,
            isGlobalLoading: false,
            isSaving: false,
            isSemanticSearching: false,
            lastSearchedQuery: null,
            hasValidData: false,
            dataSource: null,
            isSavedToLocal: false,
            isSavedToServer: false,
            currentFileName: null
        };
        this.deps = deps;
    }

    /**
     * 获取当前状态
     */
    getState(): Readonly<AppState> {
        return { ...this.state };
    }

    /**
     * 获取 isAnalyzing 状态
     */
    getIsAnalyzing(): boolean {
        return this.state.isAnalyzing;
    }

    /**
     * 设置 isAnalyzing 状态
     */
    setIsAnalyzing(analyzing: boolean): void {
        this.updateState({ isAnalyzing: analyzing });
    }

    /**
     * 设置全局 loading 状态
     */
    setGlobalLoading(loading: boolean): void {
        this.updateState({ isGlobalLoading: loading });
    }

    setSemanticSearching(searching: boolean): void {
        this.updateState({ isSemanticSearching: searching });
    }

    setLastSearchedQuery(query: string | null): void {
        this.updateState({ lastSearchedQuery: query });
    }

    /**
     * 根据应用状态计算并更新所有按钮状态和UI元素状态
     */
    private updateButtonStatesFromAppState(): void {
        const hasText = (this.deps.textField.property('value') || '').length > 0;
        const isBusy = this.state.isAnalyzing || this.state.isGlobalLoading || this.state.isSaving;

        // 数据完整性：有有效数据即可保存
        const dataReadyForSave = this.state.hasValidData;

        // Analyze按钮：有文本 && 不忙 && 无有效数据（复用 hasValidData，与 TextMetrics 一致：有数据时灰色）
        this.deps.submitBtn.classed('inactive', !hasText || isBusy || this.state.hasValidData);

        // Upload / Save：仅在没有数据可保存时禁用
        this.deps.saveBtn.classed('inactive', !dataReadyForSave);
        this.deps.saveLocalBtn.classed('inactive', !dataReadyForSave);

        // 语义搜索按钮：Search/Stop 共用。进行中显示 Stop 且可点；否则显示 Search，按条件禁用
        if (this.deps.semanticSearchBtn && !this.deps.semanticSearchBtn.empty()) {
            const tr = this.deps.tr ?? ((k: string) => k);
            this.deps.semanticSearchBtn.text(this.state.isSemanticSearching ? tr('Stop') : tr('Search'));
            if (this.state.isSemanticSearching) {
                this.deps.semanticSearchBtn.classed('inactive', false);
            } else {
                const currentQuery = this.deps.getSemanticSearchQuery?.() ?? '';
                const queryUnchanged = this.state.lastSearchedQuery !== null && currentQuery === this.state.lastSearchedQuery;
                const canRunSemantic = (hasText || this.state.hasValidData) && currentQuery.length > 0;
                this.deps.semanticSearchBtn.classed('inactive', !canRunSemantic || queryUnchanged);
            }
        }

        // TextMetrics显示：有有效数据（hasValidData = true 时，stats 一定不为 null）
        if (!this.deps.textMetrics.empty()) {
            this.deps.textMetrics.classed('is-hidden', !this.state.hasValidData);
        }
    }

    /**
     * 更新应用状态并触发按钮状态更新
     */
    updateState(updates: Partial<AppState>): void {
        // 数据变更时清空 lastSearchedQuery（参考 TextMetrics：数据变化则状态重置）
        if (updates.hasValidData === false) {
            updates = { ...updates, lastSearchedQuery: null };
        }
        Object.assign(this.state, updates);
        this.updateButtonStatesFromAppState();

        // 同时更新全局loading的UI（如果需要）
        if (updates.isGlobalLoading !== undefined) {
            d3.selectAll(".loadersmall").style('display', updates.isGlobalLoading ? null : 'none');
            // 隐藏进度显示
            if (!updates.isGlobalLoading) {
                d3.select('#analyze_progress').text('').style('display', 'none');
            }
        }
        // 语义搜索 loading：独立 loader
        if (updates.isSemanticSearching !== undefined) {
            d3.select('#semantic_search_loader').style('visibility', updates.isSemanticSearching ? 'visible' : 'hidden');
            if (!updates.isSemanticSearching) {
                d3.select('#semantic_progress').text('').style('display', 'none');
            }
        }
    }

    /**
     * 手动触发按钮状态更新（用于外部调用）
     */
    updateButtonStates(): void {
        this.updateButtonStatesFromAppState();
    }
}

