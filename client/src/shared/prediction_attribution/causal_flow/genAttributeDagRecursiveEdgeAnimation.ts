import { DAG_MIN_ATTRIBUTION_SHARE } from './genAttributeDagEdgeDisplay';
import { DAG_LIGHTNING_SLOW_MO_DEFAULT, DAG_LIGHTNING_THRESHOLD_TAU_DEFAULT, lightningBoundaryFrameDwellMs } from './genAttributeDagEdgeRenderStrength';
import { parseDagLinkEndpointKey } from './genAttributeDagNodeDim';
import {
    DAG_PROP_LOG_W,
    dagPropLogFmtNodeShareList,
    dagPropLogFmtToken,
    dagPropLogFmtWeight,
    dagPropLogPad,
    dagPropLogPadInt,
    dagPropLogPadWeight,
    logDagPropagationPlaybackLine,
    nodesAtNodeShareTotalForPlaybackLog,
} from './genAttributeDagPropagationPlaybackLog';
import {
    batchAppearanceCostMs,
    computePropagationGroupPacings,
    effectivePropagationWeightTotal,
    DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS,
    type DagRecursiveEdgeReplayPacing,
    type DagReplayPacingMode,
    type PropagationGroupPrep,
    type PropagationPlaybackWeightScope,
} from './genAttributeDagPropagationPlaybackPacing';

export type { DagRecursiveEdgeReplayPacing, DagReplayPacingMode, PropagationPlaybackWeightScope } from './genAttributeDagPropagationPlaybackPacing';
export {
    batchAppearanceCostMs,
    computePropagationGroupPacings,
    effectivePropagationWeightTotal,
    DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_MIN,
    DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_RATIO,
    DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS,
    propagationRunningMaxLookaheadForGroupCount,
} from './genAttributeDagPropagationPlaybackPacing';
export {
    DAG_PROPAGATION_PLAYBACK_LOG_LS_KEY,
    isDagPropagationPlaybackLogEnabled,
    setDagPropagationPlaybackLogEnabled,
} from './genAttributeDagPropagationPlaybackLog';

export type DagRecursiveEdgeAnimationDirection = 'backward' | 'forward';

export type DagPropagationPlaybackOptions = {
    /** forward：prompt 等有 share 节点纳入 batch slide；默认 false → 500ms prompt 首帧后跳过 prompt 批。 */
    forwardSlideSharedNodes: boolean;
    /** forward 边界帧 dwell：传播蓝边峰值闪后线性衰减至稳态蓝边（accent 混白 × τ → 常色 × renderStrength）。 */
    lightningEffect: boolean;
    /**
     * 闪电线性增强分母 τ（0,1]：`opacity = min(1, renderStrength / τ)`。
     * τ 越小越多边顶满；τ=1 等价于仅最强边可达 1（在 renderStrength 已归一前提下）。
     */
    lightningThresholdTau: number;
    /** 闪电效果慢放倍数 [1,10]：dwell 与节奏按此比例拉长。 */
    lightningSlowMo: number;
    /** 闪电效果伴随雷声（雷击 + 背景闷雷）。 */
    lightningSound: boolean;
};

/** 与 {@link genAttributeDagView} 内焦点归因快照同形；供动画 overlay 消费。 */
export type DagFocusAttributionState = {
    activeNodeIds: Set<string>;
    incomingEdgeShareByKey: Map<string, number>;
    downstreamEdgeStrengthByKey: Map<string, number>;
    /** 下游影响传播的节点到达量（焦点为 1）；供红边渲染将每源最强出边刻度钉在 arrive。 */
    downstreamArriveById: Map<string, number>;
    nodeShareById: Map<string, number>;
};

export type DagFocusAttributionComputeOptions = {
    maxIncomingDepth: number;
    includeDownstreamInfluence: boolean;
    allowedEdgeKeys?: ReadonlySet<string>;
};

export type DagFocusAttributionGraphContext = {
    nodesSortedByStepDesc: readonly { id: string; step: number }[];
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

/** 无 {@link CreateDagRecursiveEdgeAnimationControllerOptions.getReplayPacing} 时的兜底 step 间隔（ms）。 */
const DAG_RECURSIVE_EDGE_BATCH_STEP_MS_FALLBACK = 500;

/**
 * 仅用于「Propagated attribution mode」焦点入边的分批显示状态。
 * 两方向均按 `start(tgt)` 分批；backward 从高 tgt 向低 tgt 播放（贴合向上追溯），forward 反向。
 *
 * **传播蓝边强度（设计理念，render 见 {@link genAttributeDagView} `refreshNodeLinkHighlight`）**
 * - 语义值 propagated share 在递推时已乘各 hop 的传导 MI；render 不再 per-edge 乘 target MI。
 * - 蓝边 opacity：帧内 max 归一 × 焦点 MI 上限 × floor；tooltip Link strength 用原始 share。
 *
 * **forward**
 * - 计划始终含全部有 share 的 token（含 prompt）；勾选 slide prompt 时从 `batches[末]` 递减，各批按 {@link batchAppearanceCostMs}。
 * - 未勾选时：先 {@link DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS}ms prompt 稳态首帧（跳过 prompt-only 批），再从首个 gen 批递减至 `batchIndex === 0`。
 * - share 始终用全量焦点快照，动画只改「可见边集合」与归一分母（前沿内 max share）。
 * - 部分帧内焦点不提前高亮/描边（render 延后至末帧 `batchIndex === 0` 稳态），与反向首帧才亮焦点对称。
 * - 同一帧内，已可见边的相对强弱 = share 相对强弱；绝对 opacity 可因分母随新批次变大而变暗。
 * - 末帧 `batchIndex === 0` 时前沿 = 全链、分母 = 全链 max、可见性全开，与无动画稳定态数值一致（收敛）。
 *
 * **backward**
 * - 首帧 `batchIndex === 0`（焦点侧）：固定模拟开销 {@link DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS}ms，焦点红色 slide；与 forward prompt 首帧对称，不参与权重分配。
 * - 蓝线从焦点侧逐批显现：稳态 share + {@link backwardFrontierByBatchIndex} 门控（`batches[0..i]` 递增）。
 * - 未滑过：live stay；已滑过 batch：稳态 stay；非播放链生成 token 不描边；prompt（`step === -1`）若在候选集中则用 live stay（可不在传播链上）。
 * - 首个 prompt 区不参与 slide（无红框）；滑完 gen 链后一跳至末批稳态（全链蓝边），与 forward 跳过 prompt 批对称。
 * - 描边分母为稳态 `max(stay)`。
 * - 当前帧 slide 节点（`--backward-slide`）的入边：红色，强度在本批指向 slide 的入边集合内 max 归一 × 焦点 MI。
 *
 * **播放计划（见 {@link DagPropagationPlaybackPlan}）**
 * - 一批 = 同一 `start` offset 上的节点组 + 该组入边；节点 = 有 Total share 的 token ∪ 入边 tgt（去重）。
 * - 仅作 src 的 prompt 等无入边时仍成批，供 slide / 权重节拍；蓝边仍只来自 `edgeKeys`。
 * - 播放间隔权重（准备阶段一遍）：按**文字顺序**对非焦点 `groupShare/weightMax` 做 running max 归一化；向后看组数 = max({@link DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_MIN}, round(比例×组数))；与播放方向无关。组内含焦点则无 `shareNorm`。
 * - 文序**首部连续** prompt-only 组（首个 prompt 区）：prompt 区内 max 归一；不参与 gen `weightMax` / running max。
 * - `backwardFrontierByBatchIndex` / `forwardFrontierByBatchIndex`：各方向蓝线可见边并集，render 热路径 O(1)。
 * - forward / backward 共用同一 plan；不用 backward 部分快照的 nodeShare 定权重。
 *
 * **播放间隔（见 {@link batchAppearanceCostMs}）**
 * - 间隔 = 当前帧的模拟开销；由本帧 `propagationWeight` 或固定帧类型决定。
 * - 调度：展示本帧 → 等待其开销 → 下一帧（与步进回放「展示前等待」在相邻帧时刻上等价）。
 * - 权重为 0 时开销恰为 0（`step` 下 0ms，不设最小间隔）。
 * - `total` 模式：UI `totalS` 中预留 {@link DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS} 给 backward 首帧；forward 末帧另计同长度固定收尾，其余按权重分配。
 */
/** 传播链动画的一批：同一 offset 上有份额的节点 + 该组传播入边 + 播放元数据。 */
export type DagRecursiveIncomingEdgeBatch = {
    /** 与 {@link buildPropagationPlaybackPlan} 分批键一致（组内节点 `start`）。 */
    groupOffset: number;
    /** 本组代表 token（slide / tooltip）。 */
    tgtId: string;
    /** 本组全部有份额节点（含仅作 src、无入边的 prompt 等）。 */
    nodeIds: readonly string[];
    /** 本组传播链入边（`src->tgt`）。 */
    edgeKeys: string[];
    /**
     * 文字顺序局部归一化权重：share_norm ÷ runningMax(含向后 lookahead 窗口内的非焦点 share_norm)。
     */
    propagationWeight: number;
    /**
     * playback 日志 `share_norm`：prompt 区为 share/promptRegionMax；gen/input 为 share/weightMax。
     * 组内含焦点时为 undefined。
     */
    shareNorm?: number;
    /** 准备阶段：截至本组（含 lookahead 窗口）的链序 running max；prompt 区不适用。 */
    runningMaxNorm?: number;
    /** 组内非焦点 max Total share（prompt 区 playback 日志 `share=`）。 */
    groupShare?: number;
    /** 文序首部连续 prompt-only 组（首个 prompt 区）；playback 日志 `running_max` 打印为 `-`。 */
    isFirstPromptRegion?: boolean;
};

/** 点击焦点时生成的不可变播放计划（批次 + 预计算前沿 + 播放权重）。 */
export type DagPropagationPlaybackPlan = {
    focusId: string;
    batches: DagRecursiveIncomingEdgeBatch[];
    /** gen / input 区非焦点组 Total share 上限（不含 prompt 区；日志 / 对照）。 */
    weightMax: number;
    /** Σ 全部 `batches[].propagationWeight`；total 模式分母。 */
    weightTotal: number;
    /** prompt 区组内 max Total share；无 prompt 区时为 0。 */
    promptRegionMax: number;
    /** Σ prompt 区 propagationWeight（日志）。 */
    promptWeightTotal: number;
    /** Σ gen / input 区 propagationWeight（日志）。 */
    chainWeightTotal: number;
    /** 本计划 running max 前瞻组数（max(MIN, round(比例×组数))）。 */
    runningMaxLookahead: number;
    /** backward：`batchIndex = i` 时可见边 = `batches[0..i]` 并集。 */
    backwardFrontierByBatchIndex: ReadonlyArray<ReadonlySet<string>>;
    /** forward：`batchIndex = i` 时可见边 = `batches[i..末]` 并集。 */
    forwardFrontierByBatchIndex: ReadonlyArray<ReadonlySet<string>>;
};

/** 进行中的播放状态：batchIndex / direction / forwardPromptPreamblePending 可变。 */
export type DagEdgeBatchAnimationState = {
    plan: DagPropagationPlaybackPlan;
    direction: DagRecursiveEdgeAnimationDirection;
    batchIndex: number;
    /** forward 未 slide prompt：首播 500ms 稳态 prompt，再从此 index 递减（已跳过 prompt-only 批）。 */
    forwardPromptPreamblePending: boolean;
    /** 开播时固化；`total` 模式加权分母见 {@link effectivePropagationWeightTotal}。 */
    weightScope: PropagationPlaybackWeightScope;
};

export function tgtIdFromEdgeKey(edgeKey: string): string | null {
    const i = edgeKey.indexOf('->');
    if (i <= 0 || i >= edgeKey.length - 2) return null;
    return edgeKey.slice(i + 2);
}

const EMPTY_EDGE_KEY_SET: ReadonlySet<string> = new Set();

/** backward 当前批：指向 slide 节点的入边（与全图按 tgt 筛等价，仅扫本批 edgeKeys）。 */
export function backwardSlideIncomingEdgeKeysForBatch(
    plan: DagPropagationPlaybackPlan,
    batchIndex: number,
    focusId: string,
): ReadonlySet<string> {
    const batch = plan.batches[batchIndex];
    if (batch == null) return EMPTY_EDGE_KEY_SET;
    const slideTgtId = batchIndex === 0 ? focusId : batch.tgtId;
    const keys = new Set<string>();
    for (const key of batch.edgeKeys) {
        if (tgtIdFromEdgeKey(key) === slideTgtId) keys.add(key);
    }
    return keys;
}

/** 当前 batchIndex、方向下已启用的传播链入边（计划内预计算）。 */
function frontierEdgeKeysAtBatch(
    plan: DagPropagationPlaybackPlan,
    direction: DagRecursiveEdgeAnimationDirection,
    batchIndex: number,
    forwardPromptPreamblePending: boolean,
): ReadonlySet<string> {
    if (direction === 'forward' && forwardPromptPreamblePending) {
        return EMPTY_EDGE_KEY_SET;
    }
    const table =
        direction === 'backward' ? plan.backwardFrontierByBatchIndex : plan.forwardFrontierByBatchIndex;
    return table[batchIndex] ?? EMPTY_EDGE_KEY_SET;
}

export function maxShareInEdgeKeySet(
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
    if (animation == null || animation.plan.focusId !== focusId) return false;
    if (animation.direction === 'backward') {
        const lastBatch = animation.plan.batches.length - 1;
        if (lastBatch <= 0) return false;
        return animation.batchIndex < lastBatch;
    }
    // forward：batchIndex===0 为稳态终帧；其余均属「动画未结束」
    return animation.batchIndex !== 0;
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

function nodeIdsInBatch(batch: DagRecursiveIncomingEdgeBatch): Set<string> {
    return new Set(batch.nodeIds);
}

function batchesInTextOrder(
    batches: readonly DagRecursiveIncomingEdgeBatch[],
): DagRecursiveIncomingEdgeBatch[] {
    return [...batches].sort((a, b) => a.groupOffset - b.groupOffset);
}

/** 文序 prompt-only 组：无传播入边且组内全是 prompt。 */
export function isPromptOnlyPropagationGroup(
    nodeIds: Iterable<string>,
    edgeKeyCount: number,
    isPromptNode: (id: string) => boolean,
): boolean {
    if (edgeKeyCount > 0) return false;
    let hasNode = false;
    for (const id of nodeIds) {
        hasNode = true;
        if (!isPromptNode(id)) return false;
    }
    return hasNode;
}

/**
 * 文序 ASC：从首部起连续 prompt-only 组标记为首个 prompt 区；遇首个非 prompt-only 即结束。
 */
export function markFirstPromptRegionGroupsInTextOrder(
    sortedOffsetsAsc: readonly number[],
    groupAt: (offset: number) => { edgeKeys: string[]; nodeIds: Set<string> },
    isPromptNode: (id: string) => boolean,
): boolean[] {
    let inPrefix = true;
    return sortedOffsetsAsc.map((groupOffset) => {
        const group = groupAt(groupOffset);
        const promptOnly = isPromptOnlyPropagationGroup(
            group.nodeIds,
            group.edgeKeys.length,
            isPromptNode,
        );
        const isFirstPromptRegion = inPrefix && promptOnly;
        if (inPrefix && !promptOnly) inPrefix = false;
        return isFirstPromptRegion;
    });
}

/** 播放序（DESC）下首个 prompt 区之前的最后一批 index；无 prompt 区时为末批。 */
export function lastNonFirstPromptRegionBatchIndex(
    plan: { batches: readonly { isFirstPromptRegion?: boolean }[] },
): number {
    for (let i = plan.batches.length - 1; i >= 0; i--) {
        if (!plan.batches[i]!.isFirstPromptRegion) return i;
    }
    return 0;
}

/** forward 播放序：从末批向 0 递减，跳过文序首部 prompt 区后的首个 gen 批 index。 */
function firstNonPromptRegionBatchIndexFromEnd(plan: DagPropagationPlaybackPlan): number {
    return lastNonFirstPromptRegionBatchIndex(plan);
}

function planHasFirstPromptRegionBatch(plan: DagPropagationPlaybackPlan): boolean {
    return plan.batches.some((batch) => batch.isFirstPromptRegion === true);
}

/** 组内代表 token；并列时取 share 最大，同 share 取 id 字典序最小。 */
function primaryNodeIdForGroup(
    nodeIds: Iterable<string>,
    nodeShareById: ReadonlyMap<string, number>,
): string {
    let bestId = '';
    let bestShare = -1;
    for (const nodeId of nodeIds) {
        const share = nodeShareById.get(nodeId) ?? 0;
        if (share > bestShare || (share === bestShare && nodeId < bestId)) {
            bestShare = share;
            bestId = nodeId;
        }
    }
    return bestId;
}

function incomingEdgeBatchFromGroup(
    groupOffset: number,
    group: { edgeKeys: string[]; nodeIds: Set<string> },
    prep: PropagationGroupPrep,
    nodeShareById: ReadonlyMap<string, number>,
): DagRecursiveIncomingEdgeBatch {
    group.edgeKeys.sort();
    const nodeIds = [...group.nodeIds].sort();
    return {
        groupOffset,
        tgtId: primaryNodeIdForGroup(nodeIds, nodeShareById),
        nodeIds,
        edgeKeys: group.edgeKeys,
        propagationWeight: prep.propagationWeight,
        ...(prep.runningMaxNorm != null ? { runningMaxNorm: prep.runningMaxNorm } : {}),
        ...(prep.shareNorm != null ? { shareNorm: prep.shareNorm } : {}),
        ...(prep.groupShare != null ? { groupShare: prep.groupShare } : {}),
        ...(prep.isFirstPromptRegion ? { isFirstPromptRegion: true } : {}),
    };
}

function buildFrontierEdgeKeysByBatchIndex(
    batches: readonly DagRecursiveIncomingEdgeBatch[],
): Pick<DagPropagationPlaybackPlan, 'backwardFrontierByBatchIndex' | 'forwardFrontierByBatchIndex'> {
    const n = batches.length;
    const backward: Set<string>[] = [];
    const forward: Set<string>[] = [];

    for (let i = 0; i < n; i++) {
        const prev = backward[i - 1];
        backward.push(new Set(prev));
        for (const key of batches[i]!.edgeKeys) backward[i]!.add(key);
    }
    for (let i = n - 1; i >= 0; i--) {
        const next = forward[i + 1];
        forward[i] = new Set(next);
        for (const key of batches[i]!.edgeKeys) forward[i]!.add(key);
    }

    return { backwardFrontierByBatchIndex: backward, forwardFrontierByBatchIndex: forward };
}

/**
 * 传播链播放计划：按 offset 分组；组内节点 = 有 Total share 的 token（非焦点），并并入入边 tgt。
 * backward 从 index 0 递增（蓝线递增），forward 从末批递减（蓝线递增）。
 */
export function buildPropagationPlaybackPlan(
    incomingEdgeShareByKey: Map<string, number>,
    offsetOf: (id: string) => number,
    nodeShareById: ReadonlyMap<string, number>,
    focusId: string,
    isPromptNode: (id: string) => boolean,
): DagPropagationPlaybackPlan | null {
    if (incomingEdgeShareByKey.size === 0) return null;

    const byOffset = new Map<number, { edgeKeys: string[]; nodeIds: Set<string> }>();

    const ensureGroup = (offset: number) => {
        let group = byOffset.get(offset);
        if (group == null) {
            group = { edgeKeys: [], nodeIds: new Set() };
            byOffset.set(offset, group);
        }
        return group;
    };

    for (const edgeKey of incomingEdgeShareByKey.keys()) {
        const tgtId = tgtIdFromEdgeKey(edgeKey);
        if (tgtId == null) continue;
        const group = ensureGroup(offsetOf(tgtId));
        group.edgeKeys.push(edgeKey);
        group.nodeIds.add(tgtId);
    }

    for (const [nodeId, share] of nodeShareById) {
        if (nodeId === focusId) continue;
        if (share < DAG_MIN_ATTRIBUTION_SHARE) continue;
        ensureGroup(offsetOf(nodeId)).nodeIds.add(nodeId);
    }

    if (byOffset.size === 0) return null;

    const sortedOffsetsAsc = [...byOffset.keys()].sort((a, b) => a - b);
    const sortedOffsetsDesc = [...sortedOffsetsAsc].reverse();
    const firstPromptRegionFlags = markFirstPromptRegionGroupsInTextOrder(
        sortedOffsetsAsc,
        (offset) => byOffset.get(offset)!,
        isPromptNode,
    );
    const weightGroups = sortedOffsetsAsc.map((groupOffset, i) => ({
        tgtIds: byOffset.get(groupOffset)!.nodeIds,
        isFirstPromptRegion: firstPromptRegionFlags[i],
    }));
    const {
        groupPreps,
        weightMax,
        weightTotal,
        runningMaxLookahead,
        promptRegionMax,
        promptWeightTotal,
        chainWeightTotal,
    } = computePropagationGroupPacings(weightGroups, nodeShareById, focusId);
    // groupPreps 按文序 ASC；batches 按播放序 DESC（远→近），故播放序下标 j 对应文序下标 n-1-j
    const batches: DagRecursiveIncomingEdgeBatch[] = sortedOffsetsDesc.map((groupOffset, j) => {
        const prep = groupPreps[sortedOffsetsAsc.length - 1 - j]!;
        return incomingEdgeBatchFromGroup(groupOffset, byOffset.get(groupOffset)!, prep, nodeShareById);
    });

    return {
        focusId,
        batches,
        weightMax,
        weightTotal,
        promptRegionMax,
        promptWeightTotal,
        chainWeightTotal,
        runningMaxLookahead,
        ...buildFrontierEdgeKeysByBatchIndex(batches),
    };
}

/**
 * backward 节点 stay 用：沿 {@link backwardFrontierByBatchIndex}（与蓝线同前沿）重算部分快照。
 * 蓝边不经过此函数（与 forward 一样用全量 share + 前沿门控）。
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
        animation.plan.focusId !== focusId ||
        !isRecursiveEdgeAnimationFrontierPartial(animation, focusId) ||
        animation.direction !== 'backward'
    ) {
        return fullState;
    }
    const allowedEdgeKeys = frontierEdgeKeysAtBatch(
        animation.plan,
        animation.direction,
        animation.batchIndex,
        animation.forwardPromptPreamblePending,
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

function passedBatchTgtIdsBeforeIndex(
    batches: readonly DagRecursiveIncomingEdgeBatch[],
    batchIndex: number,
): Set<string> {
    const ids = new Set<string>();
    for (let i = 0; i < batchIndex; i++) {
        for (const id of nodeIdsInBatch(batches[i]!)) ids.add(id);
    }
    return ids;
}

/** 播放计划传播链上的全部 tgt（含同 offset 非代表 token）。 */
function playbackChainNodeIds(batches: readonly DagRecursiveIncomingEdgeBatch[]): Set<string> {
    const onChain = new Set<string>();
    for (const batch of batches) {
        for (const id of nodeIdsInBatch(batch)) onChain.add(id);
    }
    return onChain;
}

function promptNodeIdsFromCtx(ctx: DagFocusAttributionGraphContext): Set<string> {
    const ids = new Set<string>();
    for (const n of ctx.nodesSortedByStepDesc) {
        if (n.step === -1) ids.add(n.id);
    }
    return ids;
}

/**
 * 传播模式描边：backward 动画进行中，未滑过 batch 用 live stay；
 * 已滑过 batch 用稳态 stay；候选中的 prompt 用 live（可不在链上）；其余链外生成 token 不描边。
 */
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
    // ① 与蓝线同前沿的部分快照 → live stay 池
    const atFrontier = resolveFocusAttributionAtFrontier(
        focusId,
        focusState,
        animation,
        computeFocusState,
        ctx,
    );
    const liveById = computeLivePartialStayShareById(
        atFrontier.nodeShareById,
        atFrontier.incomingEdgeShareByKey,
        focusId,
    );
    // ② 全链稳态 stay 池（已滑过 batch 用）
    const steadyById = computeSteadyStateStayShareById(focusState.nodeShareById, focusId);
    const batches = animation!.plan.batches;
    const batchIndex = animation!.batchIndex;
    const passedTgtIds = passedBatchTgtIdsBeforeIndex(batches, batchIndex);
    const onChain = playbackChainNodeIds(batches);
    const promptIds = promptNodeIdsFromCtx(ctx);
    // ③ 合并候选：未滑过→live，已滑过→steady；仅链上或 prompt
    const strokeCandidates = new Set([...liveById.keys(), ...passedTgtIds]);
    const byNodeId = new Map<string, number>();
    for (const nodeId of strokeCandidates) {
        if (!onChain.has(nodeId) && !promptIds.has(nodeId)) continue;
        const stay = passedTgtIds.has(nodeId) ? steadyById.get(nodeId) : liveById.get(nodeId);
        if (stay != null && stay >= DAG_MIN_ATTRIBUTION_SHARE) byNodeId.set(nodeId, stay);
    }
    return byNodeId;
}

export type RecursiveEdgeAnimationRenderOverlay = {
    animationFrontierPartial: boolean;
    anim: DagEdgeBatchAnimationState | null;
    frontierEdgeKeys: ReadonlySet<string> | null;
    /** 与 focusState 同引用；入边 share 恒为全量，可见性由 frontier / edgeVisibility 裁切。 */
    linkFocusState: DagFocusAttributionState | null;
    nodeStrokeShareById: Map<string, number> | null;
    /** backward 部分帧：稳定态 stay 池 max，供描边归一分母；否则 undefined 用当前池 max。 */
    nodeStrokeMaxForRender?: number;
    incomingShareForRender: Map<string, number>;
    incomingMaxForRender: number;
    /** forward 首开帧（未 slide 共享节点）：仅 prompt 稳态描边，无链边、无 slide。 */
    forwardPromptPreambleFrame: boolean;
    /** 当前帧 slide token：forward 为 batch 代表；backward 首帧为焦点。 */
    propagationSlideTgtId: string | null;
    /** 正向传播部分帧：焦点不提前全亮（末帧 partial 结束即恢复）。 */
    deferFocusHighlightDuringAnim: boolean;
    /** 传播部分帧：不为焦点挂 `--selected` 描边（正向全程；反向仅 slide=焦点时）。 */
    suppressFocusSelectedStroke: boolean;
    edgeVisibility(edgeKey: string, inPropagationChain: boolean): number;
};

const INACTIVE_EDGE_VISIBILITY = (_edgeKey: string, _inPropagationChain: boolean): number => 1;

/** backward 首帧 slide = 焦点；无动画 = null；forward 与其余 backward 批 = 当前批代表 token。 */
function resolvePropagationSlideTgtId(
    anim: DagEdgeBatchAnimationState | null,
    animationFrontierPartial: boolean,
    focusId: string,
): string | null {
    if (anim == null || !animationFrontierPartial || anim.forwardPromptPreamblePending) {
        return null;
    }
    if (anim.direction === 'backward' && anim.batchIndex === 0) return focusId;
    const batch = anim.plan.batches[anim.batchIndex];
    if (anim.direction === 'backward' && batch?.isFirstPromptRegion) return null;
    return batch?.tgtId ?? null;
}

export function resolveRecursiveEdgeAnimationRenderOverlay(args: {
    effectiveFocusId: string | null;
    focusState: DagFocusAttributionState | null;
    userAnimationFocusId: string | null;
    animation: DagEdgeBatchAnimationState | null;
    recursiveAttributionEnabled: boolean;
    computeFocusState: ComputeFocusStateFn;
    computeSteadyStateStayShareById: ComputeSteadyStateStayShareByIdFn;
    ctx: DagFocusAttributionGraphContext;
    /** 传播描边/蓝边/动画不展示涉及该节点的部分（如 inactive）。 */
    isPropagationNodeSuppressed?: (nodeId: string) => boolean;
}): RecursiveEdgeAnimationRenderOverlay {
    const {
        effectiveFocusId: focusId,
        focusState,
        userAnimationFocusId,
        animation: anim,
        recursiveAttributionEnabled,
        computeFocusState,
        computeSteadyStateStayShareById,
        ctx,
        isPropagationNodeSuppressed,
    } = args;

    const edgeTouchesSuppressedNode = (edgeKey: string): boolean => {
        if (!isPropagationNodeSuppressed) return false;
        const ends = parseDagLinkEndpointKey(edgeKey);
        if (ends == null) return false;
        return (
            isPropagationNodeSuppressed(ends.srcId) || isPropagationNodeSuppressed(ends.tgtId)
        );
    };

    const emptyIncoming = new Map<string, number>();
    if (
        focusId == null ||
        focusState == null ||
        !recursiveAttributionEnabled ||
        userAnimationFocusId == null ||
        userAnimationFocusId !== focusId ||
        anim == null
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
            nodeStrokeShareById,
            incomingShareForRender: focusState?.incomingEdgeShareByKey ?? emptyIncoming,
            incomingMaxForRender: maxHighlightEdgeShare(focusState?.incomingEdgeShareByKey ?? emptyIncoming),
            propagationSlideTgtId: null,
            forwardPromptPreambleFrame: false,
            deferFocusHighlightDuringAnim: false,
            suppressFocusSelectedStroke: false,
            edgeVisibility: INACTIVE_EDGE_VISIBILITY,
        };
    }

    const animationFrontierPartial =
        anim != null &&
        anim.plan.focusId === userAnimationFocusId &&
        isRecursiveEdgeAnimationFrontierPartial(anim, userAnimationFocusId);
    const frontierEdgeKeys =
        animationFrontierPartial && anim != null
            ? frontierEdgeKeysAtBatch(
                  anim.plan,
                  anim.direction,
                  anim.batchIndex,
                  anim.forwardPromptPreamblePending,
              )
            : null;
    let nodeStrokeShareById = resolveEffectiveStayShareByIdForStroke(
        focusState,
        focusId,
        anim,
        computeFocusState,
        computeSteadyStateStayShareById,
        ctx,
    );
    if (isPropagationNodeSuppressed && nodeStrokeShareById != null) {
        const filtered = new Map<string, number>();
        for (const [nodeId, stay] of nodeStrokeShareById) {
            if (!isPropagationNodeSuppressed(nodeId)) filtered.set(nodeId, stay);
        }
        nodeStrokeShareById = filtered;
    }
    const nodeStrokeMaxForRender =
        animationFrontierPartial && anim?.direction === 'backward'
            ? maxHighlightEdgeShare(computeSteadyStateStayShareById(focusState.nodeShareById, focusId))
            : undefined;
    const incomingShareForRender = focusState.incomingEdgeShareByKey;
    const incomingMaxForRender =
        animationFrontierPartial && frontierEdgeKeys != null
            ? maxShareInEdgeKeySet(incomingShareForRender, frontierEdgeKeys)
            : maxHighlightEdgeShare(incomingShareForRender);
    const forwardPromptPreambleFrame = anim != null && anim.forwardPromptPreamblePending;
    const forwardPartial = animationFrontierPartial && anim?.direction === 'forward';
    const propagationSlideTgtId = resolvePropagationSlideTgtId(
        anim,
        animationFrontierPartial,
        focusId,
    );
    const deferFocusHighlightDuringAnim = forwardPartial;
    const suppressFocusSelectedStroke =
        animationFrontierPartial &&
        focusId != null &&
        (forwardPartial || propagationSlideTgtId === focusId);
    const edgeVisibility = (edgeKey: string, inPropagationChain: boolean): number => {
        if (edgeTouchesSuppressedNode(edgeKey)) return 0;
        if (!animationFrontierPartial || !inPropagationChain) {
            return 1;
        }
        return frontierEdgeKeys?.has(edgeKey) ? 1 : 0;
    };
    return {
        animationFrontierPartial,
        anim,
        frontierEdgeKeys,
        linkFocusState: focusState,
        nodeStrokeShareById,
        nodeStrokeMaxForRender,
        incomingShareForRender,
        incomingMaxForRender,
        forwardPromptPreambleFrame,
        propagationSlideTgtId,
        deferFocusHighlightDuringAnim,
        suppressFocusSelectedStroke,
        edgeVisibility,
    };
}

function logPropagationPlaybackPlanOnStart(args: {
    plan: DagPropagationPlaybackPlan;
    focusId: string;
    direction: DagRecursiveEdgeAnimationDirection;
    initialBatchIndex: number;
    pacing: DagRecursiveEdgeReplayPacing;
    nodeShareById: ReadonlyMap<string, number>;
    tokenLabelOf: (id: string) => string | null;
}): void {
    const { plan, focusId, direction, initialBatchIndex, pacing, nodeShareById, tokenLabelOf } = args;
    const pacingLine =
        pacing.mode === 'step'
            ? `pacing=step stepMs=${pacing.stepMs}`
            : `pacing=total totalS=${pacing.totalS}`;
    logDagPropagationPlaybackLine(
        `${dagPropLogPad('start', DAG_PROP_LOG_W.event)} | focus=${dagPropLogPad(dagPropLogFmtToken(tokenLabelOf(focusId)), DAG_PROP_LOG_W.focus)} | direction=${dagPropLogPad(direction, DAG_PROP_LOG_W.direction)} | batches=${dagPropLogPadInt(plan.batches.length, DAG_PROP_LOG_W.int3)} | initial=${dagPropLogPadInt(initialBatchIndex, DAG_PROP_LOG_W.int3)} | ${pacingLine}`,
    );
    const planTextOrder = batchesInTextOrder(plan.batches);
    const promptBatches = planTextOrder.filter((b) => b.isFirstPromptRegion);
    const chainBatches = planTextOrder.filter((b) => !b.isFirstPromptRegion);

    if (promptBatches.length > 0) {
        logDagPropagationPlaybackLine(
            `${dagPropLogPad('pacing:prompt', DAG_PROP_LOG_W.event)} | regionMax=${dagPropLogPadWeight(plan.promptRegionMax)} | weightTotal=${dagPropLogPadWeight(plan.promptWeightTotal)} | batches=${dagPropLogPadInt(promptBatches.length, DAG_PROP_LOG_W.int3)}`,
        );
        for (let i = 0; i < promptBatches.length; i++) {
            const b = promptBatches[i]!;
            const token = dagPropLogFmtToken(tokenLabelOf(b.tgtId));
            logDagPropagationPlaybackLine(
                `${dagPropLogPad(`plan:prompt[${i}]`, DAG_PROP_LOG_W.event)} | token=${dagPropLogPad(token, DAG_PROP_LOG_W.token)} | share=${dagPropLogPadWeight(b.groupShare)} | weight=${dagPropLogPadWeight(b.propagationWeight)}`,
            );
        }
    }

    const batchTgtIds = new Set<string>();
    for (const b of chainBatches) {
        for (const nodeId of b.nodeIds) batchTgtIds.add(nodeId);
    }
    const refNodes = nodesAtNodeShareTotalForPlaybackLog(nodeShareById, plan.weightMax, {
        excludeFocusId: focusId,
        onlyNodeIds: batchTgtIds,
    });
    logDagPropagationPlaybackLine(
        `${dagPropLogPad('pacing', DAG_PROP_LOG_W.event)} | weightMax=${dagPropLogPadWeight(plan.weightMax)} | weightTotal=${dagPropLogPadWeight(plan.chainWeightTotal)} | lookahead=${dagPropLogPadInt(plan.runningMaxLookahead, DAG_PROP_LOG_W.int3)} | nodes=${dagPropLogFmtNodeShareList(refNodes, tokenLabelOf)}`,
    );
    for (let i = 0; i < chainBatches.length; i++) {
        const b = chainBatches[i]!;
        const token = dagPropLogFmtToken(tokenLabelOf(b.tgtId));
        logDagPropagationPlaybackLine(
            `${dagPropLogPad(`plan[${i}]`, DAG_PROP_LOG_W.event)} | token=${dagPropLogPad(token, DAG_PROP_LOG_W.token)} | share_norm=${dagPropLogPadWeight(b.shareNorm)} | running_max=${dagPropLogPadWeight(b.runningMaxNorm)} | weight=${dagPropLogPadWeight(b.propagationWeight)}`,
        );
    }
}

export type DagPropagationPlaybackPhase = 'idle' | 'playing' | 'paused' | 'ended';

export type DagRecursiveEdgeAnimationController = {
    onClear(): void;
    setDirection(direction: DagRecursiveEdgeAnimationDirection): void;
    getDirection(): DagRecursiveEdgeAnimationDirection;
    getUserAnimationFocusId(): string | null;
    getPlaybackPhase(): DagPropagationPlaybackPhase;
    /** 当前帧自展示以来的时长（ms）；无活跃帧时为 0。 */
    getCurrentFrameElapsedMs(): number;
    canStartPlayback(focusId: string, ctx: DagFocusAttributionGraphContext): boolean;
    startPlayback(focusId: string, ctx: DagFocusAttributionGraphContext): void;
    pausePlayback(): void;
    resumePlayback(): void;
    stopPlayback(): void;
    isPlaybackActive(): boolean;
    resolveRenderOverlay(args: {
        effectiveFocusId: string | null;
        focusState: DagFocusAttributionState | null;
        recursiveAttributionEnabled: boolean;
        ctx: DagFocusAttributionGraphContext;
        isPropagationNodeSuppressed?: (nodeId: string) => boolean;
    }): RecursiveEdgeAnimationRenderOverlay;
    dispose(): void;
};

export type CreateDagRecursiveEdgeAnimationControllerOptions = {
    onTick: () => void;
    onPlaybackPhaseChange?: () => void;
    computeFocusState: ComputeFocusStateFn;
    computeSteadyStateStayShareById: ComputeSteadyStateStayShareByIdFn;
    isRecursiveAttributionEnabled: () => boolean;
    hasNode: (id: string) => boolean;
    offsetOf: (id: string) => number;
    /** 节点 id → 是否 prompt（`step === -1`）。 */
    isPromptNode: (id: string) => boolean;
    /** 节点 id → 界面展示用 token 文案（如 `displayLabel`）。 */
    tokenLabelOf: (id: string) => string | null;
    direction?: DagRecursiveEdgeAnimationDirection;
    /** 开始传播播放时读取；与 DAG 生成回放共用 UI 配置。 */
    getReplayPacing?: () => DagRecursiveEdgeReplayPacing;
    getPropagationPlaybackOptions?: () => DagPropagationPlaybackOptions;
};

export function createDagRecursiveEdgeAnimationController(
    options: CreateDagRecursiveEdgeAnimationControllerOptions,
): DagRecursiveEdgeAnimationController {
    const defaultPacing = (): DagRecursiveEdgeReplayPacing => ({
        mode: 'step',
        stepMs: DAG_RECURSIVE_EDGE_BATCH_STEP_MS_FALLBACK,
        totalS: 7,
    });
    const getReplayPacing = options.getReplayPacing ?? defaultPacing;
    const getPropagationPlaybackOptions =
        options.getPropagationPlaybackOptions ??
        ((): DagPropagationPlaybackOptions => ({
            forwardSlideSharedNodes: false,
            lightningEffect: false,
            lightningThresholdTau: DAG_LIGHTNING_THRESHOLD_TAU_DEFAULT,
            lightningSlowMo: DAG_LIGHTNING_SLOW_MO_DEFAULT,
            lightningSound: false,
        }));
    const notifyPhaseChange = (): void => {
        options.onPlaybackPhaseChange?.();
    };
    let direction: DagRecursiveEdgeAnimationDirection = options.direction ?? 'forward';
    let userAnimationFocusId: string | null = null;
    let animation: DagEdgeBatchAnimationState | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let version = 0;
    let graphCtx: DagFocusAttributionGraphContext | null = null;
    let playbackPhase: DagPropagationPlaybackPhase = 'idle';
    let currentFrameShownAt: number | null = null;

    function setPlaybackPhase(next: DagPropagationPlaybackPhase): void {
        if (playbackPhase === next) return;
        playbackPhase = next;
        notifyPhaseChange();
    }

    function stopPlayback(): void {
        if (animation != null) {
            const s = animation;
            const batch = s.plan.batches[s.batchIndex];
            const lastBatch = s.plan.batches.length - 1;
            logDagPropagationPlaybackLine(
                `${dagPropLogPad('stop', DAG_PROP_LOG_W.event)} | focus=${dagPropLogPad(dagPropLogFmtToken(options.tokenLabelOf(s.plan.focusId)), DAG_PROP_LOG_W.focus)} | frame=${dagPropLogPad(`${s.batchIndex}/${lastBatch}`, DAG_PROP_LOG_W.frame)} | token=${dagPropLogPad(dagPropLogFmtToken(batch != null ? options.tokenLabelOf(batch.tgtId) : null), DAG_PROP_LOG_W.token)}`,
            );
        }
        version++;
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        animation = null;
        userAnimationFocusId = null;
        currentFrameShownAt = null;
        setPlaybackPhase('idle');
    }

    function onClear(): void {
        graphCtx = null;
        stopPlayback();
    }

    function canStartPlayback(focusId: string, ctx: DagFocusAttributionGraphContext): boolean {
        if (!options.isRecursiveAttributionEnabled() || !options.hasNode(focusId)) {
            return false;
        }
        const focusState = options.computeFocusState(
            focusId,
            {
                maxIncomingDepth: Number.POSITIVE_INFINITY,
                includeDownstreamInfluence: false,
            },
            ctx,
        );
        if (focusState == null || focusState.incomingEdgeShareByKey.size === 0) {
            return false;
        }
        return (
            buildPropagationPlaybackPlan(
                focusState.incomingEdgeShareByKey,
                options.offsetOf,
                focusState.nodeShareById,
                focusId,
                options.isPromptNode,
            ) != null
        );
    }

    function startPlayback(focusId: string, ctx: DagFocusAttributionGraphContext): void {
        graphCtx = ctx;
        version++;
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        animation = null;
        if (!canStartPlayback(focusId, ctx)) {
            userAnimationFocusId = null;
            setPlaybackPhase('idle');
            return;
        }
        const focusState = options.computeFocusState(
            focusId,
            {
                maxIncomingDepth: Number.POSITIVE_INFINITY,
                includeDownstreamInfluence: false,
            },
            ctx,
        );
        if (focusState == null) {
            setPlaybackPhase('idle');
            return;
        }
        const forwardSlideSharedNodes = getPropagationPlaybackOptions().forwardSlideSharedNodes;
        const plan = buildPropagationPlaybackPlan(
            focusState.incomingEdgeShareByKey,
            options.offsetOf,
            focusState.nodeShareById,
            focusId,
            options.isPromptNode,
        );
        if (plan == null) {
            setPlaybackPhase('idle');
            return;
        }
        const lastBatch = plan.batches.length - 1;
        let batchIndex = direction === 'backward' ? 0 : Math.max(0, lastBatch);
        let forwardPromptPreamblePending = false;
        if (
            direction === 'forward' &&
            !forwardSlideSharedNodes &&
            planHasFirstPromptRegionBatch(plan)
        ) {
            forwardPromptPreamblePending = true;
            batchIndex = firstNonPromptRegionBatchIndexFromEnd(plan);
        }
        userAnimationFocusId = focusId;
        animation = {
            plan,
            direction,
            batchIndex,
            forwardPromptPreamblePending,
            weightScope: { direction, forwardSlideSharedNodes },
        };
        logPropagationPlaybackPlanOnStart({
            plan,
            focusId,
            direction,
            initialBatchIndex: batchIndex,
            pacing: getReplayPacing(),
            nodeShareById: focusState.nodeShareById,
            tokenLabelOf: options.tokenLabelOf,
        });
        setPlaybackPhase('playing');
        scheduleAnimationStep(focusId);
    }

    function pausePlayback(): void {
        if (playbackPhase !== 'playing') return;
        if (timer !== null) {
            clearTimeout(timer);
            timer = null;
        }
        setPlaybackPhase('paused');
    }

    function resumePlayback(): void {
        if (playbackPhase !== 'paused' && playbackPhase !== 'ended') return;
        const focusId = animation?.plan.focusId;
        if (focusId == null || graphCtx == null) return;
        setPlaybackPhase('playing');
        scheduleAnimationStep(focusId);
    }

    /** 当前帧的模拟开销（ms）；固定帧或本帧 `propagationWeight` 决定。 */
    function appearanceCostMsForCurrentFrame(state: DagEdgeBatchAnimationState): number {
        const lastBatch = state.plan.batches.length - 1;
        const backwardSkippedPromptSteadyEnd =
            state.direction === 'backward' &&
            planHasFirstPromptRegionBatch(state.plan) &&
            lastNonFirstPromptRegionBatchIndex(state.plan) < lastBatch &&
            state.batchIndex === lastBatch;
        if (
            state.forwardPromptPreamblePending ||
            (state.direction === 'backward' && state.batchIndex === 0) ||
            (state.direction === 'forward' && state.batchIndex === 0) ||
            backwardSkippedPromptSteadyEnd
        ) {
            if (state.direction === 'forward' && state.batchIndex === 0) {
                return lightningBoundaryFrameDwellMs(
                    DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS,
                    getPropagationPlaybackOptions().lightningEffect,
                    getPropagationPlaybackOptions().lightningSlowMo,
                );
            }
            return DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS;
        }
        const batch = state.plan.batches[state.batchIndex];
        if (batch == null) return 0;
        return batchAppearanceCostMs(batch, state.plan, getReplayPacing(), state.weightScope);
    }

    /** batchIndex 时间线：backward `0 → lastAnim → last(稳态，跳过 prompt 区)`；forward `preamble? → last → … → 0(稳态)`。 */
    function hasNextBatch(state: DagEdgeBatchAnimationState, lastBatch: number): boolean {
        if (state.direction === 'backward') {
            return state.batchIndex < lastBatch;
        }
        return state.forwardPromptPreamblePending || state.batchIndex > 0;
    }

    function advanceBatchIndex(state: DagEdgeBatchAnimationState): void {
        if (state.direction === 'backward') {
            const lastBatch = state.plan.batches.length - 1;
            const lastAnim = lastNonFirstPromptRegionBatchIndex(state.plan);
            if (state.batchIndex < lastAnim) {
                state.batchIndex += 1;
                return;
            }
            if (state.batchIndex === lastAnim && lastAnim < lastBatch) {
                state.batchIndex = lastBatch;
                return;
            }
            state.batchIndex += 1;
            return;
        }
        if (state.forwardPromptPreamblePending) {
            state.forwardPromptPreamblePending = false;
            return;
        }
        state.batchIndex -= 1;
    }

    function logPropagationFrame(state: DagEdgeBatchAnimationState): void {
        const preamble = state.forwardPromptPreamblePending;
        const batch = preamble ? null : state.plan.batches[state.batchIndex];
        const lastBatch = state.plan.batches.length - 1;
        const appearanceCostMs = appearanceCostMsForCurrentFrame(state);
        const token = preamble
            ? 'prompt'
            : dagPropLogFmtToken(batch?.tgtId != null ? options.tokenLabelOf(batch.tgtId) : null);
        const weight = preamble ? 'fixed' : dagPropLogFmtWeight(batch?.propagationWeight);
        logDagPropagationPlaybackLine(
            `${dagPropLogPad('frame', DAG_PROP_LOG_W.event)} ${dagPropLogPad(`${state.batchIndex}/${lastBatch}`, DAG_PROP_LOG_W.frame)} | token=${dagPropLogPad(token, DAG_PROP_LOG_W.token)} | weight=${dagPropLogPad(weight, DAG_PROP_LOG_W.weight)} | costMs=${dagPropLogPadInt(appearanceCostMs, DAG_PROP_LOG_W.dwell)}`,
        );
    }

    function scheduleAnimationStep(focusId: string): void {
        const state = animation;
        if (!state || state.plan.focusId !== focusId) return;
        const lastBatch = state.plan.batches.length - 1;
        if (state.plan.batches.length === 0) {
            timer = null;
            return;
        }
        if (state.direction === 'backward' && lastBatch <= 0) {
            timer = null;
            return;
        }

        const capturedVersion = ++version;

        const showFrameAndScheduleNext = (): void => {
            if (version !== capturedVersion) return;
            const liveState = animation;
            if (!liveState || liveState.plan.focusId !== focusId) return;

            currentFrameShownAt = performance.now();
            options.onTick();
            logPropagationFrame(liveState);

            const appearanceCostMs = appearanceCostMsForCurrentFrame(liveState);
            timer = setTimeout(() => {
                if (version !== capturedVersion) return;
                const stateAfterCost = animation;
                if (!stateAfterCost || stateAfterCost.plan.focusId !== focusId) return;

                if (!hasNextBatch(stateAfterCost, lastBatch)) {
                    timer = null;
                    setPlaybackPhase('ended');
                    return;
                }
                advanceBatchIndex(stateAfterCost);
                showFrameAndScheduleNext();
            }, appearanceCostMs);
        };

        showFrameAndScheduleNext();
    }

    return {
        onClear,
        setDirection(next: DagRecursiveEdgeAnimationDirection): void {
            if (direction === next) return;
            direction = next;
            stopPlayback();
        },
        getDirection(): DagRecursiveEdgeAnimationDirection {
            return direction;
        },
        getUserAnimationFocusId(): string | null {
            return userAnimationFocusId;
        },
        getPlaybackPhase(): DagPropagationPlaybackPhase {
            return playbackPhase;
        },
        getCurrentFrameElapsedMs(): number {
            if (currentFrameShownAt == null) return 0;
            return Math.max(0, performance.now() - currentFrameShownAt);
        },
        canStartPlayback,
        startPlayback,
        pausePlayback,
        resumePlayback,
        stopPlayback,
        isPlaybackActive(): boolean {
            return timer !== null;
        },
        resolveRenderOverlay(args): RecursiveEdgeAnimationRenderOverlay {
            return resolveRecursiveEdgeAnimationRenderOverlay({
                ...args,
                userAnimationFocusId,
                animation,
                computeFocusState: options.computeFocusState,
                computeSteadyStateStayShareById: options.computeSteadyStateStayShareById,
            });
        },
        dispose(): void {
            onClear();
        },
    };
}
