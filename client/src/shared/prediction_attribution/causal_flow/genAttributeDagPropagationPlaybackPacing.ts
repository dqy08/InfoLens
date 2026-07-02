/** 传播链边界帧固定停留（ms）：正向 prompt 首开 / 末帧稳态、反向首帧焦点 slide 等；不参与 Play speed 权重分配。 */
export const DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS = 500;

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
 * DAG 回放节奏：**间隔 = 当前内容的模拟开销**（ms）。
 *
 * 步进回放（▶）：展示本段内容**之前**等待其时长（见 {@link genAttributeDagStepPlayback}）。
 * 传播链（↯）：展示本帧**之后**等待其时长再调度下一帧；相邻帧出现时刻与步进语义等价。
 *
 * `outputGenClockMs`（`stepMs` 或 total 折算）= 生成一个 **output gen token** 的 1× 时钟。
 *
 * | 内容 | 模拟开销（时钟倍数） |
 * |------|---------------------|
 * | prompt（回放 t=0 即存在） | 0 |
 * | 首个 output gen（有 prompt） | {@link DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS}× |
 * | 首个 output gen（无 prompt） | 0 |
 * | output gen（续写） | 1× |
 * | tool response | {@link DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS}×（pending 期间展示） |
 * | input 后首 output gen | {@link DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS}× |
 * | 末 output gen（结束） | {@link DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS} 固定收尾 |
 *
 * 仅影响 ▶ 与 ↯ 的时钟倍数；live mock tool 仍用固定 1s（`toolCallingPendingUi`）。
 */
/** tool response 出现前的模拟开销：工具调用 + 等 response（pending 期间展示）。 */
export const DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS = 3;
/** input（prompt / tool response）之后、紧随的首个 output gen 的模拟开销；与 {@link DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS} 独立。 */
export const DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS = 3;

export type DagRecursiveEdgeReplayPacing = {
    mode: DagReplayPacingMode;
    /**
     * `step`：1× 时钟名义时长（ms）。
     * 传播链实际间隔 = `propagationWeight × stepMs`；权重为 0 时恰为 0ms。
     */
    stepMs: number;
    /**
     * `total`：整段动画名义总时长（s）。
     * 权重步从 `totalS×1000 − {@link DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS}` 按占比分配（backward 首帧预留）；forward 末帧固定收尾另计。
     */
    totalS: number;
    /**
     * 为 true 时传播链（↯）各帧间隔不再按 `propagationWeight` 缩放，改为均匀间隔
     *（`step`：每帧 `stepMs`；`total`：权重预算均分至各计时节拍）。
     */
    disableSmartStepTime?: boolean;
};

/** 步进回放（▶）各内容类型的时钟单价（ms）。 */
export type DagStepPlaybackClocks = {
    /** 1×：单个 output gen token 的模拟生成耗时。 */
    outputGenClockMs: number;
    /** {@link DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS}× */
    toolResponseClockMs: number;
    /** {@link DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS}×：input 后紧随的生成步。 */
    genAfterInputClockMs: number;
};

/**
 * 由 UI 节奏控件折算步进回放时钟单价。
 *
 * `total` 分母：每条 output gen 各 1 时钟；每个 tool 边界另加
 * {@link DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS} + {@link DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS}。
 * prompt 后的 {@link DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS}× 不计入分母。
 */
export function resolveDagStepPlaybackClocks(
    outputGenStepCount: number,
    toolBoundaryCount: number,
    pacing: DagRecursiveEdgeReplayPacing,
): DagStepPlaybackClocks {
    const clocksPerToolBoundary =
        DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS + DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS;
    if (pacing.mode === 'step') {
        const outputGenClockMs = pacing.stepMs;
        return {
            outputGenClockMs,
            toolResponseClockMs: outputGenClockMs * DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS,
            genAfterInputClockMs: outputGenClockMs * DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS,
        };
    }
    const weightTotal = outputGenStepCount + toolBoundaryCount * clocksPerToolBoundary;
    if (weightTotal <= 0) {
        return { outputGenClockMs: 0, toolResponseClockMs: 0, genAfterInputClockMs: 0 };
    }
    const outputGenClockMs = Math.round((pacing.totalS * 1000) / weightTotal);
    return {
        outputGenClockMs,
        toolResponseClockMs: outputGenClockMs * DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS,
        genAfterInputClockMs: outputGenClockMs * DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS,
    };
}

/** `total` 模式加权分母：仅含本趟实际会按权重计时的批。 */
export type PropagationPlaybackWeightScope = {
    direction: 'backward' | 'forward';
    /** forward 未勾选 slide prompt 时 prompt 批不进入分母；backward 不使用此字段。 */
    forwardSlideSharedNodes: boolean;
};

/**
 * `total` 模式分母：backward 与 forward 未 slide 用 `chainWeightTotal`（不含首个 prompt 区）；
 * 仅 forward 且勾选 slide prompt 时用全量 `weightTotal`。
 */
export function effectivePropagationWeightTotal(
    plan: { weightTotal: number; chainWeightTotal: number },
    scope: PropagationPlaybackWeightScope,
): number {
    if (scope.direction === 'backward') {
        return plan.chainWeightTotal;
    }
    if (!scope.forwardSlideSharedNodes) {
        return plan.chainWeightTotal;
    }
    return plan.weightTotal;
}

/** 传播链均匀间隔：`total` 模式权重预算均分的计时节拍数（不含固定 preamble / 稳态帧）。 */
export function propagationUniformWeightedFrameCount(
    plan: { batches: readonly { isFirstPromptRegion?: boolean }[] },
    scope: PropagationPlaybackWeightScope,
): number {
    const lastBatch = plan.batches.length - 1;
    if (lastBatch <= 0) return 0;
    if (scope.direction === 'backward') {
        for (let i = plan.batches.length - 1; i >= 0; i--) {
            if (!plan.batches[i]!.isFirstPromptRegion) return i;
        }
        return 0;
    }
    const hasPromptRegion = plan.batches.some((batch) => batch.isFirstPromptRegion === true);
    if (!scope.forwardSlideSharedNodes && hasPromptRegion) {
        for (let i = plan.batches.length - 1; i >= 0; i--) {
            if (!plan.batches[i]!.isFirstPromptRegion) return i;
        }
        return 0;
    }
    return lastBatch;
}

/**
 * 传播链（↯）当前帧的模拟开销（ms），由本帧 `propagationWeight` 或固定帧类型决定。
 *
 * - `step`：`propagationWeight × stepMs`（`disableSmartStepTime` 时每帧 `stepMs`）
 * - `total`：`(propagationWeight / effectiveWeightTotal) × (totalS×1000 − DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS)`
 *   （`disableSmartStepTime` 时权重预算均分至 {@link propagationUniformWeightedFrameCount}）
 */
export function batchAppearanceCostMs(
    batch: { propagationWeight: number },
    plan: {
        weightTotal: number;
        chainWeightTotal: number;
        batches: readonly { isFirstPromptRegion?: boolean }[];
    },
    pacing: DagRecursiveEdgeReplayPacing,
    scope?: PropagationPlaybackWeightScope,
): number {
    if (pacing.disableSmartStepTime) {
        if (pacing.mode === 'step') {
            return pacing.stepMs;
        }
        if (scope == null) return 0;
        const frameCount = propagationUniformWeightedFrameCount(plan, scope);
        if (frameCount <= 0) return 0;
        const weightedBudgetMs = Math.max(0, pacing.totalS * 1000 - DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS);
        return Math.round(weightedBudgetMs / frameCount);
    }
    const w = batch.propagationWeight;
    if (pacing.mode === 'step') {
        return Math.round(w * pacing.stepMs);
    }
    const totalWeight =
        scope != null ? effectivePropagationWeightTotal(plan, scope) : plan.weightTotal;
    if (totalWeight <= 0) return 0;
    const weightedBudgetMs = Math.max(0, pacing.totalS * 1000 - DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS);
    return Math.round((w / totalWeight) * weightedBudgetMs);
}

export type PropagationWeightGroup = {
    tgtIds: Iterable<string>;
    /** 文序首部连续 prompt-only 组（首个 prompt 区）：prompt 区内 max 归一，不参与 gen weightMax / running max。 */
    isFirstPromptRegion?: boolean;
};

export type PropagationGroupPrep = {
    propagationWeight: number;
    /** gen / input 链序 running max；prompt 区不适用。 */
    runningMaxNorm?: number;
    shareNorm?: number;
    /** 组内非焦点 max Total share（prompt 区 playback 日志 `share=`）。 */
    groupShare?: number;
    isFirstPromptRegion?: boolean;
};

export type PropagationGroupPacingsResult = {
    groupPreps: PropagationGroupPrep[];
    /** gen / input 区非焦点组 Total share 上限（不含 prompt 区）。 */
    weightMax: number;
    /** Σ 全部 `propagationWeight`；total 模式分母。 */
    weightTotal: number;
    runningMaxLookahead: number;
    /** prompt 区组内 max Total share；无 prompt 区时为 0。 */
    promptRegionMax: number;
    /** Σ prompt 区 `propagationWeight`。 */
    promptWeightTotal: number;
    /** Σ gen / input 区 `propagationWeight`。 */
    chainWeightTotal: number;
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
    skipIndex?: (index: number) => boolean,
): number {
    let windowMax = 0;
    const end = Math.min(shareNormPacing.length - 1, startIndex + lookahead);
    for (let j = startIndex; j <= end; j++) {
        if (skipIndex?.(j)) continue;
        windowMax = Math.max(windowMax, shareNormPacing[j] ?? 0);
    }
    return windowMax;
}

/**
 * 文序准备：
 * - prompt 区：share / promptRegionMax → propagationWeight；
 * - gen / input：share_norm → running max（含 lookahead）→ propagationWeight。
 * 含焦点的组无 `shareNorm`（pacing 仍用非焦点 share，通常为 0）。
 */
export function computePropagationGroupPacings(
    groups: readonly PropagationWeightGroup[],
    nodeShareById: ReadonlyMap<string, number>,
    focusId: string,
): PropagationGroupPacingsResult {
    const groupSummaries = groups.map((group) =>
        summarizePropagationGroup(group, nodeShareById, focusId),
    );
    const isFirstPromptRegion = (index: number): boolean =>
        groups[index]?.isFirstPromptRegion === true;

    let promptRegionMax = 0;
    for (let i = 0; i < groupSummaries.length; i++) {
        if (!isFirstPromptRegion(i)) continue;
        const { nonFocusGroupShare } = groupSummaries[i]!;
        if (nonFocusGroupShare > promptRegionMax) promptRegionMax = nonFocusGroupShare;
    }
    const invPromptRegionMax = promptRegionMax > 0 ? 1 / promptRegionMax : 0;

    let weightMax = 0;
    for (let i = 0; i < groupSummaries.length; i++) {
        if (isFirstPromptRegion(i)) continue;
        const { nonFocusGroupShare } = groupSummaries[i]!;
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
    let promptWeightTotal = 0;
    let chainWeightTotal = 0;

    for (let i = 0; i < groups.length; i++) {
        const { hasFocus, nonFocusGroupShare } = groupSummaries[i]!;
        if (isFirstPromptRegion(i)) {
            const shareNorm = nonFocusGroupShare * invPromptRegionMax;
            const propagationWeight = shareNorm;
            weightTotal += propagationWeight;
            promptWeightTotal += propagationWeight;
            groupPreps.push({
                propagationWeight,
                isFirstPromptRegion: true,
                ...(hasFocus ? {} : { shareNorm, groupShare: nonFocusGroupShare }),
            });
            continue;
        }
        const shareNorm = shareNormPacing[i]!;
        runningMaxNorm = Math.max(
            runningMaxNorm,
            maxShareNormInRunningMaxLookaheadWindow(
                shareNormPacing,
                i,
                runningMaxLookahead,
                isFirstPromptRegion,
            ),
        );
        const propagationWeight = runningMaxNorm > 0 ? shareNorm / runningMaxNorm : 0;
        weightTotal += propagationWeight;
        chainWeightTotal += propagationWeight;
        groupPreps.push({
            propagationWeight,
            runningMaxNorm,
            ...(hasFocus ? {} : { shareNorm: shareNorm }),
        });
    }

    return {
        groupPreps,
        weightMax,
        weightTotal,
        runningMaxLookahead,
        promptRegionMax,
        promptWeightTotal,
        chainWeightTotal,
    };
}
