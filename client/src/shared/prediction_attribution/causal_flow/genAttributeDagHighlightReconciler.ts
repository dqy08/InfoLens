/**
 * DAG Highlight Reconciler：焦点 / 传播 / attention / lightning → 节点与边视觉帧 的唯一所有者。
 *
 * 壳（{@link initGenAttributeDagView}）只调用 `refresh` / `invalidateGrayCache`；
 * 公式见 {@link genAttributeDagLinkHighlight}，矩阵投影见 {@link resolveMatrixHighlightRestyle}。
 */
import * as d3 from 'd3';
import { DirectedGraph } from 'graphology';
import { isOffsetSpanFullyExcluded } from '../core/attributionDisplayModel';
import type { AttentionPlaybackHighlight } from './runAttentionPlayback';
import {
    buildDownstreamArriveScaledRenderStrengthByKey,
    buildMaxNormalizedRenderStrengthByKey,
    lightningBoundaryAnimationDwellMs,
    lightningBoundaryFadeProgress,
    lightningContentRevealProgress,
    lightningDagFlashOverlayOpacity,
    lightningDecayOpacity,
    lightningDecayStrokeCss,
    lightningEdgeRenderOpacity,
} from './genAttributeDagEdgeRenderStrength';
import { computeFocusAttributionState } from './genAttributeDagFocusAttribution';
import type { DagFocusSession, MatrixInteractionTarget } from './genAttributeDagFocusSession';
import {
    resolveMatrixHighlightRestyle,
    type MatrixPropagationHighlightShared,
} from './genAttributeDagMatrixLayout';
import {
    buildGrayRenderStrengthByEdgeKey,
    buildNodeStrokeRenderStrengthById,
    CSS_VAR_DAG_HIGHLIGHT_LINE_IN,
    dagLinkEndpointKey,
    nodeTargetMiRatio,
    resolveDagLinkHighlightDisplay,
} from './genAttributeDagLinkHighlight';
import { buildLinkTitleText } from './genAttributeDagLinkTooltip';
import type { DagNodeLowVisibilityReason } from './genAttributeDagNodeDim';
import {
    backwardSlideIncomingEdgeKeysForBatch,
    DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS,
    type DagFocusAttributionState,
    type DagPropagationPlaybackOptions,
    type DagPropagationPlaybackPhase,
    type DagRecursiveEdgeAnimationDirection,
    type RecursiveEdgeAnimationRenderOverlay,
} from './genAttributeDagRecursiveEdgeAnimation';
import { restyleAttributionMatrixLayout } from './genAttributeDagViewMatrixMode';

export type DagHighlightLayoutMode =
    | 'text-flow'
    | 'linear-arc'
    | 'linear-arc-step-down'
    | 'spiral'
    | 'attribution-matrix';

/** 与 genAttributeDagView 同源：节点 fill/text opacity 档位。 */
const DagNodeOpacityLevel = {
    full: 1,
    weakened: 0.6,
    almostHidden: 0.1,
    hidden: 0,
} as const;

const CSS_VAR_DAG_NODE_RECURSIVE_SHARE = '--gen-attr-dag-node-recursive-share';
const CSS_VAR_DAG_NODE_QUERY_HEAT = '--gen-attr-dag-node-query-heat';
/** 与 genAttributeDagView / _theme-vars 中 lightning 线色一致 */
const CSS_VAR_DAG_LIGHTNING_LINE_COLOR = '--dag-lightning-line-color';

export type DagHighlightReconcilerNode = {
    id: string;
    step: number;
    start: number;
    end: number;
    label: string;
    displayLabel: string;
    dagTargetProb?: number;
};

export type DagHighlightReconcilerLink = {
    source: string;
    target: string;
    normalizedScore?: number;
    mutualInformationRatio?: number;
    attributionShare?: number;
    alignmentNote?: string;
    synthetic?: boolean;
};

export type DagHighlightPropagationPlaybackTooltip = {
    nodeId: string;
    direction: DagRecursiveEdgeAnimationDirection;
};

type FocusAttributionState = DagFocusAttributionState;

function endpointNode<T extends DagHighlightReconcilerNode>(
    ref: string | T,
    graph: DirectedGraph<T>,
): T {
    if (typeof ref === 'object' && ref !== null) return ref;
    const id = String(ref);
    if (!graph.hasNode(id)) {
        throw new Error(`genAttributeDagHighlightReconciler: unknown node id ${id}`);
    }
    return graph.getNodeAttributes(id) as T;
}

function dagLinkMarkerElementId(source: string, target: string): string {
    const s = source.replace(/[^0-9_]/g, '_');
    const t = target.replace(/[^0-9_]/g, '_');
    return `gen-attr-dag-mk-s${s}-t${t}`;
}

export type DagHighlightReconcilerLightningSoundSyncArgs = {
    propagationPlaybackPhase: DagPropagationPlaybackPhase;
    lightningEffectEnabled: boolean;
    lightningSoundEnabled: boolean;
    lightningPreviewActive: boolean;
    boundaryFrameElapsedMs: number;
    anim: {
        direction: DagRecursiveEdgeAnimationDirection;
        batchIndex: number;
        forwardPromptPreamblePending: boolean;
    } | null;
    forwardPromptPreambleFrame: boolean;
};

export type CreateDagHighlightReconcilerDeps<
    T extends DagHighlightReconcilerNode,
    L extends DagHighlightReconcilerLink,
> = {
    graph: DirectedGraph<T>;
    getNodes: () => readonly T[];
    incomingLinksByTarget: Map<string, L[]>;
    focus: DagFocusSession;
    recursiveEdgeAnimation: {
        getPlaybackPhase(): DagPropagationPlaybackPhase;
        getDirection(): DagRecursiveEdgeAnimationDirection;
        getCurrentFrameElapsedMs(): number;
        resolveRenderOverlay(args: {
            effectiveFocusId: string | null;
            focusState: FocusAttributionState | null;
            recursiveAttributionEnabled: boolean;
            ctx: { nodesSortedByStepDesc: readonly T[]; incomingLinksByTarget: Map<string, L[]> };
            isPropagationNodeSuppressed: (nodeId: string) => boolean;
        }): RecursiveEdgeAnimationRenderOverlay;
    };
    focusAttributionCtx: () => {
        nodesSortedByStepDesc: readonly T[];
        incomingLinksByTarget: Map<string, L[]>;
    };

    getNodeSel: () => d3.Selection<SVGGElement, T, SVGGElement, unknown>;
    getNodeHitSel: () => d3.Selection<SVGGElement, T, SVGGElement, unknown>;
    nodeG: d3.Selection<SVGGElement, unknown, null, undefined>;
    nodeGHit: d3.Selection<SVGGElement, unknown, null, undefined>;
    linkG: d3.Selection<SVGGElement, unknown, null, undefined>;
    linkGFront: d3.Selection<SVGGElement, unknown, null, undefined>;
    linkMarkersDefs: d3.Selection<SVGDefsElement, unknown, null, undefined>;
    lightningFlashOverlay: d3.Selection<HTMLElement, unknown, null, undefined>;
    matrixG: d3.Selection<SVGGElement, unknown, null, undefined>;

    effectiveFocusId: () => string | null;
    layoutSelectHoverActive: () => boolean;
    getMarqueePreviewIds: () => ReadonlySet<string>;

    isRecursiveAttributionEnabled: () => boolean;
    isShowDownstreamInfluence: () => boolean;
    isHideExcludedTokens: () => boolean;
    isHideArrowsDuringAttention: () => boolean;
    isDagPlaybackPlaying: () => boolean;
    getAttentionHighlight: () => AttentionPlaybackHighlight;
    isLastTokenAppearanceDwellActive: () => boolean;
    isDecayAttributionToHighSurprisalTargetEnabled: () => boolean;
    getPropagationPlaybackOptions: () => DagPropagationPlaybackOptions;
    getDagExcludeIntervals: () => readonly [number, number][];
    getLayoutMode: () => DagHighlightLayoutMode;

    dimInactiveTokensEffective: () => boolean;
    nodeLowVisibilityReasonFor: (
        node: T,
        focusId: string | null,
        focusState: FocusAttributionState | null,
        dimEffective?: boolean,
    ) => DagNodeLowVisibilityReason | null;
    isNodeInactiveForDim: (
        nodeId: string,
        focusId: string | null,
        focusState: FocusAttributionState | null,
        dimEffective?: boolean,
    ) => boolean;

    matrixRowNodes: () => T[];
    matrixColNodes: () => T[];
    matrixStaticHighlightTarget: () => MatrixInteractionTarget | null;
    matrixPropagationHighlightActive: () => boolean;
    matrixCommittedRowFocusId: () => string | null;
    matrixRowFocusId: () => string | null;

    syncLayoutForLowVisibilityMembership: (
        focusId: string | null,
        focusState: FocusAttributionState | null,
    ) => void;
    syncTopkTooltip: () => void;
    syncLightningSound: (args: DagHighlightReconcilerLightningSoundSyncArgs) => void;
    cancelPendingLightningStrike: () => void;
    scheduleLightningStrikeDelay: () => void;
};

export type DagHighlightReconciler = {
    refresh(): void;
    invalidateGrayCache(): void;
    getFocusState(): FocusAttributionState | null;
    getLinkFocusState(): FocusAttributionState | null;
    getPropagationPlaybackTooltip(): DagHighlightPropagationPlaybackTooltip | null;
    cancelLightningEffectPreview(): void;
    enterLightningTauPreview(): void;
    exitLightningTauPreview(): void;
    playLightningEffectPreview(): void;
    cancelLightningFadeRaf(): void;
    /** 播放进入 playing 时清预览时钟（与历史 onPlaybackPhaseChange 一致）。 */
    clearLightningPreviewOnPlaybackStart(): void;
};

export function createDagHighlightReconciler<
    T extends DagHighlightReconcilerNode,
    L extends DagHighlightReconcilerLink,
>(deps: CreateDagHighlightReconcilerDeps<T, L>): DagHighlightReconciler {
    let grayRenderCache: Map<string, number> | null = null;
    let currentFocusState: FocusAttributionState | null = null;
    let currentLinkFocusState: FocusAttributionState | null = null;
    let propagationPlaybackTooltip: DagHighlightPropagationPlaybackTooltip | null = null;
    let lightningPreviewStartedAt: number | null = null;
    let lightningTauAdjustPreview = false;
    let lightningFadeRaf: number | null = null;

    const {
        graph,
        incomingLinksByTarget,
        focus,
        recursiveEdgeAnimation,
        focusAttributionCtx,
        nodeG,
        nodeGHit,
        linkG,
        linkGFront,
        linkMarkersDefs,
        lightningFlashOverlay,
        matrixG,
        effectiveFocusId,
        layoutSelectHoverActive,
        getMarqueePreviewIds,
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
        syncTopkTooltip,
        syncLightningSound,
        cancelPendingLightningStrike,
        scheduleLightningStrikeDelay,
    } = deps;

    function cancelLightningFadeRaf(): void {
        if (lightningFadeRaf != null) {
            cancelAnimationFrame(lightningFadeRaf);
            lightningFadeRaf = null;
        }
    }

    function canPreviewLightningEffect(): boolean {
        return (
            deps.getPropagationPlaybackOptions().lightningEffect &&
            deps.isRecursiveAttributionEnabled() &&
            effectiveFocusId() != null &&
            recursiveEdgeAnimation.getPlaybackPhase() !== 'playing'
        );
    }

    function resolvePropagationPlaybackTooltipNodeId(
        animOverlay: RecursiveEdgeAnimationRenderOverlay,
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
                    if (graph.hasNode(id) && (graph.getNodeAttributes(id) as T).step === -1) {
                        return id;
                    }
                }
            }
            return deps.getNodes().find((n) => n.step === -1)?.id ?? null;
        }
        return propagationSlideTgtId ?? anim.plan.batches[anim.batchIndex]?.tgtId ?? null;
    }

    /**
     * 矩阵重上色（仅由 {@link refreshNodeLinkHighlight} 调用）。
     * 视觉投影见 {@link resolveMatrixHighlightRestyle}。
     */
    function refreshMatrixHighlight(
        propagationShared: MatrixPropagationHighlightShared | null,
    ): void {
        if (deps.getLayoutMode() !== 'attribution-matrix') return;
        grayRenderCache ??= buildGrayRenderStrengthByEdgeKey(
            graph,
            incomingLinksByTarget,
            deps.isDecayAttributionToHighSurprisalTargetEnabled(),
        );

        const treatExcludedAsNormalInAttention =
            !deps.isHideExcludedTokens() &&
            (deps.getAttentionHighlight() != null || deps.isLastTokenAppearanceDwellActive());
        const focusId = effectiveFocusId();
        const focusState = currentFocusState;
        const dimEffective = dimInactiveTokensEffective();

        const restyle = resolveMatrixHighlightRestyle({
            graph,
            incomingLinksByTarget,
            rowNodes: matrixRowNodes(),
            colNodes: matrixColNodes(),
            recursiveAttributionEnabled: deps.isRecursiveAttributionEnabled(),
            decayAttributionToHighSurprisalTarget: deps.isDecayAttributionToHighSurprisalTargetEnabled(),
            forwardSlideSharedNodes: deps.getPropagationPlaybackOptions().forwardSlideSharedNodes,
            staticTarget: matrixStaticHighlightTarget(),
            propagationShared,
            propagationHighlightActive: matrixPropagationHighlightActive(),
            userFocusId: focus.getUserFocusId(),
            committedRowFocusId: matrixCommittedRowFocusId(),
            matrixLockedTarget: focus.getMatrixLockedTarget(),
            matrixHoverTarget: focus.getMatrixHoverTarget(),
            rowFocusId: matrixRowFocusId(),
            shouldAlmostHideToken: (n) => {
                const lowVis = nodeLowVisibilityReasonFor(n as T, focusId, focusState, dimEffective);
                return (
                    (!treatExcludedAsNormalInAttention &&
                        isOffsetSpanFullyExcluded(n.start, n.end, deps.getDagExcludeIntervals())) ||
                    lowVis === 'inactive'
                );
            },
        });

        restyleAttributionMatrixLayout({
            matrixG,
            grayOpacityByKey: grayRenderCache,
            cellVisualByKey: restyle.cellVisualByKey,
            rowTokenVisualById: restyle.rowTokenVisualById,
            colTokenVisualById: restyle.colTokenVisualById,
            selfCellOpacityByCol: restyle.selfCellOpacityByCol,
        });
        // tooltip 由 refreshNodeLinkHighlight 末尾统一 sync，此处不重复。
    }

    function cancelLightningEffectPreview(): void {
        if (lightningPreviewStartedAt == null && !lightningTauAdjustPreview) return;
        cancelPendingLightningStrike();
        lightningPreviewStartedAt = null;
        lightningTauAdjustPreview = false;
        cancelLightningFadeRaf();
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
        if (deps.getPropagationPlaybackOptions().lightningSound) {
            scheduleLightningStrikeDelay();
        }
        cancelLightningFadeRaf();
        refreshNodeLinkHighlight();
    }

    function refreshNodeLinkHighlight(): void {
            const nodes = deps.getNodes();
            const nodeSel = deps.getNodeSel();
            const nodeHitSel = deps.getNodeHitSel();
            const recursiveAttributionEnabled = deps.isRecursiveAttributionEnabled();
            const showDownstreamInfluence = deps.isShowDownstreamInfluence();
            const hideExcludedTokens = deps.isHideExcludedTokens();
            const hideArrowsDuringAttention = deps.isHideArrowsDuringAttention();
            const dagPlaybackPlaying = deps.isDagPlaybackPlaying();
            const attentionHighlight = deps.getAttentionHighlight();
            const lastTokenAppearanceDwellActive = deps.isLastTokenAppearanceDwellActive();
            const dagExcludeIntervals = deps.getDagExcludeIntervals();
            const dagDecayAttributionToHighSurprisalTargetEnabled =
                deps.isDecayAttributionToHighSurprisalTargetEnabled();
            const getPropagationPlaybackOptions = deps.getPropagationPlaybackOptions;
            const marqueePreviewIds = getMarqueePreviewIds();

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
                ? nodeTargetMiRatio(graph.getNodeAttributes(focusId) as T)
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
        grayRenderCache ??= buildGrayRenderStrengthByEdgeKey(
            graph,
            incomingLinksByTarget,
            dagDecayAttributionToHighSurprisalTargetEnabled,
        );
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
        const isPropagationSlide = (d: T): boolean =>
            propagationSlideTgtId != null && d.id === propagationSlideTgtId;
        const isBackwardSlide = (d: T): boolean =>
            animOverlay.anim?.direction === 'backward' && isPropagationSlide(d);
        const selectedId = focus.getSelectedId();
        const showFocusSelectedStroke = (d: T): boolean =>
            selectedId === d.id && !(suppressFocusSelectedStroke && d.id === focusId);
        const nodeOnChainForRender = (d: T): boolean => {
            if (!forwardPromptPreambleFrame) return nodeStrokeShareById?.has(d.id) ?? false;
            return d.step === -1 && (nodeStrokeShareById?.has(d.id) ?? false);
        };
        const nodeLowVisReasonById = new Map(
            nodes.map(
                (n) => [n.id, nodeLowVisibilityReasonFor(n, focusId, focusState, dimEffective)] as const,
            ),
        );
        const nodeDisplay = (d: T): string | null =>
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
        const resolveNodeFillOpacity = (d: T): number => {
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
        const resolveNodeQueryHeat = (d: T): string | null => {
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
        const showNodeSelectedStroke = (d: T): boolean => {
            if (attentionHighlight != null) {
                if (kvEstablishedQueries?.has(d.id)) return true;
                return activeQueryIds?.has(d.id) ?? false;
            }
            return showFocusSelectedStroke(d);
        };
        const suppressAttributionChainNodeStyle = attentionHighlight != null;
        const layoutHover = layoutSelectHoverActive();
        const hoveredId = focus.getHoveredId();
        const layoutSelectedIds = focus.getLayoutSelectedIds();
        // 实线悬停框：与 {@link solidFrameFocusId} / tooltip 同源，多选虚线态不下发
        const showFocusHover = (d: T): boolean => {
            if (attentionHighlight != null || layoutHover) return false;
            return hoveredId === d.id;
        };
        const showLayoutHover = (d: T): boolean => {
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
        // 只扫真实边层（linkG / linkGFront），避免误伤无 datum 的临时层。
        const realLinkNodes = (
            linkG.selectAll<SVGGElement, L>('g.gen-attr-dag-link').nodes() as SVGGElement[]
        ).concat(linkGFront.selectAll<SVGGElement, L>('g.gen-attr-dag-link').nodes() as SVGGElement[]);
        d3.selectAll<SVGGElement, L>(realLinkNodes).each(function (d) {
            if (d == null) {
                throw new Error('refreshNodeLinkHighlight: link datum missing on real link layer');
            }
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
                    dagDecayAttributionToHighSurprisalTargetEnabled,
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
            const srcAttrs = graph.getNodeAttributes(srcId) as T;
            const tgtAttrs = graph.getNodeAttributes(tgtId) as T;
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
        if (deps.getLayoutMode() === 'attribution-matrix') {
            const propagationShared: MatrixPropagationHighlightShared | null =
                matrixPropagationHighlightActive() &&
                focusId != null &&
                focusId === focus.getUserFocusId() &&
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

        syncTopkTooltip();

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

    const api: DagHighlightReconciler = {
        refresh: refreshNodeLinkHighlight,
        invalidateGrayCache() {
            grayRenderCache = null;
        },
        getFocusState: () => currentFocusState,
        getLinkFocusState: () => currentLinkFocusState,
        getPropagationPlaybackTooltip: () => propagationPlaybackTooltip,
        cancelLightningEffectPreview,
        enterLightningTauPreview,
        exitLightningTauPreview,
        playLightningEffectPreview,
        cancelLightningFadeRaf,
        clearLightningPreviewOnPlaybackStart() {
            lightningPreviewStartedAt = null;
        },
    };
    return api;
}
