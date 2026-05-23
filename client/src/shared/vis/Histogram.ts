import { VComponent } from "./VisComponent";
import { D3Sel } from "../core/Util";
import { SimpleEventHandler } from "../core/SimpleEventHandler";
import { tr } from "../lang/i18n-lite";
import * as d3 from "d3";
import { schemeDark2 } from "d3";

const averageNumberFormat = d3.format('.2f');

/** 1-2-5 decade 模式生成非线性 y 轴刻度，最多 maxTicks 个 */
function getNonLinearTickValues(maxCount: number, maxTicks = 10): number[] {
    if (maxCount <= 0) return [0];
    const ticks: number[] = [0];
    const base = [1, 2, 5];
    let decade = 1;
    while (decade <= maxCount) {
        for (const b of base) {
            const v = b * decade;
            if (v <= maxCount) ticks.push(v);
        }
        decade *= 10;
    }
    if (ticks[ticks.length - 1] !== maxCount) ticks.push(maxCount);
    if (ticks.length <= maxTicks) return ticks;
    const result: number[] = [];
    for (let i = 0; i < maxTicks; i++) {
        const idx = Math.round((i / (maxTicks - 1)) * (ticks.length - 1));
        result.push(ticks[idx]);
    }
    return [...new Set(result)].sort((a, b) => a - b);
}

/** 单边：固定值或 'auto'（从 data 解析） */
export type HistogramExtentBound = number | 'auto';

/** extent：'auto' 等价于 ['auto','auto']，支持双边独立配置 */
export type HistogramExtent = [HistogramExtentBound, HistogramExtentBound] | 'auto';

export type HistogramData = {
    data: number[],
    label?: string,
    no_bins: number,
    extent: HistogramExtent,
    colorScale: (value: number) => string,  // 添加颜色 scale
    averageValue?: number,
    p90Value?: number,
    averageLabel?: string,
    p90Label?: string,
    showLeftInfinity?: boolean,
    showRightInfinity?: boolean,
    /** x轴刻度数字绘制间隔，0表示不跳过，1表示隔一个绘制一个（0,2,4...） */
    xAxisTickSkip?: number,
    /** x轴刻度凑整：true=仅显示 step 整数倍处的标签（与 tickSkip 配合），false/undefined=显示全部 */
    xAxisTickRound?: boolean;
    yScaleType?: 'linear' | 'sqrt' | 'log'  // y轴尺度：linear 线性，sqrt 平方根，log 对数（指数刻度，从 0 开始）
    /** 拟合分布的每个 bin 期望计数，用于绘制横虚线标识（如指数噪声拟合） */
    fitExpectedCounts?: number[];
    /** 是否叠加 prob 曲线（共用 x 轴，左侧新 y 轴 0–1） */
    showProbCurve?: boolean;
    /** 曲线数据：x=raw_score_normed，y=prob（0–1），P(signal) 按 findSignalThreshold 的 bin 分块估计，(obs-exp)/obs */
    probCurveData?: { x: number[]; y: number[] };
    /** 信号阈值竖线：归一化分数，用于 raw_score_normed 直方图 */
    signalThreshold?: number | null;
    /** 信号阈值对应的分位数（0–100），用于 label 显示 τ = pXX */
    signalThresholdPercentile?: number | null;
}


export type HistogramBinClickEvent = {
    binIndex: number;
    x0: number;
    x1: number;
    data: number[];
    no_bins: number;   // 直方图的bin数量
    source?: string;  // 直方图标识，用于区分不同的直方图实例
}

export class Histogram extends VComponent<HistogramData> {
    protected _current = {
        selectedBinIndex: null as number | null  // 当前选中的bin索引
    };
    protected css_name = 'HistogramX';
    protected options = {
        width: 200,
        height: 150,
        margin_top: 10,
        margin_bottom: 21,
        numberFormat: d3.format('.3')
    };
    static events = {
        binClicked: 'histogram-bin-clicked'
    };

    constructor(d3Parent: D3Sel, eventHandler?: SimpleEventHandler, options: {} = {}) {
        super(d3Parent, eventHandler);
        this.superInitSVG(options, ['bg', 'main', 'box', 'fg']);
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

        this.layers.bg.append('g')
            .attr('class', 'y-axis')
            .attr('transform', `translate(${op.width - 33},0)`)

        this.layers.bg.append('g')
            .attr('class', 'y-axis-prob')

        // 背景面板：避免柱体与整体页面纯白背景混淆
        this.layers.bg.insert('rect', ':first-child')
            .attr('class', 'panel-bg')
            .attr('x', -12) // 进一步向左扩展，形成更大留白
            .attr('y', 0)
            .attr('width', op.width + 12)
            .attr('height', op.height)
            .attr('rx', 6)
            .attr('ry', 6)
            .style('fill', 'transparent');

        this.layers.bg.append('g')
            .attr('class', 'x-axis')
            .attr('transform', `translate(0,${op.height - op.margin_bottom + 0.5})`)

    }

    protected _render(rD: HistogramData): void {
        const op = this.options;

        // extent 解析：'auto' 等价于 ['auto','auto']，支持双边独立配置
        const [loSpec, hiSpec]: [HistogramExtentBound, HistogramExtentBound] =
            rD.extent === 'auto' ? ['auto', 'auto'] : rD.extent;
        const finite = rD.data.filter((d) => typeof d === 'number' && isFinite(d));
        const [dataLo, dataHi] = finite.length > 0
            ? (d3.extent(finite) as [number, number])
            : [0, 1];
        const fallbackLo = finite.length <= 1 ? dataLo - 0.5 : dataLo;
        const fallbackHi = finite.length <= 1 ? dataHi + 0.5 : dataHi;
        const lo = loSpec === 'auto' ? fallbackLo : loSpec;
        const hi = hiSpec === 'auto' ? fallbackHi : hiSpec;
        const extent: [number, number] = lo > hi ? [lo, lo] : [lo, hi];

        // 计算bin宽度
        const binWidth = (extent[1] - extent[0]) / rD.no_bins;

        // 超出上下界的按照对应bin的中心值处理
        const values = rD.data.map(d => +d)
            .filter(d => isFinite(d))
            .map(d => {
                if (d >= extent[1]) {
                    // 超出或等于上界：映射到最后一个bin的中心值，避免d3.bin()为等于extent[1]的值创建额外的[19,19]bin
                    return extent[1] - 0.5 * binWidth;
                } else if (d <= extent[0]) {
                    // 超出或等于下界：映射到第一个bin的中心值，避免d3.bin()为等于extent[0]的值创建额外的[0,0]bin
                    return extent[0] + 0.5 * binWidth;
                }
                return d;
            });

        // 如果指定了 extent，确保使用 extent 作为 domain，而不是 nice() 调整后的 domain
        // 这样可以保证 extent 的上限被正确使用，即使数据被截断了
        // 使用 extent 作为 domain，确保范围正确
        const padding = { left: rD.showProbCurve ? 35 : 10, right: 35 };
        let valueScale = d3.scaleLinear().domain([extent[0], extent[1]]).range([padding.left, op.width - padding.right]);

        const hasAverageValue = typeof rD.averageValue === 'number' && Number.isFinite(rD.averageValue);
        const clampedAverage = hasAverageValue
            ? Math.min(Math.max(rD.averageValue as number, extent[0]), extent[1])
            : null;
        const averageX = hasAverageValue && clampedAverage !== null
            ? valueScale(clampedAverage)
            : null;

        const hasP90Value = typeof rD.p90Value === 'number' && Number.isFinite(rD.p90Value);
        const clampedP90 = hasP90Value
            ? Math.min(Math.max(rD.p90Value as number, extent[0]), extent[1])
            : null;
        const p90X = hasP90Value && clampedP90 !== null
            ? valueScale(clampedP90)
            : null;

        // 统一的阈值生成逻辑：生成有限数阈值，两侧bin自动包含超出范围的值
        // no_bins 是必选参数，直接使用等宽bin
        // thresholds 长度应该是 no_bins - 1，从 extent[0]+binWidth 开始，比如[0,10]，10个bin，则thresholds长度为9，分别是1..9，不包括0和10
        const thresholds = Array.from({ length: rD.no_bins - 1 }, (_, i) => extent[0] + (i + 1) * binWidth);

        // 设置domain确保边界严格按照extent划分，而不是实际的数据最大值和最小值
        const histo = d3.bin()
            .domain(<[number, number]>[extent[0], extent[1]])
            .thresholds(thresholds)(values);

        // 安全检查：确保 histo 不为空且 maxCount 有效
        let maxCount = histo.length > 0 ? d3.max(histo, h => h.length) : 0;
        if (!isFinite(maxCount) || maxCount === null || maxCount === undefined) {
            console.warn('Invalid maxCount for histogram:', maxCount);
            maxCount = 1;
        }
        if (rD.fitExpectedCounts && rD.fitExpectedCounts.length > 0) {
            const fitMax = d3.max(rD.fitExpectedCounts) ?? 0;
            if (isFinite(fitMax) && fitMax > maxCount) maxCount = fitMax;
        }

        const useSqrt = rD.yScaleType === 'sqrt';
        const useLog = rD.yScaleType === 'log';
        const countScale = useLog
            ? d3.scaleSymlog().domain([0, Math.max(1, maxCount)]).range([op.height - op.margin_bottom, op.margin_top])
            : useSqrt
                ? d3.scaleSqrt().domain([0, maxCount]).range([op.height - op.margin_bottom, op.margin_top])
                : d3.scaleLinear().domain([0, maxCount]).nice().range([op.height - op.margin_bottom, op.margin_top]);

        // 与 d3 scaleBand 一致：bandwidth = step * (1 - paddingInner)，gap = step * paddingInner
        // no_bins=20 时 barWidth:gap ≈ 2.875:1 → paddingInner ≈ 0.258
        const PADDING_INNER = 0.15;
        const adjustWidth = (step: number) => {
            if (!isFinite(step) || step <= 0) return 0;
            return step * (1 - PADDING_INNER);
        };

        const getBandWidth = (d: d3.Bin<number, number>) => valueScale(d.x1) - valueScale(d.x0);
        const getBarCenterX = (d: d3.Bin<number, number>) => {
            const x0 = valueScale(d.x0);
            const x1 = valueScale(d.x1);
            const width = adjustWidth(x1 - x0);
            const center = (isFinite(x0) ? x0 : 0) + 0.5 * (isFinite(width) ? width : 1);
            return isFinite(center) ? center : 0;
        };

        const bars = this.layers.main.selectAll('.bar').data(histo)
            .join('rect')
            .attr('class', 'bar')
            .attrs({
                x: d => {
                    const bandWidth = getBandWidth(d);
                    const barWidth = adjustWidth(bandWidth);
                    const base = valueScale(d.x0);
                    const offset = 0.5 * (bandWidth - barWidth);
                    const x = base + offset;
                    return isFinite(x) ? x : 0;
                },
                y: d => {
                    const y = countScale(d.length);
                    return isFinite(y) ? y : op.height - op.margin_bottom;
                },
                width: d => {
                    const w = adjustWidth(getBandWidth(d));
                    return isFinite(w) && w > 0 ? w : 1;
                },
                height: d => {
                    if (d.length === 0) return 0;
                    const h = op.height - op.margin_bottom - countScale(d.length);
                    return isFinite(h) && h > 0 ? h : 1;
                },
            })
            .style('fill', d => {
                // 统一使用bin的中间值计算颜色
                const colorValue = (d.x0 + d.x1) / 2;
                return rD.colorScale(colorValue);
            })
            .style('stroke', (d, i) => {
                // 如果这个bin被选中，添加蓝色边框
                return this._current.selectedBinIndex === i ? '#2a9eff' : 'none';
            })
            .style('stroke-width', (d, i) => {
                return this._current.selectedBinIndex === i ? '3' : '0';
            })
            .style('filter', (d, i) => {
                // 为选中的bin添加发光效果
                return this._current.selectedBinIndex === i ? 'drop-shadow(0 0 6px rgba(42, 158, 255, 0.8))' : 'none';
            });

        // 拟合分布横虚线：每个 bin 上标识期望计数，宽度与柱体对齐
        const fitData = rD.fitExpectedCounts && rD.fitExpectedCounts.length === histo.length
            ? histo.map((d, i) => {
                const bandWidth = getBandWidth(d);
                const barWidth = adjustWidth(bandWidth);
                const base = valueScale(d.x0);
                const x1 = base + 0.5 * (bandWidth - barWidth);
                return { x1, x2: x1 + barWidth, y: countScale(Math.max(0, rD.fitExpectedCounts![i])) };
            })
            : [];
        this.layers.main.selectAll('.fit-overlay-line').data(fitData)
            .join('line')
            .attr('class', 'fit-overlay-line')
            .attrs({
                x1: d => d.x1,
                x2: d => d.x2,
                y1: d => d.y,
                y2: d => d.y,
            })
            .style('stroke', 'var(--fit-line-color, #999)')
            .style('stroke-width', 1)
            .style('stroke-dasharray', '1,1');

        const avgMarkerData = averageX !== null && Number.isFinite(averageX)
            ? [{ x: averageX, value: rD.averageValue as number }]
            : [];

        this.layers.fg.selectAll('.avg-line').data(avgMarkerData)
            .join('line')
            .attr('class', 'avg-line')
            .attrs({
                x1: d => d.x,
                x2: d => d.x,
                y1: op.margin_top + 4,
                y2: op.height - op.margin_bottom
            })
            .style('stroke', 'var(--avg-line-color, #8c8c8c)')
            .style('stroke-width', 1.5)
            .style('stroke-dasharray', '4,3');

        this.layers.fg.selectAll('.avg-marker-label').data(avgMarkerData)
            .join('text')
            .attr('class', 'avg-marker-label sizeLabel')
            .attr('text-anchor', 'middle')
            .attr('x', d => d.x)
            .attr('y', op.margin_top)
            .text('avg');

        const avgLabelData = (typeof rD.averageValue === 'number' && Number.isFinite(rD.averageValue)) ? [rD.averageValue] : [];
        this.layers.fg.selectAll('.avg-label').data(avgLabelData)
            .join('text')
            .attr('class', 'avg-label sizeLabel')
            .attr('text-anchor', 'end')
            .attr('x', op.width * 0.75)
            .attr('y', Math.max(12, op.margin_top - 2))
            .text(value => {
                const suffix = rD.averageLabel ? ` ${rD.averageLabel}` : '';
                return `avg = ${averageNumberFormat(value)}${suffix}`;
            });

        const p90MarkerData = p90X !== null && Number.isFinite(p90X)
            ? [{ x: p90X, value: rD.p90Value as number }]
            : [];

        this.layers.fg.selectAll('.p90-line').data(p90MarkerData)
            .join('line')
            .attr('class', 'p90-line')
            .attrs({
                x1: d => d.x,
                x2: d => d.x,
                y1: op.margin_top + 4,
                y2: op.height - op.margin_bottom
            })
            .style('stroke', 'var(--p90-line-color, #8c8c8c)')
            .style('stroke-width', 1.5)
            .style('stroke-dasharray', '4,3');

        this.layers.fg.selectAll('.p90-marker-label').data(p90MarkerData)
            .join('text')
            .attr('class', 'p90-marker-label sizeLabel')
            .attr('text-anchor', 'middle')
            .attr('x', d => d.x)
            .attr('y', op.margin_top)
            .text('p90');

        const hasSignalThreshold = typeof rD.signalThreshold === 'number' && Number.isFinite(rD.signalThreshold);
        const clampedSignalThreshold = hasSignalThreshold
            ? Math.min(Math.max(rD.signalThreshold as number, extent[0]), extent[1])
            : null;
        const signalThresholdX = hasSignalThreshold && clampedSignalThreshold !== null
            ? valueScale(clampedSignalThreshold)
            : null;

        const signalThresholdMarkerData = signalThresholdX !== null && Number.isFinite(signalThresholdX)
            ? [{ x: signalThresholdX, value: rD.signalThreshold as number, percentile: rD.signalThresholdPercentile }]
            : [];

        this.layers.fg.selectAll('.signal-threshold-line').data(signalThresholdMarkerData)
            .join('line')
            .attr('class', 'signal-threshold-line')
            .attrs({
                x1: d => d.x,
                x2: d => d.x,
                y1: op.margin_top + 4,
                y2: op.height - op.margin_bottom
            })
            .style('stroke', 'var(--signal-threshold-line-color, #e74c3c)')
            .style('stroke-width', 1.5)
            .style('stroke-dasharray', '3,2');

        this.layers.fg.selectAll('.signal-threshold-marker-label').data(signalThresholdMarkerData)
            .join('text')
            .attr('class', 'signal-threshold-marker-label sizeLabel')
            .attr('text-anchor', 'middle')
            .attr('x', d => d.x)
            .attr('y', op.margin_top)
            .text(d => typeof d.percentile === 'number' ? `τ = p${d.percentile}` : 'τ');

        const p90LabelData = (typeof rD.p90Value === 'number' && Number.isFinite(rD.p90Value)) ? [rD.p90Value] : [];
        const p90LabelY = avgLabelData.length > 0 ? Math.max(24, op.margin_top + 10) : Math.max(12, op.margin_top - 2);
        this.layers.fg.selectAll('.p90-label').data(p90LabelData)
            .join('text')
            .attr('class', 'p90-label sizeLabel')
            .attr('text-anchor', 'end')
            .attr('x', op.width * 0.75)
            .attr('y', p90LabelY)
            .text(value => {
                const suffix = rD.p90Label ? ` ${rD.p90Label}` : '';
                return `p90 = ${averageNumberFormat(value)}${suffix}`;
            });

        const labelData = histo.filter(bin => bin.length > 0);
        const labelAngle = -24; // 向左上倾斜
        const totalCount = values.length; // 总数据点数量
        
        // 格式化百分比：大于1%时2位有效数字，否则1位有效数字
        const formatPercentage = (count: number, total: number): string => {
            const percentage = (count / total * 100);
            if (percentage > 1) {
                // > 1%: 2位有效数字，如 25%, 2.5%
                const formatted = Number(percentage.toPrecision(2));
                return `${formatted}%`;
            } else {
                // <= 1%: 1位有效数字，如 0.2%, 0.02%
                const formatted = Number(percentage.toPrecision(1));
                return `${formatted}%`;
            }
        };
        
        this.layers.fg.selectAll('.bar-label').data(labelData)
            .join('text')
            .attr('class', 'bar-label sizeLabel')
            .attr('text-anchor', 'middle')
            .attr('transform', d => {
                const x = getBarCenterX(d);
                const y = countScale(d.length) - 4;
                const safeY = isFinite(y) ? y : op.margin_top;
                return `translate(${x},${safeY}) rotate(${labelAngle})`;
            })
            .text(d => {
                // 获取当前bin的索引
                const binIndex = histo.findIndex(bin => bin.x0 === d.x0 && bin.x1 === d.x1);
                // 如果这个bin被选中，显示数量，否则显示百分比
                if (this._current.selectedBinIndex === binIndex) {
                    return d.length;
                } else {
                    return formatPercentage(d.length, totalCount);
                }
            })
            .style('cursor', 'pointer');

        // 添加更大的透明悬停区域
        const hoverAreas = this.layers.main.selectAll('.hover-area').data(histo)
            .join('rect')
            .attr('class', 'hover-area')
            .attrs({
                x: d => {
                    const x = valueScale(d.x0);
                    return isFinite(x) ? x : 0;
                },
                y: op.margin_top,  // 从顶部开始
                width: d => {
                    const w = adjustWidth(valueScale(d.x1) - valueScale(d.x0));
                    return isFinite(w) && w > 0 ? w : 1;
                },
                height: op.height - op.margin_bottom - op.margin_top,  // 覆盖整个图表高度
            })
            .style('fill', 'transparent')  // 透明
            .style('pointer-events', 'all')  // 确保能接收鼠标事件
            .style('cursor', 'pointer')  // 添加指针光标
            .on('mouseenter', (event, d) => {
                // 鼠标悬浮时，更新对应的label显示数量
                const binIndex = histo.findIndex(bin => bin.x0 === d.x0 && bin.x1 === d.x1);
                this.layers.fg.selectAll('.bar-label')
                    .filter((labelD: any, i: number) => {
                        const labelBinIndex = histo.findIndex(bin => bin.x0 === labelD.x0 && bin.x1 === labelD.x1);
                        return labelBinIndex === binIndex;
                    })
                    .text(d.length);
            })
            .on('mouseleave', (event, d) => {
                // 鼠标离开时，如果该bin未被选中，恢复显示百分比
                const binIndex = histo.findIndex(bin => bin.x0 === d.x0 && bin.x1 === d.x1);
                if (this._current.selectedBinIndex !== binIndex) {
                    this.layers.fg.selectAll('.bar-label')
                        .filter((labelD: any, i: number) => {
                            const labelBinIndex = histo.findIndex(bin => bin.x0 === labelD.x0 && bin.x1 === labelD.x1);
                            return labelBinIndex === binIndex;
                        })
                        .text((labelD: any) => formatPercentage(labelD.length, totalCount));
                }
            })
            .on('click', (event, d) => {
                // 阻止事件冒泡，避免触发body的点击事件清除高亮
                event.stopPropagation();
                
                // 使用数据绑定的索引，更可靠
                const binIndex = histo.findIndex(bin => bin.x0 === d.x0 && bin.x1 === d.x1);
                
                // Toggle模式：如果点击已选中的bin，则取消选中
                if (this._current.selectedBinIndex === binIndex) {
                    this._current.selectedBinIndex = null;
                    // 重新渲染以清除高亮效果
                    this._render(this.renderData);
                    // 获取parent的id作为source标识
                    const sourceId = this.parent.attr('id') || this.parent.node()?.id || '';
                    // 触发点击事件，传递null表示取消选中
                    this.eventHandler.trigger(Histogram.events.binClicked, <HistogramBinClickEvent>{
                        binIndex: -1,  // -1表示取消选中
                        x0: d.x0,
                        x1: d.x1,
                        data: d,
                        no_bins: rD.no_bins,
                        source: sourceId
                    });
                } else {
                    // 更新选中的bin索引
                    this._current.selectedBinIndex = binIndex >= 0 ? binIndex : null;
                    // 重新渲染以显示高亮效果
                    this._render(this.renderData);
                    // 获取parent的id作为source标识
                    const sourceId = this.parent.attr('id') || this.parent.node()?.id || '';
                    // 触发点击事件
                    this.eventHandler.trigger(Histogram.events.binClicked, <HistogramBinClickEvent>{
                        binIndex: binIndex >= 0 ? binIndex : 0,
                        x0: d.x0,
                        x1: d.x1,
                        data: d,
                        no_bins: rD.no_bins,
                        source: sourceId
                    });
                }
            });


        const yAxis = d3.axisRight(countScale)
            .tickFormat(useLog ? d3.format('.0f') : op.numberFormat);
        if (useSqrt || useLog) yAxis.tickValues(getNonLinearTickValues(maxCount, 10));
        this.layers.bg.select('.y-axis').call(<any>yAxis);
        
        const tickValues = [extent[0], ...thresholds, extent[1]];
        const tickSkip = rD.xAxisTickSkip ?? 0;
        
        // Custom tick format: 根据 showLeftInfinity/showRightInfinity 决定是否显示 ±∞
        // xAxisTickSkip：减少刻度标签密度；xAxisTickRound：true 时按 step 对齐过滤，false 时按索引跳过
        const xAxisTickFormat = (d: number) => {
            if (rD.showLeftInfinity && Math.abs(d - extent[0]) < 0.001) return '-∞';
            if (rD.showRightInfinity && Math.abs(d - extent[1]) < 0.001) return '∞';

            if (tickSkip > 0) {
                if (rD.xAxisTickRound) {
                    const step = (tickSkip + 1) * binWidth;
                    if (Math.abs(d / step - Math.round(d / step)) > 1e-9) return '';
                } else {
                    const idx = tickValues.findIndex((t) => Math.abs(t - d) < 1e-9 * (Math.abs(d) + 1));
                    if (idx >= 0 && idx % (tickSkip + 1) !== 0) return '';
                }
            }

            return op.numberFormat(d);
        };
        
        const xAxis = d3.axisBottom(valueScale)
            .tickFormat(xAxisTickFormat)
            .tickValues(tickValues);
        this.layers.bg.select('.x-axis').call(<any>xAxis);

        const hasProbCurve = rD.showProbCurve && rD.probCurveData && rD.probCurveData.x.length > 0;
        if (hasProbCurve) {
            const probYScale = d3.scaleLinear()
                .domain([0, 1])
                .range([op.height - op.margin_bottom, op.margin_top]);

            const probPoints: { x: number; y: number }[] = rD.probCurveData!.x.map((x, i) => ({ x, y: rD.probCurveData!.y[i] ?? 0 }));
            const probLine = d3.line<{ x: number; y: number }>()
                .x(d => valueScale(d.x))
                .y(d => probYScale(d.y))
                .curve(d3.curveLinear);

            this.layers.fg.selectAll('.prob-curve').data([probPoints])
                .join('path')
                .attr('class', 'prob-curve')
                .attr('d', probLine)
                .style('fill', 'none')
                .style('stroke', 'var(--prob-curve-color, rgba(160,200,255,0.85))')
                .style('stroke-width', 1.5)
                .style('pointer-events', 'none');

            const probAxis = d3.axisLeft(probYScale)
                .ticks(5)
                .tickFormat(d3.format('.1f'));
            this.layers.bg.select('.y-axis-prob')
                .attr('transform', `translate(${padding.left},0)`)
                .call(<any>probAxis);

            this.layers.bg.selectAll('.prob-curve-axis-label').data([1])
                .join('text')
                .attr('class', 'prob-curve-axis-label sizeLabel')
                .attr('text-anchor', 'middle')
                .attr('transform', `translate(8,${(op.height - op.margin_bottom) / 2 + op.margin_top}) rotate(-90)`)
                .text(tr('signal ratio'));

        } else {
            this.layers.fg.selectAll('.prob-curve').remove();
            this.layers.bg.select('.y-axis-prob').selectAll('*').remove();
            this.layers.bg.selectAll('.prob-curve-axis-label').remove();
        }

    }

    protected _wrangle(data) {
        return data;
    }

    /**
     * 设置选中的bin索引
     * @param binIndex bin索引，如果为null则清除选中状态
     */
    setSelectedBin(binIndex: number | null) {
        this._current.selectedBinIndex = binIndex;
        // 重新渲染以显示高亮效果
        if (this.renderData) {
            this._render(this.renderData);
        }
    }

    /**
     * 清除选中状态
     */
    clearSelection() {
        this.setSelectedBin(null);
    }

}