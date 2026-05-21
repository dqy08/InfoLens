/**
 * Top-K 条形图 HTML 渲染（行结构、省略行、高亮列），供 Tooltip、语义 debug、归因复用。
 *
 * 主题与颜色：
 * ——不采用「内联写死主题色 + 切换 data-theme 时用 JS 整段重绘 innerHTML」的做法。
 * 行/条/说明文字的颜色由 `.predictions-table` 下的类名配合 `start.scss` 中 `:root` /
 * `:root[data-theme="dark"]` 的 `--tooltip-text-normal`、`--tooltip-text-selected`、
 * `--tooltip-text-detail` 随主题变化；仅条形宽度等纯数据量保留内联 style。
 *
 * 从 {@link FrontendToken} 拼出上述 HTML 见 {@link ./tooltipPredictionsFromToken}。
 */

import * as d3 from 'd3';
import { processCandidateText } from './tokenDisplayUtils';

/**
 * 与 analysis.html 主视图 Tooltip 中 Top-K 条形图概率列一致（{@link renderTopkChartHtml} 默认格式）。
 * @param v 模型给出的概率，区间 [0, 1]
 */
export function formatTopkTooltipProbabilityPercent(v: number): string {
    return d3.format('.3g')(v * 100) + '%';
}

/** Tooltip 默认条形宽度 */
const MAX_BAR_WIDTH = 60;
/** Semantic debug 专用：更大条形与列宽，tooltip 不受影响 */
const SEMANTIC_DEBUG_MAX_BAR = 100;
const SEMANTIC_DEBUG_BAR_CELL = 180;

/** 插入数据中表示省略行的占位符，左侧列空、token 列显示 ⋮ */
export const TOPK_SEP = '\0__TOPK_SEP__\0';

/** 与后端 round_to_sig_figs 及 JSON 往返对齐，用于 top-k 行与 attribution target 概率配对 */
function probabilitiesEffectivelyEqual(a: number, b: number): boolean {
    if (a === b) return true;
    const d = Math.abs(a - b);
    return d < 1e-12 || d / Math.max(Math.abs(a), Math.abs(b), 1e-15) < 1e-9;
}

export interface TopkChartOptions {
    /** 高亮的 token（与当前 token 一致时用 `.topk-chart-row--selected`） */
    selectedToken?: string;
    /**
     * 与 selectedToken 同时传入时，只高亮「第一个」token 与 prob 均匹配的行（避免多 id 解码同形时多行同时选中）。
     * 不传时退化为仅按 token 匹配第一个。
     */
    selectedProb?: number;
    /** 条形最大宽度 px */
    maxBarWidth?: number;
    /** 条形列单元格宽度 px */
    barCellWidth?: number;
    numFormat?: (n: number) => string;
    /** 为候选行加 data-topk-pick 与指针样式（归因弹窗点选目标用） */
    interactivePickable?: boolean;
}

/** 若 actualToken 不在行中则追加 ⋮ + 该行；供 {@link prepareTopkDisplayRows} 专用 */
function mergeTopkRowsWithActualTokenIfAbsent(
    rows: Array<{ token: string; prob: number }>,
    actualToken: string,
    actualProb: number
): Array<{ token: string; prob: number }> {
    if (!rows.length || actualToken === '') return rows;
    if (!Number.isFinite(actualProb)) return rows;
    if (rows.some((d) => d.token === actualToken)) return rows;
    return [...rows, { token: TOPK_SEP, prob: 0 }, { token: actualToken, prob: actualProb }];
}

export type TopkDisplaySelection = { token: string; prob: number };

/** 从任意来源的 token + 概率构造可选的展示选中项；不合法时返回 `undefined`。 */
export function topkDisplaySelection(
    token: string | undefined | null,
    prob: number | null | undefined
): TopkDisplaySelection | undefined {
    if (token == null || token === '') return undefined;
    if (prob == null || !Number.isFinite(prob)) return undefined;
    return { token, prob };
}

/**
 * 统一入口：在服务端/模型给出的 base top-k 行上，按需合并「选中 token」行。
 * - `selection` 为 `undefined`：不追加（仅展示 base，如无真实信息密度则 Tooltip 不传 selection）。
 * - `selection` 有值且 token 已出现在 base 中：不重复追加。
 * - 条形图红色高亮由调用方对 {@link renderTopkChartHtml} 传入 `selectedToken`（及可选 `selectedProb`）。
 */
export function prepareTopkDisplayRows(
    baseRows: Array<{ token: string; prob: number }>,
    selection: TopkDisplaySelection | undefined
): Array<{ token: string; prob: number }> {
    if (!selection || !baseRows.length) return baseRows;
    const { token, prob } = selection;
    if (token === '' || !Number.isFinite(prob)) return baseRows;
    return mergeTopkRowsWithActualTokenIfAbsent(baseRows, token, prob);
}

/** 计算应高亮的行下标：优先 token+prob 唯一命中第一个，否则第一个 token 命中 */
function resolveSelectedRowIndex(
    data: Array<{ token: string; prob: number }>,
    selectedToken: string | undefined,
    selectedProb: number | undefined
): number {
    if (selectedToken === undefined || selectedToken === '') return -1;
    if (selectedProb != null && Number.isFinite(selectedProb)) {
        const i = data.findIndex(
            (d) =>
                d.token !== TOPK_SEP &&
                d.token === selectedToken &&
                probabilitiesEffectivelyEqual(d.prob, selectedProb)
        );
        if (i >= 0) return i;
    }
    return data.findIndex((d) => d.token !== TOPK_SEP && d.token === selectedToken);
}

/** 生成与 Tooltip 完全一致的 TopK 图表 HTML */
export function renderTopkChartHtml(
    data: Array<{ token: string; prob: number }>,
    options?: TopkChartOptions
): string {
    if (!data.length) return '';

    const maxBar = options?.maxBarWidth ?? MAX_BAR_WIDTH;
    const numF = options?.numFormat ?? formatTopkTooltipProbabilityPercent;

    /** 条形满宽对应概率 100%（1），与显示的百分比刻度一致 */
    const scale = d3.scaleLinear().domain([0, 1]).range([0, maxBar]);
    const barCellW = options?.barCellWidth ?? 110;

    const pickable = options?.interactivePickable === true;
    const highlightRowIndex = resolveSelectedRowIndex(data, options?.selectedToken, options?.selectedProb);

    const rows = data.map((d, i) => {
        if (d.token === TOPK_SEP) {
            return `<div class="row topk-chart-row topk-chart-row--ellipsis">⋮</div>`;
        }
        const isSelected = highlightRowIndex >= 0 && i === highlightRowIndex;
        const rowClasses = [
            'row',
            'topk-chart-row',
            pickable ? 'topk-chart-row--pickable' : '',
            isSelected ? 'topk-chart-row--selected' : '',
        ]
            .filter(Boolean)
            .join(' ');
        const bar = `<div class="topk-chart-bar-cell" style="width:${barCellW}px;">` +
            `<span class="topk-chart-bar-fill" style="width: ${scale(d.prob)}px;"></span>` +
            ` <span class="topk-chart-prob">${numF(d.prob)}</span></div>`;
        const text = `<div class="topk-chart-token-cell">${processCandidateText(d.token)}</div>`;
        const pickAttr = pickable ? ` data-topk-pick="${encodeURIComponent(d.token)}"` : '';
        return `<div class="${rowClasses}"${pickAttr}>${bar}${text}</div>`;
    });

    return rows.join('');
}

/** 生成完整 TopK 图表 HTML（含容器），用于独立展示如 semantic debug。 */
export function renderTopkChartFullHtml(data: Array<{ token: string; prob: number }>, options?: TopkChartOptions): string {
    const opts = options ?? {};
    const semanticOpts = {
        ...opts,
        maxBarWidth: opts.maxBarWidth ?? SEMANTIC_DEBUG_MAX_BAR,
        barCellWidth: opts.barCellWidth ?? SEMANTIC_DEBUG_BAR_CELL,
    };
    const rows = renderTopkChartHtml(data, semanticOpts);
    return rows ? `<div class="semantic-debug-topk-chart predictions predictions-table">${rows}</div>` : '';
}
