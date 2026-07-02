/**
 * SVG覆盖层管理器
 * 负责创建和管理SVG覆盖层，包括rect元素的创建、位置更新等
 */

import {FrontendAnalyzeResult} from "../../shared/api/GLTR_API";
import {calculateSurprisal, calculateSurprisalDensity} from "../core/Util";
import {getByteSurprisalColor, getTokenSurprisalColor, getDiffColor, getSemanticSimilarityColor} from "../cross/SurprisalColorConfig";
import { getSurprisalRenderMaxAlpha } from "../../features/analysis/surprisalColorWeakenManager";
import {TokenFragmentRect, RectCacheEntry, ZERO_WIDTH_FRAGMENT_PLACEHOLDER_PX} from "./types";

/** 差分模式配置 */
export interface DiffOverlayOptions {
    enabled: boolean;
    deltaByteSurprisals: number[];
    charToByteIndexMap: number[];
}

/** 语义分析模式配置 */
export interface SemanticOverlayOptions {
    analysisMode: boolean;
    /** 查询匹配时每 token 的 raw score normed [0,1] */
    rawScoresNormed?: number[];
}

export interface SvgOverlayManagerOptions {
    /** 获取token的真实概率信息 */
    getTokenRealTopk: (rd: FrontendAnalyzeResult, tokenIndex: number) => [number, number] | undefined;
    /** 添加token事件监听器 */
    addTokenEventListeners: (element: SVGGElement, tokenIndex: number, rd: FrontendAnalyzeResult) => void;
    /** 染色方式：density=信息密度(bits/Byte)，classic=token信息量(bits)。默认 classic */
    tokenRenderStyle?: 'density' | 'classic';
    /** 为 true 时关闭信息密度/classic 底色（语义叠加层不受影响） */
    disableInfoDensityRender?: boolean;
    /** 差分模式配置 */
    diff?: DiffOverlayOptions;
    /** 语义分析模式配置 */
    semantic?: SemanticOverlayOptions;
    /**
     * 可选：覆盖底色映射上限（与全站默认 18 / 6 不同）。
     * classic：token surprisal（bits）；density：信息密度（bits/Byte）。例如 Chat 固定为 2。
     */
    surprisalColorMax?: number;
}

export class SvgOverlayManager {
    private rectCache: Map<string, RectCacheEntry> = new Map();
    /** 语义分析叠加层 rect 缓存（与 base rect 同位置，用于 resize 时同步更新） */
    private semanticOverlayCache: Map<string, SVGRectElement> = new Map();
    private baseNode: HTMLElement;
    private options: SvgOverlayManagerOptions;

    constructor(baseNode: HTMLElement, options: SvgOverlayManagerOptions) {
        this.baseNode = baseNode;
        this.options = options;
    }

    /**
     * 创建SVG覆盖层
     * @param positions token位置数组
     * @param rd 分析结果数据
     * @returns SVG元素
     */
    createSvgOverlay(positions: TokenFragmentRect[], rd: FrontendAnalyzeResult): SVGSVGElement {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'svg-overlay');

        // 获取容器尺寸，设置SVG的viewBox和尺寸
        // 使用clientWidth/clientHeight，与 TokenPositionCalculator 输出的坐标系一致
        // （TokenPositionCalculator 已在源头处理了 zoom 转换）
        const containerWidth = this.baseNode.clientWidth || this.baseNode.offsetWidth || 800;
        const containerHeight = this.baseNode.clientHeight || this.calculateContainerHeight(positions);


        // 设置SVG尺寸和viewBox（使用像素单位，确保rect位置正确）
        svg.setAttribute('width', containerWidth.toString());
        svg.setAttribute('height', containerHeight.toString());
        svg.setAttribute('viewBox', `0 0 ${containerWidth} ${containerHeight}`);
        svg.setAttribute('preserveAspectRatio', 'none');

        // 设置SVG样式
        svg.style.position = 'absolute';
        svg.style.top = '0';
        svg.style.left = '0';
        svg.style.width = '100%';
        svg.style.height = '100%';
        svg.style.pointerEvents = 'none';
        svg.style.zIndex = '1';
        

        // 清空rect缓存（重新创建时）
        this.rectCache.clear();
        this.semanticOverlayCache.clear();

        // 按tokenIndex分组positions
        const positionsByToken = this.groupPositionsByToken(positions);

        // 为每个token创建一个group，包含该token的所有fragment rect
        positionsByToken.forEach((tokenPositions, tokenIndex) => {
            const group = this.createTokenGroup(svg, tokenPositions, tokenIndex, rd);
            svg.appendChild(group);
        });

        return svg;
    }

    /**
     * 更新SVG rect的位置和大小
     * @param svg SVG元素
     * @param positions token位置数组
     */
    updateSvgPositions(svg: SVGSVGElement, positions: TokenFragmentRect[]): void {
        // 更新SVG的viewBox和尺寸
        const containerWidth = this.baseNode.clientWidth || 0;
        const containerHeight = this.baseNode.clientHeight || this.calculateContainerHeight(positions);

        svg.setAttribute('width', containerWidth.toString());
        svg.setAttribute('height', containerHeight.toString());
        svg.setAttribute('viewBox', `0 0 ${containerWidth} ${containerHeight}`);

        // 更新每个rect的位置和大小
        // 不需要缩放转换，因为 TokenPositionCalculator 已在源头处理了 zoom
        // 宽度见 displayWidth（零宽 Range 在 SVG 中需要占位宽；与 DAG 测量的过滤策略不同）
        positions.forEach(pos => {
            const x = Math.max(0, pos.x);
            const y = Math.max(0, pos.y);
            const width = Math.max(1, this.displayWidth(pos));
            const height = Math.max(1, pos.height);
            const attrs = { x, y, width, height };

            const cacheEntry = this.rectCache.get(pos.rectKey);
            if (cacheEntry?.rect) {
                Object.entries(attrs).forEach(([k, v]) => cacheEntry.rect.setAttribute(k, v.toString()));
            }
            const overlayRect = this.semanticOverlayCache.get(pos.rectKey);
            if (overlayRect) {
                Object.entries(attrs).forEach(([k, v]) => overlayRect.setAttribute(k, v.toString()));
            }
        });
    }

    /**
     * 获取rect缓存
     */
    getRectCache(): Map<string, RectCacheEntry> {
        return this.rectCache;
    }

    /** 获取语义叠加层 rect 缓存（用于动画等） */
    getSemanticOverlayCache(): Map<string, SVGRectElement> {
        return this.semanticOverlayCache;
    }

    /**
     * 追加新 token 的 rect 到现有 SVG，不重建已有结构。
     * 用于 chunk 模式下 token 数量增长时的增量追加。
     */
    appendTokenRects(newPositions: TokenFragmentRect[], svg: SVGSVGElement, rd: FrontendAnalyzeResult): void {
        const positionsByToken = this.groupPositionsByToken(newPositions);
        positionsByToken.forEach((tokenPositions, tokenIndex) => {
            const group = this.createTokenGroup(svg, tokenPositions, tokenIndex, rd);
            svg.appendChild(group);
        });
    }

    /**
     * 更新 base rect（信息密度/classic 底色）颜色，不重建 SVG。
     * 用于 Disable info density / token render style 切换时，增量路径下刷新底色。
     */
    updateBaseRectColors(
        rd: FrontendAnalyzeResult,
        overrides: { disableInfoDensityRender: boolean; tokenRenderStyle: 'density' | 'classic' }
    ): void {
        this.rectCache.forEach(({ rect, tokenIndex }, rectKey) => {
            const color = this.computeBaseRectColor(rectKey, tokenIndex, rd, overrides);
            rect.setAttribute('fill', color);
            rect.setAttribute('data-target-color', color);
        });
    }

    /**
     * 仅更新语义叠加层颜色，不重建 SVG 结构。
     * 用于 chunk 模式下每次 score 更新时的增量渲染。
     * 利用 rectKey 命名约定（tokenIndex-fragmentIndex），只遍历 fromTokenIndex 之后的 rect。
     * @returns 实际更新的 rect 数量（用于验证日志）
     */
    updateSemanticColors(rawScoresNormed: (number | undefined)[], fromTokenIndex = 0): number {
        let count = 0;
        for (let tokenIndex = fromTokenIndex; tokenIndex < rawScoresNormed.length; tokenIndex++) {
            const score = rawScoresNormed[tokenIndex];
            const color = score !== undefined ? getSemanticSimilarityColor(score) : 'transparent';
            for (let i = 0; ; i++) {
                const rectKey = `${tokenIndex}-${i}`;
                const overlayRect = this.semanticOverlayCache.get(rectKey);
                if (!overlayRect) break;
                overlayRect.setAttribute('fill', color);
                overlayRect.setAttribute('data-target-color', color);
                count++;
            }
        }
        return count;
    }

    /**
     * 清空rect缓存
     */
    clearRectCache(): void {
        this.rectCache.clear();
        this.semanticOverlayCache.clear();
    }

    /**
     * 检查是否有缺失的rect（用于判断是否需要重新渲染）
     */
    hasMissingRects(positions: TokenFragmentRect[]): boolean {
        return positions.some(pos => !this.rectCache.has(pos.rectKey)) ||
               positions.length !== this.rectCache.size;
    }

    /**
     * 计算容器高度
     */
    private calculateContainerHeight(positions: TokenFragmentRect[]): number {
        const textLayer = this.baseNode.querySelector('.text-layer') as HTMLElement;
        const containerRect = this.baseNode.getBoundingClientRect();
        
        // 计算所有token的最大底部位置（重复逻辑提取）
        const maxTokenBottom = positions.length > 0
            ? Math.max(...positions.map(p => p.y + p.height))
            : 0;

        if (textLayer) {
            // 使用文本层的实际高度（包括padding）
            const textLayerRect = textLayer.getBoundingClientRect();
            return Math.max(
                textLayerRect.height || 0,
                maxTokenBottom,
                this.baseNode.clientHeight || 0
            );
        } else {
            // 如果没有文本层，使用所有token的最大y + height，或者容器的scrollHeight
            return Math.max(
                maxTokenBottom,
                this.baseNode.scrollHeight || 0,
                this.baseNode.clientHeight || 0,
                containerRect.height || 0,
                600
            );
        }
    }

    /**
     * 按tokenIndex分组positions
     */
    private groupPositionsByToken(positions: TokenFragmentRect[]): Map<number, TokenFragmentRect[]> {
        const positionsByToken = new Map<number, TokenFragmentRect[]>();
        positions.forEach(pos => {
            if (!positionsByToken.has(pos.tokenIndex)) {
                positionsByToken.set(pos.tokenIndex, []);
            }
            positionsByToken.get(pos.tokenIndex)!.push(pos);
        });
        return positionsByToken;
    }

    /**
     * 创建token group
     */
    private createTokenGroup(
        svg: SVGSVGElement,
        tokenPositions: TokenFragmentRect[],
        tokenIndex: number,
        rd: FrontendAnalyzeResult
    ): SVGGElement {
        const group = document.createElementNS('http://www.w3.org/2000/svg', 'g');
        group.setAttribute('data-token-index', tokenIndex.toString());
        group.setAttribute('class', 'token-group');
        group.style.pointerEvents = 'auto';
        group.style.cursor = 'pointer';

        tokenPositions.forEach(pos => {
            const rect = this.createRect(pos, tokenIndex, rd);
            group.appendChild(rect);
            // 语义分析模式：在信息密度之上叠加语义高亮（黄色渐变）
            const sem = this.options.semantic;
            if (sem?.analysisMode) {
                const overlayRect = this.createSemanticOverlayRect(pos, tokenIndex, rd);
                group.appendChild(overlayRect);
            }
        });

        this.options.addTokenEventListeners(group, tokenIndex, rd);

        return group;
    }

    /**
     * 计算 base rect 底色（与 createRect 共用逻辑，供 updateBaseRectColors 复用）
     */
    private computeBaseRectColor(
        _rectKey: string,
        tokenIndex: number,
        rd: FrontendAnalyzeResult,
        overrides?: { disableInfoDensityRender: boolean; tokenRenderStyle: 'density' | 'classic' }
    ): string {
        const disableInfoDensityRender = overrides?.disableInfoDensityRender ?? this.options.disableInfoDensityRender;
        const tokenRenderStyle = overrides?.tokenRenderStyle ?? this.options.tokenRenderStyle ?? 'classic';

        if (this.options.diff?.enabled && this.options.diff.deltaByteSurprisals.length > 0) {
            const diff = this.options.diff;
            const tokenData = rd.bpe_strings[tokenIndex];
            const offset = tokenData.offset;
            const charStart = offset[0];
            const charEnd = offset[1];
            const charToByteIndexMap = diff.charToByteIndexMap;
            const deltaByteSurprisals = diff.deltaByteSurprisals;
            const tokenByteDeltas: number[] = [];

            if (!charToByteIndexMap.length) return getDiffColor(0);
            const byteStart = charToByteIndexMap[charStart] ?? charStart;
            const byteEnd = charToByteIndexMap[charEnd] ?? charEnd;
            for (let byteIdx = byteStart; byteIdx < byteEnd && byteIdx < deltaByteSurprisals.length; byteIdx++) {
                tokenByteDeltas.push(deltaByteSurprisals[byteIdx]);
            }
            const avgDelta = tokenByteDeltas.length > 0
                ? tokenByteDeltas.reduce((sum, val) => sum + val, 0) / tokenByteDeltas.length
                : 0;
            return getDiffColor(avgDelta);
        }
        if (disableInfoDensityRender) return 'transparent';
        const tokenData = rd.bpe_strings[tokenIndex];
        const cap = this.options.surprisalColorMax;
        const maxAlpha = getSurprisalRenderMaxAlpha();
        if (tokenRenderStyle === 'classic') {
            const topk = this.options.getTokenRealTopk(rd, tokenIndex);
            const surprisal = topk != null ? calculateSurprisal(topk[1]) : 0;
            return getTokenSurprisalColor(surprisal, undefined, cap, maxAlpha);
        }
        return getByteSurprisalColor(calculateSurprisalDensity(tokenData), 1, undefined, cap, maxAlpha);
    }

    /**
     * 创建rect元素
     */
    private createRect(
        pos: TokenFragmentRect,
        tokenIndex: number,
        rd: FrontendAnalyzeResult
    ): SVGRectElement {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        this.setRectGeometry(rect, pos);

        // 设置token索引和片段信息
        rect.setAttribute('data-token-index', pos.tokenIndex.toString());
        rect.setAttribute('data-fragment-index', pos.fragmentIndex.toString());
        rect.setAttribute('data-rect-key', pos.rectKey);

        // 缓存rect引用，避免后续querySelector查询
        this.rectCache.set(pos.rectKey, { rect, tokenIndex: pos.tokenIndex });

        const color = this.computeBaseRectColor(pos.rectKey, pos.tokenIndex, rd);
        // 设置填充颜色
        rect.setAttribute('fill', color);
        rect.setAttribute('data-target-color', color); // 保存目标颜色，用于动画

        // rect的pointer-events由group控制，这里不需要单独设置
        rect.style.pointerEvents = 'auto';

        return rect;
    }

    /**
     * 创建语义分析叠加层 rect（黄色渐变，叠加在信息密度之上）
     * 与 createRect 保持一致的 rect 属性和动画支持
     */
    private createSemanticOverlayRect(
        pos: TokenFragmentRect,
        tokenIndex: number,
        rd: FrontendAnalyzeResult
    ): SVGRectElement {
        const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
        const sem = this.options.semantic!;
        const score = sem.rawScoresNormed![tokenIndex];
        const color = score !== undefined ? getSemanticSimilarityColor(score) : 'transparent';

        this.setRectGeometry(rect, pos);
        rect.setAttribute('data-token-index', pos.tokenIndex.toString());
        rect.setAttribute('data-fragment-index', pos.fragmentIndex.toString());
        rect.setAttribute('data-rect-key', pos.rectKey);
        rect.setAttribute('fill', color);
        rect.setAttribute('data-target-color', color);
        rect.style.pointerEvents = 'auto';

        this.semanticOverlayCache.set(pos.rectKey, rect);
        return rect;
    }

    /** 设置 rect 的几何属性（与 createRect 共用，保持一致性） */
    private setRectGeometry(rect: SVGRectElement, pos: TokenFragmentRect): void {
        const x = Math.max(0, pos.x);
        const y = Math.max(0, pos.y);
        const width = Math.max(1, this.displayWidth(pos));
        const height = Math.max(1, pos.height);
        rect.setAttribute('x', x.toString());
        rect.setAttribute('y', y.toString());
        rect.setAttribute('width', width.toString());
        rect.setAttribute('height', height.toString());
        rect.setAttribute('rx', '6');
        rect.setAttribute('ry', '6');
    }

    /**
     * GLTR SVG 底色需要可读的最小矩形宽。Range 对某些片段（典型为换行、以及 WebKit/iOS 的换行幽灵片）
     * 会给出 width=0；SvgOverlay 必须把零宽扩成占位宽才可画。
     * DAG 测量的纠正在 `genAttributeDagTextMeasure.ts`：非纯换行 token 会跳过 width=0 的幽灵片以对齐 DAG。
     */
    private displayWidth(pos: TokenFragmentRect): number {
        return pos.width > 0 ? pos.width : ZERO_WIDTH_FRAGMENT_PLACEHOLDER_PX;
    }
}

