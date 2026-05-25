import { DAG_MIN_ATTRIBUTION_SHARE } from './genAttributeDagEdgeDisplay';

export type DagRecursiveEdgeAnimationDirection = 'backward' | 'forward';

/** forward 专有第 0 帧：仅 prompt（稳态描边/归一），无传播链边。 */
export const FORWARD_PROMPT_BATCH_INDEX = -1;

/** forward prompt 第 0 帧固定停留（ms），不参与 Play speed 权重分配。 */
const FORWARD_PROMPT_FRAME_DWELL_MS = 500;

/** 链序 running max 前瞻：lookahead = max(MIN, round(RATIO × 传播层数))。 */
//决定了动画前期的播放速度，值越小，前面部分播放速度越慢
export const DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_RATIO = 0.1;
export const DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_MIN = 2;

/** 与 {@link computePropagationLayerPacings} 一致：按层数算向后看的层数。 */
export function propagationRunningMaxLookaheadForLayerCount(layerCount: number): number {
    if (layerCount <= 0) return 0;
    return Math.max(
        DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_MIN,
        Math.round(DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_RATIO * layerCount),
    );
}

/** forward {@link FORWARD_PROMPT_BATCH_INDEX} 帧：仅展示 prompt，外观与稳态一致。 */
export function isForwardPromptOnlyBatchIndex(
    direction: DagRecursiveEdgeAnimationDirection,
    batchIndex: number,
): boolean {
    return direction === 'forward' && batchIndex === FORWARD_PROMPT_BATCH_INDEX;
}

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

/** 无 {@link CreateDagRecursiveEdgeAnimationControllerOptions.getReplayPacing} 时的兜底 step 间隔（ms）。 */
const DAG_RECURSIVE_EDGE_BATCH_STEP_MS_FALLBACK = 500;

/** 浏览器控制台调试前缀；过滤：`dag-prop`。 */
const DAG_PROPAGATION_PLAYBACK_LOG = '[dag-prop]';

/** playback 日志最小列宽（不足则填充；超出不截断）。 */
const DAG_PROP_LOG_W = {
    event: 7,
    frame: 6,
    token: 10,
    weight: 7,
    dwell: 5,
    focus: 10,
    direction: 8,
    int3: 3,
} as const;

/** localStorage：`localStorage.setItem('info_radar.dag_propagation_playback_log', '1')` */
export const DAG_PROPAGATION_PLAYBACK_LOG_LS_KEY = 'info_radar.dag_propagation_playback_log';

export function isDagPropagationPlaybackLogEnabled(): boolean {
    if (typeof globalThis === 'undefined') return false;
    const g = globalThis as typeof globalThis & { __DAG_PROPAGATION_PLAYBACK_LOG__?: boolean };
    if (g.__DAG_PROPAGATION_PLAYBACK_LOG__ === true) return true;
    try {
        return localStorage.getItem(DAG_PROPAGATION_PLAYBACK_LOG_LS_KEY) === '1';
    } catch {
        return false;
    }
}

/** 控制台：`infoRadar.dagPropagationPlaybackLog(true)` */
export function setDagPropagationPlaybackLogEnabled(enabled: boolean): void {
    if (typeof globalThis !== 'undefined') {
        (globalThis as typeof globalThis & { __DAG_PROPAGATION_PLAYBACK_LOG__?: boolean }).__DAG_PROPAGATION_PLAYBACK_LOG__ =
            enabled;
    }
    try {
        if (enabled) localStorage.setItem(DAG_PROPAGATION_PLAYBACK_LOG_LS_KEY, '1');
        else localStorage.removeItem(DAG_PROPAGATION_PLAYBACK_LOG_LS_KEY);
    } catch {
        /* private mode / disabled storage */
    }
}

function playbackLogLine(line: string): void {
    if (!isDagPropagationPlaybackLogEnabled()) return;
    console.log(`${DAG_PROPAGATION_PLAYBACK_LOG} ${line}`);
}

if (typeof window !== 'undefined') {
    const w = window as Window & { infoRadar?: Record<string, unknown> };
    w.infoRadar = { ...w.infoRadar, dagPropagationPlaybackLog: setDagPropagationPlaybackLogEnabled };
}

function playbackFmtToken(label: string | null): string {
    return label ?? '?';
}

function playbackFmtWeight(w: number | undefined): string {
    return w != null ? w.toFixed(4) : '-';
}

function playbackPad(value: string, width: number): string {
    return value.length >= width ? value : value.padEnd(width, ' ');
}

function playbackPadInt(value: number, width: number): string {
    const s = String(value);
    return s.length >= width ? s : s.padStart(width, ' ');
}

function playbackPadWeight(w: number | undefined): string {
    return playbackPad(playbackFmtWeight(w), DAG_PROP_LOG_W.weight);
}

function playbackFmtNodeShareList(
    entries: readonly NodeShareEntry[],
    tokenLabelOf: (id: string) => string | null,
): string {
    if (entries.length === 0) return '-';
    return entries
        .map((e) => `${playbackFmtToken(tokenLabelOf(e.id))}(${playbackFmtWeight(e.share)})`)
        .join(', ');
}

/** 与 UI「DAG replay speed」一致。 */
export type DagReplayPacingMode = 'total' | 'step';

export type DagRecursiveEdgeReplayPacing = {
    mode: DagReplayPacingMode;
    /** `step`：单步名义间隔（ms），实际间隔 = `propagationWeight × stepMs`。 */
    stepMs: number;
    /** `total`：整段动画名义总时长（s），各步按权重占比分配。 */
    totalS: number;
};

/**
 * **当前帧**展示完成后的停留时长（ms），再切到下一批。
 * - `step`：`propagationWeight × stepMs`
 * - `total`：`(propagationWeight / weightTotal) × totalS`（权重全 0 时均分 `totalS`）
 */
export function batchPlaybackDelayMs(
    batch: DagRecursiveIncomingEdgeBatch,
    plan: Pick<DagPropagationPlaybackPlan, 'batches' | 'weightTotal'>,
    pacing: DagRecursiveEdgeReplayPacing,
): number {
    const w = batch.propagationWeight;
    if (pacing.mode === 'step') {
        return Math.round(w * pacing.stepMs);
    }
    const totalWeight = plan.weightTotal;
    const totalMs = pacing.totalS * 1000;
    if (totalWeight <= 0) {
        const intervalCount = Math.max(0, plan.batches.length - 1);
        return intervalCount > 0 ? Math.round(totalMs / intervalCount) : 0;
    }
    return Math.round((w / totalWeight) * totalMs);
}

/**
 * 仅用于「Propagated attribution mode」焦点入边的分批显示状态。
 * 两方向均按 `start(tgt)` 分批；backward 从高 tgt 向低 tgt 播放（贴合向上追溯），forward 反向。
 *
 * **传播蓝边强度（设计理念，render 见 {@link genAttributeDagView} `refreshNodeLinkHighlight`）**
 * - 语义值 propagated share 在递推时已乘各 hop 的传导 MI；render 不再 per-edge 乘 target MI。
 * - 蓝边 opacity：帧内 max 归一 × 焦点 MI 上限 × floor；tooltip Link strength 用原始 share。
 *
 * **forward**
 * - 第 0 帧 {@link FORWARD_PROMPT_BATCH_INDEX}：无传播链边，仅 prompt 节点按稳态 stay 描边/归一；固定停留 {@link FORWARD_PROMPT_FRAME_DWELL_MS}ms。
 * - 其后从最远 batch 递减；share 始终用全量焦点快照，动画只改「可见边集合」与归一分母（前沿内 max share）。
 * - 同一帧内，已可见边的相对强弱 = share 相对强弱；绝对 opacity 可因分母随新批次变大而变暗。
 * - 末帧 `batchIndex === 0` 时前沿 = 全链、分母 = 全链 max、可见性全开，与无动画稳定态数值一致（收敛）。
 *
 * **backward**
 * - 首帧 `batchIndex === 0`（焦点侧）：固定停留 {@link FORWARD_PROMPT_FRAME_DWELL_MS}ms，与 forward prompt 首帧一致，不参与权重分配。
 * - 部分帧沿前沿重算 share（部分快照）；节点 stay 用 live partial，与 forward 仅门控可见性不同。
 * - 节点描边 opacity：分子 live partial stay，分母稳定态 `max(stay)`（与蓝边用全链 max 一致），避免 prompt 等过早顶满。
 *
 * **播放计划（见 {@link DagPropagationPlaybackPlan}）**
 * - 一批 = 同一生成 offset 的入边层；`layerOffset` + `tgtId` 标识该层 token。
 * - 播放间隔权重（准备阶段一遍）：按**文字顺序**对非焦点 `layerShare/weightMax` 做 running max 归一化；向后看层数 = max({@link DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_MIN}, round(比例×层数))；与播放方向无关。层内含焦点则无 `shareNorm`。
 * - `backwardFrontierByBatchIndex` / `forwardFrontierByBatchIndex`：各 batchIndex 下可见边并集，render 热路径 O(1)。
 * - forward / backward 共用同一 plan；不用 backward 部分快照的 nodeShare 定权重。
 */
/** 传播链动画的一批：同一生成 offset 的入边层 + 层元数据。 */
export type DagRecursiveIncomingEdgeBatch = {
    /** 与 {@link buildPropagationPlaybackPlan} 分批键一致。 */
    layerOffset: number;
    /** 本层代表 token（forward 高亮）。 */
    tgtId: string;
    /** 本层传播链入边（`src->tgt`）。 */
    edgeKeys: string[];
    /**
     * 文字顺序局部归一化权重：share_norm ÷ runningMax(含向后 lookahead 窗口内的非焦点 share_norm)。
     */
    propagationWeight: number;
    /**
     * 非焦点 `layerShare / weightMax`（playback 日志 share_norm）。
     * 层内含焦点时为 undefined。
     */
    shareNorm?: number;
    /** 准备阶段：截至本层（含 lookahead 窗口）的链序 running max。 */
    runningMaxNorm: number;
};

/** 点击焦点时生成的不可变播放计划（批次 + 预计算前沿 + 播放权重）。 */
export type DagPropagationPlaybackPlan = {
    focusId: string;
    batches: DagRecursiveIncomingEdgeBatch[];
    /** 全链非焦点层 Total share 上限（日志 / 对照；量纲同 Total share）。 */
    weightMax: number;
    /** Σ `batches[].propagationWeight`；total 模式分母。 */
    weightTotal: number;
    /** 本计划 running max 前瞻层数（max(MIN, round(比例×层数))）。 */
    runningMaxLookahead: number;
    /** backward：`batchIndex = i` 时可见边 = `batches[0..i]` 并集。 */
    backwardFrontierByBatchIndex: ReadonlyArray<ReadonlySet<string>>;
    /** forward：`batchIndex = i` 时可见边 = `batches[i..末]` 并集。 */
    forwardFrontierByBatchIndex: ReadonlyArray<ReadonlySet<string>>;
};

/** 进行中的播放状态：仅 batchIndex 与 direction 可变。 */
export type DagEdgeBatchAnimationState = {
    plan: DagPropagationPlaybackPlan;
    direction: DagRecursiveEdgeAnimationDirection;
    batchIndex: number;
};

export function tgtIdFromEdgeKey(edgeKey: string): string | null {
    const i = edgeKey.indexOf('->');
    if (i <= 0 || i >= edgeKey.length - 2) return null;
    return edgeKey.slice(i + 2);
}

const EMPTY_EDGE_KEY_SET: ReadonlySet<string> = new Set();

/** 当前 batchIndex、方向下已启用的传播链入边（计划内预计算）。 */
function frontierEdgeKeysAtBatch(
    plan: DagPropagationPlaybackPlan,
    direction: DagRecursiveEdgeAnimationDirection,
    batchIndex: number,
): ReadonlySet<string> {
    if (isForwardPromptOnlyBatchIndex(direction, batchIndex)) {
        return EMPTY_EDGE_KEY_SET;
    }
    const table =
        direction === 'backward' ? plan.backwardFrontierByBatchIndex : plan.forwardFrontierByBatchIndex;
    return table[batchIndex] ?? EMPTY_EDGE_KEY_SET;
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
    if (animation == null || animation.plan.focusId !== focusId) return false;
    if (animation.direction === 'backward') {
        const lastBatch = animation.plan.batches.length - 1;
        if (lastBatch <= 0) return false;
        return animation.batchIndex < lastBatch;
    }
    // forward：末帧 batchIndex===0 为稳态；含 prompt 第 0 帧（-1）与其余部分帧
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

type NodeShareEntry = { id: string; share: number };

function nodesAtNodeShareTotal(
    nodeShareById: ReadonlyMap<string, number>,
    total: number,
    options?: {
        excludeFocusId?: string;
        /** 若设，仅保留该集合内的节点。 */
        onlyNodeIds?: ReadonlySet<string>;
    },
): NodeShareEntry[] {
    const out: NodeShareEntry[] = [];
    for (const [nodeId, share] of nodeShareById) {
        if (options?.excludeFocusId != null && nodeId === options.excludeFocusId) continue;
        if (options?.onlyNodeIds != null && !options.onlyNodeIds.has(nodeId)) continue;
        if (share === total) out.push({ id: nodeId, share });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    return out;
}

function tgtIdsInBatch(batch: DagRecursiveIncomingEdgeBatch): Set<string> {
    const ids = new Set<string>();
    for (const edgeKey of batch.edgeKeys) {
        const tgtId = tgtIdFromEdgeKey(edgeKey);
        if (tgtId != null) ids.add(tgtId);
    }
    return ids;
}

type PropagationWeightLayer = { tgtIds: Iterable<string> };

/** 文序单层：pacing 权重 + 日志字段（与 {@link computePropagationLayerPacings} 一致）。 */
type PropagationLayerPrep = {
    propagationWeight: number;
    runningMaxNorm: number;
    shareNorm?: number;
};

function summarizePropagationLayer(
    layer: PropagationWeightLayer,
    nodeShareById: ReadonlyMap<string, number>,
    focusId: string,
): { hasFocus: boolean; nonFocusLayerShare: number } {
    let hasFocus = false;
    let nonFocusLayerShare = 0;
    for (const tgtId of layer.tgtIds) {
        if (tgtId === focusId) {
            hasFocus = true;
            continue;
        }
        const share = nodeShareById.get(tgtId) ?? 0;
        if (share > nonFocusLayerShare) nonFocusLayerShare = share;
    }
    return { hasFocus, nonFocusLayerShare };
}

function maxShareNormInRunningMaxLookaheadWindow(
    shareNormPacing: readonly number[],
    startIndex: number,
    lookahead: number,
): number {
    let windowMax = 0;
    const end = Math.min(shareNormPacing.length - 1, startIndex + lookahead);
    for (let j = startIndex; j <= end; j++) {
        windowMax = Math.max(windowMax, shareNormPacing[j] ?? 0);
    }
    return windowMax;
}

/**
 * 文序准备：非焦点 `weightMax` → share_norm pacing → running max（含 lookahead）→ `propagationWeight`。
 * 含焦点的层无 `shareNorm`（pacing 仍用非焦点 share，通常为 0）。
 */
function computePropagationLayerPacings(
    layers: readonly PropagationWeightLayer[],
    nodeShareById: ReadonlyMap<string, number>,
    focusId: string,
): {
    layerPreps: PropagationLayerPrep[];
    weightMax: number;
    weightTotal: number;
    runningMaxLookahead: number;
} {
    const layerSummaries = layers.map((layer) =>
        summarizePropagationLayer(layer, nodeShareById, focusId),
    );

    let weightMax = 0;
    for (const { nonFocusLayerShare } of layerSummaries) {
        if (nonFocusLayerShare > weightMax) weightMax = nonFocusLayerShare;
    }

    const invWeightMax = weightMax > 0 ? 1 / weightMax : 0;
    const shareNormPacing = layerSummaries.map(
        ({ nonFocusLayerShare }) => nonFocusLayerShare * invWeightMax,
    );
    const runningMaxLookahead = propagationRunningMaxLookaheadForLayerCount(layers.length);

    const layerPreps: PropagationLayerPrep[] = [];
    let runningMaxNorm = 0;
    let weightTotal = 0;

    for (let i = 0; i < layers.length; i++) {
        const { hasFocus } = layerSummaries[i]!;
        const shareNorm = shareNormPacing[i]!;
        runningMaxNorm = Math.max(
            runningMaxNorm,
            maxShareNormInRunningMaxLookaheadWindow(shareNormPacing, i, runningMaxLookahead),
        );
        const propagationWeight = runningMaxNorm > 0 ? shareNorm / runningMaxNorm : 0;
        weightTotal += propagationWeight;
        layerPreps.push({
            propagationWeight,
            runningMaxNorm,
            ...(hasFocus ? {} : { shareNorm: shareNorm }),
        });
    }

    return { layerPreps, weightMax, weightTotal, runningMaxLookahead };
}

function batchesInTextOrder(
    batches: readonly DagRecursiveIncomingEdgeBatch[],
): DagRecursiveIncomingEdgeBatch[] {
    return [...batches].sort((a, b) => a.layerOffset - b.layerOffset);
}

/** 层内代表 tgt；并列时取 id 字典序最小。 */
function primaryTgtIdForLayer(
    tgtIds: Iterable<string>,
    nodeShareById: ReadonlyMap<string, number>,
): string {
    let bestId = '';
    let bestShare = -1;
    for (const tgtId of tgtIds) {
        const share = nodeShareById.get(tgtId) ?? 0;
        if (share > bestShare || (share === bestShare && tgtId < bestId)) {
            bestShare = share;
            bestId = tgtId;
        }
    }
    return bestId;
}

function incomingEdgeBatchFromLayer(
    layerOffset: number,
    layer: { edgeKeys: string[]; tgtIds: Set<string> },
    prep: PropagationLayerPrep,
    nodeShareById: ReadonlyMap<string, number>,
): DagRecursiveIncomingEdgeBatch {
    layer.edgeKeys.sort();
    return {
        layerOffset,
        tgtId: primaryTgtIdForLayer(layer.tgtIds, nodeShareById),
        edgeKeys: layer.edgeKeys,
        propagationWeight: prep.propagationWeight,
        runningMaxNorm: prep.runningMaxNorm,
        ...(prep.shareNorm != null ? { shareNorm: prep.shareNorm } : {}),
    };
}

function buildFrontierEdgeKeysByBatchIndex(
    batches: readonly DagRecursiveIncomingEdgeBatch[],
): Pick<DagPropagationPlaybackPlan, 'backwardFrontierByBatchIndex' | 'forwardFrontierByBatchIndex'> {
    const n = batches.length;
    const backward: Set<string>[] = Array.from({ length: n }, () => new Set<string>());
    const forward: Set<string>[] = Array.from({ length: n }, () => new Set<string>());

    for (let i = 0; i < n; i++) {
        if (i > 0) {
            for (const key of backward[i - 1]!) backward[i]!.add(key);
        }
        for (const key of batches[i]!.edgeKeys) backward[i]!.add(key);
    }
    for (let i = n - 1; i >= 0; i--) {
        if (i < n - 1) {
            for (const key of forward[i + 1]!) forward[i]!.add(key);
        }
        for (const key of batches[i]!.edgeKeys) forward[i]!.add(key);
    }

    return { backwardFrontierByBatchIndex: backward, forwardFrontierByBatchIndex: forward };
}

/**
 * 传播链播放计划：入边按 `start(tgt)` 分批（offset 降序），并预计算双向前沿。
 * backward 从 index 0 递增，forward 从末批递减。
 */
export function buildPropagationPlaybackPlan(
    incomingEdgeShareByKey: Map<string, number>,
    offsetOf: (id: string) => number,
    nodeShareById: ReadonlyMap<string, number>,
    focusId: string,
): DagPropagationPlaybackPlan | null {
    if (incomingEdgeShareByKey.size === 0) return null;

    const byOffset = new Map<number, { edgeKeys: string[]; tgtIds: Set<string> }>();
    for (const edgeKey of incomingEdgeShareByKey.keys()) {
        const tgtId = tgtIdFromEdgeKey(edgeKey);
        if (tgtId == null) continue;
        const offset = offsetOf(tgtId);
        let layer = byOffset.get(offset);
        if (layer == null) {
            layer = { edgeKeys: [], tgtIds: new Set() };
            byOffset.set(offset, layer);
        }
        layer.edgeKeys.push(edgeKey);
        layer.tgtIds.add(tgtId);
    }

    const sortedOffsetsAsc = [...byOffset.keys()].sort((a, b) => a - b);
    const sortedOffsetsDesc = [...sortedOffsetsAsc].reverse();
    const { layerPreps, weightMax, weightTotal, runningMaxLookahead } = computePropagationLayerPacings(
        sortedOffsetsAsc.map((layerOffset) => byOffset.get(layerOffset)!),
        nodeShareById,
        focusId,
    );
    const batches: DagRecursiveIncomingEdgeBatch[] = sortedOffsetsDesc.map((layerOffset, j) => {
        const prep = layerPreps[sortedOffsetsAsc.length - 1 - j]!;
        return incomingEdgeBatchFromLayer(layerOffset, byOffset.get(layerOffset)!, prep, nodeShareById);
    });

    return {
        focusId,
        batches,
        weightMax,
        weightTotal,
        runningMaxLookahead,
        ...buildFrontierEdgeKeysByBatchIndex(batches),
    };
}

/**
 * 动画前沿处的归因快照：backward 部分态沿前沿边集追溯；
 * forward 仍用全量（边可见性由 {@link frontierEdgeKeysAtBatch} 预计算前沿单独控制）。
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
    /** backward 部分帧：稳定态 stay 池 max，供描边归一分母；否则 undefined 用当前池 max。 */
    nodeStrokeMaxForRender?: number;
    incomingShareForRender: Map<string, number>;
    incomingMaxForRender: number;
    /** forward {@link FORWARD_PROMPT_BATCH_INDEX}：仅 prompt 稳态描边，无链边、无 slide 高亮。 */
    forwardPromptOnlyFrame: boolean;
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
            forwardPromptOnlyFrame: false,
            forwardSlideTgtId: null,
            edgeVisibility: INACTIVE_EDGE_VISIBILITY,
        };
    }

    const animationFrontierPartial =
        anim != null &&
        anim.plan.focusId === userAnimationFocusId &&
        isRecursiveEdgeAnimationFrontierPartial(anim, userAnimationFocusId);
    const frontierEdgeKeys =
        animationFrontierPartial && anim != null
            ? frontierEdgeKeysAtBatch(anim.plan, anim.direction, anim.batchIndex)
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
    const nodeStrokeMaxForRender =
        animationFrontierPartial && anim?.direction === 'backward'
            ? maxHighlightEdgeShare(computeSteadyStateStayShareById(focusState.nodeShareById, focusId))
            : undefined;
    const incomingShareForRender =
        animationFrontierPartial && anim?.direction === 'backward' && displayFocusState != null
            ? displayFocusState.incomingEdgeShareByKey
            : focusState.incomingEdgeShareByKey;
    const incomingMaxForRender =
        animationFrontierPartial && frontierEdgeKeys != null
            ? maxShareInEdgeKeySet(focusState.incomingEdgeShareByKey, frontierEdgeKeys)
            : maxHighlightEdgeShare(incomingShareForRender);
    const forwardPromptOnlyFrame =
        anim != null && isForwardPromptOnlyBatchIndex(anim.direction, anim.batchIndex);
    const forwardSlideTgtId =
        anim?.direction === 'forward' && animationFrontierPartial && !forwardPromptOnlyFrame
            ? (anim.plan.batches[anim.batchIndex]?.tgtId ?? null)
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
        nodeStrokeMaxForRender,
        incomingShareForRender,
        incomingMaxForRender,
        forwardPromptOnlyFrame,
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
    /** 节点 id → 界面展示用 token 文案（如 `displayLabel`）。 */
    tokenLabelOf: (id: string) => string | null;
    enabled?: boolean;
    direction?: DagRecursiveEdgeAnimationDirection;
    /** 点击焦点开始动画时读取；与 DAG 生成回放共用 UI 配置。 */
    getReplayPacing?: () => DagRecursiveEdgeReplayPacing;
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
    let enabled = options.enabled ?? true;
    let direction: DagRecursiveEdgeAnimationDirection = options.direction ?? 'forward';
    let userAnimationFocusId: string | null = null;
    let animation: DagEdgeBatchAnimationState | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let version = 0;
    let graphCtx: DagFocusAttributionGraphContext | null = null;

    function stopAnimation(): void {
        if (animation != null) {
            const s = animation;
            const batch = s.plan.batches[s.batchIndex];
            const lastBatch = s.plan.batches.length - 1;
            playbackLogLine(
                `${playbackPad('stop', DAG_PROP_LOG_W.event)} | focus=${playbackPad(playbackFmtToken(options.tokenLabelOf(s.plan.focusId)), DAG_PROP_LOG_W.focus)} | frame=${playbackPad(`${s.batchIndex}/${lastBatch}`, DAG_PROP_LOG_W.frame)} | token=${playbackPad(playbackFmtToken(batch != null ? options.tokenLabelOf(batch.tgtId) : null), DAG_PROP_LOG_W.token)}`,
            );
        }
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
        const plan = buildPropagationPlaybackPlan(
            focusState.incomingEdgeShareByKey,
            options.offsetOf,
            focusState.nodeShareById,
            focusId,
        );
        if (plan == null) return;
        const initialBatchIndex =
            direction === 'backward' ? 0 : FORWARD_PROMPT_BATCH_INDEX;
        animation = {
            plan,
            direction,
            batchIndex: initialBatchIndex,
        };
        const pacing = getReplayPacing();
        const pacingLine =
            pacing.mode === 'step'
                ? `pacing=step stepMs=${pacing.stepMs}`
                : `pacing=total totalS=${pacing.totalS}`;
        playbackLogLine(
            `${playbackPad('start', DAG_PROP_LOG_W.event)} | focus=${playbackPad(playbackFmtToken(options.tokenLabelOf(focusId)), DAG_PROP_LOG_W.focus)} | direction=${playbackPad(direction, DAG_PROP_LOG_W.direction)} | batches=${playbackPadInt(plan.batches.length, DAG_PROP_LOG_W.int3)} | initial=${playbackPadInt(initialBatchIndex, DAG_PROP_LOG_W.int3)} | ${pacingLine}`,
        );
        const nodeShareById = focusState.nodeShareById;
        const batchTgtIds = new Set<string>();
        for (const b of plan.batches) {
            for (const tgtId of tgtIdsInBatch(b)) batchTgtIds.add(tgtId);
        }
        const refNodes = nodesAtNodeShareTotal(nodeShareById, plan.weightMax, {
            excludeFocusId: focusId,
            onlyNodeIds: batchTgtIds,
        });
        playbackLogLine(
            `${playbackPad('pacing', DAG_PROP_LOG_W.event)} | weightMax=${playbackPadWeight(plan.weightMax)} | weightTotal=${playbackPadWeight(plan.weightTotal)} | lookahead=${playbackPadInt(plan.runningMaxLookahead, DAG_PROP_LOG_W.int3)} | nodes=${playbackFmtNodeShareList(refNodes, options.tokenLabelOf)}`,
        );
        const planTextOrder = batchesInTextOrder(plan.batches);
        for (let chainStep = 0; chainStep < planTextOrder.length; chainStep++) {
            const b = planTextOrder[chainStep]!;
            const token = playbackFmtToken(options.tokenLabelOf(b.tgtId));
            playbackLogLine(
                `${playbackPad(`plan[${chainStep}]`, DAG_PROP_LOG_W.event)} | token=${playbackPad(token, DAG_PROP_LOG_W.token)} | share_norm=${playbackPadWeight(b.shareNorm)} | running_max=${playbackPadWeight(b.runningMaxNorm)} | weight=${playbackPadWeight(b.propagationWeight)}`,
            );
        }
        scheduleAnimationStep(focusId);
    }

    function delayMsForCurrentBatch(state: DagEdgeBatchAnimationState): number {
        if (
            isForwardPromptOnlyBatchIndex(state.direction, state.batchIndex) ||
            (state.direction === 'backward' && state.batchIndex === 0)
        ) {
            return FORWARD_PROMPT_FRAME_DWELL_MS;
        }
        const batch = state.plan.batches[state.batchIndex];
        if (batch == null) return 0;
        return batchPlaybackDelayMs(batch, state.plan, getReplayPacing());
    }

    /**
     * 展示当前帧后的停留（ms）。
     * forward 稳态末帧（batchIndex 0）为 0；forward prompt / backward 首帧为固定值。
     */
    function dwellMsAfterCurrentFrame(state: DagEdgeBatchAnimationState): number {
        if (state.direction === 'forward' && state.batchIndex === 0) return 0;
        return delayMsForCurrentBatch(state);
    }

    function hasNextBatch(state: DagEdgeBatchAnimationState, lastBatch: number): boolean {
        if (state.direction === 'backward') {
            return state.batchIndex < lastBatch;
        }
        return (
            state.batchIndex === FORWARD_PROMPT_BATCH_INDEX ||
            state.batchIndex > 0
        );
    }

    function advanceBatchIndex(state: DagEdgeBatchAnimationState): void {
        if (state.direction === 'backward') {
            state.batchIndex += 1;
            return;
        }
        if (state.batchIndex === FORWARD_PROMPT_BATCH_INDEX) {
            state.batchIndex = state.plan.batches.length - 1;
            return;
        }
        state.batchIndex -= 1;
    }

    function logPropagationFrame(state: DagEdgeBatchAnimationState): void {
        const promptFrame = isForwardPromptOnlyBatchIndex(state.direction, state.batchIndex);
        const batch = promptFrame ? null : state.plan.batches[state.batchIndex];
        const lastBatch = state.plan.batches.length - 1;
        const dwellMs = dwellMsAfterCurrentFrame(state);
        const token = promptFrame
            ? 'prompt'
            : playbackFmtToken(batch?.tgtId != null ? options.tokenLabelOf(batch.tgtId) : null);
        const weight = promptFrame ? 'fixed' : playbackFmtWeight(batch?.propagationWeight);
        playbackLogLine(
            `${playbackPad('frame', DAG_PROP_LOG_W.event)} ${playbackPad(`${state.batchIndex}/${lastBatch}`, DAG_PROP_LOG_W.frame)} | token=${playbackPad(token, DAG_PROP_LOG_W.token)} | weight=${playbackPad(weight, DAG_PROP_LOG_W.weight)} | dwellMs=${playbackPadInt(dwellMs, DAG_PROP_LOG_W.dwell)}`,
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

        const v = ++version;

        const showFrameAndScheduleNext = (): void => {
            if (version !== v) return;
            const s = animation;
            if (!s || s.plan.focusId !== focusId) return;

            options.onTick();
            logPropagationFrame(s);

            const dwellMs = dwellMsAfterCurrentFrame(s);
            timer = setTimeout(() => {
                if (version !== v) return;
                const s2 = animation;
                if (!s2 || s2.plan.focusId !== focusId) return;

                if (!hasNextBatch(s2, lastBatch)) {
                    timer = null;
                    return;
                }
                advanceBatchIndex(s2);
                showFrameAndScheduleNext();
            }, dwellMs);
        };

        showFrameAndScheduleNext();
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
