import * as d3 from 'd3';
import "../../shared/core/d3-polyfill";

import '../../css/pages/compare.scss'
import {SimpleEventHandler} from "../../shared/core/SimpleEventHandler";
import type {AnalysisData, AnalyzeResponse, FrontendAnalyzeResult, FrontendToken} from "../../shared/api/GLTR_API";
import {TextAnalysisAPI} from "../../shared/api/GLTR_API";
import URLHandler from "../../shared/core/URLHandler";
import {Histogram, type HistogramBinClickEvent} from '../../shared/vis/Histogram';
import {ScatterPlot} from '../../shared/vis/ScatterPlot';
import {getDiffColor} from '../../shared/cross/SurprisalColorConfig';
import {initThemeManager} from '../../shared/ui/theme';
import {showAlertDialog, showDialog, showConfirmDialog} from '../../shared/ui/dialog';
import {initDemoManager, type DemoManager} from '../../shared/ui/demoManager';
import {isValidDemoFormat} from '../../shared/cross/localFileUtils';
import {normalizeDemoPath, getDemoName} from '../../shared/core/pathUtils';
// Demo存储层（复用首页架构）
import { DemoResourceLoader } from '../../shared/storage/demoResourceLoader';
import { LocalFileIO } from '../../shared/storage/localFileIO';
import { extractErrorMessage } from '../../shared/core/errorUtils';
import {
    cloneFrontendToken,
    mergeTokensForRendering,
    createRawSnapshot
} from '../../shared/cross/tokenUtils';
import {
    validateTokenConsistency,
    validateTokenProbabilities,
    validateTokenPredictions
} from '../../shared/cross/dataValidation';
import {
    calculateTextStats,
    calculateDiffStats,
    calculateMergedTokenSurprisals,
    computeAverage,
    computeP90,
    type TextStats,
    type DiffStats
} from '../../shared/cross/textStatistics';
import { updateBasicMetrics, updateTotalSurprisal, updateModel, validateMetricsElements, type DiffModeConfig } from '../../shared/cross/textMetricsUpdater';
import {GLTR_Text_Box, GLTR_Mode, GLTR_HoverEvent} from '../../shared/vis/GLTR_Text_Box';
import {ToolTip} from '../../shared/vis/ToolTip';
import { calculateHighlights } from '../../features/compare/highlightUtils';
// 公共初始化模块
import {initializeCommonApp} from '../../shared/bootstrap';
import {
    getTokenSurprisalHistogramConfig,
    getByteSurprisalHistogramConfig,
    getDeltaByteSurprisalHistogramConfig,
    getSurprisalProgressConfig
} from "../../features/analysis/visualizationConfigs";
import { tr, initI18n } from '../../shared/lang/i18n-lite';
import { addDigitsMergeRenderListener, getDigitsMergeEnabled } from '../../shared/cross/digitsMergeManager';

// 使用从 demoManager 导出的验证函数

/**
 * 将路径ID转换为安全的DOM ID（使用哈希避免冲突）
 * 
 * ID 使用策略说明：
 * - `id`（规范化路径）：用于数据存储和逻辑标识
 *   - 存储在 columnsData Map 的 key 中
 *   - 存储在 data-column-id 属性中（用于 DOM 查询，保持可读性）
 *   - 示例: "folder/demo1.json"
 * 
 * - `safeId`（哈希值）：用于 HTML 元素的 id 属性
 *   - 所有 DOM 元素的 id 属性都使用 safeId
 *   - 避免特殊字符导致的 ID 冲突和选择器问题
 *   - 示例: "a1b2c3d4"
 * 
 * 使用 djb2 哈希算法 + base36 编码，确保不同路径生成不同的ID
 * 支持任意字符（包括 Unicode、特殊字符等），哈希算法会自动处理
 * 
 * @param id 规范化路径（如 "folder/demo1.json"）
 * @returns 安全的DOM ID（如 "a1b2c3d4"），长度通常为 6-7 个字符
 */
const toSafeId = (id: string): string => {
    // 边界情况处理：空字符串或 null/undefined
    if (!id || typeof id !== 'string' || id.length === 0) {
        return 'empty';
    }
    
    // 去除首尾空白字符（虽然规范化路径通常不会有，但作为防御性编程）
    const trimmedId = id.trim();
    if (trimmedId.length === 0) {
        return 'empty';
    }
    
    // 使用 djb2 哈希算法（位运算会自动转换为32位整数）
    // 该算法对任意字符（包括 Unicode、特殊字符）都能正确处理
    let hash = 5381;
    for (let i = 0; i < trimmedId.length; i++) {
        const charCode = trimmedId.charCodeAt(i);
        // 处理 Unicode 字符（charCodeAt 返回 UTF-16 码点）
        hash = ((hash << 5) + hash) + charCode;
    }
    
    // 转换为正数并转为 base36 编码（0-9a-z）
    // Math.abs 确保结果为正数，即使哈希值为负数
    const positiveHash = Math.abs(hash);
    const safeId = positiveHash.toString(36);
    
    // 确保结果不为空（理论上不会发生，但作为防御性编程）
    return safeId || 'empty';
};

/**
 * Demo 列数据
 * 
 * ID 使用说明：
 * - id: 规范化路径，用于数据存储和逻辑标识（如 "folder/demo1.json"）
 * - DOM 查询：使用 data-column-id 属性（值为 id，保持可读性）
 * - DOM ID：使用 toSafeId(id) 生成的哈希值（避免冲突）
 */
type DemoColumnData = {
    id: string;              // 唯一ID（规范化路径，用于数据存储和 data-column-id 属性）
    demoPath: string;        // 原始路径（用于显示和 URL）
    demoName: string;        // Demo 名称（用于显示）
    data: AnalysisData | null;
    enhancedResult?: FrontendAnalyzeResult | null;  // 缓存合并后的结果，便于高亮
    stats: TextStats | null;
    diffStats?: DiffStats | null;  // 差分统计数据（仅Diff列有值）
    error: string | null;
    originalText?: string;        // 原文（用于一致性检查和缓存）
    lmfInstance?: GLTR_Text_Box;  // LMF实例引用（对比模式下使用）
    histograms: {
        stats_frac: Histogram | null;
        stats_byte_frac: Histogram | null;
        stats_surprisal_progress: ScatterPlot | null;
    };
};

window.onload = () => {
    // 初始化公共应用组件
    const api_prefix = URLHandler.parameters['api'] || '';
    const bodyElement = <Element>d3.select('body').node();
    const { eventHandler, api, tokenSurprisalColorScale, byteSurprisalColorScale, totalSurprisalFormat } = initializeCommonApp(api_prefix, bodyElement);

    const container = d3.select('#compare-container');
    const mainFrame = d3.select('.main_frame');

    // 初始化资源加载器和本地文件工具（复用首页架构）
    const demoResourceLoader = new DemoResourceLoader(api);
    const localFileIO = new LocalFileIO();
    const localDemoCache = demoResourceLoader.getLocalDemoCache();

    // 创建全局tooltip实例（用于所有列的token悬停）
    const toolTip = new ToolTip(d3.select('#global_tooltip'), eventHandler);

    // 解析 URL 参数
    const demosParam = URLHandler.parameters['demos'];
    let demoPaths: string[] = [];

    if (demosParam) {
        const raw = String(demosParam).trim();
        demoPaths = raw.split(',').map(p => p.trim()).filter(p => p.length > 0);
    }

    // 解析显示文本渲染和模型差分模式参数
    const showTextRenderParam = URLHandler.parameters['showTextRender'];
    const modelDiffModeParam = URLHandler.parameters['modelDiffMode'];

    // 存储每个 demo 列的数据（使用Map，key为唯一ID）
    const columnsData = new Map<string, DemoColumnData>();
    
    // 模型差分模式状态（从URL恢复或默认为false）
    let modelDiffMode = modelDiffModeParam == '1';
    
    // 文本渲染显示状态（从URL恢复或默认为false）
    let showTextRender = showTextRenderParam == '1';

    /**
     * 获取Base列的ID（最左侧列）
     * @returns Base列的ID，如果没有列则返回null
     */
    const getBaseColumnId = (): string | null => {
        const firstColumn = container.select('.compare-column').node() as HTMLElement | null;
        if (!firstColumn) {
            return null;
        }
        return firstColumn.getAttribute('data-column-id');
    };

    /**
     * 检查指定列是否为Base列
     */
    const isBaseColumn = (columnId: string): boolean => {
        const baseId = getBaseColumnId();
        return baseId === columnId;
    };

    /**
     * 重新计算所有列的差分数据（在模型差分模式下）
     * 当Base列变化或数据更新时调用
     */
    const recalculateAllDiffStats = (): void => {
        if (!modelDiffMode) {
            return;
        }

        const baseId = getBaseColumnId();
        if (!baseId) {
            return;
        }

        const baseData = columnsData.get(baseId);
        if (!baseData || !baseData.stats) {
            return;
        }

        const baseStats = baseData.stats;

        // 清除Base列的diffStats
        baseData.diffStats = null;

        // 为其它列计算差分数据
        columnsData.forEach((columnData, columnId) => {
            if (columnId === baseId) {
                return; // 跳过Base列
            }

            if (columnData.stats) {
                columnData.diffStats = calculateDiffStats(columnData.stats, baseStats);
            }
        });
    };

    const refreshAllColumnsAfterDigitsMerge = (): void => {
        columnsData.forEach((columnData, id) => {
            if (!columnData.data) return;
            try {
                const enhancedResult = processDemoData(columnData.data);
                const safeText = columnData.data.request.text;
                columnData.enhancedResult = enhancedResult;
                columnData.stats = calculateTextStats(enhancedResult, safeText);
            } catch (e) {
                console.error('[compare] digit merge refresh failed for column', id, e);
            }
        });
        recalculateAllDiffStats();
        columnsData.forEach((columnData, id) => {
            if (!columnData.stats || !columnData.data) return;
            const resultModel = columnData.data.result.model;
            updateMetricsForColumn(id, columnData.stats, resultModel);
            renderStatsForColumn(id, columnData);
            if (columnData.lmfInstance && columnData.enhancedResult) {
                const isDiffColumn = modelDiffMode && columnData.diffStats && !isBaseColumn(id);
                if (isDiffColumn && columnData.diffStats) {
                    columnData.lmfInstance.setDiffMode(true, columnData.diffStats.deltaByteSurprisals);
                } else {
                    columnData.lmfInstance.setDiffMode(false, []);
                }
                columnData.lmfInstance.update(columnData.enhancedResult);
            }
        });
    };

    addDigitsMergeRenderListener(refreshAllColumnsAfterDigitsMerge);

    // 使用统一的路径工具函数（已从 pathUtils 导入）

    // 创建单个 demo 列的 HTML 结构（使用唯一ID）
    const createColumnHTML = (id: string, demoName: string): string => {
        // 使用哈希生成安全的DOM ID（避免冲突）
        // safeId 用于所有 HTML 元素的 id 属性
        const safeId = toSafeId(id);
        const columnId = `compare-column-${safeId}`;
        const statsId = `stats_demo_${safeId}`;
        const headerId = `compare-header-${safeId}`;
        const metricsId = `text_metrics_${safeId}`;
        const errorId = `error_${safeId}`;
        const statsFracId = `stats_frac_${safeId}`;
        const statsByteFracId = `stats_byte_frac_${safeId}`;
        const statsProgressId = `stats_surprisal_progress_${safeId}`;
        const textRenderId = `text_render_${safeId}`;

        return `
            <!-- data-column-id 使用原始 id（规范化路径），便于调试和查询，HTML 属性支持特殊字符 -->
            <div id="${columnId}" class="compare-column" data-column-id="${id}">
                <div id="${headerId}" class="compare-header">
                    <div class="column-actions-row">
                        <button class="move-to-first-btn" title="${tr('Move to leftmost')}">⏮</button>
                        <button class="move-left-btn" title="${tr('Move left')}">◀</button>
                        <button class="delete-btn" title="${tr('Delete')}">×</button>
                        <button class="move-right-btn" title="${tr('Move right')}">▶</button>
                        <button class="move-to-last-btn" title="${tr('Move to rightmost')}">⏭</button>
                    </div>
                    <div class="column-title">${demoName}</div>
                </div>
                <div id="${errorId}" class="compare-error" style="display: none; color: var(--error-color, #f44336); padding: 10px; margin-bottom: 10px; background-color: var(--error-bg, rgba(244, 67, 54, 0.1)); border-radius: 4px;"></div>
                <div id="${metricsId}" class="text-metrics is-hidden">
                    <div class="text-metrics-primary">
                        <span id="metric_bytes_${safeId}">0 B</span>
                        <span class="text-metrics-divider">|</span>
                        <span id="metric_chars_${safeId}">${tr('0 chars')}</span>
                        <span class="text-metrics-divider">|</span>
                        <span id="metric_tokens_${safeId}">0 tokens</span>
                    </div>
                    <div id="metric_total_surprisal_${safeId}" class="text-metrics-secondary">${tr('total information = 0 bits')}</div>
                    <div id="metric_model_${safeId}" class="text-metrics-secondary is-hidden">model: </div>
                </div>
                <div id="${statsId}" class="stats" style="text-align:center;">
                    <div style="display:block;text-align: center;margin-bottom: 20px;">
                        <div id="token_histogram_title_${safeId}"></div>
                        <svg id="${statsFracId}"></svg>
                    </div>
                    <div style="display:block;text-align: center;margin-bottom: 20px;">
                        <div id="byte_histogram_title_${safeId}"></div>
                        <svg id="${statsByteFracId}"></svg>
                    </div>
                    <div style="display:block;text-align: center;margin-bottom: 20px;">
                        <div id="surprisal_progress_title_${safeId}"></div>
                        <svg id="${statsProgressId}"></svg>
                    </div>
                </div>
                <div id="${textRenderId}" class="compare-text-render is-hidden"></div>
            </div>
        `;
    };

    // 处理单个 demo 的数据
    const processDemoData = (data: AnalysisData): FrontendAnalyzeResult => {
        const result = data.result;
        const safeText = data.request.text;

        // 验证数据
        if (!Array.isArray(result.bpe_strings) || result.bpe_strings.length === 0) {
            throw new Error(tr('Returned JSON missing valid bpe_strings array'));
        }

        const predTopkError = validateTokenPredictions(result.bpe_strings as Array<{ pred_topk?: [string, number][] }>);
        if (predTopkError) {
            throw new Error(predTopkError);
        }

        const probabilityError = validateTokenProbabilities(result.bpe_strings as Array<{ real_topk?: [number, number] }>);
        if (probabilityError) {
            throw new Error(probabilityError);
        }

        const validationError = validateTokenConsistency(result.bpe_strings, safeText, { allowOverlap: true });
        if (validationError) {
            throw new Error(validationError);
        }

        // 处理 token 数据
        const originalTokens = result.bpe_strings.map((token) => cloneFrontendToken(token as FrontendToken));
        const bpeBpeMergedTokens = mergeTokensForRendering(originalTokens, safeText, {
            digitMerge: getDigitsMergeEnabled(),
        });

        const mergedValidationError = validateTokenConsistency(bpeBpeMergedTokens, safeText);
        if (mergedValidationError) {
            throw new Error(mergedValidationError);
        }

        const enhancedResult: FrontendAnalyzeResult = {
            ...result,
            originalTokens,
            bpeBpeMergedTokens,
            bpe_strings: bpeBpeMergedTokens,
            originalText: safeText
        };

        return enhancedResult;
    };

    // 为单个列渲染统计图表（使用ID）
    const renderStatsForColumn = (id: string, columnData: DemoColumnData) => {
        if (!columnData.stats || !columnData.histograms.stats_frac || !columnData.histograms.stats_byte_frac || !columnData.histograms.stats_surprisal_progress) {
            return;
        }

        const stats = columnData.stats;
        const isDiffColumn = modelDiffMode && columnData.diffStats && !isBaseColumn(id);
        const safeId = toSafeId(id);

        const mergedTokens = columnData.enhancedResult?.bpeBpeMergedTokens;
        const histogramTokenSurprisals =
            mergedTokens && mergedTokens.length > 0
                ? calculateMergedTokenSurprisals(mergedTokens)
                : stats.tokenSurprisals;
        const histogramTokenAvg = histogramTokenSurprisals.length > 0 ? computeAverage(histogramTokenSurprisals) : null;
        const histogramTokenP90 = histogramTokenSurprisals.length > 0 ? computeP90(histogramTokenSurprisals) : null;

        // 更新 token surprisal histogram（合并后 token，与原文渲染一致；不显示差分）
        // 使用 19 个台阶，对应区间：[0,1), [1,2), ..., [17,18), [18,∞)
        const tokenHistogramConfig = getTokenSurprisalHistogramConfig();
        columnData.histograms.stats_frac.update({
            ...tokenHistogramConfig,
            data: histogramTokenSurprisals,
            colorScale: tokenSurprisalColorScale,
            averageValue: histogramTokenAvg ?? undefined,
            p90Value: histogramTokenP90 ?? undefined,
            p90Label: tokenHistogramConfig.averageLabel,
        });

        // 更新列视图中 token surprisal histogram 的标题文本
        const tokenTitleElement = document.getElementById(`token_histogram_title_${safeId}`);
        if (tokenTitleElement) {
            tokenTitleElement.textContent = tokenHistogramConfig.label;
        }

        // 更新信息密度histogram（Diff列显示差分）
        if (isDiffColumn && columnData.diffStats) {
            // Diff列：显示Δ信息密度 histogram
            const deltaByteSurprisals = columnData.diffStats.deltaByteSurprisals;
            
            // 计算平均差分
            const deltaAverage = deltaByteSurprisals.length > 0
                ? deltaByteSurprisals.reduce((sum, val) => sum + val, 0) / deltaByteSurprisals.length
                : 0;
            
            const deltaByteSurprisalConfig = getDeltaByteSurprisalHistogramConfig();
            columnData.histograms.stats_byte_frac.update({
                ...deltaByteSurprisalConfig,
                data: deltaByteSurprisals,
                colorScale: getDiffColor,
                averageValue: deltaAverage,
            });
            
            // 更新标题文本
            const titleElement = document.getElementById(`byte_histogram_title_${safeId}`);
            if (titleElement) {
                titleElement.textContent = deltaByteSurprisalConfig.label;
            }
        } else {
            // Base列或非模型差分模式：显示原始信息密度 histogram
            // 使用 13 个台阶，对应区间：[0,0.5), [0.5,1), [1,1.5), ..., [5.5,6), [6,∞)
            const byteSurprisalConfig = getByteSurprisalHistogramConfig();
            columnData.histograms.stats_byte_frac.update({
                ...byteSurprisalConfig,
                data: stats.byteSurprisals,
                colorScale: byteSurprisalColorScale,
                averageValue: stats.byteAverage ?? undefined,
            });
            
            // 更新标题文本
            const titleElement = document.getElementById(`byte_histogram_title_${safeId}`);
            if (titleElement) {
                titleElement.textContent = byteSurprisalConfig.label;
            }
        }

        // 更新 surprisal progress scatter plot（与 token 直方图同为合并后 token）
        if (histogramTokenSurprisals.length > 0) {
            const surprisalProgressConfig = getSurprisalProgressConfig();
            columnData.histograms.stats_surprisal_progress.update({
                ...surprisalProgressConfig,
                data: histogramTokenSurprisals,
            });

            // 更新列视图中 surprisal progress 的标题文本
            const surprisalProgressTitleElement = document.getElementById(`surprisal_progress_title_${safeId}`);
            if (surprisalProgressTitleElement && surprisalProgressConfig.label) {
                surprisalProgressTitleElement.textContent = surprisalProgressConfig.label;
            }
        }
    };

    /**
     * 更新单个列的统计信息显示
     * @param id 列的唯一标识符
     * @param stats 文本统计信息，如果为null则隐藏所有指标
     * @param modelName 模型名称，如果提供则显示在总surprisal下方
     */
    const updateMetricsForColumn = (id: string, stats: TextStats | null, modelName?: string | null | undefined) => {
        const safeId = toSafeId(id);
        const metrics = d3.select(`#text_metrics_${safeId}`);
        const metricBytes = d3.select(`#metric_bytes_${safeId}`);
        const metricChars = d3.select(`#metric_chars_${safeId}`);
        const metricTokens = d3.select(`#metric_tokens_${safeId}`);
        const metricTotalSurprisal = d3.select(`#metric_total_surprisal_${safeId}`);
        const metricModel = d3.select(`#metric_model_${safeId}`);

        if (metrics.empty() || !validateMetricsElements(metricBytes, metricChars, metricTokens, metricTotalSurprisal, metricModel)) {
            return;
        }

        if (!stats) {
            metrics.classed('is-hidden', true);
            // 同时隐藏模型显示
            metricModel.classed('is-hidden', true);
            return;
        }

        // 更新基础指标
        updateBasicMetrics(metricBytes, metricChars, metricTokens, stats);
        
        // 在模型差分模式下，Diff列显示Δ总surprisal
        const columnData = columnsData.get(id);
        let diffMode: DiffModeConfig | undefined;
        if (modelDiffMode && columnData && columnData.diffStats && !isBaseColumn(id)) {
            // Diff列：显示Δ总surprisal（百分比形式）
            const delta = columnData.diffStats.deltaTotalSurprisal;
            const baseId = getBaseColumnId();
            const baseData = baseId ? columnsData.get(baseId) : null;
            const baseTotalSurprisal = baseData?.stats?.totalSurprisal;
            diffMode = {
                delta,
                baseTotalSurprisal
            };
        }
        
        // 更新总surprisal（支持差分模式）
        updateTotalSurprisal(metricTotalSurprisal, stats, totalSurprisalFormat, diffMode);

        // 更新模型显示（始终显示以反映原始情况）
        updateModel(metricModel, modelName);
        metricModel.classed('is-hidden', false);

        // 显示指标容器
        metrics.classed('is-hidden', false);
    };

    // 显示错误信息（使用ID）
    const showErrorForColumn = (id: string, error: string | null) => {
        const safeId = toSafeId(id);
        const errorDiv = d3.select(`#error_${safeId}`);
        const statsDiv = d3.select(`#stats_demo_${safeId}`);
        const metricsDiv = d3.select(`#text_metrics_${safeId}`);

        if (errorDiv.empty()) {
            return;
        }

        if (error) {
            errorDiv.text(error).style('display', null);
            statsDiv.style('display', 'none');
            // 使用CSS类隐藏指标容器
            if (!metricsDiv.empty()) {
                metricsDiv.classed('is-hidden', true);
            }
        } else {
            errorDiv.style('display', 'none');
            statsDiv.style('display', null);
        }
    };

    // 加载单个 demo（使用ID）
    // 加载指定列的demo数据（使用统一资源加载器）
    const loadDemoForColumn = async (id: string): Promise<void> => {
        const columnData = columnsData.get(id);
        if (!columnData) {
            console.error(`找不到ID为 ${id} 的列数据`);
            return;
        }

        try {
            // 如果已有预加载的数据（来自模型差分模式的预检查），直接使用，避免重复请求
            let response: AnalysisData;
            if (columnData.data) {
                response = columnData.data;
            } else {
                // 否则使用统一的资源加载器加载数据
                const result = await demoResourceLoader.load(columnData.demoPath);
                
                if (!result.success || !result.data) {
                    columnData.error = tr(result.message || 'Load failed');
                    showErrorForColumn(id, columnData.error);
                    updateModelDiffModeAvailability();
                    return;
                }

                response = result.data;
            }
            const enhancedResult = processDemoData(response);
            const safeText = response.request.text;
            const textStats = calculateTextStats(enhancedResult, safeText);

            columnData.data = response;
            columnData.enhancedResult = enhancedResult;
            columnData.stats = textStats;
            columnData.error = null;
            // 保存原文
            columnData.originalText = safeText;

            // 隐藏错误，显示内容
            showErrorForColumn(id, null);

            // 更新统计信息显示（从分析结果中获取实际使用的模型）
            const resultModel = response.result.model;
            updateMetricsForColumn(id, textStats, resultModel);

            // 渲染统计图表
            renderStatsForColumn(id, columnData);

            // 如果模型差分模式已启用，更新 LMF 实例
            if (modelDiffMode) {
                // 重新计算所有列的差分数据（因为可能添加了新列）
                recalculateAllDiffStats();
                
                // 重新渲染所有列的统计图表和指标（因为差分数据可能变化）
                columnsData.forEach((colData, colId) => {
                    if (colData.stats) {
                        const resultModel = colData.data.result.model;
                        updateMetricsForColumn(colId, colData.stats, resultModel);
                        renderStatsForColumn(colId, colData);
                    }
                });
                
                if (!columnData.lmfInstance) {
                    initLMFForColumn(id, columnData);
                } else {
                    // 更新差分模式（因为差分数据可能变化）
                    const isDiffColumn = columnData.diffStats && !isBaseColumn(id);
                    if (isDiffColumn && columnData.diffStats) {
                        columnData.lmfInstance.setDiffMode(true, columnData.diffStats.deltaByteSurprisals);
                    } else {
                        columnData.lmfInstance.setDiffMode(false, []);
                    }
                    columnData.lmfInstance.update(enhancedResult);
                }
            } else if (showTextRender) {
                // 非模型差分模式，但显示文本渲染，确保 LMF 实例存在并更新数据
                if (!columnData.lmfInstance) {
                    initLMFForColumn(id, columnData);
                } else {
                    columnData.lmfInstance.update(enhancedResult);
                }
            }

        } catch (err) {
            console.error(`加载 demo ${columnData.demoPath} 失败:`, err);
            columnData.error = err instanceof Error ? err.message : tr('Load failed');
            showErrorForColumn(id, columnData.error);
        } finally {
            // 加载完成（成功或失败）后，更新模型差分模式可用性
            updateModelDiffModeAvailability();
        }
    };

    // 初始化列的可视化组件（使用ID）
    const initializeColumnVisualizations = (id: string, columnData: DemoColumnData): void => {
        const safeId = toSafeId(id);
        const statsFracId = `#stats_frac_${safeId}`;
        const statsByteFracId = `#stats_byte_frac_${safeId}`;
        const statsProgressId = `#stats_surprisal_progress_${safeId}`;

        // 创建 Histogram 实例
        columnData.histograms.stats_frac = new Histogram(
            d3.select(statsFracId),
            eventHandler,
            { width: 400, height: 200 }
        );

        columnData.histograms.stats_byte_frac = new Histogram(
            d3.select(statsByteFracId),
            eventHandler,
            { width: 400, height: 200 }
        );

        // 创建 ScatterPlot 实例
        columnData.histograms.stats_surprisal_progress = new ScatterPlot(
            d3.select(statsProgressId),
            eventHandler,
            { width: 400, height: 200 }
        );

        // 如果需要显示文本渲染（模型差分模式或显示文本渲染开关），初始化 LMF 实例
        if (modelDiffMode || showTextRender) {
            initLMFForColumn(id, columnData);
        }
    };

    // 为指定列初始化 LMF 实例
    const initLMFForColumn = (id: string, columnData: DemoColumnData): void => {
        const safeId = toSafeId(id);
        const textRenderId = `#text_render_${safeId}`;
        const textRenderContainer = d3.select(textRenderId);
        
        if (textRenderContainer.empty()) {
            console.error(`找不到文本渲染容器: ${textRenderId}`);
            return;
        }

        // 根据状态决定是否显示文本渲染区域
        // 模型差分模式下始终显示，非模型差分模式下根据 showTextRender 决定
        const shouldShow = modelDiffMode || showTextRender;
        textRenderContainer.classed('is-hidden', !shouldShow);

        // 如果实例已存在，先销毁
        if (columnData.lmfInstance) {
            columnData.lmfInstance.destroy();
        }

        // 创建新的 LMF 实例
        columnData.lmfInstance = new GLTR_Text_Box(textRenderContainer, eventHandler);
        // 对比模式下禁用动画，暂时禁用 minimap
        // minimapWidth 从 CSS 变量读取，无需硬编码
        columnData.lmfInstance.updateOptions({
            gltrMode: GLTR_Mode.fract_p,
            enableRenderAnimation: false,
            enableMinimap: false
        }, true);

        // 设置差分模式（如果是Diff列）
        const isDiffColumn = modelDiffMode && columnData.diffStats && !isBaseColumn(id);
        if (isDiffColumn && columnData.diffStats) {
            columnData.lmfInstance.setDiffMode(true, columnData.diffStats.deltaByteSurprisals);
        } else {
            columnData.lmfInstance.setDiffMode(false, []);
        }

        // 如果有数据，更新显示
        let enhancedResult = columnData.enhancedResult;
        if (!enhancedResult && columnData.data) {
            enhancedResult = processDemoData(columnData.data);
            columnData.enhancedResult = enhancedResult;
        }
        if (enhancedResult) {
            columnData.lmfInstance.update(enhancedResult);
        }
    };

    // 根据 histogram source 解析出列的 safeId 和直方图类型
    const parseHistogramSource = (source?: string): { safeId: string; histogramType: 'token' | 'byte' } | null => {
        if (!source) {
            return null;
        }

        const bytePrefix = 'stats_byte_frac';
        const tokenPrefix = 'stats_frac';

        if (source.startsWith(bytePrefix)) {
            const safeId = source.substring(bytePrefix.length).replace(/^_/, '');
            return safeId ? { safeId, histogramType: 'byte' } : null;
        }

        if (source.startsWith(tokenPrefix)) {
            const safeId = source.substring(tokenPrefix.length).replace(/^_/, '');
            return safeId ? { safeId, histogramType: 'token' } : null;
        }

        return null;
    };

    // 通过 safeId 查找对应的列数据
    const findColumnBySafeId = (safeId: string): { id: string; columnData: DemoColumnData } | null => {
        if (!safeId) {
            return null;
        }

        for (const [id, columnData] of columnsData.entries()) {
            if (toSafeId(id) === safeId) {
                return { id, columnData };
            }
        }

        return null;
    };

    // 处理直方图点击，高亮对应文本
    const handleHistogramBinClick = (ev: HistogramBinClickEvent): void => {
        const parsed = parseHistogramSource(ev?.source);
        if (!parsed) {
            return;
        }

        const columnEntry = findColumnBySafeId(parsed.safeId);
        if (!columnEntry) {
            return;
        }

        const { columnData } = columnEntry;

        // 在模型差分模式下，只有base列支持点击高亮
        // 非差分模式下，仅在文本渲染已初始化时处理高亮
        if (modelDiffMode) {
            // 模型差分模式：只有base列支持点击高亮
            if (!isBaseColumn(columnData.id) || !columnData.lmfInstance) {
                return;
            }
        } else {
            // 非模型差分模式：需要文本渲染已初始化
            if (!columnData.lmfInstance) {
                return;
            }
        }

        const { stats_frac, stats_byte_frac } = columnData.histograms;

        let enhancedResult = columnData.enhancedResult;
        if (!enhancedResult && columnData.data) {
            enhancedResult = processDemoData(columnData.data);
            columnData.enhancedResult = enhancedResult;
        }

        if (!enhancedResult) {
            return;
        }

        // binIndex 为 -1 表示取消高亮
        if (ev.binIndex === -1) {
            stats_frac?.clearSelection();
            stats_byte_frac?.clearSelection();
            columnData.lmfInstance.clearHighlight();
            return;
        }

        // 同一列内仅保持一个直方图的选中状态
        if (parsed.histogramType === 'byte') {
            stats_frac?.clearSelection();
        } else {
            stats_byte_frac?.clearSelection();
        }

        // 使用通用的高亮计算函数
        const { x0, x1 } = ev;
        const { indices, style } = calculateHighlights(parsed.histogramType, x0, x1, ev.binIndex, ev.no_bins, enhancedResult);
        
        // 高亮这些 token
        columnData.lmfInstance.setHighlightedIndices(indices, style);
    };

    // 绑定token悬停事件到全局tooltip
    eventHandler.bind(GLTR_Text_Box.events.tokenHovered, (ev: GLTR_HoverEvent) => {
        if (ev.hovered) {
            toolTip.updateData(ev.d, ev.event);
        } else {
            toolTip.visibility = false;
        }
    });

    // 直方图点击 -> 高亮对应文本
    eventHandler.bind(Histogram.events.binClicked, handleHistogramBinClick);

    /**
     * 更新模型差分模式 checkbox 的可用状态
     * 当有 demo 正在加载时禁用 checkbox，所有 demo 加载完成后启用
     */
    const updateModelDiffModeAvailability = (): void => {
        const hasLoadingDemos = Array.from(columnsData.values())
            .some(col => !col.data && !col.error);
        
        const checkbox = d3.select<HTMLInputElement, any>('#model_diff_mode_toggle').node();
        if (checkbox) {
            checkbox.disabled = hasLoadingDemos;
            if (hasLoadingDemos) {
                checkbox.title = tr('Please wait for all demos to load');
            } else {
                checkbox.title = '';
            }
        }
    };

    // 检查所有 demo 的原文是否一致
    const checkTextConsistency = (): { consistent: boolean; referenceText?: string; inconsistentDemos?: string[] } => {
        const texts = new Map<string, string[]>();
        
        // 收集所有 demo 的原文
        columnsData.forEach((columnData, id) => {
            let text: string | undefined;
            
            // 优先使用缓存的原文
            if (columnData.originalText !== undefined) {
                text = columnData.originalText;
            } else if (columnData.data) {
                text = columnData.data.request.text;
            }
            
            if (text !== undefined) {
                if (!texts.has(text)) {
                    texts.set(text, []);
                }
                texts.get(text)!.push(columnData.demoName);
            }
        });

        if (texts.size === 0) {
            // 没有已加载的 demo
            return { consistent: true };
        }

        if (texts.size === 1) {
            // 所有 demo 的原文相同
            const referenceText = Array.from(texts.keys())[0];
            return { consistent: true, referenceText };
        }

        // 原文不一致，收集所有不一致的 demo 名称
        const inconsistentDemos: string[] = [];
        texts.forEach((demos) => {
            inconsistentDemos.push(...demos);
        });

        return { consistent: false, inconsistentDemos };
    };

    // 清理模型差分模式相关资源
    const cleanupModelDiffMode = (): void => {
        columnsData.forEach((columnData) => {
            // 只清除差分模式，不销毁实例
            // 实例的生命周期由 updateTextRenderVisibility 统一管理
            if (columnData.lmfInstance) {
                columnData.lmfInstance.setDiffMode(false, []);
            }
            
            // 清空原文缓存（可选，因为数据还在 data 字段中）
            // columnData.originalText = undefined;
        });
    };

    // 启用模型差分模式
    const enableModelDiffMode = (): void => {
        // 检查原文一致性
        const consistency = checkTextConsistency();
        
        if (!consistency.consistent) {
            showAlertDialog(tr('Error'), tr('Cannot enable model diff mode: current demos have inconsistent source text'));
            // 保持 checkbox 未选中状态
            const checkbox = d3.select<HTMLInputElement, any>('#model_diff_mode_toggle').node();
            if (checkbox) {
                checkbox.checked = false;
            }
            return;
        }

        modelDiffMode = true;

        // 更新URL
        syncStateToURL();

        // 更新"显示文本渲染"checkbox状态（模型差分模式下自动选中并禁用）
        updateShowTextRenderCheckbox();

        // 计算所有列的差分数据
        recalculateAllDiffStats();

        // 重新渲染所有列的统计图表和指标
        columnsData.forEach((columnData, id) => {
            if (columnData.stats) {
                // 更新统计信息显示
                const resultModel = columnData.data.result.model;
                updateMetricsForColumn(id, columnData.stats, resultModel);
                
                // 重新渲染图表
                renderStatsForColumn(id, columnData);
            }
        });

        // 显示所有文本渲染区域并初始化 LMF 实例
        columnsData.forEach((columnData, id) => {
            // 初始化 LMF 实例（如果不存在）或更新差分模式
            if (!columnData.lmfInstance) {
                initLMFForColumn(id, columnData);
            } else {
                const safeId = toSafeId(id);
                const textRenderContainer = d3.select(`#text_render_${safeId}`);
                
                if (!textRenderContainer.empty()) {
                    // 确保容器可见
                    textRenderContainer.classed('is-hidden', false);

                    // 更新差分模式
                    const isDiffColumn = columnData.diffStats && !isBaseColumn(id);
                    if (isDiffColumn && columnData.diffStats) {
                        columnData.lmfInstance.setDiffMode(true, columnData.diffStats.deltaByteSurprisals);
                    } else {
                        columnData.lmfInstance.setDiffMode(false, []);
                    }
                }
            }
        });
    };

    // 禁用模型差分模式
    const disableModelDiffMode = (): void => {
        modelDiffMode = false;
        
        // 更新URL
        syncStateToURL();
        
        // 清除所有列的差分数据
        columnsData.forEach((columnData) => {
            columnData.diffStats = null;
        });
        
        // 清理模型差分模式资源（销毁LMF实例）
        cleanupModelDiffMode();
        
        // 重新渲染所有列的统计图表和指标（恢复正常显示）
        columnsData.forEach((columnData, id) => {
            if (columnData.stats) {
                // 更新统计信息显示
                const resultModel = columnData.data.result.model;
                updateMetricsForColumn(id, columnData.stats, resultModel);
                
                // 重新渲染图表
                renderStatsForColumn(id, columnData);
            }
        });
        
        // 更新"显示文本渲染"checkbox状态（恢复可用）
        updateShowTextRenderCheckbox();
        
        // 根据showTextRender状态更新文本渲染显示（会重新创建LMF实例如果需要）
        updateTextRenderVisibility();
    };

    /**
     * 更新所有列的文本渲染显示状态
     */
    const updateTextRenderVisibility = (): void => {
        columnsData.forEach((columnData, id) => {
            const safeId = toSafeId(id);
            const textRenderContainer = d3.select(`#text_render_${safeId}`);
            
            if (!textRenderContainer.empty()) {
                // 模型差分模式下始终显示，非模型差分模式下根据 showTextRender 决定
                const shouldShow = modelDiffMode || showTextRender;
                textRenderContainer.classed('is-hidden', !shouldShow);
                
                // 需要显示但实例不存在 → 创建实例
                if (shouldShow && !columnData.lmfInstance) {
                    initLMFForColumn(id, columnData);
                }
                // 不需要显示但实例存在 → 销毁实例
                else if (!shouldShow && columnData.lmfInstance) {
                    columnData.lmfInstance.destroy();
                    columnData.lmfInstance = undefined;
                }
            }
        });
        
        // 更新URL
        syncStateToURL();
    };

    /**
     * 更新"显示文本渲染"checkbox的状态
     */
    const updateShowTextRenderCheckbox = (): void => {
        const checkbox = d3.select<HTMLInputElement, any>('#show_text_render_toggle').node();
        if (checkbox) {
            // 模型差分模式下，checkbox应该被选中且禁用
            if (modelDiffMode) {
                checkbox.checked = true;
                checkbox.disabled = true;
            } else {
                // 非模型差分模式下，checkbox可用，状态由用户控制
                checkbox.disabled = false;
                checkbox.checked = showTextRender;
            }
        }
    };

    /**
     * 处理本地文件选择（复用首页架构，支持多选）
     * 完整流程：文件选择 → 保存到缓存 → 创建标识符 → 添加到对比列表
     */
    const handleLocalFileSelection = async (): Promise<void> => {
        try {
            // 1. 触发文件选择器（启用多选）
            const result = await localFileIO.import(true);
            
            if (!result.success) {
                // 用户取消不提示错误
                if (!result.cancelled && result.message) {
                    showAlertDialog(tr('Error'), tr(result.message || 'Import failed'));
                }
                return;
            }
            
            // 2. 处理文件列表（多选模式始终返回 files 数组）
            const filesToProcess = result.files || [];
            
            if (filesToProcess.length === 0) {
                showAlertDialog(tr('Error'), tr('No file selected'));
                return;
            }
            
            // 如果文件读取阶段有部分失败，先显示提示
            if (result.message) {
                // message 包含部分文件失败的信息，但这不影响后续处理
                // 因为 files 数组已经包含了成功读取的文件
                console.warn('File reading warning:', result.message);
            }
            
            // 3. 批量处理：保存到缓存、创建标识符、添加到对比列表
            const errors: string[] = [];
            
            for (const file of filesToProcess) {
                try {
                    // 保存到缓存并获取哈希
                    const saveResult = await localDemoCache.save(file.data, { 
                        name: file.filename 
                    });
                    
                    if (!saveResult.success || !saveResult.hash) {
                        errors.push(`${file.filename}: ${tr(saveResult.message || 'Failed to save to cache')}`);
                        continue;
                    }
                    
                    // 创建资源标识符（格式：local://filename.json~hash）
                    const identifier = DemoResourceLoader.createLocalIdentifier(
                        file.filename, 
                        saveResult.hash
                    );
                    
                    // 添加到对比列表（如果已存在会跳过，不会重复添加）
                    await addSingleColumn(identifier);
                    
                } catch (error) {
                    const message = extractErrorMessage(error, tr('Processing failed'));
                    errors.push(`${file.filename}: ${message}`);
                }
            }
            
            // 4. 如果有错误，显示错误提示
            if (errors.length > 0) {
                const successCount = filesToProcess.length - errors.length;
                const errorMessage = errors.length === filesToProcess.length
                    ? tr('All files import failed:') + `\n${errors.join('\n')}`
                    : tr('Some files import failed') + ` (${tr('Success')} ${successCount}/${filesToProcess.length}):\n${errors.join('\n')}`;
                showAlertDialog(tr('Import Result'), errorMessage);
            }
            
            // 5. 更新URL（只有在至少有一个文件成功时才更新）
            if (filesToProcess.length > errors.length) {
                syncStateToURL();
            }
            
        } catch (error) {
            const message = extractErrorMessage(error, tr('Failed to add local file'));
            console.error('Failed to add local file:', error);
            showAlertDialog(tr('Error'), message);
        }
    };

    // 添加单个demo列（动态添加，不重新加载全部）
    // 支持本地资源（local://filename.json~hash）和服务器资源（folder/demo.json）
    const addSingleColumn = async (resourceIdentifier: string): Promise<void> => {
        // 1. 判断资源类型并生成唯一ID
        const isLocal = DemoResourceLoader.isLocalResource(resourceIdentifier);
        const id = isLocal 
            ? resourceIdentifier  // 本地资源：直接使用标识符作为ID
            : normalizeDemoPath(resourceIdentifier);  // 服务器资源：规范化路径
        
        // 2. 检查是否已存在
        if (columnsData.has(id)) {
            showAlertDialog(tr('Info'), tr('This demo is already in the comparison list'));
            return;
        }
        
        // 3. 提取显示名称
        const demoName = isLocal 
            ? DemoResourceLoader.extractLocalInfo(resourceIdentifier).filename
            : getDemoName(resourceIdentifier);

        // 4. 用于缓存预加载的数据，避免重复请求
        let preloadedData: AnalysisData | null = null;

        // 5. 如果模型差分模式已启用，先预检查原文
        if (modelDiffMode) {
            try {
                // 使用统一的资源加载器预加载数据（使用原始资源标识符）
                const result = await demoResourceLoader.load(resourceIdentifier);
                
                if (!result.success || !result.data) {
                    showAlertDialog(tr('Error'), tr(result.message || 'Load failed'));
                    return;
                }
                
                const preloadText = result.data.request.text;
                
                // 与已有 demo 的原文对比
                const consistency = checkTextConsistency();
                
                if (consistency.consistent && consistency.referenceText !== undefined) {
                    if (preloadText !== consistency.referenceText) {
                        // 原文不一致，显示错误并返回
                        showAlertDialog(tr('Error'), tr('Cannot add demo, source text inconsistent with existing demos:') + `\n${demoName}`);
                        return;
                    }
                }

                // 预检查通过，缓存数据供后续使用，避免重复请求
                preloadedData = result.data;
            } catch (err) {
                console.error(`预检查 demo ${resourceIdentifier} 失败:`, err);
                const message = extractErrorMessage(err, tr('Precheck failed'));
                showAlertDialog(tr('Error'), tr('Demo precheck failed:') + ` ${message}`);
                return;
            }
        }
        
        // 6. 创建列数据对象
        const columnData: DemoColumnData = {
            id,
            demoPath: resourceIdentifier,  // 存储资源标识符（本地或服务器）
            demoName,
            data: preloadedData,  // 如果有预加载的数据，直接使用；否则为 null
            enhancedResult: null,
            stats: null,
            error: null,
            originalText: undefined,
            lmfInstance: undefined,
            histograms: {
                stats_frac: null,
                stats_byte_frac: null,
                stats_surprisal_progress: null
            }
        };
        
        // 7. 创建HTML并插入到容器末尾
        const columnHTML = createColumnHTML(id, demoName);
        const containerNode = container.node();
        if (!containerNode || !(containerNode instanceof Element)) {
            throw new Error('Container node is not an Element');
        }
        const columnElement = document.createElement('div');
        containerNode.appendChild(columnElement);
        const columnNode = d3.select(columnElement);
        columnNode.html(columnHTML);
        
        // 8. 初始化可视化组件
        initializeColumnVisualizations(id, columnData);
        
        // 9. 存储数据
        columnsData.set(id, columnData);
        
        // 10. 加载demo数据（如果已有预加载数据，loadDemoForColumn 会跳过重复请求）
        await loadDemoForColumn(id);
    };

    // 清空所有对比列
    const clearAllColumns = (): void => {
        // 清理所有 LMF 实例
        columnsData.forEach((columnData) => {
            if (columnData.lmfInstance) {
                columnData.lmfInstance.destroy();
                columnData.lmfInstance = undefined;
            }
        });
        
        // 清空数据
        columnsData.clear();
        
        // 只移除列元素，保留空状态元素（空状态会自动显示）
        container.selectAll('.compare-column').remove();
        
        // 更新URL（移除demos参数）
        const currentParams = URLHandler.parameters;
        delete currentParams['demos'];
        URLHandler.updateUrl(currentParams, false);
        
        // 更新模型差分模式可用性（清空后应该禁用）
        updateModelDiffModeAvailability();
        
        // 不再需要手动设置提示信息，CSS会自动显示空状态
    };

    // 同步状态到URL参数（保留其他URL参数）
    const syncStateToURL = (): void => {
        const demoPaths = Array.from(columnsData.values())
            .map(col => col.demoPath)
            .filter(path => path != null && path !== ''); // 明确过滤空值
        
        const currentParams = URLHandler.parameters;
        
        // 删除要控制的参数
        delete currentParams['showTextRender'];
        delete currentParams['modelDiffMode'];
        delete currentParams['demos'];
        
        // 直接在 currentParams 上添加，确保 showTextRender 和 modelDiffMode 在 demos 前面
        if (showTextRender) {
            currentParams['showTextRender'] = '1';
        }
        
        if (modelDiffMode) {
            currentParams['modelDiffMode'] = '1';
        }
        
        if (demoPaths.length > 0) {
            // demos 始终按数组语义：写入为逗号拼接字符串，避免 URL 出现数组前缀 ".."
            currentParams['demos'] = demoPaths.join(',');
        }
        
        URLHandler.updateUrl(currentParams, false);
    };

    // 初始化所有列（从URL参数加载）
    const initializeColumns = async (): Promise<void> => {
        if (demoPaths.length === 0) {
            // 容器为空时，空状态会自动显示
            return;
        }
        
        // 串行添加所有列，保持 URL 参数顺序
        try {
            for (const path of demoPaths) {
                await addSingleColumn(path);
            }

            // 检查是否有错误
            const errors = Array.from(columnsData.values())
                .filter(col => col.error)
                .map(col => `${col.demoName}: ${col.error}`);
            if (errors.length > 0) {
                showAlertDialog(tr('Some demos failed to load'), errors.join('\n'));
            }
            
            // 初始化完成后，更新模型差分模式可用性
            updateModelDiffModeAvailability();
        } catch (err) {
            console.error('Error loading demos:', err);
            showAlertDialog(tr('Error'), tr('Error loading demos, please check console for details.'));
            // 即使出错也要更新可用性
            updateModelDiffModeAvailability();
        }
    };

    // 初始化主题管理器（在所有函数定义之后）
    const themeManager = initThemeManager({
        onThemeChange: () => {
            columnsData.forEach((col) => {
                if (col.data && col.stats) {
                    renderStatsForColumn(col.id, col);
                }
                requestAnimationFrame(() => col.lmfInstance?.reRenderCurrent());
            });
        }
    });

    // 获取当前已存在的demo ID集合
    // 本地资源：使用完整标识符（local://filename~hash）
    // 服务器资源：使用规范化路径
    const getExistingDemoIds = (): Set<string> => {
        return new Set(
            Array.from(columnsData.values())
                .map(col => {
                    // 本地资源直接使用标识符，服务器资源规范化路径
                    return DemoResourceLoader.isLocalResource(col.demoPath)
                        ? col.demoPath
                        : normalizeDemoPath(col.demoPath);
                })
        );
    };

    // 打开demo选择弹窗
    const showDemoSelectorDialog = (): void => {
        const existingDemoIds = getExistingDemoIds();

        showDialog({
            title: tr('Select Demo'),
            // 使用CSS响应式单位，自动响应窗口大小变化
            // 宽度：最小300px，最大不超过90vw或800px
            width: 'clamp(300px, 90vw, 800px)',
            // 高度：最小400px，最大不超过85vh
            height: 'max(400px, 85vh)',
            content: (dialog, setConfirmButtonState) => {
                // 创建demo选择容器
                const demoContainer = dialog.append('div')
                    .attr('class', 'demo-selector-container');

                // 创建demo-section结构（服务器demo列表）
                const demoSection = demoContainer.append('section')
                    .attr('class', 'demo-section');

                const demoHeader = demoSection.append('div')
                    .attr('class', 'demo-header');

                // 左侧：文本和刷新按钮
                const leftSection = demoHeader.append('div')
                    .style('display', 'flex')
                    .style('align-items', 'center')
                    .style('gap', '8px');

                leftSection.append('span')
                    .text(tr('Select demo to add:'));

                const refreshBtn = leftSection.append('button')
                    .attr('class', 'refresh-btn')
                    .attr('title', tr('Refresh demo list'))
                    .text('↻');

                const loadingIndicator = leftSection.append('span')
                    .attr('class', 'demos-loading')
                    .style('display', 'none')
                    .text(tr('Refreshing...'));

                // 右侧：本地文件选择按钮
                const headerActions = demoHeader.append('div')
                    .attr('class', 'demo-header-actions');

                headerActions.append('button')
                    .attr('class', 'btn btn-primary')
                    .style('padding', '8px 16px')
                    .style('cursor', 'pointer')
                    .text(tr('Select local'))
                    .on('click', async () => {
                        // 关闭弹窗
                        const overlay = d3.select('.dialog-overlay');
                        if (!overlay.empty()) {
                            overlay.remove();
                        }
                        
                        // 触发本地文件选择
                        await handleLocalFileSelection();
                    });

                const demosContainer = demoSection.append('div')
                    .attr('class', 'demos');

                // 创建独立的demoManager实例（只读模式，强制多选）
                const selectorDemoManager = initDemoManager({
                    api,
                    enableDemo: true,
                    containerSelector: '.demo-selector-container .demos',
                    loaderSelector: '.demo-selector-container .demos-loading',
                    refreshSelector: '.demo-selector-container .refresh-btn',
                    forceMultiSelect: true,           // 强制启用多选模式
                    disableFolderOperations: true,    // 禁用文件夹操作（只读模式）
                    disableClickLoad: true,           // 禁用单击加载，只通过复选框选择
                    onDemoLoaded: () => {
                        // 只读模式：不加载demo
                    },
                    onTextPrefill: () => {},
                    onDemoLoading: () => {},
                    onRefreshStart: () => {
                        loadingIndicator.style('display', null);
                    },
                    onRefreshEnd: () => {
                        loadingIndicator.style('display', 'none');
                        // 刷新后重新标记已存在的demo（多选模式已自动启用）
                        markExistingDemos();
                    },
                    onSelectionChange: (selectedCount: number) => {
                        // 当选择数量变化时，更新弹窗确定按钮的可用状态
                        if (setConfirmButtonState) {
                            const hasSelection = selectedCount > 0;
                            setConfirmButtonState(hasSelection);
                        }
                    },
                });

                // 标记已存在的demo为不可选
                const markExistingDemos = () => {
                    const demoItems = d3.selectAll<HTMLDivElement, any>('.demo-selector-container .demo-item');
                    demoItems.each(function(d) {
                        const demoItem = d3.select(this);
                        const checkbox = demoItem.select<HTMLInputElement>('.demo-checkbox-inline');
                        const demoBtn = demoItem.select('.demoBtn');
                        
                        if (!checkbox.empty() && !demoBtn.empty() && d) {
                            // 获取demo的完整路径
                            // d是绑定到demo-item的数据（DemoItem类型）
                            const itemPath = d.path || '';
                            const normalizedPath = normalizeDemoPath(itemPath);
                            
                            if (existingDemoIds.has(normalizedPath)) {
                                // 禁用复选框
                                const checkboxNode = checkbox.node();
                                if (checkboxNode) {
                                    checkboxNode.disabled = true;
                                    checkboxNode.checked = false;
                                }
                                
                                // 添加视觉提示
                                demoItem.classed('demo-item-disabled', true);
                                demoBtn.classed('demo-disabled', true);
                            }
                            // 不再重新绑定 change 事件，让 demoManager.ts 的事件处理正常工作
                            // 这样 multiSelect 的状态会自动同步，控制栏按钮状态也会自动更新
                        }
                    });
                };

                return {
                    getValue: () => {
                        return selectorDemoManager.getSelectedPaths();
                    },
                    validate: () => {
                        return selectorDemoManager.getSelectedPaths().length > 0;
                    }
                };
            },
            onConfirm: (selectedPaths: string[]) => {
                if (!selectedPaths || selectedPaths.length === 0) {
                    showAlertDialog(tr('Info'), tr('Please select at least one demo'));
                    return;
                }
                
                // 串行添加选中的demo，保持选择顺序
                (async () => {
                    try {
                        for (const path of selectedPaths) {
                            await wrappedAddSingleColumn(path);
                        }
                        // 更新URL
                        syncStateToURL();
                    } catch (err) {
                        console.error('Failed to add demo:', err);
                    }
                })();
            },
            confirmText: tr('Confirm'),
            cancelText: tr('Cancel')
        });
    };

    // 编辑模式状态
    let editMode = false;
    const wrapper = d3.select('.compare-wrapper');

    // 切换编辑模式
    const toggleEditMode = (): void => {
        editMode = !editMode;
        if (editMode) {
            wrapper.classed('edit-mode', true);
        } else {
            wrapper.classed('edit-mode', false);
        }
        updateEditButtonsState();
    };

    // 更新编辑按钮状态（禁用首列左移、移到最左，末列右移、移到最右）
    const updateEditButtonsState = (): void => {
        const columns = container.selectAll<HTMLElement, any>('.compare-column');
        const columnNodes = columns.nodes();
        
        columns.each(function(d, i) {
            const columnElement = d3.select(this);
            const moveToFirstBtn = columnElement.select('.move-to-first-btn');
            const moveLeftBtn = columnElement.select('.move-left-btn');
            const moveRightBtn = columnElement.select('.move-right-btn');
            const moveToLastBtn = columnElement.select('.move-to-last-btn');
            
            // 首列禁用左移和移到最左
            const isFirst = i === 0;
            moveToFirstBtn.property('disabled', isFirst);
            moveLeftBtn.property('disabled', isFirst);
            
            // 末列禁用右移和移到最右
            const isLast = i === columnNodes.length - 1;
            moveRightBtn.property('disabled', isLast);
            moveToLastBtn.property('disabled', isLast);
        });
    };

    // 同步 DOM 顺序到 columnsData 和 URL（公共逻辑）
    const syncColumnOrder = (): void => {
        // 重新查询 DOM 获取新的顺序（DOM 操作后必须重新查询）
        const newAllColumns = Array.from(container.selectAll('.compare-column').nodes()) as HTMLElement[];
        const newColumnIds = newAllColumns.map(node => {
            const element = node as HTMLElement;
            return element.getAttribute('data-column-id') || '';
        }).filter(id => id && columnsData.has(id));

        // 重新构建 columnsData Map（按照新的 DOM 顺序）
        const newColumnsData = new Map<string, DemoColumnData>();
        newColumnIds.forEach(id => {
            const data = columnsData.get(id);
            if (data) {
                newColumnsData.set(id, data);
            }
        });
        columnsData.clear();
        newColumnsData.forEach((value, key) => {
            columnsData.set(key, value);
        });

        // 更新 URL
        syncStateToURL();

        // 更新按钮状态
        updateEditButtonsState();
        
        // 如果在模型差分模式下，重新计算差分数据（因为Base可能变了）
        if (modelDiffMode) {
            recalculateAllDiffStats();
            
            // 重新渲染所有列的统计图表和指标，并更新 LMF 实例的差分模式
            columnsData.forEach((columnData, id) => {
                if (columnData.stats) {
                    const resultModel = columnData.data.result.model;
                    updateMetricsForColumn(id, columnData.stats, resultModel);
                    renderStatsForColumn(id, columnData);
                }
                
                // 更新 LMF 实例的差分模式（如果存在）
                if (columnData.lmfInstance) {
                    const isDiffColumn = columnData.diffStats && !isBaseColumn(id);
                    if (isDiffColumn && columnData.diffStats) {
                        columnData.lmfInstance.setDiffMode(true, columnData.diffStats.deltaByteSurprisals);
                    } else {
                        columnData.lmfInstance.setDiffMode(false, []);
                    }
                }
            });
        }
    };

    // 移动列（支持 left/right/first/last 四个方向）
    const moveColumn = (columnId: string, direction: 'left' | 'right' | 'first' | 'last'): void => {
        const columnElement = container.select(`[data-column-id="${columnId}"]`);
        if (columnElement.empty()) {
            return;
        }

        const columnNode = columnElement.node() as HTMLElement | null;
        if (!columnNode) {
            return;
        }

        // 获取所有 .compare-column 元素（按 DOM 顺序）
        const allColumns = Array.from(container.selectAll('.compare-column').nodes()) as HTMLElement[];
        const currentIndex = allColumns.indexOf(columnNode);
        
        if (currentIndex === -1) {
            return; // 找不到当前列
        }

        // 获取容器节点（#compare-container）
        const containerNode = container.node() as HTMLElement | null;
        if (!containerNode) {
            return;
        }

        // 获取要移动的元素的父节点（外层 div）
        const columnParent = columnNode.parentElement;
        if (!columnParent) {
            return;
        }

        // 根据方向执行移动
        if (direction === 'first') {
            // 移到最左：移到容器最前面
            if (currentIndex === 0) {
                return; // 已经在最左
            }
            const firstColumnParent = allColumns[0].parentElement;
            if (firstColumnParent) {
                containerNode.insertBefore(columnParent, firstColumnParent);
            }
        } else if (direction === 'last') {
            // 移到最右：移到容器最后面
            if (currentIndex === allColumns.length - 1) {
                return; // 已经在最右
            }
            containerNode.appendChild(columnParent);
        } else if (direction === 'left') {
            // 向左移动：移到前一列之前
            if (currentIndex === 0) {
                return; // 已经是第一列
            }
            const targetIndex = currentIndex - 1;
            const targetColumn = allColumns[targetIndex];
            if (!targetColumn) {
                return;
            }
            const targetParent = targetColumn.parentElement;
            if (!targetParent) {
                return;
            }
            // 如果两个元素的父节点相同，说明 DOM 结构有问题
            if (columnParent === targetParent) {
                console.error('DOM 结构异常：两个列在同一个父容器中');
                return;
            }
            containerNode.insertBefore(columnParent, targetParent);
        } else { // direction === 'right'
            // 向右移动：移到后一列之后
            if (currentIndex === allColumns.length - 1) {
                return; // 已经是最后一列
            }
            const targetIndex = currentIndex + 1;
            const targetColumn = allColumns[targetIndex];
            if (!targetColumn) {
                return;
            }
            const targetParent = targetColumn.parentElement;
            if (!targetParent) {
                return;
            }
            // 如果两个元素的父节点相同，说明 DOM 结构有问题
            if (columnParent === targetParent) {
                console.error('DOM 结构异常：两个列在同一个父容器中');
                return;
            }
            // 如果目标列的外层 div 有下一个兄弟节点，插入到它之前；否则追加到末尾
            if (targetParent.nextSibling) {
                containerNode.insertBefore(columnParent, targetParent.nextSibling);
            } else {
                containerNode.appendChild(columnParent);
            }
        }

        // 同步 DOM 顺序到 columnsData 和 URL
        syncColumnOrder();
    };

    // 删除列
    const deleteColumn = (columnId: string): void => {
        const columnData = columnsData.get(columnId);
        if (!columnData) {
            return;
        }

        // 在删除前先判断是否是base列（用于后续判断是否需要重新计算差分）
        const deletedIsBase = isBaseColumn(columnId);

        // 清理 LMF 实例（如果存在）
        if (columnData.lmfInstance) {
            columnData.lmfInstance.destroy();
            columnData.lmfInstance = undefined;
        }

        // 列编辑模式时直接删除，不需要确认弹窗
        // 移除 DOM 元素
        const columnElement = container.select(`[data-column-id="${columnId}"]`);
        columnElement.remove();

        // 从 columnsData 中删除
        columnsData.delete(columnId);

        // 更新 URL
        syncStateToURL();

        // 更新按钮状态
        updateEditButtonsState();
        
        // 更新模型差分模式可用性
        updateModelDiffModeAvailability();

        // 如果在模型差分模式下且删除的是base列，重新计算差分数据
        if (modelDiffMode && deletedIsBase) {
            recalculateAllDiffStats();
            
            // 重新渲染所有列的统计图表和指标，并更新 LMF 实例的差分模式
            columnsData.forEach((columnData, id) => {
                if (columnData.stats) {
                    const resultModel = columnData.data.result.model;
                    updateMetricsForColumn(id, columnData.stats, resultModel);
                    renderStatsForColumn(id, columnData);
                }
                
                // 更新 LMF 实例的差分模式（如果存在）
                if (columnData.lmfInstance) {
                    const isDiffColumn = columnData.diffStats && !isBaseColumn(id);
                    if (isDiffColumn && columnData.diffStats) {
                        columnData.lmfInstance.setDiffMode(true, columnData.diffStats.deltaByteSurprisals);
                    } else {
                        columnData.lmfInstance.setDiffMode(false, []);
                    }
                }
            });
        }
    };

    // 绑定列操作按钮事件（使用事件委托）
    container.on('click', function(event) {
        // 非编辑模式下不处理
        if (!editMode) {
            return;
        }
        
        const target = event.target as HTMLElement;
        if (!target) {
            return;
        }

        // 使用 closest 来查找按钮元素（处理点击文本节点的情况）
        const moveToFirstBtn = target.closest('.move-to-first-btn');
        const moveLeftBtn = target.closest('.move-left-btn');
        const moveRightBtn = target.closest('.move-right-btn');
        const moveToLastBtn = target.closest('.move-to-last-btn');
        const deleteBtn = target.closest('.delete-btn');
        
        // 如果点击的是禁用按钮，不处理
        if (moveToFirstBtn && (moveToFirstBtn as HTMLElement).hasAttribute('disabled')) {
            return;
        }
        if (moveLeftBtn && (moveLeftBtn as HTMLElement).hasAttribute('disabled')) {
            return;
        }
        if (moveRightBtn && (moveRightBtn as HTMLElement).hasAttribute('disabled')) {
            return;
        }
        if (moveToLastBtn && (moveToLastBtn as HTMLElement).hasAttribute('disabled')) {
            return;
        }

        const columnElement = target.closest('.compare-column');
        if (!columnElement) {
            return;
        }

        const columnId = columnElement.getAttribute('data-column-id');
        if (!columnId) {
            return;
        }

        if (moveToFirstBtn) {
            moveColumn(columnId, 'first');
        } else if (moveLeftBtn) {
            moveColumn(columnId, 'left');
        } else if (moveRightBtn) {
            moveColumn(columnId, 'right');
        } else if (moveToLastBtn) {
            moveColumn(columnId, 'last');
        } else if (deleteBtn) {
            deleteColumn(columnId);
        }
    });

    // 绑定按钮事件
    const editModeToggleBtn = d3.select('#edit_mode_toggle');
    const clearBtn = d3.select('#clear_demos_btn');
    const addBtn = d3.select('#add_demos_btn');
    const showTextRenderToggle = d3.select<HTMLInputElement, any>('#show_text_render_toggle');
    const modelDiffModeToggle = d3.select<HTMLInputElement, any>('#model_diff_mode_toggle');

    editModeToggleBtn.on('click', () => {
        toggleEditMode(); // 切换编辑模式（内部会更新 editMode 状态）
        editModeToggleBtn.text(editMode ? tr('Finish editing') : tr('Edit'));
        // 添加/移除 finish-edit 类来改变按钮样式
        editModeToggleBtn.classed('finish-edit', editMode);
    });

    clearBtn.on('click', () => {
        if (columnsData.size === 0) {
            showAlertDialog(tr('Info'), tr('No demos to compare'));
            return;
        }
        clearAllColumns();
    });

    addBtn.on('click', () => {
        showDemoSelectorDialog();
    });

    // 绑定"显示文本渲染" checkbox 事件
    showTextRenderToggle.on('change', function() {
        const checkbox = this as HTMLInputElement;
        showTextRender = checkbox.checked;
        updateTextRenderVisibility();
        // 更新URL以反映状态变化
        syncStateToURL();
    });

    // 绑定模型差分模式 checkbox 事件
    modelDiffModeToggle.on('change', function() {
        const checkbox = this as HTMLInputElement;
        if (checkbox.checked) {
            enableModelDiffMode();
        } else {
            disableModelDiffMode();
        }
    });

    // 包装 addSingleColumn，添加列后更新按钮状态
    const wrappedAddSingleColumn = async (demoPath: string): Promise<void> => {
        await addSingleColumn(demoPath);
        updateEditButtonsState();
        // addSingleColumn 内部的 loadDemoForColumn 会调用 updateModelDiffModeAvailability
        // 这里不需要重复调用
    };

    // 初始化国际化（跟随首页设置）
    initI18n();
    document.title = tr(document.title);

    // 启动
    initializeColumns().then(() => {
        updateEditButtonsState();
        updateShowTextRenderCheckbox(); // 初始化"显示文本渲染"checkbox状态
        // initializeColumns 内部会调用 updateModelDiffModeAvailability
        
        // 从URL恢复模型差分模式checkbox状态（始终同步，不管是否有demos）
        const modelDiffModeCheckbox = d3.select<HTMLInputElement, any>('#model_diff_mode_toggle').node();
        if (modelDiffModeCheckbox) {
            modelDiffModeCheckbox.checked = modelDiffMode;
        }
        
        // 如果有demo且模型差分模式开启，启用模型差分模式功能
        if (modelDiffMode && columnsData.size > 0) {
            enableModelDiffMode();
        }
        
        // 从URL恢复文本渲染显示状态（始终同步checkbox状态）
        const showTextRenderCheckbox = d3.select<HTMLInputElement, any>('#show_text_render_toggle').node();
        if (showTextRenderCheckbox) {
            showTextRenderCheckbox.checked = showTextRender;
        }
        
        // 更新文本渲染显示（如果状态为true）
        if (showTextRender) {
            updateTextRenderVisibility();
        }
    });
};

