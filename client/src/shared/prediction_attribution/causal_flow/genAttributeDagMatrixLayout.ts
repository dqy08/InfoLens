/**
 * attribution-matrix Layout adapter：高亮投影 + 交互 → Focus session 意图。
 *
 * 几何 paint 仍见 {@link genAttributeDagViewMatrixMode}；本模块拥有「焦点/传播态 → 格与轴视觉」
 * 与 pointer handlers，避免再堆进 genAttributeDagView 闭包。
 */
import { DirectedGraph } from 'graphology';
import { computeMutualInformationRatio } from '../../cross/surprisalMath';
import { DAG_MIN_ATTRIBUTION_SHARE } from './genAttributeDagEdgeDisplay';
import {
    buildDownstreamArriveScaledRenderStrengthByKey,
    buildMaxNormalizedRenderStrengthByKey,
} from './genAttributeDagEdgeRenderStrength';
import {
    computeFocusAttributionState,
    nodeUpstreamPropagationRatio,
    type DagFocusAttributionLink,
    type DagFocusAttributionNode,
} from './genAttributeDagFocusAttribution';
import type {
    DagFocusApplyResult,
    DagFocusSession,
    MatrixInteractionTarget,
} from './genAttributeDagFocusSession';
import type {
    DagFocusAttributionState,
    RecursiveEdgeAnimationRenderOverlay,
} from './genAttributeDagRecursiveEdgeAnimation';
import {
    attributionMatrixCellKey,
    attributionMatrixEdgeEndpoints,
    MATRIX_TOKEN_OPACITY_ALMOST_HIDDEN,
    MATRIX_TOKEN_OPACITY_FULL,
    MATRIX_TOKEN_OPACITY_WEAKENED,
    type MatrixCellVisual,
    type MatrixInteractionHandlers,
    type MatrixTokenVisual,
} from './genAttributeDagViewMatrixMode';

export type MatrixLayoutNode = DagFocusAttributionNode;
export type MatrixLayoutLink = DagFocusAttributionLink;

export type MatrixVisualMaps = {
    cellVisualByKey: Map<string, MatrixCellVisual>;
    rowTokenVisualById: Map<string, MatrixTokenVisual>;
    colTokenVisualById: Map<string, MatrixTokenVisual>;
};

/**
 * text {@link refreshNodeLinkHighlight} 本帧算出的 ↯ 中间态。
 * matrix 高亮只由此入口消费，不再本地 resolve。
 */
export type MatrixPropagationHighlightShared = {
    focusId: string;
    focusState: DagFocusAttributionState;
    animOverlay: RecursiveEdgeAnimationRenderOverlay;
    incomingHighlightRenderByKey: Map<string, number>;
    /** text 同帧：backward 本批 slide 入边 → 红。 */
    backwardSlideIncomingRenderByKey: Map<string, number> | null;
    propagationSlideTgtId: string | null;
};

export type MatrixHighlightRestyle = {
    cellVisualByKey: Map<string, MatrixCellVisual>;
    rowTokenVisualById: Map<string, MatrixTokenVisual>;
    colTokenVisualById: Map<string, MatrixTokenVisual>;
    selfCellOpacityByCol: Map<number, number> | undefined;
};

function nodeTargetMiRatio(node: MatrixLayoutNode): number {
    return computeMutualInformationRatio(node.dagTargetProb);
}

/** 稳定态 stay：nodeShare × (1 − 传导系数)；与 tooltip 份额语义一致。 */
export function computeSteadyStateStayShareById<
    T extends MatrixLayoutNode,
    L extends MatrixLayoutLink,
>(
    nodeShareById: Map<string, number>,
    graph: DirectedGraph<T>,
    incomingLinksByTarget: Map<string, L[]>,
    focusId: string,
    decayAttributionToHighSurprisalTarget: boolean,
): Map<string, number> {
    const byNodeId = new Map<string, number>();
    for (const [nodeId, nodeShare] of nodeShareById) {
        if (nodeId === focusId) continue;
        const node = graph.getNodeAttributes(nodeId) as T;
        const stay =
            nodeShare *
            (1 -
                nodeUpstreamPropagationRatio(
                    node,
                    incomingLinksByTarget,
                    decayAttributionToHighSurprisalTarget,
                ));
        if (stay >= DAG_MIN_ATTRIBUTION_SHARE) byNodeId.set(nodeId, stay);
    }
    return byNodeId;
}

/** Self 行蓝格 opacity：stay 池内 max 归一 + 焦点 MI 刻度，与蓝入边同尺度。 */
export function buildMatrixSelfCellOpacityByCol(
    stayById: Map<string, number>,
    colNodes: readonly MatrixLayoutNode[],
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

function emptyMatrixVisualMaps(): MatrixVisualMaps {
    return {
        cellVisualByKey: new Map(),
        rowTokenVisualById: new Map(),
        colTokenVisualById: new Map(),
    };
}

function weakenUnsetMatrixTokens(
    maps: MatrixVisualMaps,
    rowNodes: readonly MatrixLayoutNode[],
    colNodes: readonly MatrixLayoutNode[],
): void {
    for (const n of rowNodes) {
        if (!maps.rowTokenVisualById.has(n.id)) {
            maps.rowTokenVisualById.set(n.id, { fillOpacity: MATRIX_TOKEN_OPACITY_WEAKENED });
        }
    }
    for (const n of colNodes) {
        if (!maps.colTokenVisualById.has(n.id)) {
            maps.colTokenVisualById.set(n.id, { fillOpacity: MATRIX_TOKEN_OPACITY_WEAKENED });
        }
    }
}

/**
 * 行焦点蓝入边链 → 蓝格 + **列（source）轴**抬亮。
 */
function computeMatrixIncomingChainVisuals<T extends MatrixLayoutNode>(
    graph: DirectedGraph<T>,
    focusId: string,
    incomingRenderByKey: Map<string, number>,
    rowNodes: readonly MatrixLayoutNode[],
    colNodes: readonly MatrixLayoutNode[],
    options?: {
        isEdgeVisible?: (key: string) => boolean;
        showFocusFrame?: boolean;
        chainNodeIds?: ReadonlySet<string> | null;
        slideTgtId?: string | null;
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
        if (id === focusId) return false;
        if (preamble) {
            return (
                graph.hasNode(id) &&
                (graph.getNodeAttributes(id) as T).step === -1 &&
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

    if (showFocusFrame) {
        maps.rowTokenVisualById.set(focusId, {
            fillOpacity: MATRIX_TOKEN_OPACITY_FULL,
            frame: 'solid',
        });
    }

    weakenUnsetMatrixTokens(maps, rowNodes, colNodes);
    return maps;
}

function mergeMatrixTokenVisual(
    a: MatrixTokenVisual | undefined,
    b: MatrixTokenVisual | undefined,
): MatrixTokenVisual | undefined {
    if (a == null) return b;
    if (b == null) return a;
    return {
        fillOpacity: Math.max(a.fillOpacity, b.fillOpacity),
        frame: a.frame === 'solid' || b.frame === 'solid' ? 'solid' : a.frame ?? b.frame,
    };
}

function mergeMatrixVisualMaps(a: MatrixVisualMaps, b: MatrixVisualMaps): MatrixVisualMaps {
    const cellVisualByKey = new Map(a.cellVisualByKey);
    for (const [k, v] of b.cellVisualByKey) cellVisualByKey.set(k, v);
    const rowTokenVisualById = new Map(a.rowTokenVisualById);
    for (const [id, v] of b.rowTokenVisualById) {
        rowTokenVisualById.set(id, mergeMatrixTokenVisual(rowTokenVisualById.get(id), v)!);
    }
    const colTokenVisualById = new Map(a.colTokenVisualById);
    for (const [id, v] of b.colTokenVisualById) {
        colTokenVisualById.set(id, mergeMatrixTokenVisual(colTokenVisualById.get(id), v)!);
    }
    return { cellVisualByKey, rowTokenVisualById, colTokenVisualById };
}

type MatrixVisualComputeOptions = {
    recursiveAttributionEnabled: boolean;
    decayAttributionToHighSurprisalTarget: boolean;
    forwardSlideSharedNodes: boolean;
};

/** 行（目标）：蓝入边 / 上游归因。 */
function computeMatrixRowUpstreamVisuals<T extends MatrixLayoutNode, L extends MatrixLayoutLink>(
    graph: DirectedGraph<T>,
    incomingLinksByTarget: Map<string, L[]>,
    focusId: string,
    rowNodes: readonly MatrixLayoutNode[],
    colNodes: readonly MatrixLayoutNode[],
    options: MatrixVisualComputeOptions,
): MatrixVisualMaps {
    if (!graph.hasNode(focusId)) return emptyMatrixVisualMaps();
    const focusNode = graph.getNodeAttributes(focusId) as T;
    const focusState = computeFocusAttributionState(graph, incomingLinksByTarget, focusId, {
        maxIncomingDepth: options.recursiveAttributionEnabled ? Number.POSITIVE_INFINITY : 1,
        includeDownstreamInfluence: false,
        decayAttributionToHighSurprisalTarget: options.decayAttributionToHighSurprisalTarget,
    });
    if (focusState == null) return emptyMatrixVisualMaps();
    const chainNodeIds = options.recursiveAttributionEnabled
        ? new Set(
              computeSteadyStateStayShareById(
                  focusState.nodeShareById,
                  graph,
                  incomingLinksByTarget,
                  focusId,
                  options.decayAttributionToHighSurprisalTarget,
              ).keys(),
          )
        : focusState.activeNodeIds;
    return computeMatrixIncomingChainVisuals(
        graph,
        focusId,
        buildMaxNormalizedRenderStrengthByKey(
            focusState.incomingEdgeShareByKey,
            nodeTargetMiRatio(focusNode),
        ),
        rowNodes,
        colNodes,
        {
            chainNodeIds,
            highlightStayNodesFill:
                !options.recursiveAttributionEnabled || !options.forwardSlideSharedNodes,
        },
    );
}

/** 列（源）：红出边 / 下游影响。 */
function computeMatrixColDownstreamVisuals<T extends MatrixLayoutNode, L extends MatrixLayoutLink>(
    graph: DirectedGraph<T>,
    incomingLinksByTarget: Map<string, L[]>,
    focusId: string,
    rowNodes: readonly MatrixLayoutNode[],
    colNodes: readonly MatrixLayoutNode[],
    options: MatrixVisualComputeOptions,
): MatrixVisualMaps {
    const maps = emptyMatrixVisualMaps();
    if (!graph.hasNode(focusId)) return maps;
    const focusState = computeFocusAttributionState(graph, incomingLinksByTarget, focusId, {
        maxIncomingDepth: 0,
        includeDownstreamInfluence: true,
        maxOutgoingDepth: options.recursiveAttributionEnabled ? Number.POSITIVE_INFINITY : 1,
        decayAttributionToHighSurprisalTarget: options.decayAttributionToHighSurprisalTarget,
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
    weakenUnsetMatrixTokens(maps, rowNodes, colNodes);
    return maps;
}

function computeMatrixVisuals<T extends MatrixLayoutNode, L extends MatrixLayoutLink>(
    graph: DirectedGraph<T>,
    incomingLinksByTarget: Map<string, L[]>,
    target: MatrixInteractionTarget | null,
    rowNodes: readonly MatrixLayoutNode[],
    colNodes: readonly MatrixLayoutNode[],
    options: MatrixVisualComputeOptions,
): MatrixVisualMaps {
    const maps = emptyMatrixVisualMaps();
    if (target == null) return maps;

    if (target.type === 'cell') {
        const { srcId, tgtId } = target;
        if (graph.hasNode(srcId) && graph.hasNode(tgtId) && graph.hasEdge(srcId, tgtId)) {
            const tgtNode = graph.getNodeAttributes(tgtId) as T;
            const focusState = computeFocusAttributionState(graph, incomingLinksByTarget, tgtId, {
                maxIncomingDepth: 1,
                includeDownstreamInfluence: false,
                decayAttributionToHighSurprisalTarget: options.decayAttributionToHighSurprisalTarget,
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
        weakenUnsetMatrixTokens(maps, rowNodes, colNodes);
        return maps;
    }

    if (target.type === 'row') {
        return computeMatrixRowUpstreamVisuals(
            graph,
            incomingLinksByTarget,
            target.id,
            rowNodes,
            colNodes,
            options,
        );
    }

    if (target.type === 'col') {
        return computeMatrixColDownstreamVisuals(
            graph,
            incomingLinksByTarget,
            target.id,
            rowNodes,
            colNodes,
            options,
        );
    }

    // rowAndCol：蓝行上游 ∪ 红列下游
    const rowMaps = computeMatrixRowUpstreamVisuals(
        graph,
        incomingLinksByTarget,
        target.id,
        rowNodes,
        colNodes,
        options,
    );
    const colMaps = computeMatrixColDownstreamVisuals(
        graph,
        incomingLinksByTarget,
        target.id,
        rowNodes,
        colNodes,
        options,
    );
    return mergeMatrixVisualMaps(rowMaps, colMaps);
}

function applyMatrixHoverFrame(
    maps: MatrixVisualMaps,
    committedRowFocusId: string | null,
    matrixLockedTarget: MatrixInteractionTarget | null,
    matrixHoverTarget: MatrixInteractionTarget | null,
): void {
    if (committedRowFocusId != null || matrixLockedTarget != null) {
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
        else if (hover.type === 'rowAndCol') {
            bump(maps.rowTokenVisualById, hover.id);
            bump(maps.colTokenVisualById, hover.id);
        } else {
            bump(maps.colTokenVisualById, hover.srcId);
            bump(maps.rowTokenVisualById, hover.tgtId);
        }
    }
}

function applyMatrixTokenLowVisibilityOpacity(
    maps: MatrixVisualMaps,
    rowNodes: readonly MatrixLayoutNode[],
    colNodes: readonly MatrixLayoutNode[],
    shouldAlmostHideToken: (n: MatrixLayoutNode) => boolean,
): void {
    const apply = (map: Map<string, MatrixTokenVisual>, n: MatrixLayoutNode) => {
        if (!shouldAlmostHideToken(n)) return;
        const prev = map.get(n.id);
        map.set(n.id, {
            fillOpacity: MATRIX_TOKEN_OPACITY_ALMOST_HIDDEN,
            frame: prev?.frame,
        });
    };
    for (const n of rowNodes) apply(maps.rowTokenVisualById, n);
    for (const n of colNodes) apply(maps.colTokenVisualById, n);
}

function matrixVisualsFromPropagationShared<T extends MatrixLayoutNode>(
    graph: DirectedGraph<T>,
    shared: MatrixPropagationHighlightShared,
    rowNodes: readonly MatrixLayoutNode[],
    colNodes: readonly MatrixLayoutNode[],
    forwardSlideSharedNodesFallback: boolean,
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
              forwardSlideSharedNodesFallback);
    const chainNodeIds =
        animOverlay.nodeStrokeShareById != null
            ? new Set(animOverlay.nodeStrokeShareById.keys())
            : null;
    const isEdgeVisible = (key: string) =>
        animOverlay.edgeVisibility(key, focusState.incomingEdgeShareByKey.has(key)) > 0;
    const maps = computeMatrixIncomingChainVisuals(
        graph,
        focusId,
        incomingHighlightRenderByKey,
        rowNodes,
        colNodes,
        {
            isEdgeVisible,
            showFocusFrame: !animOverlay.deferFocusHighlightDuringAnim,
            chainNodeIds,
            slideTgtId: propagationSlideTgtId,
            highlightStayNodesFill: !forwardSlideSharedNodes,
            forwardPromptPreambleFrame: animOverlay.forwardPromptPreambleFrame,
        },
    );
    if (backwardSlideIncomingRenderByKey != null) {
        for (const [key, opacity] of backwardSlideIncomingRenderByKey) {
            if (!isEdgeVisible(key)) continue;
            maps.cellVisualByKey.set(key, { kind: 'red', opacity });
        }
    }
    return maps;
}

function resolveMatrixSelfCellOpacityByCol<T extends MatrixLayoutNode, L extends MatrixLayoutLink>(
    graph: DirectedGraph<T>,
    incomingLinksByTarget: Map<string, L[]>,
    colNodes: readonly MatrixLayoutNode[],
    rowFocusId: string,
    propagationShared: MatrixPropagationHighlightShared | null,
    decayAttributionToHighSurprisalTarget: boolean,
): Map<number, number> | undefined {
    const focusState =
        propagationShared?.focusState ??
        computeFocusAttributionState(graph, incomingLinksByTarget, rowFocusId, {
            maxIncomingDepth: Number.POSITIVE_INFINITY,
            includeDownstreamInfluence: false,
            decayAttributionToHighSurprisalTarget,
        });
    if (focusState == null) return undefined;
    const stayById =
        propagationShared?.animOverlay.nodeStrokeShareById ??
        computeSteadyStateStayShareById(
            focusState.nodeShareById,
            graph,
            incomingLinksByTarget,
            rowFocusId,
            decayAttributionToHighSurprisalTarget,
        );
    if (stayById.size === 0) return undefined;
    const focusNode = graph.getNodeAttributes(rowFocusId) as T;
    const animOverlay = propagationShared?.animOverlay;
    const maxShareOverride =
        animOverlay?.animationFrontierPartial && !animOverlay.forwardPromptPreambleFrame
            ? animOverlay.nodeStrokeMaxForRender
            : undefined;
    return buildMatrixSelfCellOpacityByCol(
        stayById,
        colNodes,
        nodeTargetMiRatio(focusNode),
        maxShareOverride,
    );
}

export type ResolveMatrixHighlightParams<
    T extends MatrixLayoutNode,
    L extends MatrixLayoutLink,
> = {
    graph: DirectedGraph<T>;
    incomingLinksByTarget: Map<string, L[]>;
    rowNodes: readonly T[];
    colNodes: readonly T[];
    recursiveAttributionEnabled: boolean;
    decayAttributionToHighSurprisalTarget: boolean;
    forwardSlideSharedNodes: boolean;
    staticTarget: MatrixInteractionTarget | null;
    propagationShared: MatrixPropagationHighlightShared | null;
    propagationHighlightActive: boolean;
    userFocusId: string | null;
    committedRowFocusId: string | null;
    matrixLockedTarget: MatrixInteractionTarget | null;
    matrixHoverTarget: MatrixInteractionTarget | null;
    rowFocusId: string | null;
    shouldAlmostHideToken: (n: T) => boolean;
};

/**
 * 矩阵重上色输入 → restyle 所需 maps。
 * ↯：必须带本帧 shared；缺失则抛错（不偷偷重算）。
 */
export function resolveMatrixHighlightRestyle<
    T extends MatrixLayoutNode,
    L extends MatrixLayoutLink,
>(params: ResolveMatrixHighlightParams<T, L>): MatrixHighlightRestyle {
    const {
        graph,
        incomingLinksByTarget,
        rowNodes,
        colNodes,
        recursiveAttributionEnabled,
        decayAttributionToHighSurprisalTarget,
        forwardSlideSharedNodes,
        staticTarget,
        propagationShared,
        propagationHighlightActive,
        userFocusId,
        committedRowFocusId,
        matrixLockedTarget,
        matrixHoverTarget,
        rowFocusId,
        shouldAlmostHideToken,
    } = params;

    let visuals: MatrixVisualMaps;
    if (propagationHighlightActive) {
        if (propagationShared == null || propagationShared.focusId !== userFocusId) {
            throw new Error(
                'genAttributeDagMatrixLayout: matrix ↯ highlight requires shared overlay from refreshNodeLinkHighlight',
            );
        }
        visuals = matrixVisualsFromPropagationShared(
            graph,
            propagationShared,
            rowNodes,
            colNodes,
            forwardSlideSharedNodes,
        );
    } else {
        visuals = computeMatrixVisuals(
            graph,
            incomingLinksByTarget,
            staticTarget,
            rowNodes,
            colNodes,
            {
                recursiveAttributionEnabled,
                decayAttributionToHighSurprisalTarget,
                forwardSlideSharedNodes,
            },
        );
    }
    applyMatrixHoverFrame(visuals, committedRowFocusId, matrixLockedTarget, matrixHoverTarget);
    applyMatrixTokenLowVisibilityOpacity(visuals, rowNodes, colNodes, shouldAlmostHideToken);

    const selfCellOpacityByCol =
        rowFocusId != null
            ? resolveMatrixSelfCellOpacityByCol(
                  graph,
                  incomingLinksByTarget,
                  colNodes,
                  rowFocusId,
                  propagationShared,
                  decayAttributionToHighSurprisalTarget,
              )
            : undefined;

    return {
        cellVisualByKey: visuals.cellVisualByKey,
        rowTokenVisualById: visuals.rowTokenVisualById,
        colTokenVisualById: visuals.colTokenVisualById,
        selfCellOpacityByCol,
    };
}

export type CreateMatrixInteractionHandlersDeps = {
    isInteractionLocked: () => boolean;
    focus: Pick<
        DagFocusSession,
        | 'setMatrixHover'
        | 'clearMatrixHoverIf'
        | 'setHovered'
        | 'getHoveredId'
        | 'toggleMatrixRowFocus'
        | 'toggleMatrixColLock'
        | 'toggleMatrixCellLock'
    >;
    applyFocusPlaybackStop: (result: DagFocusApplyResult) => void;
    refreshHighlight: () => void;
    syncPlayButton: () => void;
    clearSelection: () => void;
};

/** matrix pointer → Focus session 意图；重绘/停播由宿主回调。 */
export function createMatrixInteractionHandlers(
    deps: CreateMatrixInteractionHandlersDeps,
): MatrixInteractionHandlers {
    const {
        isInteractionLocked,
        focus,
        applyFocusPlaybackStop,
        refreshHighlight,
        syncPlayButton,
        clearSelection,
    } = deps;
    return {
        onRowEnter: (id) => {
            if (isInteractionLocked()) return;
            // 行=上游/归因：同步左侧 hovered（上游预览）
            focus.setMatrixHover({ type: 'row', id });
            focus.setHovered(id);
            refreshHighlight();
        },
        onRowLeave: (id) => {
            focus.clearMatrixHoverIf({ type: 'row', id });
            if (focus.getHoveredId() === id) focus.setHovered(null);
            refreshHighlight();
        },
        onRowClick: (id) => {
            if (isInteractionLocked()) return;
            applyFocusPlaybackStop(focus.toggleMatrixRowFocus(id));
            refreshHighlight();
            syncPlayButton();
        },
        onColEnter: (id) => {
            if (isInteractionLocked()) return;
            // 列=下游：不写 hovered（避免左侧走「节点焦点/上游」）；由 reconciler 投影下游态
            focus.setMatrixHover({ type: 'col', id });
            refreshHighlight();
        },
        onColLeave: (id) => {
            focus.clearMatrixHoverIf({ type: 'col', id });
            refreshHighlight();
        },
        onColClick: (id) => {
            if (isInteractionLocked()) return;
            applyFocusPlaybackStop(focus.toggleMatrixColLock(id));
            syncPlayButton();
            refreshHighlight();
        },
        onCellEnter: (srcId, tgtId) => {
            if (isInteractionLocked()) return;
            // 格悬停不写 hoveredId：text 侧只亮对应蓝边（见 highlight reconciler cell-edge-only）
            focus.setMatrixHover({ type: 'cell', srcId, tgtId });
            refreshHighlight();
        },
        onCellLeave: (srcId, tgtId) => {
            focus.clearMatrixHoverIf({ type: 'cell', srcId, tgtId });
            refreshHighlight();
        },
        onCellClick: (srcId, tgtId) => {
            if (isInteractionLocked()) return;
            applyFocusPlaybackStop(focus.toggleMatrixCellLock(srcId, tgtId));
            syncPlayButton();
            refreshHighlight();
        },
        onBackgroundClick: () => {
            clearSelection();
        },
    };
}
