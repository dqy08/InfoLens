import { getByteSurprisalColor, getSemanticSimilarityColor, MINIMAP_COLOR_FACTOR, SEMANTIC_MINIMAP_COLOR_FACTOR } from '../cross/SurprisalColorConfig';
import { isNarrowScreen } from '../core/responsive';
import { calculateSurprisalDensity, isFiniteNumber } from '../core/Util';
import type { TokenFragmentRect } from './types';
import type { FrontendAnalyzeResult } from '../../shared/api/GLTR_API';

/**
 * Minimap 配置选项
 */
export interface MinimapOptions {
    width?: number; // canvas 宽度（像素），默认 12px
}

/**
 * 聚合结果，包含行数据和统计信息
 */
interface AggregationResult {
    buckets: BucketData[];
}

/**
 * 桶数据
 */
interface BucketData {
    y: number;
    surprisalDensitySum: number;
    TokenFragmentCount: number;
}

type MinimapRenderData = FrontendAnalyzeResult & {
    chunkInfos?: Array<{
        startOffset: number;
        endOffset: number;
        chunkMatchDegree: number;
    }>;
};

interface MinimapRenderOptions {
    semanticAnalysisMode?: boolean;
    measureCharRangeY?: (startOffset: number, endOffset: number) => { minY: number; maxY: number } | null;
}

/**
 * 滚动条 Minimap 类
 * 在文本渲染区右侧绘制每一行的平均惊讶度，与滚动条对齐
 */
export class ScrollbarMinimap {
    private canvas: HTMLCanvasElement;
    private portal: HTMLElement; // Portal 容器，添加到 body
    private container: HTMLElement;
    private options: MinimapOptions;

    constructor(container: HTMLElement, options: MinimapOptions) {
        this.container = container;
        this.options = {
            width: 12,
            ...options
        };

        // 创建 Portal 容器和 canvas
        this.createPortal();
    }

    /**
     * 创建 Portal 容器和 canvas 元素
     */
    private createPortal(): void {
        // 创建 Portal 容器
        this.portal = document.createElement('div');
        this.portal.className = 'surprisal-minimap-portal';
        this.portal.style.cssText = `
            position: fixed;
            right: 0;
            top: 0;
            pointer-events: none;
            z-index: 1;
        `;

        // 创建 canvas 元素并添加到 Portal
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'surprisal-minimap';
        this.canvas.style.cssText = `
            width: ${this.options.width}px;
        `;

        this.portal.appendChild(this.canvas);

        // 将 Portal 添加到 body
        document.body.appendChild(this.portal);
    }

    /**
     * 隐藏 minimap（用于快速resize过渡期间）
     */
    public hide(): void {
        this.portal.style.opacity = '0';
    }

    /**
     * 更新 minimap 布局
     * 设置 canvas 尺寸和 portal 位置，与滚动条对齐
     */
    private updateMinimapLayout(): void {
        // 设置 canvas 分辨率
        this.canvas.width = this.options.width;
        // 更新样式宽度
        this.canvas.style.width = `${this.options.width}px`;

        let viewportHeight: number;

        if (isNarrowScreen()) {
            // 窄屏模式：使用视口高度作为可视区域高度
            const clientHeight = document.documentElement.clientHeight;
            if (clientHeight) {
                viewportHeight = clientHeight;
            } else {
                viewportHeight = window.innerHeight;
                console.warn('[ScrollbarMinimap] 使用后备值 window.innerHeight，document.documentElement.clientHeight 不可用', {
                    clientHeight,
                    innerHeight: window.innerHeight,
                    viewportHeight
                });
            }
        } else {
            // 桌面端：使用视口高度（不再依赖滚动容器）
            viewportHeight = window.innerHeight;
        }

        // 设置 canvas 高度
        this.canvas.height = viewportHeight;

        // 设置 portal 位置
        // 无论窄屏还是桌面端，都固定在视口顶部
        this.portal.style.top = '0px';
    }

    /**
     * 渲染 minimap
     * @param positions token 位置数组
     * @param renderData 渲染数据
     */
    public async render(
        positions: TokenFragmentRect[],
        renderData: FrontendAnalyzeResult,
        renderOptions: MinimapRenderOptions = {}
    ): Promise<void> {
        if (positions.length === 0) {
            this.clear();
            return;
        }

        // 确保minimap可见（从hide状态恢复）
        this.portal.style.opacity = '1';

        this.updateMinimapLayout();

        const ctx = this.canvas.getContext('2d');
        if (!ctx) return;

        // 清空画布
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);

        // 1. 计算minimap上每个像素对应的世界单位数和文本区域顶部位置
        let worldUnitsPerMinimapPixel: number;
        let textAreaTop = 0; // 文本区域在页面中的顶部绝对位置（窄屏模式不为0）

        if (isNarrowScreen()) {
            // 窄屏模式：显示整个页面的缩略图，但只在文本区域显示彩色条
            const canvasHeight = this.canvas.height;
            const scrollHeight = document.body.scrollHeight;
            worldUnitsPerMinimapPixel = scrollHeight / canvasHeight;

            // 计算文本容器在页面中的位置
            const containerRect = this.container.getBoundingClientRect();
            textAreaTop = window.scrollY + containerRect.top; // 文本区域在页面中的顶部绝对位置
        } else {
            // 桌面端：使用完整文本高度来计算缩放，提供缩略图效果
            const canvasHeight = this.canvas.height;
            const textContentHeight = (this.container.querySelector('.text-layer') as HTMLElement).scrollHeight;
            worldUnitsPerMinimapPixel = textContentHeight / canvasHeight;
            
            // 确保每个minimap像素对应的世界单位数不会太小（避免色块过大）
            const minWorldUnitsPerMinimapPixel = 1.0; // 最小1:1，即每个minimap像素对应1个世界单位
            worldUnitsPerMinimapPixel = Math.max(minWorldUnitsPerMinimapPixel, worldUnitsPerMinimapPixel);
        }

        // 2. 获取文本容器的scrollHeight作为Y范围
        let y_min = 0;
        let y_max: number;
        
        if (isNarrowScreen()) {
            // 窄屏模式：使用body的scrollHeight
            y_max = document.body.scrollHeight;
        } else {
            // 桌面端：使用text-layer的scrollHeight
            const textLayer = this.container.querySelector('.text-layer') as HTMLElement;
            y_max = textLayer ? textLayer.scrollHeight : 0;
        }

        const extendedRenderData = renderData as MinimapRenderData;
        const chunkInfos = extendedRenderData.chunkInfos ?? [];

        // 语义模式下：只在 chunkInfos 有值时绘制 chunk match；否则保持为空（不回退到信息密度外观）
        if (renderOptions.semanticAnalysisMode) {
            if (chunkInfos.length > 0) {
                this.renderChunkMatchMinimap(
                    ctx,
                    chunkInfos,
                    textAreaTop,
                    worldUnitsPerMinimapPixel,
                    renderOptions.measureCharRangeY
                );
            }
            return;
        }

        // 3. 按Y坐标桶聚合 token
        // 计算行的高度（直接取第一个token的高度）
        const lineHeight = positions[0].height;
        
        let bucketCount: number;
        // 先通过行高计算bucketCount（确保bucketHeight不小于行的高度）
        if (lineHeight > 0) {
            bucketCount = Math.floor((y_max - y_min) / lineHeight);
        } else {
            console.log('[ScrollbarMinimap] 行高度为0，跳过bucketCount计算', {
                positions,
                lineHeight
            });
            bucketCount = Infinity;
        }

        // 再通过minBucketHeightOnMinimap限制（确保在minimap上的高度不小于最小值）
        const minBucketHeightOnMinimap = 2; // 每个桶在minimap上的最小高度（像素）
        const maxBucketCountByMinimap = Math.floor(this.canvas.height / minBucketHeightOnMinimap);
        bucketCount = Math.min(bucketCount, maxBucketCountByMinimap);
        
        const bucketHeight = (y_max - y_min) / bucketCount;
        const actualBucketHeightOnMinimap = Math.max(1, bucketHeight / worldUnitsPerMinimapPixel); // 实际的bucket高度（像素）

        // 4. 绘制每一行（或合并后的行）
        const aggregationResult = this.aggregateToBuckets(positions, renderData, bucketCount, y_min, y_max);
        const { buckets } = aggregationResult;

        buckets.forEach(bucket => {
            // 计算平均surprisal密度：总surprisal（surprisalPerByte累加）除以token数
            const averageSurprisalDensity = bucket.TokenFragmentCount > 0
                ? bucket.surprisalDensitySum / bucket.TokenFragmentCount
                : 0;
            const color = getByteSurprisalColor(averageSurprisalDensity, MINIMAP_COLOR_FACTOR);
            ctx.fillStyle = color;

            const y = (textAreaTop + bucket.y) / worldUnitsPerMinimapPixel; // 映射到minimap的y坐标
            ctx.fillRect(0, y, this.canvas.width, actualBucketHeightOnMinimap);
        });
    }

    private renderChunkMatchMinimap(
        ctx: CanvasRenderingContext2D,
        chunkInfos: Array<{ startOffset: number; endOffset: number; chunkMatchDegree: number }>,
        textAreaTop: number,
        worldUnitsPerMinimapPixel: number,
        measureCharRangeY?: (startOffset: number, endOffset: number) => { minY: number; maxY: number } | null
    ): void {
        // 为了让各 chunk 在 minimap 上“首尾相接”，后一个 chunk 的起始 y 直接取前一个 chunk 的结束 y
        // 这样可以同时避免重叠（h<0 会被裁剪为 0）和避免间隙（起始从 prevEnd 往上铺满）。
        let prevEndPx: number | null = null;
        let prevChunkIndex: number | null = null;

        for (let idx = 0; idx < chunkInfos.length; idx++) {
            const chunk = chunkInfos[idx]!;
            if (!isFiniteNumber(chunk.chunkMatchDegree)) continue;

            const chunkIndex = ('chunkIndex' in chunk ? (chunk as any).chunkIndex : undefined) ?? idx;

            const measured = measureCharRangeY?.(chunk.startOffset, chunk.endOffset);
            if (!measured) {
                continue;
            }

            const { minY, maxY } = measured;

            if (!Number.isFinite(minY) || !Number.isFinite(maxY) || maxY <= minY) continue;

            const rawMinYPx = (textAreaTop + minY) / worldUnitsPerMinimapPixel;
            const rawMaxYPx = (textAreaTop + maxY) / worldUnitsPerMinimapPixel;

            // “首尾相接”：y 起点直接取上个 chunk 画到的结束位置
            const y = prevEndPx == null ? rawMinYPx : prevEndPx;
            const hRaw = rawMaxYPx - y;
            const h = hRaw < 0 ? 0 : hRaw; // 若完全落在重叠区域内则裁剪到 0
            const drawnEndPx = y + h;

            // minimap 语义颜色额外变浅：降低 alpha/强度
            ctx.fillStyle = getSemanticSimilarityColor(
                chunk.chunkMatchDegree * SEMANTIC_MINIMAP_COLOR_FACTOR
            );
            ctx.fillRect(0, y, this.canvas.width, h);

            prevEndPx = drawnEndPx;
            prevChunkIndex = chunkIndex;
        }
    }

    /**
     * 按Y坐标，把[y_min, y_max]范围内的token fragment聚合到bucketCount个桶
     * @param positions token 位置数组
     * @param renderData 渲染数据
     * @param bucketCount 分桶数量
     * @param y_min Y坐标最小值
     * @param y_max Y坐标最大值
     */
    private aggregateToBuckets(
        positions: TokenFragmentRect[], 
        renderData: FrontendAnalyzeResult, 
        bucketCount: number,
        y_min: number,
        y_max: number
    ): AggregationResult {
        // 处理边界情况：空positions或无效Y范围
        if (positions.length === 0 || y_max <= y_min) {
            return {
                buckets: []
            };
        }

        // 计算每个桶对应的高度
        const bucketHeight = (y_max - y_min) / bucketCount;

        // 初始化桶数组，y坐标从y_min开始，依次递增bucketHeight
        const buckets: BucketData[] = Array.from({ length: bucketCount }, (_, bucketIndex) => ({
            y: y_min + bucketIndex * bucketHeight,
            surprisalDensitySum: 0,
            TokenFragmentCount: 0
        }));

        // 遍历positions，聚合到桶中
        positions.forEach(pos => {
            // 使用token中心坐标计算桶索引
            const centerY = pos.y + pos.height / 2;
            const bucketIndex = Math.floor((centerY - y_min) / bucketHeight);
            
            // 过滤掉超出范围的数据
            if (bucketIndex < 0 || bucketIndex >= bucketCount) {
                return;
            }

            const bucket = buckets[bucketIndex];

            // 计算该token字节平均惊讶度并累加
            const token = renderData.bpe_strings[pos.tokenIndex];
            const surprisalDensity = calculateSurprisalDensity(token);
            bucket.surprisalDensitySum += surprisalDensity;
            bucket.TokenFragmentCount += 1;
            // todo: 使用字节数加权计算bucket的平均信息密度，而不是按token平均计算
        });

        return {
            buckets
        };
    }


    /**
     * 更新模式和选项
     */
    public updateOptions(options: Partial<MinimapOptions>): void {
        this.options = { ...this.options, ...options };
    }

    /**
     * 清空 minimap 内容并隐藏，避免残留旧数据
     */
    public clear(): void {
        const ctx = this.canvas.getContext('2d');
        if (ctx) {
            ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        }
        this.portal.style.opacity = '0';
    }

    /**
     * 清理资源
     */
    public destroy(): void {
        this.clear();
        // 移除整个 Portal 容器
        if (this.portal.parentElement) {
            this.portal.parentElement.removeChild(this.portal);
        }
    }
}
