import { DAG_MIN_ATTRIBUTION_SHARE } from './genAttributeDagEdgeDisplay';

export type DagRecursiveEdgeAnimationDirection = 'backward' | 'forward';

/** 与 {@link genAttributeDagView} 内焦点归因快照同形；供动画 overlay 消费。 */
export type DagFocusAttributionState = {
    activeNodeIds: Set<string>;
    incomingEdgeShareByKey: Map<string, number>;
    downstreamEdgeStrengthByKey: Map<string, number>;
    nodeShareById: Map<string, number>;
};

export type DagFocusAttributionComputeOptions = {
    maxIncomingDepth: number;
    includeDownstreamInfluence: boolean;
    allowedEdgeKeys?: ReadonlySet<string>;
};

export type DagFocusAttributionGraphContext = {
    nodesSortedByStepDesc: readonly { id: string }[];
    incomingLinksByTarget: ReadonlyMap<string, readonly unknown[]>;
};

type ComputeFocusStateFn = (
    focusId: string,
    options: DagFocusAttributionComputeOptions,
    ctx: DagFocusAttributionGraphContext,
) => DagFocusAttributionState | null;

type ComputeSteadyStateStayShareByIdFn = (
    nodeShareById: Map<string, number>,
    focusId: string,
) => Map<string, number>;

/** 归因链分批动画：每批停留时长（ms）。仅控制已有箭头 opacity，不新增 UI。
 * forward 时逻辑与生成时的 DAG 播放动画几乎相同，只是播放的箭头是后者的子集（传播链入边）。 */
const DAG_RECURSIVE_EDGE_BATCH_STEP_MS = 500;

/**
 * 仅用于「Propagated attribution mode」焦点入边的分批显示状态。
 * 两方向均按 `start(tgt)` 分批；backward 从高 tgt 向低 tgt 播放（贴合向上追溯），forward 反向。
 *
 * **传播蓝边强度（设计理念，render 见 {@link genAttributeDagView} `refreshNodeLinkHighlight`）**
 * - 语义值 propagated share 在递推时已乘各 hop 的传导 MI；render 不再 per-edge 乘 target MI。
 * - 蓝边 opacity：帧内 max 归一 × 焦点 MI 上限 × floor；tooltip Link strength 用原始 share。
 *
 * **forward**
 * - share 始终用全量焦点快照，动画只改「可见边集合」与归一分母（前沿内 max share）。
 * - 同一帧内，已可见边的相对强弱 = share 相对强弱；绝对 opacity 可因分母随新批次变大而变暗。
 * - 末帧 `batchIndex === 0` 时前沿 = 全链、分母 = 全链 max、可见性全开，与无动画稳定态数值一致（收敛）。
 *
 * **backward**
 * - 部分帧沿前沿重算 share（部分快照）；节点 stay 用 live partial，与 forward 仅门控可见性不同。
 */
export type DagEdgeBatchAnimationState = {
    focusId: string;
    batches: string[][];
    direction: DagRecursiveEdgeAnimationDirection;
    batchIndex: number;
};

export function tgtIdFromEdgeKey(edgeKey: string): string | null {
    const i = edgeKey.indexOf('->');
    if (i <= 0 || i >= edgeKey.length - 2) return null;
    return edgeKey.slice(i + 2);
}

/** 动画前沿：当前 batchIndex 下已启用的传播链入边。 */
function enabledEdgeKeysAtAnimationFrontier(
    batches: string[][],
    direction: DagRecursiveEdgeAnimationDirection,
    batchIndex: number,
): ReadonlySet<string> {
    const keys = new Set<string>();
    for (let i = 0; i < batches.length; i++) {
        const enabled = direction === 'backward' ? i <= batchIndex : i >= batchIndex;
        if (!enabled) continue;
        for (const edgeKey of batches[i] ?? []) keys.add(edgeKey);
    }
    return keys;
}

function maxShareInEdgeKeySet(
    incomingEdgeShareByKey: Map<string, number>,
    edgeKeys: ReadonlySet<string>,
): number {
    let max = 0;
    for (const key of edgeKeys) {
        const share = incomingEdgeShareByKey.get(key);
        if (share != null && share > max) max = share;
    }
    return max;
}

export function maxHighlightEdgeShare(sharesByKey: Map<string, number>): number {
    let max = 0;
    for (const share of sharesByKey.values()) {
        if (share > max) max = share;
    }
    return max;
}

/**
 * backward 动画进行中的节点 stay（描边/提亮用）。
 *
 * 刻意不用稳定态公式 `nodeShare × (1 − propagationMiRatio)`：动画只亮出部分入边，
 * 稳定态 stay 描述的是链全亮后的终态。此处用「当前前沿快照里的 nodeShare，减去该快照
 * 已计入入边的份额之和」，在播放过程中实时反映**当前可见归因**下各节点仍留在链上的量；
 * 动画结束或关动画时改走稳定态 stay（`computeSteadyStateStayShareById`）。
 */
function computeLivePartialStayShareById(
    nodeShareById: Map<string, number>,
    incomingEdgeShareByKey: Map<string, number>,
    focusId: string,
): Map<string, number> {
    const propagatedByTarget = new Map<string, number>();
    for (const [edgeKey, edgeShare] of incomingEdgeShareByKey) {
        const tgtId = tgtIdFromEdgeKey(edgeKey);
        if (tgtId == null) continue;
        propagatedByTarget.set(tgtId, (propagatedByTarget.get(tgtId) ?? 0) + edgeShare);
    }
    const byNodeId = new Map<string, number>();
    for (const [nodeId, nodeShare] of nodeShareById) {
        if (nodeId === focusId) continue;
        const stay = Math.max(0, nodeShare - (propagatedByTarget.get(nodeId) ?? 0));
        if (stay >= DAG_MIN_ATTRIBUTION_SHARE) byNodeId.set(nodeId, stay);
    }
    return byNodeId;
}

export function isRecursiveEdgeAnimationFrontierPartial(
    animation: DagEdgeBatchAnimationState | null,
    focusId: string,
): boolean {
    if (animation == null || animation.focusId !== focusId) return false;
    const lastBatch = animation.batches.length - 1;
    if (lastBatch <= 0) return false;
    return animation.direction === 'backward'
        ? animation.batchIndex < lastBatch
        : animation.batchIndex > 0;
}

function isBackwardRecursiveEdgeAnimationInProgress(
    animation: DagEdgeBatchAnimationState | null,
    focusId: string,
): boolean {
    return (
        animation != null &&
        animation.direction === 'backward' &&
        isRecursiveEdgeAnimationFrontierPartial(animation, focusId)
    );
}

/** 传播链入边按 `start(tgt)` 分批；批次按 offset 降序排列。
 * backward 从 index 0 递增（高 tgt→低 tgt），forward 从末批递减（低 tgt→高 tgt）。 */
export function buildRecursiveIncomingEdgeBatches(
    incomingEdgeShareByKey: Map<string, number>,
    offsetOf: (id: string) => number,
): string[][] {
    if (incomingEdgeShareByKey.size === 0) return [];

    const byOffset = new Map<number, string[]>();
    for (const edgeKey of incomingEdgeShareByKey.keys()) {
        const tgtId = tgtIdFromEdgeKey(edgeKey);
        if (tgtId == null) continue;
        const offset = offsetOf(tgtId);
        const list = byOffset.get(offset);
        if (list) {
            list.push(edgeKey);
        } else {
            byOffset.set(offset, [edgeKey]);
        }
    }

    const sortedOffsets = [...byOffset.keys()].sort((a, b) => b - a);
    return sortedOffsets.map((offset) => {
        const row = byOffset.get(offset)!;
        row.sort();
        return row;
    });
}

/**
 * 动画前沿处的归因快照：backward 部分态沿前沿边集追溯；
 * forward 仍用全量（边可见性由 {@link enabledEdgeKeysAtAnimationFrontier} 单独控制）。
 */
function resolveFocusAttributionAtFrontier(
    focusId: string,
    fullState: DagFocusAttributionState,
    animation: DagEdgeBatchAnimationState | null,
    computeFocusState: ComputeFocusStateFn,
    ctx: DagFocusAttributionGraphContext,
): DagFocusAttributionState {
    if (
        animation == null ||
        animation.focusId !== focusId ||
        !isRecursiveEdgeAnimationFrontierPartial(animation, focusId) ||
        animation.direction !== 'backward'
    ) {
        return fullState;
    }
    const allowedEdgeKeys = enabledEdgeKeysAtAnimationFrontier(
        animation.batches,
        animation.direction,
        animation.batchIndex,
    );
    if (allowedEdgeKeys.size >= fullState.incomingEdgeShareByKey.size) {
        return fullState;
    }
    const partial = computeFocusState(
        focusId,
        {
            maxIncomingDepth: Number.POSITIVE_INFINITY,
            includeDownstreamInfluence: false,
            allowedEdgeKeys,
        },
        ctx,
    );
    return partial ?? fullState;
}

/** 传播模式描边：backward 动画进行中用部分快照的有效 stay，否则稳定态 stay。 */
function resolveEffectiveStayShareByIdForStroke(
    focusState: DagFocusAttributionState,
    focusId: string,
    animation: DagEdgeBatchAnimationState | null,
    computeFocusState: ComputeFocusStateFn,
    computeSteadyStateStayShareById: ComputeSteadyStateStayShareByIdFn,
    ctx: DagFocusAttributionGraphContext,
): Map<string, number> {
    if (!isBackwardRecursiveEdgeAnimationInProgress(animation, focusId)) {
        return computeSteadyStateStayShareById(focusState.nodeShareById, focusId);
    }
    const atFrontier = resolveFocusAttributionAtFrontier(
        focusId,
        focusState,
        animation,
        computeFocusState,
        ctx,
    );
    return computeLivePartialStayShareById(
        atFrontier.nodeShareById,
        atFrontier.incomingEdgeShareByKey,
        focusId,
    );
}

export type RecursiveEdgeAnimationRenderOverlay = {
    animationFrontierPartial: boolean;
    anim: DagEdgeBatchAnimationState | null;
    frontierEdgeKeys: ReadonlySet<string> | null;
    linkFocusState: DagFocusAttributionState | null;
    displayFocusState: DagFocusAttributionState | null;
    nodeStrokeShareById: Map<string, number> | null;
    incomingShareForRender: Map<string, number>;
    incomingMaxForRender: number;
    forwardSlideTgtId: string | null;
    edgeVisibility(edgeKey: string, inPropagationChain: boolean): number;
};

const INACTIVE_EDGE_VISIBILITY = (_edgeKey: string, _inPropagationChain: boolean): number => 1;

export function resolveRecursiveEdgeAnimationRenderOverlay(args: {
    effectiveFocusId: string | null;
    focusState: DagFocusAttributionState | null;
    userAnimationFocusId: string | null;
    animation: DagEdgeBatchAnimationState | null;
    recursiveAttributionEnabled: boolean;
    animationEnabled: boolean;
    computeFocusState: ComputeFocusStateFn;
    computeSteadyStateStayShareById: ComputeSteadyStateStayShareByIdFn;
    ctx: DagFocusAttributionGraphContext;
}): RecursiveEdgeAnimationRenderOverlay {
    const {
        effectiveFocusId: focusId,
        focusState,
        userAnimationFocusId,
        animation: anim,
        recursiveAttributionEnabled,
        animationEnabled,
        computeFocusState,
        computeSteadyStateStayShareById,
        ctx,
    } = args;

    const emptyIncoming = new Map<string, number>();
    if (
        focusId == null ||
        focusState == null ||
        !recursiveAttributionEnabled ||
        !animationEnabled ||
        userAnimationFocusId == null ||
        userAnimationFocusId !== focusId
    ) {
        const nodeStrokeShareById =
            focusId != null && focusState != null && recursiveAttributionEnabled
                ? computeSteadyStateStayShareById(focusState.nodeShareById, focusId)
                : null;
        return {
            animationFrontierPartial: false,
            anim: null,
            frontierEdgeKeys: null,
            linkFocusState: focusState,
            displayFocusState: focusState,
            nodeStrokeShareById,
            incomingShareForRender: focusState?.incomingEdgeShareByKey ?? emptyIncoming,
            incomingMaxForRender: maxHighlightEdgeShare(focusState?.incomingEdgeShareByKey ?? emptyIncoming),
            forwardSlideTgtId: null,
            edgeVisibility: INACTIVE_EDGE_VISIBILITY,
        };
    }

    const animationFrontierPartial =
        anim != null &&
        anim.focusId === userAnimationFocusId &&
        isRecursiveEdgeAnimationFrontierPartial(anim, userAnimationFocusId);
    const frontierEdgeKeys =
        animationFrontierPartial && anim != null
            ? enabledEdgeKeysAtAnimationFrontier(anim.batches, anim.direction, anim.batchIndex)
            : null;
    const displayFocusState = resolveFocusAttributionAtFrontier(
        userAnimationFocusId,
        focusState,
        anim,
        computeFocusState,
        ctx,
    );
    const linkFocusState =
        animationFrontierPartial && anim?.direction === 'backward' ? displayFocusState : focusState;
    const nodeStrokeShareById = resolveEffectiveStayShareByIdForStroke(
        focusState,
        focusId,
        anim,
        computeFocusState,
        computeSteadyStateStayShareById,
        ctx,
    );
    const incomingShareForRender =
        animationFrontierPartial && anim?.direction === 'backward' && displayFocusState != null
            ? displayFocusState.incomingEdgeShareByKey
            : focusState.incomingEdgeShareByKey;
    const incomingMaxForRender =
        animationFrontierPartial && frontierEdgeKeys != null
            ? maxShareInEdgeKeySet(focusState.incomingEdgeShareByKey, frontierEdgeKeys)
            : maxHighlightEdgeShare(incomingShareForRender);
    const forwardSlideTgtId =
        anim?.direction === 'forward' && animationFrontierPartial
            ? tgtIdFromEdgeKey(anim.batches[anim.batchIndex]?.[0] ?? '')
            : null;
    const edgeVisibility = (edgeKey: string, inPropagationChain: boolean): number => {
        if (
            !animationFrontierPartial ||
            anim?.direction !== 'forward' ||
            !inPropagationChain
        ) {
            return 1;
        }
        return frontierEdgeKeys?.has(edgeKey) ? 1 : 0;
    };

    return {
        animationFrontierPartial,
        anim,
        frontierEdgeKeys,
        linkFocusState,
        displayFocusState,
        nodeStrokeShareById,
        incomingShareForRender,
        incomingMaxForRender,
        forwardSlideTgtId,
        edgeVisibility,
    };
}

export type DagRecursiveEdgeAnimationController = {
    onUserSelect(focusId: string, ctx: DagFocusAttributionGraphContext): void;
    onClear(): void;
    setEnabled(enabled: boolean): void;
    setDirection(direction: DagRecursiveEdgeAnimationDirection): void;
    getUserAnimationFocusId(): string | null;
    isEnabled(): boolean;
    resolveRenderOverlay(args: {
        effectiveFocusId: string | null;
        focusState: DagFocusAttributionState | null;
        recursiveAttributionEnabled: boolean;
        ctx: DagFocusAttributionGraphContext;
    }): RecursiveEdgeAnimationRenderOverlay;
    stopAnimation(): void;
    dispose(): void;
};

export type CreateDagRecursiveEdgeAnimationControllerOptions = {
    onTick: () => void;
    computeFocusState: ComputeFocusStateFn;
    computeSteadyStateStayShareById: ComputeSteadyStateStayShareByIdFn;
    isRecursiveAttributionEnabled: () => boolean;
    hasNode: (id: string) => boolean;
    offsetOf: (id: string) => number;
    enabled?: boolean;
    direction?: DagRecursiveEdgeAnimationDirection;
    stepMs?: number;
};

export function createDagRecursiveEdgeAnimationController(
    options: CreateDagRecursiveEdgeAnimationControllerOptions,
): DagRecursiveEdgeAnimationController {
    const stepMs = options.stepMs ?? DAG_RECURSIVE_EDGE_BATCH_STEP_MS;
    let enabled = options.enabled ?? true;
    let direction: DagRecursiveEdgeAnimationDirection = options.direction ?? 'backward';
    let userAnimationFocusId: string | null = null;
    let animation: DagEdgeBatchAnimationState | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let version = 0;
    let graphCtx: DagFocusAttributionGraphContext | null = null;

    function stopAnimation(): void {
        version++;
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        animation = null;
    }

    function onClear(): void {
        userAnimationFocusId = null;
        stopAnimation();
        graphCtx = null;
    }

    function beginUserClickAnimation(focusId: string): void {
        stopAnimation();
        if (!enabled || !options.isRecursiveAttributionEnabled() || !options.hasNode(focusId) || graphCtx == null) {
            return;
        }
        const focusState = options.computeFocusState(
            focusId,
            {
                maxIncomingDepth: Number.POSITIVE_INFINITY,
                includeDownstreamInfluence: false,
            },
            graphCtx,
        );
        if (focusState == null || focusState.incomingEdgeShareByKey.size === 0) {
            return;
        }
        const batches = buildRecursiveIncomingEdgeBatches(focusState.incomingEdgeShareByKey, options.offsetOf);
        const initialBatchIndex = direction === 'backward' ? 0 : Math.max(0, batches.length - 1);
        animation = {
            focusId,
            batches,
            direction,
            batchIndex: initialBatchIndex,
        };
        scheduleAnimationStep(focusId);
    }

    function scheduleAnimationStep(focusId: string): void {
        const state = animation;
        if (!state || state.focusId !== focusId) return;
        const lastBatch = state.batches.length - 1;
        if (lastBatch <= 0) {
            timer = null;
            return;
        }

        const v = ++version;
        const tick = (): void => {
            if (version !== v) return;
            const s = animation;
            if (!s || s.focusId !== focusId) return;
            options.onTick();

            if (s.direction === 'backward') {
                if (s.batchIndex < lastBatch) {
                    s.batchIndex += 1;
                } else {
                    timer = null;
                    options.onTick();
                    return;
                }
            } else if (s.batchIndex > 0) {
                s.batchIndex -= 1;
            } else {
                timer = null;
                options.onTick();
                return;
            }

            timer = setTimeout(tick, stepMs);
        };

        timer = setTimeout(tick, stepMs);
    }

    return {
        onUserSelect(focusId: string, ctx: DagFocusAttributionGraphContext): void {
            graphCtx = ctx;
            userAnimationFocusId = focusId;
            beginUserClickAnimation(focusId);
        },
        onClear,
        setEnabled(next: boolean): void {
            if (enabled === next) return;
            enabled = next;
            if (!enabled) stopAnimation();
        },
        setDirection(next: DagRecursiveEdgeAnimationDirection): void {
            if (direction === next) return;
            direction = next;
            stopAnimation();
        },
        getUserAnimationFocusId(): string | null {
            return userAnimationFocusId;
        },
        isEnabled(): boolean {
            return enabled;
        },
        resolveRenderOverlay(args): RecursiveEdgeAnimationRenderOverlay {
            return resolveRecursiveEdgeAnimationRenderOverlay({
                ...args,
                userAnimationFocusId,
                animation,
                animationEnabled: enabled,
                computeFocusState: options.computeFocusState,
                computeSteadyStateStayShareById: options.computeSteadyStateStayShareById,
            });
        },
        stopAnimation,
        dispose(): void {
            onClear();
        },
    };
}
