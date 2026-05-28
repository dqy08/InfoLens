/** forward prompt / backward 首帧固定停留（ms），不参与 Play speed 权重分配。 */
export const FORWARD_PROMPT_FRAME_DWELL_MS = 500;

/** 链序 running max 前瞻：lookahead = max(MIN, round(RATIO × 传播组数))。 */
export const DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_RATIO = 0.1;
export const DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_MIN = 2;

export function propagationRunningMaxLookaheadForGroupCount(groupCount: number): number {
    if (groupCount <= 0) return 0;
    return Math.max(
        DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_MIN,
        Math.round(DAG_PROPAGATION_WEIGHT_RUNNING_MAX_LOOKAHEAD_RATIO * groupCount),
    );
}

/** 与 UI「DAG replay speed」一致。 */
export type DagReplayPacingMode = 'total' | 'step';

export type DagRecursiveEdgeReplayPacing = {
    mode: DagReplayPacingMode;
    /**
     * `step`：单步名义间隔（ms）。
     * 实际间隔 = `propagationWeight × stepMs`；对权重连续，权重为 0 时恰为 0ms。
     */
    stepMs: number;
    /**
     * `total`：整段动画名义总时长（s）。
     * 权重步从 `totalS×1000 − {@link FORWARD_PROMPT_FRAME_DWELL_MS}` 按占比分配；固定帧另计。
     */
    totalS: number;
};

/**
 * **当前帧**展示完成后的停留时长（ms），再切到下一批（不含 forward prompt / backward 首帧等固定帧）。
 *
 * **与权重的关系**：停留时间对 `propagationWeight` 连续；权重为 0 时恰为 0（`step` 下为 0ms，不设最小间隔）。
 *
 * - `step`：`propagationWeight × stepMs`
 * - `total`：`(propagationWeight / weightTotal) × (totalS×1000 − FORWARD_PROMPT_FRAME_DWELL_MS)`；
 *   假定 `weightTotal > 0`。
 */
export function batchPlaybackDelayMs(
    batch: { propagationWeight: number },
    plan: { weightTotal: number },
    pacing: DagRecursiveEdgeReplayPacing,
): number {
    const w = batch.propagationWeight;
    if (pacing.mode === 'step') {
        return Math.round(w * pacing.stepMs);
    }
    const totalWeight = plan.weightTotal;
    const weightedBudgetMs = Math.max(0, pacing.totalS * 1000 - FORWARD_PROMPT_FRAME_DWELL_MS);
    return Math.round((w / totalWeight) * weightedBudgetMs);
}

export type PropagationWeightGroup = { tgtIds: Iterable<string> };

export type PropagationGroupPrep = {
    propagationWeight: number;
    runningMaxNorm: number;
    shareNorm?: number;
};

function summarizePropagationGroup(
    group: PropagationWeightGroup,
    nodeShareById: ReadonlyMap<string, number>,
    focusId: string,
): { hasFocus: boolean; nonFocusGroupShare: number } {
    let hasFocus = false;
    let nonFocusGroupShare = 0;
    for (const tgtId of group.tgtIds) {
        if (tgtId === focusId) {
            hasFocus = true;
            continue;
        }
        const share = nodeShareById.get(tgtId) ?? 0;
        if (share > nonFocusGroupShare) nonFocusGroupShare = share;
    }
    return { hasFocus, nonFocusGroupShare };
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
 * 含焦点的组无 `shareNorm`（pacing 仍用非焦点 share，通常为 0）。
 */
export function computePropagationGroupPacings(
    groups: readonly PropagationWeightGroup[],
    nodeShareById: ReadonlyMap<string, number>,
    focusId: string,
): {
    groupPreps: PropagationGroupPrep[];
    weightMax: number;
    weightTotal: number;
    runningMaxLookahead: number;
} {
    const groupSummaries = groups.map((group) =>
        summarizePropagationGroup(group, nodeShareById, focusId),
    );

    let weightMax = 0;
    for (const { nonFocusGroupShare } of groupSummaries) {
        if (nonFocusGroupShare > weightMax) weightMax = nonFocusGroupShare;
    }

    const invWeightMax = weightMax > 0 ? 1 / weightMax : 0;
    const shareNormPacing = groupSummaries.map(
        ({ nonFocusGroupShare }) => nonFocusGroupShare * invWeightMax,
    );
    const runningMaxLookahead = propagationRunningMaxLookaheadForGroupCount(groups.length);

    const groupPreps: PropagationGroupPrep[] = [];
    let runningMaxNorm = 0;
    let weightTotal = 0;

    for (let i = 0; i < groups.length; i++) {
        const { hasFocus } = groupSummaries[i]!;
        const shareNorm = shareNormPacing[i]!;
        runningMaxNorm = Math.max(
            runningMaxNorm,
            maxShareNormInRunningMaxLookaheadWindow(shareNormPacing, i, runningMaxLookahead),
        );
        const propagationWeight = runningMaxNorm > 0 ? shareNorm / runningMaxNorm : 0;
        weightTotal += propagationWeight;
        groupPreps.push({
            propagationWeight,
            runningMaxNorm,
            ...(hasFocus ? {} : { shareNorm: shareNorm }),
        });
    }

    return { groupPreps, weightMax, weightTotal, runningMaxLookahead };
}
