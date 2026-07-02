import {VComponent} from "./VisComponent";
import {FrontendAnalyzeResult} from "../../shared/api/GLTR_API";
import {D3Sel, calculateSurprisal, calculateSurprisalDensity, buildCharToByteIndexMap} from "../core/Util";
import {SimpleEventHandler} from "../core/SimpleEventHandler";
import * as d3 from "d3";
import {RenderAnimator, TokenRenderTask} from "./RenderAnimator";
import {HighlightManager, type CharIntervalUnderlineSeg} from "./HighlightManager";
import {SvgOverlayManager} from "./SvgOverlayManager";
import {TokenPositionCalculator} from "./TokenPositionCalculator";
import {ResizeHandler} from "./ResizeHandler";
import {TokenFragmentRect, HighlightStyle} from "./types";
import { waitForSmoothScrollEnd } from '../core/waitForSmoothScrollEnd';
import { CHUNK_SEARCH_FOLLOW_VIEWPORT_Y_RATIO, HIGHLIGHT_CONSTANTS } from './constants';
import {ScrollbarMinimap} from "./ScrollbarMinimap";
import {isNarrowScreen} from "../core/responsive";
import {getTokenRenderStyle} from "../cross/tokenRenderStyle";
import { getInfoDensityRenderDisabled } from "../../features/analysis/infoDensityRenderManager";
import type { FrontendToken } from "../../shared/api/GLTR_API";

/**
 * 从 CSS 变量读取 minimap 宽度
 */
function getMinimapWidthFromCSS(): number {
    const value = getComputedStyle(document.documentElement)
        .getPropertyValue('--minimap-width')
        .trim();

    if (!value) {
        console.warn('CSS 变量 --minimap-width 未定义，使用默认值 12px');
        return 12;
    }

    // 解析 "12px" 格式，提取数字
    const match = value.match(/^(\d+(?:\.\d+)?)px$/);
    if (match) {
        return parseFloat(match[1]);
    }

    console.warn(`CSS 变量 --minimap-width 格式无效: "${value}"，使用默认值 12px`);
    return 12;
}

export enum GLTR_Mode {
    fract_p
}

/** tokenData：信息密度模式为 FrontendToken，Semantic analysis 模式下附加 rawScoreNormed */
export type TokenDataForRender = FrontendToken & { rawScoreNormed?: number };

/** 语义模式下的 Tooltip 展示字段 */
export type SemanticRenderFields = {
    pwScore?: number;
    /** 信号概率 P_pw：x<=threshold 为 0，x>threshold 为 1 */
    signalProb?: number;
    rawScoreNormed?: number;
    /** 语义 / 归因着色时的原始 score（未归一化） */
    rawScore?: number;
    chunkIndex?: number;
    chunkMatchDegree?: number;
};

export type GLTR_RenderItem = {
    tokenData: TokenDataForRender;
    /** 语义分析模式下的展示字段（从 tokenData 提取，供 Tooltip 使用） */
    semantic?: SemanticRenderFields;
};
export type GLTR_HoverEvent = { hovered: boolean, d: GLTR_RenderItem, event?: MouseEvent }

/** {@link GLTR_Text_Box.events.tokenClicked} 的 detail（仅索引；原文与 offsets 由宿主通过 {@link GLTR_Text_Box.getCurrentAnalyzeResult} 再解析） */
export type GLTR_TokenClickEvent = {
    tokenIndex: number;
};

/** 从 token 中安全提取语义展示字段，无需类型断言 */
function extractSemanticFields(token: TokenDataForRender): SemanticRenderFields | undefined {
    const rawScoreNormed = "rawScoreNormed" in token && typeof token.rawScoreNormed === "number" ? token.rawScoreNormed : undefined;
    if (rawScoreNormed === undefined) return undefined;
    return { rawScoreNormed };
}

export class GLTR_Text_Box extends VComponent<FrontendAnalyzeResult> {
    protected _current = {
        maxValue: -1,
        highlightedIndices: new Set<number>(),  // 存储需要高亮的token索引
        highlightStyle: 'border' as 'border' | 'underline',  // 当前高亮样式
        /** match score chunk：Unicode 半开区间 [x0,x1)，与 DOM Range 一致 */
        chunkCharRange: null as { x0: number; x1: number } | null,
        // 差分渲染相关
        diffMode: false,  // 是否启用差分渲染模式
        deltaByteSurprisals: [] as number[],  // 逐字节的Δ信息密度(bits/Byte)
        charToByteIndexMap: [] as number[],  // 字符索引到字节索引的映射表
    };
    protected css_name = "LMF";
    protected options = {
        gltrMode: GLTR_Mode.fract_p,
        diffScale: d3.scalePow<string>().exponent(.3).range(["#b4e876", "#fff"]),
        fracScale: d3.scaleLinear<string>().domain([0, 15]).range(["#fff", "#ff8080"]),
        // 渲染动画配置
        enableRenderAnimation: false,  // 是否启用渲染动画（默认关闭，只在分析场景启用）
        // Minimap 配置
        enableMinimap: false,  // 是否启用 minimap（默认关闭）
        minimapWidth: getMinimapWidthFromCSS(),  // minimap 宽度（像素），从 CSS 变量读取
        // Semantic analysis 模式：为 true 时按 raw score normed 染色
        semanticAnalysisMode: false,
        /** 可选：底色映射上限（bits）；与 SVG 所用 classic/density 路径一致，见 overlayTokenRenderStyle */
        surprisalColorMax: undefined as number | undefined,
        /** 若设置则仅覆盖 SVG 底色的 density/classic；未设置则与全局 getTokenRenderStyle() 一致 */
        overlayTokenRenderStyle: undefined as 'density' | 'classic' | undefined,
        /** 为 true 时 SVG 底色不受全局「关闭信息密度」影响（如 Chat 需始终显示 token surprisal 底色） */
        overlayIgnoreGlobalInfoDensityDisable: false,
        /**
         * 为 true 时本实例始终不画信息密度/classic 底层（透明），不受全局开关与 overlayIgnoreGlobalInfoDensityDisable 影响。
         * 用于仅展示语义叠加层（如归因页）而无需伪造 real_topk。
         */
        overlayForceDisableInfoDensityRender: false,
        /**
         * 全量路径重建 `.text-layer` 并完成 SVG / minimap 等后续步骤后调用（布局变化触发的重绘亦同）。
         * 用于宿主挂载依赖 text-layer DOM 的装饰（如归因 ghost pill）。
         */
        onFullTextLayerRenderComplete: undefined as (() => void) | undefined,
    };

    /** SVG 信息密度/classic 底色是否应关闭（透明） */
    private getOverlayDisableInfoDensityRender(): boolean {
        if (this.options.overlayForceDisableInfoDensityRender) {
            return true;
        }
        if (this.options.overlayIgnoreGlobalInfoDensityDisable) {
            return false;
        }
        return getInfoDensityRenderDisabled();
    }

    /**
     * 获取当前主题模式（日间/夜间）
     */
    private getThemeMode(): 'light' | 'dark' {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        return isDark ? 'dark' : 'light';
    }
    
    // 渲染动画器（可选功能，不影响主干代码）
    private renderAnimator?: RenderAnimator;
    
    // 保存动画延迟配置
    private animationDelay: number = 100;
    
    // 保存当前渲染数据，用于主题切换时重新渲染
    private currentRenderData?: FrontendAnalyzeResult;
    
    // 保存当前SVG元素的引用，用于位置更新
    private currentSvgOverlay?: SVGSVGElement;

    /** 渲染版本号：每次 _render 调用递增，用于避免 chunk 模式下多次快速 update 导致的异步竞态（过时渲染的 appendChild 覆盖新渲染） */
    private _renderVersion = 0;
    
    // Resize处理器
    private resizeHandler?: ResizeHandler;

    // Token位置计算器
    private positionCalculator?: TokenPositionCalculator;

    /** chunk 模式增量渲染：缓存上次全量计算的 positions，文本变化或布局变化时清空 */
    private cachedPositions?: TokenFragmentRect[];
    private cachedPositionsText?: string;
    private cachedPositionsTokenCount: number = 0;
    /** 缓存时的容器宽度，用于检测布局变化 */
    private cachedContainerWidth: number = 0;

    // SVG覆盖层管理器
    private svgOverlayManager?: SvgOverlayManager;
    
    // 高亮管理器
    private highlightManager?: HighlightManager;
    private chunkScrollEndCancel: (() => void) | undefined;
    private chunkHighlightHoldTimer: number | undefined;
    /** 分块语义搜索：用户已手动滚动，后续不再自动跟随 */
    private chunkSearchAutoScrollUserCancelled = false;
    private chunkSearchAutoScrollCleanup: (() => void) | undefined;
    
    // 下划线元素缓存，用于第二个直方图的高亮样式（由HighlightManager管理，但需要在这里初始化）
    private underlineCache: Map<string, SVGLineElement> = new Map();
    
    // Minimap 管理器
    private minimapManager?: ScrollbarMinimap;

    private _refreshBaseRectColorsOrFullRender = (): void => {
        if (this.svgOverlayManager && this.currentRenderData) {
            const rectCount = this.svgOverlayManager.getRectCache().size;
            const tokenCount = this.currentRenderData.bpe_strings.length;
            // 无语义数据时 SVG 可能只创建了少量 rect，updateBaseRectColors 无法覆盖全部 token，需强制全量重渲染
            if (rectCount < tokenCount) {
                this.reRenderCurrent(true);
                return;
            }
            this.svgOverlayManager.updateBaseRectColors(this.currentRenderData, {
                disableInfoDensityRender: this.getOverlayDisableInfoDensityRender(),
                tokenRenderStyle: this.options.overlayTokenRenderStyle ?? getTokenRenderStyle(),
            });
        } else {
            this.reRenderCurrent(true);
        }
    };
    private _onTokenRenderStyleChange = (): void => this._refreshBaseRectColorsOrFullRender();
    private _onInfoDensityRenderChange = (): void => this._refreshBaseRectColorsOrFullRender();
    private _onSurprisalColorWeakenChange = (): void => {
        this._refreshBaseRectColorsOrFullRender();
        if (this.options.enableMinimap && this.cachedPositions && this.currentRenderData) {
            this.renderMinimap(this.cachedPositions, this.currentRenderData).catch(err => {
                console.error('Minimap渲染出错:', err);
            });
        }
    };

    static events = {
        tokenHovered: 'lmf-view-token-hovered',
        /** 点击某个 token（信息密度视图归因入口等） */
        tokenClicked: 'lmf-view-token-clicked',
    };

    /**
     * 与当前屏上渲染一致的分析结果（含 originalText、bpe_strings offsets）。
     * 归因等场景在点击后再取此值解析 context，避免在 tokenClicked 事件中携带整份 {@link FrontendAnalyzeResult}。
     */
    getCurrentAnalyzeResult(): FrontendAnalyzeResult | null {
        const rd = (this.currentRenderData ?? this.renderData) as FrontendAnalyzeResult | undefined;
        if (!rd?.bpe_strings?.length) return null;
        return rd;
    }

    /** 全量 text-layer 渲染完成且本帧未被更新的渲染抢占时通知宿主 */
    private notifyFullTextLayerRenderCompleteIfCurrent(myVersion: number): void {
        if (myVersion !== this._renderVersion) return;
        this.options.onFullTextLayerRenderComplete?.();
    }

    constructor(parent: D3Sel, eventHandler?: SimpleEventHandler, options = {}) {
        super(parent, eventHandler);
        this.superInitHTML(options);
        this._init();
        
        // 始终初始化渲染动画器（懒加载模式）
        // 通过 RenderAnimator 的 enabled 选项控制是否执行动画
        // 这样可以在运行时动态开启/关闭动画，而不需要重新创建对象
        this.animationDelay = 100;  // 控制渲染速度：值越大，每批之间的延迟越长，渲染越慢
        this.renderAnimator = new RenderAnimator({
            enabled: this.options.enableRenderAnimation,  // 根据当前选项设置初始状态
            delayBetweenBatches: this.animationDelay,
        });
        
        // 监听主题变化
        this.setupThemeListener();
        window.addEventListener('token-render-style-change', this._onTokenRenderStyleChange);
        window.addEventListener('info-density-render-change', this._onInfoDensityRenderChange);
        window.addEventListener('surprisal-color-weaken-change', this._onSurprisalColorWeakenChange);

        // 初始化颜色scale
        this.updateColorScales();

        // 初始化 minimap CSS类
        this.syncMinimapEnabledClass();
    }

    protected _init() {
        // 创建加载遮罩层
        this.createLoadingOverlay();
    }

    /**
     * 创建加载遮罩层
     */
    private createLoadingOverlay(): void {
        const baseNode = this.base.node();
        if (!baseNode) return;

        // 检查是否已存在遮罩层
        if (baseNode.querySelector('.text-loading-overlay')) {
            return;
        }

        const overlay = document.createElement('div');
        overlay.className = 'text-loading-overlay';
        overlay.innerHTML = `
            <div class="loading-content">
                <div class="loading-spinner"></div>
            </div>
        `;
        baseNode.appendChild(overlay);
    }


    protected _render(rd: FrontendAnalyzeResult = this.renderData): void {
        if (!rd) return;

        this._renderVersion++;
        // 保存当前渲染数据
        this.currentRenderData = rd;

        // 语义分析模式由配置决定，不在此处根据数据覆盖

        // 如果差分模式已启用，更新字符到字节的映射表（使用最新的原始文本）
        if (this._current.diffMode && this._current.deltaByteSurprisals.length > 0) {
            const originalText = rd.originalText;
            this._current.charToByteIndexMap = buildCharToByteIndexMap(originalText);
        }

        // 隐藏加载状态
        this.hideLoading();

        // 使用SVG覆盖层方案：在文本下方添加SVG层显示token背景色
        // 注意：_renderWithSvgOverlay是async，但这里不等待，让动画在后台进行
        this._renderWithSvgOverlay(rd).catch(err => {
            console.error('SVG渲染出错:', err);
        });
    }

    /**
     * SVG覆盖层方案：在文本下方添加SVG层显示token背景色
     * 不修改文本DOM，性能更好（O(n)复杂度）
     */
    protected async _renderWithSvgOverlay(rd: FrontendAnalyzeResult): Promise<void> {
        const myVersion = this._renderVersion;

        const rdExt = rd as FrontendAnalyzeResult & {
            rawScoresNormed?: (number | undefined)[];
            colorScores?: number[];
            chunkInfos?: Array<{ startOffset: number }>;
        };
        const rawScoresNormed = rdExt.rawScoresNormed;
        const colorScores = (rdExt.colorScores?.length ? rdExt.colorScores : undefined) ?? rawScoresNormed;
        const isSemantic = this.options.semanticAnalysisMode && colorScores?.length;

        // 增量路径：文本和布局不变时仅更新语义颜色；仅 **chunk 流式** 在文末追加 token 时允许「变多 + append」。
        // digit merge 开关会改变合并段前后整条链的 tokenIndex / offset：变少或变多都不能沿用旧 rect 前缀，
        // 否则非数字段的颜色也会错位（手动全量刷新才恢复）。
        const baseNodeForCheck = this.base.node();
        const svgInDOM = !!(this.currentSvgOverlay?.parentNode);
        const isChunkedSemantic = Boolean(rdExt.chunkInfos?.length);
        const nTok = rd.bpe_strings.length;
        const cachedTok = this.cachedPositionsTokenCount;
        const sameTokenCount = nTok === cachedTok;
        const chunkAppendOnly =
            isChunkedSemantic && nTok > cachedTok;
        const canReuseSvgForIncremental = sameTokenCount || chunkAppendOnly;
        const canIncremental =
            isSemantic &&
            this.currentSvgOverlay &&
            svgInDOM &&
            this.cachedPositions &&
            this.svgOverlayManager &&
            canReuseSvgForIncremental &&
            rd.originalText === this.cachedPositionsText &&
            baseNodeForCheck != null &&
            baseNodeForCheck.clientWidth === this.cachedContainerWidth;

        if (canIncremental) {
            // Step 1: 更新置灰边界（cheap DOM 操作，color 不影响布局）
            this.updateTruncatedBoundary(rd);
            // 置灰边界变化会改变 textNode/span 内容，导致 TokenPositionCalculator 的 textNodeIndex 失效，必须重置
            this.positionCalculator?.resetIndex();

            // Step 2: token 数增长时追加新 token rect
            // 文本未变（canIncremental 已验证），无需 resetIndex，直接只算新 token
            if (rd.bpe_strings.length > this.cachedPositionsTokenCount) {
                const prevTokenCount = this.cachedPositionsTokenCount;
                const newPositions = this.positionCalculator!.calculateTokenPositions(rd, prevTokenCount);
                this.svgOverlayManager!.appendTokenRects(newPositions, this.currentSvgOverlay!, rd);
                this.cachedPositions = [...(this.cachedPositions ?? []), ...newPositions];
                this.cachedPositionsTokenCount = rd.bpe_strings.length;
            }

            // Step 3: 更新本 chunk 范围内的语义颜色
            const latestChunk = rdExt.chunkInfos?.[rdExt.chunkInfos.length - 1];
            const fromTokenIndex = latestChunk
                ? Math.max(0, rd.bpe_strings.findIndex(t => t.offset[0] >= latestChunk.startOffset))
                : 0;
            this.svgOverlayManager!.updateSemanticColors(colorScores!, fromTokenIndex);

            // chunk 增量渲染路径也需要同步刷新 minimap，否则会出现刷新滞后
            if (this.cachedPositions && this.cachedPositions.length > 0) {
                await this.renderMinimap(this.cachedPositions, rd);
            }
            return;
        }

        // 全量渲染路径
        // 清除现有的可视化效果
        this.clearVisualization();

        // 设置容器文本（纯文本节点）
        this.setContainerText(rd);

        // 等待DOM更新，确保文本已渲染
        await new Promise(resolve => requestAnimationFrame(resolve));
        await new Promise(resolve => setTimeout(resolve, 10));

        if (myVersion !== this._renderVersion) return;

        const baseNode = this.base.node();
        if (!baseNode) return;
        
        if (!this.positionCalculator) {
            this.positionCalculator = new TokenPositionCalculator(baseNode);
        }

        const rdForPositions: FrontendAnalyzeResult = rd;
        let positions = this.positionCalculator.calculateTokenPositions(rdForPositions);
        if (isSemantic && rawScoresNormed?.length) {
            const chunkInfos = (rd as FrontendAnalyzeResult & { chunkInfos?: unknown[] }).chunkInfos;
            // 分块模式：不匹配 chunk 也渲染（底色 + tooltip）；整段模式保持原过滤
            if (!chunkInfos?.length) {
                positions = positions.filter((p) => rawScoresNormed[p.tokenIndex] !== undefined);
            }
        }

        if (positions.length === 0) {
            // 无 token（如请求开始时清空画布）是预期情况，不告警
            if (rd.bpe_strings.length > 0) {
                console.warn('⚠️ 没有有效的token位置');
            }
            this.notifyFullTextLayerRenderCompleteIfCurrent(myVersion);
            return;
        }

        const overlayOptions = {
            getTokenRealTopk: (r: FrontendAnalyzeResult, tokenIndex: number) => this.getTokenRealTopk(r, tokenIndex),
            addTokenEventListeners: (element: SVGGElement, tokenIndex: number, r: FrontendAnalyzeResult) => this.addTokenEventListeners(element, tokenIndex, r),
            tokenRenderStyle: this.options.overlayTokenRenderStyle ?? getTokenRenderStyle(),
            disableInfoDensityRender: this.getOverlayDisableInfoDensityRender(),
            diff: this._current.diffMode && this._current.deltaByteSurprisals.length > 0
                ? {
                    enabled: true,
                    deltaByteSurprisals: this._current.deltaByteSurprisals,
                    charToByteIndexMap: this._current.charToByteIndexMap,
                }
                : undefined,
            semantic: this.options.semanticAnalysisMode ? { analysisMode: true, rawScoresNormed: colorScores } : undefined,
            surprisalColorMax: this.options.surprisalColorMax,
        };
        this.svgOverlayManager = new SvgOverlayManager(baseNode, overlayOptions);

        const svg = this.svgOverlayManager.createSvgOverlay(positions, rdForPositions);

        // 初始化或更新高亮管理器（每次渲染时重新创建，因为SVG是新的）
        this.highlightManager = new HighlightManager(
            svg,
            this.svgOverlayManager.getRectCache(),
            this.underlineCache
        );

        // 若已有更新的渲染启动，跳过 appendChild，避免 chunk 模式下多次 update 导致 SVG 叠加
        if (myVersion !== this._renderVersion) return;

        this.currentSvgOverlay = svg;
        // 将SVG添加到容器（在文本节点之后）
        baseNode.appendChild(svg);

        // 写入位置缓存，供后续 chunk 增量更新复用
        this.cachedPositions = positions;
        this.cachedPositionsText = rd.originalText;
        this.cachedPositionsTokenCount = rd.bpe_strings.length;
        this.cachedContainerWidth = baseNode.clientWidth;

        // 初始化ResizeHandler（如果还没有初始化）
        this.setupResizeHandler();

        // 处理渲染动画
        if (this.renderAnimator && this.options.enableRenderAnimation) {
            await this.animateSvgRects(svg, positions);
        }

        // 渲染完成后，如果有高亮状态需要恢复，则恢复
        const delay = this.renderAnimator && this.options.enableRenderAnimation ? 200 : 0;
        if (this._current.chunkCharRange) {
            const { x0, x1 } = this._current.chunkCharRange;
            setTimeout(() => this.setChunkCharRangeHighlight(x0, x1), delay);
        } else if (this._current.highlightedIndices.size > 0) {
            setTimeout(() => {
                this.setHighlightedIndices(this._current.highlightedIndices, this._current.highlightStyle);
            }, delay);
        }
        
        // 渲染 Minimap
        await this.renderMinimap(positions, rd);
        this.notifyFullTextLayerRenderCompleteIfCurrent(myVersion);
    }

    /**
     * SVG rect动画：分批显示rect（渐显效果）
     * @param svg SVG元素
     * @param positions token位置数组
     */
    private async animateSvgRects(svg: SVGSVGElement, positions: TokenFragmentRect[]): Promise<void> {
        if (!this.renderAnimator) return;

        const totalTokens = positions.length;
        const initialBatchSize = 32;
        let currentIndex = 0;
        let currentBatchSize = initialBatchSize;

        // 初始状态：所有 rect（含语义叠加层）透明
        const rectCache = this.svgOverlayManager?.getRectCache();
        const overlayCache = this.svgOverlayManager?.getSemanticOverlayCache();
        if (rectCache) {
            rectCache.forEach(({ rect }) => rect.setAttribute('fill-opacity', '0'));
        }
        overlayCache?.forEach((rect) => rect.setAttribute('fill-opacity', '0'));

        // 第一批处理之前也添加延迟
        await new Promise(resolve => setTimeout(resolve, this.animationDelay));

        while (currentIndex < totalTokens) {
            const actualBatchSize = Math.min(currentBatchSize, totalTokens - currentIndex);
            for (let i = currentIndex; i < currentIndex + actualBatchSize; i++) {
                const rectKey = positions[i].rectKey;
                rectCache?.get(rectKey)?.rect?.setAttribute('fill-opacity', '1');
                overlayCache?.get(rectKey)?.setAttribute('fill-opacity', '1');
            }

            currentIndex += actualBatchSize;

            // 如果不是最后一批，等待一段时间再处理下一批
            if (currentIndex < totalTokens) {
                await new Promise(resolve => setTimeout(resolve, this.animationDelay));
                currentBatchSize = Math.floor(currentBatchSize * 1.5); // 批次大小乘以1.5，形成加速效果
            }
        }
    }


    /**
     * 计算已分析文本的截断边界，超出部分将灰显。
     * 优先级：语义分析 chunkInfos > 语义分析 rawScores > 信息密度 tokens
     */
    private computeTruncatedLength(
        tokens: Array<{ offset: [number, number] }>,
        rawScores?: (number | undefined)[],
        chunkInfos?: Array<{ startOffset: number; endOffset: number }>
    ): number {
        // 1. 语义分析分块模式：以最后一个 chunk 的 endOffset 为界
        if (chunkInfos?.length) {
            return chunkInfos[chunkInfos.length - 1]!.endOffset;
        }
        // 2. 语义分析整段模式：以最后一个有 rawScores 的 token 为界
        if (rawScores?.length && tokens.length > 0) {
            let lastIdx = -1;
            for (let i = rawScores.length - 1; i >= 0; i--) {
                if (rawScores[i] !== undefined) {
                    lastIdx = i;
                    break;
                }
            }
            if (lastIdx >= 0) return tokens[lastIdx]!.offset[1];
        }
        // 3. 信息密度模式：以 token 覆盖的末尾为界
        return tokens.length > 0 ? tokens[tokens.length - 1]!.offset[1] : 0;
    }

    /**
     * 仅更新置灰边界（truncated-text span 的起止位置），不重建 text-layer。
     * truncated-text 只改变 color，不影响布局，SVG positions 仍然有效。
     */
    private updateTruncatedBoundary(rd: FrontendAnalyzeResult): void {
        const baseNode = this.base.node();
        if (!baseNode) return;
        const textLayer = baseNode.querySelector('.text-layer') as HTMLElement | null;
        if (!textLayer) return;

        const rdExt = rd as FrontendAnalyzeResult & {
            rawScoresNormed?: (number | undefined)[];
            chunkInfos?: Array<{ startOffset: number; endOffset: number }>;
        };
        const truncatedLength = this.computeTruncatedLength(rd.bpe_strings, rdExt.rawScoresNormed, rdExt.chunkInfos);
        const fullText = rd.originalText;
        const isTruncated = truncatedLength < fullText.length;

        const textNode = textLayer.firstChild;
        if (textNode && textNode.nodeType === Node.TEXT_NODE) {
            const expected = isTruncated ? fullText.slice(0, truncatedLength) : fullText;
            if (textNode.textContent !== expected) textNode.textContent = expected;
        }

        const span = textLayer.querySelector('.truncated-text') as HTMLElement | null;
        const remaining = isTruncated ? fullText.slice(truncatedLength) : '';
        if (remaining) {
            if (span) {
                if (span.textContent !== remaining) span.textContent = remaining;
            } else {
                const newSpan = document.createElement('span');
                newSpan.className = 'truncated-text';
                newSpan.textContent = remaining;
                textLayer.appendChild(newSpan);
            }
        } else if (span) {
            span.remove();
        }
    }

    /**
     * 当容器为空时，设置容器的文本内容
     * 这适用于正常的GLTR组件使用场景
     * 创建一个连续的文本节点，这样findNodeAndOffset才能正确工作
     */
    private setContainerText(rd: FrontendAnalyzeResult): void {
        const baseNode = this.base.node();
        if (!baseNode) return;

        // 清除所有现有内容
        while (baseNode.firstChild) {
            baseNode.removeChild(baseNode.firstChild);
        }

        const fullText = rd.originalText;
        if (!fullText) {
            if (baseNode) {
                if (!this.positionCalculator) {
                    this.positionCalculator = new TokenPositionCalculator(baseNode);
                } else {
                    this.positionCalculator.resetIndex();
                }
            }
            return;
        }

        const textContainer = document.createElement('div');
        textContainer.className = 'text-layer';
        textContainer.style.position = 'relative';
        textContainer.style.zIndex = '2';

        const tokens = rd.bpe_strings;
        const rawScores = (
            rd as FrontendAnalyzeResult & {
                rawScoresNormed?: (number | undefined)[];
            }
        ).rawScoresNormed;
        const chunkInfos = (rd as FrontendAnalyzeResult & { chunkInfos?: Array<{ startOffset: number; endOffset: number }> }).chunkInfos;
        const truncatedLength = this.computeTruncatedLength(tokens, rawScores, chunkInfos);
        const isTruncated = truncatedLength < fullText.length;

        if (isTruncated) {
            textContainer.appendChild(document.createTextNode(fullText.slice(0, truncatedLength)));
            const span = document.createElement('span');
            span.className = 'truncated-text';
            span.textContent = fullText.slice(truncatedLength);
            textContainer.appendChild(span);
        } else {
            textContainer.appendChild(document.createTextNode(fullText));
        }

        baseNode.appendChild(textContainer);

        if (baseNode) {
            if (!this.positionCalculator) {
                this.positionCalculator = new TokenPositionCalculator(baseNode);
            } else {
                this.positionCalculator.resetIndex();
            }
        }
    }

    /**
     * 仅显示文本内容，不渲染颜色标记
     * 用于在等待后端返回时立即显示文本，提升用户体验
     * @param text 要显示的文本内容
     */
    public setTextOnly(text: string): void {
        const baseNode = this.base.node();
        if (!baseNode) return;

        // 文本切换（如 demo 切换）期间先清空 minimap，避免显示旧数据
        if (this.options.enableMinimap && this.minimapManager) {
            this.minimapManager.clear();
        }

        // 保存遮罩层
        const existingOverlay = baseNode.querySelector('.text-loading-overlay');

        // 清除所有现有内容（包括之前的可视化效果）
        while (baseNode.firstChild) {
            baseNode.removeChild(baseNode.firstChild);
        }

        // 重置增量渲染缓存，避免下次 _renderWithSvgOverlay 误走增量路径（SVG 已脱离 DOM）
        this.currentSvgOverlay = undefined;
        this.cachedPositions = undefined;
        this.cachedPositionsText = undefined;
        this.cachedPositionsTokenCount = 0;
        this.cachedContainerWidth = 0;
        this.svgOverlayManager?.clearRectCache();

        // 创建一个文本容器div，确保文本在SVG上方
        if (text) {
            const textContainer = document.createElement('div');
            textContainer.className = 'text-layer';
            textContainer.style.position = 'relative';
            textContainer.style.zIndex = '2';
            const textNode = document.createTextNode(text);
            textContainer.appendChild(textNode);
            baseNode.appendChild(textContainer);
        }

        // 重新添加遮罩层（确保在最后，这样z-index才能正确工作）
        if (existingOverlay) {
            baseNode.appendChild(existingOverlay);
        } else {
            this.createLoadingOverlay();
        }

        // 显示加载状态
        this.showLoading();
    }

    /**
     * 显示加载状态
     */
    public showLoading(): void {
        const baseNode = this.base.node();
        if (!baseNode) return;

        // 添加loading类到容器
        baseNode.classList.add('loading');

        // 显示遮罩层
        const overlay = baseNode.querySelector('.text-loading-overlay') as HTMLElement;
        if (overlay) {
            overlay.classList.add('visible');
        }
    }

    /**
     * 隐藏加载状态
     */
    public hideLoading(): void {
        const baseNode = this.base.node();
        if (!baseNode) return;

        // 移除loading类
        baseNode.classList.remove('loading');

        // 隐藏遮罩层
        const overlay = baseNode.querySelector('.text-loading-overlay') as HTMLElement;
        if (overlay) {
            overlay.classList.remove('visible');
        }
    }

    /**
     * 清除现有的可视化效果
     */
    private clearVisualization(): void {
        const baseNode = this.base.node();
        if (baseNode) {
            // 移除SVG覆盖层
            const svgOverlay = baseNode.querySelector('.svg-overlay');
            if (svgOverlay) {
                svgOverlay.remove();
            }
            
            // 清理SVG引用
            this.currentSvgOverlay = undefined;

            // 清空位置缓存（SVG 已销毁，缓存失效）
            this.cachedPositions = undefined;
            this.cachedPositionsText = undefined;
            this.cachedPositionsTokenCount = 0;
            this.cachedContainerWidth = 0;

            // 清空rect缓存
            this.svgOverlayManager?.clearRectCache();
            
            // 清空下划线缓存
            this.underlineCache.clear();

            // 可视化重建前清空 minimap，避免旧缩略图短暂残留
            if (this.options.enableMinimap && this.minimapManager) {
                this.minimapManager.clear();
            }
            
            // 确保遮罩层存在（如果被意外清除，重新创建）
            if (!baseNode.querySelector('.text-loading-overlay')) {
                this.createLoadingOverlay();
            }
        }
    }
    
    /**
     * 设置ResizeHandler，监听容器大小变化并更新SVG rect位置
     */
    private setupResizeHandler(): void {
        // 如果已经设置了，就不重复设置
        if (this.resizeHandler) {
            return;
        }
        
        const baseNode = this.base.node();
        if (!baseNode) return;
        
        // 创建ResizeHandler
        this.resizeHandler = new ResizeHandler(baseNode, {
            onPositionUpdate: () => this.updateSvgPositions(),
            getCurrentSvg: () => this.currentSvgOverlay,
            onTransitionStart: () => {
                // 快速resize过渡开始时隐藏minimap
                if (this.options.enableMinimap && this.minimapManager) {
                    this.minimapManager.hide();
                }
            },
        });
        
        // 开始监听
        this.resizeHandler.setup();
    }
    
    /**
     * 更新SVG rect的位置和大小
     * 当容器大小变化或文本重新布局时调用
     */
    private updateSvgPositions(): void {
        if (!this.currentSvgOverlay || !this.currentRenderData) {
            return;
        }

        const baseNode = this.base.node();
        if (!baseNode) return;
        
        // 重新计算所有token的位置
        if (!this.positionCalculator) {
            this.positionCalculator = new TokenPositionCalculator(baseNode);
        }
        const positions = this.positionCalculator.calculateTokenPositions(this.currentRenderData);
        
        if (positions.length === 0) {
            return;
        }

        // 如果片段数量发生变化，重新完整渲染以保持同步
        if (!this.svgOverlayManager || this.svgOverlayManager.hasMissingRects(positions)) {
            this._renderWithSvgOverlay(this.currentRenderData).catch(err => {
                console.error('SVG渲染出错:', err);
            });
            return;
        }
        
        // 更新SVG rect的位置和大小
        this.svgOverlayManager.updateSvgPositions(this.currentSvgOverlay, positions);

        // 同步更新位置缓存和容器宽度，下次 chunk 更新可继续走增量路径
        this.cachedPositions = positions;
        this.cachedPositionsText = this.currentRenderData.originalText;
        this.cachedPositionsTokenCount = this.currentRenderData.bpe_strings.length;
        this.cachedContainerWidth = baseNode.clientWidth;

        // 更新下划线位置（如果存在）
        this.highlightManager?.updateUnderlinePositions();

        this.refreshChunkCharRangeUnderlines();

        // 重新渲染minimap以同步更新
        if (this.options.enableMinimap && this.minimapManager) {
            this.renderMinimap(positions, this.currentRenderData).catch(err => {
                console.error('Minimap渲染出错:', err);
            });
        }
    }


    // calculateTokenPositions, buildTextNodeIndex, findNodeAndOffset 方法已移至 TokenPositionCalculator


    // createSvgOverlay 方法已移至 SvgOverlayManager

    // getColorForSurprisal 方法已移至 SvgOverlayManager（通过 getSurprisalColor 直接调用）
    
    /**
     * 用当前数据重新渲染（如切换 token render style 后立即生效）
     * @param forceFullRender 为 true 时清除增量缓存，强制走全量路径（用于 disableInfoDensity/tokenRenderStyle 等选项变更，chunk 模式下也需重建 rect）
     */
    public reRenderCurrent(forceFullRender = false): void {
        if (!this.currentRenderData) return;
        if (forceFullRender) {
            this.cachedPositions = undefined;
            this.cachedPositionsText = undefined;
            this.cachedPositionsTokenCount = 0;
            this.cachedContainerWidth = 0;
        }
        const wasAnimation = this.options.enableRenderAnimation;
        this.options.enableRenderAnimation = false;
        this._render(this.currentRenderData);
        setTimeout(() => { this.options.enableRenderAnimation = wasAnimation; }, 0);
    }

    /**
     * 更新颜色scale（根据当前主题）
     * 仿照SurprisalColorConfig的逻辑，适配夜间模式
     */
    private updateColorScales(): void {
        const theme = this.getThemeMode();
        
        // 更新fracScale：惊讶度颜色，从浅色到红色
        // 日间模式: #fff -> #ff8080
        // 夜间模式: #191919 -> #ff8080 (仿照getSurprisalColor的逻辑)
        const fracStartColor = theme === 'dark' ? "#191919" : "#fff";
        this.options.fracScale.range([fracStartColor, "#ff8080"]);
        
        // 更新diffScale：差分模式，从绿色到中性色
        // 日间模式: #b4e876 -> #fff
        // 夜间模式: #b4e876 -> #191919
        const diffEndColor = theme === 'dark' ? "#191919" : "#fff";
        this.options.diffScale.range(["#b4e876", diffEndColor]);
    }
    
    /**
     * 设置主题变化监听器
     * 仅更新 fracScale/diffScale；重渲染由 initThemeManager 的 onThemeChange -> rerenderOnThemeChange 统一触发
     */
    private setupThemeListener(): void {
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                if (mutation.type === 'attributes' && mutation.attributeName === 'data-theme') {
                    this.updateColorScales();
                }
            });
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
    }

    /**
     * 获取指定token的真实概率信息
     */
    private getTokenRealTopk(rd: FrontendAnalyzeResult, tokenIndex: number): [number, number] | undefined {
        const token = rd.bpe_strings[tokenIndex];
        return token.real_topk
            ? token.real_topk as [number, number]
            : undefined;
    }

    /**
     * 为token元素添加事件监听器
     * 支持SVGGElement（group方案）
     */
    private addTokenEventListeners(element: SVGGElement, tokenIndex: number, rd: FrontendAnalyzeResult): void {
        const tokenData = rd.bpe_strings[tokenIndex] as TokenDataForRender;
        // 语义信息可能是异步补齐/缓存命中后才可用；tooltip 的语义字段必须在 hover 时基于最新数据计算
        const computeSemantic = (): SemanticRenderFields | undefined => {
            // 用最新渲染数据（而不是闭包里的 rd），避免首次渲染时 semantic ext 不全导致 tooltip 永远拿不到语义匹配信息
            const latestRd = this.currentRenderData ?? rd;
            const latestExt = latestRd as FrontendAnalyzeResult & {
                rawScoresNormed?: number[];
                tokenRawScores?: number[];
                pPwValues?: number[];
                pwScores?: number[];
            };

            const rawScoresNormed = latestExt.rawScoresNormed;
            const hasRawScoresNormedNow = rawScoresNormed?.length && tokenIndex < rawScoresNormed.length;

            let semantic = extractSemanticFields(tokenData);
            if (hasRawScoresNormedNow && rawScoresNormed) {
                // rawScoreNormed 始终用 rawScoresNormed，与 color source 无关
                const attnScore = rawScoresNormed[tokenIndex];
                const rawScore = latestExt.tokenRawScores?.[tokenIndex];
                const signalProb = latestExt.pPwValues?.[tokenIndex];  // P_pw：x<=threshold 为 0，x>threshold 为 1
                const pwScore = latestExt.pwScores?.[tokenIndex];

                const tokenOffset =
                    latestRd.bpeBpeMergedTokens?.[tokenIndex]?.offset ?? latestRd.bpe_strings[tokenIndex]?.offset;
                const rdChunkInfos = (latestRd as FrontendAnalyzeResult & {
                    chunkInfos?: Array<{ startOffset: number; endOffset: number; chunkIndex?: number; chunkMatchDegree?: number }>;
                }).chunkInfos;
                const chunkInfo = tokenOffset && rdChunkInfos?.find(
                    c => tokenOffset[0] >= c.startOffset && tokenOffset[0] < c.endOffset
                );

                semantic = {
                    ...semantic,
                    rawScoreNormed: attnScore,
                    rawScore,
                    signalProb,
                    pwScore,
                    chunkIndex: chunkInfo?.chunkIndex,
                    chunkMatchDegree: chunkInfo?.chunkMatchDegree,
                } as SemanticRenderFields;
            }
            return semantic;
        };

        const handleMouseEnter = (event: MouseEvent) => {
            // 按住主键拖动（框选）时不再弹出 tooltip，避免挡正文选中
            if ((event.buttons & 1) !== 0) return;
            this.eventHandler.trigger(GLTR_Text_Box.events.tokenHovered, <GLTR_HoverEvent>{
                hovered: true,
                d: { tokenData, semantic: computeSemantic() },
                event: event
            });
            // 移除 appendChild：Chrome 中移动 SVG 元素会导致 mouseleave 不触发，进而 tooltip 无法关闭
        };

        const handleMouseLeave = (event: MouseEvent) => {
            this.eventHandler.trigger(GLTR_Text_Box.events.tokenHovered, <GLTR_HoverEvent>{
                hovered: false,
                // hovered=false 时 tooltip 不会读取 semantic；避免在 mouseleave 上额外计算
                d: { tokenData, semantic: undefined },
                event: event
            });
        };

        /** 从当前 token 开始按下主键（框选起点）时立即收起 tooltip */
        const handleMouseDown = (event: MouseEvent) => {
            if (event.button !== 0) return;
            this.eventHandler.trigger(GLTR_Text_Box.events.tokenHovered, <GLTR_HoverEvent>{
                hovered: false,
                d: { tokenData, semantic: undefined },
                event: event
            });
        };

        element.addEventListener('mouseenter', handleMouseEnter);
        element.addEventListener('mouseleave', handleMouseLeave);
        element.addEventListener('mousedown', handleMouseDown);

        element.addEventListener('click', (event: MouseEvent) => {
            if (event.button !== 0) return;
            event.stopPropagation();
            this.eventHandler.trigger(GLTR_Text_Box.events.tokenClicked, <GLTR_TokenClickEvent>{
                tokenIndex,
            });
        });
    }
    
    /**
     * 渲染 Minimap
     */
    private async renderMinimap(positions: TokenFragmentRect[], rd: FrontendAnalyzeResult): Promise<void> {
        if (!this.options.enableMinimap) {
            return;
        }

        this.ensureMinimapManager();
        if (!this.minimapManager) return;

        // 统一入口：有位置则渲染，无位置则清空，避免切换数据源时残留旧 minimap
        if (positions.length === 0) {
            this.minimapManager.clear();
            return;
        }

        await this.minimapManager.render(positions, rd, {
            semanticAnalysisMode: this.options.semanticAnalysisMode,
            measureCharRangeY: (startOffset: number, endOffset: number) =>
                this.measureCharRangeY(startOffset, endOffset),
        });
    }

    private measureCharRangeY(startOffset: number, endOffset: number): { minY: number; maxY: number } | null {
        const baseNode = this.base.node();
        if (!baseNode || endOffset <= startOffset) return null;

        const calculator = this.positionCalculator ?? new TokenPositionCalculator(baseNode);
        const start = calculator.findNodeAndOffset(Math.max(0, startOffset));
        const end = calculator.findNodeAndOffset(Math.max(0, endOffset));
        if (!start || !end) return null;

        const range = document.createRange();
        range.setStart(start.node, start.offset);
        range.setEnd(end.node, end.offset);

        const containerRect = baseNode.getBoundingClientRect();
        const zoom = calculator.getZoom();
        let minY = Number.POSITIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        for (const rect of range.getClientRects()) {
            if (rect.width === 0 && rect.height === 0) continue;
            const top = (rect.top - containerRect.top) / zoom;
            const bottom = (rect.bottom - containerRect.top) / zoom;
            minY = Math.min(minY, top);
            maxY = Math.max(maxY, bottom);
        }
        return Number.isFinite(minY) && Number.isFinite(maxY) ? { minY, maxY } : null;
    }

    /**
     * 计算系统经典滚动条的宽度
     * 通过 right_panel 和 LMF 的宽度差来判断滚动条是否占用布局空间
     * @returns 滚动条宽度（px），如果为0则表示使用覆盖式滚动条或无滚动条
     */
    private calculateTraditionalScrollbarWidth(): number {
        const baseNode = this.base.node();
        if (!baseNode) {
            return 0;
        }

        const rightPanel = document.querySelector('.right_panel') as HTMLElement;
        if (!rightPanel) {
            return 0;
        }

        // right_panel 的 offsetWidth（包含滚动条，如果滚动条占用布局空间）
        const rightPanelWidth = rightPanel.offsetWidth;
        // LMF 的 offsetWidth（包含 padding 和 border，但不包含滚动条）
        const lmfWidth = baseNode.offsetWidth;
        // 计算滚动条宽度：right_panel 宽度 - LMF 宽度
        const scrollbarWidth = rightPanelWidth - lmfWidth;

        // 返回滚动条宽度（如果小于等于0，表示使用覆盖式滚动条或无滚动条）
        return scrollbarWidth > 0 ? scrollbarWidth : 0;
    }

    /**
     * 确保 minimap 管理器存在并配置正确
     */
    private ensureMinimapManager(): void {
        const baseNode = this.base.node();
        if (!baseNode) return;

        // 计算 minimap 宽度
        let minimapWidth: number = this.options.minimapWidth;

        if (!isNarrowScreen()) {
            // 宽屏模式：根据滚动条宽度设置 minimap 宽度
            const scrollbarWidth = this.calculateTraditionalScrollbarWidth();

            if (scrollbarWidth > 0) {
                // 传统滚动条，minimap 宽度设为滚动条宽度
                minimapWidth = scrollbarWidth;
            }

            // minimap 宽度稍微小一点，避免与滚动条重叠
            if (minimapWidth > 1) {
                minimapWidth -= 1;
            }
        }

        const config = {
            width: minimapWidth
        };

        if (!this.minimapManager) {
            this.minimapManager = new ScrollbarMinimap(baseNode, config);
        } else {
            this.minimapManager.updateOptions(config);
        }
    }

    /**
     * 同步 minimap 启用状态到 CSS 类
     */
    private syncMinimapEnabledClass(): void {
        const baseNode = this.base.node();
        if (baseNode) {
            baseNode.classList.toggle('minimap-enabled', this.options.enableMinimap);
        }
    }

    /**
     * 清理资源：停止ResizeHandler并清理定时器
     */
    destroy(): void {
        // 清理ResizeHandler
        if (this.resizeHandler) {
            this.resizeHandler.destroy();
            this.resizeHandler = undefined;
        }
        
        // 清理 Minimap
        if (this.minimapManager) {
            this.minimapManager.destroy();
            this.minimapManager = undefined;
        }
        
        // 清理SVG引用
        this.currentSvgOverlay = undefined;
        window.removeEventListener('token-render-style-change', this._onTokenRenderStyleChange);
        window.removeEventListener('info-density-render-change', this._onInfoDensityRenderChange);
        window.removeEventListener('surprisal-color-weaken-change', this._onSurprisalColorWeakenChange);

        // 调用父类的destroy方法
        super.destroy();
    }

    protected _wrangle(data: FrontendAnalyzeResult) {
        const tokens = data.bpe_strings;
        const allTop1 = tokens
            .map(token => token.pred_topk.length > 0 ? token.pred_topk[0][1] : null)
            .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));

        if (allTop1.length === 0) {
            // pred_topk 为空是正常情况（例如内存优化策略跳过 TopK 计算），静默处理
            this._current.maxValue = 0;
            this.options.diffScale.domain([0, 1]);
            return data;
        }

        const maxTop1 = d3.max(allTop1);
        this._current.maxValue = maxTop1 ?? 0;
        this.options.diffScale.domain([0, this._current.maxValue || 1]);

        return data;
    }

    /**
     * 重写 updateOptions 方法，同步更新 RenderAnimator 的 enabled 状态和 minimap CSS类
     */
    updateOptions(options: any, reRender = false) {
        // 如果更新了 enableRenderAnimation，同步更新 renderAnimator 的 enabled 状态
        if (options.hasOwnProperty('enableRenderAnimation') && this.renderAnimator) {
            this.renderAnimator.setEnabled(options.enableRenderAnimation);
        }

        // 保存之前的enableMinimap状态，用于判断是否需要创建/销毁minimap
        const previousEnableMinimap = this.options.enableMinimap;

        // 调用父类方法更新选项
        super.updateOptions(options, reRender);

        // 如果更新了 enableMinimap，同步更新CSS类并创建/销毁minimap
        if (options.hasOwnProperty('enableMinimap')) {
            this.syncMinimapEnabledClass();
            
            // 如果有渲染数据，需要创建或销毁minimap
            if (this.currentRenderData && this.positionCalculator) {
                if (this.options.enableMinimap && !previousEnableMinimap) {
                    // 从false变为true：创建并渲染minimap
                    const positions = this.positionCalculator.calculateTokenPositions(this.currentRenderData);
                    if (positions.length > 0) {
                        this.renderMinimap(positions, this.currentRenderData).catch(err => {
                            console.error('Minimap渲染出错:', err);
                        });
                    }
                } else if (!this.options.enableMinimap && previousEnableMinimap && this.minimapManager) {
                    // 从true变为false：销毁minimap
                    this.minimapManager.destroy();
                    this.minimapManager = undefined;
                }
            }
            return;
        }

        // 统一兜底：其他 option 变更若触发重渲染，也同步刷新 minimap，避免分支遗漏
        if (this.options.enableMinimap && this.minimapManager && this.currentRenderData && this.positionCalculator) {
            const positions = this.positionCalculator.calculateTokenPositions(this.currentRenderData);
            this.renderMinimap(positions, this.currentRenderData).catch(err => {
                console.error('Minimap渲染出错:', err);
            });
        }
    }

    private cancelChunkHighlightFade(): void {
        this.chunkScrollEndCancel?.();
        this.chunkScrollEndCancel = undefined;
        if (this.chunkHighlightHoldTimer !== undefined) {
            window.clearTimeout(this.chunkHighlightHoldTimer);
            this.chunkHighlightHoldTimer = undefined;
        }
        this.highlightManager?.cancelCharIntervalFade();
    }

    /**
     * chunk 点击：Unicode 半开区间 [x0,x1) 下划线（DOM Range → 与直方图 token 高亮互斥）
     */
    setChunkCharRangeHighlight(x0: number, x1: number): void {
        const x0i = Math.max(0, Math.floor(x0));
        const x1i = Math.max(0, Math.floor(x1));
        if (x1i <= x0i) {
            this._current.chunkCharRange = null;
            this.highlightManager?.clearCharIntervalUnderlines();
            return;
        }

        this._current.chunkCharRange = { x0: x0i, x1: x1i };
        this._current.highlightedIndices.clear();

        if (!this.highlightManager) {
            setTimeout(() => this.setChunkCharRangeHighlight(x0i, x1i), 50);
            return;
        }

        const segments = this.computeCharIntervalUnderlineSegments(x0i, x1i);
        this.highlightManager.setCharIntervalUnderlines(segments);
    }

    /** 分块语义搜索开始：wheel / 触摸即视为用户接管滚动 */
    beginChunkSearchAutoScroll(): void {
        this.endChunkSearchAutoScroll();
        this.chunkSearchAutoScrollUserCancelled = false;

        const container = isNarrowScreen()
            ? window
            : (document.querySelector('.right_panel') as HTMLElement | null);
        if (!container) return;

        const opts = { passive: true, capture: true } as const;
        const onUserScroll = () => {
            if (this.chunkSearchAutoScrollUserCancelled) return;
            this.chunkSearchAutoScrollUserCancelled = true;
            this.chunkScrollEndCancel?.();
            this.chunkScrollEndCancel = undefined;
        };

        container.addEventListener('wheel', onUserScroll, opts);
        container.addEventListener('touchstart', onUserScroll, opts);
        this.chunkSearchAutoScrollCleanup = () => {
            container.removeEventListener('wheel', onUserScroll, opts);
            container.removeEventListener('touchstart', onUserScroll, opts);
        };
    }

    endChunkSearchAutoScroll(): void {
        this.chunkSearchAutoScrollCleanup?.();
        this.chunkSearchAutoScrollCleanup = undefined;
        this.chunkSearchAutoScrollUserCancelled = false;
    }

    /** 滚到 chunk 起点（分析结束、直方图 bin 点击，视口 0.2） */
    scrollToChunkStart(charOffset: number, onScrollEnd?: () => void): void {
        this.scrollToUnicodeCharOffset(Math.max(0, Math.floor(charOffset)), onScrollEnd);
    }

    /** 分块语义搜索进行中：滚动跟随当前 chunk 起点（视口 0.6） */
    followSearchingChunk(charOffset: number): void {
        if (this.chunkSearchAutoScrollUserCancelled) return;
        this.scrollToUnicodeCharOffset(
            Math.max(0, Math.floor(charOffset)),
            undefined,
            CHUNK_SEARCH_FOLLOW_VIEWPORT_Y_RATIO
        );
    }

    /**
     * semantic match per chunk：高亮区间 → 滚到 chunk 起点 → 滚完保持 → 淡出
     */
    jumpToChunkHighlight(x0: number, x1: number): void {
        this.cancelChunkHighlightFade();
        this.setChunkCharRangeHighlight(x0, x1);
        const x0i = Math.max(0, Math.floor(x0));
        this.scrollToChunkStart(x0i, () => {
            this.chunkHighlightHoldTimer = window.setTimeout(() => {
                this.chunkHighlightHoldTimer = undefined;
                this.fadeCurrentChunkHighlight();
            }, HIGHLIGHT_CONSTANTS.CHUNK_HIGHLIGHT_HOLD_MS);
        });
    }

    private fadeCurrentChunkHighlight(): void {
        if (!this._current.chunkCharRange || !this.highlightManager) return;
        const fadeMs = HIGHLIGHT_CONSTANTS.CHUNK_HIGHLIGHT_FADE_MS;
        this.highlightManager.fadeOutCharIntervalUnderlines(fadeMs, () => {
            this._current.chunkCharRange = null;
        });
    }

    /** DOM 矩形（视口）→ SVG overlay 下划线一段；坐标与 TokenPositionCalculator 一致 */
    private static clientRectToUnderlineSeg(
        r: DOMRectReadOnly,
        containerRect: DOMRectReadOnly,
        zoom: number
    ): CharIntervalUnderlineSeg {
        return {
            x1: (r.left - containerRect.left) / zoom,
            x2: (r.right - containerRect.left) / zoom,
            y: (r.bottom - containerRect.top) / zoom,
        };
    }

    private computeCharIntervalUnderlineSegments(x0: number, x1: number): CharIntervalUnderlineSeg[] {
        const baseNode = this.base.node();
        if (!baseNode) {
            throw new Error('[GLTR_Text_Box] chunk 下划线：缺少 base 节点');
        }
        if (x1 <= x0) return [];

        const calculator = this.positionCalculator ?? new TokenPositionCalculator(baseNode);
        const a = calculator.findNodeAndOffset(x0);
        const b = calculator.findNodeAndOffset(x1);
        if (!a || !b) {
            throw new Error(
                `[GLTR_Text_Box] chunk 下划线：无法将 Unicode 半开区间 [${x0}, ${x1}) 映射到文本节点`
            );
        }

        const range = document.createRange();
        range.setStart(a.node, a.offset);
        range.setEnd(b.node, b.offset);

        const cr = baseNode.getBoundingClientRect();
        const z = calculator.getZoom();
        const toSeg = (box: DOMRectReadOnly) => GLTR_Text_Box.clientRectToUnderlineSeg(box, cr, z);

        const segments: CharIntervalUnderlineSeg[] = [];
        for (const r of range.getClientRects()) {
            if (r.width !== 0 || r.height !== 0) {
                segments.push(toSeg(r));
            }
        }
        if (segments.length === 0) {
            throw new Error(
                `[GLTR_Text_Box] chunk 下划线 [${x0}, ${x1})：` +
                    'Range.getClientRects() 未产生任何有效矩形（不做包围盒回退）'
            );
        }
        return segments;
    }

    private refreshChunkCharRangeUnderlines(): void {
        const c = this._current.chunkCharRange;
        if (!c || !this.highlightManager) return;
        this.highlightManager.updateCharIntervalUnderlines(
            this.computeCharIntervalUnderlineSegments(c.x0, c.x1)
        );
    }

    /**
     * 滚动至 Unicode 偏移；桌面滚动 `.right_panel`，窄屏为 `window`
     * @param viewportYRatio 目标点在视口中的纵向位置（0=顶部，1=底部），默认 0.2
     */
    scrollToUnicodeCharOffset(charOffset: number, onScrollEnd?: () => void, viewportYRatio = 0.2): void {
        this.chunkScrollEndCancel?.();
        this.chunkScrollEndCancel = undefined;

        requestAnimationFrame(() => {
            const baseNode = this.base.node();
            if (!baseNode) {
                onScrollEnd?.();
                return;
            }

            const calculator = this.positionCalculator ?? new TokenPositionCalculator(baseNode);
            const safeOffset = Math.max(0, Math.floor(charOffset));
            const found = calculator.findNodeAndOffset(safeOffset);
            if (!found) {
                onScrollEnd?.();
                return;
            }

            const range = document.createRange();
            range.setStart(found.node, found.offset);
            range.collapse(true);

            let rect = range.getBoundingClientRect();
            if (rect.width === 0 && rect.height === 0) {
                const rects = range.getClientRects();
                if (!rects.length) {
                    onScrollEnd?.();
                    return;
                }
                rect = rects[0];
            }

            if (isNarrowScreen()) {
                const y = window.scrollY + rect.top - window.innerHeight * viewportYRatio;
                window.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
                if (onScrollEnd) {
                    this.chunkScrollEndCancel = waitForSmoothScrollEnd(window, onScrollEnd);
                }
                return;
            }

            const panel = document.querySelector('.right_panel') as HTMLElement | null;
            if (!panel) {
                onScrollEnd?.();
                return;
            }

            const panelRect = panel.getBoundingClientRect();
            const topInPanel = rect.top - panelRect.top + panel.scrollTop;
            const target = topInPanel - panel.clientHeight * viewportYRatio;
            const maxScroll = Math.max(0, panel.scrollHeight - panel.clientHeight);
            panel.scrollTo({ top: Math.max(0, Math.min(target, maxScroll)), behavior: 'smooth' });
            if (onScrollEnd) {
                this.chunkScrollEndCancel = waitForSmoothScrollEnd(panel, onScrollEnd);
            }
        });
    }

    /**
     * 设置需要高亮的token索引
     * @param indices 需要高亮的token索引集合
     * @param highlightStyle 高亮样式：'border' 使用边框，'underline' 使用下划线
     */
    setHighlightedIndices(indices: Set<number>, highlightStyle: HighlightStyle = 'border') {
        this.cancelChunkHighlightFade();
        this._current.chunkCharRange = null;
        this._current.highlightedIndices = indices;
        this._current.highlightStyle = highlightStyle;
        
        if (!this.highlightManager) {
            // 如果高亮管理器未初始化，延迟执行
            setTimeout(() => {
                this.setHighlightedIndices(indices, highlightStyle);
            }, 50);
            return;
        }

        this.highlightManager.setHighlightedIndices(indices, highlightStyle);
    }

    /**
     * 清除所有高亮
     */
    clearHighlight() {
        this.cancelChunkHighlightFade();
        this._current.highlightedIndices.clear();
        this._current.chunkCharRange = null;

        if (this.highlightManager) {
            this.highlightManager.clearHighlight();
        }
    }

    /**
     * 设置差分渲染模式和数据
     * @param enabled 是否启用差分模式
     * @param deltaByteSurprisals 逐字节的Δ信息密度(bits/Byte)
     */
    setDiffMode(enabled: boolean, deltaByteSurprisals: number[] = []) {
        this._current.diffMode = enabled;
        this._current.deltaByteSurprisals = deltaByteSurprisals;
        
        // 如果有当前渲染数据，构建字符索引到字节索引的映射表并重新渲染
        if (this.currentRenderData) {
            // 构建字符索引到字节索引的映射表
            // 使用当前渲染数据的原始文本
            const originalText = this.currentRenderData.originalText;
            this._current.charToByteIndexMap = buildCharToByteIndexMap(originalText);
            
            // 差分模式切换时禁用动画
            const originalAnimationSetting = this.options.enableRenderAnimation;
            this.options.enableRenderAnimation = false;
            this._render(this.currentRenderData);
            setTimeout(() => {
                this.options.enableRenderAnimation = originalAnimationSetting;
            }, 100);
        }
    }


}