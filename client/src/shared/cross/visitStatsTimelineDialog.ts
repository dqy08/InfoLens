/**
 * Visit Stats — active visits 时间线（后端 UTC 整点小时；UI 与访问面板一致用本地时间展示）
 * 周期与 hour 格式：visitStatsContract.ts ↔ backend/platform/visit_stats.py
 */
import * as d3 from 'd3';
import { showDialog } from '../../shared/ui/dialog';
import { tr } from '../../shared/lang/i18n-lite';
import type { TextAnalysisAPI } from '../../shared/api/GLTR_API';
import {
    STATS_PERIOD_HOURS,
    STATS_SLOTS_PER_LOCAL_DAY,
    STATS_SLOTS_PER_LOCAL_WEEK,
    STATS_UTC_HOUR_FMT,
} from './visitStatsContract';

type TimelineMetric = 'active_visits' | 'active_sec';
type TimelineBin = { hour: string; active_visits: number; active_sec: number };
type TimelineGranularity = 'hour' | 'day';
type TimelineOverlay = 'none' | 'day' | 'week';
type ChartPoint = { t: Date; value: number };

const METRIC_OPTIONS: { value: TimelineMetric; label: string }[] = [
    { value: 'active_visits', label: 'Active visits' },
    { value: 'active_sec', label: 'Active time' },
];

function binCount(b: TimelineBin, metric: TimelineMetric): number {
    return b[metric] ?? 0;
}

function formatMetricValue(n: number, metric: TimelineMetric): string {
    if (metric === 'active_sec') return `${n}s`;
    const unit = n === 1 ? 'active visit' : 'active visits';
    return `${n} ${unit}`;
}

function metricCountLabel(metric: TimelineMetric): string {
    if (metric === 'active_sec') return 'active time (s)';
    return 'active visits';
}

const CHART_WIDTH = 560;
const CHART_HEIGHT = 220;
const MARGIN = { top: 12, right: 12, bottom: 36, left: 40 };
const BAR_COLOR = '#22c55e';
const WEEKEND_BG = 'rgba(128, 128, 128, 0.14)';
const parseUtcHour = d3.utcParse(STATS_UTC_HOUR_FMT)!;

function localDayKey(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function parseLocalDay(key: string): Date {
    const [y, m, day] = key.split('-').map((s) => parseInt(s, 10));
    return new Date(y, m - 1, day);
}

function addLocalDays(t: Date, n: number): Date {
    return new Date(t.getFullYear(), t.getMonth(), t.getDate() + n);
}

function formatLocalDateTime(d: Date): string {
    return d.toLocaleString();
}

function formatLocalDate(d: Date): string {
    return d.toLocaleDateString();
}

function isLocalWeekend(d: Date): boolean {
    const day = d.getDay();
    return day === 0 || day === 6;
}

function formatLocalAxisHour(d: Date): string {
    if (d.getHours() === 0 && d.getMinutes() === 0) {
        return formatLocalDate(d);
    }
    return d.toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

const LOCAL_WEEKDAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function formatOverlayDayAxis(d: Date): string {
    return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function formatOverlayWeekAxis(d: Date): string {
    return LOCAL_WEEKDAY_LABELS[d.getDay()];
}

function formatOverlayWeekHourAxis(d: Date): string {
    return `${formatOverlayWeekAxis(d)} ${formatOverlayDayAxis(d)}`;
}

const WEEK_HOUR_SLOTS = STATS_SLOTS_PER_LOCAL_WEEK;

type OverlayView = 'none' | 'day24' | 'week168' | 'week7';

function resolveOverlayView(granularity: TimelineGranularity, overlay: TimelineOverlay): OverlayView {
    if (overlay === 'none') return 'none';
    if (overlay === 'day') return 'day24';
    return granularity === 'hour' ? 'week168' : 'week7';
}

function overlayHourBinEnd(t: Date): Date {
    return new Date(
        t.getFullYear(),
        t.getMonth(),
        t.getDate(),
        t.getHours() + STATS_PERIOD_HOURS,
    );
}

function timelineDialogFullscreenExpanded(el: HTMLElement): boolean {
    return document.fullscreenElement === el;
}

async function toggleTimelineDialogFullscreen(el: HTMLElement): Promise<void> {
    if (document.fullscreenElement === el) {
        await document.exitFullscreen();
        return;
    }
    if (document.fullscreenElement) {
        await document.exitFullscreen();
    }
    await el.requestFullscreen();
}

function measureChart(host: HTMLDivElement, fullscreen: boolean): { width: number; height: number } {
    if (!fullscreen) {
        return { width: CHART_WIDTH, height: CHART_HEIGHT };
    }
    const r = host.getBoundingClientRect();
    const w = Math.max(320, Math.floor(r.width));
    const h = Math.max(200, Math.floor(r.height));
    if (w > 0 && h > 0) {
        return { width: w, height: h };
    }
    return { width: Math.max(320, window.innerWidth - 64), height: Math.max(200, window.innerHeight - 120) };
}

function utcHourKey(d: Date): string {
    return d3.utcFormat(STATS_UTC_HOUR_FMT)(d3.utcHour.floor(d));
}

/** 后端 UTC 整点小时；补全空缺 */
function fillHourGaps(bins: TimelineBin[], metric: TimelineMetric): ChartPoint[] {
    if (bins.length === 0) return [];
    const map = new Map(bins.map((b) => [b.hour, binCount(b, metric)]));
    const start = d3.utcHour.floor(parseUtcHour(bins[0].hour)!);
    const end = d3.utcHour.floor(parseUtcHour(bins[bins.length - 1].hour)!);
    const out: ChartPoint[] = [];
    for (let t = start; t <= end; t = d3.utcHour.offset(t, STATS_PERIOD_HOURS)) {
        const key = utcHourKey(t);
        out.push({ t, value: map.get(key) ?? 0 });
    }
    return out;
}

function aggregateToLocalDayBins(
    bins: TimelineBin[],
    metric: TimelineMetric,
): { day: string; value: number }[] {
    const map = new Map<string, number>();
    for (const b of bins) {
        const key = localDayKey(parseUtcHour(b.hour)!);
        map.set(key, (map.get(key) ?? 0) + binCount(b, metric));
    }
    return [...map.keys()].sort().map((day) => ({ day, value: map.get(day)! }));
}

function fillLocalDayGaps(bins: { day: string; value: number }[]): ChartPoint[] {
    if (bins.length === 0) return [];
    const map = new Map(bins.map((b) => [b.day, b.value]));
    let start = parseLocalDay(bins[0].day);
    const end = parseLocalDay(bins[bins.length - 1].day);
    const out: ChartPoint[] = [];
    for (let t = start; t <= end; t = addLocalDays(t, 1)) {
        const key = localDayKey(t);
        out.push({ t, value: map.get(key) ?? 0 });
    }
    return out;
}

function binsToChartPoints(
    bins: TimelineBin[],
    granularity: TimelineGranularity,
    metric: TimelineMetric,
): ChartPoint[] {
    if (granularity === 'hour') return fillHourGaps(bins, metric);
    return fillLocalDayGaps(aggregateToLocalDayBins(bins, metric));
}

/** 所有日期的本地小时访问合计（24 槽） */
function overlayToLocalDayDistribution(bins: TimelineBin[], metric: TimelineMetric): ChartPoint[] {
    const sums = new Array<number>(STATS_SLOTS_PER_LOCAL_DAY).fill(0);
    for (const b of bins) {
        const t = parseUtcHour(b.hour);
        if (!t) continue;
        sums[t.getHours()] += binCount(b, metric);
    }
    const ref = new Date(2000, 0, 1);
    return sums.map((value, h) => ({
        t: new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(), h),
        value,
    }));
}

/** Hour + Sum to 1 week：各周叠到同一周模板，168 个本地小时槽（周日 0:00 起） */
function overlayToLocalWeekHourDistribution(bins: TimelineBin[], metric: TimelineMetric): ChartPoint[] {
    const sums = new Array<number>(WEEK_HOUR_SLOTS).fill(0);
    for (const b of bins) {
        const t = parseUtcHour(b.hour);
        if (!t) continue;
        sums[t.getDay() * STATS_SLOTS_PER_LOCAL_DAY + t.getHours()] += binCount(b, metric);
    }
    const refSunday = new Date(2000, 0, 2);
    return sums.map((value, idx) => {
        const dow = Math.floor(idx / STATS_SLOTS_PER_LOCAL_DAY);
        const hour = idx % STATS_SLOTS_PER_LOCAL_DAY;
        return {
            t: new Date(refSunday.getFullYear(), refSunday.getMonth(), refSunday.getDate() + dow, hour),
            value,
        };
    });
}

/** Day + Sum to 1 week：各周按本地星期合计（7 槽，周日=0） */
function overlayToLocalWeekDistribution(bins: TimelineBin[], metric: TimelineMetric): ChartPoint[] {
    const sums = new Array<number>(7).fill(0);
    for (const { day, value } of aggregateToLocalDayBins(bins, metric)) {
        sums[parseLocalDay(day).getDay()] += value;
    }
    const refSunday = new Date(2000, 0, 2);
    return sums.map((value, dow) => ({
        t: addLocalDays(refSunday, dow),
        value,
    }));
}

function prepareChartData(
    bins: TimelineBin[],
    granularity: TimelineGranularity,
    overlay: TimelineOverlay,
    metric: TimelineMetric,
): ChartPoint[] {
    const view = resolveOverlayView(granularity, overlay);
    if (view === 'day24') return overlayToLocalDayDistribution(bins, metric);
    if (view === 'week168') return overlayToLocalWeekHourDistribution(bins, metric);
    if (view === 'week7') return overlayToLocalWeekDistribution(bins, metric);
    return binsToChartPoints(bins, granularity, metric);
}

function binEnd(t: Date, granularity: TimelineGranularity, overlay: TimelineOverlay): Date {
    const view = resolveOverlayView(granularity, overlay);
    if (view === 'day24' || view === 'week168') return overlayHourBinEnd(t);
    if (view === 'week7') return addLocalDays(t, 1);
    return granularity === 'hour' ? d3.utcHour.offset(t, STATS_PERIOD_HOURS) : addLocalDays(t, 1);
}

type TimelineXZoomState = { transform: d3.ZoomTransform | null };

const ZOOM_MIN_POINTS = 2;

function timelineZoomFilter(event: Event, fullscreen: boolean): boolean {
    if (event.type === 'wheel') {
        if (!fullscreen && !(event as WheelEvent).ctrlKey) return false;
        event.preventDefault();
        return true;
    }
    return !(event as MouseEvent).ctrlKey && (event as MouseEvent).button !== 1;
}

function renderTimelineChart(
    host: d3.Selection<HTMLDivElement, unknown, HTMLElement, unknown>,
    bins: TimelineBin[],
    metric: TimelineMetric,
    granularity: TimelineGranularity,
    overlay: TimelineOverlay,
    fullscreen: boolean,
    xZoom: TimelineXZoomState,
): void {
    host.selectAll('*').remove();
    const data = prepareChartData(bins, granularity, overlay, metric);
    const countLabel = metricCountLabel(metric);
    const overlayView = resolveOverlayView(granularity, overlay);
    if (data.length === 0) {
        host.append('p').style('margin', '0').style('font-size', '13px').text('No timeline data yet.');
        return;
    }

    const hostEl = host.node() as HTMLDivElement;
    const { width: chartWidth, height: chartHeight } = measureChart(hostEl, fullscreen);
    const innerW = chartWidth - MARGIN.left - MARGIN.right;
    const innerH = chartHeight - MARGIN.top - MARGIN.bottom;

    const x0 = d3
        .scaleTime()
        .domain([data[0].t, binEnd(data[data.length - 1].t, granularity, overlay)])
        .range([0, innerW]);

    const tickCount = Math.min(data.length, 16);
    const xTickFormat =
        overlayView === 'day24'
            ? (d: Date | d3.NumberValue) => formatOverlayDayAxis(d as Date)
            : overlayView === 'week168'
              ? (d: Date | d3.NumberValue) => formatOverlayWeekHourAxis(d as Date)
              : overlayView === 'week7'
                ? (d: Date | d3.NumberValue) => formatOverlayWeekAxis(d as Date)
                : granularity === 'hour'
                  ? (d: Date | d3.NumberValue) => formatLocalAxisHour(d as Date)
                  : (d: Date | d3.NumberValue) => formatLocalDate(d as Date);

    const svg = host
        .append('svg')
        .attr('width', chartWidth)
        .attr('height', chartHeight)
        .attr('role', 'img')
        .attr(
            'aria-label',
            overlayView === 'day24'
                ? `${countLabel} by hour of day (all dates summed, local time).`
                : overlayView === 'week168'
                  ? `${countLabel} by hour within week (all weeks summed, local time).`
                  : overlayView === 'week7'
                    ? `${countLabel} by weekday (all weeks summed, local time).`
                    : granularity === 'hour'
                      ? `${countLabel} per hour (local time). Drag to pan; Ctrl+wheel or fullscreen wheel to zoom; double-click to reset.`
                      : `${countLabel} per day (local time). Drag to pan; Ctrl+wheel or fullscreen wheel to zoom; double-click to reset.`,
        );

    const marginTransform = `translate(${MARGIN.left},${MARGIN.top})`;
    const g = svg.append('g').attr('transform', marginTransform);

    const yAxisG = g.append('g').attr('class', 'visit-stats-timeline-y');

    const xAxisG = g.append('g').attr('transform', `translate(0,${innerH})`).attr('class', 'visit-stats-timeline-x');

    const plotG = g.append('g').attr('class', 'visit-stats-timeline-plot');
    plotG
        .append('rect')
        .attr('class', 'visit-stats-timeline-plot-bg')
        .attr('width', innerW)
        .attr('height', innerH)
        .attr('fill', 'transparent');

    const weekendG = plotG.append('g').attr('class', 'visit-stats-timeline-weekend-bg');

    const tip = host
        .append('div')
        .attr('class', 'visit-stats-timeline-tip')
        .style('position', 'absolute')
        .style('pointer-events', 'none')
        .style('visibility', 'hidden')
        .style('font-size', '12px')
        .style('padding', '4px 8px')
        .style('border-radius', '4px')
        .style('background', 'var(--panel-bg, rgba(0,0,0,0.75))')
        .style('color', 'var(--text-color, #fff)');

    host.style('position', 'relative');

    const weekendData = overlayView === 'day24' ? [] : data.filter((d) => isLocalWeekend(d.t));

    const tipHtml = (d: ChartPoint) => {
        const valueLabel = formatMetricValue(d.value, metric);
        const end = binEnd(d.t, granularity, overlay);
        if (overlayView === 'day24') {
            return `${formatOverlayDayAxis(d.t)} – ${formatOverlayDayAxis(end)} (all dates)<br/>${valueLabel}`;
        }
        if (overlayView === 'week168') {
            return `${formatOverlayWeekHourAxis(d.t)} – ${formatOverlayWeekHourAxis(end)} (all weeks)<br/>${valueLabel}`;
        }
        if (overlayView === 'week7') {
            return `${formatOverlayWeekAxis(d.t)} (all weeks)<br/>${valueLabel}`;
        }
        if (granularity === 'hour') {
            return `${formatLocalDateTime(d.t)} – ${formatLocalDateTime(end)}<br/>${valueLabel}`;
        }
        return `${formatLocalDate(d.t)}<br/>${valueLabel}`;
    };

    const barsG = plotG.append('g').attr('class', 'visit-stats-timeline-bars');
    barsG
        .selectAll('rect.visit-stats-timeline-bar')
        .data(data)
        .join('rect')
        .attr('class', 'visit-stats-timeline-bar')
        .attr('fill', BAR_COLOR)
        .style('cursor', 'pointer')
        .attr('opacity', (d) => (d.value > 0 ? 0.85 : 0.15))
        .on('mouseenter', function (_event, d) {
            d3.select(this).attr('opacity', 1);
            tip.style('visibility', 'visible').html(tipHtml(d));
        })
        .on('mousemove', (event) => {
            const box = hostEl.getBoundingClientRect();
            tip.style('left', `${event.clientX - box.left + 8}px`).style('top', `${event.clientY - box.top - 28}px`);
        })
        .on('mouseleave', function () {
            const d = d3.select(this).datum() as ChartPoint;
            d3.select(this).attr('opacity', d.value > 0 ? 0.85 : 0.15);
            tip.style('visibility', 'hidden');
        });

    const binOverlapsVisibleDomain = (d: ChartPoint, x: d3.ScaleTime<number, number>) => {
        const [vis0, vis1] = x.domain();
        const start = d.t.getTime();
        const end = binEnd(d.t, granularity, overlay).getTime();
        return end > vis0.getTime() && start < vis1.getTime();
    };

    const yForVisible = (x: d3.ScaleTime<number, number>) => {
        const visible = data.filter((d) => binOverlapsVisibleDomain(d, x));
        const yMax = d3.max(visible, (d) => d.value) ?? 1;
        return d3.scaleLinear().domain([0, yMax]).nice().range([innerH, 0]);
    };

    const applyView = (x: d3.ScaleTime<number, number>) => {
        const yVis = yForVisible(x);
        const yTop = yVis.domain()[1] ?? 1;
        xAxisG
            .call(d3.axisBottom(x).tickValues(x.ticks(tickCount)).tickFormat(xTickFormat))
            .selectAll('text')
            .attr('transform', 'rotate(-24)')
            .style('text-anchor', 'end');
        yAxisG
            .call(d3.axisLeft(yVis).ticks(Math.min(5, yTop + 1)).tickFormat(d3.format('d')))
            .call((sel) => sel.select('.domain').remove());
        weekendG
            .selectAll('rect')
            .data(weekendData)
            .join('rect')
            .attr('x', (d) => x(d.t))
            .attr('y', 0)
            .attr('width', (d) => Math.max(1, x(binEnd(d.t, granularity, overlay)) - x(d.t)))
            .attr('height', innerH)
            .attr('fill', WEEKEND_BG)
            .attr('pointer-events', 'none');
        barsG
            .selectAll<SVGRectElement, ChartPoint>('rect.visit-stats-timeline-bar')
            .attr('x', (d) => x(d.t))
            .attr('width', (d) => Math.max(1, x(binEnd(d.t, granularity, overlay)) - x(d.t) - 1))
            .attr('y', (d) => yVis(d.value))
            .attr('height', (d) => innerH - yVis(d.value));
    };

    const initialTransform = xZoom.transform ?? d3.zoomIdentity;
    applyView(initialTransform.rescaleX(x0));

    if (overlayView !== 'day24' && overlayView !== 'week7' && data.length >= ZOOM_MIN_POINTS) {
        const zoom = d3
            .zoom<SVGGElement, unknown>()
            .scaleExtent([1, 48])
            .translateExtent([
                [0, 0],
                [innerW, innerH],
            ])
            .extent([
                [0, 0],
                [innerW, innerH],
            ])
            .filter((event) => timelineZoomFilter(event, fullscreen))
            .on('zoom', (event) => {
                plotG.attr('transform', null);
                xZoom.transform = event.transform;
                applyView(event.transform.rescaleX(x0));
            });

        plotG
            .style('cursor', 'grab')
            .call(zoom)
            .call(zoom.transform, initialTransform)
            .on('dblclick.zoom', (event) => {
                event.preventDefault();
                xZoom.transform = null;
                plotG.call(zoom.transform, d3.zoomIdentity);
            });
    }
}

function syncFullscreenButton(btn: d3.Selection<HTMLButtonElement, unknown, null, undefined>, dialogEl: HTMLElement): void {
    const on = timelineDialogFullscreenExpanded(dialogEl);
    btn.text(on ? '×' : '⛶').attr('title', on ? 'Exit fullscreen' : 'Fullscreen');
}

export async function showVisitStatsTimelineDialog(api: TextAnalysisAPI): Promise<void> {
    let binsCache: TimelineBin[] = [];
    let metricCache: TimelineMetric = 'active_visits';
    let granularityCache: TimelineGranularity = 'hour';
    let overlayCache: TimelineOverlay = 'none';
    const xZoom: TimelineXZoomState = { transform: null };
    let dialogEl: HTMLDivElement | null = null;
    let chartHost: d3.Selection<HTMLDivElement, unknown, null, undefined> | null = null;
    let fullscreenBtn: d3.Selection<HTMLButtonElement, unknown, null, undefined> | null = null;

    const rerender = () => {
        if (!dialogEl || !chartHost || chartHost.empty()) return;
        renderTimelineChart(
            chartHost,
            binsCache,
            metricCache,
            granularityCache,
            overlayCache,
            timelineDialogFullscreenExpanded(dialogEl),
            xZoom,
        );
        if (fullscreenBtn) syncFullscreenButton(fullscreenBtn, dialogEl);
    };

    const scheduleRerender = () => requestAnimationFrame(() => rerender());

    const onLayoutChange = () => {
        if (dialogEl && timelineDialogFullscreenExpanded(dialogEl)) scheduleRerender();
    };

    showDialog({
        title: 'Visits timeline',
        content: (dialog) => {
            const shell = d3.select(dialog.node()!.parentElement!);
            dialogEl = shell.node() as HTMLDivElement;
            shell.classed('visit-stats-timeline-dialog', true);

            const wrap = dialog
                .append('div')
                .attr('class', 'dialog-form-container dialog-form-container--fill');
            const toolbar = wrap
                .append('div')
                .attr('class', 'visit-stats-timeline-toolbar')
                .style('display', 'flex')
                .style('flex-wrap', 'wrap')
                .style('align-items', 'center')
                .style('gap', '12px')
                .style('margin', '0 0 8px')
                .style('font-size', '13px');

            const metricSelect = toolbar
                .append('select')
                .attr('class', 'visit-stats-timeline-metric')
                .style('width', 'fit-content');
            metricSelect
                .selectAll('option')
                .data(METRIC_OPTIONS)
                .join('option')
                .attr('value', (d) => d.value)
                .property('selected', (d) => d.value === metricCache)
                .text((d) => d.label);

            const granularitySelect = toolbar
                .append('select')
                .attr('class', 'visit-stats-timeline-granularity')
                .style('width', 'fit-content');
            granularitySelect
                .selectAll('option')
                .data([
                    { value: 'hour', label: 'Hour' },
                    { value: 'day', label: 'Day' },
                ] as const)
                .join('option')
                .attr('value', (d) => d.value)
                .property('selected', (d) => d.value === granularityCache)
                .text((d) => d.label);
            const overlayDayLabel = toolbar
                .append('label')
                .style('display', 'inline-flex')
                .style('align-items', 'center')
                .style('gap', '4px')
                .style('cursor', 'pointer');
            const overlayDayInput = overlayDayLabel
                .append('input')
                .attr('type', 'checkbox')
                .property('checked', overlayCache === 'day');
            overlayDayLabel.append('span').text('Sum to 1 day');

            const overlayWeekLabel = toolbar
                .append('label')
                .style('display', 'inline-flex')
                .style('align-items', 'center')
                .style('gap', '4px')
                .style('cursor', 'pointer');
            const overlayWeekInput = overlayWeekLabel
                .append('input')
                .attr('type', 'checkbox')
                .property('checked', overlayCache === 'week');
            overlayWeekLabel.append('span').text('Sum to 1 week');

            const syncToolbar = () => {
                const hourMode = granularityCache === 'hour';
                overlayDayLabel.style('display', hourMode ? 'inline-flex' : 'none');
                if (!hourMode && overlayCache === 'day') {
                    overlayCache = 'none';
                    overlayDayInput.property('checked', false);
                }
            };

            metricSelect.on('change', function () {
                metricCache = (this as HTMLSelectElement).value as TimelineMetric;
                xZoom.transform = null;
                scheduleRerender();
            });

            granularitySelect.on('change', function () {
                granularityCache = (this as HTMLSelectElement).value as TimelineGranularity;
                xZoom.transform = null;
                syncToolbar();
                scheduleRerender();
            });

            const setOverlay = (next: TimelineOverlay) => {
                if (next === 'day' && granularityCache !== 'hour') next = 'none';
                overlayCache = next;
                overlayDayInput.property('checked', next === 'day');
                overlayWeekInput.property('checked', next === 'week');
                syncToolbar();
                xZoom.transform = null;
                scheduleRerender();
            };

            overlayDayInput.on('change', function () {
                setOverlay((this as HTMLInputElement).checked ? 'day' : 'none');
            });
            overlayWeekInput.on('change', function () {
                setOverlay((this as HTMLInputElement).checked ? 'week' : 'none');
            });
            syncToolbar();

            chartHost = wrap.append('div').attr('class', 'visit-stats-timeline-chart');
            chartHost.append('p').style('margin', '0 0 8px').style('font-size', '13px').style('opacity', '0.75').text('Loading…');

            fullscreenBtn = shell
                .select('.dialog-buttons')
                .insert('button', '.dialog-button.cancel')
                .attr('type', 'button')
                .attr('class', 'dialog-button cancel visit-stats-timeline-fullscreen-btn')
                .attr('title', 'Fullscreen')
                .text('⛶')
                .on('click', async function () {
                    if (!dialogEl) return;
                    try {
                        await toggleTimelineDialogFullscreen(dialogEl);
                    } catch {
                        /* request/exit rejected */
                    }
                    scheduleRerender();
                });

            document.addEventListener('fullscreenchange', onLayoutChange);
            window.addEventListener('resize', onLayoutChange);

            void (async () => {
                try {
                    const data = await api.getVisitStatsActiveVisitsTimeline();
                    if (!data?.success) throw new Error(data?.error ?? 'Failed to load timeline');
                    binsCache = (data.bins ?? []).map((b) => ({
                        hour: b.hour,
                        active_visits: b.active_visits ?? 0,
                        active_sec: b.active_sec ?? 0,
                    }));
                    xZoom.transform = null;
                    chartHost!.select('p').remove();
                    scheduleRerender();
                } catch (e) {
                    chartHost!.selectAll('*').remove();
                    const msg = e instanceof Error ? e.message : String(e);
                    chartHost!
                        .append('p')
                        .style('margin', '0')
                        .style('font-size', '13px')
                        .text(`Failed to load timeline: ${msg}`);
                }
            })();

            return { focus: () => {} };
        },
        onCancel: () => {
            document.removeEventListener('fullscreenchange', onLayoutChange);
            window.removeEventListener('resize', onLayoutChange);
            if (dialogEl && document.fullscreenElement === dialogEl) {
                void document.exitFullscreen();
            }
        },
        cancelText: tr('Exit'),
        confirmText: null,
        width: 'clamp(360px, 94vw, 620px)',
    });
}
