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
    type PromptTokenSpan,
} from './genAttributeDagPreprocess';
import type { CharRange, TokenGenStep } from './tokenGenAttributionRunner';
import type { AttentionPlaybackHighlight } from './runAttentionPlayback';
import {
    DAG_LIGHTNING_SLOW_MO_DEFAULT,
    DAG_LIGHTNING_THRESHOLD_TAU_DEFAULT,
} from './genAttributeDagEdgeRenderStrength';
import { createDagLightningSoundController } from './genAttributeDagLightningSound';
import { DAG_CAUSAL_FLOW_ICON } from './genAttributeDagIcons';
import { lsReadBool, lsWriteBool } from '../../storage/localStorageHelpers';
import {
    createDagRecursiveEdgeAnimationController,
    DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS,
    type DagRecursiveEdgeReplayPacing,
    type DagFocusAttributionState,
    type DagPropagationPlaybackOptions,
    type DagPropagationPlaybackPhase,
    type DagRecursiveEdgeAnimationDirection,
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
import {
    createDagFocusSession,
    type MatrixInteractionTarget,
} from './genAttributeDagFocusSession';
import {
    createDagHighlightReconciler,
    type DagHighlightReconciler,
} from './genAttributeDagHighlightReconciler';
import {
    computeSteadyStateStayShareById,
    createMatrixInteractionHandlers,
} from './genAttributeDagMatrixLayout';
import {
    addAttributionIncomingEdges as addAttributionIncomingEdgesToGraph,
    addSyntheticEdgesForInputRanges as addSyntheticEdgesForInputRangesToGraph,
    clearDagGraphEdges,
} from './genAttributeDagGraphEdges';
import {
    CSS_VAR_DAG_NORMAL_LINE_COLOR,
    dagLinkEndpointKey,
    edgeAttributionShare,
    resolveDagLinkTooltipStrengths,
} from './genAttributeDagLinkHighlight';
import {
    buildLinkTitleMetricRows,
    formatAttributionSharePercentForTooltip,
    type DagLinkTitleSnapshot,
} from './genAttributeDagLinkTooltip';
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
    clearGenAttributeDagAlignmentWarnDedupe,
    type NodeInterval,
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
    type DagNodeLayoutPose,
} from './genAttributeDagViewTextFlowMode';
import { paintSpiralLayout } from './genAttributeDagViewSpiralMode';
import {
    MATRIX_CELL_SIZE,
    disposeMatrixPointerHit,
    paintAttributionMatrixLayout,
    matrixRowElementKey,
    matrixColElementKey,
} from './genAttributeDagViewMatrixMode';
import { computeFitZoomTransform } from './genAttributeDagFitZoom';
import {
    annotateLayoutTransitionFlyRoles,
    flyArrowMarkerLayout,
    flyArrowTracksPoseHeight,
    flyArrowTransform,
    flyArrowTwistFromAngles,
    flyPoseTransform,
    buildEdgeCellFlyPairs,
    buildEdgeEdgeFlyPairs,
    buildLayoutTransitionPairs,
    dagLayoutEdgeTransitionKind,
    cellFlyPoseFromRect,
    dagLayoutNodeKey,
    DAG_LAYOUT_FLY_DEFAULT_COLOR,
    DAG_LAYOUT_TRANSITION_FLY_MAX,
    DAG_LAYOUT_TRANSITION_MS,
    edgeFlyPoseFromPathTangent,
    flySyntheticDashPair,
    isSteadyPainted,
    layoutTransitionFlyCombinedOpacity,
    lerp,
    lerpFlyPose,
    lerpPose,
    parsePoseFromTransform,
    poseToTransform,
    readSteadyPaintOpacity,
    remapFlyPosesAcrossZoom,
    remapPosesAcrossZoom,
    runLayoutTransitionClock,
    type DagLayoutFlyPose,
    type DagLayoutElementKind,
    type DagLayoutTransitionCardinality,
    type SteadyPaintKind,
} from './genAttributeDagLayoutTransition';
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

/** 节点布局模式：`text-flow` 按文字排版层几何；`linear-arc` / `linear-arc-step-down` 为线性序 + 弧线连边（后者按 CI 逐级下移）；`spiral` 螺旋排布；`attribution-matrix` 归因强度热力图（attention-matrix 式）；`text-matrix` 为 text 与 matrix 并排（状态联动；方向见 {@link TextMatrixOrientation}）。 */
export type DagLayoutMode =
    | 'text-flow'
    | 'linear-arc'
    | 'linear-arc-step-down'
    | 'spiral'
    | 'attribution-matrix'
    | 'text-matrix';
/** text-matrix：并排方向（左右 / 上下）。 */
export type TextMatrixOrientation = 'horizontal' | 'vertical';
function isLinearArcFamilyLayout(mode: DagLayoutMode): mode is 'linear-arc' | 'linear-arc-step-down' {
    return mode === 'linear-arc' || mode === 'linear-arc-step-down';
}
export function isTextMatrixLayout(mode: DagLayoutMode): boolean {
    return mode === 'text-matrix';
}
function layoutShowsGraph(mode: DagLayoutMode): boolean {
    return mode !== 'attribution-matrix';
}
function layoutShowsMatrix(mode: DagLayoutMode): boolean {
    return mode === 'attribution-matrix' || isTextMatrixLayout(mode);
}
function layoutAllowsNodeDrag(mode: DagLayoutMode): boolean {
    return mode === 'text-flow' || isTextMatrixLayout(mode);
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
/** linear-arc / linear-arc-step-down：同上 */
const DAG_INITIAL_ZOOM_BOOST_LINEAR_ARC = 4;
/** spiral：同上 */
const DAG_INITIAL_ZOOM_BOOST_SPIRAL = 2;
/** attribution-matrix：同上 */
const DAG_INITIAL_ZOOM_BOOST_ATTRIBUTION_MATRIX = 2;

function dagInitialZoomBoost(mode: DagLayoutMode): number {
    switch (mode) {
        case 'text-flow':
        case 'text-matrix':
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
     * - `text-flow`：`rootG.getBBox()`（含边）等比落入内框；四边对称各 24px（见 `DAG_TEXT_FLOW_FIT_PAD_PX`）。
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
    /** 是否在切换 layout 时播放转场；关闭则瞬切。 */
    setLayoutTransitionEnabled(enabled: boolean): void;
    /** layout 转场时长（毫秒）；≤0 视为瞬切。 */
    setLayoutTransitionDurationMs(ms: number): void;
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
     * - `false`（默认）：保留为「几乎隐藏」（opacity 约 0.1）占位。
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
    /** text-matrix：并排方向（左右 / 上下）。 */
    setTextMatrixOrientation(orientation: TextMatrixOrientation): void;
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
    /** text-matrix 并排方向；默认 `horizontal`。 */
    textMatrixOrientation?: TextMatrixOrientation;
    /** 切换 layout 时是否播放转场；默认 `true`。 */
    layoutTransitionEnabled?: boolean;
    /** layout 转场时长（ms）；默认 {@link DAG_LAYOUT_TRANSITION_MS}。 */
    layoutTransitionDurationMs?: number;
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
    let layoutTransitionEnabled = options?.layoutTransitionEnabled ?? true;
    let layoutTransitionDurationMs =
        options?.layoutTransitionDurationMs !== undefined &&
        Number.isFinite(options.layoutTransitionDurationMs)
            ? Math.max(0, options.layoutTransitionDurationMs)
            : DAG_LAYOUT_TRANSITION_MS;
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
    /** 布局转场进行中：忽略再次切 mode / 拖节点 / 框选 / zoom */
    let layoutTransitionLocked = false;
    let cancelLayoutTransition: (() => void) | null = null;
    /** text-matrix：并排方向。 */
    let textMatrixOrientation: TextMatrixOrientation = options?.textMatrixOrientation ?? 'horizontal';
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
            setLayoutTransitionEnabled: noop,
            setLayoutTransitionDurationMs: noop,
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
            setTextMatrixOrientation: noop,
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

    /** DAG Top‑K tooltip：挂载初期为 stub；在 highlight reconciler 创建后赋真实实现 */
    let syncGenAttrDagTopkTooltipImpl: () => void = () => {
        dagTopkToolTip.hideAndReset();
    };

    /** 非可拖布局时节点不可拖；用该类覆盖选中态的 grab 光标（linear-arc / spiral / 纯 matrix 等）。 */
    function syncStackLayoutDragUi(): void {
        stackEl.classList.toggle('gen-attr-dag-no-node-drag-layout', !layoutAllowsNodeDrag(layoutMode));
    }

    /**
     * matrix 稳态双色外围（`gen-attr-dag-matrix-layout`）。
     * 转场约定：只动画节点与边/格；背景等其余元素稳态再显现。
     * @param active 省略时按当前 `layoutMode === 'attribution-matrix'`。
     */
    function syncMatrixLayoutBgClass(active?: boolean): void {
        stackEl.classList.toggle(
            'gen-attr-dag-matrix-layout',
            active ?? layoutMode === 'attribution-matrix',
        );
    }
    syncStackLayoutDragUi();
    syncMatrixLayoutBgClass();

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
    /** text-matrix：视口正中灰线（DOM，不属于可缩放画布；显隐靠 stack class） */
    stack.append('div').attr('class', 'gen-attr-dag-text-matrix-divider');

    const lightningFlashOverlay = stack
        .append('div')
        .attr('class', 'gen-attr-dag-lightning-flash')
        .style('display', 'none')
        .style('opacity', '0');

    /** 边箭头 marker 放在 svg 根 defs，与 zoom 根平级、不受 zoom 变换，与原先单例 marker 一致，避免嵌套在 zoom 内时箭头相对线段偏细 */
    const linkMarkersDefs = svg.append('defs').attr('class', 'gen-attr-dag-link-markers-defs');
    /** text-matrix：左右半屏 clip（svg 用户坐标，挂在 zoom 之外，视口固定） */
    const clipUid = `tm${Math.random().toString(36).slice(2, 9)}`;
    const clipLeftId = `gen-attr-dag-clip-left-${clipUid}`;
    const clipRightId = `gen-attr-dag-clip-right-${clipUid}`;
    const paneClipDefs = svg.append('defs').attr('class', 'gen-attr-dag-pane-clip-defs');
    const leftClipRect = paneClipDefs.append('clipPath').attr('id', clipLeftId).append('rect');
    const rightClipRect = paneClipDefs.append('clipPath').attr('id', clipRightId).append('rect');

    /** text-matrix：clip 壳（无 transform）；其内才是各侧独立 zoom 根 */
    const textPaneG = svg.append('g').attr('class', 'gen-attr-dag-text-pane');
    const matrixPaneG = svg.append('g').attr('class', 'gen-attr-dag-matrix-pane');
    const rootG = textPaneG.append('g').attr('class', 'gen-attr-dag-zoom-root');
    const matrixZoomG = matrixPaneG.append('g').attr('class', 'gen-attr-dag-matrix-zoom-root');
    /**
     * zoom 回调在 `applyInitialDagZoom` 时就会同步触发，此时后续 DOM 尚未声明；
     * 先占位，就绪后再赋真实实现（同 {@link syncGenAttrDagTopkTooltipImpl}）。
     */
    let syncTextMatrixPaneClips: () => void = () => {};

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

    /** text-matrix：左右独立 zoom 状态（d3-zoom 在 svg 上只存一份，手势前按半屏重播种） */
    let tmTextZoom: d3.ZoomTransform = d3.zoomIdentity;
    let tmMatrixZoom: d3.ZoomTransform = d3.zoomIdentity;
    let tmGesturePane: 'text' | 'matrix' | null = null;
    /** 程序化 `zoom.transform` 时指定写入哪一侧（text-matrix） */
    let tmProgrammaticPane: 'text' | 'matrix' | null = null;

    const zoomBehavior = d3
        .zoom<SVGSVGElement, unknown>()
        // 与 d3-zoom 默认一致（放行 pinch 的 wheel+ctrlKey），另在转场中锁交互
        .filter(
            (event) =>
                !layoutTransitionLocked &&
                (!event.ctrlKey || event.type === 'wheel') &&
                !event.button,
        )
        .on('start', (event) => {
            if (!isTextMatrixLayout(layoutMode) || event.sourceEvent == null) return;
            tmGesturePane = pointerInTextMatrixTextPane(event.sourceEvent) ? 'text' : 'matrix';
            // 将 d3 内部状态对齐到当前半屏，后续 delta 只作用这一侧
            svg.property('__zoom', tmGesturePane === 'text' ? tmTextZoom : tmMatrixZoom);
        })
        .on('zoom', (event) => {
            if (isTextMatrixLayout(layoutMode)) {
                const pane = tmGesturePane ?? tmProgrammaticPane;
                if (pane === 'matrix') {
                    tmMatrixZoom = event.transform;
                    matrixZoomG.attr('transform', tmMatrixZoom.toString());
                } else if (pane === 'text') {
                    tmTextZoom = event.transform;
                    rootG.attr('transform', tmTextZoom.toString());
                }
                if (event.sourceEvent) {
                    layoutDirty = true;
                    if (pane === 'matrix' && matrixPinSteady != null) matrixPinFollowActive = false;
                }
                syncGenAttrDagTopkTooltipImpl();
                return;
            }
            // 单布局：两侧 zoom 根镜像同一 transform（matrix 在 matrixZoomG；转场 fly 在 rootG）
            rootG.attr('transform', event.transform);
            matrixZoomG.attr('transform', event.transform);
            // 仅用户交互（滚轮/拖平移）计入「改动布局」；程序触发的 transform
            // （init 初始缩放、`fitViewportToContent`、pin 跟随）`sourceEvent === null`，不置 dirty。
            if (event.sourceEvent) {
                layoutDirty = true;
                // 播放中用户改视口：停止 pin 跟随（播放前的 dirty 不经过这里打断）。
                if (matrixPinSteady != null) matrixPinFollowActive = false;
            }
            syncGenAttrDagTopkTooltipImpl();
        })
        .on('end', () => {
            tmGesturePane = null;
        });

    function applyInitialDagZoom(): void {
        svg.call(zoomBehavior.transform, d3.zoomIdentity.scale(defaultDagZoomK()));
    }

    svg.call(zoomBehavior);
    // 不要 d3.zoom 默认的双击放大。
    svg.on('dblclick.zoom', null);
    applyInitialDagZoom();

    // 空白 clear：仅当无 matrixHit 所有者时生效（text-flow 等）。
    // layoutShowsMatrix 时由 click.matrixHit 独占整次 svg click（含 text-matrix 左半屏空白）。
    svg.on('click.dagBg', () => {
        if (layoutShowsMatrix(layoutMode)) return;
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
    /** attribution-matrix / text-matrix 热力图层（`pointer-events` 由 {@link syncLayoutLayerVisibility} 随模式开关） */
    const matrixG = matrixZoomG
        .append('g')
        .attr('class', 'gen-attr-dag-matrix')
        .style('display', 'none')
        .style('pointer-events', 'none');
    /** 右键框选橡胶筋（图坐标系，随 text 侧 zoom） */
    const marqueeG = rootG.append('g').attr('class', 'gen-attr-dag-marquee').style('pointer-events', 'none');

    const graph = new DirectedGraph<DagNodeAttrs>();
    let nodes: DagNode[] = [];
    /** `nodes` 按 step 降序（新→旧→prompt）排列的副本，供传播链动画 {@link promptNodeIdsFromCtx} 等使用。 */
    let nodesSortedByStepDesc: DagNode[] = [];
    let links: DagLink[] = [];
    /** 按 targetId 索引的入边列表，供 {@link computeFocusAttributionState} 使用，避免每次 hover O(N×E) 全扫描。 */
    const incomingLinksByTarget = new Map<string, DagLink[]>();
    /** 灰边 / 焦点视觉帧状态见 {@link createDagHighlightReconciler}。 */
    let stepProcessed = 0;
    /**
     * 焦点态唯一所有者：传播焦点 / 步进选中 / 悬停 / matrix 检查 / 布局多选。
     * 见 {@link createDagFocusSession}。
     */
    const focus = createDagFocusSession({
        onUserFocusChange: (focusId) => options?.onUserFocusChange?.(focusId),
    });
    /** Cmd/Ctrl 是否按下：与多选集一起决定悬停用虚线框而非焦点描边。 */
    let multiSelectModifierDown = false;
    /** ▶ Simulate attention：attend / FFN 阶段 token 高亮 */
    let attentionHighlight: AttentionPlaybackHighlight = null;
    let lastTokenAppearanceDwellActive = false;
    const focusAttributionCtx = () => ({
        nodesSortedByStepDesc,
        incomingLinksByTarget,
    });

    let syncDagPlayButtonImpl: () => void = () => {};

    const isMatrixRowId = (id: string): boolean => matrixRowNodes().some((n) => n.id === id);

    const getPropagationPlaybackOptionsRaw =
        options?.getPropagationPlaybackOptions ??
        ((): DagPropagationPlaybackOptions => ({
            forwardSlideSharedNodes: false,
            lightningEffect: false,
            lightningThresholdTau: DAG_LIGHTNING_THRESHOLD_TAU_DEFAULT,
            lightningSlowMo: DAG_LIGHTNING_SLOW_MO_DEFAULT,
            lightningSound: false,
        }));
    /** 含 matrix 的布局不接 Lightning（纯 matrix 无图侧效果；text+matrix 也不提供该选项）；强制关掉以免仍播雷声。 */
    const getPropagationPlaybackOptions = (): DagPropagationPlaybackOptions => {
        const opts = getPropagationPlaybackOptionsRaw();
        if (!layoutShowsMatrix(layoutMode)) return opts;
        if (!opts.lightningEffect && !opts.lightningSound) return opts;
        return { ...opts, lightningEffect: false, lightningSound: false };
    };

    const lightningSound = createDagLightningSoundController();
    /** 高亮调解器：在 DOM/焦点 helpers 就绪后赋值；此前调用 refresh 视为编程错误。 */
    let highlight: DagHighlightReconciler | null = null;
    function refreshNodeLinkHighlight(): void {
        if (!highlight) {
            throw new Error('genAttributeDagView: refreshNodeLinkHighlight before highlight reconciler init');
        }
        highlight.refresh();
    }
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
                highlight?.clearLightningPreviewOnPlaybackStart();
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
            computeSteadyStateStayShareById(
                nodeShareById,
                graph,
                incomingLinksByTarget,
                focusId,
                dagDecayAttributionToHighSurprisalTargetEnabled,
            ),
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

    function applyFocusPlaybackStop(result: { stopPlayback: boolean }): void {
        if (result.stopPlayback) recursiveEdgeAnimation.stopPlayback();
    }

    /** 多选交互态：悬停用虚线框，不用焦点描边 / 归因悬停预览 / tooltip。 */
    function layoutSelectHoverActive(): boolean {
        return (
            focus.getLayoutSelectedIds().size > 0 ||
            multiSelectModifierDown ||
            marqueeSession != null
        );
    }

    function solidFrameFocusId(): string | null {
        return focus.solidFrameFocusId(layoutSelectHoverActive(), (id) => graph.hasNode(id));
    }

    function effectiveFocusId(): string | null {
        return focus.effectiveFocusId(layoutSelectHoverActive());
    }

    /**
     * matrix 交互 → 节点 tooltip token：行/列=对应轴 token。
     * 格走边 tooltip（见 {@link syncGenAttrDagTopkTooltipImpl}），不经此函数。
     */
    function matrixTooltipTokenId(target: MatrixInteractionTarget | null): string | null {
        if (target == null || target.type === 'cell') return null;
        return target.id;
    }

    function matrixTooltipPreferCol(target: MatrixInteractionTarget | null): boolean {
        return target?.type === 'col' || target?.type === 'rowAndCol';
    }

    /** tooltip 锚点：传播播放 > matrix hover/lock > {@link solidFrameFocusId}。 */
    function tooltipFocusId(): string | null {
        const playbackTip = highlight?.getPropagationPlaybackTooltip() ?? null;
        if (playbackTip != null && graph.hasNode(playbackTip.nodeId)) {
            return playbackTip.nodeId;
        }
        if (layoutShowsMatrix(layoutMode)) {
            const matrixId = matrixTooltipTokenId(
                focus.getMatrixHoverTarget() ?? focus.getMatrixLockedTarget(),
            );
            if (matrixId != null && graph.hasNode(matrixId)) return matrixId;
        }
        return solidFrameFocusId();
    }

    /** matrix 可见 chip 的 fill rect（HUD 定位不依赖几何，但 update 路径要求非空锚点）。 */
    function matrixTooltipAnchorRect(nodeId: string, target: MatrixInteractionTarget | null): SVGRectElement | null {
        const preferCol = matrixTooltipPreferCol(target);
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
        return nodeIncludedInLayoutForFocus(
            n,
            effectiveFocusId(),
            highlight?.getFocusState() ?? null,
        );
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

    /** 按模式显隐 graph / matrix 层；离开 matrix 时拆除矩阵 DOM。 */
    function syncLayoutLayerVisibility(): void {
        const showGraph = layoutShowsGraph(layoutMode);
        const showMatrix = layoutShowsMatrix(layoutMode);
        const graphDisplay = showGraph ? null : 'none';
        linkG.style('display', graphDisplay);
        nodeG.style('display', graphDisplay);
        linkGFront.style('display', graphDisplay);
        nodeGHit.style('display', graphDisplay);
        matrixG.style('display', showMatrix ? null : 'none').style('pointer-events', showMatrix ? 'auto' : 'none');
        if (!showMatrix) {
            disposeMatrixPointerHit();
            matrixG.selectAll('*').remove();
            clearTextMatrixPaneLayout();
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
            layoutTransitionLocked ||
            dagPlaybackPlaying ||
            recursiveEdgeAnimation.getPlaybackPhase() === 'playing'
        );
    }

    /**
     * 点击确立/取消焦点后抑制悬停，直到指针离开节点再进入（与 matrixHit 同产品逻辑）。
     * mouseenter 在仍停留于节点时不会重触发，但仍挡住偶发重入。
     */
    let suppressTextHoverUntilLeave = false;

    function bindNodePointerHandlers(
        sel: d3.Selection<SVGGElement, DagNode, SVGGElement | null, unknown>,
    ): void {
        sel.on('mouseenter', (event, d) => {
            if (isTextMatrixLayout(layoutMode) && !pointerInTextMatrixTextPane(event)) return;
            if (suppressTextHoverUntilLeave) return;
            // 若在节点上按下/松开修饰键可能丢 key 事件，用 pointer 状态对齐
            syncMultiSelectModifierDown(isMultiSelectModifierKey(event));
            // text 悬停只写 hoveredId；matrix 轴投影由 matrixStaticHighlightTarget 推导
            focus.setHovered(d.id);
            refreshNodeLinkHighlight();
        })
            .on('mouseleave', () => {
                suppressTextHoverUntilLeave = false;
                focus.setHovered(null);
                refreshNodeLinkHighlight();
            })
            .on('click', (event, d) => {
                event.stopPropagation();
                if (isTextMatrixLayout(layoutMode) && !pointerInTextMatrixTextPane(event)) return;
                if (layoutInteractionLocked()) return;
                suppressTextHoverUntilLeave = true;
                if (isMultiSelectModifierKey(event)) {
                    applyFocusPlaybackStop(focus.toggleLayoutSelected(d.id));
                    refreshNodeLinkHighlight();
                    syncDagPlayButtonImpl();
                    return;
                }
                applyFocusPlaybackStop(focus.toggleNodeFocus(d.id));
                focus.syncMatrixRowLockWithUserFocus(isMatrixRowId);
                refreshNodeLinkHighlight();
                syncDagPlayButtonImpl();
            });
    }

    function syncSvgSize(): void {
        const { w, h } = stackLayoutViewportPx(stackEl);
        svg.attr('width', w).attr('height', h);
        syncTextMatrixPaneClips();
    }

    function textMatrixIsVertical(): boolean {
        return textMatrixOrientation === 'vertical';
    }

    function pointerInTextMatrixTextPane(event: PointerEvent | MouseEvent): boolean {
        const [x, y] = d3.pointer(event, svg.node()!);
        const { w, h } = stackLayoutViewportPx(stackEl);
        return textMatrixIsVertical() ? y < h / 2 : x < w / 2;
    }

    function pointerInTextMatrixMatrixPane(event: PointerEvent): boolean {
        const [x, y] = d3.pointer(event, svg.node()!);
        const { w, h } = stackLayoutViewportPx(stackEl);
        return textMatrixIsVertical() ? y >= h / 2 : x >= w / 2;
    }

    /** 清除 text-matrix 半屏 clip / 分割线 class（离开该模式时）。 */
    function clearTextMatrixPaneLayout(): void {
        textPaneG.attr('clip-path', null);
        matrixPaneG.attr('clip-path', null);
        stackEl.classList.remove('gen-attr-dag-text-matrix-layout', 'gen-attr-dag-text-matrix-layout--vertical');
    }

    /** text-matrix：半屏 clip 矩形（svg 用户坐标，不随 zoom）。 */
    syncTextMatrixPaneClips = (): void => {
        if (!isTextMatrixLayout(layoutMode)) {
            textPaneG.attr('clip-path', null);
            matrixPaneG.attr('clip-path', null);
            return;
        }
        const { w, h } = stackLayoutViewportPx(stackEl);
        const vertical = textMatrixIsVertical();
        if (vertical) {
            const mid = h / 2;
            leftClipRect.attr('x', 0).attr('y', 0).attr('width', w).attr('height', mid);
            rightClipRect
                .attr('x', 0)
                .attr('y', mid)
                .attr('width', w)
                .attr('height', Math.max(h - mid, 0));
        } else {
            const mid = w / 2;
            leftClipRect.attr('x', 0).attr('y', 0).attr('width', mid).attr('height', h);
            rightClipRect
                .attr('x', mid)
                .attr('y', 0)
                .attr('width', Math.max(w - mid, 0))
                .attr('height', h);
        }
        textPaneG.attr('clip-path', `url(#${clipLeftId})`);
        matrixPaneG.attr('clip-path', `url(#${clipRightId})`);
        stackEl.classList.add('gen-attr-dag-text-matrix-layout');
        stackEl.classList.toggle('gen-attr-dag-text-matrix-layout--vertical', vertical);
    };

    /** 当前 matrix 视口 zoom（text-matrix 用独立状态；其余用 svg 上的 d3-zoom）。 */
    function matrixViewZoomTransform(): d3.ZoomTransform {
        return isTextMatrixLayout(layoutMode) ? tmMatrixZoom : d3.zoomTransform(svg.node()!);
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

    function syncMatrixRowLockWithUserFocus(): void {
        focus.syncMatrixRowLockWithUserFocus(isMatrixRowId);
    }

    function matrixCommittedRowFocusId(): string | null {
        return focus.matrixCommittedRowFocusId(recursiveAttributionEnabled, isMatrixRowId);
    }

    function matrixRowFocusId(): string | null {
        return focus.matrixRowFocusId(recursiveAttributionEnabled, isMatrixRowId);
    }

    const matrixInteractionHandlers = createMatrixInteractionHandlers({
        isInteractionLocked: () => layoutInteractionLocked(),
        focus,
        applyFocusPlaybackStop,
        refreshHighlight: () => refreshNodeLinkHighlight(),
        syncPlayButton: () => syncDagPlayButtonImpl(),
        clearSelection: () => clearNodeSelection(),
    });

    /**
     * matrix 静态归因目标：右侧自有 lock/hover 原生优先；否则左侧投影。
     */
    function matrixStaticHighlightTarget(): MatrixInteractionTarget | null {
        return focus.matrixStaticHighlightTarget(
            dagPlaybackPlaying,
            isMatrixRowId,
            showDownstreamInfluence,
        );
    }

    /** ↯ 进行中：userFocus 行焦点 + playing/paused。 */
    function matrixPropagationHighlightActive(): boolean {
        const phase = recursiveEdgeAnimation.getPlaybackPhase();
        const userFocusId = focus.getUserFocusId();
        return (
            recursiveAttributionEnabled &&
            userFocusId != null &&
            graph.hasNode(userFocusId) &&
            (phase === 'playing' || phase === 'paused')
        );
    }

    /** 传播归因 + backward：仅 UI 路径反向，不改边数据与归因 key。 */
    function linkEndpointsForPaint(d: DagLink): { src: DagNode; tgt: DagNode } {
        const src = endpointNode(d.source, graph);
        const tgt = endpointNode(d.target, graph);
        const flipArrows =
            recursiveAttributionEnabled && recursiveEdgeAnimation.getDirection() === 'backward';
        return flipArrows ? { src: tgt, tgt: src } : { src, tgt };
    }

    function paintMatrixLayer(): void {
        // 左侧焦点不写入 matrix lock；仅清掉「无行焦点时」的残留行 lock。
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
            acceptPointer: isTextMatrixLayout(layoutMode)
                ? pointerInTextMatrixMatrixPane
                : undefined,
        });
        // 颜色由调用方随后的 refreshNodeLinkHighlight → refreshMatrixHighlight 写入。
    }

    /**
     * text-matrix：半屏各按独立视口 fit，写入两侧独立 zoom（互不跟随）。
     * 分割线为 DOM，不在画布坐标系内。
     */
    function fitTextMatrixPanes(): void {
        rootG.attr('transform', null);
        matrixZoomG.attr('transform', null);
        const textBBox = rootG.node()!.getBBox();
        const matrixBBox = matrixG.node()!.getBBox();

        const { w, h } = stackLayoutViewportPx(stackEl);
        const vertical = textMatrixIsVertical();
        const mid = vertical ? h / 2 : w / 2;
        const textW = vertical ? w : Math.max(mid, 1);
        const textH = vertical ? Math.max(mid, 1) : h;
        const matrixW = vertical ? w : Math.max(w - mid, 1);
        const matrixH = vertical ? Math.max(h - mid, 1) : h;
        const zText = computeFitZoomTransform({
            mode: 'text-flow',
            contentBBox: textBBox,
            viewportW: textW,
            viewportH: textH,
            k0: initialDagZoomK() * dagInitialZoomBoost('text-flow'),
        });
        const zMatrix = computeFitZoomTransform({
            mode: 'attribution-matrix',
            contentBBox: matrixBBox,
            viewportW: matrixW,
            viewportH: matrixH,
            k0: initialDagZoomK() * dagInitialZoomBoost('attribution-matrix'),
        });
        tmTextZoom = d3.zoomIdentity.translate(zText.x, zText.y).scale(zText.k);
        // matrix 半屏：先平移到分割线另一侧，再套自己的 fit
        tmMatrixZoom = vertical
            ? d3.zoomIdentity.translate(zMatrix.x, mid + zMatrix.y).scale(zMatrix.k)
            : d3.zoomIdentity.translate(mid + zMatrix.x, zMatrix.y).scale(zMatrix.k);
        rootG.attr('transform', tmTextZoom.toString());
        matrixZoomG.attr('transform', tmMatrixZoom.toString());
        // 同步 d3 内部状态到 text 侧（不覆盖 matrixZoomG）
        tmProgrammaticPane = 'text';
        svg.call(zoomBehavior.transform, tmTextZoom);
        tmProgrammaticPane = null;
        matrixZoomG.attr('transform', tmMatrixZoom.toString());
        syncTextMatrixPaneClips();
    }

    function paint(): void {
        syncLayoutLayerVisibility();
        if (layoutMode === 'attribution-matrix') {
            clearTextMatrixPaneLayout();
            paintMatrixLayer();
            return;
        }
        syncNodeStrokeRects(nodeSel, displayScale);
        syncNodeLayoutSelRects(nodeSel, displayScale);
        const graphMode = isTextMatrixLayout(layoutMode) ? 'text-flow' : layoutMode;
        if (graphMode === 'linear-arc' || graphMode === 'linear-arc-step-down') {
            const layoutNodes = nodes.filter((n) => nodeIncludedInLayout(n));
            paintLinearArcLayout({
                linkSel,
                nodeSel,
                nodes: layoutNodes,
                adjacentGapPx: linearArcAdjacentGapPx,
                variant: graphMode === 'linear-arc-step-down' ? 'step-down' : 'flat',
                getLinkNodes: linkEndpointsForPaint,
            });
        } else if (graphMode === 'spiral') {
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
        if (isTextMatrixLayout(layoutMode)) {
            paintMatrixLayer();
            syncTextMatrixPaneClips();
        } else {
            clearTextMatrixPaneLayout();
        }
    }

    let dragPointerOffset: { x: number; y: number } | null = null;
    const drag = d3
        .drag<SVGGElement, DagNode>()
        // 左键且无修饰键；布局多选非空时拖集内节点，否则仅焦点节点可拖；修饰键留给点选/框选
        .filter(
            (event, d) =>
                !isMultiSelectModifierKey(event) &&
                !event.button &&
                layoutAllowsNodeDrag(layoutMode) &&
                !layoutInteractionLocked() &&
                (focus.getLayoutSelectedIds().size > 0
                    ? focus.getLayoutSelectedIds().has(d.id)
                    : focus.getSelectedId() === d.id)
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
            const layoutSel = focus.getLayoutSelectedIds();
            const moving =
                layoutSel.size > 0
                    ? nodes.filter((n) => layoutSel.has(n.id))
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
            applyFocusPlaybackStop(focus.setLayoutSelectedAfterMarquee(hits, true));
        } else {
            applyFocusPlaybackStop(focus.setLayoutSelectedAfterMarquee(hits, false));
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
        if (isTextMatrixLayout(layoutMode) && !pointerInTextMatrixTextPane(event)) return;
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

    highlight = createDagHighlightReconciler({
        graph,
        getNodes: () => nodes,
        incomingLinksByTarget,
        focus,
        recursiveEdgeAnimation,
        focusAttributionCtx,
        getNodeSel: () => nodeSel,
        getNodeHitSel: () => nodeHitSel,
        nodeG,
        nodeGHit,
        linkG,
        linkGFront,
        linkMarkersDefs,
        lightningFlashOverlay,
        matrixG,
        effectiveFocusId,
        layoutSelectHoverActive,
        getMarqueePreviewIds: () => marqueePreviewIds,
        isRecursiveAttributionEnabled: () => recursiveAttributionEnabled,
        isShowDownstreamInfluence: () => showDownstreamInfluence,
        isHideExcludedTokens: () => hideExcludedTokens,
        isHideArrowsDuringAttention: () => hideArrowsDuringAttention,
        isDagPlaybackPlaying: () => dagPlaybackPlaying,
        getAttentionHighlight: () => attentionHighlight,
        isLastTokenAppearanceDwellActive: () => lastTokenAppearanceDwellActive,
        isDecayAttributionToHighSurprisalTargetEnabled: () =>
            dagDecayAttributionToHighSurprisalTargetEnabled,
        getPropagationPlaybackOptions,
        getDagExcludeIntervals: () => dagExcludeIntervals,
        getLayoutMode: () => layoutMode,
        dimInactiveTokensEffective,
        nodeLowVisibilityReasonFor,
        isNodeInactiveForDim,
        matrixRowNodes,
        matrixColNodes,
        matrixStaticHighlightTarget,
        matrixPropagationHighlightActive,
        matrixCommittedRowFocusId,
        matrixRowFocusId,
        syncLayoutForLowVisibilityMembership,
        syncTopkTooltip: () => syncGenAttrDagTopkTooltipImpl(),
        syncLightningSound,
        cancelPendingLightningStrike: () => lightningSound.cancelPendingStrike(),
        scheduleLightningStrikeDelay: () => lightningSound.scheduleStrikeDelay(),
    });

    // 须在 highlight 就绪后再挂：修饰键会触发 refreshNodeLinkHighlight。
    window.addEventListener('keydown', onMultiSelectModifierKeyDown);
    window.addEventListener('keyup', onMultiSelectModifierKeyUp);
    window.addEventListener('blur', onMultiSelectModifierBlur);

    function cancelLightningEffectPreview(): void {
        highlight!.cancelLightningEffectPreview();
    }

    function enterLightningTauPreview(): void {
        highlight!.enterLightningTauPreview();
    }

    function exitLightningTauPreview(): void {
        highlight!.exitLightningTauPreview();
    }

    function playLightningEffectPreview(): void {
        highlight!.playLightningEffectPreview();
    }

    function cancelLightningFadeRaf(): void {
        highlight!.cancelLightningFadeRaf();
    }

    syncGenAttrDagTopkTooltipImpl = (): void => {
        if (!showTokenInfoOnSelected) {
            dagTopkToolTip.hideAndReset();
            return;
        }

        // matrix 格 = 边：HUD 展示与 text 边 `<title>` 同源的指标（非节点 Top‑K）。
        const matrixTarget = layoutShowsMatrix(layoutMode)
            ? (focus.getMatrixHoverTarget() ?? focus.getMatrixLockedTarget())
            : null;
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
                highlight!.getLinkFocusState(),
                recursiveAttributionEnabled,
                dagDecayAttributionToHighSurprisalTargetEnabled,
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
        const hoveredId = focus.getHoveredId();
        const selectedId = focus.getSelectedId();
        const playbackTip = highlight!.getPropagationPlaybackTooltip();
        const focusStateForTip = highlight!.getFocusState();
        const shareSourceId =
            playbackTip?.direction === 'backward'
                ? focusIdNext
                : layoutShowsMatrix(layoutMode)
                  ? focus.matrixShareSourceId()
                  : hoveredId != null && solidFrameFocusId() === hoveredId
                    ? hoveredId
                    : null;
        if (
            selectedId &&
            shareSourceId &&
            focusStateForTip &&
            shareSourceId !== selectedId &&
            graph.hasNode(selectedId) &&
            graph.hasNode(shareSourceId)
        ) {
            // 链内链外均显示份额；低于 {@link DAG_MIN_ATTRIBUTION_SHARE} 时 format 为 "< x%"
            const share = focusStateForTip.nodeShareById.get(shareSourceId) ?? 0;
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
        focus.setSelectedOnly(id);
        refreshNodeLinkHighlight();
        syncDagPlayButtonImpl();
    }

    function clearNodeSelection(): void {
        applyFocusPlaybackStop(focus.clearAll());
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
        applyFocusPlaybackStop(focus.setUserFocus(id, isMatrixRowId));
        refreshNodeLinkHighlight();
        syncDagPlayButtonImpl();
    }

    /** 将当前 `nodes` / `links` 同步到 SVG：join 新 DOM、`paint` 几何、`refreshNodeLinkHighlight` 样式。 */
    function syncGraphToSvg(): void {
        highlight?.invalidateGrayCache();
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
        clearDagGraphEdges(graph, links, incomingLinksByTarget);
        highlight?.invalidateGrayCache();
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
        addAttributionIncomingEdgesToGraph({
            graph,
            links,
            incomingLinksByTarget,
            step,
            targetId,
            targetStart,
            targetEnd,
            alignStep,
            excludeIntervalContext,
            excludeIntervals,
            nodeIntervals: nodeIntervalsForAlign(),
            dagDeleteIntervals,
            edgeTopPCoverage,
            decayAttributionToHighSurprisalTarget: dagDecayAttributionToHighSurprisalTargetEnabled,
            excludePromptPatternsText: getEffectiveExcludePromptPatternsText(),
            excludeGeneratedPatternsText: getEffectiveExcludeGeneratedPatternsText(),
        });
    }

    /** 按 inputRanges 为 tool_response 节点建合成入边（`trNodeFilter` 限制候选，增量时仅新增节点）。 */
    function addSyntheticEdgesForInputRanges(
        inputRanges: CharRange[],
        trNodeFilter: (n: DagNode) => boolean,
    ): void {
        addSyntheticEdgesForInputRangesToGraph({
            graph,
            links,
            incomingLinksByTarget,
            nodes,
            inputRanges,
            trNodeFilter,
            dagExcludeIntervals,
            onSyntheticEdgesAdded: () => {
                highlight?.invalidateGrayCache();
            },
        });
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
        applyFocusPlaybackStop(focus.selectGeneratedToken(targetId));
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
        clearLayoutTransitionArtifacts();
        clearGenAttributeDagAlignmentWarnDedupe();
        recursiveEdgeAnimation.onClear();
        textMeasure.reset();
        textMeasure = createGenAttributeDagTextMeasure(measureRoot);
        graph.clear();
        nodes = [];
        nodesSortedByStepDesc = [];
        links = [];
        incomingLinksByTarget.clear();
        highlight?.invalidateGrayCache();
        stepProcessed = 0;
        focus.reset();
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
    }

    function contentBBoxForFit(mode: DagLayoutMode): DOMRect {
        if (isLinearArcFamilyLayout(mode)) {
            return nodeG.node()!.getBBox();
        }
        if (mode === 'attribution-matrix') {
            return matrixG.node()!.getBBox();
        }
        // text-flow / spiral：rootG；text-matrix 走双侧独立 fit，不经此 bbox
        return rootG.node()!.getBBox();
    }

    function fitViewportToContent(force: boolean = false): void {
        syncSvgSize();
        if (layoutDirty && !force) {
            return;
        }
        if (nodes.length === 0) {
            applyInitialDagZoom();
        } else if (isTextMatrixLayout(layoutMode)) {
            fitTextMatrixPanes();
        } else {
            const { w, h } = stackLayoutViewportPx(stackEl);
            const contentBBox = contentBBoxForFit(layoutMode);
            const z = computeFitZoomTransform({
                mode: layoutMode,
                contentBBox,
                viewportW: w,
                viewportH: h,
                k0: defaultDagZoomK(),
            });
            svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(z.x, z.y).scale(z.k));
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
            const userFocusId = focus.getUserFocusId();
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
        const userFocusId = focus.getUserFocusId();
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
        const userFocusId = focus.getUserFocusId();
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

    function layoutElementKind(mode: DagLayoutMode): DagLayoutElementKind {
        return mode === 'attribution-matrix' ? 'matrix' : 'graph';
    }

    function prefersReducedMotion(): boolean {
        return (
            typeof matchMedia === 'function' &&
            matchMedia('(prefers-reduced-motion: reduce)').matches
        );
    }

    /**
     * 转场捕获可见性（相对 svg 根）。
     * 契约：只使用稳态已画出的元素；判断见 {@link isSteadyPainted}；须在压层前调用。
     */
    function painted(el: Element, kind: SteadyPaintKind): boolean {
        return isSteadyPainted(el, kind, { root: svg.node() });
    }

    function paintOpacity(el: Element, kind: SteadyPaintKind): number {
        return readSteadyPaintOpacity(el, kind, { root: svg.node() });
    }

    /** 矩阵轴 token → element key；非行列 chip 返回 null。 */
    function matrixTokenKeyFromEl(el: Element): string | null {
        const id = el.getAttribute('data-node-id');
        if (!id) return null;
        if (el.classList.contains('gen-attr-dag-matrix-row-token')) return matrixRowElementKey(id);
        if (el.classList.contains('gen-attr-dag-matrix-col-token')) return matrixColElementKey(id);
        return null;
    }

    /** 枚举稳态可见 token（图节点或矩阵行列 chip）。 */
    function forEachPaintedToken(
        mode: DagLayoutMode,
        fn: (key: string, el: SVGGElement, node: DagNode | null) => void,
    ): void {
        if (mode === 'attribution-matrix') {
            matrixG.selectAll<SVGGElement, unknown>('g.gen-attr-dag-matrix-token').each(function () {
                if (!painted(this, 'token')) return;
                const key = matrixTokenKeyFromEl(this);
                if (!key) return;
                fn(key, this, null);
            });
            return;
        }
        nodeG.selectAll<SVGGElement, DagNode>('g.gen-attr-dag-node').each(function (d) {
            if (!d || !painted(this, 'token')) return;
            fn(dagLayoutNodeKey(d.id), this, d);
        });
    }

    function captureTokenPosesFromDom(mode: DagLayoutMode): Map<string, DagNodeLayoutPose> {
        const out = new Map<string, DagNodeLayoutPose>();
        forEachPaintedToken(mode, (key, el, node) => {
            if (node) {
                out.set(
                    key,
                    parsePoseFromTransform(el.getAttribute('transform'), {
                        id: node.id,
                        nodeW: node.nodeW,
                        nodeH: node.nodeH,
                    }),
                );
                return;
            }
            const id = el.getAttribute('data-node-id') ?? key;
            const fill = el.querySelector('rect.gen-attr-dag-node-fill');
            const nodeW = fill instanceof SVGRectElement ? fill.width.baseVal.value : 4;
            const nodeH = fill instanceof SVGRectElement ? fill.height.baseVal.value : 4;
            out.set(key, parsePoseFromTransform(el.getAttribute('transform'), { id, nodeW, nodeH }));
        });
        return out;
    }

    /** 元素 key → fill opacity（与稳态 `resolveNodeFillOpacity` / matrix token visual 一致）。 */
    function captureTokenFillOpacityFromDom(mode: DagLayoutMode): Map<string, number> {
        const out = new Map<string, number>();
        forEachPaintedToken(mode, (key, el) => {
            const fill = el.querySelector('rect.gen-attr-dag-node-fill');
            out.set(key, fill ? paintOpacity(fill, 'token') : 1);
        });
        return out;
    }

    /** 与 scss `--gen-attr-dag-link-stroke-width: calc(2px * compactness)` 一致。 */
    function linkStrokeWidthPx(): number {
        const sample =
            linkG.select<SVGPathElement>('path.gen-attr-dag-link-visible').node() ??
            linkGFront.select<SVGPathElement>('path.gen-attr-dag-link-visible').node();
        if (sample) {
            const w = parseFloat(getComputedStyle(sample).strokeWidth);
            if (w > 0 && Number.isFinite(w)) return w;
        }
        return 2 * displayScale;
    }

    /**
     * 图边 path 中点 + 切线 → 细条种子（key = src->tgt）；厚度对齐真实边 stroke-width。
     * `frontKeys`：稳态在 {@link linkGFront} 的边（焦点蓝/红），转场 DOM 须画在灰边之上。
     */
    function captureEdgeSeedPosesFromDom(): {
        poses: Map<string, DagLayoutFlyPose>;
        frontKeys: Set<string>;
    } {
        const out = new Map<string, DagLayoutFlyPose>();
        const frontKeys = new Set<string>();
        const thickPx = linkStrokeWidthPx();
        const visit = (
            sel: d3.Selection<SVGGElement, DagLink, SVGGElement, unknown>,
            front: boolean,
        ) => {
            sel.each(function (d) {
                if (!d || out.has(dagLinkEndpointKey(d.source, d.target))) return;
                const path = this.querySelector('path.gen-attr-dag-link-visible');
                if (!(path instanceof SVGPathElement)) return;
                if (!painted(path, 'stroke')) return;
                const len = path.getTotalLength();
                if (!(len > 0) || !Number.isFinite(len)) return;
                // 条带用端点弦；箭头扭转用末端切线（对齐 marker orient=auto）
                const p0 = path.getPointAtLength(0);
                const p1 = path.getPointAtLength(len);
                const back = Math.min(1, len * 0.02);
                const pNear = path.getPointAtLength(len - back);
                const chordX = p1.x - p0.x;
                const chordY = p1.y - p0.y;
                const chordAngleDeg = (Math.atan2(chordY, chordX) * 180) / Math.PI;
                const endAngleDeg = (Math.atan2(p1.y - pNear.y, p1.x - pNear.x) * 180) / Math.PI;
                const key = dagLinkEndpointKey(d.source, d.target);
                const strokeOp = paintOpacity(path, 'stroke');
                const stroke =
                    path.getAttribute('stroke')?.trim() ||
                    getComputedStyle(path).stroke ||
                    DAG_LAYOUT_FLY_DEFAULT_COLOR;
                const synthetic = d.synthetic === true;
                const dash = synthetic ? flySyntheticDashPair(displayScale) : null;
                if (front) frontKeys.add(key);
                out.set(
                    key,
                    edgeFlyPoseFromPathTangent({
                        id: key,
                        midX: (p0.x + p1.x) / 2,
                        midY: (p0.y + p1.y) / 2,
                        tanX: chordX,
                        tanY: chordY,
                        pathLength: Math.hypot(chordX, chordY),
                        thickPx,
                        opacity: strokeOp,
                        color: stroke,
                        dashed: synthetic,
                        dashOn: dash?.dashOn,
                        dashOff: dash?.dashOff,
                        arrowTwistDeg: flyArrowTwistFromAngles(chordAngleDeg, endAngleDeg),
                    }),
                );
            });
        };
        visit(linkG.selectAll<SVGGElement, DagLink>('g.gen-attr-dag-link'), false);
        visit(linkGFront.selectAll<SVGGElement, DagLink>('g.gen-attr-dag-link'), true);
        return { poses: out, frontKeys };
    }

    /** 矩阵有边格子 → 中心制无转角方块（key = src->tgt）。 */
    function captureMatrixEdgeCellPosesFromDom(): Map<string, DagLayoutFlyPose> {
        const out = new Map<string, DagLayoutFlyPose>();
        matrixG
            .selectAll<SVGRectElement, { key: string; hasEdge?: boolean; synthetic?: boolean }>(
                'rect.gen-attr-dag-matrix-cell:not(.gen-attr-dag-matrix-self-cell)',
            )
            .each(function (d) {
                if (!d?.hasEdge || !d.key) return;
                if (!painted(this, 'fill')) return;
                const w = this.width.baseVal.value || MATRIX_CELL_SIZE;
                const h = this.height.baseVal.value || MATRIX_CELL_SIZE;
                const cellOp = paintOpacity(this, 'fill');
                const fill =
                    this.getAttribute('fill')?.trim() ||
                    getComputedStyle(this).fill ||
                    DAG_LAYOUT_FLY_DEFAULT_COLOR;
                const synthetic = d.synthetic === true;
                const dash = synthetic ? flySyntheticDashPair(displayScale) : null;
                out.set(
                    d.key,
                    cellFlyPoseFromRect({
                        id: d.key,
                        x: this.x.baseVal.value,
                        y: this.y.baseVal.value,
                        w,
                        h,
                        opacity: cellOp,
                        color: fill,
                        dashed: synthetic,
                        dashOn: dash?.dashOn,
                        dashOff: dash?.dashOff,
                    }),
                );
            });
        return out;
    }

    /** 节点焦点框 class（转场中焦点不变，fly 直接沿用）。 */
    type TokenFrameFlags = { selected: boolean; hover: boolean; layoutSelected: boolean };

    function captureTokenFrameFromDom(mode: DagLayoutMode): Map<string, TokenFrameFlags> {
        const out = new Map<string, TokenFrameFlags>();
        forEachPaintedToken(mode, (key, el) => {
            out.set(key, {
                selected: el.classList.contains('gen-attr-dag-node--selected'),
                hover: el.classList.contains('gen-attr-dag-node--hover'),
                layoutSelected: el.classList.contains('gen-attr-dag-node--layout-selected'),
            });
        });
        return out;
    }

    function applyZoomPose(z: { x: number; y: number; k: number }): void {
        svg.call(zoomBehavior.transform, d3.zoomIdentity.translate(z.x, z.y).scale(z.k));
    }

    function setTransitionContentHidden(hidden: boolean): void {
        const op = hidden ? '0' : null;
        nodeG.style('opacity', op);
        nodeGHit.style('opacity', op);
        matrixG.selectAll('g.gen-attr-dag-matrix-token').style('opacity', op);
    }

    /**
     * 真实边/矩阵装饰层透明度。
     * 转场期间保持 0（fly 由飞位层表达；crossfade 过程中不显示边格）；
     * 空格/框线/轴角/Self 等同层，稳态再显。
     */
    function setNewOverlayOpacity(opacity: number): void {
        const v = String(opacity);
        linkG.style('opacity', v);
        linkGFront.style('opacity', v);
        matrixG.select('g.gen-attr-dag-matrix-grid').style('opacity', v);
        matrixG.select('g.gen-attr-dag-matrix-axis-corner').style('opacity', v);
        matrixG.selectAll('.gen-attr-dag-matrix-self-label').style('opacity', v);
    }

    /**
     * 转场 fly 字号（与 capsule 同坐标系）：图节点对齐 scss calc；矩阵 chip 对齐固定 11px。
     * `zoomSizeScale`：起点位姿已 remap 到终态 zoom 时，字号同步乘 sk/ek。
     */
    /** 转场内字号度量只读一次：热路径勿对每个 fly 反复 getComputedStyle。 */
    function layoutTransitionFlyFontMetrics(): { parentEm: number; fontScale: number } {
        const parentEm = parseFloat(getComputedStyle(svg.node()!).fontSize);
        const fontScale =
            parseFloat(
                getComputedStyle(stackEl).getPropertyValue('--gen-attr-dag-node-text-font-scale').trim(),
            ) || 0.9;
        if (!(parentEm > 0) || !Number.isFinite(parentEm)) {
            throw new Error(
                'layoutTransitionFlyFontMetrics: svg font-size must be a finite positive length',
            );
        }
        return { parentEm, fontScale };
    }

    function layoutTransitionFlyFontPx(
        elementKey: string,
        node: Pick<DagNode, 'ciVisualScale'>,
        metrics: { parentEm: number; fontScale: number },
        zoomSizeScale = 1,
    ): number {
        if (elementKey.startsWith('matrix-')) {
            return 11 * zoomSizeScale;
        }
        return (
            metrics.parentEm * displayScale * metrics.fontScale * node.ciVisualScale * zoomSizeScale
        );
    }

    function clearLayoutTransitionArtifacts(): void {
        cancelLayoutTransition?.();
        cancelLayoutTransition = null;
        rootG.select('g.gen-attr-dag-layout-transition-fly').remove();
        setTransitionContentHidden(false);
        setNewOverlayOpacity(1);
        syncMatrixLayoutBgClass();
        layoutTransitionLocked = false;
    }

    function commitLayoutModeInstant(mode: DagLayoutMode): void {
        layoutMode = mode;
        matrixPinSteady = null;
        matrixPinFollowActive = false;
        syncStackLayoutDragUi();
        syncMatrixLayoutBgClass();
        if (batchDepth > 0) return;
        syncGraphToSvg();
        fitViewportToContent(true);
    }

    function setLayoutMode(mode: DagLayoutMode): void {
        if (layoutMode === mode) return;
        // 转场中再切：中断当前动画，瞬切到新 layout（避免 select 与 mode 脱节）
        if (layoutTransitionLocked) {
            clearLayoutTransitionArtifacts();
            commitLayoutModeInstant(mode);
            return;
        }
        // text-matrix 并排为复合布局，不做飞位转场。
        if (
            !layoutTransitionEnabled ||
            layoutTransitionDurationMs <= 0 ||
            batchDepth > 0 ||
            nodes.length === 0 ||
            prefersReducedMotion() ||
            isTextMatrixLayout(layoutMode) ||
            isTextMatrixLayout(mode)
        ) {
            clearLayoutTransitionArtifacts();
            commitLayoutModeInstant(mode);
            return;
        }

        const fromMode = layoutMode;
        const fromKind = layoutElementKind(fromMode);
        const toKind = layoutElementKind(mode);
        // 边/格三策略：fly-edge-cell | fly-edge-edge | crossfade（见 dagLayoutEdgeTransitionKind）
        const edgeTransition = dagLayoutEdgeTransitionKind(fromMode, mode);
        const startZoom = d3.zoomTransform(svg.node()!);
        const startPoses = captureTokenPosesFromDom(fromMode);
        const startFillOpacity = captureTokenFillOpacityFromDom(fromMode);
        const startFrames = captureTokenFrameFromDom(fromMode);
        const startEdgeFly =
            edgeTransition === 'crossfade'
                ? { poses: new Map<string, DagLayoutFlyPose>(), frontKeys: new Set<string>() }
                : edgeTransition === 'fly-edge-cell' && fromKind === 'matrix'
                  ? { poses: captureMatrixEdgeCellPosesFromDom(), frontKeys: new Set<string>() }
                  : captureEdgeSeedPosesFromDom();
        const startFlyPoses = startEdgeFly.poses;

        layoutTransitionLocked = true;
        // 只转场节点 + 边/格；crossfade：过程中不显示边格（结束瞬显）；其余用 fly；其它元素稳态再显
        const flyLayerG = rootG
            .append('g')
            .attr('class', 'gen-attr-dag-layout-transition-fly')
            .style('pointer-events', 'none');
        // fly 边/格层在 token fly 之下，避免盖住飞位标签；front 对齐稳态 linkGFront
        const flyEdgeG = flyLayerG.append('g').attr('class', 'gen-attr-dag-layout-transition-fly-edges');
        const flyEdgeGBack = flyEdgeG.append('g').attr('class', 'gen-attr-dag-layout-transition-fly-edges-back');
        const flyEdgeGFront = flyEdgeG
            .append('g')
            .attr('class', 'gen-attr-dag-layout-transition-fly-edges-front');

        // 在 syncGraphToSvg（可能挂上数万矩阵格）之前读 viewport，避免强制大 DOM layout
        const { w, h } = stackLayoutViewportPx(stackEl);
        const flyFontMetrics = layoutTransitionFlyFontMetrics();

        layoutMode = mode;
        matrixPinSteady = null;
        matrixPinFollowActive = false;
        syncStackLayoutDragUi();
        syncMatrixLayoutBgClass(false);
        syncGraphToSvg();

        // 末态仍保持稳态可见：先捕获「此刻画出来的」，再压层（同帧内无中间绘制）
        flyLayerG.style('display', 'none');
        const endZoom = computeFitZoomTransform({
            mode,
            contentBBox: contentBBoxForFit(mode),
            viewportW: w,
            viewportH: h,
            k0: defaultDagZoomK(),
        });
        flyLayerG.style('display', null);

        const endPoses = captureTokenPosesFromDom(mode);
        const endFillOpacity = captureTokenFillOpacityFromDom(mode);
        const endFrames = captureTokenFrameFromDom(mode);
        const endEdgeFly =
            edgeTransition === 'crossfade'
                ? { poses: new Map<string, DagLayoutFlyPose>(), frontKeys: new Set<string>() }
                : edgeTransition === 'fly-edge-cell' && toKind === 'matrix'
                  ? { poses: captureMatrixEdgeCellPosesFromDom(), frontKeys: new Set<string>() }
                  : captureEdgeSeedPosesFromDom();
        const endFlyPoses = endEdgeFly.poses;
        // 起/终任一端在 linkGFront 的边，fly 时仍压在灰边之上
        const flyFrontKeys = new Set<string>([...startEdgeFly.frontKeys, ...endEdgeFly.frontKeys]);
        setTransitionContentHidden(true);
        // 转场中压住真实边/格（fly 由飞位层表达；crossfade 过程中不显示，结束瞬显）
        setNewOverlayOpacity(0);
        // 先钉终态视口：把起点改写到终态 zoom 下「屏幕同位同尺寸」，再只插值节点。
        const startZoomPose = { x: startZoom.x, y: startZoom.y, k: startZoom.k };
        const fromPosesInEndView = remapPosesAcrossZoom(startPoses, startZoomPose, endZoom);
        const fromFlyInEndView = remapFlyPosesAcrossZoom(startFlyPoses, startZoomPose, endZoom);
        const pairs = buildLayoutTransitionPairs({
            fromKind,
            toKind,
            fromPoses: fromPosesInEndView,
            toPoses: endPoses,
        });
        const flyRoles = annotateLayoutTransitionFlyRoles(pairs);
        const flyRankByKey = new Map<string, number>();
        for (const d of links) {
            flyRankByKey.set(
                dagLinkEndpointKey(String(d.source), String(d.target)),
                edgeAttributionShare(d),
            );
        }
        // 按三策略建 fly；crossfade 无 fly 边/格
        const flyPairs =
            edgeTransition === 'fly-edge-cell'
                ? buildEdgeCellFlyPairs({
                      fromKind,
                      toKind,
                      edgePoses: fromKind === 'graph' ? fromFlyInEndView : endFlyPoses,
                      cellPoses: fromKind === 'matrix' ? fromFlyInEndView : endFlyPoses,
                      maxPairs: DAG_LAYOUT_TRANSITION_FLY_MAX,
                      rankByKey: flyRankByKey,
                  })
                : edgeTransition === 'fly-edge-edge'
                  ? buildEdgeEdgeFlyPairs({
                        fromEdgePoses: fromFlyInEndView,
                        toEdgePoses: endFlyPoses,
                        maxPairs: DAG_LAYOUT_TRANSITION_FLY_MAX,
                        rankByKey: flyRankByKey,
                    })
                  : [];

        const nodeById = new Map(nodes.map((n) => [n.id, n] as const));
        const zoomSizeScale = startZoom.k / endZoom.k;
        /**
         * 焦点/多选蓝框：外扩 pad + stroke-width（及虚线周期）。
         * 与稳态对齐——图：`syncNodeStrokeRects` / scss `2×displayScale`；矩阵 chip：pad=1、sw=2。
         * 起点须再乘 {@link zoomSizeScale}（位姿已 remap 到终态 zoom，否则屏上线宽会跳）。
         */
        type FlyFrameChrome = {
            strokePad: number;
            strokeWidth: number;
            layoutSelPad: number;
            layoutSelStrokeWidth: number;
            layoutSelDashOn: number;
            layoutSelDashOff: number;
        };
        const layoutTransitionFrameChrome = (elementKey: string): FlyFrameChrome => {
            if (elementKey.startsWith('matrix-')) {
                return {
                    strokePad: 1,
                    strokeWidth: 2,
                    layoutSelPad: 2,
                    layoutSelStrokeWidth: 1.5,
                    layoutSelDashOn: 4,
                    layoutSelDashOff: 3,
                };
            }
            const ds = displayScale;
            return {
                strokePad: ds,
                strokeWidth: 2 * ds,
                layoutSelPad: 2 * ds,
                layoutSelStrokeWidth: 1.5 * ds,
                layoutSelDashOn: 4 * ds,
                layoutSelDashOff: 3 * ds,
            };
        };
        const scaleFlyFrameChrome = (c: FlyFrameChrome, s: number): FlyFrameChrome => ({
            strokePad: c.strokePad * s,
            strokeWidth: c.strokeWidth * s,
            layoutSelPad: c.layoutSelPad * s,
            layoutSelStrokeWidth: c.layoutSelStrokeWidth * s,
            layoutSelDashOn: c.layoutSelDashOn * s,
            layoutSelDashOff: c.layoutSelDashOff * s,
        });
        type FlyNodeItem = {
            el: SVGGElement;
            selRect: SVGRectElement;
            strokeRect: SVGRectElement;
            fillRect: SVGRectElement;
            textEl: SVGTextElement;
            from: DagNodeLayoutPose;
            to: DagNodeLayoutPose;
            fromFontPx: number;
            toFontPx: number;
            fromFillOp: number;
            toFillOp: number;
            fromChrome: FlyFrameChrome;
            toChrome: FlyFrameChrome;
            cardinality: DagLayoutTransitionCardinality;
            isPrimary: boolean;
        };
        type FlyEdgeItem = {
            g: SVGGElement;
            /** 实心条带 rect，或合成边虚线 line */
            body: SVGRectElement | SVGLineElement;
            bodyIsLine: boolean;
            /**
             * 虚线 stroke-width：边↔边跟 h；边↔格锁图侧边粗。
             * 避免矩阵→图时用格高(~18)当线宽，与图→矩阵（边粗）虚线观感不一致。
             */
            bodyStrokeTracksH: boolean;
            bodyStrokeLockPx: number;
            arrow: SVGGElement;
            from: DagLayoutFlyPose;
            to: DagLayoutFlyPose;
            /** 嵌套箭头 svg 的设计厚度；边↔边热路径按当前 h 再缩放 */
            arrowLayoutThickPx: number;
            arrowTracksH: boolean;
        };
        const flyNodes: FlyNodeItem[] = [];
        const flyEdges: FlyEdgeItem[] = [];
        for (const pair of flyPairs) {
            const color =
                pair.from.arrowScale >= pair.to.arrowScale ? pair.from.color : pair.to.color;
            const dashed = pair.from.dashed || pair.to.dashed;
            // 合成虚线：边↔格锁图侧线宽；dash 周期在 pose 里随 zoom remap（见 flySyntheticDashPair）
            const bodyStrokeTracksH = !dashed || flyArrowTracksPoseHeight(pair.from, pair.to);
            const bodyStrokeLockPx = bodyStrokeTracksH
                ? 0
                : pair.from.arrowScale >= pair.to.arrowScale
                  ? pair.from.h
                  : pair.to.h;
            const bodyStroke0 = bodyStrokeTracksH ? pair.from.h : bodyStrokeLockPx;
            const edgeParent = flyFrontKeys.has(pair.fromKey) ? flyEdgeGFront : flyEdgeGBack;
            const g = edgeParent
                .append('g')
                .attr('class', 'gen-attr-dag-layout-fly-edge')
                .classed('gen-attr-dag-layout-fly-edge--synthetic', dashed)
                .attr('transform', flyPoseTransform(pair.from));
            const body = dashed
                ? g
                      .append('line')
                      .attr('class', 'gen-attr-dag-layout-fly-edge-body')
                      .attr('x1', 0)
                      .attr('y1', pair.from.h / 2)
                      .attr('x2', pair.from.w)
                      .attr('y2', pair.from.h / 2)
                      .attr('stroke', color)
                      .attr('stroke-width', bodyStroke0)
                      .attr('stroke-dasharray', `${pair.from.dashOn} ${pair.from.dashOff}`)
                      .attr('stroke-linecap', 'butt')
                      .attr('opacity', pair.from.opacity)
                : g
                      .append('rect')
                      .attr('class', 'gen-attr-dag-layout-fly-edge-body')
                      .attr('width', pair.from.w)
                      .attr('height', pair.from.h)
                      .attr('rx', 0)
                      .attr('ry', 0)
                      .attr('fill', color)
                      .attr('opacity', pair.from.opacity);
            // 嵌套 svg = 稳态 marker 同 viewBox/path/裁切；厚度取图侧（边↔边为 from，随后跟 h 缩放）
            const thickSide = pair.from.arrowScale >= pair.to.arrowScale ? pair.from : pair.to;
            const arrowLayoutThickPx = thickSide.h;
            const arrowTracksH = flyArrowTracksPoseHeight(pair.from, pair.to);
            const mk = flyArrowMarkerLayout(arrowLayoutThickPx);
            const arrow = g
                .append('g')
                .attr('class', 'gen-attr-dag-layout-fly-edge-arrow')
                .attr(
                    'transform',
                    flyArrowTransform(
                        pair.from,
                        arrowTracksH ? arrowLayoutThickPx : undefined,
                    ),
                )
                .attr('opacity', pair.from.opacity * pair.from.arrowScale);
            const arrowSvg = arrow
                .append('svg')
                .attr('x', mk.x)
                .attr('y', mk.y)
                .attr('width', mk.size)
                .attr('height', mk.size)
                .attr('viewBox', mk.viewBox)
                .attr('overflow', 'hidden');
            arrowSvg
                .append('path')
                .attr('d', mk.pathD)
                .attr('fill', 'none')
                .attr('stroke', color)
                .attr('stroke-width', mk.strokeWidth)
                .attr('stroke-linecap', 'round')
                .attr('stroke-linejoin', 'round');
            flyEdges.push({
                g: g.node()!,
                body: body.node()!,
                bodyIsLine: dashed,
                bodyStrokeTracksH,
                bodyStrokeLockPx,
                arrow: arrow.node()!,
                from: pair.from,
                to: pair.to,
                arrowLayoutThickPx,
                arrowTracksH,
            });
        }
        for (const role of flyRoles) {
            const { pair } = role;
            const srcNode = nodeById.get(pair.from.id) ?? nodeById.get(pair.to.id);
            if (!srcNode) continue;
            const fromFontPx = layoutTransitionFlyFontPx(
                pair.fromKey,
                srcNode,
                flyFontMetrics,
                zoomSizeScale,
            );
            const toFontPx = layoutTransitionFlyFontPx(pair.toKey, srcNode, flyFontMetrics);
            const fromChrome = scaleFlyFrameChrome(
                layoutTransitionFrameChrome(pair.fromKey),
                zoomSizeScale,
            );
            const toChrome = layoutTransitionFrameChrome(pair.toKey);
            const fr = startFrames.get(pair.fromKey);
            const toFr = endFrames.get(pair.toKey);
            const g = flyLayerG.append('g').attr('class', 'gen-attr-dag-node gen-attr-dag-layout-fly-node');
            g.classed('gen-attr-dag-node--prompt', srcNode.step === -1);
            // 焦点框不变：起终点 OR（1↔N 时任一侧有框即保留）
            g.classed('gen-attr-dag-node--selected', !!(fr?.selected || toFr?.selected));
            g.classed('gen-attr-dag-node--hover', !!(fr?.hover || toFr?.hover));
            g.classed(
                'gen-attr-dag-node--layout-selected',
                !!(fr?.layoutSelected || toFr?.layoutSelected),
            );
            const w0 = pair.from.nodeW;
            const h0 = pair.from.nodeH;
            const rx = Math.min(w0, h0) / 2;
            const { strokePad: sp0, layoutSelPad: lp0 } = fromChrome;
            const selRect = g
                .append('rect')
                .attr('class', 'gen-attr-dag-node-layout-sel')
                .attr('x', -lp0)
                .attr('y', -lp0)
                .attr('width', w0 + 2 * lp0)
                .attr('height', h0 + 2 * lp0)
                .attr('rx', rx + lp0)
                .attr('ry', rx + lp0)
                // style 覆盖 scss（无单位 = SVG 用户单位，随 rootG zoom 缩放）
                .style('stroke-width', String(fromChrome.layoutSelStrokeWidth))
                .style(
                    'stroke-dasharray',
                    `${fromChrome.layoutSelDashOn} ${fromChrome.layoutSelDashOff}`,
                );
            const strokeRect = g
                .append('rect')
                .attr('class', 'gen-attr-dag-node-stroke')
                .attr('x', -sp0)
                .attr('y', -sp0)
                .attr('width', w0 + 2 * sp0)
                .attr('height', h0 + 2 * sp0)
                .attr('rx', rx + sp0)
                .attr('ry', rx + sp0)
                // 覆盖 scss 固定 displayScale，使屏上线宽随 zoom remap / 图↔矩阵插值
                .style('stroke-width', String(fromChrome.strokeWidth));
            const fillRect = g
                .append('rect')
                .attr('class', 'gen-attr-dag-node-fill')
                .attr('width', w0)
                .attr('height', h0)
                .attr('rx', rx)
                .attr('ry', rx);
            const textEl = g
                .append('text')
                .attr('class', 'gen-attr-dag-node-text')
                .attr('xml:space', 'preserve')
                .attr('text-anchor', 'middle')
                .attr('dominant-baseline', 'central')
                .attr('x', w0 / 2)
                .attr('y', h0 / 2)
                .style('font-size', `${fromFontPx}px`)
                .text(srcNode.displayLabel);
            const fromFillOp = startFillOpacity.get(pair.fromKey) ?? 1;
            const toFillOp = endFillOpacity.get(pair.toKey) ?? 1;
            g.attr('transform', poseToTransform(pair.from));
            g.style(
                'opacity',
                String(layoutTransitionFlyCombinedOpacity(0, role, fromFillOp, toFillOp)),
            );
            flyNodes.push({
                el: g.node()!,
                selRect: selRect.node()!,
                strokeRect: strokeRect.node()!,
                fillRect: fillRect.node()!,
                textEl: textEl.node()!,
                from: pair.from,
                to: pair.to,
                fromFontPx,
                toFontPx,
                fromFillOp,
                toFillOp,
                fromChrome,
                toChrome,
                cardinality: role.cardinality,
                isPrimary: role.isPrimary,
            });
        }

        applyZoomPose(endZoom);

        const finish = () => {
            cancelLayoutTransition = null;
            flyLayerG.remove();
            setTransitionContentHidden(false);
            setNewOverlayOpacity(1);
            syncMatrixLayoutBgClass(toKind === 'matrix');
            applyZoomPose(endZoom);
            layoutDirty = false;
            userDraggedNodes = false;
            layoutTransitionLocked = false;
            refreshNodeLinkHighlight();
        };

        // 热路径直写 DOM：避免每帧 d3.select/attr/querySelector
        // crossfade：边/格层保持 opacity 0，finish 时再显
        cancelLayoutTransition = runLayoutTransitionClock({
            durationMs: layoutTransitionDurationMs,
            onTick: ({ eased }) => {
                for (const b of flyEdges) {
                    const p = lerpFlyPose(b.from, b.to, eased);
                    b.g.setAttribute('transform', flyPoseTransform(p));
                    if (b.bodyIsLine) {
                        const y = p.h / 2;
                        const sw = b.bodyStrokeTracksH ? p.h : b.bodyStrokeLockPx;
                        b.body.setAttribute('x2', String(p.w));
                        b.body.setAttribute('y1', String(y));
                        b.body.setAttribute('y2', String(y));
                        b.body.setAttribute('stroke-width', String(sw));
                        b.body.setAttribute('stroke-dasharray', `${p.dashOn} ${p.dashOff}`);
                    } else {
                        b.body.setAttribute('width', String(p.w));
                        b.body.setAttribute('height', String(p.h));
                    }
                    b.body.setAttribute('opacity', String(p.opacity));
                    b.arrow.setAttribute(
                        'transform',
                        flyArrowTransform(
                            p,
                            b.arrowTracksH ? b.arrowLayoutThickPx : undefined,
                        ),
                    );
                    b.arrow.setAttribute('opacity', String(p.opacity * p.arrowScale));
                }
                for (const g of flyNodes) {
                    const p = lerpPose(g.from, g.to, eased);
                    const rx = Math.min(p.nodeW, p.nodeH) / 2;
                    const sp = lerp(g.fromChrome.strokePad, g.toChrome.strokePad, eased);
                    const lp = lerp(g.fromChrome.layoutSelPad, g.toChrome.layoutSelPad, eased);
                    g.el.setAttribute('transform', poseToTransform(p));
                    g.el.style.opacity = String(
                        layoutTransitionFlyCombinedOpacity(eased, g, g.fromFillOp, g.toFillOp),
                    );
                    g.selRect.setAttribute('x', String(-lp));
                    g.selRect.setAttribute('y', String(-lp));
                    g.selRect.setAttribute('width', String(p.nodeW + 2 * lp));
                    g.selRect.setAttribute('height', String(p.nodeH + 2 * lp));
                    g.selRect.setAttribute('rx', String(rx + lp));
                    g.selRect.setAttribute('ry', String(rx + lp));
                    g.selRect.style.strokeWidth = String(
                        lerp(
                            g.fromChrome.layoutSelStrokeWidth,
                            g.toChrome.layoutSelStrokeWidth,
                            eased,
                        ),
                    );
                    g.selRect.style.strokeDasharray = `${lerp(g.fromChrome.layoutSelDashOn, g.toChrome.layoutSelDashOn, eased)} ${lerp(g.fromChrome.layoutSelDashOff, g.toChrome.layoutSelDashOff, eased)}`;
                    g.strokeRect.setAttribute('x', String(-sp));
                    g.strokeRect.setAttribute('y', String(-sp));
                    g.strokeRect.setAttribute('width', String(p.nodeW + 2 * sp));
                    g.strokeRect.setAttribute('height', String(p.nodeH + 2 * sp));
                    g.strokeRect.setAttribute('rx', String(rx + sp));
                    g.strokeRect.setAttribute('ry', String(rx + sp));
                    g.strokeRect.style.strokeWidth = String(
                        lerp(g.fromChrome.strokeWidth, g.toChrome.strokeWidth, eased),
                    );
                    g.fillRect.setAttribute('width', String(p.nodeW));
                    g.fillRect.setAttribute('height', String(p.nodeH));
                    g.fillRect.setAttribute('rx', String(rx));
                    g.fillRect.setAttribute('ry', String(rx));
                    g.textEl.setAttribute('x', String(p.nodeW / 2));
                    g.textEl.setAttribute('y', String(p.nodeH / 2));
                    g.textEl.style.fontSize = `${lerp(g.fromFontPx, g.toFontPx, eased)}px`;
                }
            },
            onDone: finish,
        });
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

    /** matrix / text-matrix 轴/方向选项变更后：清 pin、重绘并 fit。 */
    function afterMatrixAxisOptionChange(): void {
        matrixPinSteady = null;
        matrixPinFollowActive = false;
        if (batchDepth > 0 || !layoutShowsMatrix(layoutMode)) return;
        paint();
        refreshNodeLinkHighlight();
        fitViewportToContent(true);
    }

    /** text-matrix：切换左右/上下并排。 */
    function setTextMatrixOrientation(orientation: TextMatrixOrientation): void {
        if (textMatrixOrientation === orientation) return;
        textMatrixOrientation = orientation;
        if (batchDepth > 0 || !isTextMatrixLayout(layoutMode)) return;
        matrixPinSteady = null;
        matrixPinFollowActive = false;
        syncTextMatrixPaneClips();
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
        if (!layoutShowsMatrix(layoutMode)) {
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
        const t = matrixViewZoomTransform();
        const { x: ax, y: ay } = matrixFirstSourceAnchor;
        matrixPinSteady = { x: t.applyX(ax), y: t.applyY(ay) };
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
            !layoutShowsMatrix(layoutMode) ||
            !matrixPinSourceTokens ||
            !matrixPinFollowActive ||
            matrixPinSteady == null ||
            matrixFirstSourceAnchor == null
        ) {
            return;
        }
        const { x: ax, y: ay } = matrixFirstSourceAnchor;
        const k = matrixViewZoomTransform().k;
        const tx = matrixPinSteady.x - k * ax;
        const ty = matrixPinSteady.y - k * ay;
        const next = d3.zoomIdentity.translate(tx, ty).scale(k);
        if (isTextMatrixLayout(layoutMode)) {
            tmMatrixZoom = next;
            matrixZoomG.attr('transform', next.toString());
            return;
        }
        svg.call(zoomBehavior.transform, next);
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
        getSelectedNodeId: () => focus.getSelectedId(),
        getUserFocusId: () => focus.getUserFocusId(),
        setSelectedNodeId,
        setUserFocusNodeId,
        clearNodeSelection,
        setDagPlaybackPlaying,
        setMeasureWidthPx,
        setLayoutMode,
        setLayoutTransitionEnabled(enabled: boolean): void {
            layoutTransitionEnabled = enabled;
        },
        setLayoutTransitionDurationMs(ms: number): void {
            if (!Number.isFinite(ms)) {
                throw new Error('genAttributeDagView: layoutTransitionDurationMs must be finite');
            }
            layoutTransitionDurationMs = Math.max(0, ms);
        },
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
        setTextMatrixOrientation,
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
