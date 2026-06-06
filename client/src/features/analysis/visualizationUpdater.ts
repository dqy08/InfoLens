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
import { getAttentionRawScore, mergeAttentionTokensFullyForRendering, normalizeTokenScores } from '../../shared/cross/semanticUtils';
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

/** Token 边界不一致时抛出，用于中断联合展示 */
export class TokenBoundaryInconsistentError extends Error {
    constructor() {
        super('Tokenizer results inconsistent: semantic and info-density token boundaries differ.');
        this.name = 'TokenBoundaryInconsistentError';
    }
}

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
}

/** 语义分析原始数据（独立存储） */
export interface SemanticData {
    text: string;
    model?: string;
    /** 整段模式：API 返回的 token_attention 副本，用于切换 digit merge 时重算（分块模式不存） */
    semanticTokenAttentionFromApi?: Array<{
        offset: [number, number];
        raw: string;
        score: number;
        rawScore?: number;
    }>;
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
 * 信息密度与语义分析独立存储，展示时根据一致性决定单独或联合
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
     * 获取当前展示数据（由 infoDensityData 与 semanticData 按展示逻辑计算）
     */
    getCurrentData(): AnalyzeResponse | null {
        const display = this.computeDisplayResult();
        if (!display) return null;
        return { request: { text: display.originalText }, result: display };
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
    private clearHighlights(): void {
        this.deps.highlightController.clearHighlights();
    }

    /**
     * 计算展示结果：仅信息密度 / 仅语义 / 联合（两者一致时）
     */
    private computeDisplayResult(): (FrontendAnalyzeResult & {
        rawScoresNormed?: number[];
        attentionRawScores?: number[];
        chunkInfos?: SemanticData['chunkInfos'];
    }) | null {
        const info = this.currentState.infoDensityData;
        const sem = this.currentState.semanticData;
        const infoResult = info?.result as FrontendAnalyzeResult | undefined;
        const infoText = info?.request?.text ?? infoResult?.originalText ?? '';
        const semText = sem?.text ?? '';

        if (infoResult && sem && infoText === semText && hasSemanticData(sem)) {
            const infoMerged = infoResult.bpeBpeMergedTokens ?? infoResult.bpe_strings;
            if (infoMerged?.length) {
                // 有 token_attention 时校验边界；仅 chunkInfos 时跳过（无语义着色）
                if (sem.token_attention?.length) {
                    const boundaryError = this.checkSemanticAlignsWithInfo(sem.token_attention, infoMerged, semText);
                if (boundaryError) {
                    const { aSample, bSample, aNext, bNext, textBefore, textAt, textAfter } = boundaryError;
                    console.warn(
                        '[联合模式] 两种分析的分词token边界不一致：\n' +
                        '  语义分析：', aSample, '\n' +
                        '  信息密度：', bSample, '\n' +
                        '  语义后一个：', aNext, '\n' +
                        '  信息后一个：', bNext, '\n' +
                        '  位置附近原文：', JSON.stringify(textBefore), '|', JSON.stringify(textAt), '|', JSON.stringify(textAfter)
                    );
                    showAlertDialog(tr('Error'), tr('Tokenizer results inconsistent: semantic and info-density token boundaries differ.'));
                    this.currentState.semanticData = null;
                    throw new TokenBoundaryInconsistentError();
                }
                }
                // 联合模式：bpeMerged 与语义 tokens 超出部分合并为并集，使 rect/渲染范围与截断边界一致
                const tokenAttention = sem.token_attention ?? [];
                const { unionTokens, scoresForUnion, rawScoresForUnion } = tokenAttention.length
                    ? this.mergeBpeWithSemanticBeyond(infoMerged, tokenAttention)
                    : (() => {
                        const m = this.mapTokenAttentionToMerged(infoMerged, []);
                        return {
                            unionTokens: infoMerged,
                            scoresForUnion: m.scores,
                            rawScoresForUnion: m.rawScores,
                        };
                    })();
                return {
                    ...infoResult,
                    bpeBpeMergedTokens: unionTokens,
                    bpe_strings: unionTokens,
                    rawScoresNormed: scoresForUnion,
                    attentionRawScores: rawScoresForUnion,
                    chunkInfos: sem.chunkInfos,
                };
            }
        }
        // 有语义数据（token_attention 或 chunkInfos）时用 buildSemanticOnlyResult
        if (sem && hasSemanticData(sem)) {
            return this.buildSemanticOnlyResult({ model: sem.model }, sem.token_attention, sem.text, sem.chunkInfos);
        }
        if (infoResult) return { ...infoResult, chunkInfos: sem?.chunkInfos ?? undefined };
        return null;
    }

    /**
     * 分析开始前更新直方图显示/隐藏：基于「已有数据 + 将要得到的数据」判断各统计图是否有意义
     * @param mode 即将进行的分析类型
     * @param text 即将分析的文本（用于判断与已有数据是否一致、能否联合展示）
     * @param willBeChunked 语义分析时：true 表示将走分块模式，直方图不显示
     */
    public updateHistogramVisibilityForPending(mode: 'infoDensity' | 'semantic', text: string, willBeChunked?: boolean): void {
        const tokenHistogramItem = document.getElementById('token_histogram_item');
        const surprisalProgressItem = document.getElementById('surprisal_progress_item');
        const rawScoreNormedItem = document.getElementById('raw_score_normed_histogram_item');
        const matchScoreProgressItem = document.getElementById('match_score_progress_item');

        const infoText = this.currentState.infoDensityData?.request?.text ?? '';
        const semText = this.currentState.semanticData?.text ?? '';
        const semanticQueryOn = getSemanticAnalysisEnabled();

        let showInfoDensity = false;
        let showSemantic = false;

        if (mode === 'infoDensity') {
            /** Semantic Query 勾选时统计区不出现信息密度图占位 */
            showInfoDensity = !semanticQueryOn;
            showSemantic =
                semanticQueryOn &&
                hasSemanticData(this.currentState.semanticData) &&
                semText === text;
        } else {
            showSemantic = true;
            showInfoDensity =
                !semanticQueryOn &&
                !!(this.currentState.infoDensityData && infoText === text);
        }

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

            // 联合模式下 tooltip 需要 pPwValues/pwScores 显示语义匹配信息，即使 fitResult 为 null 也要传递
            const resultWithExt = hasThreshold
                ? { ...displayResult, signalProbs, pPwValues, pwScores }
                : displayResult!;
            if (fitResult != null) {
                this.deps.highlightController.updateCurrentData({ result: resultWithExt, signalProbs, pPwValues, pwScores });
                if (!skipLmfUpdate) {
                    this.deps.lmf.update({ ...resultWithExt, pwScores, colorScores: scoresForColor } as FrontendAnalyzeResult & { pPwValues?: number[]; pwScores?: number[]; colorScores?: number[] });
                }
            } else {
                this.deps.highlightController.updateCurrentData({ result: resultWithExt });
                if (!skipLmfUpdate) {
                    this.deps.lmf.update({ ...resultWithExt, colorScores: scoresForColor } as FrontendAnalyzeResult & { pPwValues?: number[]; pwScores?: number[]; colorScores?: number[] });
                }
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
        const r = cd?.result as (FrontendAnalyzeResult & { rawScoresNormed?: number[] }) | undefined;
        if (!r?.rawScoresNormed?.length) return;
        const el = document.getElementById('semantic_color_source_select') as HTMLSelectElement | null;
        const v = el?.value ?? 'pw_score';
        const scoresForColor = v === 'signal_probability' ? (cd!.pPwValues ?? [])
            : v === 'pw_score' ? (cd!.pwScores ?? [])
            : r.rawScoresNormed;
        this.deps.lmf.update({ ...r, pPwValues: cd!.pPwValues, pwScores: cd!.pwScores, colorScores: scoresForColor } as FrontendAnalyzeResult & { pPwValues?: number[]; pwScores?: number[]; colorScores?: number[] });
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

    /**
     * 清除语义分析相关数据（直方图、debug、semanticData），用于打开模式时初始化
     */
    public clearSemanticState(): void {
        this.currentState.semanticData = null;
        const rawScoreNormedItem = document.getElementById('raw_score_normed_histogram_item');
        if (rawScoreNormedItem) rawScoreNormedItem.style.display = 'none';
        const matchScoreProgressItem = document.getElementById('match_score_progress_item');
        if (matchScoreProgressItem) matchScoreProgressItem.style.display = 'none';
        this.updateSemanticDebugInfo();
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
        if (sem && !sem.chunkInfos?.length && sem.semanticTokenAttentionFromApi?.length && sem.text) {
            const mergedAttention = mergeAttentionTokensFullyForRendering(
                sem.semanticTokenAttentionFromApi,
                sem.text,
                { digitMerge }
            );
            const normalizedAttention = normalizeTokenScores(mergedAttention);
            const computedSignalFit = findSignalThresholdWithLog(normalizedAttention);
            sem.token_attention = normalizedAttention;
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
        let displayResult: ReturnType<VisualizationUpdater['computeDisplayResult']>;
        try {
            displayResult = this.computeDisplayResult();
        } catch (e) {
            if (e instanceof TokenBoundaryInconsistentError) {
                displayResult = this.computeDisplayResult();
            } else {
                console.error(e);
                return;
            }
        }
        this.deps.highlightController.updateCurrentData(displayResult ? { result: displayResult } : null);
        this.deps.lmf.clearHighlight();
        if (displayResult) this.deps.lmf.update(displayResult);
        this.updateVisualizationInternal();
        this.deps.appStateManager.updateButtonStates();
    }

    /**
     * 根据语义分析配置同步 UI 状态（查询输入框、文本渲染模式等）
     * 界面完全由配置决定，不因数据有无而改变
     */
    public syncSemanticUiFromConfig(): void {
        const enabled = getSemanticAnalysisEnabled();
        const el = document.getElementById('semantic_analysis_section');
        if (el) el.style.display = enabled ? '' : 'none';
        this.deps.lmf.updateOptions({ semanticAnalysisMode: enabled }, false);
        if (!enabled) {
            // 关闭时清除语义数据；统计图由下方 updateVisualizationInternal 统一刷新
            this.currentState.semanticData = null;
            const rawScoreNormedItem = document.getElementById('raw_score_normed_histogram_item');
            if (rawScoreNormedItem) rawScoreNormedItem.style.display = 'none';
            const matchScoreProgressItem = document.getElementById('match_score_progress_item');
            if (matchScoreProgressItem) matchScoreProgressItem.style.display = 'none';
            this.updateSemanticDebugInfo();
            const displayResult = this.computeDisplayResult();
            this.deps.highlightController.updateCurrentData(displayResult ? { result: displayResult } : null);
            if (!displayResult) {
                d3.select('#all_result').style('opacity', 0);
                this.deps.appStateManager.updateState({ hasValidData: false });
            }
        }
        /** 勾选 / 关闭 Semantic Query 后立即刷新统计图显隐（与 getSemanticAnalysisEnabled 一致） */
        this.updateVisualizationInternal(false);
        // 语义分析配置影响 Upload/Save 的 dataReadyForSave 条件，需始终更新按钮状态
        this.deps.appStateManager.updateButtonStates();
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
            let displayResult: ReturnType<VisualizationUpdater['computeDisplayResult']>;
            try {
                displayResult = this.computeDisplayResult();
            } catch (e) {
                if (e instanceof TokenBoundaryInconsistentError) {
                    displayResult = this.computeDisplayResult();
                } else {
                    throw e;
                }
            }
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
        const tokenAttention = res?.token_attention;
        const currentText = text ?? '';

        if (!hasSemanticData(res)) {
            this.clearSemanticState();
            this.rerenderHistograms();
            this.deps.lmf.hideLoading();
            return true;
        }
        if (!currentText) return false;

        // 整段模式（无 chunkInfos）需校验 token 边界
        if (tokenAttention?.length && !chunkInfos?.length) {
            const err = validateTokenConsistency(tokenAttention!, currentText, { allowOverlap: true });
            if (err) {
                showAlertDialog(tr('Error'), err);
                return false;
            }
        }

        /** 分块模式：装配端已按 chunk 完成 overlap+digit+normalize，禁止全文再合并/再归一化（避免跨 chunk 合数字、跨 chunk 定标）。 */
        const isChunkedSemantic = Boolean(chunkInfos?.length);
        const semanticTokenAttentionFromApi =
            !isChunkedSemantic && tokenAttention && tokenAttention.length > 0
                ? tokenAttention.map((t) => ({
                      ...t,
                      offset: [t.offset[0], t.offset[1]] as [number, number],
                  }))
                : undefined;
        const mergedAttention = isChunkedSemantic
            ? (tokenAttention ?? [])
            : mergeAttentionTokensFullyForRendering(tokenAttention ?? [], currentText, {
                  digitMerge: getDigitsMergeEnabled(),
              });
        const normalizedAttention = isChunkedSemantic ? mergedAttention : normalizeTokenScores(mergedAttention);
        const computedSignalFit = isChunkedSemantic
            ? undefined
            : findSignalThresholdWithLog(normalizedAttention);
        const chunkInfosResolved =
            chunkInfos?.length
                ? chunkInfos.map((info) => {
                      const slice = normalizedAttention.filter(
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
            semanticTokenAttentionFromApi,
            token_attention: normalizedAttention,
            signalFitResult: signalFitResult ?? computedSignalFit ?? undefined,
            chunkInfos: chunkInfosResolved,
            full_match_degree: res.full_match_degree,
        };
        let displayResult: ReturnType<VisualizationUpdater['computeDisplayResult']>;
        try {
            displayResult = this.computeDisplayResult();
        } catch (e) {
            this.currentState.semanticData = null;
            if (e instanceof TokenBoundaryInconsistentError) {
                this.deps.lmf.hideLoading();
                this.rerenderHistograms();
                return false;
            }
            showAlertDialog(tr('Error'), e instanceof Error ? e.message : String(e));
            return false;
        }

        d3.select('#all_result').style('opacity', 1).style('display', null);
        this.deps.lmf.hideLoading();
        this.deps.highlightController.updateCurrentData({ result: displayResult });
        this.deps.lmf.clearHighlight();
        this.clearHighlights();
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
        tokenAttention: Array<{
            offset: [number, number];
            raw: string;
            score: number;
            rawScore?: number;
        }>,
        text: string,
        chunkInfos?: SemanticData['chunkInfos']
    ): (FrontendAnalyzeResult & {
        rawScoresNormed: number[];
        attentionRawScores: number[];
        chunkInfos?: SemanticData['chunkInfos'];
    }) | null {
        const safeText = text ?? '';
        if (!safeText) return null;
        /** `semanticData.token_attention` 已在 handleSemanticResponse 中完成 overlap + digit + normalize */
        const bpeTokens: FrontendToken[] = tokenAttention.map((t) => ({
            offset: t.offset,
            raw: t.raw,
            pred_topk: []
        })) as FrontendToken[];
        const rawScoresNormed = tokenAttention.map((t) => t.score);
        const attentionRawScores = tokenAttention.map((t) => getAttentionRawScore(t));
        const cloneRow = (t: FrontendToken): FrontendToken => ({ ...t });
        return {
            model: res.model,
            bpe_strings: bpeTokens.map(cloneRow),
            originalTokens: bpeTokens.map(cloneRow),
            bpeBpeMergedTokens: bpeTokens.map(cloneRow),
            originalText: safeText,
            rawScoresNormed,
            attentionRawScores,
            chunkInfos
        };
    }

    /**
     * 检查 semantic token_attention 的边界是否与 info 一致；允许稀疏覆盖（semantic 不必覆盖全文）
     * @returns 不一致时返回错误描述（含前后文本），一致时返回 null
     */
    private checkSemanticAlignsWithInfo(
        tokenAttention: Array<{ offset: [number, number]; raw?: string }>,
        infoMerged: Array<{ offset: [number, number] }>,
        text: string
    ): { firstBadIdx: number; aSample: string; bSample: string; aNext: string; bNext: string; textBefore: string; textAt: string; textAfter: string } | null {
        const boundaries = new Set<number>([0]);
        for (const t of infoMerged) boundaries.add(t.offset[1]);
        const infoEnd = infoMerged.length > 0 ? infoMerged[infoMerged.length - 1]!.offset[1] : 0;
        const totalChars = text.length;
        const ctx = 30;
        const esc = (s: string) => JSON.stringify(s).slice(1, -1);
        const fmt = (t: { offset: [number, number]; raw?: string }, idx: number) => {
            const raw = (t as { raw?: string }).raw ?? text.slice(t.offset[0], t.offset[1]);
            const s = raw.slice(0, 20) + (raw.length > 20 ? '…' : '');
            return `第${idx}个token分词 [字符${t.offset[0]}-${t.offset[1]}] "${esc(s)}"`;
        };
        for (let i = 0; i < tokenAttention.length; i++) {
            const [as, ae] = tokenAttention[i].offset;
            if (as < 0 || ae > totalChars || ae <= as) continue; // 由 validateTokenConsistency 处理
            if (ae > infoEnd) continue; // 超出双方重叠范围，不参与检查
            if (!boundaries.has(as) || !boundaries.has(ae)) {
                const raw = (tokenAttention[i] as { raw?: string }).raw ?? '';
                const infoIdx = infoMerged.findIndex(t => t.offset[0] <= as && as < t.offset[1]);
                const infoAt = infoIdx >= 0 ? infoMerged[infoIdx]! : null;
                const rawShort = (raw || text.slice(as, ae)).slice(0, 20);
                const infoRaw = infoAt ? (text.slice(infoAt.offset[0], infoAt.offset[1]).slice(0, 20) || '') : '';
                const nextSem = tokenAttention[i + 1];
                const nextInfo = infoIdx >= 0 && infoIdx + 1 < infoMerged.length ? infoMerged[infoIdx + 1]! : null;
                return {
                    firstBadIdx: i,
                    aSample: `第${i}个token分词 [字符${as}-${ae}] "${esc(rawShort)}${rawShort.length >= 20 ? '…' : ''}"`,
                    bSample: infoAt ? `同一位置token分词 [字符${infoAt.offset[0]}-${infoAt.offset[1]}] "${esc(infoRaw)}${infoRaw.length >= 20 ? '…' : ''}"` : '无对应',
                    aNext: nextSem ? fmt(nextSem, i + 1) : '无',
                    bNext: nextInfo ? fmt(nextInfo, infoIdx + 1) : '无',
                    textBefore: text.slice(Math.max(0, as - ctx), as),
                    textAt: text.slice(as, ae),
                    textAfter: text.slice(ae, Math.min(totalChars, ae + ctx)),
                };
            }
        }
        return null;
    }

    /**
     * 联合模式：将 bpeMergedTokens 与超出信息密度范围的语义 tokens 合并为并集，用于 rect/渲染范围与截断边界一致。
     * @returns { unionTokens, scoresForUnion }
     */
    private mergeBpeWithSemanticBeyond(
        bpeMerged: FrontendToken[],
        tokenAttention: Array<{
            offset: [number, number];
            raw: string;
            score: number;
            rawScore?: number;
        }>
    ): {
        unionTokens: FrontendToken[];
        scoresForUnion: (number | undefined)[];
        rawScoresForUnion: (number | undefined)[];
    } {
        const infoEnd = bpeMerged.length > 0 ? bpeMerged[bpeMerged.length - 1]!.offset[1] : 0;
        const beyond = tokenAttention.filter((t) => t.offset[0] >= infoEnd);
        if (beyond.length === 0) {
            const { scores, rawScores } = this.mapTokenAttentionToMerged(bpeMerged, tokenAttention);
            return {
                unionTokens: bpeMerged,
                scoresForUnion: scores,
                rawScoresForUnion: rawScores,
            };
        }
        /** beyond 已在 handleSemanticResponse 中 overlap+digit 合并；段内用原始梯度重新归一化 */
        const beyondRenormed = normalizeTokenScores(beyond.map((t) => ({ ...t, score: getAttentionRawScore(t) })));
        const semanticAsFrontend: FrontendToken[] = beyondRenormed.map((t) => ({
            offset: [t.offset[0], t.offset[1]],
            raw: t.raw,
            real_topk: [0, 1] as [number, number],
            pred_topk: [],
        }));
        const unionTokens = [...bpeMerged, ...semanticAsFrontend];
        const { scores: infoScores, rawScores: infoRawScores } = this.mapTokenAttentionToMerged(
            bpeMerged,
            tokenAttention
        );
        const beyondScores: (number | undefined)[] = beyondRenormed.map((t) =>
            Number.isFinite(t.score) ? t.score : undefined
        );
        const beyondRawScores: (number | undefined)[] = beyondRenormed.map((t) => {
            const r = getAttentionRawScore(t);
            return Number.isFinite(r) ? r : undefined;
        });
        const scoresForUnion = [...infoScores, ...beyondScores];
        const rawScoresForUnion = [...infoRawScores, ...beyondRawScores];
        return { unionTokens, scoresForUnion, rawScoresForUnion };
    }

    /**
     * 将 token_attention（offset 为原文字符偏移）映射到 merged tokens
     */
    /**
     * 将 token_attention 映射到 merged tokens，双指针 O(N+M)。
     * 前提：两个数组均按 offset 升序排列。
     */
    private mapTokenAttentionToMerged(
        bpeBpeMergedTokens: Array<{ offset: [number, number] }>,
        tokenAttention: Array<{ offset: [number, number]; score: number; rawScore?: number }>
    ): {
        scores: (number | undefined)[];
        rawScores: (number | undefined)[];
    } {
        const n = bpeBpeMergedTokens.length;
        const scores: number[] = new Array(n).fill(0);
        const rawScores: number[] = new Array(n).fill(0);
        const weights: number[] = new Array(n).fill(0);

        let j = 0; // 跳过所有在当前 attn 之前结束的 merged token
        for (const attn of tokenAttention) {
            const [as, ae] = attn.offset;
            const rawPart = getAttentionRawScore(attn);
            while (j < n && bpeBpeMergedTokens[j].offset[1] <= as) j++;
            for (let k = j; k < n && bpeBpeMergedTokens[k].offset[0] < ae; k++) {
                const [s, e] = bpeBpeMergedTokens[k].offset;
                // j/k 的推进条件已保证 e > as 且 s < ae，overlap 必然 > 0
                const overlap = Math.min(e, ae) - Math.max(s, as);
                scores[k] += attn.score * overlap;
                rawScores[k] += rawPart * overlap;
                weights[k] += overlap;
            }
        }

        const norm = (vals: number[]) => vals.map((v, i) => (weights[i] > 0 ? v / weights[i] : undefined));
        return {
            scores: norm(scores),
            rawScores: norm(rawScores),
        };
    }
}

