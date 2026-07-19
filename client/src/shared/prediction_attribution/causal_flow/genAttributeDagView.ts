import * as d3 from 'd3';
import { DirectedGraph } from 'graphology';
import type { D3Sel } from '../../core/Util';
import { visualizeSpecialChars } from '../../cross/tokenDisplayUtils';
import {
    clampDagEdgeTopPCoverage,
    collectDeletePromptIntervals,
    collectGenAttrDagExcludeIntervals,
    DAG_EDGE_TOP_P_COVERAGE_DEFAULT,
    normalizePromptTokenSpans,
    excludeNodeAggregatedEntries,
    phase2RankAndSparsify,
    type PromptTokenSpan,
} from './genAttributeDagPreprocess';
import type { CharRange, TokenGenStep } from './tokenGenAttributionRunner';
import type { AttentionPlaybackHighlight } from './runAttentionPlayback';
import {
    DAG_EDGE_MIN_NORMALIZED_SCORE,
    DAG_MIN_ATTRIBUTION_SHARE,
    DAG_NODE_STROKE_OPACITY_BASE,
} from './genAttributeDagEdgeDisplay';
import {
    buildDownstreamArriveScaledRenderStrengthByKey,
    buildMaxNormalizedRenderStrengthByKey,
    DAG_LIGHTNING_SLOW_MO_DEFAULT,
    DAG_LIGHTNING_THRESHOLD_TAU_DEFAULT,
    lightningBoundaryAnimationDwellMs,
    lightningBoundaryFadeProgress,
    lightningContentRevealProgress,
    lightningDagFlashOverlayOpacity,
    lightningDecayOpacity,
    lightningDecayStrokeCss,
    lightningEdgeRenderOpacity,
    normalizeEdgeRenderOpacity,
} from './genAttributeDagEdgeRenderStrength';
import { createDagLightningSoundController } from './genAttributeDagLightningSound';
import { DAG_CAUSAL_FLOW_ICON } from './genAttributeDagIcons';
import { lsReadBool, lsWriteBool } from '../../storage/localStorageHelpers';
import {
    backwardSlideIncomingEdgeKeysForBatch,
    createDagRecursiveEdgeAnimationController,
    DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS,
    type DagRecursiveEdgeReplayPacing,
    maxHighlightEdgeShare,
    type DagFocusAttributionState,
    type DagPropagationPlaybackOptions,
    type DagPropagationPlaybackPhase,
    type DagRecursiveEdgeAnimationDirection,
    type RecursiveEdgeAnimationRenderOverlay,
} from './genAttributeDagRecursiveEdgeAnimation';
import {
    clampDimInactiveTokensThreshold,
    dagNodeLowVisibilityReason,
    DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT,
    isDagNodeInactiveByTotalShare,
} from './genAttributeDagNodeDim';
import {
    computeFocusAttributionState,
    nodeUpstreamPropagationRatio,
} from './genAttributeDagFocusAttribution';
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
import {
    dagNodeBaseWidth,
    dagTextFlowPaintOrigin,
    paintTextFlowLayout,
} from './genAttributeDagViewTextFlowMode';
import { paintSpiralLayout } from './genAttributeDagViewSpiralMode';
import {
    attributionMatrixCellKey,
    attributionMatrixEdgeEndpoints,
    MATRIX_TOKEN_OPACITY_FULL,
    MATRIX_TOKEN_OPACITY_WEAKENED,
    disposeMatrixPointerHit,
    paintAttributionMatrixLayout,
    restyleAttributionMatrixLayout,
    type MatrixCellVisual,
    type MatrixInteractionHandlers,
    type MatrixTokenVisual,
} from './genAttributeDagViewMatrixMode';
import { tr } from '../../../shared/lang/i18n-lite';

/** ▶ / ↯ 首次可点教练提示：各记一次（Got it 或实际点击播放）。 */
type DagPlayCoachmarkKind = 'step' | 'propagation';
const DAG_PLAY_COACHMARK_SEEN_KEYS: Record<DagPlayCoachmarkKind, string> = {
    step: 'info_radar_gen_attr_dag_play_coachmark_step',
    propagation: 'info_radar_gen_attr_dag_play_coachmark_propagation',
};

function isDagPlayCoachmarkSeen(kind: DagPlayCoachmarkKind): boolean {
    return lsReadBool(DAG_PLAY_COACHMARK_SEEN_KEYS[kind], false, { encoding: '1' });
}

function markDagPlayCoachmarkSeen(kind: DagPlayCoachmarkKind): void {
    lsWriteBool(DAG_PLAY_COACHMARK_SEEN_KEYS[kind], true, '1');
}

/** 再次挂载前执行上一轮 detach（当前为空操作，保留扩展点） */
const detachGenAttributeDagPanel = new WeakMap<HTMLElement, () => void>();

/** 节点布局模式：`text-flow` 按文字排版层几何；`linear-arc` / `linear-arc-step-down` 为线性序 + 弧线连边（后者按 CI 逐级下移）；`spiral` 螺旋排布；`attribution-matrix` 归因强度热力图（attention-matrix 式）。 */
export type DagLayoutMode =
    | 'text-flow'
    | 'linear-arc'
    | 'linear-arc-step-down'
    | 'spiral'
    | 'attribution-matrix';
function isLinearArcFamilyLayout(mode: DagLayoutMode): mode is 'linear-arc' | 'linear-arc-step-down' {
    return mode === 'linear-arc' || mode === 'linear-arc-step-down';
}

/** attribution-matrix 交互目标：见 {@link matrixHoverTarget}。 */
type MatrixInteractionTarget =
    | { type: 'row'; id: string }
    | { type: 'col'; id: string }
    | { type: 'cell'; srcId: string; tgtId: string };

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
     * 测量层矩形左上角（1×）。compactness / CI 不改此值；text-flow 绘制偏移见 {@link dagTextFlowPaintOrigin}。
     * 同行 `y` 相等供 {@link snapSubwordNode}；compactness 水平贴左，避免长 token 相对短 token 右偏。
     */
    x: number;
    y: number;
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
    /**
     * tool_call → tool_response 合成入边（N×M，非 API 归因建边）。
     * 稳态灰边刻意不画：灰边经 {@link perTargetIncomingEdgeShare}，tool_response（step&lt;0）传导系数为 0 → opacity 0；
     * 有焦点时仅在传播链上高亮（虚线见 scss）。
     */
    synthetic?: boolean;
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

/** 焦点在 target 时单条入边份额（直接模式一跳；灰边与此时蓝边共用）。合成边 target 为 tool_response 时传导系数 0，稳态灰边不画。 */
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
        // 纯 prompt 节点（step < 0 且无入边）不参与灰边池。
        if (targetNode.step < 0 && (incomingLinksByTarget.get(targetId)?.length ?? 0) === 0) continue;
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
    incomingLinksByTarget: Map<string, DagLink[]>,
    focusId: string,
): Map<string, number> {
    const byNodeId = new Map<string, number>();
    for (const [nodeId, nodeShare] of nodeShareById) {
        if (nodeId === focusId) continue;
        const node = graph.getNodeAttributes(nodeId) as DagNode;
        const stay = nodeShare * (1 - nodeUpstreamPropagationRatio(node, incomingLinksByTarget, dagDecayAttributionToHighSurprisalTargetEnabled));
        if (stay >= DAG_MIN_ATTRIBUTION_SHARE) byNodeId.set(nodeId, stay);
    }
    return byNodeId;
}

/** Self 行蓝格 opacity：stay 池内 max 归一 + 焦点 MI 刻度，与蓝入边 {@link buildMaxNormalizedRenderStrengthByKey} 同尺度。 */
function buildMatrixSelfCellOpacityByCol(
    stayById: Map<string, number>,
    colNodes: DagNode[],
    focusTargetMiRatio: number,
    maxShareOverride?: number,
): Map<number, number> {
    const renderByNodeId = buildMaxNormalizedRenderStrengthByKey(
        stayById,
        focusTargetMiRatio,
        maxShareOverride,
    );
    const byCol = new Map<number, number>();
    for (let col = 0; col < colNodes.length; col++) {
        const opacity = renderByNodeId.get(colNodes[col]!.id);
        if (opacity != null) byCol.set(col, opacity);
    }
    return byCol;
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
/** attribution-matrix：同上 */
const DAG_INITIAL_ZOOM_BOOST_ATTRIBUTION_MATRIX = 2;

function dagInitialZoomBoost(mode: DagLayoutMode): number {
    switch (mode) {
        case 'text-flow':
            return DAG_INITIAL_ZOOM_BOOST_TEXT_FLOW;
        case 'linear-arc':
        case 'linear-arc-step-down':
            return DAG_INITIAL_ZOOM_BOOST_LINEAR_ARC;
        case 'spiral':
            return DAG_INITIAL_ZOOM_BOOST_SPIRAL;
        case 'attribution-matrix':
            return DAG_INITIAL_ZOOM_BOOST_ATTRIBUTION_MATRIX;
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
/** 与 {@link _theme-vars.scss} `--dag-lightning-line-color` 一致（传播末帧闪电：accent 混白，亮到发白） */
const CSS_VAR_DAG_LIGHTNING_LINE_COLOR = '--dag-lightning-line-color';
/** 与 causal_flow.scss 中 `--recursive-chain` 的 `stroke-opacity` 一致（由 JS 写入 g 元素） */
const CSS_VAR_DAG_NODE_RECURSIVE_SHARE = '--gen-attr-dag-node-recursive-share';
/** attention 目标 token 汇聚热度 [0,1]；驱动 fill 的 color-mix（见 causal_flow.scss） */
const CSS_VAR_DAG_NODE_QUERY_HEAT = '--gen-attr-dag-node-query-heat';

/** DAG 节点 fill/text `opacity` 档位（exclude 完全隐藏时另用 `display:none`）；描边在 g 上不设 opacity。 */
const DagNodeOpacityLevel = {
    /** 全亮：Causal Flow 焦点；传播动画中的 slide；无焦点或非递归模式链上节点的默认 */
    full: 1,
    /** 置灰：Causal Flow 有焦点时的非焦点节点（含传播动画中的 prompt / 链上 gen）；或无焦点时的链外 / 无出边 prompt 叶子 */
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

/** 布局多选外框：比焦点描边再外扩一档，避免与 `--selected` 描边重合。 */
function syncNodeLayoutSelRects(
    sel: d3.Selection<SVGGElement, DagNode, SVGGElement | null, unknown>,
    displayScale: number,
): void {
    const p = displayScale * 2;
    sel.select('rect.gen-attr-dag-node-layout-sel')
        .attr('x', -p)
        .attr('y', -p)
        .attr('width', (d) => d.nodeW + 2 * p)
        .attr('height', (d) => d.nodeH + 2 * p)
        .attr('rx', (d) => nodeRx(d) + p)
        .attr('ry', (d) => nodeRx(d) + p);
}

function isMultiSelectModifierKey(event: { metaKey?: boolean; ctrlKey?: boolean }): boolean {
    return !!(event.metaKey || event.ctrlKey);
}

/** 轴对齐矩形相交（含边触碰）。 */
function rectsIntersect(
    a: { x0: number; y0: number; x1: number; y1: number },
    b: { x0: number; y0: number; x1: number; y1: number },
): boolean {
    return a.x0 <= b.x1 && a.x1 >= b.x0 && a.y0 <= b.y1 && a.y1 >= b.y0;
}

function nodeAabb(
    d: Pick<DagNode, 'x' | 'y' | 'nodeW' | 'nodeH' | 'ciVisualScale'>,
    displayScale: number,
): {
    x0: number;
    y0: number;
    x1: number;
    y1: number;
} {
    const p = dagTextFlowPaintOrigin(d, displayScale);
    return {
        x0: p.x,
        y0: p.y,
        x1: p.x + d.nodeW,
        y1: p.y + d.nodeH,
    };
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
     * Exclude 在建边时一次定稿；动态过程中改 exclude 正则不溯及已建边（见模块顶注释「Exclude 原则」）。
     * @param excludeIntervalContext 本步建边时用于 exclude 匹配的全文（与 {@link excludeNodeAggregatedEntries} 一致）。
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
     * @param preserveUserViewport 为 `true` 时保留调用前的 `layoutDirty` 与 `userDraggedNodes`
     *（二者同进同退）：设置项切换后重放等保留用户 pan/zoom 及「拖过节点」语义。默认 `false`
     *（新一次 run 等场景仍从干净视口起算）。
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
    /** 更新边 Top-P 覆盖阈值；要重算当前 DAG 须 {@link rebuildEdges}（或 reset 后重放）。 */
    setEdgeTopPCoverage(coverage: number): void;
    /**
     * 按当前 Top-P / exclude / decay 等设置，仅重建边集；保留节点几何（含拖拽后的 x/y）与视口。
     * 稳态改边相关选项时用此路径，勿整图 {@link reset}。
     */
    rebuildEdges(steps: readonly TokenGenStep[], excludeIntervalContext: string): void;
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
    /** attribution-matrix：行列屏幕轴对调（对称布局）。 */
    setMatrixTranspose(transpose: boolean): void;
    /** attribution-matrix：横轴标签翻到远侧（默认近侧：上）。 */
    setMatrixSwitchHorizontalLabel(on: boolean): void;
    /** attribution-matrix：纵轴标签翻到远侧（默认近侧：左）。 */
    setMatrixSwitchVerticalLabel(on: boolean): void;
    /**
     * attribution-matrix：播放跟随时钉住第一个语义 source token 的屏幕位置
     *（稳态取自点击 ▶ 时的视口，多为播完画面；可与 Auto zoom 同用）。
     */
    setMatrixPinSourceTokens(pin: boolean): void;
    /**
     * 从当前已绘矩阵视口捕获 pin 稳态（须在点击 ▶、裁前缀 / `reset` 之前调用）。
     */
    captureMatrixPinSteady(): void;
    /** 清除 {@link captureMatrixPinSteady} 的结果。 */
    clearMatrixPinSteady(): void;
    /**
     * 步进回放中：按当前缩放平移视口，使第一个 source 锚点落在 {@link captureMatrixPinSteady} 的屏幕位置。
     * 与 Auto zoom 正交——先 fit 再调本方法。
     * 播放前的 pan/zoom 不妨碍钉住（稳态即捕获自当时视口）；播放中用户再 pan/zoom 则停止跟随。
     */
    syncMatrixPinViewport(): void;
    /** 传播链播放方向（forward / backward）。 */
    setRecursiveEdgeBatchAnimationDirection(direction: DagRecursiveEdgeAnimationDirection): void;
    /** 重算节点/边高亮（如 slide prompt 等仅影响渲染、不改图数据的选项切换后）。 */
    refreshNodeLinkHighlight(): void;
    /** ▶ attention 模拟播放中的 token 高亮；`null` 清除。 */
    setAttentionPlaybackHighlight(state: AttentionPlaybackHighlight): void;
    /** 末 token 展示后 500ms 收尾 dwell；与 attention 同属「动画期」exclude 亮度例外。 */
    setLastTokenAppearanceDwellActive(active: boolean): void;
    /** Simulate attention ∧ Hide arrows 时，步进回放（▶）整场隐藏 DAG 边。 */
    setHideArrowsDuringAttention(hide: boolean): void;
    /** 在 DAG 上播放一次闪电动画预览（需因果流模式、传播焦点、已勾选闪电）。 */
    playLightningEffectPreview(): void;
    /** 中止闪电动画预览并恢复稳态渲染。 */
    cancelLightningEffectPreview(): void;
    /** 调节 τ 时：固定在第一回击峰值帧预览传播蓝边亮度（不播雷声、不跑时间轴）。 */
    enterLightningTauPreview(): void;
    /** 结束 {@link enterLightningTauPreview}。 */
    exitLightningTauPreview(): void;
    /** 是否在焦点上额外展示下游影响出边（直接一跳 / 因果流递归）。 */
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

const DAG_LINK_TOOLTIP_LABEL_OPTS = { spaceDotExceptBeforeAsciiLetterOrNumber: true as const };

/** 边 tooltip 指标（SVG `<title>` 与 matrix 格 HUD 同源）。 */
function buildLinkTitleMetricRows(snapshot: DagLinkTitleSnapshot): {
    staticRows: Array<{ label: string; value: string }>;
    dynamicRows: Array<{ label: string; value: string }>;
    alignmentNote?: string;
} {
    return {
        staticRows: [
            {
                label: 'Attribution score:',
                value: formatTooltipAttributionScore(snapshot.normalizedScore),
            },
            {
                label: 'Target MI ratio:',
                value: formatMutualInformationRatioForTooltip(snapshot.mutualInformationRatio),
            },
            {
                label: 'Attribution share (Adjacent):',
                value: formatTooltipDirectAttributionShare(
                    snapshot.attributionShare,
                    snapshot.mutualInformationRatio,
                ),
            },
        ],
        alignmentNote: snapshot.alignmentNote,
        dynamicRows: [
            {
                label: 'Attribution share (Propagated):',
                value: formatTooltipRecursiveAttributionShare(snapshot.recursiveAttributionShare),
            },
            {
                label: 'Link strength:',
                value: formatTooltipLinkStrength(snapshot.linkStrength),
            },
        ],
    };
}

function buildLinkTitleText(snapshot: DagLinkTitleSnapshot): string {
    // 建边后不变；空行以下随焦点/传播归因变化（Attribution share (Propagated)、Link strength）。
    const { staticRows, dynamicRows, alignmentNote } = buildLinkTitleMetricRows(snapshot);
    const staticMetrics = staticRows.map((r) => `${r.label} ${r.value}`);
    if (alignmentNote) staticMetrics.push(alignmentNote);

    const metrics = [
        staticMetrics.join('\n'),
        '',
        ...dynamicRows.map((r) => `${r.label} ${r.value}`),
    ];

    return [
        `From:\n${visualizeSpecialChars(snapshot.src.label, DAG_LINK_TOOLTIP_LABEL_OPTS)}\nOffset: ${formatNodeOffsetRange(snapshot.src.id)}`,
        `To:\n${visualizeSpecialChars(snapshot.tgt.label, DAG_LINK_TOOLTIP_LABEL_OPTS)}\nOffset: ${formatNodeOffsetRange(snapshot.tgt.id)}`,
        metrics.join('\n'),
    ].join('\n\n');
}

/** tooltip「Link strength」/ Propagated 份额：与 {@link resolveDagLinkHighlightDisplay} 同源。 */
function resolveDagLinkTooltipStrengths(
    d: Pick<DagLink, 'attributionShare' | 'normalizedScore' | 'mutualInformationRatio'>,
    edgeKey: string,
    focusState: DagFocusAttributionState | null,
    recursiveAttributionEnabled: boolean,
): { linkStrength: number; recursiveAttributionShare?: number } {
    const directStrength = directAttributionStrength(d);
    if (focusState) {
        const downstreamStrength = focusState.downstreamEdgeStrengthByKey.get(edgeKey);
        if (downstreamStrength != null) {
            return { linkStrength: downstreamStrength };
        }
        const incomingShare = focusState.incomingEdgeShareByKey.get(edgeKey);
        if (incomingShare != null) {
            return {
                linkStrength: incomingShare,
                recursiveAttributionShare: recursiveAttributionEnabled ? incomingShare : undefined,
            };
        }
    }
    return { linkStrength: directStrength };
}

/**
 * 单码点：可作拼接一侧（前一片末尾或当前片开头）——非 Han 字母或 ' - _
 * 对称处理 `__`→`init`、`love`→`'s` 等。
 */
const GLUE_EDGE_CHAR = /^(?:(?!\p{Script=Han})\p{L}|['\-_])$/u;

/**
 * 子词拼接：offset 紧贴、同行（y 相等）、prev 末码点与当前首码点均满足 {@link GLUE_EDGE_CHAR}
 * → 将当前测量左缘按 compactness 底宽紧贴 prev（不含 CI 外扩）。
 */
function snapSubwordNode(node: DagNode, prev: DagNode | null): void {
    if (!prev || prev.end !== node.start || node.y !== prev.y) return;
    const last = [...prev.label].at(-1) ?? '';
    const first = [...node.label][0] ?? '';
    if (!GLUE_EDGE_CHAR.test(last) || !GLUE_EDGE_CHAR.test(first)) return;
    node.x = prev.x + dagNodeBaseWidth(prev);
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
 * - 合成边（tool_call→tool_response，N×M）：稳态灰边 opacity 为 0（tool_response 传导系数 0），全画会臃肿，刻意不单独处理；有焦点时仅在传播链高亮；
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

/** 焦点下边的视觉规则：传播蓝边看向上原因链；可选红边看下游影响（一跳或递归）。 */
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
    const { linkStrength, recursiveAttributionShare } = resolveDagLinkTooltipStrengths(
        d,
        edgeKey,
        focusState,
        recursiveAttributionEnabled,
    );

    if (focusState) {
        const downstreamStrength = focusState.downstreamEdgeStrengthByKey.get(edgeKey);
        if (downstreamStrength != null) {
            return {
                stroke: `var(${CSS_VAR_DAG_HIGHLIGHT_LINE_OUT})`,
                renderStrength: downstreamHighlightRenderByKey.get(edgeKey)!,
                linkStrength,
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
                linkStrength,
                recursiveAttributionShare,
            };
        }
    }

    return {
        stroke: `var(${CSS_VAR_DAG_NORMAL_LINE_COLOR})`,
        renderStrength: grayRender,
        linkStrength,
    };
}

/**
 * Generate & Attribute 右栏 DAG 视图。
 *
 * 节点 ID 基于归因 offset：`"${start}_${end}"`，全局唯一。
 * - prompt 层：由调用方在首帧 `update` 前 {@link GenAttributeDagHandle.setPromptTokenSpans} 注入（`step === -1`）
 * - 第 k 个生成 token：target 节点（`step === k`，从 0 起）
 *
 * **不做 BPE/digit 合并**（不经 `mergeTokenSpansFullyForRendering`，与 Attribution 主视图的
 * `buildAttributionDisplayResult` 管线不同）：DAG 必须按 API 原始 span 建点，节点身份才与增量 `update`
 * 一致；合并会改变粒度，且各步归因集合不同，跨步合并结果不稳定。
 *
 * 调用方传入**原始** {@link TokenGenStep}：view 内部按 `alignAndAggregateByNode`（piece → 节点聚合）
 * → `excludeNodeAggregatedEntries`（prompt / 已生成区 exclude，节点区间语义）
 * → `phase2RankAndSparsify`（Top-N / 池内归一 / β 截断 / cumulative Top-P）后连边。
 *
 * **Exclude 原则（建边时一次定稿）**：每步 `update()` / 合成边建链时读取**当时**的 exclude 正则；该步一旦建边即定稿，
 * 已建边不做事后删改或份额重算。**动态过程**（实时生成逐步入图、▶ 步进回放同一前缀未 reset）中修改 exclude 正则：
 * **对已建边不生效**。稳态下改 exclude / Top-P / decay：走 {@link GenAttributeDagHandle.rebuildEdges}
 *（只重建边、保留节点几何与视口；页面 DAG 忙时为 no-op）。几何类选项仍须 {@link GenAttributeDagHandle.reset} 后重放。
 * API 归因入边：src 在 exclude 后置零并在可见池内重归一，target 整段命中则不建入边；
 * 合成边（tool_call → tool_response，N×M）仅连未 exclude 的 src 并均分，供传播归因拓扑；稳态不画灰边。
 * `dagExcludeIntervals` 每步仍按当前正则刷新，**仅**供节点透明度 / hide，不参与边集修正。
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
    /** Simulate attention ∧ Hide arrows 时，步进回放（▶）整场隐藏 DAG 边；默认 `false`。 */
    hideArrowsDuringAttention?: boolean;
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
    /** forward 是否 slide 有 share 的 prompt 等节点；默认 `{ forwardSlideSharedNodes: false }`。 */
    getPropagationPlaybackOptions?: () => DagPropagationPlaybackOptions;
    /** 是否展示从焦点出发的下游影响出边（直接一跳 / 因果流递归）；默认 `false`。 */
    showDownstreamInfluence?: boolean;
    /** 边 Top-P 覆盖阈值（候选池内累计份额）；默认 {@link DAG_EDGE_TOP_P_COVERAGE_DEFAULT}。 */
    edgeTopPCoverage?: number;
    /** 进入/退出/切换全屏失败时（常见于移动端不支持元素全屏等）。不传则无提示。 */
    onFullscreenError?: (message: string) => void;
    /** 用户传播焦点（↯ 模式）确立或清除时；与 {@link getUserFocusId} 同步。 */
    onUserFocusChange?: (focusId: string | null) => void;
    /**
     * DAG 归因排除：prompt 区正则的**生效**全文（勾选关则 `''`）。须与 Gen Attribute 页控件同源（仅该页使用本视图）。
     * 每步建边时读取；动态过程中改正则不溯及已建边（见模块顶注释「Exclude 原则」）。
     */
    getEffectiveExcludePromptPatternsText: () => string;
    /** 已生成后缀区排除正则的生效全文（勾选关则 `''`）。建边语义同 {@link getEffectiveExcludePromptPatternsText}。 */
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
    let hideArrowsDuringAttention: boolean = options?.hideArrowsDuringAttention ?? false;
    let dimInactiveTokens: boolean = options?.dimInactiveTokens ?? false;
    let dimInactiveTokensThreshold = clampDimInactiveTokensThreshold(
        options?.dimInactiveTokensThreshold ?? DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT,
    );
    let dimInactiveNotDuringAnimation: boolean = options?.dimInactiveNotDuringAnimation ?? false;
    let showTokenInfoOnSelected: boolean = options?.showTokenInfoOnSelected ?? false;
    let recursiveAttributionEnabled: boolean = options?.recursiveAttributionEnabled ?? false;
    /** attribution-matrix：true 时横=目标、纵=源；Self 为右列。 */
    let matrixTranspose = false;
    /** attribution-matrix：横轴标签在远侧（下）。 */
    let matrixSwitchHorizontalLabel = false;
    /** attribution-matrix：纵轴标签在远侧（右）。 */
    let matrixSwitchVerticalLabel = false;
    /** attribution-matrix：播放跟随时钉住第一个语义 source token。 */
    let matrixPinSourceTokens = false;
    /** 最近一次 matrix paint 的第一个 source 锚点（matrixG 坐标）；无源轴时为 null。 */
    let matrixFirstSourceAnchor: { x: number; y: number } | null = null;
    /**
     * pin 稳态：点击 ▶ 时第一个 source 的屏幕位置（多为播完画面；含用户已 pan/zoom 的位置）。
     * 播放中 fit 之后 {@link syncMatrixPinViewport} 对齐到此，使 source 轴停在该位置。
     */
    let matrixPinSteady: { x: number; y: number } | null = null;
    /**
     * 捕获稳态后允许跟随；播放中用户 pan/zoom 置 false（与 Auto zoom 的 mid-play 打断同理）。
     * 不用 `layoutDirty`：播放前拖拽也会 dirty，但 pin 正要钉在那时的位置。
     */
    let matrixPinFollowActive = false;
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
            rebuildEdges: noop,
            setHideExcludedTokens: noop,
            setHideArrowsDuringAttention: noop,
            setDimInactiveTokens: noop,
            setDimInactiveTokensThreshold: noop,
            setDimInactiveNotDuringAnimation: noop,
            setShowTokenInfoOnSelected: noop,
            setRecursiveAttributionEnabled: noop,
            setMatrixTranspose: noop,
            setMatrixSwitchHorizontalLabel: noop,
            setMatrixSwitchVerticalLabel: noop,
            setMatrixPinSourceTokens: noop,
            captureMatrixPinSteady: noop,
            clearMatrixPinSteady: noop,
            syncMatrixPinViewport: noop,
            setRecursiveEdgeBatchAnimationDirection: noop,
            refreshNodeLinkHighlight: noop,
            setAttentionPlaybackHighlight: noop,
            setLastTokenAppearanceDwellActive: noop,
            playLightningEffectPreview: noop,
            cancelLightningEffectPreview: noop,
            enterLightningTauPreview: noop,
            exitLightningTauPreview: noop,
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
            '.gen-attr-dag-stack, .gen-attr-dag-topk-tooltip, svg.gen-attr-dag-svg, button.gen-attr-dag-refresh, button.gen-attr-dag-play, button.gen-attr-dag-fullscreen, .gen-attr-dag-play-coachmark'
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
        stackEl.classList.toggle('gen-attr-dag-matrix-layout', layoutMode === 'attribution-matrix');
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

    const lightningFlashOverlay = stack
        .append('div')
        .attr('class', 'gen-attr-dag-lightning-flash')
        .style('display', 'none')
        .style('opacity', '0');

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
            // 仅用户交互（滚轮/拖平移）计入「改动布局」；程序触发的 transform
            // （init 初始缩放、`fitViewportToContent`、pin 跟随）`sourceEvent === null`，不置 dirty。
            if (event.sourceEvent) {
                layoutDirty = true;
                // 播放中用户改视口：停止 pin 跟随（播放前的 dirty 不经过这里打断）。
                if (matrixPinSteady != null) matrixPinFollowActive = false;
            }
            syncGenAttrDagTopkTooltipImpl();
        });

    function applyInitialDagZoom(): void {
        svg.call(zoomBehavior.transform, d3.zoomIdentity.scale(defaultDagZoomK()));
    }

    svg.call(zoomBehavior);
    // 不要 d3.zoom 默认的双击放大。
    svg.on('dblclick.zoom', null);
    applyInitialDagZoom();

    // matrix 命中也挂在 svg 上；同元素上 stopPropagation 挡不住本监听器，
    // 若此处仍 clear，会先清空再被 matrixHit 重新选中，导致无法 toggle 取消。
    // matrix 空白点击由 onBackgroundClick → clearNodeSelection。
    svg.on('click', () => {
        if (layoutMode === 'attribution-matrix') return;
        clearNodeSelection();
    });
    // DAG 无上下文菜单；右键留给框选，并避免 Ctrl+单击（macOS）弹出菜单打断多选。
    svg.on('contextmenu', (event) => {
        event.preventDefault();
    });

    const linkG = rootG.append('g').attr('class', 'gen-attr-dag-links');
    const nodeG = rootG.append('g').attr('class', 'gen-attr-dag-nodes');
    /** 邻接焦点的高亮边：在节点层之后绘制，避免被节点遮挡 */
    const linkGFront = rootG.append('g').attr('class', 'gen-attr-dag-links-front');
    /** 与视觉节点同几何的透明命中层，置于 linkGFront 之上，避免蓝线挡住 hover/click */
    const nodeGHit = rootG.append('g').attr('class', 'gen-attr-dag-nodes-hit');
    /** attribution-matrix 热力图层（与节点/边互斥显示；`pointer-events` 由 {@link syncLayoutLayerVisibility} 随模式开关） */
    const matrixG = rootG
        .append('g')
        .attr('class', 'gen-attr-dag-matrix')
        .style('display', 'none')
        .style('pointer-events', 'none');
    /** 右键框选橡胶筋（图坐标系，随 zoom） */
    const marqueeG = rootG.append('g').attr('class', 'gen-attr-dag-marquee').style('pointer-events', 'none');

    const graph = new DirectedGraph<DagNodeAttrs>();
    let nodes: DagNode[] = [];
    /** `nodes` 按 step 降序（新→旧→prompt）排列的副本，供传播链动画 {@link promptNodeIdsFromCtx} 等使用。 */
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
    /**
     * 布局多选集合（蓝虚线框）：与焦点互清；仅用于多节点拖拽。
     * Cmd/Ctrl+点、右键框选写入；普通单击/点空白清空。
     */
    let layoutSelectedIds = new Set<string>();
    /** Cmd/Ctrl 是否按下：与多选集一起决定悬停用虚线框而非焦点描边。 */
    let multiSelectModifierDown = false;
    /** 悬浮节点 id；无选中时参与归因预览焦点，有选中时仅驱动 `--hover` 等样式，不改归因焦点 */
    let hoveredId: string | null = null;
    /**
     * attribution-matrix 交互态：
     * - `row` 点击与 {@link userFocusId} 互通（播放入口）。
     * - `col`/`cell`：仅静态检查（红下游 / 单边），不设焦点、不驱动 ↯。
     * - 高亮经 {@link refreshNodeLinkHighlight}；无焦点时悬停可预览（含 Self 行）。
     * - 有焦点/lock 时悬停只加框，不改归因。点击空白清 lock + 焦点。
     */
    let matrixHoverTarget: MatrixInteractionTarget | null = null;
    let matrixLockedTarget: MatrixInteractionTarget | null = null;
    /** ▶ Simulate attention：attend / FFN 阶段 token 高亮 */
    let attentionHighlight: AttentionPlaybackHighlight = null;
    let lastTokenAppearanceDwellActive = false;
    /** 最近一次 {@link refreshNodeLinkHighlight} 计算出的归因状态（基于 {@link effectiveFocusId}）；tooltip 用于展示归因份额 */
    let currentFocusState: FocusAttributionState | null = null;
    /** 边 tooltip 用的焦点态（含动画 overlay 的 `linkFocusState`）；与 `<title>` / Link strength 同源 */
    let currentLinkFocusState: FocusAttributionState | null = null;
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

    function notifyUserFocusChange(): void {
        options?.onUserFocusChange?.(userFocusId);
    }

    const getPropagationPlaybackOptionsRaw =
        options?.getPropagationPlaybackOptions ??
        ((): DagPropagationPlaybackOptions => ({
            forwardSlideSharedNodes: false,
            lightningEffect: false,
            lightningThresholdTau: DAG_LIGHTNING_THRESHOLD_TAU_DEFAULT,
            lightningSlowMo: DAG_LIGHTNING_SLOW_MO_DEFAULT,
            lightningSound: false,
        }));
    /** matrix 不接 Lightning（图隐藏且无格上等价效果）；强制关掉以免仍播雷声。 */
    const getPropagationPlaybackOptions = (): DagPropagationPlaybackOptions => {
        const opts = getPropagationPlaybackOptionsRaw();
        if (layoutMode !== 'attribution-matrix') return opts;
        if (!opts.lightningEffect && !opts.lightningSound) return opts;
        return { ...opts, lightningEffect: false, lightningSound: false };
    };

    let lightningPreviewStartedAt: number | null = null;
    let lightningTauAdjustPreview = false;
    const lightningSound = createDagLightningSoundController();
    let lightningSoundOnBoundaryFrame = false;

    function syncLightningSound(args: {
        propagationPlaybackPhase: DagPropagationPlaybackPhase;
        lightningEffectEnabled: boolean;
        lightningSoundEnabled: boolean;
        lightningPreviewActive: boolean;
        boundaryFrameElapsedMs: number;
        anim: { direction: DagRecursiveEdgeAnimationDirection; batchIndex: number; forwardPromptPreamblePending: boolean } | null;
        forwardPromptPreambleFrame: boolean;
    }): void {
        if (!args.lightningEffectEnabled || !args.lightningSoundEnabled) {
            lightningSound.cancelPendingStrike();
            lightningSound.stopRumble();
            lightningSoundOnBoundaryFrame = false;
            return;
        }
        const { propagationPlaybackPhase, anim, lightningPreviewActive } = args;
        if (propagationPlaybackPhase !== 'playing' && propagationPlaybackPhase !== 'paused') {
            if (lightningPreviewActive) {
                lightningSoundOnBoundaryFrame = false;
                return;
            }
            lightningSound.stopRumble();
            lightningSoundOnBoundaryFrame = false;
            return;
        }
        if (anim?.direction !== 'forward') {
            lightningSound.stopRumble();
            lightningSoundOnBoundaryFrame = false;
            return;
        }
        const onLightningFrame =
            anim.batchIndex === 0 && !anim.forwardPromptPreamblePending && !args.forwardPromptPreambleFrame;
        if (onLightningFrame) {
            if (args.boundaryFrameElapsedMs < DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS) {
                lightningSoundOnBoundaryFrame = false;
                if (propagationPlaybackPhase === 'playing') {
                    lightningSound.startRumbleLoop();
                } else {
                    lightningSound.pauseRumble();
                }
                return;
            }
            if (!lightningSoundOnBoundaryFrame) {
                lightningSound.scheduleStrikeAfterRumbleDelay();
            }
            lightningSoundOnBoundaryFrame = true;
            return;
        }
        lightningSoundOnBoundaryFrame = false;
        if (propagationPlaybackPhase === 'playing') {
            lightningSound.startRumbleLoop();
        } else {
            lightningSound.pauseRumble();
        }
    }

    const recursiveEdgeAnimation = createDagRecursiveEdgeAnimationController({
        onTick: () => refreshNodeLinkHighlight(),
        onPlaybackPhaseChange: () => {
            if (recursiveEdgeAnimation.getPlaybackPhase() === 'playing') {
                lightningPreviewStartedAt = null;
            }
            syncDagPlayButtonImpl();
            refreshNodeLinkHighlight();
        },
        computeFocusState: (focusId, options, ctx) =>
            computeFocusAttributionState(
                graph,
                ctx.incomingLinksByTarget as Map<string, DagLink[]>,
                focusId,
                {
                    ...options,
                    decayAttributionToHighSurprisalTarget: dagDecayAttributionToHighSurprisalTargetEnabled,
                },
            ),
        computeSteadyStateStayShareById: (nodeShareById, focusId) =>
            computeSteadyStateStayShareById(nodeShareById, graph, incomingLinksByTarget, focusId),
        isRecursiveAttributionEnabled: () => recursiveAttributionEnabled,
        hasNode: (id) => graph.hasNode(id),
        offsetOf: (id) => (graph.hasNode(id) ? (graph.getNodeAttributes(id) as DagNode).start : 0),
        isPromptNode: (id) => graph.hasNode(id) && (graph.getNodeAttributes(id) as DagNode).step === -1,
        tokenLabelOf: (id) => {
            if (!graph.hasNode(id)) return null;
            const n = graph.getNodeAttributes(id) as DagNode;
            return n.displayLabel ?? n.label;
        },
        direction: options?.recursiveEdgeBatchAnimationDirection ?? 'forward',
        getReplayPacing: options?.getReplayPacing,
        getPropagationPlaybackOptions,
    });

    /** 多选交互态：悬停用虚线框，不用焦点描边 / 归因悬停预览 / tooltip。 */
    function layoutSelectHoverActive(): boolean {
        return (
            layoutSelectedIds.size > 0 ||
            multiSelectModifierDown ||
            marqueeSession != null
        );
    }

    /**
     * 实线焦点框对应节点（`--hover` / `--selected`）：
     * 非多选虚线态下悬停优先，否则为点击确立的焦点；与 tooltip 同源。
     */
    function solidFrameFocusId(): string | null {
        if (!layoutSelectHoverActive() && hoveredId != null && graph.hasNode(hoveredId)) {
            return hoveredId;
        }
        const id = userFocusId ?? selectedId;
        return id != null && graph.hasNode(id) ? id : null;
    }

    /** 归因预览焦点：播放/选中优先；仅无选中时才用悬停（多选虚线态忽略悬停）。 */
    function effectiveFocusId(): string | null {
        if (layoutSelectHoverActive()) return userFocusId ?? selectedId;
        return userFocusId ?? selectedId ?? hoveredId;
    }

    /**
     * matrix 交互 → 节点 tooltip token：行/列=对应轴 token。
     * 格走边 tooltip（见 {@link syncGenAttrDagTopkTooltipImpl}），不经此函数。
     */
    function matrixTooltipTokenId(target: MatrixInteractionTarget | null): string | null {
        if (target == null || target.type === 'cell') return null;
        return target.id;
    }

    /**
     * matrix 实线悬停对应的「被读份额」节点：与 text 的 `hoveredId` 同角色。
     * 仅行/列；格用边指标，不走节点份额行。
     */
    function matrixShareSourceId(): string | null {
        const hover = matrixHoverTarget;
        if (hover == null || hover.type === 'cell') return null;
        return hover.id;
    }

    /** tooltip 锚点：传播播放 > matrix hover/lock > {@link solidFrameFocusId}。 */
    function tooltipFocusId(): string | null {
        if (propagationPlaybackTooltip != null && graph.hasNode(propagationPlaybackTooltip.nodeId)) {
            return propagationPlaybackTooltip.nodeId;
        }
        if (layoutMode === 'attribution-matrix') {
            const matrixId = matrixTooltipTokenId(matrixHoverTarget ?? matrixLockedTarget);
            if (matrixId != null && graph.hasNode(matrixId)) return matrixId;
        }
        return solidFrameFocusId();
    }

    /** matrix 可见 chip 的 fill rect（HUD 定位不依赖几何，但 update 路径要求非空锚点）。 */
    function matrixTooltipAnchorRect(nodeId: string, target: MatrixInteractionTarget | null): SVGRectElement | null {
        const preferCol = target?.type === 'col';
        const tokens = matrixG.selectAll<SVGGElement, unknown>('g.gen-attr-dag-matrix-token');
        const fillOf = (sel: d3.Selection<SVGGElement, unknown, SVGGElement, unknown>) =>
            sel.select<SVGRectElement>('rect.gen-attr-dag-node-fill').node();
        const preferred = tokens.filter(function () {
            const el = this as SVGGElement;
            if (el.getAttribute('data-node-id') !== nodeId) return false;
            const isCol = el.classList.contains('gen-attr-dag-matrix-col-token');
            return preferCol ? isCol : !isCol;
        });
        return (
            fillOf(preferred) ??
            fillOf(tokens.filter(function () {
                return (this as SVGGElement).getAttribute('data-node-id') === nodeId;
            }))
        );
    }

    /** matrix 格 HUD 锚点：优先格子本身，否则回退列 chip。 */
    function matrixCellTooltipAnchorRect(srcId: string, tgtId: string): SVGRectElement | null {
        const cell = matrixG
            .selectAll<SVGRectElement, { srcId: string; tgtId: string }>('rect.gen-attr-dag-matrix-cell')
            .filter((d) => d != null && d.srcId === srcId && d.tgtId === tgtId)
            .node();
        return cell ?? matrixTooltipAnchorRect(srcId, { type: 'col', id: srcId });
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
            layoutMode === 'spiral' ||
            layoutMode === 'attribution-matrix'
        );
    }

    /** 矩阵布局时隐藏节点/边层；其它布局隐藏矩阵层。 */
    function syncLayoutLayerVisibility(): void {
        const matrix = layoutMode === 'attribution-matrix';
        const graphDisplay = matrix ? 'none' : null;
        linkG.style('display', graphDisplay);
        nodeG.style('display', graphDisplay);
        linkGFront.style('display', graphDisplay);
        nodeGHit.style('display', graphDisplay);
        matrixG.style('display', matrix ? null : 'none').style('pointer-events', matrix ? 'auto' : 'none');
        if (!matrix) {
            disposeMatrixPointerHit();
            matrixG.selectAll('*').remove();
            matrixFirstSourceAnchor = null;
        }
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
        const { anim, forwardPromptPreambleFrame, propagationSlideTgtId, nodeStrokeShareById } =
            animOverlay;
        if (forwardPromptPreambleFrame) {
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

    /**
     * 与预处理同源的 exclude 半开区间；**仅**供节点透明度 / hide（{@link isOffsetSpanFullyExcluded}），
     * 不参与边集事后修正（边 exclude 在建边时定稿，见模块顶注释「Exclude 原则」）。
     * 每步按**当前**正则刷新，故动态过程中改 exclude 可能改变节点 dim/hide，但不改已建边。
     * 在 {@link setPromptTokenSpans} 与每步 {@link update} 中刷新；{@link reset} 清空。
     */
    let dagExcludeIntervals: [number, number][] = [];
    /**
     * 每次 {@link setPromptTokenSpans} 按 `layoutWire` + `inputRanges` 重算（与 exclude 一致；多轮追加 input 区时扩展）。
     * 命中区间内的 prompt token 不进入图也不进入测量层（textMeasure 物理压缩布局空间）。
     */
    let dagDeleteIntervals: [number, number][] = [];
    /**
     * 当前 input 区划分（prompt + 后续 tool_response）；与 step/`setPromptTokenSpans` 同源。
     * attribution-matrix 行轴用：排除 `inputRanges[0]`，保留 k≥1 的 tool_response。
     */
    let dagInputRanges: CharRange[] = [];
    /**
     * 用户是否手动改动过布局：拖节点 或 用户手势 zoom/pan。
     * - true 时：容器尺寸变化（窗口 resize / 侧栏）不再自动 fit，保留用户视图
     * - false 时：任何尺寸变化都自动 fit
     * 清零点：{@link reset}（默认）、{@link fitViewportToContent}（fit 本身把视图带回默认）；
     * `reset(true)` 时与 userDraggedNodes 一并保留。
     */
    let layoutDirty = false;
    /**
     * 用户是否拖动过节点（仅拖节点，不含画布 pan/zoom）。
     * - {@link layoutDirty} 在 pan/zoom 时也会为 true；刷新时若仅 pan/zoom 则仍 {@link fitViewportToContent}，
     *   若拖过节点则回放数据恢复节点几何并保留当前 pan/zoom。
     * 清零点：{@link reset}（默认）、成功 {@link fitViewportToContent}（与 layoutDirty 一并清）；
     * `reset(true)` 时与 layoutDirty 一并保留。
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

    function layoutInteractionLocked(): boolean {
        return (
            dagPlaybackPlaying || recursiveEdgeAnimation.getPlaybackPhase() === 'playing'
        );
    }

    function clearLayoutSelectionOnly(): void {
        if (layoutSelectedIds.size === 0) return;
        layoutSelectedIds = new Set();
    }

    function clearFocusForLayoutSelection(): void {
        selectedId = null;
        userFocusId = null;
        recursiveEdgeAnimation.stopPlayback();
        notifyUserFocusChange();
    }

    function bindNodePointerHandlers(
        sel: d3.Selection<SVGGElement, DagNode, SVGGElement | null, unknown>,
    ): void {
        sel.on('mouseenter', (event, d) => {
            // 若在节点上按下/松开修饰键可能丢 key 事件，用 pointer 状态对齐
            syncMultiSelectModifierDown(isMultiSelectModifierKey(event));
            hoveredId = d.id;
            refreshNodeLinkHighlight();
        })
            .on('mouseleave', () => {
                hoveredId = null;
                refreshNodeLinkHighlight();
            })
            .on('click', (event, d) => {
                event.stopPropagation();
                if (layoutInteractionLocked()) return;
                if (isMultiSelectModifierKey(event)) {
                    clearFocusForLayoutSelection();
                    const next = new Set(layoutSelectedIds);
                    if (next.has(d.id)) next.delete(d.id);
                    else next.add(d.id);
                    layoutSelectedIds = next;
                    refreshNodeLinkHighlight();
                    syncDagPlayButtonImpl();
                    return;
                }
                clearLayoutSelectionOnly();
                const next = userFocusId === d.id ? null : d.id;
                userFocusId = next;
                selectedId = next;
                recursiveEdgeAnimation.stopPlayback();
                refreshNodeLinkHighlight();
                syncDagPlayButtonImpl();
                notifyUserFocusChange();
            });
    }

    function syncSvgSize(): void {
        const { w, h } = stackLayoutViewportPx(stackEl);
        svg.attr('width', w).attr('height', h);
    }

    /**
     * attribution-matrix 列轴（源）：与其它布局一致按 `nodeIncludedInLayout` 过滤，按 offset 定序。
     * 行轴（目标）见 {@link matrixRowNodes}。
     */
    function matrixColNodes(): DagNode[] {
        return nodes
            .filter((n) => nodeIncludedInLayout(n))
            .slice()
            .sort((a, b) => a.start - b.start || a.end - b.end);
    }

    /** 是否落在 tool_response input 区（`dagInputRanges[k]`, k≥1）；与合成边建边判定一致。 */
    function nodeInToolResponseInput(n: DagNode): boolean {
        for (let k = 1; k < dagInputRanges.length; k++) {
            const [trStart, trEnd] = dagInputRanges[k]!;
            if (n.step < 0 && n.start >= trStart && n.end <= trEnd) return true;
        }
        return false;
    }

    /**
     * attribution-matrix 行轴（目标）：生成 token + tool_response（第二段及之后 input）；
     * 首轮 prompt（`inputRanges[0]`）不作被归因目标，不占纵向。
     */
    function matrixRowNodes(): DagNode[] {
        return matrixColNodes().filter((n) => n.step !== -1 || nodeInToolResponseInput(n));
    }

    /** 行焦点 ↔ matrix 行 lock；非行焦点时清掉行 lock（保留 col/cell 静态 lock）。 */
    function syncMatrixRowLockWithUserFocus(): void {
        if (userFocusId != null && matrixRowNodes().some((n) => n.id === userFocusId)) {
            matrixLockedTarget = { type: 'row', id: userFocusId };
            return;
        }
        if (matrixLockedTarget?.type === 'row') matrixLockedTarget = null;
    }

    /** 已确立的行焦点（点击 / userFocus / ▶ selected / 行 lock）。 */
    function matrixCommittedRowFocusId(): string | null {
        if (!recursiveAttributionEnabled) return null;
        if (userFocusId != null && matrixRowNodes().some((n) => n.id === userFocusId)) {
            return userFocusId;
        }
        if (selectedId != null && matrixRowNodes().some((n) => n.id === selectedId)) {
            return selectedId;
        }
        if (matrixLockedTarget?.type === 'row') return matrixLockedTarget.id;
        return null;
    }

    /** Self 行：已确立行焦点；无焦点时悬停行 token 预览。 */
    function matrixRowFocusId(): string | null {
        const committed = matrixCommittedRowFocusId();
        if (committed != null) return committed;
        if (matrixHoverTarget?.type === 'row') return matrixHoverTarget.id;
        return null;
    }

    function resolveMatrixSelfCellOpacityByCol(
        rowFocusId: string,
        propagationShared: MatrixPropagationHighlightShared | null,
    ): Map<number, number> | undefined {
        const focusState =
            propagationShared?.focusState ??
            computeFocusAttributionState(graph, incomingLinksByTarget, rowFocusId, {
                maxIncomingDepth: Number.POSITIVE_INFINITY,
                includeDownstreamInfluence: false,
                decayAttributionToHighSurprisalTarget: dagDecayAttributionToHighSurprisalTargetEnabled,
            });
        if (focusState == null) return undefined;
        const stayById =
            propagationShared?.animOverlay.nodeStrokeShareById ??
            computeSteadyStateStayShareById(
                focusState.nodeShareById,
                graph,
                incomingLinksByTarget,
                rowFocusId,
            );
        if (stayById.size === 0) return undefined;
        const focusNode = graph.getNodeAttributes(rowFocusId) as DagNode;
        const animOverlay = propagationShared?.animOverlay;
        const maxShareOverride =
            animOverlay?.animationFrontierPartial && !animOverlay.forwardPromptPreambleFrame
                ? animOverlay.nodeStrokeMaxForRender
                : undefined;
        return buildMatrixSelfCellOpacityByCol(
            stayById,
            matrixColNodes(),
            nodeTargetMiRatio(focusNode),
            maxShareOverride,
        );
    }

    /** 点列/格时清掉传播焦点，避免播放钮仍指向旧行。 */
    function clearUserFocusForMatrixStaticLock(): void {
        if (userFocusId == null && selectedId == null) return;
        userFocusId = null;
        selectedId = null;
        recursiveEdgeAnimation.stopPlayback();
        notifyUserFocusChange();
        syncDagPlayButtonImpl();
    }

    const matrixInteractionHandlers: MatrixInteractionHandlers = {
        onRowEnter: (id) => {
            if (layoutInteractionLocked()) return;
            matrixHoverTarget = { type: 'row', id };
            refreshNodeLinkHighlight();
        },
        onRowLeave: (id) => {
            if (matrixHoverTarget?.type === 'row' && matrixHoverTarget.id === id) matrixHoverTarget = null;
            refreshNodeLinkHighlight();
        },
        onRowClick: (id) => {
            if (layoutInteractionLocked()) return;
            clearLayoutSelectionOnly();
            const next = userFocusId === id ? null : id;
            userFocusId = next;
            selectedId = next;
            matrixLockedTarget = next != null ? { type: 'row', id: next } : null;
            matrixHoverTarget = null;
            recursiveEdgeAnimation.stopPlayback();
            refreshNodeLinkHighlight();
            syncDagPlayButtonImpl();
            notifyUserFocusChange();
        },
        onColEnter: (id) => {
            if (layoutInteractionLocked()) return;
            matrixHoverTarget = { type: 'col', id };
            refreshNodeLinkHighlight();
        },
        onColLeave: (id) => {
            if (matrixHoverTarget?.type === 'col' && matrixHoverTarget.id === id) matrixHoverTarget = null;
            refreshNodeLinkHighlight();
        },
        onColClick: (id) => {
            if (layoutInteractionLocked()) return;
            clearUserFocusForMatrixStaticLock();
            const same = matrixLockedTarget?.type === 'col' && matrixLockedTarget.id === id;
            matrixLockedTarget = same ? null : { type: 'col', id };
            matrixHoverTarget = null;
            refreshNodeLinkHighlight();
        },
        onCellEnter: (srcId, tgtId) => {
            if (layoutInteractionLocked()) return;
            matrixHoverTarget = { type: 'cell', srcId, tgtId };
            refreshNodeLinkHighlight();
        },
        onCellLeave: (srcId, tgtId) => {
            if (
                matrixHoverTarget?.type === 'cell' &&
                matrixHoverTarget.srcId === srcId &&
                matrixHoverTarget.tgtId === tgtId
            ) {
                matrixHoverTarget = null;
            }
            refreshNodeLinkHighlight();
        },
        onCellClick: (srcId, tgtId) => {
            if (layoutInteractionLocked()) return;
            clearUserFocusForMatrixStaticLock();
            const same =
                matrixLockedTarget?.type === 'cell' &&
                matrixLockedTarget.srcId === srcId &&
                matrixLockedTarget.tgtId === tgtId;
            matrixLockedTarget = same ? null : { type: 'cell', srcId, tgtId };
            matrixHoverTarget = null;
            refreshNodeLinkHighlight();
        },
        onBackgroundClick: () => {
            clearNodeSelection();
        },
    };

    type MatrixVisualMaps = {
        cellVisualByKey: Map<string, MatrixCellVisual>;
        rowTokenVisualById: Map<string, MatrixTokenVisual>;
        colTokenVisualById: Map<string, MatrixTokenVisual>;
    };

    function emptyMatrixVisualMaps(): MatrixVisualMaps {
        return {
            cellVisualByKey: new Map(),
            rowTokenVisualById: new Map(),
            colTokenVisualById: new Map(),
        };
    }

    function weakenUnsetMatrixTokens(maps: MatrixVisualMaps): void {
        for (const n of matrixRowNodes()) {
            if (!maps.rowTokenVisualById.has(n.id)) {
                maps.rowTokenVisualById.set(n.id, { fillOpacity: MATRIX_TOKEN_OPACITY_WEAKENED });
            }
        }
        for (const n of matrixColNodes()) {
            if (!maps.colTokenVisualById.has(n.id)) {
                maps.colTokenVisualById.set(n.id, { fillOpacity: MATRIX_TOKEN_OPACITY_WEAKENED });
            }
        }
    }

    /**
     * 行焦点蓝入边链 → 蓝格 + **列（source）轴**抬亮。
     * 格：与 text 入边同一套 opacity / frontier 门控。
     * 轴：链上 stay / 1 跳 active / slide 只抬 source 侧；target 侧仅焦点行（+ 框）。
     */
    function computeMatrixIncomingChainVisuals(
        focusId: string,
        incomingRenderByKey: Map<string, number>,
        options?: {
            isEdgeVisible?: (key: string) => boolean;
            showFocusFrame?: boolean;
            /** text 的 nodeStrokeShareById / activeNodeIds */
            chainNodeIds?: ReadonlySet<string> | null;
            slideTgtId?: string | null;
            /** 与 text `highlightStayNodesFill` 一致；false 时仅焦点+slide 全亮 */
            highlightStayNodesFill?: boolean;
            forwardPromptPreambleFrame?: boolean;
        },
    ): MatrixVisualMaps {
        const maps = emptyMatrixVisualMaps();
        const isEdgeVisible = options?.isEdgeVisible ?? (() => true);
        for (const [key, opacity] of incomingRenderByKey) {
            if (!isEdgeVisible(key)) continue;
            maps.cellVisualByKey.set(key, { kind: 'blue', opacity });
        }

        const chain = options?.chainNodeIds ?? null;
        const slideTgtId = options?.slideTgtId ?? null;
        const showFocusFrame = options?.showFocusFrame !== false;
        const highlightStay = options?.highlightStayNodesFill !== false;
        const preamble = options?.forwardPromptPreambleFrame === true;

        const sourceFull = (id: string): boolean => {
            if (id === focusId) return false; // 焦点只在 target（行）侧亮
            if (preamble) {
                return (
                    graph.hasNode(id) &&
                    (graph.getNodeAttributes(id) as DagNode).step === -1 &&
                    (chain?.has(id) ?? false)
                );
            }
            const isSlide = slideTgtId != null && id === slideTgtId;
            if (highlightStay) return isSlide || (chain?.has(id) ?? false);
            return isSlide;
        };

        const lightSourceAxis = (id: string): void => {
            const colPrev = maps.colTokenVisualById.get(id);
            maps.colTokenVisualById.set(id, {
                fillOpacity: MATRIX_TOKEN_OPACITY_FULL,
                frame: colPrev?.frame,
            });
        };

        if (chain != null) {
            for (const id of chain) {
                if (sourceFull(id)) lightSourceAxis(id);
            }
        }
        if (slideTgtId != null && sourceFull(slideTgtId)) lightSourceAxis(slideTgtId);

        // 行焦点框（text 的 selected）；被归因 token 不在 target 侧抬亮。
        if (showFocusFrame) {
            maps.rowTokenVisualById.set(focusId, {
                fillOpacity: MATRIX_TOKEN_OPACITY_FULL,
                frame: 'solid',
            });
        }

        weakenUnsetMatrixTokens(maps);
        return maps;
    }

    /**
     * 按当前矩阵交互目标解析格子 / 行轴 / 列轴视觉态（行·列分表，同 id 不联动）：
     * - `row`：行焦点蓝框；蓝格对应的**列** token 抬亮；其余半亮
     * - `col`：列焦点蓝框；红格对应的**行** token 抬亮；其余半亮
     * - `cell`：列 src + 行 tgt 蓝框抬亮；其余半亮
     */
    function computeMatrixVisuals(target: MatrixInteractionTarget | null): MatrixVisualMaps {
        const maps = emptyMatrixVisualMaps();
        if (target == null) return maps;

        if (target.type === 'cell') {
            const { srcId, tgtId } = target;
            if (graph.hasNode(srcId) && graph.hasNode(tgtId) && graph.hasEdge(srcId, tgtId)) {
                // 与行焦点同一套公式（{@link buildMaxNormalizedRenderStrengthByKey}），只是强制 1 跳：
                // 保证「悬停格子」与「悬停该格所在行」对同一条边给出完全一致的蓝色透明度。
                const tgtNode = graph.getNodeAttributes(tgtId) as DagNode;
                const focusState = computeFocusAttributionState(graph, incomingLinksByTarget, tgtId, {
                    maxIncomingDepth: 1,
                    includeDownstreamInfluence: false,
                    decayAttributionToHighSurprisalTarget: dagDecayAttributionToHighSurprisalTargetEnabled,
                });
                const key = attributionMatrixCellKey(srcId, tgtId);
                const opacity =
                    focusState == null
                        ? 0
                        : buildMaxNormalizedRenderStrengthByKey(
                              focusState.incomingEdgeShareByKey,
                              nodeTargetMiRatio(tgtNode),
                          ).get(key) ?? 0;
                maps.cellVisualByKey.set(key, { kind: 'blue', opacity });
                maps.colTokenVisualById.set(srcId, {
                    frame: 'solid',
                    fillOpacity: MATRIX_TOKEN_OPACITY_FULL,
                });
                maps.rowTokenVisualById.set(tgtId, {
                    frame: 'solid',
                    fillOpacity: MATRIX_TOKEN_OPACITY_FULL,
                });
            }
            weakenUnsetMatrixTokens(maps);
            return maps;
        }

        const focusId = target.id;
        if (!graph.hasNode(focusId)) return maps;
        const focusNode = graph.getNodeAttributes(focusId) as DagNode;

        if (target.type === 'row') {
            const focusState = computeFocusAttributionState(graph, incomingLinksByTarget, focusId, {
                maxIncomingDepth: recursiveAttributionEnabled ? Number.POSITIVE_INFINITY : 1,
                includeDownstreamInfluence: false,
                decayAttributionToHighSurprisalTarget: dagDecayAttributionToHighSurprisalTargetEnabled,
            });
            if (focusState == null) return maps;
            const forwardSlideSharedNodes = getPropagationPlaybackOptions().forwardSlideSharedNodes;
            const chainNodeIds = recursiveAttributionEnabled
                ? new Set(
                      computeSteadyStateStayShareById(
                          focusState.nodeShareById,
                          graph,
                          incomingLinksByTarget,
                          focusId,
                      ).keys(),
                  )
                : focusState.activeNodeIds;
            return computeMatrixIncomingChainVisuals(
                focusId,
                buildMaxNormalizedRenderStrengthByKey(
                    focusState.incomingEdgeShareByKey,
                    nodeTargetMiRatio(focusNode),
                ),
                {
                    chainNodeIds,
                    // 非递归：chain=activeNodeIds，须抬亮；递归：与 text highlightStayNodesFill 一致。
                    highlightStayNodesFill: !recursiveAttributionEnabled || !forwardSlideSharedNodes,
                },
            );
        }

        // target.type === 'col'：下游红链；矩阵模式下恒计算，不受 `showDownstreamInfluence` 开关影响。
        const focusState = computeFocusAttributionState(graph, incomingLinksByTarget, focusId, {
            maxIncomingDepth: 0,
            includeDownstreamInfluence: true,
            maxOutgoingDepth: recursiveAttributionEnabled ? Number.POSITIVE_INFINITY : 1,
            decayAttributionToHighSurprisalTarget: dagDecayAttributionToHighSurprisalTargetEnabled,
        });
        if (focusState == null) return maps;
        const downstreamRenderByKey = buildDownstreamArriveScaledRenderStrengthByKey(
            focusState.downstreamEdgeStrengthByKey,
            focusState.downstreamArriveById,
        );
        for (const [key, opacity] of downstreamRenderByKey) {
            maps.cellVisualByKey.set(key, { kind: 'red', opacity });
            const ends = attributionMatrixEdgeEndpoints(key);
            if (ends) {
                maps.rowTokenVisualById.set(ends.tgtId, { fillOpacity: MATRIX_TOKEN_OPACITY_FULL });
            }
        }
        maps.colTokenVisualById.set(focusId, {
            frame: 'solid',
            fillOpacity: MATRIX_TOKEN_OPACITY_FULL,
        });
        weakenUnsetMatrixTokens(maps);
        return maps;
    }

    /** ▶ / `update` 写入的 `selectedId` 若在行轴上，视为行焦点（与 text `effectiveFocusId` 对齐）。 */
    function matrixSelectedRowTarget(): MatrixInteractionTarget | null {
        if (selectedId == null) return null;
        if (!matrixRowNodes().some((n) => n.id === selectedId)) return null;
        return { type: 'row', id: selectedId };
    }

    /**
     * matrix 静态归因目标：▶ selected 行 → userFocus 行 → lock → selected 行；无锁时悬停可预览。
     */
    function matrixStaticHighlightTarget(): MatrixInteractionTarget | null {
        const selectedRow = matrixSelectedRowTarget();
        if (dagPlaybackPlaying && selectedRow != null) return selectedRow;
        const userFocusRow: MatrixInteractionTarget | null =
            userFocusId != null && matrixRowNodes().some((n) => n.id === userFocusId)
                ? { type: 'row', id: userFocusId }
                : null;
        const committed = userFocusRow ?? matrixLockedTarget ?? selectedRow;
        if (committed != null) return committed;
        return matrixHoverTarget;
    }

    /** 有锁时悬停只加框，不改格子归因（对齐 text `--hover`）。 */
    function applyMatrixHoverFrame(maps: MatrixVisualMaps): void {
        if (matrixCommittedRowFocusId() != null || matrixLockedTarget != null) {
            const hover = matrixHoverTarget;
            if (hover == null) return;
            const bump = (map: Map<string, MatrixTokenVisual>, id: string) => {
                const prev = map.get(id);
                map.set(id, {
                    fillOpacity: prev?.fillOpacity ?? MATRIX_TOKEN_OPACITY_WEAKENED,
                    frame: prev?.frame === 'solid' ? 'solid' : 'hover',
                });
            };
            if (hover.type === 'row') bump(maps.rowTokenVisualById, hover.id);
            else if (hover.type === 'col') bump(maps.colTokenVisualById, hover.id);
            else {
                bump(maps.colTokenVisualById, hover.srcId);
                bump(maps.rowTokenVisualById, hover.tgtId);
            }
        }
    }

    /** ↯ 进行中：userFocus 行焦点 + playing/paused。 */
    function matrixPropagationHighlightActive(): boolean {
        const phase = recursiveEdgeAnimation.getPlaybackPhase();
        return (
            recursiveAttributionEnabled &&
            userFocusId != null &&
            graph.hasNode(userFocusId) &&
            (phase === 'playing' || phase === 'paused')
        );
    }

    /**
     * text {@link refreshNodeLinkHighlight} 本帧算出的 ↯ 中间态。
     * matrix 高亮只由此入口消费，不再本地 resolve。
     */
    type MatrixPropagationHighlightShared = {
        focusId: string;
        focusState: FocusAttributionState;
        animOverlay: RecursiveEdgeAnimationRenderOverlay;
        incomingHighlightRenderByKey: Map<string, number>;
        /** text 同帧：backward 本批 slide 入边 → 红。 */
        backwardSlideIncomingRenderByKey: Map<string, number> | null;
        propagationSlideTgtId: string | null;
    };

    function matrixVisualsFromPropagationShared(
        shared: MatrixPropagationHighlightShared,
    ): MatrixVisualMaps {
        const {
            focusId,
            focusState,
            animOverlay,
            incomingHighlightRenderByKey,
            backwardSlideIncomingRenderByKey,
            propagationSlideTgtId,
        } = shared;
        const forwardSlideSharedNodes =
            animOverlay.anim?.direction === 'backward'
                ? false
                : (animOverlay.anim?.weightScope.forwardSlideSharedNodes ??
                  getPropagationPlaybackOptions().forwardSlideSharedNodes);
        const chainNodeIds =
            animOverlay.nodeStrokeShareById != null
                ? new Set(animOverlay.nodeStrokeShareById.keys())
                : null;
        const isEdgeVisible = (key: string) =>
            animOverlay.edgeVisibility(key, focusState.incomingEdgeShareByKey.has(key)) > 0;
        const maps = computeMatrixIncomingChainVisuals(focusId, incomingHighlightRenderByKey, {
            isEdgeVisible,
            showFocusFrame: !animOverlay.deferFocusHighlightDuringAnim,
            chainNodeIds,
            slideTgtId: propagationSlideTgtId,
            highlightStayNodesFill: !forwardSlideSharedNodes,
            forwardPromptPreambleFrame: animOverlay.forwardPromptPreambleFrame,
        });
        // 对齐 text `resolveDagLinkHighlightDisplay`：本批 backward slide 入边改红。
        if (backwardSlideIncomingRenderByKey != null) {
            for (const [key, opacity] of backwardSlideIncomingRenderByKey) {
                if (!isEdgeVisible(key)) continue;
                maps.cellVisualByKey.set(key, { kind: 'red', opacity });
            }
        }
        return maps;
    }

    /**
     * 矩阵重上色（仅由 {@link refreshNodeLinkHighlight} 调用）。
     * ↯：必须带本帧 shared；缺失则空态（报错取向，不偷偷重算）。
     * 静态：{@link matrixStaticHighlightTarget}。
     */
    function refreshMatrixHighlight(
        propagationShared: MatrixPropagationHighlightShared | null,
    ): void {
        if (layoutMode !== 'attribution-matrix') return;
        grayRenderCache ??= buildGrayRenderStrengthByEdgeKey(graph, incomingLinksByTarget);

        let visuals: MatrixVisualMaps;
        if (matrixPropagationHighlightActive()) {
            if (propagationShared == null || propagationShared.focusId !== userFocusId) {
                throw new Error(
                    'genAttributeDagView: matrix ↯ highlight requires shared overlay from refreshNodeLinkHighlight',
                );
            }
            visuals = matrixVisualsFromPropagationShared(propagationShared);
        } else {
            visuals = computeMatrixVisuals(matrixStaticHighlightTarget());
        }
        applyMatrixHoverFrame(visuals);

        const rowFocusId = matrixRowFocusId();
        const selfCellOpacityByCol =
            rowFocusId != null ? resolveMatrixSelfCellOpacityByCol(rowFocusId, propagationShared) : undefined;

        restyleAttributionMatrixLayout({
            matrixG,
            grayOpacityByKey: grayRenderCache,
            cellVisualByKey: visuals.cellVisualByKey,
            rowTokenVisualById: visuals.rowTokenVisualById,
            colTokenVisualById: visuals.colTokenVisualById,
            selfCellOpacityByCol,
        });
        // tooltip 由 refreshNodeLinkHighlight 末尾统一 sync，此处不重复。
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
        syncLayoutLayerVisibility();
        if (layoutMode === 'attribution-matrix') {
            // 从其它布局切回时，用 userFocusId 恢复行 lock（col/cell 静态 lock 保留）。
            syncMatrixRowLockWithUserFocus();
            const toMatrixNode = (n: DagNode) => ({
                id: n.id,
                displayLabel: n.displayLabel,
                isPrompt: n.step === -1,
            });
            matrixFirstSourceAnchor = paintAttributionMatrixLayout({
                matrixG,
                svg: svg.node()!,
                rowNodes: matrixRowNodes().map(toMatrixNode),
                colNodes: matrixColNodes().map(toMatrixNode),
                links: links.map((d) => ({
                    source: endpointNode(d.source, graph).id,
                    target: endpointNode(d.target, graph).id,
                    ...(d.synthetic === true ? { synthetic: true as const } : {}),
                })),
                handlers: matrixInteractionHandlers,
                showSelfRow: recursiveAttributionEnabled,
                transpose: matrixTranspose,
                switchHorizontalLabel: matrixSwitchHorizontalLabel,
                switchVerticalLabel: matrixSwitchVerticalLabel,
            });
            // 颜色由调用方随后的 refreshNodeLinkHighlight → refreshMatrixHighlight 写入。
            return;
        }
        syncNodeStrokeRects(nodeSel, displayScale);
        syncNodeLayoutSelRects(nodeSel, displayScale);
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
                displayScale,
                getLinkNodes: linkEndpointsForPaint,
            });
        }
        syncNodeHitTransforms();
    }

    let dragPointerOffset: { x: number; y: number } | null = null;
    const drag = d3
        .drag<SVGGElement, DagNode>()
        // 左键且无修饰键；布局多选非空时拖集内节点，否则仅焦点节点可拖；修饰键留给点选/框选
        .filter(
            (event, d) =>
                !isMultiSelectModifierKey(event) &&
                !event.button &&
                layoutMode === 'text-flow' &&
                !layoutInteractionLocked() &&
                (layoutSelectedIds.size > 0
                    ? layoutSelectedIds.has(d.id)
                    : selectedId === d.id)
        )
        .on('start', (event, d) => {
            event.sourceEvent?.stopPropagation();
            const [px, py] = d3.pointer(event, rootG.node());
            dragPointerOffset = { x: px - d.x, y: py - d.y };
        })
        .on('drag', (event, d) => {
            layoutDirty = true;
            userDraggedNodes = true;
            const [px, py] = d3.pointer(event, rootG.node());
            const offset = dragPointerOffset ?? { x: 0, y: 0 };
            const nextX = px - offset.x;
            const nextY = py - offset.y;
            const dx = nextX - d.x;
            const dy = nextY - d.y;
            if (dx === 0 && dy === 0) return;
            const moving =
                layoutSelectedIds.size > 0
                    ? nodes.filter((n) => layoutSelectedIds.has(n.id))
                    : [d];
            for (const n of moving) {
                n.x += dx;
                n.y += dy;
            }
            paint();
            syncGenAttrDagTopkTooltipImpl();
        })
        .on('end', () => {
            dragPointerOffset = null;
        });

    type MarqueeSession = {
        x0: number;
        y0: number;
        additive: boolean;
        rect: d3.Selection<SVGRectElement, unknown, null, undefined>;
    };
    let marqueeSession: MarqueeSession | null = null;
    /** 框选拖动中与橡胶筋相交的节点（虚线预览）；mouseup 后清空。 */
    let marqueePreviewIds = new Set<string>();

    function endMarqueeSession(event: MouseEvent): void {
        if (!marqueeSession) return;
        const session = marqueeSession;
        marqueeSession = null;
        marqueePreviewIds = new Set();
        window.removeEventListener('mousemove', onMarqueeMouseMove);
        window.removeEventListener('mouseup', onMarqueeMouseUp);
        const [x1, y1] = d3.pointer(event, rootG.node());
        const box = {
            x0: Math.min(session.x0, x1),
            y0: Math.min(session.y0, y1),
            x1: Math.max(session.x0, x1),
            y1: Math.max(session.y0, y1),
        };
        session.rect.remove();
        const hits = nodes.filter((n) => rectsIntersect(box, nodeAabb(n, displayScale))).map((n) => n.id);
        if (session.additive) {
            if (hits.length === 0) {
                refreshNodeLinkHighlight();
                return;
            }
            clearFocusForLayoutSelection();
            const next = new Set(layoutSelectedIds);
            for (const id of hits) next.add(id);
            layoutSelectedIds = next;
        } else {
            clearFocusForLayoutSelection();
            layoutSelectedIds = new Set(hits);
        }
        refreshNodeLinkHighlight();
        syncDagPlayButtonImpl();
    }

    function onMarqueeMouseMove(event: MouseEvent): void {
        if (!marqueeSession) return;
        const [x, y] = d3.pointer(event, rootG.node());
        const x0 = Math.min(marqueeSession.x0, x);
        const y0 = Math.min(marqueeSession.y0, y);
        const x1 = Math.max(marqueeSession.x0, x);
        const y1 = Math.max(marqueeSession.y0, y);
        marqueeSession.rect
            .attr('x', x0)
            .attr('y', y0)
            .attr('width', x1 - x0)
            .attr('height', y1 - y0);
        const box = { x0, y0, x1, y1 };
        const next = new Set(
            nodes.filter((n) => rectsIntersect(box, nodeAabb(n, displayScale))).map((n) => n.id),
        );
        if (
            next.size === marqueePreviewIds.size &&
            [...next].every((id) => marqueePreviewIds.has(id))
        ) {
            return;
        }
        marqueePreviewIds = next;
        refreshNodeLinkHighlight();
    }

    function onMarqueeMouseUp(event: MouseEvent): void {
        if (event.button !== 2) return;
        endMarqueeSession(event);
    }

    svg.on('mousedown.marquee', (event: MouseEvent) => {
        if (event.button !== 2) return;
        if (layoutInteractionLocked()) return;
        const target = event.target as Element | null;
        if (target?.closest?.('.gen-attr-dag-node-hit')) return;
        event.preventDefault();
        const [x0, y0] = d3.pointer(event, rootG.node());
        marqueeG.selectAll('*').remove();
        const rect = marqueeG
            .append('rect')
            .attr('class', 'gen-attr-dag-marquee-rect')
            .attr('x', x0)
            .attr('y', y0)
            .attr('width', 0)
            .attr('height', 0);
        marqueeSession = {
            x0,
            y0,
            additive: isMultiSelectModifierKey(event),
            rect,
        };
        marqueePreviewIds = new Set();
        window.addEventListener('mousemove', onMarqueeMouseMove);
        window.addEventListener('mouseup', onMarqueeMouseUp);
        // 进入框选态：立刻关掉焦点悬停
        refreshNodeLinkHighlight();
    });

    function syncMultiSelectModifierDown(next: boolean): void {
        if (next === multiSelectModifierDown) return;
        multiSelectModifierDown = next;
        refreshNodeLinkHighlight();
    }

    function onMultiSelectModifierKeyDown(event: KeyboardEvent): void {
        if (event.key !== 'Meta' && event.key !== 'Control') return;
        syncMultiSelectModifierDown(true);
    }

    function onMultiSelectModifierKeyUp(event: KeyboardEvent): void {
        if (event.key !== 'Meta' && event.key !== 'Control') return;
        // keyup 时对应修饰键已松开；另一侧若仍按住则保持
        syncMultiSelectModifierDown(event.metaKey || event.ctrlKey);
    }

    function onMultiSelectModifierBlur(): void {
        syncMultiSelectModifierDown(false);
    }

    window.addEventListener('keydown', onMultiSelectModifierKeyDown);
    window.addEventListener('keyup', onMultiSelectModifierKeyUp);
    window.addEventListener('blur', onMultiSelectModifierBlur);

    /** 焦点高亮：递归强调来源链，直接强调一跳关系。 */
    let lightningFadeRaf: number | null = null;

    function cancelLightningEffectPreview(): void {
        if (lightningPreviewStartedAt == null && !lightningTauAdjustPreview) return;
        lightningSound.cancelPendingStrike();
        lightningPreviewStartedAt = null;
        lightningTauAdjustPreview = false;
        cancelLightningFadeRaf();
    }

    function canPreviewLightningEffect(): boolean {
        return (
            getPropagationPlaybackOptions().lightningEffect &&
            recursiveAttributionEnabled &&
            effectiveFocusId() != null &&
            recursiveEdgeAnimation.getPlaybackPhase() !== 'playing'
        );
    }

    function enterLightningTauPreview(): void {
        if (!canPreviewLightningEffect()) return;
        lightningPreviewStartedAt = null;
        lightningTauAdjustPreview = true;
        cancelLightningFadeRaf();
        refreshNodeLinkHighlight();
    }

    function exitLightningTauPreview(): void {
        if (!lightningTauAdjustPreview) return;
        lightningTauAdjustPreview = false;
        cancelLightningFadeRaf();
        refreshNodeLinkHighlight();
    }

    function playLightningEffectPreview(): void {
        if (!canPreviewLightningEffect()) return;
        lightningTauAdjustPreview = false;
        lightningPreviewStartedAt = performance.now();
        if (getPropagationPlaybackOptions().lightningSound) {
            lightningSound.scheduleStrikeDelay();
        }
        cancelLightningFadeRaf();
        refreshNodeLinkHighlight();
    }

    function cancelLightningFadeRaf(): void {
        if (lightningFadeRaf != null) {
            cancelAnimationFrame(lightningFadeRaf);
            lightningFadeRaf = null;
        }
    }

    function refreshNodeLinkHighlight(): void {
        const focusId = effectiveFocusId();
        const propagationPlaybackPhase = recursiveEdgeAnimation.getPlaybackPhase();
        const includeDownstreamInfluence =
            showDownstreamInfluence &&
            !(
                recursiveAttributionEnabled &&
                (recursiveEdgeAnimation.getDirection() === 'backward' ||
                    propagationPlaybackPhase === 'playing' ||
                    propagationPlaybackPhase === 'paused')
            );
        const focusState = focusId
            ? computeFocusAttributionState(graph, incomingLinksByTarget, focusId, {
                maxIncomingDepth: recursiveAttributionEnabled ? Number.POSITIVE_INFINITY : 1,
                includeDownstreamInfluence,
                maxOutgoingDepth: recursiveAttributionEnabled ? Number.POSITIVE_INFINITY : 1,
                decayAttributionToHighSurprisalTarget: dagDecayAttributionToHighSurprisalTargetEnabled,
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
        currentLinkFocusState = linkFocusState;
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
            !animOverlay.forwardPromptPreambleFrame;
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
            focusState == null || !includeDownstreamInfluence
                ? new Map<string, number>()
                : buildDownstreamArriveScaledRenderStrengthByKey(
                      focusState.downstreamEdgeStrengthByKey,
                      focusState.downstreamArriveById,
                  );
        grayRenderCache ??= buildGrayRenderStrengthByEdgeKey(graph, incomingLinksByTarget);
        const grayRenderByKey = grayRenderCache;
        const {
            propagationSlideTgtId: propagationSlideTgtIdFromAnim,
            forwardPromptPreambleFrame,
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
            !forwardPromptPreambleFrame &&
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
            if (!forwardPromptPreambleFrame) return nodeStrokeShareById?.has(d.id) ?? false;
            return d.step === -1 && (nodeStrokeShareById?.has(d.id) ?? false);
        };
        const nodeLowVisReasonById = new Map(
            nodes.map(
                (n) => [n.id, nodeLowVisibilityReasonFor(n, focusId, focusState, dimEffective)] as const,
            ),
        );
        const nodeDisplay = (d: DagNode): string | null =>
            hideExcludedTokens && nodeLowVisReasonById.get(d.id) != null ? 'none' : null;
        const lightningEffectEnabled = getPropagationPlaybackOptions().lightningEffect;
        const lightningPreviewActive =
            lightningEffectEnabled &&
            recursiveAttributionEnabled &&
            (lightningPreviewStartedAt != null || lightningTauAdjustPreview) &&
            propagationPlaybackPhase !== 'playing';
        const lightningBoundaryFrame =
            lightningEffectEnabled &&
            recursiveAttributionEnabled &&
            anim != null &&
            anim.direction === 'forward' &&
            anim.batchIndex === 0 &&
            !forwardPromptPreambleFrame &&
            propagationPlaybackPhase === 'playing';
        const boundaryFrameElapsedMs = lightningBoundaryFrame
            ? recursiveEdgeAnimation.getCurrentFrameElapsedMs()
            : 0;
        const lightningVisualActive =
            lightningPreviewActive ||
            (lightningBoundaryFrame &&
                boundaryFrameElapsedMs >= DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS);
        const lightningAnimationDwellMs = lightningBoundaryAnimationDwellMs(
            DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS,
            lightningEffectEnabled,
            getPropagationPlaybackOptions().lightningSlowMo,
        );
        const lightningSlowMoUi = getPropagationPlaybackOptions().lightningSlowMo;
        const lightningElapsedMs = lightningVisualActive
            ? lightningTauAdjustPreview
                ? 0
                : lightningBoundaryFrame
                ? boundaryFrameElapsedMs - DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS
                : Math.max(0, performance.now() - (lightningPreviewStartedAt ?? performance.now()))
            : 0;
        const lightningFadeProgress = lightningVisualActive
            ? lightningBoundaryFadeProgress(lightningElapsedMs, lightningSlowMoUi)
            : 0;
        const dagFlashOverlayOpacity =
            lightningVisualActive && !lightningTauAdjustPreview
                ? lightningDagFlashOverlayOpacity(lightningElapsedMs, lightningSlowMoUi)
                : 0;
        const lightningContentReveal = lightningVisualActive
            ? lightningContentRevealProgress(lightningElapsedMs, lightningSlowMoUi)
            : 1;
        /** 传播动画视觉态（含暂停 / 部分前沿帧）；与静态有焦点区分 fill 全亮规则（动画时另允 slide）。 */
        const propagationAnimVisualActive =
            anim != null &&
            focusId != null &&
            (propagationPlaybackPhase === 'playing' ||
                propagationPlaybackPhase === 'paused' ||
                animationFrontierPartial);
        /** 未 slide prompt（仅 forward）：静态与动画均 stay 达阈 fill 全亮；勾选时 fill 仅焦点 + slide。反向始终按不 slide 处理。 */
        const forwardSlideSharedNodes =
            anim?.direction === 'backward'
                ? false
                : propagationPlaybackPhase === 'playing' || propagationPlaybackPhase === 'paused'
                  ? (anim?.weightScope.forwardSlideSharedNodes ??
                     getPropagationPlaybackOptions().forwardSlideSharedNodes)
                  : getPropagationPlaybackOptions().forwardSlideSharedNodes;
        const highlightStayNodesFill = recursiveAttributionEnabled && !forwardSlideSharedNodes;
        const attentionLit =
            attentionHighlight != null ? new Set(attentionHighlight.litIds) : null;
        const activeQueryIds =
            attentionHighlight != null
                ? new Set(
                      attentionHighlight.queryTokenIds ??
                          (attentionHighlight.queryTokenId != null
                              ? [attentionHighlight.queryTokenId]
                              : []),
                  )
                : null;
        const kvEstablishedQueries =
            attentionHighlight?.kvEstablishedQueryIds != null
                ? new Set(attentionHighlight.kvEstablishedQueryIds)
                : null;
        const resolveNodeFillOpacity = (d: DagNode): number => {
            const lowVis = nodeLowVisReasonById.get(d.id) ?? null;
            const treatExcludedAsNormalInAttention =
                !hideExcludedTokens &&
                (attentionHighlight != null || lastTokenAppearanceDwellActive);
            let base: number;
            if (hideExcludedTokens && lowVis != null) {
                base = DagNodeOpacityLevel.hidden;
            } else if (
                !treatExcludedAsNormalInAttention &&
                isOffsetSpanFullyExcluded(d.start, d.end, dagExcludeIntervals)
            ) {
                base = DagNodeOpacityLevel.almostHidden;
            } else {
                const nodeFullyHighlighted = recursiveAttributionEnabled
                    ? forwardPromptPreambleFrame
                        ? nodeOnChainForRender(d)
                        : highlightStayNodesFill
                          ? (d.id === focusId && !deferFocusHighlightDuringAnim) ||
                            (nodeStrokeShareById?.has(d.id) ?? false) ||
                            isPropagationSlide(d)
                          : propagationAnimVisualActive
                            ? (d.id === focusId && !deferFocusHighlightDuringAnim) ||
                              isPropagationSlide(d)
                            : d.id === focusId
                    : (focusNodeIds?.has(d.id) ?? false);
                base = DagNodeOpacityLevel.full;
                if (!nodeFullyHighlighted) {
                    const hasGenTokens = nodes.some((n) => n.step >= 0);
                    const isPromptLeaf =
                        hasGenTokens && d.step === -1 && graph.outDegree(d.id) === 0;
                    if (focusId || isPromptLeaf) base = DagNodeOpacityLevel.weakened;
                }
                if (lowVis === 'inactive') {
                    base = DagNodeOpacityLevel.almostHidden;
                }
            }
            if (attentionHighlight == null) return base;
            if (activeQueryIds?.has(d.id) || attentionLit!.has(d.id)) {
                return DagNodeOpacityLevel.full;
            }
            return Math.min(base, DagNodeOpacityLevel.weakened);
        };
        const resolveNodeQueryHeat = (d: DagNode): string | null => {
            const queryHeat = attentionHighlight?.queryHeat;
            if (
                queryHeat == null ||
                !Number.isFinite(queryHeat) ||
                !activeQueryIds?.has(d.id)
            ) {
                return null;
            }
            return String(Math.min(1, Math.max(0, queryHeat)));
        };
        const showNodeSelectedStroke = (d: DagNode): boolean => {
            if (attentionHighlight != null) {
                if (kvEstablishedQueries?.has(d.id)) return true;
                return activeQueryIds?.has(d.id) ?? false;
            }
            return showFocusSelectedStroke(d);
        };
        const suppressAttributionChainNodeStyle = attentionHighlight != null;
        const layoutHover = layoutSelectHoverActive();
        // 实线悬停框：与 {@link solidFrameFocusId} / tooltip 同源，多选虚线态不下发
        const showFocusHover = (d: DagNode): boolean => {
            if (attentionHighlight != null || layoutHover) return false;
            return hoveredId === d.id;
        };
        const showLayoutHover = (d: DagNode): boolean => {
            if (attentionHighlight != null || !layoutHover) return false;
            return hoveredId === d.id || marqueePreviewIds.has(d.id);
        };
        nodeSel
            .classed('gen-attr-dag-node--hover', showFocusHover)
            .classed('gen-attr-dag-node--layout-hover', showLayoutHover)
            .classed('gen-attr-dag-node--selected', showNodeSelectedStroke)
            .classed('gen-attr-dag-node--layout-selected', (d) => layoutSelectedIds.has(d.id))
            .style('display', nodeDisplay)
            .style('opacity', null)
            .classed(
                'gen-attr-dag-node--recursive-chain',
                (d) =>
                    !suppressAttributionChainNodeStyle &&
                    (nodeOnChainForRender(d) || isBackwardSlide(d)),
            )
            .classed(
                'gen-attr-dag-node--backward-slide',
                (d) => !suppressAttributionChainNodeStyle && isBackwardSlide(d),
            )
            .style(CSS_VAR_DAG_NODE_RECURSIVE_SHARE, (d) => {
                if (suppressAttributionChainNodeStyle) return null;
                if (!nodeOnChainForRender(d) && !isBackwardSlide(d)) return null;
                const renderStrength = nodeStrokeRenderById?.get(d.id);
                return renderStrength != null ? String(renderStrength) : null;
            })
            .style(CSS_VAR_DAG_NODE_QUERY_HEAT, resolveNodeQueryHeat);
        nodeSel
            .select('rect.gen-attr-dag-node-fill')
            .attr('opacity', resolveNodeFillOpacity);
        nodeSel
            .select('text.gen-attr-dag-node-text')
            .attr('opacity', resolveNodeFillOpacity);
        nodeHitSel
            .classed('gen-attr-dag-node--hover', showFocusHover)
            .classed('gen-attr-dag-node--layout-hover', showLayoutHover)
            .classed('gen-attr-dag-node--selected', showNodeSelectedStroke)
            .classed('gen-attr-dag-node--layout-selected', (d) => layoutSelectedIds.has(d.id))
            .style('display', nodeDisplay);
        nodeG.style(
            'opacity',
            lightningVisualActive && lightningContentReveal < 1 ? String(lightningContentReveal) : null,
        );
        nodeGHit.style(
            'opacity',
            lightningVisualActive && lightningContentReveal < 1 ? String(lightningContentReveal) : null,
        );
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
            const isBluePropagationIncoming =
                linkFocusState != null &&
                linkFocusState.incomingEdgeShareByKey.has(edgeKey) &&
                backwardSlideIncomingRenderByKey?.get(edgeKey) == null;
            const isLightningArrow =
                lightningVisualActive && isBluePropagationIncoming && finalRenderStrength > 0;
            const strokeForRender =
                isLightningArrow
                    ? lightningDecayStrokeCss(
                          lightningFadeProgress,
                          CSS_VAR_DAG_LIGHTNING_LINE_COLOR,
                          CSS_VAR_DAG_HIGHLIGHT_LINE_IN,
                      )
                    : stroke;
            const opacityForRender = isLightningArrow
                ? lightningDecayOpacity(
                      lightningEdgeRenderOpacity(
                          finalRenderStrength,
                          getPropagationPlaybackOptions().lightningThresholdTau,
                      ),
                      finalRenderStrength,
                      lightningFadeProgress,
                  )
                : finalRenderStrength * lightningContentReveal;
            const edgeOpacityForRender =
                hideArrowsDuringAttention && dagPlaybackPlaying ? 0 : opacityForRender;
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
            g.select('path.gen-attr-dag-link-visible').attr('stroke', strokeForRender).attr('stroke-opacity', edgeOpacityForRender);
            linkMarkersDefs
                .select<SVGPathElement>(`#${dagLinkMarkerElementId(d.source, d.target)} path`)
                .attr('stroke', strokeForRender)
                .attr('stroke-opacity', edgeOpacityForRender);

            const incident =
                linkFocusState != null &&
                (linkFocusState.incomingEdgeShareByKey.has(edgeKey) ||
                    (includeDownstreamInfluence &&
                        (focusState?.downstreamEdgeStrengthByKey.has(edgeKey) ?? false)));
            const parent = incident ? linkGFront : linkG;
            const parentNode = parent.node()!;
            if (this.parentNode !== parentNode) {
                parentNode.appendChild(this as SVGGElement);
            }
        });

        syncLayoutForLowVisibilityMembership(focusId, focusState);

        // matrix：唯一上色入口；须在 layout sync（可能 rebuild 几何）之后。
        if (layoutMode === 'attribution-matrix') {
            const propagationShared: MatrixPropagationHighlightShared | null =
                matrixPropagationHighlightActive() &&
                focusId != null &&
                focusId === userFocusId &&
                focusState != null
                    ? {
                          focusId,
                          focusState,
                          animOverlay,
                          incomingHighlightRenderByKey,
                          backwardSlideIncomingRenderByKey,
                          propagationSlideTgtId,
                      }
                    : null;
            refreshMatrixHighlight(propagationShared);
        }

        syncGenAttrDagTopkTooltipImpl();

        if (dagFlashOverlayOpacity > 0) {
            lightningFlashOverlay.style('display', null).style('opacity', String(dagFlashOverlayOpacity));
        } else {
            lightningFlashOverlay.style('display', 'none').style('opacity', '0');
        }

        const boundaryFrameLightningPending =
            lightningBoundaryFrame &&
            boundaryFrameElapsedMs < DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS;
        if (
            boundaryFrameLightningPending ||
            (lightningVisualActive &&
                !lightningTauAdjustPreview &&
                (lightningFadeProgress < 1 ||
                    dagFlashOverlayOpacity > 0 ||
                    lightningContentReveal < 1) &&
                lightningElapsedMs < lightningAnimationDwellMs)
        ) {
            if (lightningFadeRaf == null) {
                lightningFadeRaf = requestAnimationFrame(() => {
                    lightningFadeRaf = null;
                    refreshNodeLinkHighlight();
                });
            }
        } else {
            cancelLightningFadeRaf();
            if (lightningPreviewActive && lightningElapsedMs >= lightningAnimationDwellMs) {
                lightningPreviewStartedAt = null;
            }
        }

        syncLightningSound({
            propagationPlaybackPhase,
            lightningEffectEnabled,
            lightningSoundEnabled: getPropagationPlaybackOptions().lightningSound,
            lightningPreviewActive,
            boundaryFrameElapsedMs,
            anim: animOverlay.anim,
            forwardPromptPreambleFrame: animOverlay.forwardPromptPreambleFrame,
        });
    }

    syncGenAttrDagTopkTooltipImpl = (): void => {
        if (!showTokenInfoOnSelected) {
            dagTopkToolTip.hideAndReset();
            return;
        }

        // matrix 格 = 边：HUD 展示与 text 边 `<title>` 同源的指标（非节点 Top‑K）。
        const matrixTarget =
            layoutMode === 'attribution-matrix' ? (matrixHoverTarget ?? matrixLockedTarget) : null;
        if (matrixTarget?.type === 'cell') {
            const { srcId, tgtId } = matrixTarget;
            if (!graph.hasNode(srcId) || !graph.hasNode(tgtId)) {
                dagTopkToolTip.hideAndReset();
                return;
            }
            const link = (incomingLinksByTarget.get(tgtId) ?? []).find((l) => l.source === srcId);
            if (link == null) {
                dagTopkToolTip.hideAndReset();
                return;
            }
            const rect = matrixCellTooltipAnchorRect(srcId, tgtId);
            if (!rect) {
                dagTopkToolTip.hideAndReset();
                return;
            }
            const src = graph.getNodeAttributes(srcId) as DagNode;
            const tgt = graph.getNodeAttributes(tgtId) as DagNode;
            const edgeKey = dagLinkEndpointKey(srcId, tgtId);
            const { linkStrength, recursiveAttributionShare } = resolveDagLinkTooltipStrengths(
                link,
                edgeKey,
                currentLinkFocusState,
                recursiveAttributionEnabled,
            );
            const snapshot: DagLinkTitleSnapshot = {
                normalizedScore: link.normalizedScore,
                mutualInformationRatio: link.mutualInformationRatio,
                attributionShare: link.attributionShare,
                alignmentNote: link.alignmentNote,
                src,
                tgt,
                recursiveAttributionShare,
                linkStrength,
            };
            const { staticRows, dynamicRows, alignmentNote } = buildLinkTitleMetricRows(snapshot);
            const rowsBeforeInfo: NonNullable<ToolTipUpdateAugment['rowsBeforeInfo']> = [...staticRows];
            if (alignmentNote) {
                rowsBeforeInfo.push({ label: alignmentNote, value: '', valueColor: false });
            }
            rowsBeforeInfo.push(...dynamicRows);
            dagTopkToolTip.updateData(
                {
                    tokenData: {
                        raw: src.label,
                        offset: [src.start, src.end],
                        pred_topk: [],
                    },
                },
                rect,
                {
                    headerLines: [src.label, '↓', tgt.label],
                    rowsBeforeInfo,
                },
            );
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
        const rect =
            (matrixTarget != null
                ? matrixTooltipAnchorRect(focusIdNext, matrixTarget)
                : null) ??
            nodeSel
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

        // 归因份额行：仅实线悬停（或反向播放锚点）时展示；虚线多选悬停不计入
        const rowsBeforeInfo: ToolTipUpdateAugment['rowsBeforeInfo'] = [];
        const shareSourceId =
            propagationPlaybackTooltip?.direction === 'backward'
                ? focusIdNext
                : layoutMode === 'attribution-matrix'
                  ? matrixShareSourceId()
                  : hoveredId != null && solidFrameFocusId() === hoveredId
                    ? hoveredId
                    : null;
        if (
            selectedId &&
            shareSourceId &&
            currentFocusState &&
            shareSourceId !== selectedId &&
            graph.hasNode(selectedId) &&
            graph.hasNode(shareSourceId)
        ) {
            // 链内链外均显示份额；低于 {@link DAG_MIN_ATTRIBUTION_SHARE} 时 format 为 "< x%"
            const share = currentFocusState.nodeShareById.get(shareSourceId) ?? 0;
            if (recursiveAttributionEnabled) {
                const shareNode = graph.getNodeAttributes(shareSourceId) as DagNode;
                const stay = share * (1 - nodeUpstreamPropagationRatio(shareNode, incomingLinksByTarget, dagDecayAttributionToHighSurprisalTargetEnabled));
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
        clearLayoutSelectionOnly();
        selectedId = id;
        refreshNodeLinkHighlight();
        syncDagPlayButtonImpl();
    }

    function clearNodeSelection(): void {
        layoutSelectedIds = new Set();
        selectedId = null;
        userFocusId = null;
        matrixLockedTarget = null;
        matrixHoverTarget = null;
        recursiveEdgeAnimation.stopPlayback();
        refreshNodeLinkHighlight();
        syncDagPlayButtonImpl();
        notifyUserFocusChange();
    }

    function setUserFocusNodeId(id: string | null): void {
        if (id == null) {
            clearNodeSelection();
            return;
        }
        if (!graph.hasNode(id)) {
            throw new Error(`genAttributeDagView: unknown node id ${id}`);
        }
        layoutSelectedIds = new Set();
        userFocusId = id;
        selectedId = id;
        matrixHoverTarget = null;
        syncMatrixRowLockWithUserFocus();
        recursiveEdgeAnimation.stopPlayback();
        refreshNodeLinkHighlight();
        syncDagPlayButtonImpl();
        notifyUserFocusChange();
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
            })
            .classed('gen-attr-dag-link--synthetic', (d) => d.synthetic === true);
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
                g.append('rect').attr('class', 'gen-attr-dag-node-layout-sel');
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
        allInputSpans = normalizePromptTokenSpans(allInputSpans);
        const inputRanges = opts?.inputRanges ?? [[0, layoutWire.length] as [number, number]];
        dagInputRanges = inputRanges;
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
                x: g.x,
                y: g.y,
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
        // tool_response 节点（inputRanges[k], k>=1）建合成入边（N×M），均匀指向对应 tool_call 节点。
        // 图数据供传播拓扑；稳态灰边 opacity 为 0（见 perTargetIncomingEdgeShare / tool_response 传导系数）。
        // exclude 在建边时定稿：仅连未 exclude 的 tool_call（见模块顶注释「Exclude 原则」）。
        // 仅处理本次新增节点，避免重复建边。
        if (addedNodes.length > 0) {
            const addedIds = new Set(addedNodes.map((n) => n.id));
            addSyntheticEdgesForInputRanges(inputRanges, (n) => addedIds.has(n.id));
        }
        // prompt 节点 step=-1 始终排在末尾；可多次调用（已有节点跳过）。
        nodesSortedByStepDesc = [...nodes].sort((a, b) => b.step - a.step || b.start - a.start);
        if (batchDepth === 0) syncGraphToSvg();
    }

    /** 将当前 `nodes` 映射为对齐层所需的最小区间信息（按插入序，align 内部会再按 start 排序）。 */
    function nodeIntervalsForAlign(): NodeInterval[] {
        return nodes.map((n) => ({ id: n.id, start: n.start, end: n.end, label: n.label }));
    }

    /** 清空边集（保留节点与几何）；供 {@link rebuildEdges} 使用。 */
    function clearAllEdges(): void {
        graph.clearEdges();
        links = [];
        incomingLinksByTarget.clear();
        grayRenderCache = null;
    }

    /**
     * 为已有 target 节点按当前 exclude / Top-P / decay 建归因入边。
     * `alignStep` 仅用于对齐告警；须与节点 `step` 一致。
     */
    function addAttributionIncomingEdges(
        step: TokenGenStep,
        targetId: string,
        targetStart: number,
        targetEnd: number,
        alignStep: number,
        excludeIntervalContext: string | undefined,
        excludeIntervals: [number, number][],
    ): void {
        const { token, response } = step;
        if (isOffsetSpanFullyExcluded(targetStart, targetEnd, excludeIntervals)) return;
        const pieces: PieceEntry[] = (response.token_attribution ?? []).map((t) => ({
            offset: t.offset as [number, number],
            raw: t.raw,
            score: t.score,
        }));
        const aggregated = alignAndAggregateByNode(pieces, nodeIntervalsForAlign(), {
            step: alignStep,
            targetToken: token,
            ...(dagDeleteIntervals.length > 0
                ? { skipWarnIfFullyInIntervals: dagDeleteIntervals }
                : {}),
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
                (dagDecayAttributionToHighSurprisalTargetEnabled ? mutualInformationRatio : 1) *
                normalizedScore;
            return edgeVisibility >= DAG_EDGE_MIN_NORMALIZED_SCORE;
        });
        const massSum = selectedForDisplay.reduce((acc, t) => acc + Math.max(0, t.poolMassFrac), 0);
        const linksForTarget: DagLink[] = [];
        for (const item of selectedForDisplay) {
            const srcId = item.nodeId;
            if (!graph.hasNode(srcId)) {
                throw new Error(
                    `genAttributeDagView: attribution nodeId ${srcId} has no graph node at alignStep=${alignStep} (align/DAG out of sync)`
                );
            }
            const share = massSum > 0 ? item.poolMassFrac / massSum : undefined;
            const alignmentNote =
                item.alignmentTooltipLines && item.alignmentTooltipLines.length > 0
                    ? item.alignmentTooltipLines.join('\n\n')
                    : undefined;
            if (graph.hasEdge(srcId, targetId)) {
                throw new Error(
                    `genAttributeDagView: unexpected duplicate edge ${srcId} -> ${targetId} at alignStep=${alignStep} (duplicate nodeId in selected or repeat update?)`
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
    }

    /** 按 inputRanges 为 tool_response 节点建合成入边（`trNodeFilter` 限制候选，增量时仅新增节点）。 */
    function addSyntheticEdgesForInputRanges(
        inputRanges: CharRange[],
        trNodeFilter: (n: DagNode) => boolean,
    ): void {
        if (inputRanges.length <= 1) return;
        for (let k = 1; k < inputRanges.length; k++) {
            const [trStart, trEnd] = inputRanges[k]!;
            const [, prevEnd] = inputRanges[k - 1]!;
            const tcStart = prevEnd;
            const tcEnd = trStart;
            const trNodes = nodes.filter(
                (n) =>
                    n.step < 0 &&
                    n.start >= trStart &&
                    n.end <= trEnd &&
                    trNodeFilter(n),
            );
            if (trNodes.length === 0) continue;
            const tcNodes = nodes.filter(
                (n) => n.step >= 0 && n.start >= tcStart && n.end <= tcEnd,
            );
            if (tcNodes.length === 0) {
                throw new Error(
                    `genAttributeDagView: tool_response input [${trStart}, ${trEnd}) added before tool_call nodes exist in [${tcStart}, ${tcEnd}); check setPromptTokenSpans vs update() ordering`,
                );
            }
            const activeTcNodes =
                dagExcludeIntervals.length === 0
                    ? tcNodes
                    : tcNodes.filter(
                          (n) => !isOffsetSpanFullyExcluded(n.start, n.end, dagExcludeIntervals),
                      );
            if (activeTcNodes.length === 0) continue;
            const share = 1 / activeTcNodes.length;
            for (const trNode of trNodes) {
                const syntheticLinks: DagLink[] = [];
                for (const tcNode of activeTcNodes) {
                    if (graph.hasEdge(tcNode.id, trNode.id)) continue;
                    const edgeAttrs = {
                        normalizedScore: share,
                        attributionShare: share,
                        mutualInformationRatio: 1,
                    };
                    graph.addEdge(tcNode.id, trNode.id, edgeAttrs);
                    syntheticLinks.push({
                        source: tcNode.id,
                        target: trNode.id,
                        synthetic: true,
                        ...edgeAttrs,
                    });
                }
                if (syntheticLinks.length > 0) {
                    links.push(...syntheticLinks);
                    incomingLinksByTarget.set(trNode.id, syntheticLinks);
                    grayRenderCache = null;
                }
            }
        }
    }

    function update(step: TokenGenStep, excludeIntervalContext?: string): void {
        const { context, token, response } = step;
        if (!response.token_attribution || !token) return;

        dagInputRanges = step.inputRanges;
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
            x: g.x,
            y: g.y,
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

        const excludeIntervals = collectGenAttrDagExcludeIntervals(
            intervalCtx,
            step.inputRanges,
            getEffectiveExcludePromptPatternsText(),
            getEffectiveExcludeGeneratedPatternsText(),
        );
        dagExcludeIntervals = excludeIntervals;

        // align → exclude → rank → 建边（exclude 一次定稿，见模块顶注释「Exclude 原则」）。
        addAttributionIncomingEdges(
            step,
            targetId,
            targetStart,
            targetEnd,
            stepProcessed,
            excludeIntervalContext,
            excludeIntervals,
        );

        stepProcessed++;
        // 每步生成后：默认选中本步新生成的 token；无其它选中时悬浮仍可临时预览
        layoutSelectedIds = new Set();
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

    /**
     * 仅重建边集：保留节点（含拖拽 x/y）、layoutDirty / userDraggedNodes、选中与视口。
     * 调用前须已更新 edgeTopPCoverage / exclude 生效全文等。
     */
    function rebuildEdges(steps: readonly TokenGenStep[], excludeIntervalContext: string): void {
        recursiveEdgeAnimation.stopPlayback();
        if (nodes.length === 0 || steps.length === 0) return;

        clearAllEdges();
        clearGenAttributeDagAlignmentWarnDedupe();

        const last = steps[steps.length - 1]!;
        dagInputRanges = last.inputRanges;
        dagExcludeIntervals = collectGenAttrDagExcludeIntervals(
            excludeIntervalContext,
            last.inputRanges,
            getEffectiveExcludePromptPatternsText(),
            getEffectiveExcludeGeneratedPatternsText(),
        );
        addSyntheticEdgesForInputRanges(last.inputRanges, () => true);

        for (let i = 0; i < steps.length; i++) {
            const step = steps[i]!;
            const { context, token, response } = step;
            if (!response.token_attribution || !token) continue;
            const targetStart = context.length;
            const targetEnd = context.length + token.length;
            const targetId = `${targetStart}_${targetEnd}`;
            if (!graph.hasNode(targetId)) {
                throw new Error(
                    `genAttributeDagView: rebuildEdges missing target node ${targetId} at step=${i}`
                );
            }
            const targetNode = graph.getNodeAttributes(targetId) as DagNode;
            const stepExcludeIntervals = collectGenAttrDagExcludeIntervals(
                excludeIntervalContext,
                step.inputRanges,
                getEffectiveExcludePromptPatternsText(),
                getEffectiveExcludeGeneratedPatternsText(),
            );
            addAttributionIncomingEdges(
                step,
                targetId,
                targetStart,
                targetEnd,
                targetNode.step,
                excludeIntervalContext,
                stepExcludeIntervals,
            );
        }

        // 节点 opacity / hide 用全量上下文的 exclude 区间
        dagExcludeIntervals = collectGenAttrDagExcludeIntervals(
            excludeIntervalContext,
            last.inputRanges,
            getEffectiveExcludePromptPatternsText(),
            getEffectiveExcludeGeneratedPatternsText(),
        );
        invalidateLayoutIncludedNodeIdsKey();
        if (batchDepth === 0) syncGraphToSvg();
    }

    function reset(preserveUserViewport: boolean = false): void {
        const wasLayoutDirty = layoutDirty;
        const wasUserDraggedNodes = userDraggedNodes;
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
        layoutSelectedIds = new Set();
        hoveredId = null;
        matrixHoverTarget = null;
        matrixLockedTarget = null;
        attentionHighlight = null;
        lastTokenAppearanceDwellActive = false;
        dagTopkToolTip.hideAndReset();
        linkMarkersDefs.selectAll('marker').remove();
        linkG.selectAll('*').remove();
        linkGFront.selectAll('*').remove();
        nodeG.selectAll('*').remove();
        nodeGHit.selectAll('*').remove();
        disposeMatrixPointerHit();
        matrixG.selectAll('*').remove();
        matrixFirstSourceAnchor = null;
        dagExcludeIntervals = [];
        dagDeleteIntervals = [];
        dagInputRanges = [];
        layoutIncludedNodeIdsKey = LAYOUT_INCLUDED_ALL_KEY;
        linkSel = rootG
            .selectAll<SVGGElement, DagLink>('g.gen-attr-dag-link')
            .data<DagLink>([], dagLinkDataKey);
        nodeSel = nodeG.selectAll<SVGGElement, DagNode>('g.gen-attr-dag-node').data<DagNode>([], (d) => d.id);
        nodeHitSel = nodeGHit
            .selectAll<SVGGElement, DagNode>('g.gen-attr-dag-node-hit')
            .data<DagNode>([], (d) => d.id);
        layoutDirty = preserveUserViewport ? wasLayoutDirty : false;
        userDraggedNodes = preserveUserViewport ? wasUserDraggedNodes : false;
        syncDagPlayButtonImpl();
        notifyUserFocusChange();
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
            } else if (layoutMode === 'text-flow' || layoutMode === 'attribution-matrix') {
                /** `rootG` 整包 bbox + 宽高双约束顶对齐（矩阵与 text-flow 相同） */
                const padTf = DAG_TEXT_FLOW_FIT_PAD_PX;
                const innerWTextFlow = Math.max(w - 2 * padTf, 1);
                const innerHTextFlow = Math.max(h - 2 * padTf, 1);
                const b =
                    layoutMode === 'attribution-matrix'
                        ? matrixG.node()!.getBBox()
                        : rootG.node()!.getBBox();
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
            const kind: DagPlayCoachmarkKind =
                userFocusId != null && recursiveAttributionEnabled ? 'propagation' : 'step';
            dismissDagPlayCoachmark(kind);
            if (userFocusId != null) {
                togglePropagationPlayback();
                return;
            }
            if (!onDagPlaybackToggle) return;
            onDagPlaybackToggle(!dagPlaybackPlaying);
        });

    const playCoachmark = resultsRoot
        .append('div')
        .attr('class', 'gen-attr-dag-play-coachmark')
        .attr('role', 'status');
    playCoachmark.property('hidden', true);
    playCoachmark.append('div').attr('class', 'gen-attr-dag-play-coachmark-arrow').attr('aria-hidden', 'true');
    const playCoachmarkBody = playCoachmark
        .append('div')
        .attr('class', 'gen-attr-dag-play-coachmark-body');
    playCoachmarkBody
        .append('span')
        .attr('class', 'gen-attr-dag-play-coachmark-text')
        .text('Click to play');
    playCoachmarkBody
        .append('button')
        .attr('type', 'button')
        .attr('class', 'gen-attr-dag-play-coachmark-dismiss')
        .text('Got it')
        .on('click', (event) => {
            event.stopPropagation();
            const raw = playCoachmark.attr('data-kind');
            if (raw === 'step' || raw === 'propagation') {
                dismissDagPlayCoachmark(raw);
            } else {
                hideDagPlayCoachmark();
            }
        });

    let playCoachmarkKindShown: DagPlayCoachmarkKind | null = null;

    function hideDagPlayCoachmark(): void {
        playCoachmark.property('hidden', true).attr('data-kind', null);
        playCoachmarkKindShown = null;
    }

    function dismissDagPlayCoachmark(kind: DagPlayCoachmarkKind): void {
        markDagPlayCoachmarkSeen(kind);
        hideDagPlayCoachmark();
    }

    function syncDagPlayCoachmark(playing: boolean, disabled: boolean, propagationPlayUi: boolean): void {
        if (!onDagPlaybackToggle) {
            hideDagPlayCoachmark();
            return;
        }
        const kind: DagPlayCoachmarkKind = propagationPlayUi ? 'propagation' : 'step';
        if (playing || disabled || isDagPlayCoachmarkSeen(kind)) {
            if (playCoachmarkKindShown != null) hideDagPlayCoachmark();
            return;
        }
        if (playCoachmarkKindShown === kind) return;
        playCoachmark.attr('data-kind', kind).property('hidden', false);
        playCoachmarkKindShown = kind;
    }

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
        // ▶ / ↯ 可点且未在播：固定强调色（见 CSS gen-attr-dag-play--propagation-hint）
        playBtn.classed('gen-attr-dag-play--propagation-hint', !playing && !disabled);
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
        syncDagPlayCoachmark(playing, disabled, propagationPlayUi);
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
        const wasPlaying = dagPlaybackPlaying;
        dagPlaybackPlaying = playing;
        if (!playing) {
            lastTokenAppearanceDwellActive = false;
            if (wasPlaying || attentionHighlight != null) {
                attentionHighlight = null;
            }
        }
        if (playing !== wasPlaying) {
            refreshNodeLinkHighlight();
        }
        syncDagPlayButton();
    }

    function setAttentionPlaybackHighlight(state: AttentionPlaybackHighlight): void {
        attentionHighlight = state;
        refreshNodeLinkHighlight();
    }

    function setLastTokenAppearanceDwellActive(active: boolean): void {
        if (lastTokenAppearanceDwellActive === active) return;
        lastTokenAppearanceDwellActive = active;
        refreshNodeLinkHighlight();
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
        matrixPinSteady = null;
        matrixPinFollowActive = false;
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

    function setHideArrowsDuringAttention(hide: boolean): void {
        if (hideArrowsDuringAttention === hide) return;
        hideArrowsDuringAttention = hide;
        if (batchDepth > 0 || nodes.length === 0) return;
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

    /** attribution-matrix 轴/方向选项变更后：清 pin、重绘并 fit。 */
    function afterMatrixAxisOptionChange(): void {
        matrixPinSteady = null;
        matrixPinFollowActive = false;
        if (batchDepth > 0 || layoutMode !== 'attribution-matrix') return;
        paint();
        refreshNodeLinkHighlight();
        fitViewportToContent(true);
    }

    /** attribution-matrix 对称布局：切换后立即重绘。 */
    function setMatrixTranspose(transpose: boolean): void {
        if (matrixTranspose === transpose) return;
        matrixTranspose = transpose;
        afterMatrixAxisOptionChange();
    }

    function setMatrixSwitchHorizontalLabel(on: boolean): void {
        if (matrixSwitchHorizontalLabel === on) return;
        matrixSwitchHorizontalLabel = on;
        afterMatrixAxisOptionChange();
    }

    function setMatrixSwitchVerticalLabel(on: boolean): void {
        if (matrixSwitchVerticalLabel === on) return;
        matrixSwitchVerticalLabel = on;
        afterMatrixAxisOptionChange();
    }

    /** attribution-matrix：播放时钉住第一个语义 source token（稳态取自点击 ▶ 时的屏幕位置）。 */
    function setMatrixPinSourceTokens(pin: boolean): void {
        if (matrixPinSourceTokens === pin) return;
        matrixPinSourceTokens = pin;
        if (!pin) {
            matrixPinSteady = null;
            matrixPinFollowActive = false;
        }
    }

    /** 从当前视口捕获 pin 稳态（点击 ▶、裁前缀 / `reset` 之前；含用户已拖到的位置）。 */
    function captureMatrixPinSteady(): void {
        if (layoutMode !== 'attribution-matrix') {
            matrixPinSteady = null;
            matrixPinFollowActive = false;
            return;
        }
        // 锚点可能尚未写入（仅 restyle / 切回布局）：补一次 paint。
        if (matrixFirstSourceAnchor == null && nodes.length > 0) {
            paint();
        }
        if (matrixFirstSourceAnchor == null) {
            matrixPinSteady = null;
            matrixPinFollowActive = false;
            return;
        }
        const t = d3.zoomTransform(svg.node()!);
        const { x: ax, y: ay } = matrixFirstSourceAnchor;
        matrixPinSteady = { x: t.x + t.k * ax, y: t.y + t.k * ay };
        matrixPinFollowActive = true;
    }

    function clearMatrixPinSteady(): void {
        matrixPinSteady = null;
        matrixPinFollowActive = false;
    }

    /**
     * 平移视口使当前第一个 source 锚点对齐 pin 稳态屏幕位置（保持当前 k）。
     * 不看 `layoutDirty`：播放前拖拽后仍钉在捕获位置；播放中用户再改视口则 `matrixPinFollowActive` 为 false。
     */
    function syncMatrixPinViewport(): void {
        if (
            layoutMode !== 'attribution-matrix' ||
            !matrixPinSourceTokens ||
            !matrixPinFollowActive ||
            matrixPinSteady == null ||
            matrixFirstSourceAnchor == null
        ) {
            return;
        }
        const { x: ax, y: ay } = matrixFirstSourceAnchor;
        const k = d3.zoomTransform(svg.node()!).k;
        const tx = matrixPinSteady.x - k * ax;
        const ty = matrixPinSteady.y - k * ay;
        svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
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
        if (marqueeSession) {
            window.removeEventListener('mousemove', onMarqueeMouseMove);
            window.removeEventListener('mouseup', onMarqueeMouseUp);
            marqueeSession.rect.remove();
            marqueeSession = null;
            marqueePreviewIds = new Set();
        }
        window.removeEventListener('keydown', onMultiSelectModifierKeyDown);
        window.removeEventListener('keyup', onMultiSelectModifierKeyUp);
        window.removeEventListener('blur', onMultiSelectModifierBlur);
        cancelLightningEffectPreview();
        cancelLightningFadeRaf();
        lightningSound.dispose();
        recursiveEdgeAnimation.dispose();
        detachDagPseudoFullscreenIfPresent(rootEl);
        ro.disconnect();
        document.removeEventListener('fullscreenchange', refreshFullscreenChrome);
        document.removeEventListener(CSS_PSEUDO_FULLSCREEN_CHANGE_EVENT, refreshFullscreenChrome);
        dagTopkToolTip.dispose();
        resultsRoot
            .selectAll(
                '.gen-attr-dag-stack, .gen-attr-dag-topk-tooltip, button.gen-attr-dag-refresh, button.gen-attr-dag-play, button.gen-attr-dag-fullscreen, .gen-attr-dag-play-coachmark'
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
        rebuildEdges,
        setHideExcludedTokens,
        setHideArrowsDuringAttention,
        setDimInactiveTokens,
        setDimInactiveTokensThreshold,
        setDimInactiveNotDuringAnimation,
        setShowTokenInfoOnSelected,
        setRecursiveAttributionEnabled,
        setMatrixTranspose,
        setMatrixSwitchHorizontalLabel,
        setMatrixSwitchVerticalLabel,
        setMatrixPinSourceTokens,
        captureMatrixPinSteady,
        clearMatrixPinSteady,
        syncMatrixPinViewport,
        setRecursiveEdgeBatchAnimationDirection,
        refreshNodeLinkHighlight,
        setAttentionPlaybackHighlight,
        setLastTokenAppearanceDwellActive,
        playLightningEffectPreview,
        cancelLightningEffectPreview,
        enterLightningTauPreview,
        exitLightningTauPreview,
        isPropagationPlaybackEngaged,
        stopPropagationPlayback,
        setShowDownstreamInfluence,
        hasPromptSpans: () => nodes.some((n) => n.step === -1),
        detach,
    };
}
