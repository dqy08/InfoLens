/**
 * 语义搜索控制器
 * 负责执行语义分析（整段 / 分块模式）
 * 流程固定：相关度门控 → 关键词归因（由 API 层组合两原生接口）
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
    getTokenRawScore,
    mergeTokenSpansFullyForRendering,
    normalizeTokenScores,
    splitTextToChunks,
} from '../cross/semanticUtils';
import { codePointLength, utf16IndexToCodePointIndex } from '../cross/mergeTokenSpans';
import type { signalFitResult } from '../../features/analysis/signalThresholdDetector';

export interface SemanticSearchControllerDeps {
    getQuery: () => string;
    getText: () => string;
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
        void this.runSemanticSearchBase(async ({ query, text, signal }) => {
            if (this.deps.isChunkedMode()) {
                await this.runChunked({ query, text, signal });
            } else {
                await this.runWhole({ query, text, signal });
            }
        });
    }

    private async runSemanticSearchBase(
        execute: (params: { query: string; text: string; signal: AbortSignal }) => Promise<void>
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
            await execute({ query, text, signal });
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

    private async runWhole(params: { query: string; text: string; signal: AbortSignal }): Promise<void> {
        const { query, text, signal } = params;
        const res = await this.deps.api.analyzeSemantic(query, text, { debug_info: true, signal });
        if (res?.success && res?.token_attention) {
            this.deps.visualizationUpdater.handleSemanticResponse(res, text);
            const md = res?.full_match_degree;
            this.deps.finishSemanticSearch(query, md != null && typeof md === 'number' ? md : null, isSemanticFromCache(res));
        } else {
            this.deps.showSemanticError(res?.message);
        }
    }

    /**
     * 分块搜索（demo）：严格串行——await 分析 → 上色 → 下一块；无预取/hold/follow；结束滚到首个匹配。
     * 产品决策：站内节奏刻意简化；扩展侧仍保留预取/hold/follow（见 extension/content.js），两边不必对齐。
     */
    private async runChunked(params: { query: string; text: string; signal: AbortSignal }): Promise<void> {
        const { query, text, signal } = params;
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

        const matchThreshold = () => getSemanticMatchThreshold();

        for (let i = 0; i < chunks.length; i++) {
            if (signal.aborted) break;
            const chunk = chunks[i];
            d3.select('#semantic_progress').text(`Chunk ${i + 1}/${chunks.length}`).style('display', 'inline-block');

            const res = await this.deps.api.analyzeSemantic(query, chunk.text, { signal });
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
            const matched = matchDegree >= matchThreshold();
            const merged = mergeTokenSpansFullyForRendering(res.token_attention ?? [], chunk.text, {
                digitMerge: getDigitsMergeEnabled(),
            });
            const normalized = normalizeTokenScores(merged);
            const tokens = matched
                ? normalized
                : normalized.map((t) => ({ ...t, rawScore: getTokenRawScore(t), score: 0 }));

            // splitTextToChunks.startOffset 为 UTF-16；token/chunkInfos/渲染均为码点
            const chunkCpStart = utf16IndexToCodePointIndex(text, chunk.startOffset);
            const chunkCpEnd = chunkCpStart + codePointLength(chunk.text);
            chunkInfos.push({
                startOffset: chunkCpStart,
                endOffset: chunkCpEnd,
                chunkIndex: i,
                chunkMatchDegree: matchDegree,
            });
            const tokensOffsetAdjusted = tokens.map(t => ({
                ...t,
                offset: [t.offset[0] + chunkCpStart, t.offset[1] + chunkCpStart] as [number, number],
            }));
            allChunkProcessedTokens.push(...tokensOffsetAdjusted);

            if (!lastChunkFromCache) {
                if (!this.deps.visualizationUpdater.handleSemanticResponse(
                    { token_attention: allChunkProcessedTokens, chunkInfos, debug_info: undefined },
                    text,
                    undefined
                )) {
                    aborted = true;
                    this.deps.showSemanticError();
                    break;
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
            if (!signal.aborted) {
                const firstMatch = chunkInfos.find((c) => c.chunkMatchDegree >= matchThreshold());
                if (firstMatch) {
                    this.deps.lmf.jumpToChunkHighlight(firstMatch.startOffset, firstMatch.endOffset);
                }
                this.deps.finishSemanticSearch(query, maxMatchDegree, allFromCache);
            }
        }
    }
}
