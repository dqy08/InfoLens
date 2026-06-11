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

/**
 * DAG 步进回放（▶）：**间隔 = 下一段「内容」出现前还要多久**（不是当前画面自身的展示时长）。
 *
 * `stepDelayMs`（`stepMs` 或 total 折算）= 生成一个 **output gen token** 的模拟耗时（1× 时钟）。
 *
 * | 当前内容 | 等待 | 下一段内容 |
 * |----------|------|------------|
 * | prompt（回放 t=0 即存在） | {@link DAG_PLAYBACK_WAIT_AFTER_INPUT_CLOCKS}× | 首个 output gen |
 * | output gen | 1× | 下一 output gen |
 * | 末 gen（需 tool） | {@link DAG_PLAYBACK_WAIT_UNTIL_RESPONSE_CLOCKS}× pending | tool response |
 * | tool response | {@link DAG_PLAYBACK_WAIT_AFTER_INPUT_CLOCKS}× | 下轮首 output gen |
 * | 末 gen（结束） | 500ms 固定 | —（收尾特例，见 `DAG_LAST_TOKEN_DWELL_MS`） |
 *
 * 3× 是等 **response 到达**（工具调用耗时），不是 response 帧自身的「生成时间」。
 * 仅影响 ▶；事件调度见 {@link genAttributeDagStepPlayback}（与 ↯ 传播链无关）。
 * live mock tool 仍用固定 1s（`toolCallingPendingUi`）。
 */
/** 末 gen 之后、response 出现前：等 response 的时钟数（pending 期间展示）。 */
export const DAG_PLAYBACK_WAIT_UNTIL_RESPONSE_CLOCKS = 3;
/** input（prompt / tool response）出现后、紧跟的首个 output gen 前。 */
export const DAG_PLAYBACK_WAIT_AFTER_INPUT_CLOCKS = 2;

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
/**
 * @returns `stepDelayMs` — 1× 时钟（等到下一 output gen）；
 * `waitUntilResponseMs` — {@link DAG_PLAYBACK_WAIT_UNTIL_RESPONSE_CLOCKS}×（等到 response 出现）。
 *
 * `total` 分母：每条已录 output gen 的 gen→gen 各 1 时钟；每个 tool 边界另加
 * {@link DAG_PLAYBACK_WAIT_UNTIL_RESPONSE_CLOCKS}（→response）+
 * {@link DAG_PLAYBACK_WAIT_AFTER_INPUT_CLOCKS}（response→首 gen）。
 * prompt 后的 {@link DAG_PLAYBACK_WAIT_AFTER_INPUT_CLOCKS}× 不计入分母。
 */
export function resolveDagStepPlaybackDelays(
    outputGenStepCount: number,
    toolBoundaryCount: number,
    pacing: DagRecursiveEdgeReplayPacing,
): { stepDelayMs: number; waitUntilResponseMs: number; waitAfterInputMs: number } {
    const clocksPerToolBoundary =
        DAG_PLAYBACK_WAIT_UNTIL_RESPONSE_CLOCKS + DAG_PLAYBACK_WAIT_AFTER_INPUT_CLOCKS;
    if (pacing.mode === 'step') {
        const stepDelayMs = pacing.stepMs;
        return {
            stepDelayMs,
            waitUntilResponseMs: stepDelayMs * DAG_PLAYBACK_WAIT_UNTIL_RESPONSE_CLOCKS,
            waitAfterInputMs: stepDelayMs * DAG_PLAYBACK_WAIT_AFTER_INPUT_CLOCKS,
        };
    }
    const weightTotal = outputGenStepCount + toolBoundaryCount * clocksPerToolBoundary;
    if (weightTotal <= 0) return { stepDelayMs: 0, waitUntilResponseMs: 0, waitAfterInputMs: 0 };
    const stepDelayMs = Math.round((pacing.totalS * 1000) / weightTotal);
    return {
        stepDelayMs,
        waitUntilResponseMs: stepDelayMs * DAG_PLAYBACK_WAIT_UNTIL_RESPONSE_CLOCKS,
        waitAfterInputMs: stepDelayMs * DAG_PLAYBACK_WAIT_AFTER_INPUT_CLOCKS,
    };
}

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
