import * as d3 from 'd3';
import { DirectedGraph } from 'graphology';
import type { D3Sel } from '../../core/Util';
import { visualizeSpecialChars } from '../../cross/tokenDisplayUtils';
import {
    clampDagEdgeTopPCoverage,
    collectDeletePromptIntervals,
    collectGenAttrDagExcludeIntervals,
    DAG_EDGE_TOP_P_COVERAGE_DEFAULT,
    excludeNodeAggregatedEntries,
    phase2RankAndSparsify,
    type PromptTokenSpan,
} from './genAttributeDagPreprocess';
import type { CharRange } from './tokenGenAttributionRunner';
import {
    DAG_EDGE_MIN_NORMALIZED_SCORE,
    DAG_MIN_ATTRIBUTION_SHARE,
    DAG_NODE_STROKE_OPACITY_BASE,
} from './genAttributeDagEdgeDisplay';
import {
    buildMaxNormalizedRenderStrengthByKey,
    normalizeEdgeRenderOpacity,
} from './genAttributeDagEdgeRenderStrength';
import { DAG_CAUSAL_FLOW_ICON } from './genAttributeDagIcons';
import {
    backwardSlideIncomingEdgeKeysForBatch,
    createDagRecursiveEdgeAnimationController,
    type DagRecursiveEdgeReplayPacing,
    maxHighlightEdgeShare,
    type DagFocusAttributionState,
    type DagRecursiveEdgeAnimationDirection,
} from './genAttributeDagRecursiveEdgeAnimation';
import {
    clampDimInactiveTokensThreshold,
    dagNodeLowVisibilityReason,
    DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT,
    isDagNodeInactiveByTotalShare,
} from './genAttributeDagNodeDim';
export type { DagRecursiveEdgeAnimationDirection };
import {
    computeMutualInformationRatio,
    computeConditionalInformationRatio,
    dagCiVisualScaleFromTargetProb,
    dagPropagationMiRatio,
    FULL_CONFIDENCE_PROBABILITY_BASELINE,
} from '../../cross/surprisalMath';
import { isOffsetSpanFullyExcluded } from '../core/attributionDisplayModel';
import {
    alignAndAggregateByNode,
    clearGenAttributeDagAlignmentWarnDedupe,
    type NodeInterval,
    type PieceEntry,
} from './genAttributeDagIntervalResolve';
import type { FrontendToken } from '../../../shared/api/GLTR_API';
import type { TokenGenStep } from './tokenGenAttributionRunner';
import { createGenAttributeDagTextMeasure } from './genAttributeDagTextMeasure';
import { frontendTokenFromGenAttrStep } from './genAttributeDagTopkToken';
import { SimpleEventHandler } from '../../core/SimpleEventHandler';
import { ToolTip, type ToolTipUpdateAugment } from '../../../shared/vis/ToolTip';
import { formatTopkTooltipProbabilityPercent } from '../../cross/topkChartUtils';
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
    LINEAR_ARC_STEP_DOWN_DISTANCE_SCALE,
    paintLinearArcLayout,
} from './genAttributeDagViewLinearArcMode';
import { paintTextFlowLayout } from './genAttributeDagViewTextFlowMode';
import { paintSpiralLayout } from './genAttributeDagViewSpiralMode';
import { tr } from '../../../shared/lang/i18n-lite';

/** 再次挂载前执行上一轮 detach（当前为空操作，保留扩展点） */
const detachGenAttributeDagPanel = new WeakMap<HTMLElement, () => void>();

/** 节点布局模式：`text-flow` 按文字排版层几何；`linear-arc` / `linear-arc-step-down` 为线性序 + 弧线连边（后者按 CI 逐级下移）；`spiral` 螺旋排布。 */
export type DagLayoutMode = 'text-flow' | 'linear-arc' | 'linear-arc-step-down' | 'spiral';
function isLinearArcFamilyLayout(mode: DagLayoutMode): mode is 'linear-arc' | 'linear-arc-step-down' {
    return mode === 'linear-arc' || mode === 'linear-arc-step-down';
}

export const DAG_COMPACTNESS_DEFAULT = 0.5;
/** 下限取小正数以满足 {@link readDisplayScaleFromCss}「必须为正」且不出现零宽度边线。 */
export const DAG_COMPACTNESS_MIN = 0.05;
export const DAG_COMPACTNESS_MAX = 1;

export function clampDagCompactness(n: number): number {
    if (!Number.isFinite(n)) return DAG_COMPACTNESS_DEFAULT;
    return Math.min(DAG_COMPACTNESS_MAX, Math.max(DAG_COMPACTNESS_MIN, n));
}



/** 节点 CI 视觉放大开关；`false` 时所有生成节点 ciVisualScale 恒为 1×，下次 update() 起生效。 */
let dagNodeCiVisualScaleEnabled = false;
export function setDagNodeCiVisualScaleEnabled(enabled: boolean): void {
    dagNodeCiVisualScaleEnabled = enabled;
}

/**
 * 「Decay attribution to high-surprisal targets」——递归归因的配套开关。
 * 开启：沿链向上时，在高惊讶度（低置信 / teacher forcing）的**生成 token** 处用 MI 折扣传播预算，
 * 使它们成为与 prompt 同类的「来源」，链在此变短。
 * 关闭：所有生成 token 视为透明管道，预算不衰减，链只止于 prompt。
 * `false` 时 `mutualInformationRatio` 仍按目标概率存储与展示，传播/边强度计算中 MI 系数恒为 1。
 */
let dagDecayAttributionToHighSurprisalTargetEnabled = false;
export function setDagDecayAttributionToHighSurprisalTargetEnabled(enabled: boolean): void {
    dagDecayAttributionToHighSurprisalTargetEnabled = enabled;
}

/**
 * DAG 生成节点矩形/标签缩放：CI=0→1×，CI=1→2×（prompt 节点恒用 1，见建点处）。
 * p > {@link FULL_CONFIDENCE_PROBABILITY_BASELINE}（surprisal < 2 bit）时截断为 1×，不放大。
 * {@link dagNodeCiVisualScaleEnabled} 为 false 时恒返回 1。
 */
function dagGeneratedNodeCiVisualScale(targetProb: number | undefined): number {
    return dagCiVisualScaleFromTargetProb(targetProb, dagNodeCiVisualScaleEnabled);
}

/** DAG Top‑K tooltip 内 CI/MI 行，数值格式与原节点原生 title 一致（{@link formatTopkTooltipProbabilityPercent}）。 */
function dagCiMiTooltipRowForProb(targetProb: number | undefined): { label: string; value: string } | undefined {
    if (targetProb === undefined || !Number.isFinite(targetProb)) return undefined;
    const ciRatio = computeConditionalInformationRatio(targetProb);
    const miRatio = computeMutualInformationRatio(targetProb);
    const ci = Number.isFinite(ciRatio) ? formatTopkTooltipProbabilityPercent(ciRatio) : String(ciRatio);
    const mi = Number.isFinite(miRatio) ? formatTopkTooltipProbabilityPercent(miRatio) : String(miRatio);
    return { label: 'CI/MI:', value: `${ci} / ${mi}` };
}

const TOOLTIP_NA = 'N/A';

/** 边原生 `<title>` 中互信息率 α 的展示。 */
function formatMutualInformationRatioForTooltip(miRatio: number | undefined): string {
    if (miRatio === undefined || !Number.isFinite(miRatio)) return TOOLTIP_NA;
    return formatTopkTooltipProbabilityPercent(miRatio);
}

function isPositiveFiniteShare(share: number | undefined): share is number {
    return typeof share === 'number' && Number.isFinite(share) && share > 0;
}

/**
 * 边级 MI 系数（直接归因强度、无焦点灰边）。
 * 递归链上的传播折扣在节点级 {@link nodePropagationMiRatio}，二者分工不同。
 */
function effectiveMiRatio(miRatio: number | undefined): number | undefined {
    if (!dagDecayAttributionToHighSurprisalTargetEnabled) return 1;
    if (miRatio === undefined || !Number.isFinite(miRatio)) return undefined;
    return miRatio;
}

function formatTooltipAttributionScore(normalizedScore: number | undefined): string {
    if (normalizedScore === undefined || !Number.isFinite(normalizedScore)) return TOOLTIP_NA;
    return normalizedScore.toFixed(3);
}

/** 直接归因份额的展示：L1 份额 × 目标真实 MI（与弱化开关无关，仅供读数）。 */
function formatTooltipDirectAttributionShare(
    attributionShare: number | undefined,
    miRatio: number | undefined,
): string {
    if (!isPositiveFiniteShare(attributionShare)) return TOOLTIP_NA;
    if (miRatio === undefined || !Number.isFinite(miRatio)) return TOOLTIP_NA;
    return formatTopkTooltipProbabilityPercent(attributionShare * miRatio);
}

function formatTooltipRecursiveAttributionShare(share: number | undefined): string {
    if (share === undefined || !Number.isFinite(share)) return TOOLTIP_NA;
    return formatAttributionSharePercentForTooltip(share);
}

/** 节点 tooltip 归因份额：低于 {@link DAG_MIN_ATTRIBUTION_SHARE} 时显示 `< x%`（x 为阈值，1 位有效数字）。 */
function formatAttributionSharePercentForTooltip(share: number): string {
    const thresholdLabel = d3.format('.1g')(DAG_MIN_ATTRIBUTION_SHARE * 100) + '%';
    if (!Number.isFinite(share) || share < DAG_MIN_ATTRIBUTION_SHARE) {
        return `< ${thresholdLabel}`;
    }
    return formatTopkTooltipProbabilityPercent(share);
}

function formatTooltipLinkStrength(strength: number): string {
    return Number.isFinite(strength) ? strength.toFixed(3) : TOOLTIP_NA;
}

export {
    clampLinearArcAdjacentGap,
    LINEAR_ARC_ADJACENT_GAP_DEFAULT,
    LINEAR_ARC_ADJACENT_GAP_MAX,
    LINEAR_ARC_ADJACENT_GAP_MIN,
    LINEAR_ARC_BEZIER_HANDLE_INSET_FRACTION,
    LINEAR_ARC_STEP_DOWN_DISTANCE_SCALE,
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
    /**
     * 本步 {@link TokenGenStep} 的 `response.target_prob`（仅生成节点）。
     * 下台阶等处用 {@link dagStepDownEffectiveCiRatio}(dagTargetProb)（高置信 p>p₁ 为 0；与「关闭 CI 视觉」无关）；
     */
    dagTargetProb?: number;
    /** {@link visualizeSpecialChars}（DAG 节点：词界空格 + 不可打印为 `[]`），建点后不变；边 tooltip 用完整 `[hex]` */
    displayLabel: string;
    /** 悬停 / 选中焦点时 Top‑K tooltip；仅生成节点（`step >= 0`） */
    gltrTooltipToken?: FrontendToken;
    /** 跟在 tooltip 内 log perplexity 行之后的 CI/MI；与 {@link dagCiMiTooltipRowForProb} 同源 */
    dagCiMiTooltipRow?: { label: string; value: string };
};

type DagNode = DagNodeAttrs;

type DagLink = {
    source: string;
    target: string;
    /**
     * 候选池内 max 归一后的归因分，区间约 [0, 1]；作为 `stroke-opacity` 的基项（再乘 {@link mutualInformationRatio}）。
     * 池内稀疏化与建边前过滤均使用 {@link DAG_EDGE_MIN_NORMALIZED_SCORE}（见 genAttributeDagEdgeDisplay）。
     */
    normalizedScore?: number;
    /** 互信息率：仅作为本步入边的视觉透明度系数，不参与归因筛选。 */
    mutualInformationRatio?: number;
    /** 本步内：该边在可见入边池内的 L1 份额（建边阈值过滤后归一），追因传播的基本单位。 */
    attributionShare?: number;
    /** 与 `console.warn('[genAttributeDagView.align] …')` 正文一致（可多条，换行拼接） */
    alignmentNote?: string;
};

/**
 * 该边的 attribution share：优先使用可见边池内的 L1 份额；无 attributionShare 时回退到 max-normalized score。
 * max-normalized score 作为后备仅用于 attributionShare 尚未计算（如阈值过滤前）的场景。
 */
function edgeAttributionShare(d: Pick<DagLink, 'attributionShare' | 'normalizedScore'>): number {
    const share = d.attributionShare;
    if (typeof share === 'number' && Number.isFinite(share) && share > 0) return share;
    const s = d.normalizedScore ?? 1;
    return Number.isFinite(s) ? Math.max(0, s) : 1;
}

/**
 * 无焦点时的边渲染强度：attribution share × {@link effectiveMiRatio}。
 * 「Decay attribution to high-surprisal targets」关闭时 MI 系数恒为 1（展示仍见 {@link formatMutualInformationRatioForTooltip}）。
 */
function directAttributionStrength(
    d: Pick<DagLink, 'attributionShare' | 'normalizedScore' | 'mutualInformationRatio'>,
): number {
    const mi = effectiveMiRatio(d.mutualInformationRatio) ?? 1;
    return edgeAttributionShare(d) * mi;
}

function dagLinkEndpointKey(source: string, target: string): string {
    return `${source}->${target}`;
}

/** 节点 target 端 MI ratio（与 tooltip「Target MI ratio」同源；与 decay 开关无关）。 */
function nodeTargetMiRatio(node: DagNode): number {
    return computeMutualInformationRatio(node.dagTargetProb);
}

/**
 * 候选归因节点描边透明度：池内 `stay / max(stay)` 线性映射到 `[{@link DAG_NODE_STROKE_OPACITY_BASE}, 1]`，
 * 避免弱节点描边过淡、在 UI 里看不出来（见 {@link DAG_NODE_STROKE_OPACITY_BASE}）。
 */
function normalizeNodeStrokeRenderOpacity(share: number, maxShare: number): number {
    if (!Number.isFinite(share) || share <= 0) return 0;
    const scaled =
        !Number.isFinite(maxShare) || maxShare <= 0
            ? Math.min(1, share)
            : Math.min(1, share / maxShare);
    if (scaled <= 0) return 0;
    return DAG_NODE_STROKE_OPACITY_BASE + scaled * (1 - DAG_NODE_STROKE_OPACITY_BASE);
}

/** 焦点在 target 时单条入边份额（直接模式一跳；灰边与此时蓝边共用）。 */
function perTargetIncomingEdgeShare(
    link: Pick<DagLink, 'attributionShare' | 'normalizedScore'>,
    targetNode: DagNode,
): number {
    const upstreamBudget = nodePropagationMiRatio(targetNode);
    return Math.min(1, upstreamBudget * edgeAttributionShare(link));
}

/** 灰边 stroke-opacity：按各 target 入边池归一，与焦点在该 target 时的蓝边一致。 */
function buildGrayRenderStrengthByEdgeKey(
    graph: DirectedGraph<DagNodeAttrs>,
    incomingLinksByTarget: Map<string, DagLink[]>,
): Map<string, number> {
    const byKey = new Map<string, number>();
    for (const [targetId, links] of incomingLinksByTarget) {
        if (!graph.hasNode(targetId)) continue;
        const targetNode = graph.getNodeAttributes(targetId) as DagNode;
        // prompt 节点（step < 0）不应出现在 incomingLinksByTarget（仅 update() 中生成节点作为 target 时写入），
        // 此处防御：nodePropagationMiRatio 对 prompt 返回 0，全组 share=0，跳过以节省迭代。
        if (targetNode.step < 0) continue;
        let maxShare = 0;
        const rows: Array<{ key: string; share: number }> = [];
        for (const link of links) {
            if (!graph.hasEdge(link.source, link.target)) continue;
            const srcId = endpointNode(link.source, graph).id;
            const share = perTargetIncomingEdgeShare(link, targetNode);
            if (share > maxShare) maxShare = share;
            rows.push({ key: dagLinkEndpointKey(srcId, targetId), share });
        }
        for (const { key, share } of rows) {
            byKey.set(key, normalizeEdgeRenderOpacity(share, maxShare));
        }
    }
    return byKey;
}

/** 稳定态 stay：nodeShare × (1 − 传导系数)；与 tooltip 份额语义一致。 */
function computeSteadyStateStayShareById(
    nodeShareById: Map<string, number>,
    graph: DirectedGraph<DagNodeAttrs>,
    focusId: string,
): Map<string, number> {
    const byNodeId = new Map<string, number>();
    for (const [nodeId, nodeShare] of nodeShareById) {
        if (nodeId === focusId) continue;
        const stay = nodeShare * (1 - nodePropagationMiRatio(graph.getNodeAttributes(nodeId) as DagNode));
        if (stay >= DAG_MIN_ATTRIBUTION_SHARE) byNodeId.set(nodeId, stay);
    }
    return byNodeId;
}

/** 递归链候选节点描边强度：stay 池内 max 归一后映射到 `[{@link DAG_NODE_STROKE_OPACITY_BASE}, 1]`。 */
function buildNodeStrokeRenderStrengthById(
    stayByNodeId: Map<string, number>,
    maxShareOverride?: number,
): Map<string, number> {
    const maxShare =
        maxShareOverride != null && Number.isFinite(maxShareOverride) && maxShareOverride > 0
            ? maxShareOverride
            : maxHighlightEdgeShare(stayByNodeId);
    const byNodeId = new Map<string, number>();
    for (const [nodeId, stay] of stayByNodeId) {
        byNodeId.set(nodeId, normalizeNodeStrokeRenderOpacity(stay, maxShare));
    }
    return byNodeId;
}

/**
 * 流式增量：任一端节点 span 完全落在排除区间内则删边（不重算 Top‑N，与全量重放可轻微不一致）。
 * 同步 graphology 与并行 `links`。
 */
function pruneDagLinksTouchingFullyExcludedNodes(
    graph: DirectedGraph<DagNodeAttrs>,
    links: DagLink[],
    incomingLinksByTarget: Map<string, DagLink[]>,
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

    for (const [targetId, incoming] of incomingLinksByTarget) {
        if (incoming.length === 0) {
            incomingLinksByTarget.delete(targetId);
            continue;
        }
        let keep = 0;
        for (const link of incoming) {
            if (removedLinkKeys.has(dagLinkEndpointKey(link.source, link.target))) {
                continue;
            }
            incoming[keep++] = link;
        }
        if (keep === 0) {
            incomingLinksByTarget.delete(targetId);
            continue;
        }
        incoming.length = keep;
        if (!graph.hasNode(targetId)) {
            incomingLinksByTarget.delete(targetId);
        }
    }
}

const SVG_MIN_W = 320;
const SVG_MIN_H = 280;

/** text-flow：`fitViewportToContent` 四边对称边距（px）。 */
const DAG_TEXT_FLOW_FIT_PAD_PX = 24;

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
/** linear-arc / linear-arc-step-down：同上 */
const DAG_INITIAL_ZOOM_BOOST_LINEAR_ARC = 4;
/** spiral：同上 */
const DAG_INITIAL_ZOOM_BOOST_SPIRAL = 2;

function dagInitialZoomBoost(mode: DagLayoutMode): number {
    switch (mode) {
        case 'text-flow':
            return DAG_INITIAL_ZOOM_BOOST_TEXT_FLOW;
        case 'linear-arc':
        case 'linear-arc-step-down':
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
/** 与 {@link start.scss} `--dag-highlight-line-color-in`（`--accent-color`）一致（入边：指向焦点） */
const CSS_VAR_DAG_HIGHLIGHT_LINE_IN = '--dag-highlight-line-color-in';
/** 与 {@link start.scss} `--dag-highlight-line-color-out` 一致（出边：从焦点出发） */
const CSS_VAR_DAG_HIGHLIGHT_LINE_OUT = '--dag-highlight-line-color-out';
/** 与 causal_flow.scss 中 `--recursive-chain` 的 `stroke-opacity` 一致（由 JS 写入 g 元素） */
const CSS_VAR_DAG_NODE_RECURSIVE_SHARE = '--gen-attr-dag-node-recursive-share';

/** DAG 节点 `opacity` 档位（exclude 完全隐藏时另用 `display:none`） */
const DagNodeOpacityLevel = {
    /** 全亮：归因链上高亮节点；无焦点时的默认 */
    full: 1,
    /** 弱化：存在焦点时链外，或无出边 prompt 叶子 */
    weakened: 0.6,
    /** 几乎隐藏：exclude 命中且保留占位 */
    almostHidden: 0.1,
    /** 隐藏：exclude 命中且完全隐藏 */
    hidden: 0,
} as const;

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

/** stroke rect 外扩 pad=displayScale，与 scss `stroke-width: calc(2 * display-scale)` 一致，描边不压 fill。 */
function syncNodeStrokeRects(
    sel: d3.Selection<SVGGElement, DagNode, SVGGElement | null, unknown>,
    displayScale: number,
): void {
    const p = displayScale;
    sel.select('rect.gen-attr-dag-node-stroke')
        .attr('x', -p)
        .attr('y', -p)
        .attr('width', (d) => d.nodeW + 2 * p)
        .attr('height', (d) => d.nodeH + 2 * p)
        .attr('rx', (d) => nodeRx(d) + p)
        .attr('ry', (d) => nodeRx(d) + p);
}

export type SetPromptTokenSpansOpts = {
    /** exclude 语义；未传时默认 `[[0, layoutWire.length)]` */
    inputRanges?: CharRange[];
};

export type GenAttributeDagHandle = {
    /**
     * 在首帧 `update`（第一步生成 token）之前调用：用累积 input token spans 建 prompt 层节点。
     * 可多次调用；每次传入全量 input spans 与 layout wire，view 内部 diff 追加新节点。
     * @param layoutWire 与 offsets 同系的累积全文（首帧可为纯 prompt；回放/追加时为完整 wire）
     */
    setPromptTokenSpans(spans: PromptTokenSpan[], layoutWire: string, opts?: SetPromptTokenSpansOpts): void;
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
     * @param preserveUserViewport 为 `true` 时保留调用前的 `layoutDirty`：设置项切换后重放、
     * 步进重放从末尾重头播放等保留用户 pan/zoom。默认 `false`（新一次 run 等场景仍从干净视口起算）。
     */
    reset(preserveUserViewport?: boolean): void;
    /**
     * zoom identity 后按内容适配视口；空图走默认缩放；`k` 上限 `k₀`（随当前布局模式的初始 zoom 倍率变化）。
     * - `text-flow`：`rootG.getBBox()`（含边）等比落入内框；四边对称各 {@link DAG_TEXT_FLOW_FIT_PAD_PX}px。
     * - `linear-arc` / `linear-arc-step-down`：仅按 `gen-attr-dag-nodes` 行宽定比，token 行相对内框竖直居中（弧不参与）。
     * 若 `layoutDirty` 为真则 no-op（仅已执行的 `syncSvgSize` 生效，不改 pan/zoom），但 `force` 为真时仍
     * fit 并清 dirty（例如刷新按钮的强制适配）。
     */
    fitViewportToContent(force?: boolean): void;
    /** 当前选中节点 id；无选中为 `null`。 */
    getSelectedNodeId(): string | null;
    /** 用户点击确立的传播播放焦点；与 {@link getSelectedNodeId} 解耦（步进 update 会改 selected 但不改此项）。 */
    getUserFocusId(): string | null;
    /** 设置选中节点（`null` 清除）；节点须已存在于图中。不更新 {@link getUserFocusId}。 */
    setSelectedNodeId(id: string | null): void;
    /**
     * 同时设置用户传播焦点与选中描边（demo 快照恢复等）；`null` 等价于 {@link clearNodeSelection}。
     */
    setUserFocusNodeId(id: string | null): void;
    /** 清除节点选中态（与点击画布空白等价）；不改变图数据，生成结束后可调用以去掉末 token 描边 */
    clearNodeSelection(): void;
    /** DAG 步进重放：更新 ▶ / ⏸ 按钮文案（由页面在播放开始/结束/暂停时调用） */
    setDagPlaybackPlaying: (playing: boolean) => void;
    /** 传播链动画处于播放/暂停/结束可续播（非 idle）。 */
    isPropagationPlaybackEngaged(): boolean;
    /** 停止传播链播放并清动画状态（不改变 {@link getUserFocusId}）。 */
    stopPropagationPlayback(): void;
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
     * linear-arc 家族下相邻节点矩形外侧边的水平间隙（px）。仅影响该家族几何；若在生成/播放中途调用且
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
     * 切换 exclude / inactive（0.1 档）节点的隐藏模式（UI: Hide exclude/inactive tokens）：
     * - `true`：完全隐藏（`display:none`）；linear-arc 下同时不参与布局。
     * - `false`（默认）：保留为「几乎隐藏」（{@link DagNodeOpacityLevel.almostHidden}）占位。
     */
    setHideExcludedTokens(hide: boolean): void;
    /** Causal Flow：按 Attribution share (Total) 将低份额节点降至 0.1。 */
    setDimInactiveTokens(enabled: boolean): void;
    setDimInactiveTokensThreshold(threshold: number): void;
    /** Dim inactive 开启时：传播动画播放/暂停期间不 dim。 */
    setDimInactiveNotDuringAnimation(enabled: boolean): void;
    /** 是否显示 token tooltip（UI: Show token tooltip；`showTokenInfoOnSelected`）。 */
    setShowTokenInfoOnSelected(show: boolean): void;
    /** 是否启用传播归因（UI: Propagated attribution mode；`recursiveAttributionEnabled`）。 */
    setRecursiveAttributionEnabled(enabled: boolean): void;
    /** 传播链播放方向（forward / backward）。 */
    setRecursiveEdgeBatchAnimationDirection(direction: DagRecursiveEdgeAnimationDirection): void;
    /** 是否在直接归因焦点上额外展示从焦点出发的下游影响出边。 */
    setShowDownstreamInfluence(show: boolean): void;
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

/**
 * 边当前显示状态；在 {@link refreshNodeLinkHighlight} 中与 stroke 一并刷新 `<title>`。
 *
 * {@link recursiveAttributionShare} 为当前焦点下传播归因链上的份额（UI: Propagated；仅入边链；无焦点或不在链上为 undefined）。
 * {@link linkStrength} 为 tooltip 用的原始强度；{@link renderStrength} 为写入 stroke-opacity 的值（直接模式灰边与蓝边同刻度）。
 * 空行以上为建边后不变的直接归因指标。不用「opacity」命名：灰边与蓝/红高亮边在相同强度下 `stroke-opacity` 数值可相同，但肉眼对比度不同，
 * 视觉效果由 stroke 颜色与透明度共同衍生，强度才是可比较的固定量。
 */
type DagLinkTitleSnapshot = {
    normalizedScore?: number;
    mutualInformationRatio?: number;
    attributionShare?: number;
    alignmentNote?: string;
    src: DagNode;
    tgt: DagNode;
    /** 递归链入边上的传播份额 edgeShare；不在链上时为 undefined（直接模式或无焦点）。 */
    recursiveAttributionShare?: number;
    linkStrength: number;
};

function buildLinkTitleText(snapshot: DagLinkTitleSnapshot): string {
    // 建边后不变；空行以下随焦点/传播归因变化（Attribution share (Propagated)、Link strength）。
    const staticMetrics = [
        `Attribution score: ${formatTooltipAttributionScore(snapshot.normalizedScore)}`,
        `Target MI ratio: ${formatMutualInformationRatioForTooltip(snapshot.mutualInformationRatio)}`,
        `Attribution share (Adjacent): ${formatTooltipDirectAttributionShare(
            snapshot.attributionShare,
            snapshot.mutualInformationRatio,
        )}`,
    ];
    if (snapshot.alignmentNote) {
        staticMetrics.push(snapshot.alignmentNote);
    }

    const metrics = [
        staticMetrics.join('\n'),
        '',
        `Attribution share (Propagated): ${formatTooltipRecursiveAttributionShare(snapshot.recursiveAttributionShare)}`,
        `Link strength: ${formatTooltipLinkStrength(snapshot.linkStrength)}`,
    ];

    const dagTooltipLabelOpts = { spaceDotExceptBeforeAsciiLetterOrNumber: true as const };
    return [
        `From:\n${visualizeSpecialChars(snapshot.src.label, dagTooltipLabelOpts)}\nOffset: ${formatNodeOffsetRange(snapshot.src.id)}`,
        `To:\n${visualizeSpecialChars(snapshot.tgt.label, dagTooltipLabelOpts)}\nOffset: ${formatNodeOffsetRange(snapshot.tgt.id)}`,
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

/**
 * 传播归因 vs 直接归因（设计理念）
 *
 * UI 称 Propagated attribution mode；代码标识 `recursiveAttribution*`（递归向上传播份额，二者同义）。
 *
 * - 直接归因：只看一跳前驱，回答“它直接依赖了谁”。
 * - 传播归因：持续向上追溯，直到信息来源，回答“真正原因来自哪里”。
 *
 * 来源通常有两类：prompt，或低置信/高惊讶的生成 token（含 teacher forcing）。
 * 高置信中间 token 更像传导节点，归因会继续穿过它。
 *
 * UI 语义：
 * - 灰边：各 target 入边池内 max 归一（无焦点时的默认边）；
 * - 焦点蓝入边：链内 max 归一，最强边刻度统一为焦点 MI ratio（动画前沿仅改归一分母与可见性，不 per-edge 再乘 MI）；
 *   最终 opacity 不低于 {@link DAG_EDGE_RENDER_OPACITY_FLOOR}；
 * - 上游节点描边（仅传播归因）：stay 池内 max 归一，映射到 `[{@link DAG_NODE_STROKE_OPACITY_BASE}, 1]`；直接模式一跳由边色表达，不描边。
 * - 传播模式节点提亮与 stay 描边一致：仅焦点 + stay 达阈的上游（传导节点仅蓝边，不提亮）。
 */
type FocusAttributionState = DagFocusAttributionState;

/** 节点在递归传播中的传导系数：越低越像来源，越高越像传导节点。 */
function nodePropagationMiRatio(node: DagNode): number {
    if (node.step < 0) return 0;
    if (!dagDecayAttributionToHighSurprisalTargetEnabled) return 1;
    return dagPropagationMiRatio(node.dagTargetProb);
}

type DagLinkHighlightDisplay = {
    stroke: string;
    /** 写入 stroke-opacity（链内 max 归一；蓝入边最强边刻度见 {@link refreshNodeLinkHighlight}，红出边/灰边为 1）。 */
    renderStrength: number;
    /** tooltip「Link strength」：原始强度，不做归一。 */
    linkStrength: number;
    recursiveAttributionShare?: number;
};

/** 焦点下边的视觉规则：传播归因看“向上原因链”，直接看“一跳关系 + 可选下游影响”。 */
function resolveDagLinkHighlightDisplay(
    d: DagLink,
    edgeKey: string,
    focusState: FocusAttributionState | null,
    recursiveAttributionEnabled: boolean,
    grayRenderByKey: Map<string, number>,
    incomingHighlightRenderByKey: Map<string, number>,
    downstreamHighlightRenderByKey: Map<string, number>,
    backwardSlideIncomingRenderByKey: Map<string, number> | null,
): DagLinkHighlightDisplay {
    const directStrength = directAttributionStrength(d);
    const grayRender = grayRenderByKey.get(edgeKey) ?? directStrength;

    if (focusState) {
        const downstreamStrength = focusState.downstreamEdgeStrengthByKey.get(edgeKey);
        if (downstreamStrength != null) {
            return {
                stroke: `var(${CSS_VAR_DAG_HIGHLIGHT_LINE_OUT})`,
                renderStrength: downstreamHighlightRenderByKey.get(edgeKey)!,
                linkStrength: downstreamStrength,
            };
        }

        const incomingShare = focusState.incomingEdgeShareByKey.get(edgeKey);
        if (incomingShare != null) {
            const backwardSlideRender = backwardSlideIncomingRenderByKey?.get(edgeKey);
            return {
                stroke:
                    backwardSlideRender != null
                        ? `var(${CSS_VAR_DAG_HIGHLIGHT_LINE_OUT})`
                        : `var(${CSS_VAR_DAG_HIGHLIGHT_LINE_IN})`,
                renderStrength:
                    backwardSlideRender ?? incomingHighlightRenderByKey.get(edgeKey)!,
                linkStrength: incomingShare,
                recursiveAttributionShare: recursiveAttributionEnabled ? incomingShare : undefined,
            };
        }
    }

    return {
        stroke: `var(${CSS_VAR_DAG_NORMAL_LINE_COLOR})`,
        renderStrength: grayRender,
        linkStrength: directStrength,
    };
}

function computeFocusAttributionState(
    graph: DirectedGraph<DagNodeAttrs>,
    nodesSortedByStepDesc: DagNode[],
    incomingLinksByTarget: Map<string, DagLink[]>,
    focusId: string,
    options: {
        maxIncomingDepth: number;
        includeDownstreamInfluence: boolean;
        /** 若设，仅沿这些传播链入边向上追溯（backward 动画逐步亮边时的部分状态）。 */
        allowedEdgeKeys?: ReadonlySet<string>;
    },
): FocusAttributionState | null {
    if (!graph.hasNode(focusId)) return null;

    // 从焦点向上追溯：递归模式追到来源；直接模式仅保留一跳前驱。
    const activeNodeIds = new Set<string>([focusId]);
    const incomingEdgeShareByKey = new Map<string, number>();
    const downstreamEdgeStrengthByKey = new Map<string, number>();
    const nodeShareById = new Map<string, number>([[focusId, 1]]);
    const remainingDepthByNodeId = new Map<string, number>([[focusId, options.maxIncomingDepth]]);

    for (const node of nodesSortedByStepDesc) {
        // min(1)/max(0) 仅防御，正常路径下 nodeShare ∈ (0, 1]。
        const nodeShare = Math.min(1, Math.max(0, nodeShareById.get(node.id) ?? 0));
        if (nodeShare <= 0) continue;
        const remainingDepth = remainingDepthByNodeId.get(node.id) ?? 0;
        if (remainingDepth <= 0) continue;

        // 低系数节点更接近来源，高系数节点更接近传导。
        const upstreamBudget = nodeShare * nodePropagationMiRatio(node);
        if (upstreamBudget < DAG_MIN_ATTRIBUTION_SHARE) continue;

        for (const link of incomingLinksByTarget.get(node.id) ?? []) {
            if (!graph.hasEdge(link.source, link.target)) continue;
            const srcId = endpointNode(link.source, graph).id;
            const edgeKey = dagLinkEndpointKey(srcId, node.id);
            if (options.allowedEdgeKeys && !options.allowedEdgeKeys.has(edgeKey)) continue;
            // min(1) 仅防御：attributionShare L1 归一且 MI ≤ 1 保证乘积不超过 1。
            const edgeShare = Math.min(1, upstreamBudget * edgeAttributionShare(link));
            if (edgeShare < DAG_MIN_ATTRIBUTION_SHARE) continue;

            incomingEdgeShareByKey.set(edgeKey, edgeShare);
            activeNodeIds.add(srcId);
            // min(1) 仅防御：nodeShare 从 1 出发，经 attributionShare 分配与 MI 衰减后各节点累积不超过 1。
            nodeShareById.set(srcId, Math.min(1, (nodeShareById.get(srcId) ?? 0) + edgeShare));
            remainingDepthByNodeId.set(
                srcId,
                Math.max(remainingDepthByNodeId.get(srcId) ?? 0, remainingDepth - 1),
            );
        }
    }

    // 直接模式可附带展示“焦点影响了谁”。
    if (options.includeDownstreamInfluence) {
        graph.forEachOutEdge(focusId, (_edgeId, edgeAttrs, srcId, tgtId) => {
            const link = edgeAttrs as unknown as Pick<DagLink, 'attributionShare' | 'normalizedScore' | 'mutualInformationRatio'>;
            const strength = directAttributionStrength(link);
            if (strength < DAG_MIN_ATTRIBUTION_SHARE) return;
            downstreamEdgeStrengthByKey.set(dagLinkEndpointKey(srcId, tgtId), strength);
            activeNodeIds.add(tgtId);
        });
    }

    return { activeNodeIds, incomingEdgeShareByKey, downstreamEdgeStrengthByKey, nodeShareById };
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
    /** 点击 ▶：传入 `true`；点击 ⏸：传入 `false`（页面内定时重放 DAG；仅无用户焦点时由 view 调用） */
    onDagPlaybackToggle?: (playing: boolean) => void;
    /** 无用户焦点时 DAG 步进是否可播（如无 runner 步则 false） */
    onDagCanPlay?: () => boolean;
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
     * linear-arc 家族：相邻节点矩形外侧边的水平间隙（px），决定水平方向疏密；
     * 默认 {@link LINEAR_ARC_ADJACENT_GAP_DEFAULT}。
     */
    linearArcAdjacentGapPx?: number;
    /** exclude / inactive（0.1）是否完全隐藏（true）还是 0.1 占位（false，默认）。 */
    hideExcludedTokens?: boolean;
    dimInactiveTokens?: boolean;
    dimInactiveTokensThreshold?: number;
    dimInactiveNotDuringAnimation?: boolean;
    /** 是否显示 token tooltip（UI: Show token tooltip；`showTokenInfoOnSelected`）。 */
    showTokenInfoOnSelected?: boolean;
    /** 传播归因（UI: Propagated attribution mode；`recursiveAttributionEnabled`）；默认 `false`。 */
    recursiveAttributionEnabled?: boolean;
    /** 传播链播放方向；默认 `forward`。 */
    recursiveEdgeBatchAnimationDirection?: DagRecursiveEdgeAnimationDirection;
    /** 传播链动画节奏；默认 step / 500ms / 7s。 */
    getReplayPacing?: () => DagRecursiveEdgeReplayPacing;
    /** 直接归因模式下是否展示从焦点出发的下游影响出边；默认 `false`。 */
    showDownstreamInfluence?: boolean;
    /** 边 Top-P 覆盖阈值（候选池内累计份额）；默认 {@link DAG_EDGE_TOP_P_COVERAGE_DEFAULT}。 */
    edgeTopPCoverage?: number;
    /** 进入/退出/切换全屏失败时（常见于移动端不支持元素全屏等）。不传则无提示。 */
    onFullscreenError?: (message: string) => void;
    /**
     * DAG 归因排除：prompt 区正则的**生效**全文（勾选关则 `''`）。须与 Gen Attribute 页控件同源（仅该页使用本视图）。
     */
    getEffectiveExcludePromptPatternsText: () => string;
    /** 已生成后缀区排除正则的生效全文（勾选关则 `''`）。 */
    getEffectiveExcludeGeneratedPatternsText: () => string;
    /**
     * DAG prompt 删除正则的生效全文（勾选关则 `''`）。
     * 命中的 prompt token 从 DAG 中彻底移除，不占布局空间（比 exclude+hide 更严格）。
     * 每次 {@link GenAttributeDagHandle.setPromptTokenSpans} 按当前 input 区间重算。
     */
    getEffectiveDeletePromptPatternsText: () => string;
};

export function initGenAttributeDagView(
    resultsRoot: D3Sel,
    options: InitGenAttributeDagViewOptions
): GenAttributeDagHandle {
    const onDagRefresh = options?.onDagRefresh;
    const onDagPlaybackToggle = options?.onDagPlaybackToggle;
    const onDagCanPlay = options?.onDagCanPlay;
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
    let dimInactiveTokens: boolean = options?.dimInactiveTokens ?? false;
    let dimInactiveTokensThreshold = clampDimInactiveTokensThreshold(
        options?.dimInactiveTokensThreshold ?? DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT,
    );
    let dimInactiveNotDuringAnimation: boolean = options?.dimInactiveNotDuringAnimation ?? false;
    let showTokenInfoOnSelected: boolean = options?.showTokenInfoOnSelected ?? false;
    let recursiveAttributionEnabled: boolean = options?.recursiveAttributionEnabled ?? false;
    let showDownstreamInfluence: boolean = options?.showDownstreamInfluence ?? false;
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
            getSelectedNodeId: () => null,
            getUserFocusId: () => null,
            setSelectedNodeId: noop,
            setUserFocusNodeId: noop,
            clearNodeSelection: noop,
            setDagPlaybackPlaying: noop,
            setMeasureWidthPx: noop,
            setLayoutMode: noop,
            setLinearArcAdjacentGapPx: noop,
            setDagCompactness: noop,
            setEdgeTopPCoverage: noop,
            setHideExcludedTokens: noop,
            setDimInactiveTokens: noop,
            setDimInactiveTokensThreshold: noop,
            setDimInactiveNotDuringAnimation: noop,
            setShowTokenInfoOnSelected: noop,
            setRecursiveAttributionEnabled: noop,
            setRecursiveEdgeBatchAnimationDirection: noop,
            isPropagationPlaybackEngaged: () => false,
            stopPropagationPlayback: noop,
            setShowDownstreamInfluence: noop,
            hasPromptSpans: () => false,
            detach: noop,
        };
    }

    const {
        getEffectiveExcludePromptPatternsText,
        getEffectiveExcludeGeneratedPatternsText,
        getEffectiveDeletePromptPatternsText,
    } = options;

    detachGenAttributeDagPanel.get(rootEl)?.();
    resultsRoot
        .selectAll(
            '.gen-attr-dag-stack, .gen-attr-dag-topk-tooltip, svg.gen-attr-dag-svg, button.gen-attr-dag-refresh, button.gen-attr-dag-play, button.gen-attr-dag-fullscreen'
        )
        .remove();

    const stack = resultsRoot.append('div').attr('class', 'gen-attr-dag-stack');
    const stackEl = stack.node() as HTMLElement;

    const dagTooltipEh = new SimpleEventHandler(stackEl);
    const dagTooltipRoot = resultsRoot.append('div').attr('class', 'tooltip gen-attr-dag-topk-tooltip');
    dagTooltipRoot.append('div').attr('class', 'currentToken');
    dagTooltipRoot.append('div').attr('class', 'myDetail');
    dagTooltipRoot
        .append('div')
        .attr('class', 'gen-attr-dag-topk-tooltip-predictions-scroll')
        .append('div')
        .attr('class', 'predictions predictions-table');
    const dagTopkToolTip = new ToolTip(dagTooltipRoot, dagTooltipEh, {
        surprisalRowLabel: tr('log perplexity:'),
        placement: 'parent-bottom-right',
        pointerInteractive: false,
    });

    /** DAG Top‑K tooltip：挂载初期为 stub；{@link syncGenAttrDagTopkTooltipImpl} 在 {@link refreshNodeLinkHighlight} 定义之后赋值 */
    let syncGenAttrDagTopkTooltipImpl: () => void = () => {
        dagTopkToolTip.hideAndReset();
    };

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

    let textMeasure = createGenAttributeDagTextMeasure(measureRoot);

    /**
     * 与 `--gen-attr-dag-display-scale` 一致；`setDagCompactness` 会更新（并同步 `linkEndInsetPx`）。
     * 热路径不读 `getComputedStyle`，仅在该 setter 与 init 时刷新。
     */
    let displayScale = readDisplayScaleFromCss(stackEl);
    let linkEndInsetPx = linkEndInsetBaseAtUnitScalePx(measureRoot) * displayScale;

    function refreshDagScaleDerivedFromCss(): void {
        displayScale = readDisplayScaleFromCss(stackEl);
        linkEndInsetPx = linkEndInsetBaseAtUnitScalePx(measureRoot) * displayScale;
        syncNodeStrokeRects(nodeSel, displayScale);
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
            syncGenAttrDagTopkTooltipImpl();
        });

    function applyInitialDagZoom(): void {
        svg.call(zoomBehavior.transform, d3.zoomIdentity.scale(defaultDagZoomK()));
    }

    svg.call(zoomBehavior);
    applyInitialDagZoom();

    svg.on('click', () => clearNodeSelection());

    const linkG = rootG.append('g').attr('class', 'gen-attr-dag-links');
    const nodeG = rootG.append('g').attr('class', 'gen-attr-dag-nodes');
    /** 邻接焦点的高亮边：在节点层之后绘制，避免被节点遮挡 */
    const linkGFront = rootG.append('g').attr('class', 'gen-attr-dag-links-front');
    /** 与视觉节点同几何的透明命中层，置于 linkGFront 之上，避免蓝线挡住 hover/click */
    const nodeGHit = rootG.append('g').attr('class', 'gen-attr-dag-nodes-hit');

    const graph = new DirectedGraph<DagNodeAttrs>();
    let nodes: DagNode[] = [];
    /** `nodes` 按 step 降序（新→旧→prompt）排列的副本，供 {@link computeFocusAttributionState} 使用，避免每次 hover 重新排序。 */
    let nodesSortedByStepDesc: DagNode[] = [];
    let links: DagLink[] = [];
    /** 按 targetId 索引的入边列表，供 {@link computeFocusAttributionState} 使用，避免每次 hover O(N×E) 全扫描。 */
    const incomingLinksByTarget = new Map<string, DagLink[]>();
    /** 灰边渲染强度缓存；图结构变化（{@link syncGraphToSvg}）或 {@link reset} 时置 null 失效。 */
    let grayRenderCache: Map<string, number> | null = null;
    let stepProcessed = 0;
    let selectedId: string | null = null;
    /** 用户点击确立的播放焦点；`update` 不修改，用于 ▶ 传播链路由 */
    let userFocusId: string | null = null;
    /** 悬浮节点 id；无选中时参与归因预览焦点，有选中时仅驱动 `--hover` 等样式，不改归因焦点 */
    let hoveredId: string | null = null;
    /** 最近一次 {@link refreshNodeLinkHighlight} 计算出的归因状态（基于 {@link effectiveFocusId}）；tooltip 用于展示归因份额 */
    let currentFocusState: FocusAttributionState | null = null;
    /** 传播链动画进行中 tooltip 锚点；播放结束后为 null，恢复 target / hover。 */
    let propagationPlaybackTooltip: {
        nodeId: string;
        direction: DagRecursiveEdgeAnimationDirection;
    } | null = null;

    const focusAttributionCtx = () => ({
        nodesSortedByStepDesc,
        incomingLinksByTarget,
    });

    let syncDagPlayButtonImpl: () => void = () => {};

    const recursiveEdgeAnimation = createDagRecursiveEdgeAnimationController({
        onTick: () => refreshNodeLinkHighlight(),
        onPlaybackPhaseChange: () => {
            syncDagPlayButtonImpl();
            refreshNodeLinkHighlight();
        },
        computeFocusState: (focusId, options, ctx) =>
            computeFocusAttributionState(
                graph,
                ctx.nodesSortedByStepDesc as DagNode[],
                ctx.incomingLinksByTarget as Map<string, DagLink[]>,
                focusId,
                options,
            ),
        computeSteadyStateStayShareById: (nodeShareById, focusId) =>
            computeSteadyStateStayShareById(nodeShareById, graph, focusId),
        isRecursiveAttributionEnabled: () => recursiveAttributionEnabled,
        hasNode: (id) => graph.hasNode(id),
        offsetOf: (id) => (graph.hasNode(id) ? (graph.getNodeAttributes(id) as DagNode).start : 0),
        tokenLabelOf: (id) => {
            if (!graph.hasNode(id)) return null;
            const n = graph.getNodeAttributes(id) as DagNode;
            return n.displayLabel ?? n.label;
        },
        direction: options?.recursiveEdgeBatchAnimationDirection ?? 'forward',
        getReplayPacing: options?.getReplayPacing,
    });

    /** 归因预览焦点：用户播放焦点优先，否则选中 / 悬浮 */
    function effectiveFocusId(): string | null {
        return userFocusId ?? selectedId ?? hoveredId;
    }

    function dimInactiveTokensEffective(): boolean {
        if (!recursiveAttributionEnabled || !dimInactiveTokens) return false;
        if (dimInactiveNotDuringAnimation) {
            const phase = recursiveEdgeAnimation.getPlaybackPhase();
            if (phase === 'playing' || phase === 'paused') return false;
        }
        return true;
    }

    function nodeLowVisibilityReasonFor(
        node: DagNode,
        focusId: string | null,
        focusState: FocusAttributionState | null,
        dimEffective: boolean = dimInactiveTokensEffective(),
    ) {
        return dagNodeLowVisibilityReason(
            node.id,
            node.start,
            node.end,
            node.step,
            dagExcludeIntervals,
            focusId,
            focusState,
            dimEffective,
            dimInactiveTokensThreshold,
        );
    }

    /** Dim inactive：仅 inactive 节点裁边/动画；exclude 仍按原规则（0.1 占位时可保留灰边）。 */
    function isNodeInactiveForDim(
        nodeId: string,
        focusId: string | null,
        focusState: FocusAttributionState | null,
        dimEffective: boolean = dimInactiveTokensEffective(),
    ): boolean {
        if (!graph.hasNode(nodeId)) return false;
        const step = (graph.getNodeAttributes(nodeId) as DagNode).step;
        return isDagNodeInactiveByTotalShare(
            nodeId,
            step,
            focusId,
            focusState,
            dimEffective,
            dimInactiveTokensThreshold,
        );
    }

    function nodeIncludedInLayoutForFocus(
        n: DagNode,
        focusId: string | null,
        focusState: FocusAttributionState | null,
        dimEffective: boolean = dimInactiveTokensEffective(),
    ): boolean {
        if (!hideExcludedTokens) return true;
        return nodeLowVisibilityReasonFor(n, focusId, focusState, dimEffective) == null;
    }

    function nodeIncludedInLayout(n: DagNode): boolean {
        return nodeIncludedInLayoutForFocus(n, effectiveFocusId(), currentFocusState);
    }

    /** hide 关闭且已全量 paint 后的标记；与 {@link LAYOUT_INCLUDED_STALE_KEY}、过滤集 key 区分。 */
    const LAYOUT_INCLUDED_ALL_KEY = '';
    /** {@link invalidateLayoutIncludedNodeIdsKey}：强制下次 sync 重算几何（含 hide 关闭恢复全量布局）。 */
    const LAYOUT_INCLUDED_STALE_KEY = '\x00';

    /** {@link syncLayoutForLowVisibilityMembership} 上次已反映进 paint 的参与布局节点集。 */
    let layoutIncludedNodeIdsKey = LAYOUT_INCLUDED_ALL_KEY;

    function computeLayoutIncludedNodeIdsKey(
        focusId: string | null,
        focusState: FocusAttributionState | null,
    ): string {
        if (!hideExcludedTokens) return '';
        const dimEffective = dimInactiveTokensEffective();
        const ids: string[] = [];
        for (const n of nodes) {
            if (nodeIncludedInLayoutForFocus(n, focusId, focusState, dimEffective)) ids.push(n.id);
        }
        ids.sort();
        return ids.join('\0');
    }

    function layoutModeExcludesLowVisibilityFromGeometry(): boolean {
        return (
            isLinearArcFamilyLayout(layoutMode) ||
            layoutMode === 'spiral'
        );
    }

    /** 步进重放（▶）期间为 true；fit 由页面 `afterStepShown` + Auto zoom 统一处理，见 {@link syncLayoutForLowVisibilityMembership}。 */
    let dagPlaybackPlaying = false;

    /**
     * Hide exclude/inactive 时，参与布局的节点集随焦点 / dim 阈值变化；须重算 linear-arc / spiral 几何。
     */
    function syncLayoutForLowVisibilityMembership(
        focusId: string | null,
        focusState: FocusAttributionState | null,
    ): void {
        if (!layoutModeExcludesLowVisibilityFromGeometry() || batchDepth > 0 || nodes.length === 0) {
            return;
        }
        if (!hideExcludedTokens) {
            if (layoutIncludedNodeIdsKey === LAYOUT_INCLUDED_ALL_KEY) return;
            layoutIncludedNodeIdsKey = LAYOUT_INCLUDED_ALL_KEY;
            paint();
            if (!layoutDirty && !dagPlaybackPlaying) fitViewportToContent(true);
            return;
        }
        const key = computeLayoutIncludedNodeIdsKey(focusId, focusState);
        if (key === layoutIncludedNodeIdsKey) return;
        layoutIncludedNodeIdsKey = key;
        paint();
        if (!layoutDirty && !dagPlaybackPlaying) fitViewportToContent(true);
    }

    function invalidateLayoutIncludedNodeIdsKey(): void {
        layoutIncludedNodeIdsKey = LAYOUT_INCLUDED_STALE_KEY;
    }

    /** 传播链动画当前帧应对应 tooltip 的节点；非播放中返回 null。 */
    function resolvePropagationPlaybackTooltipNodeId(
        animOverlay: ReturnType<typeof recursiveEdgeAnimation.resolveRenderOverlay>,
        focusId: string | null,
    ): string | null {
        if (focusId == null || !animOverlay.animationFrontierPartial || animOverlay.anim == null) {
            return null;
        }
        const { anim, forwardPromptOnlyFrame, propagationSlideTgtId, nodeStrokeShareById } = animOverlay;
        if (forwardPromptOnlyFrame) {
            if (nodeStrokeShareById != null) {
                for (const id of nodeStrokeShareById.keys()) {
                    if (graph.hasNode(id) && (graph.getNodeAttributes(id) as DagNode).step === -1) {
                        return id;
                    }
                }
            }
            return nodes.find((n) => n.step === -1)?.id ?? null;
        }
        return propagationSlideTgtId ?? anim.plan.batches[anim.batchIndex]?.tgtId ?? null;
    }

    /** tooltip 锚点：传播播放（忽略 hover）> hover > 焦点 */
    function tooltipFocusId(): string | null {
        if (propagationPlaybackTooltip != null && graph.hasNode(propagationPlaybackTooltip.nodeId)) {
            return propagationPlaybackTooltip.nodeId;
        }
        if (hoveredId != null && graph.hasNode(hoveredId)) {
            return hoveredId;
        }
        return effectiveFocusId();
    }
    /**
     * 与 {@link pruneDagLinksTouchingFullyExcludedNodes} / 预处理同源：全串上的 exclude 半开区间，
     * 供节点「隐藏」透明度判定（{@link isOffsetSpanFullyExcluded}）。在 {@link setPromptTokenSpans} 与每步
     * {@link update} 中刷新；{@link reset} 清空。
     */
    let dagExcludeIntervals: [number, number][] = [];
    /**
     * 每次 {@link setPromptTokenSpans} 按 `layoutWire` + `inputRanges` 重算（与 exclude 一致；多轮追加 input 区时扩展）。
     * 命中区间内的 prompt token 不进入图也不进入测量层（textMeasure 物理压缩布局空间）。
     */
    let dagDeleteIntervals: [number, number][] = [];
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
    let nodeHitSel = nodeGHit
        .selectAll<SVGGElement, DagNode>('g.gen-attr-dag-node-hit')
        .data<DagNode>([], (d) => d.id);

    /** 与 {@link nodeSel} 同序同 transform（paint 各布局模式之后调用） */
    function syncNodeHitTransforms(): void {
        const visualNodes = nodeSel.nodes();
        nodeHitSel.attr('transform', (_d, i) => d3.select(visualNodes[i]).attr('transform'));
    }

    function bindNodePointerHandlers(
        sel: d3.Selection<SVGGElement, DagNode, SVGGElement | null, unknown>,
    ): void {
        sel.on('mouseenter', (_event, d) => {
            hoveredId = d.id;
            refreshNodeLinkHighlight();
        })
            .on('mouseleave', () => {
                hoveredId = null;
                refreshNodeLinkHighlight();
            })
            .on('click', (event, d) => {
                event.stopPropagation();
                const next = userFocusId === d.id ? null : d.id;
                userFocusId = next;
                selectedId = next;
                recursiveEdgeAnimation.stopPlayback();
                refreshNodeLinkHighlight();
                syncDagPlayButtonImpl();
            });
    }

    function syncSvgSize(): void {
        const { w, h } = stackLayoutViewportPx(stackEl);
        svg.attr('width', w).attr('height', h);
    }

    /** 传播归因 + backward：仅 UI 路径反向，不改边数据与归因 key。 */
    function linkEndpointsForPaint(d: DagLink): { src: DagNode; tgt: DagNode } {
        const src = endpointNode(d.source, graph);
        const tgt = endpointNode(d.target, graph);
        const flipArrows =
            recursiveAttributionEnabled && recursiveEdgeAnimation.getDirection() === 'backward';
        return flipArrows ? { src: tgt, tgt: src } : { src, tgt };
    }

    function paint(): void {
        syncNodeStrokeRects(nodeSel, displayScale);
        if (layoutMode === 'linear-arc' || layoutMode === 'linear-arc-step-down') {
            const layoutNodes = nodes.filter((n) => nodeIncludedInLayout(n));
            paintLinearArcLayout({
                linkSel,
                nodeSel,
                nodes: layoutNodes,
                adjacentGapPx: linearArcAdjacentGapPx,
                variant: layoutMode === 'linear-arc-step-down' ? 'step-down' : 'flat',
                getLinkNodes: linkEndpointsForPaint,
            });
        } else if (layoutMode === 'spiral') {
            const layoutNodes = nodes.filter((n) => nodeIncludedInLayout(n));
            paintSpiralLayout({
                linkSel,
                nodeSel,
                nodes: layoutNodes,
                linkEndInsetPx,
                getLinkNodes: linkEndpointsForPaint,
            });
        } else {
            paintTextFlowLayout({
                linkSel,
                nodeSel,
                linkEndInsetPx,
                getLinkNodes: linkEndpointsForPaint,
            });
        }
        syncNodeHitTransforms();
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
            syncGenAttrDagTopkTooltipImpl();
        })
        .on('end', () => {
            dragPointerOffset = null;
        });

    /** 焦点高亮：递归强调来源链，直接强调一跳关系。 */
    function refreshNodeLinkHighlight(): void {
        const focusId = effectiveFocusId();
        const focusState = focusId
            ? computeFocusAttributionState(graph, nodesSortedByStepDesc, incomingLinksByTarget, focusId, {
                maxIncomingDepth: recursiveAttributionEnabled ? Number.POSITIVE_INFINITY : 1,
                includeDownstreamInfluence: !recursiveAttributionEnabled && showDownstreamInfluence,
            })
            : null;
        currentFocusState = focusState;
        const dimEffective = dimInactiveTokensEffective();
        const suppressPropagationNode = (nodeId: string): boolean =>
            isNodeInactiveForDim(nodeId, focusId, focusState, dimEffective);
        const animOverlay = recursiveEdgeAnimation.resolveRenderOverlay({
            effectiveFocusId: focusId,
            focusState,
            recursiveAttributionEnabled,
            ctx: focusAttributionCtx(),
            isPropagationNodeSuppressed: suppressPropagationNode,
        });
        let playbackNodeId = resolvePropagationPlaybackTooltipNodeId(animOverlay, focusId);
        if (playbackNodeId != null && suppressPropagationNode(playbackNodeId)) {
            playbackNodeId = null;
        }
        propagationPlaybackTooltip =
            playbackNodeId != null && animOverlay.anim != null
                ? { nodeId: playbackNodeId, direction: animOverlay.anim.direction }
                : null;
        const linkFocusState = animOverlay.linkFocusState ?? focusState;
        const focusNodeIds = focusState?.activeNodeIds ?? null;
        const nodeStrokeShareById = animOverlay.nodeStrokeShareById;
        const nodeStrokeRenderById =
            nodeStrokeShareById == null
                ? null
                : buildNodeStrokeRenderStrengthById(
                      nodeStrokeShareById,
                      animOverlay.nodeStrokeMaxForRender,
                  );
        const focusTargetMiRatio =
            focusId != null && graph.hasNode(focusId)
                ? nodeTargetMiRatio(graph.getNodeAttributes(focusId) as DagNode)
                : 1;
        const useAnimationIncomingHighlight =
            recursiveAttributionEnabled &&
            animOverlay.animationFrontierPartial &&
            !animOverlay.forwardPromptOnlyFrame;
        const incomingHighlightRenderByKey =
            focusState == null
                ? new Map<string, number>()
                : buildMaxNormalizedRenderStrengthByKey(
                      useAnimationIncomingHighlight
                          ? animOverlay.incomingShareForRender
                          : focusState.incomingEdgeShareByKey,
                      focusTargetMiRatio,
                      useAnimationIncomingHighlight ? animOverlay.incomingMaxForRender : undefined,
                  );
        const downstreamHighlightRenderByKey =
            focusState == null
                ? new Map<string, number>()
                : buildMaxNormalizedRenderStrengthByKey(focusState.downstreamEdgeStrengthByKey);
        grayRenderCache ??= buildGrayRenderStrengthByEdgeKey(graph, incomingLinksByTarget);
        const grayRenderByKey = grayRenderCache;
        const {
            propagationSlideTgtId: propagationSlideTgtIdFromAnim,
            forwardPromptOnlyFrame,
            deferFocusHighlightDuringAnim,
            suppressFocusSelectedStroke,
            incomingShareForRender,
            anim,
            animationFrontierPartial,
        } = animOverlay;
        const propagationSlideTgtId =
            propagationSlideTgtIdFromAnim != null &&
            suppressPropagationNode(propagationSlideTgtIdFromAnim)
                ? null
                : propagationSlideTgtIdFromAnim;
        let backwardSlideIncomingRenderByKey: Map<string, number> | null = null;
        if (
            animationFrontierPartial &&
            anim?.direction === 'backward' &&
            !forwardPromptOnlyFrame &&
            focusId != null
        ) {
            const slideKeys = backwardSlideIncomingEdgeKeysForBatch(
                anim.plan,
                anim.batchIndex,
                focusId,
            );
            if (slideKeys.size > 0) {
                backwardSlideIncomingRenderByKey = buildMaxNormalizedRenderStrengthByKey(
                    incomingShareForRender,
                    focusTargetMiRatio,
                    undefined,
                    slideKeys,
                );
            }
        }
        const isPropagationSlide = (d: DagNode): boolean =>
            propagationSlideTgtId != null && d.id === propagationSlideTgtId;
        const isBackwardSlide = (d: DagNode): boolean =>
            animOverlay.anim?.direction === 'backward' && isPropagationSlide(d);
        const showFocusSelectedStroke = (d: DagNode): boolean =>
            selectedId === d.id && !(suppressFocusSelectedStroke && d.id === focusId);
        const nodeOnChainForRender = (d: DagNode): boolean => {
            if (!forwardPromptOnlyFrame) return nodeStrokeShareById?.has(d.id) ?? false;
            return d.step === -1 && (nodeStrokeShareById?.has(d.id) ?? false);
        };
        const nodeLowVisReasonById = new Map(
            nodes.map(
                (n) => [n.id, nodeLowVisibilityReasonFor(n, focusId, focusState, dimEffective)] as const,
            ),
        );
        const nodeDisplay = (d: DagNode): string | null =>
            hideExcludedTokens && nodeLowVisReasonById.get(d.id) != null ? 'none' : null;
        nodeSel
            .classed('gen-attr-dag-node--hover', (d) => hoveredId === d.id)
            .classed('gen-attr-dag-node--selected', showFocusSelectedStroke)
            .style('display', nodeDisplay)
            .attr('opacity', (d) => {
                const lowVis = nodeLowVisReasonById.get(d.id) ?? null;
                if (hideExcludedTokens && lowVis != null) return DagNodeOpacityLevel.hidden;
                if (isOffsetSpanFullyExcluded(d.start, d.end, dagExcludeIntervals)) {
                    return DagNodeOpacityLevel.almostHidden;
                }
                const nodeFullyHighlighted = recursiveAttributionEnabled
                    ? forwardPromptOnlyFrame
                        ? nodeOnChainForRender(d)
                        : (!deferFocusHighlightDuringAnim && d.id === focusId) ||
                          (nodeStrokeShareById?.has(d.id) ?? false) ||
                          isPropagationSlide(d)
                    : (focusNodeIds?.has(d.id) ?? false);
                let opacity: number = DagNodeOpacityLevel.full;
                if (nodeFullyHighlighted) {
                    opacity = DagNodeOpacityLevel.full;
                } else {
                    const hasGenTokens = nodes.some((n) => n.step >= 0);
                    const isPromptLeaf =
                        hasGenTokens && d.step === -1 && graph.outDegree(d.id) === 0;
                    if (focusId || isPromptLeaf) opacity = DagNodeOpacityLevel.weakened;
                }
                if (lowVis === 'inactive') {
                    return DagNodeOpacityLevel.almostHidden;
                }
                return opacity;
            })
            .classed(
                'gen-attr-dag-node--recursive-chain',
                (d) => nodeOnChainForRender(d) || isBackwardSlide(d),
            )
            .classed('gen-attr-dag-node--backward-slide', isBackwardSlide)
            .style(CSS_VAR_DAG_NODE_RECURSIVE_SHARE, (d) => {
                if (!nodeOnChainForRender(d) && !isBackwardSlide(d)) return null;
                const renderStrength = nodeStrokeRenderById?.get(d.id);
                return renderStrength != null ? String(renderStrength) : null;
            });
        nodeHitSel
            .classed('gen-attr-dag-node--hover', (d) => hoveredId === d.id)
            .classed('gen-attr-dag-node--selected', showFocusSelectedStroke)
            .style('display', nodeDisplay);
        // 每条边：颜色/强度（见 resolveDagLinkHighlightDisplay）、`<title>` 一并刷新（含 linkGFront 高亮边）。
        rootG.selectAll<SVGGElement, DagLink>('g.gen-attr-dag-link').each(function(d) {
            const srcId = endpointNode(d.source, graph).id;
            const tgtId = endpointNode(d.target, graph).id;
            const edgeKey = dagLinkEndpointKey(srcId, tgtId);
            const { stroke, renderStrength, linkStrength, recursiveAttributionShare } =
                resolveDagLinkHighlightDisplay(
                    d,
                    edgeKey,
                    linkFocusState,
                    recursiveAttributionEnabled,
                    grayRenderByKey,
                    incomingHighlightRenderByKey,
                    downstreamHighlightRenderByKey,
                    backwardSlideIncomingRenderByKey,
                );
            const finalRenderStrength =
                renderStrength *
                animOverlay.edgeVisibility(
                    edgeKey,
                    focusState?.incomingEdgeShareByKey.has(edgeKey) ?? false,
                );
            const g = d3.select(this);
            const srcAttrs = graph.getNodeAttributes(srcId) as DagNode;
            const tgtAttrs = graph.getNodeAttributes(tgtId) as DagNode;
            g.select('title').text(
                buildLinkTitleText({
                    normalizedScore: d.normalizedScore,
                    mutualInformationRatio: d.mutualInformationRatio,
                    attributionShare: d.attributionShare,
                    alignmentNote: d.alignmentNote,
                    src: srcAttrs,
                    tgt: tgtAttrs,
                    recursiveAttributionShare,
                    linkStrength,
                }),
            );
            g.select('path.gen-attr-dag-link-visible').attr('stroke', stroke).attr('stroke-opacity', finalRenderStrength);
            linkMarkersDefs
                .select<SVGPathElement>(`#${dagLinkMarkerElementId(d.source, d.target)} path`)
                .attr('stroke', stroke)
                .attr('stroke-opacity', finalRenderStrength);

            const incident =
                linkFocusState != null &&
                (linkFocusState.incomingEdgeShareByKey.has(edgeKey) ||
                    (focusState?.downstreamEdgeStrengthByKey.has(edgeKey) ?? false));
            const parent = incident ? linkGFront : linkG;
            const parentNode = parent.node()!;
            if (this.parentNode !== parentNode) {
                parentNode.appendChild(this as SVGGElement);
            }
        });

        syncLayoutForLowVisibilityMembership(focusId, focusState);
        syncGenAttrDagTopkTooltipImpl();
    }

    syncGenAttrDagTopkTooltipImpl = (): void => {
        if (!showTokenInfoOnSelected) {
            dagTopkToolTip.hideAndReset();
            return;
        }
        const focusIdNext = tooltipFocusId();
        if (!focusIdNext || !graph.hasNode(focusIdNext)) {
            dagTopkToolTip.hideAndReset();
            return;
        }
        const attrs = graph.getNodeAttributes(focusIdNext) as DagNode;
        // 生成节点必须有 gltrTooltipToken；prompt 节点用 label 构造最简 token
        const isPromptNode = attrs.step < 0;
        if (!isPromptNode && !attrs.gltrTooltipToken) {
            dagTopkToolTip.hideAndReset();
            return;
        }
        const rect = nodeSel
            .filter((d: DagNode) => d.id === focusIdNext)
            .select<SVGRectElement>('rect.gen-attr-dag-node-fill')
            .node();
        if (!rect) {
            dagTopkToolTip.hideAndReset();
            return;
        }
        const tokenForTooltip: FrontendToken = attrs.gltrTooltipToken ?? {
            raw: attrs.label,
            offset: [attrs.start, attrs.end],
            pred_topk: [],
        };

        // 反向播放：当前 token 展示稳态归因份额（同 hover）；正向播放 / 非播放：仅 hover 时展示
        const rowsBeforeInfo: ToolTipUpdateAugment['rowsBeforeInfo'] = [];
        const shareSourceId =
            propagationPlaybackTooltip?.direction === 'backward' ? focusIdNext : hoveredId;
        if (
            selectedId &&
            shareSourceId &&
            currentFocusState &&
            shareSourceId !== selectedId &&
            graph.hasNode(selectedId)
        ) {
            const selectedStep = (graph.getNodeAttributes(selectedId) as DagNode).step;
            // 归因范围：选中 token 之前的所有 token（prompt 节点 step=-1，生成节点 step < selectedStep）
            const inAttributionRange =
                selectedStep >= 0 &&
                (attrs.step === -1 || (attrs.step >= 0 && attrs.step < selectedStep));
            if (inAttributionRange) {
                const share = currentFocusState.nodeShareById.get(shareSourceId) ?? 0;
                if (recursiveAttributionEnabled) {
                    const stay = share * (1 - nodePropagationMiRatio(attrs));
                    rowsBeforeInfo.push(
                        { label: tr('Attribution share (Total):'), value: formatAttributionSharePercentForTooltip(share) },
                        { label: tr('Attribution share (Self):'), value: formatAttributionSharePercentForTooltip(stay) },
                    );
                } else {
                    rowsBeforeInfo.push({
                        label: tr('Attribution share:'),
                        value: formatAttributionSharePercentForTooltip(share),
                    });
                }
            }
        }
        const rowsAfterSurprisal: ToolTipUpdateAugment['rowsAfterSurprisal'] =
            attrs.dagCiMiTooltipRow != null ? [attrs.dagCiMiTooltipRow] : [];
        const augment: ToolTipUpdateAugment | undefined =
            rowsBeforeInfo.length > 0 || rowsAfterSurprisal.length > 0
                ? { rowsBeforeInfo, rowsAfterSurprisal }
                : undefined;
        dagTopkToolTip.updateData({ tokenData: tokenForTooltip }, rect, augment);
    };

    function setSelectedNodeId(id: string | null): void {
        if (id != null && !graph.hasNode(id)) {
            throw new Error(`genAttributeDagView: unknown node id ${id}`);
        }
        selectedId = id;
        refreshNodeLinkHighlight();
        syncDagPlayButtonImpl();
    }

    function clearNodeSelection(): void {
        selectedId = null;
        userFocusId = null;
        recursiveEdgeAnimation.stopPlayback();
        refreshNodeLinkHighlight();
        syncDagPlayButtonImpl();
    }

    function setUserFocusNodeId(id: string | null): void {
        if (id == null) {
            clearNodeSelection();
            return;
        }
        if (!graph.hasNode(id)) {
            throw new Error(`genAttributeDagView: unknown node id ${id}`);
        }
        userFocusId = id;
        selectedId = id;
        recursiveEdgeAnimation.stopPlayback();
        refreshNodeLinkHighlight();
        syncDagPlayButtonImpl();
    }

    /** 将当前 `nodes` / `links` 同步到 SVG：join 新 DOM、`paint` 几何、`refreshNodeLinkHighlight` 样式。 */
    function syncGraphToSvg(): void {
        grayRenderCache = null;
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
                    el.append('title');
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
        // 逐条写 resolveDagLinkHighlightDisplay（与 `<title>` 中 Link strength 同源），任何前值都会被覆盖，全量重置纯冗余。

        nodeSel = nodeG
            .selectAll<SVGGElement, DagNode>('g.gen-attr-dag-node')
            .data(nodes, (d) => d.id)
            .join((enter) => {
                // 节点身份 append-only、几何（nodeW/nodeH）一旦建立不再变化（drag 仅改 x/y，
                // 由 paint 通过 transform 处理），故与几何相关的属性仅在 enter 写一次即可；
                // 同理 `--prompt` class 依据 step === -1，step 初始化后不变。
                const g = enter
                    .append('g')
                    .attr('class', 'gen-attr-dag-node')
                    .style('--gen-attr-dag-node-ci-visual-scale', (d: DagNode) => String(d.ciVisualScale));
                g.classed('gen-attr-dag-node--prompt', (d: DagNode) => d.step === -1);
                g.append('rect').attr('class', 'gen-attr-dag-node-stroke');
                g.append('rect')
                    .attr('class', 'gen-attr-dag-node-fill')
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
                return g;
            });

        nodeHitSel = nodeGHit
            .selectAll<SVGGElement, DagNode>('g.gen-attr-dag-node-hit')
            .data(nodes, (d) => d.id)
            .join((enter) => {
                const g = enter.append('g').attr('class', 'gen-attr-dag-node-hit');
                g.append('rect')
                    .attr('class', 'gen-attr-dag-node-hit-target')
                    .attr('width', (d: DagNode) => d.nodeW)
                    .attr('height', (d: DagNode) => d.nodeH)
                    .attr('rx', (d: DagNode) => nodeRx(d))
                    .attr('ry', (d: DagNode) => nodeRx(d));
                bindNodePointerHandlers(g);
                return g.call(drag);
            });

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

    function setPromptTokenSpans(
        allInputSpans: PromptTokenSpan[],
        layoutWire: string,
        opts?: SetPromptTokenSpansOpts,
    ): void {
        const inputRanges = opts?.inputRanges ?? [[0, layoutWire.length] as [number, number]];
        dagDeleteIntervals = collectDeletePromptIntervals(
            layoutWire,
            inputRanges,
            getEffectiveDeletePromptPatternsText(),
        );
        if (textMeasure.isEmpty()) {
            textMeasure = createGenAttributeDagTextMeasure(measureRoot, dagDeleteIntervals);
        } else {
            textMeasure.setDeleteIntervals(dagDeleteIntervals);
        }
        // 排除已在图中的节点，以及落入删除区间的节点（不加入图，也不加入测量层）。
        const newSpans = allInputSpans.filter((attr) => {
            const [ns, ne] = attr.offset;
            return !graph.hasNode(`${ns}_${ne}`) && !isOffsetSpanFullyExcluded(ns, ne, dagDeleteIntervals);
        });
        const geomByKey = textMeasure.isEmpty()
            ? textMeasure.setPrompt(layoutWire, allInputSpans)
            : textMeasure.appendInputSpans(layoutWire, newSpans);
        const addedNodes: DagNode[] = [];
        for (const attr of newSpans) {
            const [ns, ne] = attr.offset;
            const srcId = `${ns}_${ne}`;
            const g = geomByKey.get(srcId);
            if (!g) {
                throw new Error(`genAttributeDagView: missing layout for prompt node ${srcId}`);
            }
            const displayLabel = visualizeSpecialChars(attr.raw, {
                spaceDotExceptBeforeAsciiLetterOrNumber: true,
                omitHexInCodePointLabel: true,
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
        dagExcludeIntervals = collectGenAttrDagExcludeIntervals(
            layoutWire,
            inputRanges,
            getEffectiveExcludePromptPatternsText(),
            getEffectiveExcludeGeneratedPatternsText(),
        );
        // prompt 节点 step=-1 始终排在末尾；可多次调用（已有节点跳过）。
        nodesSortedByStepDesc = [...nodes].sort((a, b) => b.step - a.step || b.start - a.start);
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
            omitHexInCodePointLabel: true,
        });
        const ciVisualScale = dagGeneratedNodeCiVisualScale(response.target_prob);
        const gltrTooltipToken = frontendTokenFromGenAttrStep(step);
        const dagCiMiTooltipRow = dagCiMiTooltipRowForProb(response.target_prob);
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
            dagTargetProb: response.target_prob,
            displayLabel,
            ...(gltrTooltipToken != null ? { gltrTooltipToken } : {}),
            ...(dagCiMiTooltipRow != null ? { dagCiMiTooltipRow } : {}),
        };
        graph.addNode(targetId, targetNode);
        nodes.push(targetNode);
        // 新 token 的 step 最大，直接放到排序列表最前面，无需重新全排序。
        nodesSortedByStepDesc.unshift(targetNode);
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
        const afterExclude = excludeNodeAggregatedEntries(
            step,
            aggregated,
            excludeIntervalContext,
            getEffectiveExcludePromptPatternsText(),
            getEffectiveExcludeGeneratedPatternsText(),
        );
        const selected = phase2RankAndSparsify(afterExclude, { cumulativeShare: edgeTopPCoverage });

        const mutualInformationRatio = computeMutualInformationRatio(response.target_prob);
        const selectedForDisplay = selected.filter((item) => {
            const normalizedScore = item.score;
            const edgeVisibility =
                (dagDecayAttributionToHighSurprisalTargetEnabled ? mutualInformationRatio : 1) * normalizedScore;
            return edgeVisibility >= DAG_EDGE_MIN_NORMALIZED_SCORE;
        });
        const massSum = selectedForDisplay.reduce((acc, t) => acc + Math.max(0, t.poolMassFrac), 0);
        const linksForTarget: DagLink[] = [];
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
                attributionShare: share,
                ...(alignmentNote ? { alignmentNote } : {}),
            };
            graph.addEdge(srcId, targetId, edgeAttrs);
            const newLink: DagLink = {
                source: srcId,
                target: targetId,
                ...edgeAttrs,
            };
            links.push(newLink);
            linksForTarget.push(newLink);
        }
        if (linksForTarget.length > 0) incomingLinksByTarget.set(targetId, linksForTarget);

        const excludeIntervals = collectGenAttrDagExcludeIntervals(
            intervalCtx,
            step.inputRanges,
            getEffectiveExcludePromptPatternsText(),
            getEffectiveExcludeGeneratedPatternsText(),
        );
        dagExcludeIntervals = excludeIntervals;
        pruneDagLinksTouchingFullyExcludedNodes(graph, links, incomingLinksByTarget, excludeIntervals);

        stepProcessed++;
        // 每步生成后：默认选中本步新生成的 token；无其它选中时悬浮仍可临时预览
        selectedId = targetId;
        recursiveEdgeAnimation.stopPlayback();
        if (batchDepth === 0) {
            syncGraphToSvg();
            // 生成时每步 fit；步进重放（▶）由页面按 Auto zoom 在 `afterStepShown` 统一处理。
            if (!dagPlaybackPlaying) {
                fitViewportToContent();
            }
        }
    }

    function reset(preserveUserViewport: boolean = false): void {
        const wasLayoutDirty = layoutDirty;
        clearGenAttributeDagAlignmentWarnDedupe();
        recursiveEdgeAnimation.onClear();
        textMeasure.reset();
        textMeasure = createGenAttributeDagTextMeasure(measureRoot);
        graph.clear();
        nodes = [];
        nodesSortedByStepDesc = [];
        links = [];
        incomingLinksByTarget.clear();
        grayRenderCache = null;
        stepProcessed = 0;
        selectedId = null;
        userFocusId = null;
        hoveredId = null;
        dagTopkToolTip.hideAndReset();
        linkMarkersDefs.selectAll('marker').remove();
        linkG.selectAll('*').remove();
        linkGFront.selectAll('*').remove();
        nodeG.selectAll('*').remove();
        nodeGHit.selectAll('*').remove();
        dagExcludeIntervals = [];
        dagDeleteIntervals = [];
        layoutIncludedNodeIdsKey = LAYOUT_INCLUDED_ALL_KEY;
        linkSel = rootG
            .selectAll<SVGGElement, DagLink>('g.gen-attr-dag-link')
            .data<DagLink>([], dagLinkDataKey);
        nodeSel = nodeG.selectAll<SVGGElement, DagNode>('g.gen-attr-dag-node').data<DagNode>([], (d) => d.id);
        nodeHitSel = nodeGHit
            .selectAll<SVGGElement, DagNode>('g.gen-attr-dag-node-hit')
            .data<DagNode>([], (d) => d.id);
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
            if (isLinearArcFamilyLayout(layoutMode)) {
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
                /** `rootG` 整包 bbox + 宽高双约束顶对齐 */
                const padTf = DAG_TEXT_FLOW_FIT_PAD_PX;
                const innerWTextFlow = Math.max(w - 2 * padTf, 1);
                const innerHTextFlow = Math.max(h - 2 * padTf, 1);
                const b = rootG.node()!.getBBox();
                const bw = Math.max(b.width, 1e-6);
                const bh = Math.max(b.height, 1e-6);
                const kRaw = Math.min(innerWTextFlow / bw, innerHTextFlow / bh);
                const k = Math.min(Number.isFinite(kRaw) && kRaw > 0 ? kRaw : k0, k0);
                const tx = padTf - k * b.x;
                const ty = padTf - k * b.y;
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

    const playBtn = resultsRoot
        .append('button')
        .attr('type', 'button')
        .attr('class', 'refresh-btn gen-attr-dag-play')
        .attr('title', 'Play')
        .text('▶')
        .style('display', onDagPlaybackToggle ? null : 'none')
        .on('click', (event) => {
            event.stopPropagation();
            if (playBtn.property('disabled')) return;
            if (userFocusId != null) {
                togglePropagationPlayback();
                return;
            }
            if (!onDagPlaybackToggle) return;
            onDagPlaybackToggle(!dagPlaybackPlaying);
        });

    function syncDagPlayButton(): void {
        const propPhase = recursiveEdgeAnimation.getPlaybackPhase();
        const propActive = recursiveEdgeAnimation.isPlaybackActive();
        const playing = dagPlaybackPlaying || propActive;
        const propagationPlayUi = userFocusId != null && recursiveAttributionEnabled;
        let disabled = false;
        if (userFocusId != null) {
            if (!recursiveAttributionEnabled) {
                disabled = true;
            } else {
                const canProp =
                    propPhase !== 'idle' ||
                    recursiveEdgeAnimation.canStartPlayback(userFocusId, focusAttributionCtx());
                disabled = !canProp;
            }
        } else {
            disabled = onDagCanPlay != null && !onDagCanPlay();
        }
        playBtn.property('disabled', disabled);
        const propagationHint =
            propagationPlayUi && !playing && !disabled;
        playBtn.classed('gen-attr-dag-play--propagation-hint', propagationHint);
        playBtn
            .text(playing ? '⏸' : propagationPlayUi ? DAG_CAUSAL_FLOW_ICON : '▶')
            .attr(
                'title',
                playing
                    ? 'Pause'
                    : propagationPlayUi
                      ? 'Propagation (↯)'
                      : 'Step replay (▶)'
            );
    }
    syncDagPlayButtonImpl = syncDagPlayButton;
    syncDagPlayButton();

    function togglePropagationPlayback(): void {
        const phase = recursiveEdgeAnimation.getPlaybackPhase();
        if (phase === 'playing') {
            recursiveEdgeAnimation.pausePlayback();
            syncDagPlayButton();
            return;
        }
        onDagPlaybackToggle?.(false);
        if (userFocusId == null) return;
        if (phase === 'paused') {
            recursiveEdgeAnimation.resumePlayback();
        } else {
            recursiveEdgeAnimation.startPlayback(userFocusId, focusAttributionCtx());
        }
        syncDagPlayButton();
    }

    function setDagPlaybackPlaying(playing: boolean): void {
        dagPlaybackPlaying = playing;
        syncDagPlayButton();
    }

    /** 仅动画定时器在跑时视为 busy；`paused`/`ended` 不阻塞页面侧重放 DAG。 */
    function isPropagationPlaybackEngaged(): boolean {
        return recursiveEdgeAnimation.isPlaybackActive();
    }

    function stopPropagationPlayback(): void {
        recursiveEdgeAnimation.stopPlayback();
        syncDagPlayButton();
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
        if (!isLinearArcFamilyLayout(layoutMode) || nodes.length === 0) return;
        paint();
        fitViewportToContent(true);
    }

    function setHideExcludedTokens(hide: boolean): void {
        if (hideExcludedTokens === hide) return;
        hideExcludedTokens = hide;
        if (batchDepth > 0 || nodes.length === 0) return;
        invalidateLayoutIncludedNodeIdsKey();
        refreshNodeLinkHighlight();
    }

    function setDimInactiveTokens(enabled: boolean): void {
        if (dimInactiveTokens === enabled) return;
        dimInactiveTokens = enabled;
        invalidateLayoutIncludedNodeIdsKey();
        refreshNodeLinkHighlight();
    }

    function setDimInactiveTokensThreshold(threshold: number): void {
        const next = clampDimInactiveTokensThreshold(threshold);
        if (dimInactiveTokensThreshold === next) return;
        dimInactiveTokensThreshold = next;
        invalidateLayoutIncludedNodeIdsKey();
        refreshNodeLinkHighlight();
    }

    function setDimInactiveNotDuringAnimation(enabled: boolean): void {
        if (dimInactiveNotDuringAnimation === enabled) return;
        dimInactiveNotDuringAnimation = enabled;
        invalidateLayoutIncludedNodeIdsKey();
        refreshNodeLinkHighlight();
    }

    function setShowTokenInfoOnSelected(show: boolean): void {
        if (showTokenInfoOnSelected === show) return;
        showTokenInfoOnSelected = show;
        syncGenAttrDagTopkTooltipImpl();
    }

    /** 传播归因（UI: Propagated attribution mode；`recursiveAttributionEnabled`）：向上追到来源；关闭则为直接归因（一跳）。 */
    function setRecursiveAttributionEnabled(enabled: boolean): void {
        if (recursiveAttributionEnabled === enabled) return;
        recursiveAttributionEnabled = enabled;
        if (!enabled) recursiveEdgeAnimation.stopPlayback();
        paint();
        refreshNodeLinkHighlight();
        syncDagPlayButton();
    }

    function setRecursiveEdgeBatchAnimationDirection(direction: DagRecursiveEdgeAnimationDirection): void {
        recursiveEdgeAnimation.setDirection(direction);
        paint();
        refreshNodeLinkHighlight();
        syncDagPlayButton();
    }

    function setShowDownstreamInfluence(show: boolean): void {
        if (showDownstreamInfluence === show) return;
        showDownstreamInfluence = show;
        refreshNodeLinkHighlight();
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
        recursiveEdgeAnimation.dispose();
        detachDagPseudoFullscreenIfPresent(rootEl);
        ro.disconnect();
        document.removeEventListener('fullscreenchange', refreshFullscreenChrome);
        document.removeEventListener(CSS_PSEUDO_FULLSCREEN_CHANGE_EVENT, refreshFullscreenChrome);
        dagTopkToolTip.dispose();
        resultsRoot
            .selectAll(
                '.gen-attr-dag-stack, .gen-attr-dag-topk-tooltip, button.gen-attr-dag-refresh, button.gen-attr-dag-play, button.gen-attr-dag-fullscreen'
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
        getSelectedNodeId: () => selectedId,
        getUserFocusId: () => userFocusId,
        setSelectedNodeId,
        setUserFocusNodeId,
        clearNodeSelection,
        setDagPlaybackPlaying,
        setMeasureWidthPx,
        setLayoutMode,
        setLinearArcAdjacentGapPx,
        setDagCompactness,
        setEdgeTopPCoverage,
        setHideExcludedTokens,
        setDimInactiveTokens,
        setDimInactiveTokensThreshold,
        setDimInactiveNotDuringAnimation,
        setShowTokenInfoOnSelected,
        setRecursiveAttributionEnabled,
        setRecursiveEdgeBatchAnimationDirection,
        isPropagationPlaybackEngaged,
        stopPropagationPlayback,
        setShowDownstreamInfluence,
        hasPromptSpans: () => nodes.some((n) => n.step === -1),
        detach,
    };
}
