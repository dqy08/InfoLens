import * as d3 from 'd3';
import { DirectedGraph } from 'graphology';
import { calculateSurprisal, type D3Sel } from '../utils/Util';
import { visualizeSpecialChars } from '../utils/tokenDisplayUtils';
import {
    clampDagEdgeTopPCoverage,
    collectGenAttrDagExcludeIntervals,
    DAG_EDGE_TOP_P_COVERAGE_DEFAULT,
    excludeNodeAggregatedEntries,
    phase2RankAndSparsify,
    type PromptTokenSpan,
} from './genAttributeDagPreprocess';
import { DAG_EDGE_MIN_DISPLAY_OPACITY } from './genAttributeDagEdgeDisplay';
import {
    computeMutualInformationRatio,
    computeConditionalInformationRatio,
    FULL_CONFIDENCE_PROBABILITY_BASELINE,
} from '../utils/surprisalMath';
import { isOffsetSpanFullyExcluded } from './attributionDisplayModel';
import {
    alignAndAggregateByNode,
    clearGenAttributeDagAlignmentWarnDedupe,
    type NodeInterval,
    type PieceEntry,
} from './genAttributeDagIntervalResolve';
import type { TokenGenStep } from './tokenGenAttributionRunner';
import { createGenAttributeDagTextMeasure } from './genAttributeDagTextMeasure';
import { formatTopkTooltipProbabilityPercent } from '../utils/topkChartUtils';
import {
    CSS_PSEUDO_FULLSCREEN_CHANGE_EVENT,
    dagResultsSurfaceFullscreenExpanded,
    detachDagPseudoFullscreenIfPresent,
    runDagFullscreenToggleWithPseudoWorkaround,
} from './genAttributeDagFullscreenWorkaround';
import {
    clampLinearArcAdjacentGap,
    LINEAR_ARC_ADJACENT_GAP_DEFAULT,
    LINEAR_ARC_ADJACENT_GAP_MAX,
    LINEAR_ARC_ADJACENT_GAP_MIN,
    LINEAR_ARC_BEZIER_HANDLE_INSET_FRACTION,
    paintLinearArcLayout,
} from './genAttributeDagViewLinearArcMode';
import { paintTextFlowLayout } from './genAttributeDagViewTextFlowMode';
import { paintSpiralLayout } from './genAttributeDagViewSpiralMode';
import { tr } from '../lang/i18n-lite';

/** 与 {@link ToolTip} 中 surprisal 数值格式一致（`.3g`） */
const DAG_TITLE_SURPRISAL_FMT = d3.format('.3g');

/** 再次挂载前执行上一轮 detach（当前为空操作，保留扩展点） */
const detachGenAttributeDagPanel = new WeakMap<HTMLElement, () => void>();

/** 节点布局模式：`text-flow` 按文字排版层几何；`linear-arc` 按节点插入序线性排布 + 弧线连边；`spiral` 螺旋排布。 */
export type DagLayoutMode = 'text-flow' | 'linear-arc' | 'spiral';

export const DAG_COMPACTNESS_DEFAULT = 0.5;
/** 下限取小正数以满足 {@link readDisplayScaleFromCss}「必须为正」且不出现零宽度边线。 */
export const DAG_COMPACTNESS_MIN = 0.05;
export const DAG_COMPACTNESS_MAX = 1;

export function clampDagCompactness(n: number): number {
    if (!Number.isFinite(n)) return DAG_COMPACTNESS_DEFAULT;
    return Math.min(DAG_COMPACTNESS_MAX, Math.max(DAG_COMPACTNESS_MIN, n));
}



/** 节点 CI 视觉放大开关；`false` 时所有生成节点 ciVisualScale 恒为 1×，下次 update() 起生效。 */
let dagNodeCiVisualScaleEnabled = true;
export function setDagNodeCiVisualScaleEnabled(enabled: boolean): void {
    dagNodeCiVisualScaleEnabled = enabled;
}

/** 高惊讶度目标边弱化开关；`false` 时 mutualInformationRatio 恒为 1（不弱化），下次 update() 起生效。 */
let dagEdgeWeakenHighSurprisalEnabled = true;
export function setDagEdgeWeakenHighSurprisalEnabled(enabled: boolean): void {
    dagEdgeWeakenHighSurprisalEnabled = enabled;
}

/**
 * DAG 生成节点矩形/标签缩放：CI=0→1×，CI=1→2×（prompt 节点恒用 1，见建点处）。
 * p > {@link FULL_CONFIDENCE_PROBABILITY_BASELINE}（surprisal < 3 bit）时截断为 1×，不放大。
 * {@link dagNodeCiVisualScaleEnabled} 为 false 时恒返回 1。
 */
function dagGeneratedNodeCiVisualScale(targetProb: number | undefined): number {
    if (!dagNodeCiVisualScaleEnabled) return 1;
    if (targetProb !== undefined && Number.isFinite(targetProb) && targetProb > FULL_CONFIDENCE_PROBABILITY_BASELINE) return 1;
    return 1 + computeConditionalInformationRatio(targetProb);
}

/** 原生 `<title>` 中 CI/MI 百分号展示，与 Top-K 概率列 {@link formatTopkTooltipProbabilityPercent} 同形。 */
function formatCiMiRatiosLineForTooltip(ciRatio: number, miRatio: number): string {
    const ci = Number.isFinite(ciRatio) ? formatTopkTooltipProbabilityPercent(ciRatio) : String(ciRatio);
    const mi = Number.isFinite(miRatio) ? formatTopkTooltipProbabilityPercent(miRatio) : String(miRatio);
    return `CI/MI: ${ci} / ${mi}`;
}

/** 边原生 `<title>` 中互信息率 α 的展示（节点 title 改用 {@link formatCiMiRatiosLineForTooltip}）。 */
function formatMutualInformationRatioForTooltip(miRatio: number): string {
    if (!Number.isFinite(miRatio)) return String(miRatio);
    return formatTopkTooltipProbabilityPercent(miRatio);
}

export {
    clampLinearArcAdjacentGap,
    LINEAR_ARC_ADJACENT_GAP_DEFAULT,
    LINEAR_ARC_ADJACENT_GAP_MAX,
    LINEAR_ARC_ADJACENT_GAP_MIN,
    LINEAR_ARC_BEZIER_HANDLE_INSET_FRACTION,
};

/** 图中节点业务字段（与 graphology 节点 attributes 为同一对象） */
type DagNodeAttrs = {
    id: string;
    label: string;
    /** prompt 节点为 -1；第 k 个生成 token 为 k，从 0 起（与按序 `update` 调用一致） */
    step: number;
    /**
     * 节点在整段 context 字符串中的区间 `[start, end)`，与建点时的 offset 同源。
     * 独立于 `id` 保存，使区间查询不依赖 id 形如 `"s_e"` 的隐式契约，便于将来节点合并时脱钩。
     */
    start: number;
    end: number;
    /**
     * 节点矩形中心坐标。center 不随 CI 缩放变化，故同行 token 的 cy 始终相等，
     * 可直接用于 {@link snapSubwordNode} 同行检测，无需额外 baseY 字段。
     */
    cx: number;
    cy: number;
    /** 测量层几何 × display-scale × CI 缩放 后的宽、高 */
    nodeW: number;
    nodeH: number;
    /** CI 视觉缩放倍数 `1 + CI` ∈ [1, 2]；prompt 节点为 `1`。供 CSS 字号变量使用。 */
    ciVisualScale: number;
    /** {@link visualizeSpecialChars}（DAG：仅「空格后是 [A-Za-z0-9]」保留空格，其余空格为 ·），建点后不变 */
    displayLabel: string;
    /** 原生 `<title>` 全文（与 `DISABLE_DAG_NODE_TOOLTIPS` 无关，便于切换时不必重算） */
    nativeTitleText: string;
};

type DagNode = DagNodeAttrs;

type DagLink = {
    source: string;
    target: string;
    /**
     * 候选池内 max 归一后的归因分，区间约 [0, 1]；作为 `stroke-opacity` 的基项（再乘 {@link mutualInformationRatio}）。
     * 池内稀疏化与建边前过滤均使用 {@link DAG_EDGE_MIN_DISPLAY_OPACITY}（见 genAttributeDagEdgeDisplay）；条件为 {@link dagLinkStrokeOpacity} 不低于该阈值。
     */
    normalizedScore?: number;
    /** 互信息率：仅作为本步入边的视觉透明度系数，不参与归因筛选。 */
    mutualInformationRatio?: number;
    /** 本步内：该边池内 L1 份额在「仅可见边」（{@link DAG_EDGE_MIN_DISPLAY_OPACITY} 过滤后）上的占比；用于原生 title「Fan in share」 */
    scoreShare?: number;
    /** 与 `console.warn('[genAttributeDagView.align] …')` 正文一致（可多条，换行拼接） */
    alignmentNote?: string;
    /** 边创建时固定的 `<title>` 全文 */
    titleText: string;
};

/** 与 {@link refreshNodeLinkHighlight} 中边的 `stroke-opacity` 一致：`normalizedScore × mutualInformationRatio`（开关关闭时 MI 系数恒为 1）。 */
function dagLinkStrokeOpacity(d: Pick<DagLink, 'normalizedScore' | 'mutualInformationRatio'>): number {
    const mi = dagEdgeWeakenHighSurprisalEnabled ? (d.mutualInformationRatio ?? 1) : 1;
    return (d.normalizedScore ?? 1) * mi;
}

function dagLinkEndpointKey(source: string, target: string): string {
    return `${source}->${target}`;
}

/**
 * 流式增量：任一端节点 span 完全落在排除区间内则删边（不重算 Top‑N，与全量重放可轻微不一致）。
 * 同步 graphology 与并行 `links`。
 */
function pruneDagLinksTouchingFullyExcludedNodes(
    graph: DirectedGraph<DagNodeAttrs>,
    links: DagLink[],
    intervals: [number, number][],
): void {
    if (intervals.length === 0) return;

    const incidentEdgeIds = new Set<string>();
    graph.forEachNode((nodeId, nodeAttrs) => {
        if (!isOffsetSpanFullyExcluded(nodeAttrs.start, nodeAttrs.end, intervals)) return;
        for (const edgeId of graph.inEdges(nodeId)) incidentEdgeIds.add(edgeId);
        for (const edgeId of graph.outEdges(nodeId)) incidentEdgeIds.add(edgeId);
    });
    if (incidentEdgeIds.size === 0) return;

    const removedLinkKeys = new Set<string>();
    for (const edgeId of incidentEdgeIds) {
        if (!graph.hasEdge(edgeId)) continue;
        const source = graph.source(edgeId);
        const target = graph.target(edgeId);
        removedLinkKeys.add(dagLinkEndpointKey(source, target));
        graph.dropEdge(edgeId);
    }
    if (removedLinkKeys.size === 0) return;

    let write = 0;
    for (const link of links) {
        if (removedLinkKeys.has(dagLinkEndpointKey(link.source, link.target))) {
            continue;
        }
        links[write++] = link;
    }
    links.length = write;
}

const SVG_MIN_W = 320;
const SVG_MIN_H = 280;

/**
 * `.gen-attr-dag-stack` 布局尺寸(px)，供 SVG width/height 与 `fitViewportToContent` 共用。
 * 用 offsetWidth/offsetHeight（布局流尺寸）而非 getBoundingClientRect，
 * 以保证 SVG 正确填满容器——两者在有 CSS transform 时会不同。
 */
function stackLayoutViewportPx(stackEl: HTMLElement): { w: number; h: number } {
    return {
        w: Math.max(stackEl.offsetWidth, SVG_MIN_W),
        h: Math.max(stackEl.offsetHeight, SVG_MIN_H),
    };
}

/** text-flow：在「抵消 display-scale」基准上的初始 zoom 倍率（d3 的 k） */
const DAG_INITIAL_ZOOM_BOOST_TEXT_FLOW = 2;
/** linear-arc：同上 */
const DAG_INITIAL_ZOOM_BOOST_LINEAR_ARC = 4;
/** spiral：同上 */
const DAG_INITIAL_ZOOM_BOOST_SPIRAL = 2;

function dagInitialZoomBoost(mode: DagLayoutMode): number {
    switch (mode) {
        case 'text-flow':
            return DAG_INITIAL_ZOOM_BOOST_TEXT_FLOW;
        case 'linear-arc':
            return DAG_INITIAL_ZOOM_BOOST_LINEAR_ARC;
        case 'spiral':
            return DAG_INITIAL_ZOOM_BOOST_SPIRAL;
        default: {
            const _: never = mode;
            throw new Error(`genAttributeDagView: unknown DagLayoutMode (${String(_)})`);
        }
    }
}

/** 与 {@link gen_attribute.scss} `.gen-attr-dag-stack` 中 `--gen-attr-dag-compactness` 一致（display-scale/link 线粗等同源派生） */
const CSS_VAR_DAG_COMPACTNESS = '--gen-attr-dag-compactness';
/** 与 {@link gen_attribute.scss} `.gen-attr-dag-stack` 中 `--gen-attr-dag-display-scale` 一致 */
const CSS_VAR_DISPLAY_SCALE = '--gen-attr-dag-display-scale';
/** 与 {@link gen_attribute.scss} `.gen-attr-dag-stack` 中 `--gen-attr-dag-link-stroke-width` 一致 */
const CSS_VAR_DAG_LINK_STROKE_WIDTH = '--gen-attr-dag-link-stroke-width';

/** 与 {@link start.scss} `--dag-normal-line-color` 一致（普通边：线 stroke + 箭头 marker stroke） */
const CSS_VAR_DAG_NORMAL_LINE_COLOR = '--dag-normal-line-color';
/** 与 {@link start.scss} `--dag-highlight-line-color-in` 一致（入边：指向焦点） */
const CSS_VAR_DAG_HIGHLIGHT_LINE_IN = '--dag-highlight-line-color-in';
/** 与 {@link start.scss} `--dag-highlight-line-color-out` 一致（出边：从焦点出发） */
const CSS_VAR_DAG_HIGHLIGHT_LINE_OUT = '--dag-highlight-line-color-out';

/** 弱化：未排除的 prompt 无出边，或（prompt/生成区）邻域外且存在悬停/选中焦点时 */
const DAG_NODE_WEAKEN_OPACITY = 0.5;
/** 隐藏：节点 span 完全落在 exclude 规则命中区间内（prompt 与生成区各一套模式） */
const DAG_NODE_HIDDEN_OPACITY = 0.1;

/** 暂时关闭节点上的原生 `<title>` 悬浮提示；恢复时改为 `false`（边不受影响） */
const DISABLE_DAG_NODE_TOOLTIPS = false;

/**
 * 边端在矩形边界外侧的留白，相对测量层「1em」的比例（无单位）；与箭头/描边衔接用。
 * 测量层与节点几何同源（lmf-readout-text），故随字号/CSS 变化而变。
 */
const LINK_END_INSET_PER_EM = 0.1;

/** 箭头 marker 的 viewBox 半高（viewBox = `0 -H W 2H`） */
const MARKER_HALF_H = 5;
/** 箭头 marker 的 viewBox 宽（同时是 path 尖端 x 坐标） */
const MARKER_VW = 10;
/** 箭头 marker 渲染尺寸（markerWidth = markerHeight，单位为 markerUnits=strokeWidth） */
const MARKER_SIZE = 4;

/** 每条边独立 marker 的 document id（节点 id 为 `start_end`，与另一节点组合唯一） */
function dagLinkMarkerElementId(source: string, target: string): string {
    const s = source.replace(/[^0-9_]/g, '_');
    const t = target.replace(/[^0-9_]/g, '_');
    return `gen-attr-dag-mk-s${s}-t${t}`;
}

/** 与 {@link dagLinkMarkerElementId} 一一对应，作 d3 data key */
function dagLinkDataKey(d: DagLink): string {
    return dagLinkMarkerElementId(String(d.source), String(d.target));
}

function readDisplayScaleFromCss(el: HTMLElement): number {
    const raw = getComputedStyle(el).getPropertyValue(CSS_VAR_DISPLAY_SCALE).trim();
    if (raw === '') return 1;
    const n = parseFloat(raw);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(
            `genAttributeDagView: ${CSS_VAR_DISPLAY_SCALE} must be a finite positive number, got "${raw}"`
        );
    }
    return n;
}

/** `display-scale === 1` 时矩形边界外侧留白（px）：测量层 font-size × {@link LINK_END_INSET_PER_EM} */
function linkEndInsetBaseAtUnitScalePx(measureLayerEl: HTMLElement): number {
    const fs = parseFloat(getComputedStyle(measureLayerEl).fontSize);
    if (!Number.isFinite(fs) || fs <= 0) {
        throw new Error('genAttributeDagView: .gen-attr-dag-measure-layer font-size must be a finite positive length');
    }
    return fs * LINK_END_INSET_PER_EM;
}

function nodeRx(d: DagNode): number {
    return Math.min(d.nodeW / 2, d.nodeH / 2);
}

export type GenAttributeDagHandle = {
    /**
     * 在首帧 `update`（第一步生成 token）之前调用一次：用全量 prompt token spans 建 prompt 层节点。
     * @param promptText 本步 `context` 全文（与 offsets 一致）
     */
    setPromptTokenSpans(spans: PromptTokenSpan[], promptText: string): void;
    /**
     * 每生成一个 token 后调用，增量更新图；传入原始 {@link TokenGenStep}，view 内部完成 exclude / 对齐 / 筛选。
     * @param excludeIntervalContext 与 {@link ./genAttributeDagPreprocess excludeNodeAggregatedEntries} 一致：当前已写出的累积全文（如 `steps[last].context + steps[last].token`）。
     */
    update(step: TokenGenStep, excludeIntervalContext?: string): void;
    /**
     * 批量更新：批内的 {@link setPromptTokenSpans} 与 {@link update} 只维护图数据，不触达 SVG；
     * 直到 {@link endBatch} 才统一跑一次全量渲染。用于刷新/回放整段历史，避免中间帧
     * 反复跑 `syncGraphToSvg` / `refreshNodeLinkHighlight`（中间态不可见）。嵌套 `begin` 无额外效果。
     */
    beginBatch(): void;
    /** 结束批量：执行一次全量 `syncGraphToSvg`。未在批内调用时为 no-op。 */
    endBatch(): void;
    /** 是否处于 `beginBatch`/`endBatch` 之间（批内不写 SVG，勿对空 DOM 调 `fitViewportToContent`） */
    isBatching(): boolean;
    /**
     * 清空图与测量状态；不修改当前 SVG 上的 d3 zoom 变换（视口平移/缩放由 `layoutDirty` 与
     * `fitViewportToContent` 控制）。
     * @param preserveUserViewport 为 `true` 时保留调用前的 `layoutDirty`：用于「从末尾重播前 reset」
     * 时若用户已手动画布，重放后仍不自动 fit。默认 `false`（新一次 run 等场景仍从干净视口策略起算）。
     */
    reset(preserveUserViewport?: boolean): void;
    /**
     * zoom identity 后按内容适配视口；空图走默认缩放；`k` 上限 `k₀`（随当前布局模式的初始 zoom 倍率变化）。
     * - `text-flow`：`rootG.getBBox()`（含边）等比落入内框。
     * - `linear-arc`：仅按 `gen-attr-dag-nodes` 行宽定比，token 行相对内框竖直居中（弧不参与）。
     * 若 `layoutDirty` 为真则 no-op（仅已执行的 `syncSvgSize` 生效，不改 pan/zoom），但 `force` 为真时仍
     * fit 并清 dirty（例如刷新按钮的强制适配）。
     */
    fitViewportToContent(force?: boolean): void;
    /** 清除节点选中态（与点击画布空白等价）；不改变图数据，生成结束后可调用以去掉末 token 描边 */
    clearNodeSelection(): void;
    /** DAG 步进重放：更新 ▶ / ⏸ 按钮文案（由页面在播放开始/结束/暂停时调用） */
    setDagPlaybackPlaying: (playing: boolean) => void;
    /**
     * 设置不可见测量层的固定像素宽度（写入 inline `width`）。
     * 测量层宽度是节点几何（折行位置 / `x, y`）的唯一自变量；容器尺寸变化不再改变几何。
     * 本方法只改 DOM 属性，不触发重测：调用方决定何时 `reset` + 重放 + `fitViewportToContent`。
     * 传 `null` 恢复样式表默认（`100%`，跟随容器）。
     */
    setMeasureWidthPx(widthPx: number | null): void;
    /** 切换 DAG 节点布局模式并立即重排现有节点/边。 */
    setLayoutMode(mode: DagLayoutMode): void;
    /**
     * linear-arc 下相邻节点矩形外侧边的水平间隙（px）。仅影响 linear-arc 几何；若在生成/播放中途调用且
     * `skipRefit` 为真，仅写入值，下一轮 `syncGraphToSvg`/空闲后再反映（与测量宽度语义一致）。
     */
    setLinearArcAdjacentGapPx(px: number, opts?: { skipRefit?: boolean }): void;
    /**
     * 写入 `--gen-attr-dag-compactness`（与样式表中 display-scale / 边线粗等同源派生）。
     * 已有节点的 `nodeW`/`nodeH` 仍为建点时的缩放结果；调用方在需要一致几何时应 `reset` 后重放。
     */
    setDagCompactness(c: number): void;
    /** 更新边 Top-P 覆盖阈值；要重算当前 DAG 须 reset 后重放。 */
    setEdgeTopPCoverage(coverage: number): void;
    /**
     * 切换 excluded 节点的隐藏模式：
     * - `true`：完全隐藏（`display:none`）；linear-arc 下同时不参与布局。
     * - `false`（默认）：保留为低透明度（{@link DAG_NODE_HIDDEN_OPACITY}）占位。
     */
    setHideExcludedTokens(hide: boolean): void;
    /** prompt 层节点是否已注入（即 {@link setPromptTokenSpans} 至少成功添加过一个节点） */
    hasPromptSpans(): boolean;
    /** 移除 DAG 栈与刷新按钮（离开页面时调用） */
    detach(): void;
};

function endpointNode(
    ref: DagLink['source'] | DagLink['target'],
    graph: DirectedGraph<DagNodeAttrs>
): DagNode {
    if (typeof ref === 'object' && ref !== null) return ref as DagNode;
    const id = String(ref);
    if (!graph.hasNode(id)) throw new Error(`genAttributeDagView: unknown node id ${id}`);
    return graph.getNodeAttributes(id) as DagNode;
}

/** 节点 id 为 `start_end`，用于原生 `<title>` 文案 */
function formatNodeOffsetRange(id: string): string {
    const i = id.indexOf('_');
    if (i <= 0) return id;
    const a = id.slice(0, i);
    const b = id.slice(i + 1);
    if (!/^\d+$/.test(a) || !/^\d+$/.test(b)) return id;
    return `[${a}, ${b})`;
}

function buildNodeNativeTitleText(
    d: Pick<DagNode, 'displayLabel' | 'id' | 'step'> & { targetProb?: number },
): string {
    const lines = [
        d.displayLabel,
        `Offset: ${formatNodeOffsetRange(d.id)}`,
        `Step: ${d.step}`,
    ];
    const { targetProb } = d;
    if (targetProb !== undefined && Number.isFinite(targetProb)) {
        lines.push(`\nProb: ${formatTopkTooltipProbabilityPercent(targetProb)}`);
        lines.push(`Information: ${DAG_TITLE_SURPRISAL_FMT(calculateSurprisal(targetProb))} bits`);
        lines.push(
            formatCiMiRatiosLineForTooltip(
                computeConditionalInformationRatio(targetProb),
                computeMutualInformationRatio(targetProb),
            ),
        );
    }
    return lines.join('\n');
}

/** 建边时调用：端点已带 {@link DagNodeAttrs.displayLabel} */
function buildLinkTitleText(
    d: Pick<DagLink, 'normalizedScore' | 'mutualInformationRatio' | 'scoreShare' | 'alignmentNote'>,
    src: DagNode,
    tgt: DagNode
): string {
    const s = d.normalizedScore ?? 1;
    const normStr = Number.isFinite(s) ? s.toFixed(3) : String(s);
    const opacity = dagLinkStrokeOpacity(d);
    const opacityStr = Number.isFinite(opacity) ? opacity.toFixed(3) : String(opacity);

    const metrics = [
        `Attribution score: ${normStr}`,
        `Target MI ratio: ${formatMutualInformationRatioForTooltip(d.mutualInformationRatio ?? 1)}`,
        `Link strength: ${opacityStr}`,
    ];
    const share = d.scoreShare;
    if (typeof share === 'number' && Number.isFinite(share) && share > 0) {
        metrics.push(`Fan in share: ${(share * 100).toFixed(1)}%`);
    }
    if (d.alignmentNote) {
        metrics.push(d.alignmentNote);
    }

    return [
        `From:\n${src.displayLabel}\nOffset: ${formatNodeOffsetRange(src.id)}`,
        `To:\n${tgt.displayLabel}\nOffset: ${formatNodeOffsetRange(tgt.id)}`,
        metrics.join('\n'),
    ].join('\n\n');
}

/**
 * 单码点：可作拼接一侧（前一片末尾或当前片开头）——非 Han 字母或 ' - _
 * 对称处理 `__`→`init`、`love`→`'s` 等。
 */
const GLUE_EDGE_CHAR = /^(?:(?!\p{Script=Han})\p{L}|['\-_])$/u;

/**
 * 子词拼接：offset 紧贴、同行（cy 相等）、prev 末码点与当前首码点均满足 {@link GLUE_EDGE_CHAR}
 * → 将当前节点中心 cx 紧贴 prev 右缘（链式调用时 prev.cx 已调整，自动支持多段续片）。
 */
function snapSubwordNode(node: DagNode, prev: DagNode | null): void {
    if (!prev || prev.end !== node.start || node.cy !== prev.cy) return;
    const last = [...prev.label].at(-1) ?? '';
    const first = [...node.label][0] ?? '';
    if (!GLUE_EDGE_CHAR.test(last) || !GLUE_EDGE_CHAR.test(first)) return;
    node.cx = prev.cx + (prev.nodeW + node.nodeW) / 2;
}

/** 焦点 + 一层入邻（直接祖先）+ 一层出邻（直接后代），用于选中/悬停高亮范围 */
function oneHopNeighborhood(graph: DirectedGraph<DagNodeAttrs>, nodeId: string): Set<string> {
    const active = new Set<string>([nodeId]);
    graph.forEachInNeighbor(nodeId, (n) => {
        active.add(n);
    });
    graph.forEachOutNeighbor(nodeId, (n) => {
        active.add(n);
    });
    return active;
}

/** 边是否与焦点节点邻接（用于高亮边样式与 SVG 中置于灰边之上） */
function dagLinkIncidentToFocus(
    graph: DirectedGraph<DagNodeAttrs>,
    focusId: string | null,
    d: DagLink
): boolean {
    if (!focusId) return false;
    const s = endpointNode(d.source, graph).id;
    const t = endpointNode(d.target, graph).id;
    return s === focusId || t === focusId;
}

/**
 * 邻接焦点时边的描边：从焦点出发 → 红；指向焦点 → 蓝（自环视为「出发」）。
 * 非邻接返回 `null`，调用方用默认边色。
 */
function dagLinkHighlightStroke(
    graph: DirectedGraph<DagNodeAttrs>,
    focusId: string | null,
    d: DagLink
): string | null {
    if (!focusId) return null;
    const s = endpointNode(d.source, graph).id;
    const t = endpointNode(d.target, graph).id;
    if (s !== focusId && t !== focusId) return null;
    if (s === focusId) return `var(${CSS_VAR_DAG_HIGHLIGHT_LINE_OUT})`;
    return `var(${CSS_VAR_DAG_HIGHLIGHT_LINE_IN})`;
}

/**
 * Generate & Attribute 右栏 DAG 视图。
 *
 * 节点 ID 基于归因 offset：`"${start}_${end}"`，全局唯一。
 * - prompt 层：由调用方在首帧 `update` 前 {@link GenAttributeDagHandle.setPromptTokenSpans} 注入（`step === -1`）
 * - 第 k 个生成 token：target 节点（`step === k`，从 0 起）
 *
 * **不做 BPE/digit 合并**（不经 `mergeAttentionTokensFullyForRendering`，与 Attribution 主视图的
 * `buildAttributionDisplayResult` 管线不同）：DAG 必须按 API 原始 span 建点，节点身份才与增量 `update`
 * 一致；合并会改变粒度，且各步归因集合不同，跨步合并结果不稳定。
 *
 * 调用方传入**原始** {@link TokenGenStep}：view 内部按 `alignAndAggregateByNode`（piece → 节点聚合）
 * → `excludeNodeAggregatedEntries`（prompt / 已生成区 exclude，节点区间语义）
 * → `phase2RankAndSparsify`（Top-N / 池内归一 / β 截断 / cumulative Top-P）后连边。
 *
 * 节点初值几何来自不可见测量层（{@link ./genAttributeDagTextMeasure}），与 LMF 相同 Range 测量；
 * 节点框左上角对齐测量起点；矩形与 SVG 标签相对测量层共用 `--gen-attr-dag-display-scale`；仅缩放平移作用于 SVG。
 */
export type InitGenAttributeDagViewOptions = {
    /** 点击 ▶：传入 `true`；点击 ⏸：传入 `false`（页面内定时重放 DAG） */
    onDagPlaybackToggle?: (playing: boolean) => void;
    /** 点击 DAG 刷新时：在内部先按需 `fitViewportToContent`、再 `reset` 之后调用，用于重放（视口沿用 fit 结果）。 */
    onDagRefresh?: () => void;
    /**
     * 写入 `.gen-attr-dag-stack` 的 `--gen-attr-dag-compactness`（矩形与节点文字、边线粗等同源缩放基准）。
     * 未设置时沿用样式表默认值（见 {@link DAG_COMPACTNESS_DEFAULT}）。
     */
    dagCompactness?: number;
    /**
     * @deprecated 与 {@link dagCompactness} 同义；二者择一，若同时传入则抛错。
     */
    displayScale?: number;
    /**
     * 不可见测量层固定宽度（px，写入 inline `width`）。测量层宽度是节点几何（折行位置 / `x, y`）的
     * 唯一自变量——钉死后，容器 resize 等不再改变节点几何（视口仍可由自动 fit / 手势调整），避免
     * 「resize 只 refit 旧几何、刷新才重测几何」的结构性不一致。未设置时沿用样式表 `100%`（跟随容器）。
     */
    measureWidthPx?: number;
    /** DAG 节点布局模式；默认 `text-flow`。 */
    layoutMode?: DagLayoutMode;
    /**
     * linear-arc：相邻节点矩形外侧边的水平间隙（px），决定水平方向疏密；
     * 默认 {@link LINEAR_ARC_ADJACENT_GAP_DEFAULT}。
     */
    linearArcAdjacentGapPx?: number;
    /** 被 exclude 规则命中的节点是否完全隐藏（true）还是仅降至 {@link DAG_NODE_HIDDEN_OPACITY}（false，默认）。 */
    hideExcludedTokens?: boolean;
    /** 边 Top-P 覆盖阈值（候选池内累计份额）；默认 {@link DAG_EDGE_TOP_P_COVERAGE_DEFAULT}。 */
    edgeTopPCoverage?: number;
    /** 进入/退出/切换全屏失败时（常见于移动端不支持元素全屏等）。不传则无提示。 */
    onFullscreenError?: (message: string) => void;
};

export function initGenAttributeDagView(
    resultsRoot: D3Sel,
    options?: InitGenAttributeDagViewOptions
): GenAttributeDagHandle {
    const onDagRefresh = options?.onDagRefresh;
    const onDagPlaybackToggle = options?.onDagPlaybackToggle;
    const onFullscreenError = options?.onFullscreenError;
    let layoutMode: DagLayoutMode = options?.layoutMode ?? 'text-flow';
    let linearArcAdjacentGapPx = LINEAR_ARC_ADJACENT_GAP_DEFAULT;
    if (options?.linearArcAdjacentGapPx !== undefined) {
        const iv = options.linearArcAdjacentGapPx;
        if (!Number.isFinite(iv)) {
            throw new Error('genAttributeDagView: linearArcAdjacentGapPx must be finite');
        }
        linearArcAdjacentGapPx = clampLinearArcAdjacentGap(iv);
    }
    let hideExcludedTokens: boolean = options?.hideExcludedTokens ?? false;
    let edgeTopPCoverage = clampDagEdgeTopPCoverage(
        options?.edgeTopPCoverage ?? DAG_EDGE_TOP_P_COVERAGE_DEFAULT,
    );

    function reportFullscreenFailure(err: unknown): void {
        if (!onFullscreenError) return;
        const detail =
            err instanceof Error
                ? err.message
                : typeof err === 'string'
                  ? err
                  : '';
        const base = tr('Fullscreen unavailable');
        onFullscreenError(detail ? `${base}: ${detail}` : base);
    }

    const rootEl = resultsRoot.node() as HTMLElement | null;
    if (!rootEl) {
        const noop = (): void => {};
        return {
            setPromptTokenSpans: noop,
            update: noop,
            beginBatch: noop,
            endBatch: noop,
            isBatching: () => false,
            reset: noop,
            fitViewportToContent: noop,
            clearNodeSelection: noop,
            setDagPlaybackPlaying: noop,
            setMeasureWidthPx: noop,
            setLayoutMode: noop,
            setLinearArcAdjacentGapPx: noop,
            setDagCompactness: noop,
            setEdgeTopPCoverage: noop,
            setHideExcludedTokens: noop,
            hasPromptSpans: () => false,
            detach: noop,
        };
    }

    detachGenAttributeDagPanel.get(rootEl)?.();
    resultsRoot
        .selectAll(
            '.gen-attr-dag-stack, svg.gen-attr-dag-svg, button.gen-attr-dag-refresh, button.gen-attr-dag-play, button.gen-attr-dag-fullscreen'
        )
        .remove();

    const stack = resultsRoot.append('div').attr('class', 'gen-attr-dag-stack');
    const stackEl = stack.node() as HTMLElement;

    /** 非 text-flow 时节点不可拖；用该类覆盖选中态的 grab 光标（linear-arc / spiral 等）。 */
    function syncStackLayoutDragUi(): void {
        stackEl.classList.toggle('gen-attr-dag-no-node-drag-layout', layoutMode !== 'text-flow');
    }
    syncStackLayoutDragUi();

    if (options?.dagCompactness !== undefined && options?.displayScale !== undefined) {
        throw new Error('genAttributeDagView: pass only one of dagCompactness or displayScale');
    }
    const compactnessInit = options?.dagCompactness ?? options?.displayScale;
    if (compactnessInit !== undefined) {
        const c = clampDagCompactness(compactnessInit);
        stackEl.style.setProperty(CSS_VAR_DAG_COMPACTNESS, String(c));
    }


    const measureRoot = stack
        .append('div')
        .attr('class', 'gen-attr-dag-measure-layer')
        .node() as HTMLElement;

    function setMeasureWidthPx(widthPx: number | null): void {
        if (widthPx === null) {
            measureRoot.style.removeProperty('width');
            return;
        }
        if (!Number.isFinite(widthPx) || widthPx <= 0) {
            throw new Error('genAttributeDagView: measureWidthPx must be a finite positive number');
        }
        measureRoot.style.width = `${widthPx}px`;
    }

    if (options?.measureWidthPx !== undefined) {
        setMeasureWidthPx(options.measureWidthPx);
    }

    const textMeasure = createGenAttributeDagTextMeasure(measureRoot);

    /**
     * 与 `--gen-attr-dag-display-scale` 一致；`setDagCompactness` 会更新（并同步 `linkEndInsetPx`）。
     * 热路径不读 `getComputedStyle`，仅在该 setter 与 init 时刷新。
     */
    let displayScale = readDisplayScaleFromCss(stackEl);
    let linkEndInsetPx = linkEndInsetBaseAtUnitScalePx(measureRoot) * displayScale;

    function refreshDagScaleDerivedFromCss(): void {
        displayScale = readDisplayScaleFromCss(stackEl);
        linkEndInsetPx = linkEndInsetBaseAtUnitScalePx(measureRoot) * displayScale;
    }

    function setDagCompactness(c: number): void {
        const v = clampDagCompactness(c);
        stackEl.style.setProperty(CSS_VAR_DAG_COMPACTNESS, String(v));
        refreshDagScaleDerivedFromCss();
    }

    function setEdgeTopPCoverage(coverage: number): void {
        edgeTopPCoverage = clampDagEdgeTopPCoverage(coverage);
    }

    const svg = stack.append('svg').attr('class', 'gen-attr-dag-svg');

    /** 边箭头 marker 放在 svg 根 defs，与 {@link rootG} 平级、不受 zoom 变换，与原先单例 marker 一致，避免嵌套在 zoom 内时箭头相对线段偏细 */
    const linkMarkersDefs = svg.append('defs').attr('class', 'gen-attr-dag-link-markers-defs');

    const rootG = svg.append('g').attr('class', 'gen-attr-dag-zoom-root');

    /**
     * 基准缩放为 `1 / --gen-attr-dag-display-scale`：节点几何与 SVG 文字已按 display-scale 相对测量层缩放后，
     * 再用其倒数做 zoom，使屏上接近未单独缩小时的阅读比例；实际初始 k 还会乘以 {@link dagInitialZoomBoost}（按布局模式）。
     */
    function initialDagZoomK(): number {
        return 1 / displayScale;
    }

    function defaultDagZoomK(): number {
        return initialDagZoomK() * dagInitialZoomBoost(layoutMode);
    }

    const zoomBehavior = d3
        .zoom<SVGSVGElement, unknown>()
        .on('zoom', (event) => {
            rootG.attr('transform', event.transform);
            // 仅用户交互（滚轮/拖平移/双击）计入「改动布局」；程序触发的 transform
            // （init 初始缩放、`fitViewportToContent`）`sourceEvent === null`，不置 dirty。
            if (event.sourceEvent) layoutDirty = true;
        });

    function applyInitialDagZoom(): void {
        svg.call(zoomBehavior.transform, d3.zoomIdentity.scale(defaultDagZoomK()));
    }

    svg.call(zoomBehavior);
    applyInitialDagZoom();

    svg.on('click', () => setSelectedNodeId(null));

    const linkG = rootG.append('g').attr('class', 'gen-attr-dag-links');
    const nodeG = rootG.append('g').attr('class', 'gen-attr-dag-nodes');
    /** 邻接焦点的高亮边：在节点层之后绘制，避免被节点遮挡 */
    const linkGFront = rootG.append('g').attr('class', 'gen-attr-dag-links-front');

    const graph = new DirectedGraph<DagNodeAttrs>();
    let nodes: DagNode[] = [];
    let links: DagLink[] = [];
    let stepProcessed = 0;
    let selectedId: string | null = null;
    /** 临时焦点：与选中同款子图高亮；优先于 {@link selectedId}，移出节点后回落到选中态 */
    let hoveredId: string | null = null;
    /**
     * 与 {@link pruneDagLinksTouchingFullyExcludedNodes} / 预处理同源：全串上的 exclude 半开区间，
     * 供节点「隐藏」透明度判定（{@link isOffsetSpanFullyExcluded}）。在 {@link setPromptTokenSpans} 与每步
     * {@link update} 中刷新；{@link reset} 清空。
     */
    let dagExcludeIntervals: [number, number][] = [];
    /**
     * 用户是否手动改动过布局：拖节点 或 用户手势 zoom/pan。
     * - true 时：容器尺寸变化（窗口 resize / 侧栏）不再自动 fit，保留用户视图
     * - false 时：任何尺寸变化都自动 fit
     * 清零点：{@link reset}、{@link fitViewportToContent}（fit 本身把视图带回默认）
     */
    let layoutDirty = false;
    /**
     * 用户是否拖动过节点（仅拖节点，不含画布 pan/zoom）。
     * - {@link layoutDirty} 在 pan/zoom 时也会为 true；刷新时若仅 pan/zoom 则仍 {@link fitViewportToContent}，
     *   若拖过节点则回放数据恢复节点几何并保留当前 pan/zoom。
     * 清零点：{@link reset}（图清空）、成功 {@link fitViewportToContent} 后视为回到默认视图语义（与 layoutDirty 一并清）
     */
    let userDraggedNodes = false;

    let linkSel = rootG
        .selectAll<SVGGElement, DagLink>('g.gen-attr-dag-link')
        .data<DagLink>([], dagLinkDataKey);
    let nodeSel = nodeG.selectAll<SVGGElement, DagNode>('g.gen-attr-dag-node').data<DagNode>([], (d) => d.id);

    function syncSvgSize(): void {
        const { w, h } = stackLayoutViewportPx(stackEl);
        svg.attr('width', w).attr('height', h);
    }

    function paint(): void {
        if (layoutMode === 'linear-arc') {
            const layoutNodes = hideExcludedTokens
                ? nodes.filter((n) => !isOffsetSpanFullyExcluded(n.start, n.end, dagExcludeIntervals))
                : nodes;
            paintLinearArcLayout({
                linkSel,
                nodeSel,
                nodes: layoutNodes,
                adjacentGapPx: linearArcAdjacentGapPx,
                getLinkNodes: (d) => ({
                    src: endpointNode(d.source, graph),
                    tgt: endpointNode(d.target, graph),
                }),
            });
            return;
        }
        if (layoutMode === 'spiral') {
            const layoutNodes = hideExcludedTokens
                ? nodes.filter((n) => !isOffsetSpanFullyExcluded(n.start, n.end, dagExcludeIntervals))
                : nodes;
            paintSpiralLayout({
                linkSel,
                nodeSel,
                nodes: layoutNodes,
                linkEndInsetPx,
                getLinkNodes: (d) => ({
                    src: endpointNode(d.source, graph),
                    tgt: endpointNode(d.target, graph),
                }),
            });
            return;
        }
        paintTextFlowLayout({
            linkSel,
            nodeSel,
            linkEndInsetPx,
            getLinkNodes: (d) => ({
                src: endpointNode(d.source, graph),
                tgt: endpointNode(d.target, graph),
            }),
        });
    }

    let dragPointerOffset: { x: number; y: number } | null = null;
    const drag = d3
        .drag<SVGGElement, DagNode>()
        // 与 d3 默认 filter 一致，并仅在「当前节点已单击选中」时允许拖动手势生效，减少误拖
        // 仅 text-flow（UI 的 default）支持拖拽；linear-arc 下禁拖
        .filter(
            (event, d) =>
                !event.ctrlKey &&
                !event.button &&
                selectedId === d.id &&
                layoutMode === 'text-flow'
        )
        .on('start', (event, d) => {
            event.sourceEvent?.stopPropagation();
            const [x, y] = d3.pointer(event, rootG.node());
            dragPointerOffset = { x: x - d.cx, y: y - d.cy };
        })
        .on('drag', (event, d) => {
            layoutDirty = true;
            userDraggedNodes = true;
            const [x, y] = d3.pointer(event, rootG.node());
            const offset = dragPointerOffset ?? { x: 0, y: 0 };
            d.cx = x - offset.x;
            d.cy = y - offset.y;
            paint();
        })
        .on('end', () => {
            dragPointerOffset = null;
        });

    /**
     * 节点透明度：先按「一跳邻域」提亮为 1（选中先于悬停，邻域内一致）；
     * 否则被 exclude 整段命中的为「隐藏」({@link DAG_NODE_HIDDEN_OPACITY})（prompt/生成区一致）；
     * 其余节点：prompt 无出边时弱化；存在焦点时，所有邻域外非隐藏节点弱化（与原先焦点压暗一致）。
     * 边的高亮仍以悬停优先、否则选中为焦点（{@link dagLinkIncidentToFocus}）。
     */
    function refreshNodeLinkHighlight(): void {
        const focusId = hoveredId ?? selectedId;
        const selectedNbhd = selectedId ? oneHopNeighborhood(graph, selectedId) : null;
        const hoveredNbhd = hoveredId ? oneHopNeighborhood(graph, hoveredId) : null;

        nodeSel
            .classed('gen-attr-dag-node--hover', (d) => hoveredId === d.id)
            .classed('gen-attr-dag-node--selected', (d) => selectedId === d.id)
            .style('display', (d) =>
                hideExcludedTokens && isOffsetSpanFullyExcluded(d.start, d.end, dagExcludeIntervals)
                    ? 'none' : null
            )
            .attr('opacity', (d) => {
                if (selectedNbhd?.has(d.id)) return 1;
                if (hoveredNbhd?.has(d.id)) return 1;
                if (isOffsetSpanFullyExcluded(d.start, d.end, dagExcludeIntervals)) {
                    return hideExcludedTokens ? 0 : DAG_NODE_HIDDEN_OPACITY;
                }
                const hasGenTokens = nodes.some((n) => n.step >= 0);
                const isPromptLeaf = hasGenTokens && d.step === -1 && graph.outDegree(d.id) === 0;
                if (focusId || isPromptLeaf) return DAG_NODE_WEAKEN_OPACITY;
                return 1;
            });
        // 每条边独立 marker：线与箭头 path 同步 stroke / stroke-opacity。
        // normalizedScore 决定边内相对强弱（与 opacity 基项一致）；互信息率只作为整步入边的视觉折扣。
        linkSel.each(function(d) {
            const op = dagLinkStrokeOpacity(d);
            const stroke =
                dagLinkHighlightStroke(graph, focusId, d) ?? `var(${CSS_VAR_DAG_NORMAL_LINE_COLOR})`;
            const g = d3.select(this);
            g.select('path.gen-attr-dag-link-visible').attr('stroke', stroke).attr('stroke-opacity', op);
            linkMarkersDefs
                .select<SVGPathElement>(`#${dagLinkMarkerElementId(d.source, d.target)} path`)
                .attr('stroke', stroke)
                .attr('stroke-opacity', op);
        });
        // 灰边在 linkG、高亮边在 linkGFront（位于 nodeG 之后），既不被灰边也不被节点遮挡。
        // 同层内保持 DOM 插入顺序（= `links` push 顺序）即可，无需显式 sort：
        // - `links` 只 push、不重排；
        // - 新 `<g>` 由 d3 `enter().append` 追加在 `linkG` 末尾；
        // - 下面仅在父节点不一致时才 `appendChild`，避免白搬动导致末尾顺序被打乱。
        rootG.selectAll<SVGGElement, DagLink>('g.gen-attr-dag-link').each(function(d) {
            const incident = dagLinkIncidentToFocus(graph, focusId, d);
            const parent = incident ? linkGFront : linkG;
            const parentNode = parent.node()!;
            if (this.parentNode !== parentNode) {
                parentNode.appendChild(this as SVGGElement);
            }
        });
    }

    function setSelectedNodeId(id: string | null): void {
        selectedId = id;
        refreshNodeLinkHighlight();
    }

    function clearNodeSelection(): void {
        setSelectedNodeId(null);
    }

    /** 将当前 `nodes` / `links` 同步到 SVG：join 新 DOM、`paint` 几何、`refreshNodeLinkHighlight` 样式。 */
    function syncGraphToSvg(): void {
        linkGFront.selectAll<SVGGElement, DagLink>('g.gen-attr-dag-link').each(function() {
            linkG.node()!.appendChild(this as SVGGElement);
        });
        linkMarkersDefs
            .selectAll<SVGMarkerElement, DagLink>('marker')
            .data(links, (d) => dagLinkMarkerElementId(d.source, d.target))
            .join((enter) => {
                const m = enter
                    .append('marker')
                    .attr('id', (d) => dagLinkMarkerElementId(d.source, d.target))
                    .attr('viewBox', `0 -${MARKER_HALF_H} ${MARKER_VW} ${MARKER_HALF_H * 2}`)
                    .attr('refX', MARKER_VW * 0.8)
                    .attr('refY', 0)
                    .attr('markerWidth', MARKER_SIZE)
                    .attr('markerHeight', MARKER_SIZE)
                    .attr('orient', 'auto');
                m.append('path')
                    .attr('d', `M0,-${MARKER_HALF_H} L${MARKER_VW},0 L0,${MARKER_HALF_H}`)
                    .attr('fill', 'none')
                    .attr('stroke', `var(${CSS_VAR_DAG_NORMAL_LINE_COLOR})`)
                    // markerUnits=strokeWidth 坐标系下，viewBox宽/marker尺寸 = 1× 线宽
                    .attr('stroke-width', MARKER_VW / MARKER_SIZE)
                    .attr('stroke-linecap', 'round')
                    .attr('stroke-linejoin', 'round');
                return m;
            });

        linkSel = linkG
            .selectAll<SVGGElement, DagLink>('g.gen-attr-dag-link')
            .data(links, dagLinkDataKey)
            .join((enter) => {
                const g = enter.append('g').attr('class', 'gen-attr-dag-link');
                g.each(function(d: DagLink) {
                    const el = d3.select(this);
                    const mkId = dagLinkMarkerElementId(d.source, d.target);
                    el.append('title').text(d.titleText);
                    el.append('path')
                        .attr('class', 'gen-attr-dag-link-visible')
                        .attr('fill', 'none')
                        .attr('stroke', `var(${CSS_VAR_DAG_NORMAL_LINE_COLOR})`)
                        .attr('stroke-width', `var(${CSS_VAR_DAG_LINK_STROKE_WIDTH})`)
                        .attr('pointer-events', 'stroke')
                        .attr('marker-end', `url(#${mkId})`);
                });
                return g;
            });
        // 不在此处全量重置 marker `stroke-opacity`：紧接着的 {@link refreshNodeLinkHighlight} 会按边
        // 逐条写 `dagLinkStrokeOpacity`（与 `<title>` 中 Strength 同源），任何前值都会被覆盖，全量重置纯冗余。

        nodeSel = nodeG
            .selectAll<SVGGElement, DagNode>('g.gen-attr-dag-node')
            .data(nodes, (d) => d.id)
            .join(
                (enter) => {
                    // 节点身份 append-only、几何（nodeW/nodeH）一旦建立不再变化（drag 仅改 x/y，
                    // 由 paint 通过 transform 处理），故与几何相关的属性仅在 enter 写一次即可；
                    // 同理 `--prompt` class 依据 step === -1，step 初始化后不变。
                    const g = enter
                        .append('g')
                        .attr('class', 'gen-attr-dag-node')
                        .style('--gen-attr-dag-node-ci-visual-scale', (d: DagNode) => String(d.ciVisualScale));
                    g.classed('gen-attr-dag-node--prompt', (d: DagNode) => d.step === -1);
                    if (!DISABLE_DAG_NODE_TOOLTIPS) {
                        g.append('title').text((d: DagNode) => d.nativeTitleText);
                    }
                    g.append('rect')
                        .attr('x', 0)
                        .attr('y', 0)
                        .attr('width', (d: DagNode) => d.nodeW)
                        .attr('height', (d: DagNode) => d.nodeH)
                        .attr('rx', (d: DagNode) => nodeRx(d))
                        .attr('ry', (d: DagNode) => nodeRx(d));
                    g.append('text')
                        .attr('class', 'gen-attr-dag-node-text')
                        .attr('xml:space', 'preserve')
                        .attr('pointer-events', 'none')
                        .attr('text-anchor', 'middle')
                        .attr('dominant-baseline', 'central')
                        .attr('x', (d: DagNode) => d.nodeW / 2)
                        .attr('y', (d: DagNode) => d.nodeH / 2)
                        .text((d: DagNode) => d.displayLabel);
                    g.on('mouseenter', (_event, d) => {
                        hoveredId = d.id;
                        refreshNodeLinkHighlight();
                    });
                    g.on('mouseleave', () => {
                        hoveredId = null;
                        refreshNodeLinkHighlight();
                    });
                    g.on('click', (event, d) => {
                        event.stopPropagation();
                        setSelectedNodeId(selectedId === d.id ? null : d.id);
                    });
                    return g.call(drag);
                }
            );

        paint();
        refreshNodeLinkHighlight();
    }

    /**
     * 批量模式下 `setPromptTokenSpans` / `update` 只维护图数据，不跑 `syncGraphToSvg`。
     * 刷新按钮回放整段历史时，中间帧不可见却要承担 N × O(N) 的 svg 同步，用批处理把它们压成一次。
     * 嵌套 begin 无额外效果。（尺寸与 fit：批外由 `ResizeObserver` / 各调用方在 `replay` 后按需 `fitViewportToContent`；批末仅刷 DOM。）
     */
    let batchDepth = 0;
    function beginBatch(): void {
        batchDepth++;
    }
    function endBatch(): void {
        if (batchDepth === 0) return;
        batchDepth--;
        if (batchDepth === 0) {
            syncGraphToSvg();
            // 不在此 fit：`replay` 前若调过 `reset()`，`layoutDirty` 已被清零，此处 `fitViewportToContent` 会误把「dirty 刷新应保留的视图」拉回默认；
            // not dirty 时由刷新按钮末尾 `fit(true)`、改测量宽度/恢复缓存等调用方在 `replay` 后统一 fit。
            // 栈高由 flex 固定后 RO(stack) 可能不触发，仅影响 `syncSvgSize` 时机，与首版「靠栈变高触发 RO」相同取舍。
        }
    }

    function isBatching(): boolean {
        return batchDepth > 0;
    }

    function setPromptTokenSpans(spans: PromptTokenSpan[], promptText: string): void {
        const geomByKey = textMeasure.setPrompt(promptText, spans);
        const addedNodes: DagNode[] = [];
        for (const attr of spans) {
            const [ns, ne] = attr.offset;
            const srcId = `${ns}_${ne}`;
            if (graph.hasNode(srcId)) continue;
            const g = geomByKey.get(srcId);
            if (!g) {
                throw new Error(`genAttributeDagView: missing layout for prompt node ${srcId}`);
            }
            const displayLabel = visualizeSpecialChars(attr.raw, {
                spaceDotExceptBeforeAsciiLetterOrNumber: true,
            });
            const srcNode: DagNode = {
                id: srcId,
                label: attr.raw,
                step: -1,
                start: ns,
                end: ne,
                cx: g.cx,
                cy: g.cy,
                nodeW: g.width * displayScale,
                nodeH: g.height * displayScale,
                ciVisualScale: 1,
                displayLabel,
                nativeTitleText: buildNodeNativeTitleText({
                    displayLabel,
                    id: srcId,
                    step: -1,
                }),
            };
            graph.addNode(srcId, srcNode);
            nodes.push(srcNode);
            addedNodes.push(srcNode);
        }
        const firstNewIdx = nodes.length - addedNodes.length;
        for (let i = 0; i < addedNodes.length; i++) {
            const prevIdx = firstNewIdx + i - 1;
            snapSubwordNode(addedNodes[i]!, prevIdx >= 0 ? nodes[prevIdx]! : null);
        }
        dagExcludeIntervals = collectGenAttrDagExcludeIntervals(promptText, promptText.length);
        if (batchDepth === 0) syncGraphToSvg();
    }

    /** 将当前 `nodes` 映射为对齐层所需的最小区间信息（按插入序，align 内部会再按 start 排序）。 */
    function nodeIntervalsForAlign(): NodeInterval[] {
        return nodes.map((n) => ({ id: n.id, start: n.start, end: n.end, label: n.label }));
    }

    function update(step: TokenGenStep, excludeIntervalContext?: string): void {
        const { context, token, response } = step;
        if (!response.token_attribution || !token) return;

        const intervalCtx = excludeIntervalContext ?? step.context;

        const targetStart = context.length;
        const targetEnd = context.length + token.length;
        const targetId = `${targetStart}_${targetEnd}`;
        if (graph.hasNode(targetId)) {
            throw new Error(
                `genAttributeDagView: unexpected duplicate target node id=${targetId} at stepProcessed=${stepProcessed} (same update() or out-of-order replay?)`
            );
        }
        const g = textMeasure.appendGeneratedToken(token, [targetStart, targetEnd]);
        const displayLabel = visualizeSpecialChars(token, {
            spaceDotExceptBeforeAsciiLetterOrNumber: true,
        });
        const ciVisualScale = dagGeneratedNodeCiVisualScale(response.target_prob);
        const targetNode: DagNode = {
            id: targetId,
            label: token,
            step: stepProcessed,
            start: targetStart,
            end: targetEnd,
            cx: g.cx,
            cy: g.cy,
            nodeW: g.width * displayScale * ciVisualScale,
            nodeH: g.height * displayScale * ciVisualScale,
            ciVisualScale,
            displayLabel,
            nativeTitleText: buildNodeNativeTitleText({
                displayLabel,
                id: targetId,
                step: stepProcessed,
                targetProb: response.target_prob,
            }),
        };
        graph.addNode(targetId, targetNode);
        nodes.push(targetNode);
        snapSubwordNode(targetNode, nodes.length >= 2 ? nodes[nodes.length - 2]! : null);

        // align → exclude → rank：Top-N / β / cumP 在节点语义上工作（合并型「如下」/ 拆分型等）。
        const pieces: PieceEntry[] = (response.token_attribution ?? []).map((t) => ({
            offset: t.offset as [number, number],
            raw: t.raw,
            score: t.score,
        }));
        const aggregated = alignAndAggregateByNode(pieces, nodeIntervalsForAlign(), {
            step: stepProcessed,
            targetToken: token,
        });
        const afterExclude = excludeNodeAggregatedEntries(step, aggregated, excludeIntervalContext);
        const selected = phase2RankAndSparsify(afterExclude, { cumulativeShare: edgeTopPCoverage });

        const mutualInformationRatio = computeMutualInformationRatio(response.target_prob);
        // 仅保留可绘制的边；「Fan in share」的分母为下列可见边的池内 L1 份额之和（非完整 sparse 池）。
        const selectedForDisplay = selected.filter(
            (item) =>
                dagLinkStrokeOpacity({
                    normalizedScore: item.score,
                    mutualInformationRatio,
                }) >= DAG_EDGE_MIN_DISPLAY_OPACITY
        );
        const massSum = selectedForDisplay.reduce((acc, t) => acc + Math.max(0, t.poolMassFrac), 0);
        for (const item of selectedForDisplay) {
            const srcId = item.nodeId;
            if (!graph.hasNode(srcId)) {
                throw new Error(
                    `genAttributeDagView: attribution nodeId ${srcId} has no graph node at stepProcessed=${stepProcessed} (align/DAG out of sync)`
                );
            }
            const share = massSum > 0 ? item.poolMassFrac / massSum : undefined;
            const alignmentNote =
                item.alignmentTooltipLines && item.alignmentTooltipLines.length > 0
                    ? item.alignmentTooltipLines.join('\n\n')
                    : undefined;
            if (graph.hasEdge(srcId, targetId)) {
                throw new Error(
                    `genAttributeDagView: unexpected duplicate edge ${srcId} -> ${targetId} at stepProcessed=${stepProcessed} (duplicate nodeId in selected or repeat update?)`
                );
            }
            const edgeAttrs = {
                normalizedScore: item.score,
                mutualInformationRatio,
                scoreShare: share,
                ...(alignmentNote ? { alignmentNote } : {}),
            };
            graph.addEdge(srcId, targetId, edgeAttrs);
            const srcAttrs = graph.getNodeAttributes(srcId) as DagNode;
            const tgtAttrs = graph.getNodeAttributes(targetId) as DagNode;
            links.push({
                source: srcId,
                target: targetId,
                ...edgeAttrs,
                titleText: buildLinkTitleText(edgeAttrs, srcAttrs, tgtAttrs),
            });
        }

        const excludeIntervals = collectGenAttrDagExcludeIntervals(intervalCtx, step.promptRegionEnd);
        dagExcludeIntervals = excludeIntervals;
        pruneDagLinksTouchingFullyExcludedNodes(graph, links, excludeIntervals);

        stepProcessed++;
        // 每步生成后：默认焦点为本步新生成的 token（与悬浮同款高亮；有真实悬停时仍以 hoveredId 优先）
        selectedId = targetId;
        if (batchDepth === 0) {
            syncGraphToSvg();
            // 生成 / 单步回放 / DAG 步进播放（均非批内）每步 `fitViewportToContent()`；其内部在
            // `layoutDirty` 时 no-op。整段批回放仅 `endBatch` → `syncGraphToSvg`，fit 由调用方或 RO。
            fitViewportToContent();
        }
    }

    function reset(preserveUserViewport: boolean = false): void {
        const wasLayoutDirty = layoutDirty;
        clearGenAttributeDagAlignmentWarnDedupe();
        textMeasure.reset();
        graph.clear();
        nodes = [];
        links = [];
        stepProcessed = 0;
        selectedId = null;
        hoveredId = null;
        linkMarkersDefs.selectAll('marker').remove();
        linkG.selectAll('*').remove();
        linkGFront.selectAll('*').remove();
        nodeG.selectAll('*').remove();
        dagExcludeIntervals = [];
        linkSel = rootG
            .selectAll<SVGGElement, DagLink>('g.gen-attr-dag-link')
            .data<DagLink>([], dagLinkDataKey);
        nodeSel = nodeG.selectAll<SVGGElement, DagNode>('g.gen-attr-dag-node').data<DagNode>([], (d) => d.id);
        layoutDirty = preserveUserViewport ? wasLayoutDirty : false;
        userDraggedNodes = false;
    }

    function fitViewportToContent(force: boolean = false): void {
        syncSvgSize();
        if (layoutDirty && !force) {
            return;
        }
        const k0 = defaultDagZoomK();
        if (nodes.length === 0) {
            applyInitialDagZoom();
        } else {
            svg.call(zoomBehavior.transform, d3.zoomIdentity);
            const pad = 12;
            const { w, h } = stackLayoutViewportPx(stackEl);
            const innerW = Math.max(w - 2 * pad, 1);
            const innerH = Math.max(h - 2 * pad, 1);
            if (layoutMode === 'linear-arc') {
                /** 仅用 token 行宽度定比；竖直按行中心居中（弧不参与 bbox → 不致上下抖） */
                const bn = nodeG.node()!.getBBox();
                const bw = Math.max(bn.width, 1e-6);
                const kRaw = innerW / bw;
                const k = Math.min(Number.isFinite(kRaw) && kRaw > 0 ? kRaw : k0, k0);
                const tx = pad * 2 - k * bn.x;
                const rowMidY = bn.y + bn.height / 2;
                const ty = pad + innerH / 2 - k * rowMidY;
                svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
            } else if (layoutMode === 'spiral') {
                /**
                 * 螺旋：等比缩放 + 视口中心对齐曲线原点 (0,0)（{@link paintSpiralLayout} 坐标），
                 * 避免按 bbox 中心 fit 时随步进增长 centroid 漂移导致播放抖动。
                 */
                const b = rootG.node()!.getBBox();
                const xmin = b.x;
                const xmax = b.x + b.width;
                const ymin = b.y;
                const ymax = b.y + b.height;
                const halfW = innerW / 2;
                const halfH = innerH / 2;
                let kFromOrigin = Infinity;
                if (xmax > 0) kFromOrigin = Math.min(kFromOrigin, halfW / xmax);
                if (xmin < 0) kFromOrigin = Math.min(kFromOrigin, halfW / (-xmin));
                if (ymax > 0) kFromOrigin = Math.min(kFromOrigin, halfH / ymax);
                if (ymin < 0) kFromOrigin = Math.min(kFromOrigin, halfH / (-ymin));
                const bw = Math.max(b.width, 1e-6);
                const bh = Math.max(b.height, 1e-6);
                const kFromSides = Math.min(innerW / bw, innerH / bh);
                const kRaw = Number.isFinite(kFromOrigin) && kFromOrigin > 0 ? kFromOrigin : kFromSides;
                const k = Math.min(kRaw, k0);
                const tx = pad + halfW;
                const ty = pad + halfH;
                svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
            } else if (layoutMode === 'text-flow') {
                /** 与原实现一致：`rootG` 整包 bbox + 宽高双约束顶对齐 */
                const b = rootG.node()!.getBBox();
                const bw = Math.max(b.width, 1e-6);
                const bh = Math.max(b.height, 1e-6);
                const kRaw = Math.min(innerW / bw, innerH / bh);
                const k = Math.min(Number.isFinite(kRaw) && kRaw > 0 ? kRaw : k0, k0);
                const tx = pad * 2 - k * b.x;
                const ty = pad - k * b.y;
                svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
            } else {
                const _: never = layoutMode;
                throw new Error(`genAttributeDagView: unsupported layoutMode for fit (${String(_)})`);
            }
        }
        // 任何成功 fit（含 RO 自动 fit、refresh）都回到默认视图语义，下个 dirty 周期重新起算。
        layoutDirty = false;
        userDraggedNodes = false;
    }

    /**
     * 所有「容器尺寸变化」的统一入口：窗口 resize / 右栏宽度变化 / 全屏进出 / 新节点撑高测量层。
     * - 批量回放期间（`batchDepth > 0`）中间帧不可见，跳过
     * - 有图时走 `fitViewportToContent`：`layoutDirty` 时只 `syncSvgSize`、不改 pan/zoom；否则自动 fit
     */
    const ro = new ResizeObserver(() => {
        if (batchDepth > 0) return;
        // 有图时交 `fitViewportToContent`：内部在 `layoutDirty` 时只 `syncSvgSize`；空图时勿走 fit（与
        // 旧行为一致，避免对空图在 RO 上反复 `applyInitialDagZoom`）
        if (nodes.length > 0) {
            fitViewportToContent();
        } else {
            syncSvgSize();
        }
    });
    ro.observe(stackEl);

    let dagPlaybackPlaying = false;
    const playBtn = resultsRoot
        .append('button')
        .attr('type', 'button')
        .attr('class', 'refresh-btn gen-attr-dag-play')
        .attr('title', 'Play')
        .text('▶')
        .style('display', onDagPlaybackToggle ? null : 'none')
        .on('click', (event) => {
            event.stopPropagation();
            if (!onDagPlaybackToggle) return;
            onDagPlaybackToggle(!dagPlaybackPlaying);
        });

    function setDagPlaybackPlaying(playing: boolean): void {
        dagPlaybackPlaying = playing;
        playBtn.text(playing ? '⏸' : '▶').attr('title', playing ? 'Pause' : 'Play');
    }

    function setLayoutMode(mode: DagLayoutMode): void {
        if (layoutMode === mode) return;
        layoutMode = mode;
        syncStackLayoutDragUi();
        if (batchDepth > 0) return;
        syncGraphToSvg();
        fitViewportToContent(true);
    }

    function setLinearArcAdjacentGapPx(px: number, opts?: { skipRefit?: boolean }): void {
        if (!Number.isFinite(px)) {
            throw new Error('genAttributeDagView: linear arc adjacent node gap must be finite');
        }
        const next = clampLinearArcAdjacentGap(px);
        if (linearArcAdjacentGapPx === next) return;
        linearArcAdjacentGapPx = next;
        if (opts?.skipRefit || batchDepth > 0) return;
        if (layoutMode !== 'linear-arc' || nodes.length === 0) return;
        paint();
        fitViewportToContent(true);
    }

    function setHideExcludedTokens(hide: boolean): void {
        if (hideExcludedTokens === hide) return;
        hideExcludedTokens = hide;
        if (batchDepth > 0 || nodes.length === 0) return;
        paint();
        refreshNodeLinkHighlight();
        fitViewportToContent(true);
    }

    const fullscreenBtn = resultsRoot
        .append('button')
        .attr('type', 'button')
        .attr('class', 'refresh-btn gen-attr-dag-fullscreen')
        .attr('title', 'Fullscreen')
        .text('⛶');

    // 全屏：以 Fullscreen API 为主；伪全屏仅作浏览器不支持时的降级（详见 genAttributeDagFullscreenWorkaround.ts）

    function updateFullscreenBtnIcon(): void {
        const active = dagResultsSurfaceFullscreenExpanded(rootEl);
        fullscreenBtn.text(active ? '×' : '⛶').attr('title', active ? 'Exit fullscreen' : 'Fullscreen');
    }

    function refreshFullscreenChrome(): void {
        updateFullscreenBtnIcon();
        syncSvgSize();
    }

    fullscreenBtn.on('click', (event) => {
        event.stopPropagation();
        void (async (): Promise<void> => {
            await runDagFullscreenToggleWithPseudoWorkaround({
                rootEl,
                onNativeExitFailure: reportFullscreenFailure,
            });
            refreshFullscreenChrome();
        })();
    });

    // 原生全屏与伪全屏（降级）共用同一刷新函数：按钮态 + SVG 尺寸
    document.addEventListener('fullscreenchange', refreshFullscreenChrome);
    document.addEventListener(CSS_PSEUDO_FULLSCREEN_CHANGE_EVENT, refreshFullscreenChrome);

    resultsRoot
        .append('button')
        .attr('type', 'button')
        .attr('class', 'refresh-btn gen-attr-dag-refresh')
        .attr('title', 'Refresh')
        .text('↻')
        .on('click', (event) => {
            event.stopPropagation();
            // 刷新语义：
            //   clean → fit
            //   dirty 且仅 pan/zoom（未拖节点）→ 回放 + fit
            //   dirty 且拖过节点 → 回放恢复节点几何 + 保留 pan/zoom
            // `reset()` 会清 `layoutDirty`/`userDraggedNodes`，而回放后 RO 还会异步触发一次（测量层增长）；
            // 为让那次 RO tick 不踩 dirty 决策，在 `reset` 前保存 wasDirty / wasNodeDragged。
            const wasDirty = layoutDirty;
            const wasNodeDragged = userDraggedNodes;
            const shouldFit = !wasDirty || !wasNodeDragged;
            reset();
            onDagRefresh?.();
            if (shouldFit) {
                fitViewportToContent(true);
            } else {
                layoutDirty = true;
            }
            // 重放每步仍会在 `update` 内选中末步节点；生成结束无 onComplete，此处统一清选中
            clearNodeSelection();
        });

    syncSvgSize();

    function detach(): void {
        detachDagPseudoFullscreenIfPresent(rootEl);
        ro.disconnect();
        document.removeEventListener('fullscreenchange', refreshFullscreenChrome);
        document.removeEventListener(CSS_PSEUDO_FULLSCREEN_CHANGE_EVENT, refreshFullscreenChrome);
        resultsRoot
            .selectAll(
                '.gen-attr-dag-stack, button.gen-attr-dag-refresh, button.gen-attr-dag-play, button.gen-attr-dag-fullscreen'
            )
            .remove();
        detachGenAttributeDagPanel.delete(rootEl);
    }

    detachGenAttributeDagPanel.set(rootEl, detach);

    return {
        setPromptTokenSpans,
        update,
        beginBatch,
        endBatch,
        isBatching,
        reset,
        fitViewportToContent,
        clearNodeSelection,
        setDagPlaybackPlaying,
        setMeasureWidthPx,
        setLayoutMode,
        setLinearArcAdjacentGapPx,
        setDagCompactness,
        setEdgeTopPCoverage,
        setHideExcludedTokens,
        hasPromptSpans: () => nodes.some((n) => n.step === -1),
        detach,
    };
}
