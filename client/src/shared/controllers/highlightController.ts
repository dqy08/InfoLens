import * as d3 from 'd3';
import type { GLTR_Text_Box } from '../../shared/vis/GLTR_Text_Box';
import type { Histogram } from '../../shared/vis/Histogram';
import type { HistogramBinClickEvent } from '../../shared/vis/Histogram';
import type { ScatterPlot, ScatterChunkClickEvent } from '../../shared/vis/ScatterPlot';
import type { FrontendAnalyzeResult } from '../../shared/api/GLTR_API';
import {
    calculateHighlights,
    type HistogramType,
    type HighlightData
} from '../../features/compare/highlightUtils';

export type HighlightCurrentData = { result: FrontendAnalyzeResult; signalProbs?: number[]; pPwValues?: number[]; pwScores?: number[] } | null;

export type HighlightControllerOptions = {
    stats_frac: Histogram;
    stats_raw_score_normed?: Histogram;
    stats_match_score_progress?: ScatterPlot;
    lmf: GLTR_Text_Box;
    currentData: HighlightCurrentData;
};

export class HighlightController {
    private options: HighlightControllerOptions;

    constructor(options: HighlightControllerOptions) {
        this.options = options;
    }

    /**
     * 清除所有高亮（文本与直方图）
     */
    public clearHighlights(): void {
        this.options.stats_frac.clearSelection();
        this.options.stats_raw_score_normed?.clearSelection();
        this.options.stats_match_score_progress?.clearSelection();
        this.options.lmf.clearHighlight();
    }

    /**
     * 处理直方图 bin 点击事件
     */
    public handleHistogramBinClick(ev: HistogramBinClickEvent): void {
        const { currentData } = this.options;
        if (!currentData) return;

        // 如果 binIndex 为 -1，表示用户取消选择，清除所有高亮
        if (ev.binIndex === -1) {
            this.clearHighlights();
            return;
        }

        const { x0, x1, binIndex, no_bins, source } = ev;
        const highlightData: HighlightData = { ...currentData.result, signalProbs: currentData.signalProbs, pPwValues: currentData.pPwValues, pwScores: currentData.pwScores };

        let histogramType: HistogramType = 'token';
        if (source === 'stats_raw_score_normed') histogramType = 'raw_score_normed';

        if (histogramType === 'raw_score_normed') {
            this.options.stats_frac.clearSelection();
        } else {
            this.options.stats_raw_score_normed?.clearSelection();
        }

        this.options.stats_match_score_progress?.clearSelection();

        const { indices, style } = calculateHighlights(histogramType, x0, x1, binIndex, no_bins, highlightData);

        this.options.lmf.setHighlightedIndices(indices, style);
    }

    /**
     * 处理 match score per chunk 进度图 chunk 区域点击
     */
    public handleMatchScoreChunkClick(ev: ScatterChunkClickEvent): void {
        if (ev.source !== 'stats_match_score_progress') return;
        const { currentData } = this.options;
        if (!currentData) return;

        if (ev.chunkIndex === -1) {
            this.options.lmf.clearHighlight();
            return;
        }

        this.options.stats_frac.clearSelection();
        this.options.stats_raw_score_normed?.clearSelection();

        this.options.lmf.jumpToChunkHighlight(ev.x0, ev.x1);
    }

    /** 获取当前高亮数据 */
    public getCurrentData(): HighlightCurrentData {
        return (this.options as { currentData: HighlightCurrentData }).currentData;
    }

    /**
     * 更新当前数据（当数据变化时调用）
     */
    public updateCurrentData(currentData: HighlightCurrentData): void {
        (this.options as { currentData: HighlightCurrentData }).currentData = currentData;
    }
}

/**
 * 初始化高亮清除事件监听（点击空白处和 ESC 键）
 */
export const initHighlightClearListeners = (
    clearHighlights: () => void
): void => {
    // 点击页面空白处清除高亮（通用解决方案）
    // 监听整个文档的点击事件，但排除可交互元素
    d3.select('body').on('click.clearHighlight', (event: MouseEvent) => {
        const target = <HTMLElement>event.target;
        if (!target) return;
        
        // 排除可交互元素：token、按钮、输入框、直方图bin等
        const isInteractive = 
            target.closest('.token') ||           // token元素
            target.closest('button') ||           // 按钮
            target.closest('input') ||            // 输入框
            target.closest('textarea') ||         // 文本域
            target.closest('select') ||           // 下拉框
            target.closest('.bar') ||             // 直方图bar
            target.closest('.hover-area') ||      // 直方图悬停区域
            target.closest('a') ||                // 链接
            target.closest('[role="button"]') ||  // 有button角色的元素
            target.closest('[onclick]');          // 有onclick属性的元素
        
        // 如果点击的不是可交互元素，则清除高亮
        if (!isInteractive) {
            clearHighlights();
        }
    });

    // 按下 ESC 键清除高亮
    d3.select(window).on('keydown.clearHighlight', (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
            clearHighlights();
        }
    });
};

