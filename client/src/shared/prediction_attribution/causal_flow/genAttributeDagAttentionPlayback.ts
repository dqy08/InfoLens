/**
 * DAG 步进回放（▶）attention 模拟：以「每个将要 gen 的 token」为动画单位。
 *
 * ## 原理 ↔ 实现
 * | | 推理 | 本模块 |
 * |---|------|--------|
 * | **scan** | 位置 i 的 Q 仅 attend K/V[0…i]（因果） | `scanIdsForQueryInContext(context, query)`；池 = `contextIdsBeforeOutputGen`（exclude + delete 过滤） |
 * | **query** | 尚无 K/V、需作输入 forward 的 token 逐位作 Q | `uncachedIdsBeforeOutputGen`：首 gen=整段 prompt；decode=上一 gen（已 cache，单轮）；tool 后=call 末+response（call 末仅采样未 forward） |
 * | **skip** | prefill 仍算全位，可只展示末轮 | 仅减 query 轮次；末轮 query/scan 与不 skip 的最后一轮相同 |
 *
 * ## 准备阶段（每个 outputGen 前）
 * - **context**（scan 池）：`contextIdsBeforeOutputGen`，exclude + delete 过滤（与 DAG 可见节点一致）
 * - **query 候选**：`uncached`（见 {@link uncachedIdsBeforeOutputGen}）
 * - **未勾 Skip prefill** 且 uncached > 1：多轮 prefill（query 前移，scan 前缀伸长）
 * - **勾 Skip prefill** 或 uncached ≤ 1：单轮，query = 末候选
 *
 * prompt / toolResponse 事件仅展示内容，不单独播 attention。
 * 输出阶段：FFN 前延迟 → 展示 gen token → FFN 后延迟。播放层见 {@link runAttentionPlayback}。
 */
import type { PromptTokenSpan } from './genAttributeDagPreprocess';
import {
    collectDeletePromptIntervals,
    collectGenAttrDagExcludeIntervals,
    filterPromptSpansInInputRanges,
    isDagGenStepTargetExcluded,
    normalizePromptTokenSpans,
} from './genAttributeDagPreprocess';
import type { DagStepPlaybackEvent } from './genAttributeDagStepPlayback';
import { isToolCallingBoundaryBetweenSteps } from './genAttributeDagStepPlayback';
import type { TokenGenStep } from './tokenGenAttributionRunner';
import { isOffsetSpanFullyExcluded } from '../core/attributionDisplayModel';

export type AttentionRoundPlan = {
    /** Query token：本 round 视角；scanIds 末位 */
    queryTokenId: string;
    scanIds: string[];
};

export type AttentionPlaybackPlan =
    | { kind: 'prefill'; rounds: AttentionRoundPlan[] }
    | { kind: 'decode'; round: AttentionRoundPlan };

/** prefill 中间轮播放：`plain` 逐轮左→右扫；`random` 乱序批处理 query、随机 attend burst 高亮。 */
export type PrefillStyle = 'plain' | 'random';

export type AttentionPlaybackConfig = {
    attendMs: number;
    /** dwell ratio：新 gen 前后 FFN 停留 = 此值 × attendMs（代码内亦称 ffnRatio）。 */
    ffnRatio: number;
    accumulativeHighlight?: boolean;
    /** plain / gen scan：每 attend beat 并行扫过的 token 数；random 段内每 query 随机高亮数。 */
    attendBurst?: number;
    /** random prefill：每帧并行建立的 query 数。 */
    queryBurst?: number;
    prefillStyle?: PrefillStyle;
};

/** random prefill：从因果前缀有放回抽 burst 个；前缀不足 burst 则全亮。 */
export function randomPrefillLitIds(
    scanIds: readonly string[],
    burst: number,
    random: () => number = Math.random,
): string[] {
    if (scanIds.length === 0) return [];
    const b = clampAttendBurst(burst);
    if (scanIds.length <= b) return [...scanIds];
    const lit: string[] = [];
    for (let i = 0; i < b; i++) {
        lit.push(scanIds[Math.floor(random() * scanIds.length)]!);
    }
    return lit;
}

/** Fisher–Yates；返回同一数组引用。 */
export function shuffleInPlace<T>(arr: T[], random: () => number = Math.random): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [arr[i], arr[j]] = [arr[j]!, arr[i]!];
    }
    return arr;
}

/** `attendOnly` = 仅扫上下文；`gen` = attend 后 FFN 前延迟 → 出现 → FFN 后延迟。 */
export type RoundDwellMode = 'attendOnly' | 'gen';

export function dagNodeIdFromOffset(start: number, end: number): string {
    return `${start}_${end}`;
}

export function genStepTargetNodeId(step: Pick<TokenGenStep, 'context' | 'token'>): string {
    const start = step.context.length;
    return dagNodeIdFromOffset(start, start + step.token.length);
}

export function diffNewInputRanges(
    prevRanges: readonly [number, number][],
    nextRanges: readonly [number, number][],
): [number, number][] {
    return nextRanges.filter(
        ([s, e]) => !prevRanges.some(([ps, pe]) => s >= ps && e <= pe),
    );
}

export type AttentionExcludeContext = {
    excludeIntervalContext: string;
    excludePromptPatternsText: string;
    excludeGeneratedPatternsText: string;
    /** 与 DAG {@link collectDeletePromptIntervals} 同源；未勾选 delete 时传 `''`。 */
    deletePromptPatternsText: string;
};

function excludeIntervalsForStep(
    step: Pick<TokenGenStep, 'inputRanges'>,
    ctx: AttentionExcludeContext,
): [number, number][] {
    return collectGenAttrDagExcludeIntervals(
        ctx.excludeIntervalContext,
        step.inputRanges,
        ctx.excludePromptPatternsText,
        ctx.excludeGeneratedPatternsText,
    );
}

function deleteIntervalsForStep(
    step: Pick<TokenGenStep, 'inputRanges'>,
    ctx: AttentionExcludeContext,
): [number, number][] {
    return collectDeletePromptIntervals(
        ctx.excludeIntervalContext,
        step.inputRanges,
        ctx.deletePromptPatternsText,
    );
}

function promptSpanInAttentionPlan(
    start: number,
    end: number,
    excludeIntervals: readonly [number, number][],
    deleteIntervals: readonly [number, number][],
): boolean {
    return (
        !isOffsetSpanFullyExcluded(start, end, excludeIntervals) &&
        !isOffsetSpanFullyExcluded(start, end, deleteIntervals)
    );
}

function spanToNodeId(span: PromptTokenSpan): string {
    return dagNodeIdFromOffset(span.offset[0], span.offset[1]);
}

export function inputSpanNodeIdsInRanges(
    catalogSpans: readonly PromptTokenSpan[],
    inputRanges: readonly [number, number][],
    excludeIntervals: readonly [number, number][],
    deleteIntervals: readonly [number, number][] = [],
): string[] {
    return filterPromptSpansInInputRanges(normalizePromptTokenSpans(catalogSpans), [...inputRanges])
        .filter(({ offset: [s, e] }) => promptSpanInAttentionPlan(s, e, excludeIntervals, deleteIntervals))
        .sort((a, b) => a.offset[0] - b.offset[0])
        .map(spanToNodeId);
}

/** 因果 mask：原理 Q_i → K/V[0…i]；实现为 context 中至 query（含）的前缀。 */
export function scanIdsForQueryInContext(
    contextIds: readonly string[],
    queryTokenId: string,
): string[] {
    const idx = contextIds.indexOf(queryTokenId);
    if (idx < 0) return [];
    return contextIds.slice(0, idx + 1);
}

/**
 * 多 query 轮：每轮 query 取自 candidates；scan = context 中至该 query 的前缀。
 */
export function buildPrefillRounds(
    queryCandidates: readonly string[],
    contextIds: readonly string[],
): AttentionRoundPlan[] {
    return queryCandidates.map((queryTokenId) => ({
        queryTokenId,
        scanIds: scanIdsForQueryInContext(contextIds, queryTokenId),
    }));
}

/** 单轮：scan 为 context 中至 query（含）的前缀。 */
export function buildAttentionRound(
    queryTokenId: string,
    contextIds: readonly string[],
): AttentionRoundPlan {
    return {
        queryTokenId,
        scanIds: scanIdsForQueryInContext(contextIds, queryTokenId),
    };
}

/** @deprecated 使用 {@link buildAttentionRound}；保留别名便于阅读 decode 路径。 */
export function buildDecodeRound(contextIds: readonly string[]): AttentionRoundPlan | null {
    if (contextIds.length === 0) return null;
    return buildAttentionRound(contextIds[contextIds.length - 1]!, contextIds);
}

export const ATTEND_BURST_MIN = 1;
export const ATTEND_BURST_MAX = 256;
export const ATTEND_BURST_DEFAULT = 1;
export const QUERY_BURST_DEFAULT = 3;

export function clampAttendBurst(n: number): number {
    if (!Number.isFinite(n)) return ATTEND_BURST_DEFAULT;
    return Math.max(ATTEND_BURST_MIN, Math.min(ATTEND_BURST_MAX, Math.round(n)));
}

export function attendBeatCount(tokenCount: number, burst: number): number {
    if (tokenCount <= 0) return 0;
    const b = clampAttendBurst(burst);
    return Math.ceil(tokenCount / b);
}

export function attentionRoundMs(
    round: AttentionRoundPlan,
    cfg: AttentionPlaybackConfig,
    dwellMode: RoundDwellMode = 'gen',
): number {
    const burst = clampAttendBurst(cfg.attendBurst ?? ATTEND_BURST_DEFAULT);
    const attendBeats = attendBeatCount(round.scanIds.length, burst);
    const attend = attendBeats * cfg.attendMs;
    const ffn = cfg.ffnRatio * cfg.attendMs;
    if (dwellMode === 'attendOnly') return attend;
    return attend + 2 * ffn;
}

/** 单次 FFN dwell = UI「Dwell × attend」（`ffnRatio × attendMs`）。 */
export function attentionFfnDwellMs(cfg: AttentionPlaybackConfig): number {
    return cfg.ffnRatio * cfg.attendMs;
}

/** 准备阶段开头 dwell 第 0 帧时长（见 {@link runAttentionPlayback}）；与 FFN dwell 同长；整场回放仅一次。 */
export function attendDwell0Ms(cfg: AttentionPlaybackConfig): number {
    return attentionFfnDwellMs(cfg);
}

export function attentionPlanTotalMs(
    plan: AttentionPlaybackPlan,
    cfg: AttentionPlaybackConfig,
    opts?: { includeLeadDwell0?: boolean },
): number {
    const dwell0 = opts?.includeLeadDwell0 ? attendDwell0Ms(cfg) : 0;
    if (plan.kind === 'prefill') {
        const n = plan.rounds.length;
        if (n === 0) return 0;
        const last = plan.rounds[n - 1]!;
        if ((cfg.prefillStyle ?? 'plain') === 'random' && n > 1) {
            const queryBurst = clampAttendBurst(cfg.queryBurst ?? QUERY_BURST_DEFAULT);
            const dwell = cfg.ffnRatio * cfg.attendMs;
            const randomFrames = attendBeatCount(n - 1, queryBurst);
            return (
                dwell0 +
                randomFrames * cfg.attendMs +
                dwell +
                attentionRoundMs(last, cfg, 'gen')
            );
        }
        return (
            dwell0 +
            plan.rounds.reduce(
                (sum, r, i) =>
                    sum +
                    attentionRoundMs(
                        r,
                        cfg,
                        i === n - 1 ? 'gen' : 'attendOnly',
                    ),
                0,
            )
        );
    }
    return dwell0 + attentionRoundMs(plan.round, cfg, 'gen');
}

/** output gen 准备阶段墙钟；无 plan 时为 0。 */
export function outputGenPrepMs(
    plan: AttentionPlaybackPlan | null,
    cfg: AttentionPlaybackConfig,
): number {
    if (!plan) return 0;
    return attentionPlanTotalMs(plan, cfg);
}

export function resolveApproxAttendMsFromOutputGenClock(
    outputGenClockMs: number,
    ffnRatio: number,
): number {
    /** 单 token attend beat + 2× FFN（decode 最短路径；会话首帧 dwell0 另计）。 */
    const denom = 1 + 2 * ffnRatio;
    if (denom <= 0 || outputGenClockMs <= 0) return 0;
    return outputGenClockMs / denom;
}

function lastNonExcludedGenIdBefore(
    steps: readonly TokenGenStep[],
    stepIndex: number,
    ctx: AttentionExcludeContext,
    skipOutputGen: (stepIndex: number) => boolean,
): string | null {
    for (let j = stepIndex - 1; j >= 0; j--) {
        if (skipOutputGen(j)) continue;
        const prev = steps[j]!;
        if (
            isDagGenStepTargetExcluded(
                prev,
                ctx.excludeIntervalContext,
                ctx.excludePromptPatternsText,
                ctx.excludeGeneratedPatternsText,
            )
        ) {
            continue;
        }
        return genStepTargetNodeId(prev);
    }
    return null;
}

/**
 * gen 前尚无 K/V、需在本轮准备阶段作 query 的 token（文序）。
 * 路径分派见文件头「原理 ↔ 实现」；tool 分支：call 末 token 在生成暂停时仅被采样、未再 forward。
 */
export function uncachedIdsBeforeOutputGen(
    steps: readonly TokenGenStep[],
    stepIndex: number,
    catalogSpans: readonly PromptTokenSpan[],
    ctx: AttentionExcludeContext,
    skipOutputGen: (stepIndex: number) => boolean,
): string[] {
    const step = steps[stepIndex];
    if (!step) return [];

    if (stepIndex === 0) {
        return inputSpanNodeIdsInRanges(
            catalogSpans,
            step.inputRanges,
            excludeIntervalsForStep(step, ctx),
            deleteIntervalsForStep(step, ctx),
        );
    }

    // call 末 + response：见 uncachedIdsBeforeOutputGen
    if (isToolCallingBoundaryBetweenSteps(steps, stepIndex - 1)) {
        const prevStep = steps[stepIndex - 1]!;
        const toolCallLastId = genStepTargetNodeId(prevStep);
        const newRanges = diffNewInputRanges(prevStep.inputRanges, step.inputRanges);
        const toolResponseIds = inputSpanNodeIdsInRanges(
            catalogSpans,
            newRanges,
            excludeIntervalsForStep(step, ctx),
            deleteIntervalsForStep(step, ctx),
        );
        if (toolResponseIds.length === 0) return [toolCallLastId];
        if (toolResponseIds[0] === toolCallLastId) return toolResponseIds;
        return [toolCallLastId, ...toolResponseIds];
    }

    const prevGenId = lastNonExcludedGenIdBefore(steps, stepIndex, ctx, skipOutputGen);
    return prevGenId != null ? [prevGenId] : [];
}

/** gen 前完整上下文：prompt/input + 此前 gen token，按文序 offset 合并。 */
export function contextIdsBeforeOutputGen(
    steps: readonly TokenGenStep[],
    stepIndex: number,
    catalogSpans: readonly PromptTokenSpan[],
    ctx: AttentionExcludeContext,
    skipOutputGen: (stepIndex: number) => boolean,
): string[] {
    const step = steps[stepIndex];
    if (!step) return [];
    const excludeIntervals = excludeIntervalsForStep(step, ctx);
    const deleteIntervals = deleteIntervalsForStep(step, ctx);
    const entries: { id: string; start: number }[] = [];
    for (const span of filterPromptSpansInInputRanges(normalizePromptTokenSpans(catalogSpans), [...step.inputRanges])) {
        const [s, e] = span.offset;
        if (!promptSpanInAttentionPlan(s, e, excludeIntervals, deleteIntervals)) continue;
        entries.push({ id: spanToNodeId(span), start: s });
    }
    for (let j = 0; j < stepIndex; j++) {
        if (skipOutputGen(j)) continue;
        const prev = steps[j]!;
        if (
            isDagGenStepTargetExcluded(
                prev,
                ctx.excludeIntervalContext,
                ctx.excludePromptPatternsText,
                ctx.excludeGeneratedPatternsText,
            )
        ) {
            continue;
        }
        entries.push({ id: genStepTargetNodeId(prev), start: prev.context.length });
    }
    entries.sort((a, b) => a.start - b.start);
    return entries.map((e) => e.id);
}

export type AttentionBudgetBreakdown = {
    scanCount: number;
    roundCount: number;
};

function budgetForPlan(plan: AttentionPlaybackPlan): { scanCount: number; roundCount: number } {
    if (plan.kind === 'prefill') {
        let scanCount = 0;
        for (const r of plan.rounds) scanCount += r.scanIds.length;
        return { scanCount, roundCount: plan.rounds.length };
    }
    return { scanCount: plan.round.scanIds.length, roundCount: 1 };
}

export function computeAttentionBudgetBreakdown(
    steps: readonly TokenGenStep[],
    events: readonly DagStepPlaybackEvent[],
    catalogSpans: readonly PromptTokenSpan[],
    ctx: AttentionExcludeContext,
    skipOutputGen: (stepIndex: number) => boolean,
    skipPrefill: boolean,
): AttentionBudgetBreakdown {
    let scanCount = 0;
    let roundCount = 0;

    for (const event of events) {
        if (event.kind !== 'outputGen') continue;
        const plan = planForOutputGenEvent(
            steps,
            event.stepIndex,
            catalogSpans,
            ctx,
            skipOutputGen,
            skipPrefill,
        );
        if (!plan) continue;
        const b = budgetForPlan(plan);
        scanCount += b.scanCount;
        roundCount += b.roundCount;
    }

    return { scanCount, roundCount };
}

export function resolveAttentionPlaybackConfig(
    pacing: { mode: 'total' | 'step'; totalS: number; stepMs: number },
    attendMsFromControl: number,
    ffnRatio: number,
    outputGenClockMs: number,
): AttentionPlaybackConfig {
    const attendMs =
        pacing.mode === 'total'
            ? resolveApproxAttendMsFromOutputGenClock(outputGenClockMs, ffnRatio)
            : attendMsFromControl;
    return { attendMs, ffnRatio };
}

/** 按文件头「原理 ↔ 实现」组 plan：context → scan 池，uncached → query 候选，skip 仅减轮次。 */
export function planForOutputGenEvent(
    steps: readonly TokenGenStep[],
    stepIndex: number,
    catalogSpans: readonly PromptTokenSpan[],
    ctx: AttentionExcludeContext,
    skipOutputGen: (stepIndex: number) => boolean,
    skipPrefill: boolean,
): AttentionPlaybackPlan | null {
    if (skipOutputGen(stepIndex)) return null;
    if (!steps[stepIndex]) return null;

    const scanIds = contextIdsBeforeOutputGen(
        steps,
        stepIndex,
        catalogSpans,
        ctx,
        skipOutputGen,
    );
    if (scanIds.length === 0) return null;

    const uncached = uncachedIdsBeforeOutputGen(
        steps,
        stepIndex,
        catalogSpans,
        ctx,
        skipOutputGen,
    );
    const queryCandidates =
        uncached.length > 0 ? uncached : [scanIds[scanIds.length - 1]!];

    if (queryCandidates.length > 1 && !skipPrefill) {
        const rounds = buildPrefillRounds(queryCandidates, scanIds);
        return rounds.length > 0 ? { kind: 'prefill', rounds } : null;
    }

    const queryTokenId = queryCandidates[queryCandidates.length - 1]!;
    return { kind: 'decode', round: buildAttentionRound(queryTokenId, scanIds) };
}
