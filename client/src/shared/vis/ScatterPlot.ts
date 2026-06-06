import { VComponent } from "./VisComponent";
import { D3Sel } from "../core/Util";
import { SimpleEventHandler } from "../core/SimpleEventHandler";
import { getSemanticSimilarityColor } from "../cross/SurprisalColorConfig";
import { HIGHLIGHT_CONSTANTS } from "./constants";
import * as d3 from "d3";

/** 水平线段：x0/x1 为 x 轴范围，y 为 y 轴值（如 chunk 匹配度） */
export type ChunkLine = { x0: number; x1: number; y: number };

export type ScatterPlotData = {
    /** 原始数组（x=索引）或显式点数组 */
    data: number[] | Array<{ x: number; y: number }>;
    xLabel?: string;
    yLabel?: string;
    extent?: { x?: [number, number]; y?: [number, number] };
    scatterColor?: string;
    lineColor?: string;
    /** 是否绘制移动平均线，默认 true */
    showMovingAverage?: boolean;
    /** 可选：chunk 匹配线，每段起点 x0、终点 x1、y 为匹配度 */
    chunkLines?: ChunkLine[];
    /** 可选：固定阈值线，y 轴值，每次分析固定 */
    thresholdLine?: number;
    /** 为 true 且存在 chunkLines 时，绘制与直方图类似的悬停区、标签与点击（match score 专用） */
    chunkInteraction?: boolean;
}

export type ScatterChunkClickEvent = {
    chunkIndex: number;
    x0: number;
    x1: number;
    matchDegree: number;
    totalChunks: number;
    source?: string;
};

type Point = {
    x: number,
    y: number
}

type RenderData = {
    scatterPoints: Point[];
    movingAverageLine: Point[];
    chunkLines: ChunkLine[];
    chunkInteraction: boolean;
    thresholdLine?: number;
    extent?: { x?: [number, number]; y?: [number, number] };
    xLabel?: string;
    yLabel?: string;
    scatterColor?: string;
    lineColor?: string;
    showMovingAverage: boolean;
}

/** 与直方图 bar-label 一致的百分比格式 */
function formatPercentage(count: number, total: number): string {
    const percentage = (count / total * 100);
    if (percentage > 1) {
        const formatted = Number(percentage.toPrecision(2));
        return `${formatted}%`;
    }
    const formatted = Number(percentage.toPrecision(1));
    return `${formatted}%`;
}

export class ScatterPlot extends VComponent<ScatterPlotData> {
    protected css_name = 'ScatterPlotX';
    protected options = {
        width: 400,
        height: 200,
        margin_top: 10,
        margin_bottom: 21,
        margin_left: 10,
        margin_right: 35,
        numberFormat: d3.format('.2f')
    };
    protected _current: { selectedChunkX0: number | null; hoveredChunkX0: number | null } = {
        selectedChunkX0: null,
        hoveredChunkX0: null
    };

    static events = {
        chunkClicked: 'scatter-chunk-clicked'
    };

    constructor(d3Parent: D3Sel, eventHandler?: SimpleEventHandler, options: {} = {}) {
        super(d3Parent, eventHandler);
        this.superInitSVG(options, ['bg', 'main', 'fg']);
        this._init();
    }

    protected _init() {
        const op = this.options;

        this.parent.attrs({
            width: op.width,
            height: op.height,
            viewBox: `0 0 ${op.width} ${op.height}`,
            preserveAspectRatio: 'xMidYMid meet'
        });

        // 背景面板
        this.layers.bg.insert('rect', ':first-child')
            .attr('class', 'panel-bg')
            .attr('x', -12)
            .attr('y', 0)
            .attr('width', op.width + 12)
            .attr('height', op.height)
            .attr('rx', 6)
            .attr('ry', 6)
            .style('fill', 'transparent');

        // Y轴
        this.layers.bg.append('g')
            .attr('class', 'y-axis')
            .attr('transform', `translate(${op.width - op.margin_right},0)`);

        // X轴
        this.layers.bg.append('g')
            .attr('class', 'x-axis')
            .attr('transform', `translate(0,${op.height - op.margin_bottom + 0.5})`);
    }

    protected _wrangle(data: ScatterPlotData): RenderData {
        const chunkInteraction = !!data.chunkInteraction;
        const raw = data.data;
        const isPoints = raw.length > 0 && typeof raw[0] === 'object' && 'x' in raw[0] && 'y' in raw[0];
        const scatterPoints: Point[] = isPoints
            ? (raw as Array<{ x: number; y: number }>).slice(0, 10000)
            : (raw as number[]).slice(0, 10000).map((y, i) => ({ x: i, y }));

        if (scatterPoints.length === 0) {
            return {
                scatterPoints: [],
                movingAverageLine: [],
                chunkLines: data.chunkLines ?? [],
                chunkInteraction,
                thresholdLine: data.thresholdLine,
                extent: data.extent,
                xLabel: data.xLabel,
                yLabel: data.yLabel,
                scatterColor: data.scatterColor,
                lineColor: data.lineColor,
                showMovingAverage: data.showMovingAverage ?? true
            };
        }

        const showMovingAverage = data.showMovingAverage ?? true;
        let movingAverage: Point[] = [];
        if (showMovingAverage && !isPoints) {
            const rawSurprisals = raw as number[];
            const T = rawSurprisals.length;
            const movingAverageWindow = 32;
            for (let i = 0; i < T; i++) {
                const halfWindow = Math.floor(movingAverageWindow / 2);
                const start = Math.max(0, i - halfWindow);
                const end = Math.min(T, i + halfWindow + 1);
                const windowTokens = rawSurprisals.slice(start, end);
                const avg = windowTokens.reduce((sum, val) => sum + val, 0) / windowTokens.length;
                movingAverage.push({ x: i, y: avg });
            }
        }

        return {
            scatterPoints,
            movingAverageLine: movingAverage,
            chunkLines: data.chunkLines ?? [],
            chunkInteraction,
            thresholdLine: data.thresholdLine,
            extent: data.extent,
            xLabel: data.xLabel,
            yLabel: data.yLabel,
            scatterColor: data.scatterColor,
            lineColor: data.lineColor,
            showMovingAverage
        };
    }

    setSelectedChunk(x0: number | null): void {
        this._current.selectedChunkX0 = x0;
        if (x0 === null) this._current.hoveredChunkX0 = null;
        if (this.renderData) {
            this._render(this.renderData as RenderData);
        }
    }

    clearSelection(): void {
        this.setSelectedChunk(null);
    }

    protected _render(rd: RenderData): void {
        const op = this.options;

        // 如果没有任何散点也没有 chunk 线，只保留一个最简占位：清空主图层后直接返回
        if (rd.scatterPoints.length === 0 && rd.chunkLines.length === 0) {
            this.layers.main.selectAll('*').remove();
            this.layers.fg.selectAll('.chunk-match-label').remove();
            this.layers.fg.selectAll('.hover-area').remove();
            return;
        }

        const allXValues = (() => {
            const base = rd.showMovingAverage
                ? [...rd.scatterPoints.map(d => d.x), ...rd.movingAverageLine.map(d => d.x)]
                : rd.scatterPoints.map(d => d.x);
            if (rd.chunkLines.length > 0) {
                for (const c of rd.chunkLines) {
                    base.push(c.x0, c.x1);
                }
            }
            return base;
        })();
        const xExtent = rd.extent?.x ?? (d3.extent(allXValues) as [number, number]);
        if (!xExtent || xExtent.length !== 2 || !isFinite(xExtent[0]) || !isFinite(xExtent[1]) || xExtent[0] >= xExtent[1]) {
            const xMax = d3.max(allXValues) ?? 1;
            xExtent[0] = 0;
            xExtent[1] = Math.max(1, xMax);
        }

        const yExtent: [number, number] = rd.extent?.y ?? [0, 20];

        // semantic match progress：x=字符偏移，但希望 x 轴刻度显示为“全文位置百分比”
        const showXAsPercent = !!rd.chunkInteraction;
        const xDomainSpan = xExtent[1] - xExtent[0];
        const xAxisDefaultTickFormat = d3.format('d');
        const xAxisPercentTickFormat = (d: number) => {
            if (!isFinite(xDomainSpan) || xDomainSpan <= 0) return xAxisDefaultTickFormat(d);
            const pct = ((d - xExtent[0]) / xDomainSpan) * 100;
            const clamped = Math.max(0, Math.min(100, pct));
            return `${Math.round(clamped)}%`;
        };

        // 创建比例尺
        const xScale = d3.scaleLinear()
            .domain(xExtent)
            .range([op.margin_left, op.width - op.margin_right]);
        if (!showXAsPercent) xScale.nice();

        const yScale = d3.scaleLinear()
            .domain(yExtent)
            .range([op.height - op.margin_bottom, op.margin_top]);

        if (rd.showMovingAverage && rd.movingAverageLine.length > 0) {
            const line = d3.line<Point>()
                .x(d => xScale(d.x))
                .y(d => yScale(d.y))
                .curve(d3.curveLinear);
            this.layers.main.selectAll('.moving-average-line')
                .data([rd.movingAverageLine])
                .join('path')
                .attr('class', 'moving-average-line')
                .attr('d', line)
                .style('fill', 'none')
                .style('stroke', rd.lineColor || '#ff6b6b')
                .style('stroke-width', 2);
        } else {
            this.layers.main.selectAll('.moving-average-line').remove();
        }

        // 固定阈值线（灰色，横跨全 x 轴）
        const thresholdData = rd.thresholdLine != null && isFinite(rd.thresholdLine) ? [rd.thresholdLine] : [];
        this.layers.main.selectAll('.threshold-line')
            .data(thresholdData)
            .join('line')
            .attr('class', 'threshold-line')
            .attr('x1', xScale(xExtent[0]))
            .attr('x2', xScale(xExtent[1]))
            .attr('y1', d => yScale(d))
            .attr('y2', d => yScale(d))
            .style('stroke', '#999')
            .style('stroke-width', 1)
            .style('stroke-dasharray', '4,4')
            .style('opacity', 0.5);
        // chunk 匹配线（水平线段，y=匹配度，x0~x1=chunk 范围）
        const selX0 = this._current.selectedChunkX0;
        if (selX0 != null && !rd.chunkLines.some(c => c.x0 === selX0)) {
            this._current.selectedChunkX0 = null;
        }
        const hovX0 = this._current.hoveredChunkX0;
        if (hovX0 != null && !rd.chunkLines.some(c => c.x0 === hovX0)) {
            this._current.hoveredChunkX0 = null;
        }
        const selectedX0 = this._current.selectedChunkX0;
        const hoveredX0 = this._current.hoveredChunkX0;

        if (rd.chunkLines.length > 0) {
            const chunkStrokeUnselected = () => getSemanticSimilarityColor(1);
            const chunkStrokeFor = (d: ChunkLine) =>
                selectedX0 === d.x0 ? HIGHLIGHT_CONSTANTS.HIGHLIGHT_COLOR : chunkStrokeUnselected();
            /** 选中或悬停：加粗；仅选中时描边为蓝色 */
            const chunkLineEmphasized = (d: ChunkLine) =>
                selectedX0 === d.x0 || hoveredX0 === d.x0;
            this.layers.main.selectAll<SVGLineElement, ChunkLine>('.chunk-line')
                .data(rd.chunkLines, d => d.x0.toString())
                .join(
                    enter => enter.append('line')
                        .attr('class', 'chunk-line')
                        .attr('x1', d => xScale(d.x0))
                        .attr('x2', d => xScale(d.x1))
                        .attr('y1', d => yScale(d.y))
                        .attr('y2', d => yScale(d.y))
                        .style('stroke', d => chunkStrokeFor(d))
                        .style('stroke-width', d => chunkLineEmphasized(d) ? 4 : 2)
                        .style('opacity', null)
                        .style('filter', null)
                        .style('pointer-events', 'none'),
                    update => update
                        .attr('x1', d => xScale(d.x0))
                        .attr('x2', d => xScale(d.x1))
                        .attr('y1', d => yScale(d.y))
                        .attr('y2', d => yScale(d.y))
                        .style('stroke', d => chunkStrokeFor(d))
                        .style('stroke-width', d => chunkLineEmphasized(d) ? 4 : 2)
                        .style('opacity', null)
                        .style('filter', null)
                );
        } else {
            this.layers.main.selectAll('.chunk-line').remove();
        }

        // 渲染散点（后渲染，在线上方）
        this.layers.main.selectAll('.scatter-point')
            .data(rd.scatterPoints)
            .join('circle')
            .attr('class', 'scatter-point')
            .attr('cx', d => xScale(d.x))
            .attr('cy', d => yScale(d.y))
            .attr('r', 1.5)
            .style('fill', rd.scatterColor || '#70b0ff')
            .style('opacity', 0.5)

        const xAxis = d3.axisBottom(xScale)
            .tickFormat(showXAsPercent ? xAxisPercentTickFormat : xAxisDefaultTickFormat)
            // 强制端点刻度出现（0%~100%），避免 d3 ticks 默认不包含边界
            .tickValues(showXAsPercent
                ? [0, 25, 50, 75, 100].map(p => xExtent[0] + xDomainSpan * (p / 100))
                : undefined);
        this.layers.bg.select('.x-axis')
            .call(xAxis as any);

        const yAxisTicks = yExtent[1] <= 1
            ? [0, 0.25, 0.5, 0.75, 1]
            : Array.from({ length: 11 }, (_, i) => i * 2);
        const yAxisTickFormat = (d: number) =>
            yExtent[1] > 1 && Math.abs(d - 20) < 0.001 ? '∞' : op.numberFormat(d);
        const yAxis = d3.axisRight(yScale)
            .tickValues(yAxisTicks)
            .tickFormat(yAxisTickFormat);
        this.layers.bg.select('.y-axis')
            .call(yAxis as any);

        const lines = rd.chunkLines;
        const n = lines.length;

        if (rd.chunkInteraction && n > 0) {
            const getChunkIndex = (d: ChunkLine) => lines.findIndex(c => c.x0 === d.x0 && c.x1 === d.x1);
            const getCenterX = (d: ChunkLine) => {
                const x0 = xScale(d.x0);
                const x1 = xScale(d.x1);
                return 0.5 * (x0 + x1);
            };

            this.layers.fg.selectAll<SVGTextElement, ChunkLine>('.chunk-match-label')
                .data(lines, (d: ChunkLine) => d.x0.toString())
                .join('text')
                .attr('class', 'chunk-match-label bar-label sizeLabel')
                .attr('text-anchor', 'middle')
                .attr('transform', d => {
                    const x = getCenterX(d);
                    const y = yScale(d.y) - 4;
                    const safeY = isFinite(y) ? y : op.margin_top;
                    return `translate(${x},${safeY})`;
                })
                .text(d =>
                    hoveredX0 === d.x0 ? formatPercentage(d.y * 100, 100) : ''
                )
                .style('cursor', 'pointer');

            const eventHandler = this.eventHandler;
            const sourceId = this.parent.attr('id') || this.parent.node()?.id || '';

            this.layers.fg.selectAll<SVGRectElement, ChunkLine>('.hover-area')
                .data(lines, (d: ChunkLine) => d.x0.toString())
                .join('rect')
                .attr('class', 'hover-area')
                .attrs({
                    x: d => {
                        const x = xScale(d.x0);
                        return isFinite(x) ? x : 0;
                    },
                    y: op.margin_top,
                    width: d => {
                        const w = xScale(d.x1) - xScale(d.x0);
                        return isFinite(w) && w > 0 ? w : 1;
                    },
                    height: op.height - op.margin_bottom - op.margin_top,
                })
                .style('fill', 'transparent')
                .style('pointer-events', 'all')
                .style('cursor', 'pointer')
                .on('mouseenter', (_event, d) => {
                    this._current.hoveredChunkX0 = d.x0;
                    if (this.renderData) this._render(this.renderData as RenderData);
                })
                .on('mouseleave', (_event, d) => {
                    if (this._current.hoveredChunkX0 === d.x0) {
                        this._current.hoveredChunkX0 = null;
                    }
                    if (this.renderData) this._render(this.renderData as RenderData);
                })
                .on('click', (event, d) => {
                    event.stopPropagation();
                    const chunkIndex = getChunkIndex(d);
                    if (chunkIndex < 0) return;

                    if (this._current.selectedChunkX0 === d.x0) {
                        this._current.selectedChunkX0 = null;
                        if (this.renderData) this._render(this.renderData as RenderData);
                        eventHandler.trigger(ScatterPlot.events.chunkClicked, <ScatterChunkClickEvent>{
                            chunkIndex: -1,
                            x0: d.x0,
                            x1: d.x1,
                            matchDegree: d.y,
                            totalChunks: n,
                            source: sourceId
                        });
                    } else {
                        this._current.selectedChunkX0 = d.x0;
                        if (this.renderData) this._render(this.renderData as RenderData);
                        eventHandler.trigger(ScatterPlot.events.chunkClicked, <ScatterChunkClickEvent>{
                            chunkIndex,
                            x0: d.x0,
                            x1: d.x1,
                            matchDegree: d.y,
                            totalChunks: n,
                            source: sourceId
                        });
                    }
                });
        } else {
            this.layers.fg.selectAll('.chunk-match-label').remove();
            this.layers.fg.selectAll('.hover-area').remove();
        }
    }
}
