/**
 * 语义搜索控制器
 * 负责执行语义分析（整段 / 分块模式）
 */

import * as d3 from 'd3';
import type { TextAnalysisAPI } from '../../shared/api/GLTR_API';
import { isSemanticFromCache } from '../../shared/api/GLTR_API';
import type { AppStateManager } from '../../features/analysis/appStateManager';
import type { VisualizationUpdater } from '../../features/analysis/visualizationUpdater';
import type { GLTR_Text_Box } from '../../shared/vis/GLTR_Text_Box';
import { SEMANTIC_CHUNK_BYTES } from '../core/constants';
import { getSemanticMatchThreshold } from '../cross/semanticThresholdManager';
import { getDigitsMergeEnabled } from '../cross/digitsMergeManager';
import {
    getAttentionRawScore,
    mergeAttentionTokensFullyForRendering,
    normalizeTokenScores,
    splitTextToChunks,
} from '../cross/semanticUtils';
import type { signalFitResult } from '../../features/analysis/signalThresholdDetector';
import { CHUNK_SEARCH_HOLD_MS } from '../vis/constants';
import * as semanticResultCache from '../cross/semanticResultCache';

function isChunkSemanticallyCached(chunkText: string, query: string, submode?: string): boolean {
    if (submode === 'hybrid') {
        return !!semanticResultCache.get(chunkText, query, 'count')
            && !!semanticResultCache.get(chunkText, query, 'fill_blank');
    }
    return !!semanticResultCache.get(chunkText, query, submode);
}

/** 可中止的短时等待（abort 时提前结束，不抛错） */
function delayAbortable(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const id = window.setTimeout(resolve, ms);
        const onAbort = () => {
            window.clearTimeout(id);
            resolve();
        };
        if (signal.aborted) {
            onAbort();
            return;
        }
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export interface SemanticSearchControllerDeps {
    getQuery: () => string;
    getText: () => string;
    getSubmode: () => string | undefined;
    isChunkedMode: () => boolean;
    api: TextAnalysisAPI;
    appStateManager: AppStateManager;
    visualizationUpdater: VisualizationUpdater;
    lmf: GLTR_Text_Box;
    showToast: (message: string, type: 'success' | 'error') => void;
    showSemanticError: (message?: string) => void;
    onSearchStart: (query: string) => void;
    finishSemanticSearch: (query: string, matchDegree: number | null, fromCache: boolean) => void;
    tr: (key: string) => string;
    extractErrorMessage: (err: unknown, fallback: string) => string;
}

export class SemanticSearchController {
    private deps: SemanticSearchControllerDeps;
    private abortController: AbortController | null = null;

    constructor(deps: SemanticSearchControllerDeps) {
        this.deps = deps;
    }

    abort(): void {
        this.abortController?.abort();
    }

    run(): void {
        void this.runSemanticSearchBase(async ({ query, text, submode, signal }) => {
            if (this.deps.isChunkedMode()) {
                await this.runChunked({ query, text, submode, signal });
            } else {
                await this.runWhole({ query, text, submode, signal });
            }
        });
    }

    private async runSemanticSearchBase(
        execute: (params: { query: string; text: string; submode: string | undefined; signal: AbortSignal }) => Promise<void>
    ): Promise<void> {
        const query = this.deps.getQuery();
        if (!query) return;
        const text = this.deps.getText();
        if (!text) {
            this.deps.showToast(this.deps.tr('Please enter text first'), 'error');
            return;
        }
        this.abortController = new AbortController();
        const signal = this.abortController.signal;
        this.deps.onSearchStart(query);
        try {
            this.deps.appStateManager.setSemanticSearching(true);
            d3.select('#semantic_match_degree').style('display', 'none');
            d3.select('#semantic_search_loader').style('visibility', 'visible');
            d3.select('#all_result').style('opacity', 1).style('display', null);
            this.deps.lmf.setTextOnly(text);
            this.deps.visualizationUpdater.updateHistogramVisibilityForPending('semantic', text, this.deps.isChunkedMode());
            await execute({ query, text, submode: this.deps.getSubmode(), signal });
        } catch (err) {
            if (err instanceof Error && err.name === 'AbortError') {
                this.deps.lmf.hideLoading();
                this.deps.visualizationUpdater.rerenderHistograms();
                return;
            }
            this.deps.showToast(
                this.deps.extractErrorMessage(err, this.deps.tr('Semantic analysis failed')),
                'error'
            );
            this.deps.lmf.hideLoading();
            this.deps.visualizationUpdater.rerenderHistograms();
        } finally {
            this.abortController = null;
            this.deps.appStateManager.setSemanticSearching(false);
            d3.select('#semantic_search_loader').style('visibility', 'hidden');
        }
    }

    private async runWhole(params: { query: string; text: string; submode: string | undefined; signal: AbortSignal }): Promise<void> {
        const { query, text, submode, signal } = params;
        const onProgress = (step: number, totalSteps: number, stage: string, percentage?: number) => {
            const progressText = percentage !== undefined && percentage !== null
                ? `Step ${step}/${totalSteps}:\t ${stage} ${percentage}%`
                : `Step ${step}/${totalSteps}:\t ${stage}`;
            d3.select('#semantic_progress').text(progressText).style('display', 'inline-block');
        };
        const res = await this.deps.api.analyzeSemantic(query, text, { onProgress, submode, debug_info: true, signal });
        if (res?.success && res?.token_attention) {
            this.deps.visualizationUpdater.handleSemanticResponse(res, text);
            const md = res?.full_match_degree;
            this.deps.finishSemanticSearch(query, md != null && typeof md === 'number' ? md : null, isSemanticFromCache(res));
        } else {
            this.deps.showSemanticError(res?.message);
        }
    }

    private async runChunked(params: { query: string; text: string; submode: string | undefined; signal: AbortSignal }): Promise<void> {
        const { query, text, submode, signal } = params;
        const chunks = splitTextToChunks(text, SEMANTIC_CHUNK_BYTES);
        if (chunks.length === 0) {
            this.deps.visualizationUpdater.handleSemanticResponse({ token_attention: [] }, text, undefined);
            this.deps.finishSemanticSearch(query, null, true);
            return;
        }
        /** 各 chunk 内已 overlap+digit+normalize，仅做 offset 平移后拼接，全文不再合并/归一化 */
        const allChunkProcessedTokens: Array<{
            offset: [number, number];
            raw: string;
            score: number;
            rawScore?: number;
        }> = [];
        const chunkInfos: Array<{ startOffset: number; endOffset: number; chunkIndex: number; chunkMatchDegree: number; thresholdResult?: signalFitResult }> = [];
        let maxMatchDegree = 0;
        let allFromCache = true;
        let aborted = false;
        let lastChunkFromCache = false;
        /** 上一块上色后的 hold 期间已预发起的下一块分析 */
        let pendingNextAnalysis: ReturnType<TextAnalysisAPI['analyzeSemantic']> | null = null;
        /** hold 结束后已滚到下一块，本轮循环开头无需再滚 */
        let scrollDoneForIndex: number | null = null;

        const needsAutoScroll = chunks.some((c) => !isChunkSemanticallyCached(c.text, query, submode));
        if (needsAutoScroll) {
            this.deps.lmf.beginChunkSearchAutoScroll();
        }
        try {
        for (let i = 0; i < chunks.length; i++) {
            if (signal.aborted) break;
            const chunk = chunks[i];
            d3.select('#semantic_progress').text(`Chunk ${i + 1}/${chunks.length}`).style('display', 'inline-block');

            const res = pendingNextAnalysis
                ? await pendingNextAnalysis
                : await this.deps.api.analyzeSemantic(query, chunk.text, { submode, signal });
            pendingNextAnalysis = null;
            // 上色/直方图仍以本块返回的 isSemanticFromCache(res) 为准，从首个非缓存块起才刷新 UI。
            // isChunkSemanticallyCached 仅用于滚动跟随与预取，与 API 读同一套 semanticResultCache。
            if (signal.aborted) {
                aborted = true;
                break;
            }
            if (!res?.success) {
                this.deps.showSemanticError(res?.message);
                aborted = true;
                break;
            }
            lastChunkFromCache = isSemanticFromCache(res);
            if (!lastChunkFromCache) allFromCache = false;
            const matchDegree = res.full_match_degree ?? 0;
            maxMatchDegree = Math.max(maxMatchDegree, matchDegree);
            const matched = matchDegree >= getSemanticMatchThreshold();
            const merged = mergeAttentionTokensFullyForRendering(res.token_attention ?? [], chunk.text, {
                digitMerge: getDigitsMergeEnabled(),
            });
            const normalized = normalizeTokenScores(merged);
            const tokens = matched
                ? normalized
                : normalized.map((t) => ({ ...t, rawScore: getAttentionRawScore(t), score: 0 }));

            chunkInfos.push({
                startOffset: chunk.startOffset,
                endOffset: chunk.startOffset + chunk.text.length,
                chunkIndex: i,
                chunkMatchDegree: matchDegree,
            });
            const tokensOffsetAdjusted = tokens.map(t => ({
                ...t,
                offset: [t.offset[0] + chunk.startOffset, t.offset[1] + chunk.startOffset] as [number, number],
            }));
            allChunkProcessedTokens.push(...tokensOffsetAdjusted);
            if (!lastChunkFromCache) {
                if (scrollDoneForIndex !== i) {
                    this.deps.lmf.followSearchingChunk(chunk.startOffset);
                }
                scrollDoneForIndex = null;
                if (!this.deps.visualizationUpdater.handleSemanticResponse(
                    { token_attention: allChunkProcessedTokens, chunkInfos, debug_info: undefined },
                    text,
                    undefined
                )) {
                    aborted = true;
                    this.deps.showSemanticError();
                    break;
                }
                const nextIndex = i + 1;
                if (nextIndex < chunks.length) {
                    const nextChunk = chunks[nextIndex]!;
                    pendingNextAnalysis = this.deps.api.analyzeSemantic(query, nextChunk.text, { submode, signal });
                    await delayAbortable(CHUNK_SEARCH_HOLD_MS, signal);
                    if (signal.aborted) {
                        aborted = true;
                        break;
                    }
                    if (!isChunkSemanticallyCached(nextChunk.text, query, submode)) {
                        this.deps.lmf.followSearchingChunk(nextChunk.startOffset);
                        scrollDoneForIndex = nextIndex;
                    }
                }
            }
        }

        if (!aborted) {
            if (lastChunkFromCache) {
                this.deps.visualizationUpdater.handleSemanticResponse(
                    { token_attention: allChunkProcessedTokens, chunkInfos, debug_info: undefined },
                    text,
                    undefined
                );
            }
            if (!allFromCache) {
                await delayAbortable(CHUNK_SEARCH_HOLD_MS, signal);
            }
            if (!signal.aborted) {
                const threshold = getSemanticMatchThreshold();
                const firstMatch = chunkInfos.find((c) => c.chunkMatchDegree >= threshold);
                if (firstMatch) {
                    this.deps.lmf.scrollToChunkStart(firstMatch.startOffset);
                }
                this.deps.finishSemanticSearch(query, maxMatchDegree, allFromCache);
            }
        }
        } finally {
            if (needsAutoScroll) {
                this.deps.lmf.endChunkSearchAutoScroll();
            }
        }
    }
}
