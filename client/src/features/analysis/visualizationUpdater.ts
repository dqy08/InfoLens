/**
 * 可视化更新模块
 * 负责处理分析结果的可视化更新逻辑
 */

import * as d3 from 'd3';
import type { AnalyzeResponse, FrontendAnalyzeResult, FrontendToken } from '../../shared/api/GLTR_API';
import type { GLTR_Text_Box } from '../../shared/vis/GLTR_Text_Box';
import type { HighlightController } from '../../shared/controllers/highlightController';
import type { TextInputController } from '../../shared/controllers/textInputController';
import type { Histogram } from '../../shared/vis/Histogram';
import type { ScatterPlot } from '../../shared/vis/ScatterPlot';
import type { AppStateManager } from './appStateManager';
import {
    cloneFrontendToken,
    mergeTokensForRendering,
    createRawSnapshot
} from '../../shared/cross/tokenUtils';
import { getTokenRawScore, mergeTokenSpansFullyForRendering, normalizeTokenScores } from '../../shared/cross/semanticUtils';
import {
    validateTokenConsistency,
    validateTokenProbabilities,
    validateTokenPredictions
} from '../../shared/cross/dataValidation';
import {
    calculateTextStats,
    calculateMergedTokenSurprisals,
    computeAverage,
    computeP90,
    type TextStats
} from '../../shared/cross/textStatistics';
import {
    getTokenSurprisalHistogramConfig,
    getSurprisalProgressConfig,
    getMatchScoreProgressConfig,
    getRawScoreNormedHistogramConfig
} from "./visualizationConfigs";
import { getSemanticSimilarityColor, HISTOGRAM_MIN_ALPHA } from '../../shared/cross/SurprisalColorConfig';
import { showAlertDialog } from '../../shared/ui/dialog';
import { tr } from '../../shared/lang/i18n-lite';
import { computeExpectedCounts } from './lognormalFit';
import { findSignalThresholdWithLog, type signalFitResult, type SignalThresholdBin } from './signalThresholdDetector';
import { getSemanticAnalysisEnabled } from '../../shared/cross/semanticAnalysisManager';
import { getDigitsMergeEnabled } from '../../shared/cross/digitsMergeManager';
import { getSemanticMatchThreshold } from '../../shared/cross/semanticThresholdManager';
import { applySemanticDebugInfoPanel } from '../../shared/prediction_attribution/core/semanticDebugInfo';

/**
 * P(signal | raw_score_normed = s) 复用 findSignalThreshold 的 bins
 * 每个样本 s 落入对应 bin，P(signal) = (obsInBin - expInBin) / obsInBin
 */
function signalProbFromBins(scores: number[], bins: SignalThresholdBin[]): number[] {
    if (scores.length === 0 || bins.length === 0) return [];
    const tauLefts = bins.map((b) => b.tauLeft);
    return scores.map((s) => {
        const i = Math.max(0, Math.min(bins.length - 1, d3.bisectRight(tauLefts, s) - 1));
        const b = bins[i]!;
        if (s < b.tauLeft || s >= b.tauRight) return 0;
        return b.obsInBin > 0 ? Math.max(0, Math.min(1, (b.obsInBin - b.expInBin) / b.obsInBin)) : 0;
    });
}

/**
 * 可视化更新依赖
 */
export interface VisualizationDependencies {
    lmf: GLTR_Text_Box;
    highlightController: HighlightController;
    textInputController: TextInputController;
    stats_frac: Histogram;
    stats_raw_score_normed: Histogram;
    stats_surprisal_progress: ScatterPlot;
    stats_match_score_progress: ScatterPlot;
    appStateManager: AppStateManager;
    surprisalColorScale: d3.ScaleSequential<string>;
    /** 语义/密度模式切换时同步 Analyze·上传·保存·metrics 等 chrome 显隐 */
    syncModeChrome?: (semanticEnabled: boolean) => void;
}

/** 语义分析原始数据（独立存储） */
export interface SemanticData {
    text: string;
    model?: string;
    /** 整段模式：API `token_attention` 字段的原始 score 条目副本，用于切换 digit merge 时重算（分块模式不存） */
    semanticTokenSpansFromApi?: Array<{
        offset: [number, number];
        raw: string;
        score: number;
        rawScore?: number;
    }>;
    /**
     * 经 overlap/digit 合并与归一化后的 token 归因 score 条目。
     * 字段名 `token_attention` 为 API 历史遗留，**非** transformer attention 权重。
     */
    token_attention: Array<{
        offset: [number, number];
        raw: string;
        score: number;
        rawScore?: number;
    }>;
    /** 拟合结果，由数据层在归一化后计算并传入；整段模式使用 */
    signalFitResult?: signalFitResult | null;
    /** 分块边界；分块模式使用，每项可含该块独立拟合的 thresholdResult */
    chunkInfos?: Array<{ startOffset: number; endOffset: number; chunkIndex: number; chunkMatchDegree: number; thresholdResult?: signalFitResult }>;
    /** 全文匹配度；非分块模式使用，用于 pw_score 的匹配度乘法因子 */
    full_match_degree?: number;
}

/** 是否有语义分析数据：token_attention 或 chunkInfos 任一非空即视为有数据 */
function hasSemanticData(data: { token_attention?: unknown[]; chunkInfos?: unknown[] } | null | undefined): boolean {
    return (data?.token_attention?.length ?? 0) > 0 || (data?.chunkInfos?.length ?? 0) > 0;
}

/**
 * 当前数据状态
 * 信息密度与语义分析独立存储；展示由当前模式二选一，互不合并
 */
export interface CurrentDataState {
    /** 信息密度分析结果（独立） */
    infoDensityData: AnalyzeResponse | null;
    /** 语义分析结果（独立） */
    semanticData: SemanticData | null;
    rawApiResponse: AnalyzeResponse | null;
    currentSurprisals: number[] | null;
    currentTokenAvg: number | null;
    currentTokenP90: number | null;
    currentTotalSurprisal: number | null;
}

/**
 * 可视化更新管理器
 */
export class VisualizationUpdater {
    private deps: VisualizationDependencies;
    private currentState: CurrentDataState;

    constructor(deps: VisualizationDependencies) {
        this.deps = deps;
        this.currentState = {
            infoDensityData: null,
            semanticData: null,
            rawApiResponse: null,
            currentSurprisals: null,
            currentTokenAvg: null,
            currentTokenP90: null,
            currentTotalSurprisal: null
        };
    }

    /**
     * 获取当前数据状态
     */
    getCurrentState(): Readonly<CurrentDataState> {
        return { ...this.currentState };
    }

    /**
     * 获取当前原始API响应
     */
    getRawApiResponse(): AnalyzeResponse | null {
        return this.currentState.rawApiResponse;
    }

    /**
     * 获取当前展示数据（按当前模式取 infoDensityData 或 semanticData，互不合并）
     */
    getCurrentData(): AnalyzeResponse | null {
        const display = this.computeDisplayResult();
        if (!display) return null;
        return { request: { text: display.originalText }, result: display };
    }

    /** 语义分块中达到 Match threshold 的 chunk（供 Find 浮条 ↑↓） */
    getMatchedChunks(): Array<{ startOffset: number; endOffset: number; chunkIndex: number; chunkMatchDegree: number }> {
        const chunkInfos = this.currentState.semanticData?.chunkInfos;
        if (!chunkInfos?.length) return [];
        const threshold = getSemanticMatchThreshold();
        return chunkInfos.filter((c) => c.chunkMatchDegree >= threshold);
    }

    /** 切回语义模式时恢复 Match 文案：分块取 max(chunkMatchDegree)，整段取 full_match_degree */
    peekSemanticMatchDegree(): number | null {
        const sem = this.currentState.semanticData;
        if (!sem || !hasSemanticData(sem)) return null;
        if (sem.chunkInfos?.length) {
            return Math.max(...sem.chunkInfos.map((c) => c.chunkMatchDegree));
        }
        return typeof sem.full_match_degree === 'number' ? sem.full_match_degree : null;
    }

    /**
     * 获取当前 surprisal 数据
     */
    getCurrentSurprisals(): number[] | null {
        return this.currentState.currentSurprisals;
    }

    /**
     * 更新文本指标（包括模型显示）
     */
    private updateTextMetrics(stats: TextStats | null, modelName?: string | null | undefined): void {
        this.deps.textInputController.updateTextMetrics(stats, modelName);
    }

    /**
     * 清除高亮
     */
    private clearHighlights(options?: { preserveChunkInterval?: boolean }): void {
        this.deps.highlightController.clearHighlights(options);
    }

    /**
     * 计算展示结果：按当前模式二选一（语义 / 信息密度），不合并
     */
    private computeDisplayResult(): (FrontendAnalyzeResult & {
        rawScoresNormed?: number[];
        tokenRawScores?: number[];
        chunkInfos?: SemanticData['chunkInfos'];
    }) | null {
        const info = this.currentState.infoDensityData;
        const sem = this.currentState.semanticData;
        const infoResult = info?.result as FrontendAnalyzeResult | undefined;

        if (getSemanticAnalysisEnabled()) {
            if (sem && hasSemanticData(sem)) {
                return this.buildSemanticOnlyResult(
                    { model: sem.model },
                    sem.token_attention,
                    sem.text,
                    sem.chunkInfos
                );
            }
            return null;
        }
        if (infoResult) return { ...infoResult };
        return null;
    }

    /**
     * 分析开始前更新直方图显示/隐藏：基于当前模式 + 将要得到的数据
     * @param mode 即将进行的分析类型
     * @param text 即将分析的文本
     * @param willBeChunked 语义分析时：true 表示将走分块模式，直方图不显示
     */
    public updateHistogramVisibilityForPending(mode: 'infoDensity' | 'semantic', text: string, willBeChunked?: boolean): void {
        const tokenHistogramItem = document.getElementById('token_histogram_item');
        const surprisalProgressItem = document.getElementById('surprisal_progress_item');
        const rawScoreNormedItem = document.getElementById('raw_score_normed_histogram_item');
        const matchScoreProgressItem = document.getElementById('match_score_progress_item');

        const showInfoDensity = mode === 'infoDensity';
        const showSemantic = mode === 'semantic';

        if (tokenHistogramItem) tokenHistogramItem.style.display = showInfoDensity ? '' : 'none';
        if (surprisalProgressItem) surprisalProgressItem.style.display = showInfoDensity ? '' : 'none';
        /** 直方图仅在整段模式显示，chunk 模式下不显示 */
        const showRawScoreHistogram = showSemantic && !willBeChunked;
        if (rawScoreNormedItem) rawScoreNormedItem.style.display = showRawScoreHistogram ? '' : 'none';
        /** semantic match progress 仅 chunk 模式显示 */
        if (matchScoreProgressItem) matchScoreProgressItem.style.display = showSemantic && !!willBeChunked ? '' : 'none';

        // pending 时渲染空统计图（坐标轴 + 空柱体/散点），避免空白
        if (showInfoDensity && mode === 'infoDensity') {
            const tokenConfig = getTokenSurprisalHistogramConfig();
            this.deps.stats_frac.update({ ...tokenConfig, data: [], colorScale: () => 'transparent' });
            const tokenTitle = document.getElementById('token_histogram_title');
            if (tokenTitle) tokenTitle.textContent = tokenConfig.label;
            const progressConfig = getSurprisalProgressConfig();
            this.deps.stats_surprisal_progress.update({ ...progressConfig, data: [] });
            const progressTitle = document.getElementById('surprisal_progress_title');
            if (progressTitle && progressConfig.label) progressTitle.textContent = progressConfig.label;
        }
        if (showRawScoreHistogram && mode === 'semantic') {
            const rawScoreNormedConfig = getRawScoreNormedHistogramConfig();
            this.deps.stats_raw_score_normed.update({ ...rawScoreNormedConfig, data: [], colorScale: () => 'transparent' });
            const titleEl = document.getElementById('raw_score_normed_histogram_title');
            if (titleEl) titleEl.textContent = rawScoreNormedConfig.label;
        }
        if (showSemantic && mode === 'semantic' && willBeChunked) {
            const matchScoreProgressConfig = getMatchScoreProgressConfig();
            const docLen = text.length;
            this.deps.stats_match_score_progress.update({
                ...matchScoreProgressConfig,
                data: [],
                showMovingAverage: false,
                chunkLines: [],
                thresholdLine: getSemanticMatchThreshold(),
                extent: { x: docLen > 0 ? [0, docLen] : undefined, y: [0, 1] }
            });
            const matchScoreTitleEl = document.getElementById('match_score_progress_title');
            if (matchScoreTitleEl && matchScoreProgressConfig.label) matchScoreTitleEl.textContent = matchScoreProgressConfig.label;
        }
    }

    /**
     * 重新渲染直方图（内部方法）
     * Semantic Query 勾选：仅语义相关图；未勾选：有信息密度数据时显示 token + surprisal
     * @param skipLmfUpdate 为 true 时跳过 lmf.update（主题切换时由 rerenderOnThemeChange 统一重绘，避免竞态）
     */
    private updateVisualizationInternal(skipLmfUpdate = false): void {
        const hasInfoDensity = !!this.currentState.infoDensityData;
        const displayResult = this.computeDisplayResult();
        const sem = this.currentState.semanticData;
        const showInfoDensityCharts = hasInfoDensity && !getSemanticAnalysisEnabled();

        const tokenHistogramItem = document.getElementById('token_histogram_item');
        const surprisalProgressItem = document.getElementById('surprisal_progress_item');
        const rawScoreNormedItem = document.getElementById('raw_score_normed_histogram_item');

        if (showInfoDensityCharts) {
            const currentSurprisals = this.currentState.currentSurprisals;
            const currentTokenAvg = this.currentState.currentTokenAvg;
            const currentTokenP90 = this.currentState.currentTokenP90;
            if (currentSurprisals) {
                const tokenHistogramConfig = getTokenSurprisalHistogramConfig();
                this.deps.stats_frac.update({
                    ...tokenHistogramConfig,
                    data: currentSurprisals,
                    colorScale: this.deps.surprisalColorScale,
                    averageValue: currentTokenAvg ?? undefined,
                    p90Value: currentTokenP90 ?? undefined,
                    p90Label: tokenHistogramConfig.averageLabel,
                });
                const titleElement = document.getElementById('token_histogram_title');
                if (titleElement) titleElement.textContent = tokenHistogramConfig.label;
            }
            if (currentSurprisals && currentSurprisals.length > 0) {
                const surprisalProgressConfig = getSurprisalProgressConfig();
                this.deps.stats_surprisal_progress.update({
                    ...surprisalProgressConfig,
                    data: currentSurprisals,
                });
                const surprisalProgressTitleElement = document.getElementById('surprisal_progress_title');
                if (surprisalProgressTitleElement && surprisalProgressConfig.label) {
                    surprisalProgressTitleElement.textContent = surprisalProgressConfig.label;
                }
            }
            if (tokenHistogramItem) tokenHistogramItem.style.display = '';
            if (surprisalProgressItem) surprisalProgressItem.style.display = '';
        } else {
            if (tokenHistogramItem) tokenHistogramItem.style.display = 'none';
            if (surprisalProgressItem) surprisalProgressItem.style.display = 'none';
        }

        const rawScoresNormed = displayResult?.rawScoresNormed;
        const validRawScoresNormed = rawScoresNormed?.filter((s) => typeof s === 'number' && isFinite(s));
        const signalFitResult = sem?.signalFitResult ?? null;
        const chunkInfos = sem?.chunkInfos;
        const isChunkMode = (chunkInfos?.length ?? 0) > 0;
        const chunksWithThreshold = chunkInfos?.filter((c) => c.thresholdResult != null) ?? [];
        const usePerChunkThreshold = chunksWithThreshold.length > 0;
        const thresholdByChunk = usePerChunkThreshold
            ? new Map(chunksWithThreshold.map((c) => [c.chunkIndex, c.thresholdResult!]))
            : null;
        if (validRawScoresNormed && validRawScoresNormed.length > 0) {
            const rawScoreNormedConfig = getRawScoreNormedHistogramConfig();
            const colorScale = (v: number) => getSemanticSimilarityColor(v, HISTOGRAM_MIN_ALPHA);
            const thresholdForHistogram = usePerChunkThreshold && chunksWithThreshold.length > 0
                ? chunksWithThreshold[0]!.thresholdResult!
                : signalFitResult;
            // confidence>0：findSignalThreshold 成功（≥ MIN_ACCEPTABLE）；confidence===0 为 P90 回退，不画截尾对数正态期望曲线
            const fitResult = validRawScoresNormed.length >= 2 && thresholdForHistogram != null && thresholdForHistogram.confidence > 0
                ? {
                    mu: thresholdForHistogram.mu,
                    sigma: thresholdForHistogram.sigma,
                    expectedCounts: computeExpectedCounts(
                        thresholdForHistogram.mu,
                        thresholdForHistogram.sigma,
                        rawScoreNormedConfig.extent as [number, number],
                        rawScoreNormedConfig.no_bins,
                        validRawScoresNormed.length
                    ),
                }
                : null;
            const signalProbs = thresholdForHistogram != null
                ? signalProbFromBins(validRawScoresNormed, thresholdForHistogram.bins)
                : [];
            /**
             * P_pw：后验信号概率的简化映射，x <= threshold 时为 0，x > threshold 时为 1
             * pw_score = score × P_pw × matchDegree
             * 分块模式：每个 token 使用其所属 chunk 的 threshold 和 chunkMatchDegree
             * 非分块模式：使用全文匹配度 full_match_degree
             */
            const rawScoresNormedFull = displayResult!.rawScoresNormed ?? [];
            const bpeBpeMergedTokens = displayResult?.bpeBpeMergedTokens ?? [];

            const getChunkForToken = (tokenIndex: number) => {
                const token = bpeBpeMergedTokens[tokenIndex];
                if (!token || !isChunkMode) return null;
                const offset = token.offset[0];
                return chunkInfos!.find((c) => c.startOffset <= offset && offset < c.endOffset) ?? null;
            };

            const getThresholdForToken = (i: number): number => {
                const chunk = getChunkForToken(i);
                if (chunk && thresholdByChunk != null) {
                    const tr = thresholdByChunk.get(chunk.chunkIndex);
                    if (tr) return tr.threshold;
                }
                return signalFitResult?.threshold ?? 0;
            };

            const getMatchDegreeForToken = (i: number): number => {
                const chunk = getChunkForToken(i);
                if (chunk) return chunk.chunkMatchDegree;
                return sem?.full_match_degree ?? 1;
            };

            const hasThreshold = signalFitResult != null || thresholdByChunk != null;
            const pPwValues = hasThreshold
                ? rawScoresNormedFull.map((s, i) => {
                    const threshold = getThresholdForToken(i);
                    const isAboveThreshold = typeof s === 'number' && isFinite(s) && s > threshold;
                    return isAboveThreshold ? 1 : 0;
                })
                : [];
            const pwScores = hasThreshold
                ? rawScoresNormedFull.map((s, i) => {
                    const threshold = getThresholdForToken(i);
                    const isAboveThreshold = typeof s === 'number' && isFinite(s) && s > threshold;
                    const baseScore = isAboveThreshold ? s : 0;
                    const matchDegree = getMatchDegreeForToken(i);
                    return baseScore * matchDegree;
                })
                : [];

            const colorSourceEl = document.getElementById('semantic_color_source_select') as HTMLSelectElement | null;
            const colorSource = colorSourceEl?.value ?? 'pw_score';
            const scoresForColor = colorSource === 'signal_probability' ? pPwValues
                : colorSource === 'pw_score' ? pwScores
                : (displayResult!.rawScoresNormed ?? []);

            // tooltip / color source 切换需要 pPwValues/pwScores，即使 fitResult 为 null（如 P90 回退）也要传递
            const resultWithExt = hasThreshold
                ? { ...displayResult, signalProbs, pPwValues, pwScores }
                : displayResult!;
            this.deps.highlightController.updateCurrentData(
                hasThreshold
                    ? { result: resultWithExt, signalProbs, pPwValues, pwScores }
                    : { result: resultWithExt }
            );
            if (!skipLmfUpdate) {
                this.deps.lmf.update({
                    ...resultWithExt,
                    ...(hasThreshold ? { pwScores } : {}),
                    colorScores: scoresForColor,
                } as FrontendAnalyzeResult & { pPwValues?: number[]; pwScores?: number[]; colorScores?: number[] });
            }

            /** 直方图仅在整段模式显示，chunk 模式下不统计、不显示 */
            if (!isChunkMode) {
                const probCurveData = signalProbs.length > 0
                    ? (() => {
                        const pairs = validRawScoresNormed.map((x, i) => ({ x, y: signalProbs[i]! })).sort((a, b) => a.x - b.x);
                        return { x: pairs.map(p => p.x), y: pairs.map(p => p.y) };
                    })()
                    : undefined;
                const signalThresholdPercentile = thresholdForHistogram != null && validRawScoresNormed.length > 0
                    ? Math.round((validRawScoresNormed.filter((s) => s < thresholdForHistogram.threshold).length / validRawScoresNormed.length) * 100)
                    : undefined;
                this.deps.stats_raw_score_normed.update({
                    ...rawScoreNormedConfig,
                    data: validRawScoresNormed,
                    colorScale,
                    fitExpectedCounts: fitResult?.expectedCounts,
                    showProbCurve: true,
                    probCurveData: probCurveData?.x.length ? probCurveData : undefined,
                    signalThreshold: thresholdForHistogram?.threshold ?? undefined,
                    signalThresholdPercentile: signalThresholdPercentile ?? undefined,
                });
                const titleEl = document.getElementById('raw_score_normed_histogram_title');
                if (titleEl) titleEl.textContent = rawScoreNormedConfig.label;
                if (rawScoreNormedItem) rawScoreNormedItem.style.display = '';
            } else {
                if (rawScoreNormedItem) rawScoreNormedItem.style.display = 'none';
            }
            /** semantic match progress：仅 chunk 模式，仅绘制 chunk 匹配线，不绘制点 */
            if (isChunkMode) {
                const matchScoreProgressConfig = getMatchScoreProgressConfig();
                const docLen = (displayResult?.originalText ?? '').length;
                const chunkLines = chunkInfos?.length
                    ? chunkInfos.map((c) => ({ x0: c.startOffset, x1: c.endOffset, y: c.chunkMatchDegree }))
                    : [];
                const thresholdLine = getSemanticMatchThreshold();
                this.deps.stats_match_score_progress.update({
                    ...matchScoreProgressConfig,
                    data: [],
                    showMovingAverage: false,
                    chunkLines,
                    thresholdLine,
                    chunkInteraction: true,
                    extent: { x: docLen > 0 ? [0, docLen] : undefined, y: [0, 1] }
                });
                const matchScoreTitleEl = document.getElementById('match_score_progress_title');
                if (matchScoreTitleEl && matchScoreProgressConfig.label) matchScoreTitleEl.textContent = matchScoreProgressConfig.label;
                const matchScoreProgressItem = document.getElementById('match_score_progress_item');
                if (matchScoreProgressItem) matchScoreProgressItem.style.display = '';
            } else {
                const matchScoreProgressItem = document.getElementById('match_score_progress_item');
                if (matchScoreProgressItem) matchScoreProgressItem.style.display = 'none';
            }
        } else {
            const needLmfUpdate = !!displayResult && (hasInfoDensity || !!validRawScoresNormed?.length || hasSemanticData(sem));
            if (displayResult) this.deps.highlightController.updateCurrentData({ result: displayResult });
            if (needLmfUpdate && !skipLmfUpdate) {
                this.deps.lmf.update(displayResult!);
            }
            /** chunk 模式下不显示直方图；整段模式且无数据时显示空占位 */
            if (getSemanticAnalysisEnabled() && !isChunkMode) {
                const rawScoreNormedConfig = getRawScoreNormedHistogramConfig();
                this.deps.stats_raw_score_normed.update({ ...rawScoreNormedConfig, data: [], colorScale: () => 'transparent' });
                const titleEl = document.getElementById('raw_score_normed_histogram_title');
                if (titleEl) titleEl.textContent = rawScoreNormedConfig.label;
                if (rawScoreNormedItem) rawScoreNormedItem.style.display = '';
            } else {
                if (rawScoreNormedItem) rawScoreNormedItem.style.display = 'none';
            }
            /** semantic match progress 无数据时显示空占位（仅 chunk 模式） */
            if (getSemanticAnalysisEnabled() && isChunkMode) {
                const matchScoreProgressConfig = getMatchScoreProgressConfig();
                const docLen = (displayResult?.originalText ?? '').length;
                const chunkLines = chunkInfos?.length
                    ? chunkInfos.map((c) => ({ x0: c.startOffset, x1: c.endOffset, y: c.chunkMatchDegree }))
                    : [];
                const thresholdLine = getSemanticMatchThreshold();
                this.deps.stats_match_score_progress.update({
                    ...matchScoreProgressConfig,
                    data: [],
                    showMovingAverage: false,
                    chunkLines,
                    thresholdLine,
                    chunkInteraction: true,
                    extent: { x: docLen > 0 ? [0, docLen] : undefined, y: [0, 1] }
                });
                const matchScoreTitleEl = document.getElementById('match_score_progress_title');
                if (matchScoreTitleEl && matchScoreProgressConfig.label) matchScoreTitleEl.textContent = matchScoreProgressConfig.label;
                const matchScoreProgressItem = document.getElementById('match_score_progress_item');
                if (matchScoreProgressItem) matchScoreProgressItem.style.display = '';
            } else {
                const matchScoreProgressItem = document.getElementById('match_score_progress_item');
                if (matchScoreProgressItem) matchScoreProgressItem.style.display = 'none';
            }
        }
    }

    /** 重新渲染直方图（供外部调用） */
    public rerenderHistograms(): void {
        this.updateVisualizationInternal(false);
    }

    /** 仅更新语义着色源（color source 切换时调用，不重新拟合） */
    public updateSemanticColorSource(): void {
        const cd = this.deps.highlightController.getCurrentData();
        const r = cd?.result as (FrontendAnalyzeResult & { rawScoresNormed?: number[]; pPwValues?: number[]; pwScores?: number[] }) | undefined;
        if (!r?.rawScoresNormed?.length) return;
        const el = document.getElementById('semantic_color_source_select') as HTMLSelectElement | null;
        const v = el?.value ?? 'pw_score';
        const pPwValues = cd!.pPwValues ?? r.pPwValues;
        const pwScores = cd!.pwScores ?? r.pwScores;
        const scoresForColor = v === 'signal_probability' ? (pPwValues ?? [])
            : v === 'pw_score' ? (pwScores ?? [])
            : r.rawScoresNormed;
        this.deps.lmf.update({ ...r, pPwValues, pwScores, colorScores: scoresForColor } as FrontendAnalyzeResult & { pPwValues?: number[]; pwScores?: number[]; colorScores?: number[] });
    }

    /** 主题切换时调用：在样式生效后统一重绘直方图与文本（rgba 透出背景，需等新主题生效） */
    public rerenderOnThemeChange(): void {
        requestAnimationFrame(() => requestAnimationFrame(() => {
            this.updateVisualizationInternal(true);
            this.deps.lmf.reRenderCurrent();
        }));
    }

    /**
     * 文本修改时清除独立存储的数据（避免展示与输入不一致）
     */
    public clearDataOnTextChange(): void {
        this.currentState.infoDensityData = null;
        this.currentState.semanticData = null;
        this.currentState.rawApiResponse = null;
        this.currentState.currentSurprisals = null;
        this.currentState.currentTokenAvg = null;
        this.currentState.currentTokenP90 = null;
        this.currentState.currentTotalSurprisal = null;
        this.deps.highlightController.updateCurrentData(null);
        d3.select('#all_result').style('opacity', 0);
        this.updateSemanticDebugInfo();
    }

    /** 正文重绘回退用原文：语义 → 信息密度 → 左侧输入 */
    private resolvePlainTextFallback(): string {
        const infoResult = this.currentState.infoDensityData?.result as FrontendAnalyzeResult | undefined;
        return (
            this.currentState.semanticData?.text
            ?? this.currentState.infoDensityData?.request?.text
            ?? infoResult?.originalText
            ?? this.deps.textInputController.getTextValue()
            ?? ''
        );
    }

    /**
     * 统一正文刷新：有分析结果走完整着色管线，否则 showPlainText 剥掉语义着色。
     */
    private refreshTextAfterDataChange(
        displayResult: ReturnType<VisualizationUpdater['computeDisplayResult']>,
        plainTextFallback: string
    ): void {
        this.deps.lmf.clearHighlight();
        if (displayResult) {
            this.updateVisualizationInternal(false);
        } else {
            this.deps.highlightController.updateCurrentData(null);
            this.deps.lmf.showPlainText(plainTextFallback);
            this.updateVisualizationInternal(true);
        }
    }

    /**
     * 清除语义分析相关数据并重绘（直方图、debug、正文着色），使界面与「无语义搜索结果」一致
     */
    public clearSemanticState(): void {
        const plainTextFallback = this.resolvePlainTextFallback();
        this.currentState.semanticData = null;
        const rawScoreNormedItem = document.getElementById('raw_score_normed_histogram_item');
        if (rawScoreNormedItem) rawScoreNormedItem.style.display = 'none';
        const matchScoreProgressItem = document.getElementById('match_score_progress_item');
        if (matchScoreProgressItem) matchScoreProgressItem.style.display = 'none';
        this.updateSemanticDebugInfo();
        const displayResult = this.computeDisplayResult();
        this.refreshTextAfterDataChange(displayResult, plainTextFallback);
        this.deps.appStateManager.updateButtonStates();
        this.deps.syncModeChrome?.(getSemanticAnalysisEnabled());
    }

    /**
     * digit merge 用户偏好变化时：对信息密度与整段语义从可重算数据源刷新；分块语义无副本则保持当前展示不变
     */
    public applyDigitsMergeSetting(): void {
        const digitMerge = getDigitsMergeEnabled();
        const info = this.currentState.infoDensityData;
        if (info?.result) {
            const fr = info.result as FrontendAnalyzeResult;
            const text = info.request?.text ?? fr.originalText ?? '';
            if (fr.originalTokens?.length && text) {
                const newMerged = mergeTokensForRendering(fr.originalTokens, text, { digitMerge });
                fr.bpeBpeMergedTokens = newMerged;
                fr.bpe_strings = newMerged;
            }
        }
        const sem = this.currentState.semanticData;
        if (sem && !sem.chunkInfos?.length && sem.semanticTokenSpansFromApi?.length && sem.text) {
            const mergedSpans = mergeTokenSpansFullyForRendering(
                sem.semanticTokenSpansFromApi,
                sem.text,
                { digitMerge }
            );
            const normalizedSpans = normalizeTokenScores(mergedSpans);
            const computedSignalFit = findSignalThresholdWithLog(normalizedSpans);
            sem.token_attention = normalizedSpans;
            sem.signalFitResult = computedSignalFit ?? undefined;
        }
        const infoResult = this.currentState.infoDensityData?.result as FrontendAnalyzeResult | undefined;
        const safeText = this.currentState.infoDensityData?.request?.text ?? infoResult?.originalText ?? '';
        if (infoResult?.bpeBpeMergedTokens?.length && safeText) {
            const mergedSurprisals = calculateMergedTokenSurprisals(infoResult.bpeBpeMergedTokens);
            this.currentState.currentSurprisals = mergedSurprisals;
            this.currentState.currentTokenAvg = computeAverage(mergedSurprisals);
            this.currentState.currentTokenP90 = computeP90(mergedSurprisals);
        }
        const displayResult = this.computeDisplayResult();
        this.refreshTextAfterDataChange(displayResult, this.resolvePlainTextFallback());
        this.deps.appStateManager.updateButtonStates();
        this.deps.syncModeChrome?.(getSemanticAnalysisEnabled());
    }

    /**
     * 根据语义分析配置同步 UI 状态（查询输入框、文本渲染模式等）
     * 界面完全由配置决定；切换模式时保留另一边内存数据，仅切换展示
     */
    public syncSemanticUiFromConfig(): void {
        const enabled = getSemanticAnalysisEnabled();
        const el = document.getElementById('semantic_analysis_section');
        if (el) el.style.display = enabled ? '' : 'none';
        this.deps.lmf.updateOptions({ semanticAnalysisMode: enabled }, false);
        const displayResult = this.computeDisplayResult();
        this.refreshTextAfterDataChange(displayResult, this.resolvePlainTextFallback());
        this.deps.appStateManager.updateButtonStates();
        this.deps.syncModeChrome?.(enabled);
    }

    /**
     * 更新可视化（核心方法）
     * 
     * @param data 分析响应数据
     * @param disableAnimation 是否禁用动画
     * @param options 选项
     */
    updateFromRequest(
        data: AnalyzeResponse,
        disableAnimation: boolean = false,
        options: { enableSave?: boolean } = {}
    ): void {
        const { enableSave = true } = options;

        const abortDueToInvalidResponse = (message: string) => {
            console.error(message);
            showAlertDialog(tr('Error'), message);
            this.deps.appStateManager.updateState({ hasValidData: false });
            this.syncSemanticUiFromConfig();
        };

        try {
            // 只有 Analyze 触发时开启动画，其它情况保持关闭（默认已关闭）
            if (!disableAnimation) {
                this.deps.lmf.updateOptions({ enableRenderAnimation: true }, false);
            }
            // Semantic analysis 模式由配置决定
            this.deps.lmf.updateOptions({
                semanticAnalysisMode: getSemanticAnalysisEnabled(),
            }, false);

            d3.select('#all_result').style('opacity', 1).style('display', null);
            this.deps.appStateManager.setIsAnalyzing(false);
            this.deps.appStateManager.setGlobalLoading(false);

            // 隐藏文本区域的加载状态（会在lmf.update中自动隐藏，但这里提前隐藏以提升体验）
            this.deps.lmf.hideLoading();

            // 验证数据结构
            if (!data || !data.result) {
                console.error('Invalid data structure:', data);
                throw new Error('Invalid API response structure');
            }

            const result = data.result;

            // 确保所有必需的字段都存在且类型正确
            if (!Array.isArray(result.bpe_strings) || result.bpe_strings.length === 0) {
                abortDueToInvalidResponse(tr('Returned JSON missing valid bpe_strings array, processing cancelled.'));
                return;
            }
            const predTopkError = validateTokenPredictions(result.bpe_strings as Array<{ pred_topk?: [string, number][] }>);
            if (predTopkError) {
                abortDueToInvalidResponse(predTopkError);
                return;
            }
            const probabilityError = validateTokenProbabilities(result.bpe_strings as Array<{ real_topk?: [number, number] }>);
            if (probabilityError) {
                abortDueToInvalidResponse(probabilityError);
                return;
            }

            const safeText = data.request.text;
            const validationError = validateTokenConsistency(result.bpe_strings, safeText, { allowOverlap: true });
            if (validationError) {
                abortDueToInvalidResponse(validationError);
                return;
            }

            const rawSnapshot = createRawSnapshot(data);
            const originalTokens = result.bpe_strings.map((token) => cloneFrontendToken(token as FrontendToken));
            const bpeBpeMergedTokens = mergeTokensForRendering(originalTokens, safeText, {
                digitMerge: getDigitsMergeEnabled(),
            });
            const mergedValidationError = validateTokenConsistency(bpeBpeMergedTokens, safeText);
            if (mergedValidationError) {
                abortDueToInvalidResponse(mergedValidationError);
                return;
            }

            const enhancedResult: FrontendAnalyzeResult = {
                ...result,
                originalTokens,
                bpeBpeMergedTokens,
                bpe_strings: bpeBpeMergedTokens,
                originalText: safeText,
            };
            data.result = enhancedResult;

            // 独立存储信息密度数据（info density 无 debug 信息，隐藏 semantic debug）
            this.currentState.infoDensityData = data;
            this.currentState.rawApiResponse = rawSnapshot;
            this.updateSemanticDebugInfo();
            const displayResult = this.computeDisplayResult();
            this.deps.highlightController.updateCurrentData(displayResult ? { result: displayResult } : null);

            this.deps.lmf.clearHighlight();
            if (displayResult) this.deps.lmf.update(displayResult);

            const textStats = calculateTextStats(enhancedResult, safeText);

            const mergedSurprisals = calculateMergedTokenSurprisals(enhancedResult.bpeBpeMergedTokens);
            // 直方图 / progress：合并后 token；文本指标仍用 textStats（原始 token）
            this.currentState.currentSurprisals = mergedSurprisals;
            this.currentState.currentTokenAvg = computeAverage(mergedSurprisals);
            this.currentState.currentTokenP90 = computeP90(mergedSurprisals);
            this.currentState.currentTotalSurprisal = textStats.totalSurprisal;

            // 更新文本指标和模型显示（从分析结果中获取实际使用的模型）
            const resultModel = data.result.model;
            this.updateTextMetrics(textStats, resultModel);

            // Analyze 渲染完成后关闭动画，避免拖拽等二次渲染再次播放
            if (!disableAnimation) {
                // 延迟关闭，确保动画有足够时间完成
                // 动画时长估算：初始延迟100ms + 批次处理时间（根据token数量）
                const tokenCount = enhancedResult.bpe_strings.length;
                const estimatedAnimationTime = 100 + Math.ceil(tokenCount / 50) * 100;
                const delayTime = Math.max(2000, estimatedAnimationTime + 500);

                setTimeout(() => {
                    this.deps.lmf.updateOptions({ enableRenderAnimation: false }, false);
                }, delayTime);
            }
        } catch (error) {
            console.error('Error updating visualization:', error);
            this.deps.appStateManager.setIsAnalyzing(false);
            this.deps.appStateManager.setGlobalLoading(false);
            this.deps.appStateManager.updateState({ hasValidData: false });
            this.syncSemanticUiFromConfig();
            showAlertDialog(tr('Error'), 'Error rendering visualization. Check console for details.');
            return;
        }

        // 清除之前的选中状态
        this.clearHighlights();

        // 重新渲染直方图
        this.updateVisualizationInternal();

        // 数据成功处理，标记为有效数据（TextMetrics 显示，Analyze 变灰）
        this.deps.appStateManager.updateState({ hasValidData: true });

        this.syncSemanticUiFromConfig();
    }

    /**
     * 语义分析响应：独立存储 semanticData，按展示逻辑计算并渲染。
     * @returns true 成功；false 校验失败或计算异常，调用方应停止后续分析。
     */
    public handleSemanticResponse(
        res: {
            model?: string;
            token_attention?: Array<{
                offset: [number, number];
                raw: string;
                score: number;
                rawScore?: number;
            }>;
            debug_info?: { abbrev?: string; topk_tokens?: string[]; topk_probs?: number[] };
            chunkInfos?: Array<{ startOffset: number; endOffset: number; chunkIndex: number; chunkMatchDegree: number; thresholdResult?: signalFitResult }>;
            full_match_degree?: number;
        },
        text?: string,
        signalFitResult?: signalFitResult | null
    ): boolean {
        const chunkInfos = res?.chunkInfos;
        const semanticTokens = res?.token_attention;
        const currentText = text ?? '';

        if (!hasSemanticData(res)) {
            this.clearSemanticState();
            this.rerenderHistograms();
            this.deps.lmf.hideLoading();
            return true;
        }
        if (!currentText) return false;

        // 整段模式（无 chunkInfos）需校验 token 边界
        if (semanticTokens?.length && !chunkInfos?.length) {
            const err = validateTokenConsistency(semanticTokens!, currentText, { allowOverlap: true });
            if (err) {
                showAlertDialog(tr('Error'), err);
                return false;
            }
        }

        /** 分块模式：装配端已按 chunk 完成 overlap+digit+normalize，禁止全文再合并/再归一化（避免跨 chunk 合数字、跨 chunk 定标）。 */
        const isChunkedSemantic = Boolean(chunkInfos?.length);
        const semanticTokenSpansFromApi =
            !isChunkedSemantic && semanticTokens && semanticTokens.length > 0
                ? semanticTokens.map((t) => ({
                      ...t,
                      offset: [t.offset[0], t.offset[1]] as [number, number],
                  }))
                : undefined;
        const mergedSpans = isChunkedSemantic
            ? (semanticTokens ?? [])
            : mergeTokenSpansFullyForRendering(semanticTokens ?? [], currentText, {
                  digitMerge: getDigitsMergeEnabled(),
              });
        const normalizedSpans = isChunkedSemantic ? mergedSpans : normalizeTokenScores(mergedSpans);
        const computedSignalFit = isChunkedSemantic
            ? undefined
            : findSignalThresholdWithLog(normalizedSpans);
        const chunkInfosResolved =
            chunkInfos?.length
                ? chunkInfos.map((info) => {
                      const slice = normalizedSpans.filter(
                          (t) => t.offset[0] < info.endOffset && t.offset[1] > info.startOffset
                      );
                      const thresholdResult =
                          slice.length > 0 ? findSignalThresholdWithLog(slice) : null;
                      return { ...info, ...(thresholdResult ? { thresholdResult } : {}) };
                  })
                : chunkInfos;

        this.currentState.semanticData = {
            text: currentText,
            model: res.model,
            semanticTokenSpansFromApi,
            token_attention: normalizedSpans,
            signalFitResult: signalFitResult ?? computedSignalFit ?? undefined,
            chunkInfos: chunkInfosResolved,
            full_match_degree: res.full_match_degree,
        };
        let displayResult: ReturnType<VisualizationUpdater['computeDisplayResult']>;
        try {
            displayResult = this.computeDisplayResult();
        } catch (e) {
            this.currentState.semanticData = null;
            showAlertDialog(tr('Error'), e instanceof Error ? e.message : String(e));
            return false;
        }

        d3.select('#all_result').style('opacity', 1).style('display', null);
        this.deps.lmf.hideLoading();
        this.deps.highlightController.updateCurrentData({ result: displayResult });
        // 流式 chunk 更新时保留 jumpToChunkHighlight 的区间下划线及其 hold/fade
        this.clearHighlights({ preserveChunkInterval: true });
        this.updateVisualizationInternal();

        this.updateSemanticDebugInfo(res.debug_info);
        return true;
    }

    /** 更新文本渲染区下方的 debug 信息（abbrev + top10） */
    private updateSemanticDebugInfo(di?: { abbrev?: string; topk_tokens?: string[]; topk_probs?: number[] }): void {
        applySemanticDebugInfoPanel('results', 'semantic_debug_info', { debugInfo: di });
    }

    private buildSemanticOnlyResult(
        res: { model?: string },
        semanticTokens: Array<{
            offset: [number, number];
            raw: string;
            score: number;
            rawScore?: number;
        }>,
        text: string,
        chunkInfos?: SemanticData['chunkInfos']
    ): (FrontendAnalyzeResult & {
        rawScoresNormed: number[];
        tokenRawScores: number[];
        chunkInfos?: SemanticData['chunkInfos'];
    }) | null {
        const safeText = text ?? '';
        if (!safeText) return null;
        /** `semanticData.token_attention` 已在 handleSemanticResponse 中完成 overlap + digit + normalize */
        const bpeTokens: FrontendToken[] = semanticTokens.map((t) => ({
            offset: t.offset,
            raw: t.raw,
            pred_topk: []
        })) as FrontendToken[];
        const rawScoresNormed = semanticTokens.map((t) => t.score);
        const tokenRawScores = semanticTokens.map((t) => getTokenRawScore(t));
        const cloneRow = (t: FrontendToken): FrontendToken => ({ ...t });
        return {
            model: res.model,
            bpe_strings: bpeTokens.map(cloneRow),
            originalTokens: bpeTokens.map(cloneRow),
            bpeBpeMergedTokens: bpeTokens.map(cloneRow),
            originalText: safeText,
            rawScoresNormed,
            tokenRawScores,
            chunkInfos
        };
    }
}
