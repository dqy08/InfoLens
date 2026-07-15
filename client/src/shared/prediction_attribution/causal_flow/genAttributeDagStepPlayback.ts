/**
 * DAG **步进回放**（▶）事件队列：与传播链动画（↯，`genAttributeDagRecursiveEdgeAnimation`）无关。
 *
 * prompt / toolResponse：出现前等待 `appearanceCostMs`（tool 等待）。
 * outputGen：出现前统一走准备阶段（`outputGenPrep`）；勾选 Simulate attention 时播动画，否则 `setTimer` 用旧版固定时钟。
 * 开销为 0 的段在同一次调用栈内连续 show，不用 `setTimer`。
 */
import type { TokenGenStep } from './tokenGenAttributionRunner';
import type { AttentionPlaybackPlan } from './genAttributeDagAttentionPlayback';
import {
    resolveDagStepPlaybackClocks,
    type DagRecursiveEdgeReplayPacing,
    type DagStepPlaybackClocks,
} from './genAttributeDagPropagationPlaybackPacing';

export type DagStepPlaybackEvent =
    | { kind: 'prompt' }
    | { kind: 'toolResponse'; stepIndex: number }
    | { kind: 'outputGen'; stepIndex: number };

export type { DagStepPlaybackClocks };

/** 相邻 output gen 之间是否夹 tool（下一步 `inputRanges` 变长）。 */
export function isToolCallingBoundaryBetweenSteps(
    steps: readonly TokenGenStep[],
    afterStepIndex: number,
): boolean {
    const next = steps[afterStepIndex + 1];
    if (!next) return false;
    const cur = steps[afterStepIndex]!;
    return next.inputRanges.length > cur.inputRanges.length;
}

export function countToolCallingBoundaries(steps: readonly TokenGenStep[]): number {
    let n = 0;
    for (let i = 0; i + 1 < steps.length; i++) {
        if (isToolCallingBoundaryBetweenSteps(steps, i)) n++;
    }
    return n;
}

export function resolveDagStepPlaybackClocksFromPacing(
    steps: readonly TokenGenStep[],
    pacing: DagRecursiveEdgeReplayPacing,
): DagStepPlaybackClocks {
    return resolveDagStepPlaybackClocks(steps.length, countToolCallingBoundaries(steps), pacing);
}

/** 按回放顺序展开：prompt（可选）→ 每步 output gen；轮间边界前插入 tool response。 */
export function buildDagStepPlaybackEvents(
    steps: readonly TokenGenStep[],
    includePrompt: boolean,
): DagStepPlaybackEvent[] {
    const events: DagStepPlaybackEvent[] = [];
    if (includePrompt) events.push({ kind: 'prompt' });
    for (let i = 0; i < steps.length; i++) {
        if (i > 0 && isToolCallingBoundaryBetweenSteps(steps, i - 1)) {
            events.push({ kind: 'toolResponse', stepIndex: i });
        }
        events.push({ kind: 'outputGen', stepIndex: i });
    }
    return events;
}

/**
 * 正向扫描事件队列，预计算每段出现前的模拟开销（ms）。
 *
 * `outputGen` 的准备耗时由 {@link DagStepPlaybackOutputGenPrep.resolve} 统一计算，此处恒为 0。
 */
export function buildDagStepPlaybackAppearanceCosts(
    events: readonly DagStepPlaybackEvent[],
    clocks: DagStepPlaybackClocks,
    /** Simulate attention 时与 live mock tool 一致，不再用 {@link DagStepPlaybackClocks.toolResponseClockMs}。 */
    toolResponseAppearanceCostMs?: number,
): number[] {
    const toolResponseMs = toolResponseAppearanceCostMs ?? clocks.toolResponseClockMs;
    return events.map((event) => {
        switch (event.kind) {
            case 'prompt':
                return 0;
            case 'toolResponse':
                return toolResponseMs;
            case 'outputGen':
                return 0;
            default: {
                const _exhaustive: never = event;
                return _exhaustive;
            }
        }
    });
}

/**
 * 未勾选 Simulate attention 时，各 output gen 步的固定准备延迟（ms）。
 *
 * `inputPauseDue`：prompt / tool response 已展示，但「input 后首拍」尚未消费。
 * exclude 命中的 gen 为 0，且**不**消费首拍；首拍落在第一个非 exclude 的 gen。
 */
export function buildOutputGenLegacyPrepMs(
    events: readonly DagStepPlaybackEvent[],
    clocks: DagStepPlaybackClocks,
    skipOutputGen?: (stepIndex: number) => boolean,
): ReadonlyMap<number, number> {
    let inputPauseDue = false;
    const byStepIndex = new Map<number, number>();
    for (const event of events) {
        switch (event.kind) {
            case 'prompt':
                inputPauseDue = true;
                break;
            case 'toolResponse':
                inputPauseDue = true;
                break;
            case 'outputGen': {
                if (skipOutputGen?.(event.stepIndex)) {
                    byStepIndex.set(event.stepIndex, 0);
                } else if (inputPauseDue) {
                    inputPauseDue = false;
                    byStepIndex.set(event.stepIndex, clocks.genAfterInputClockMs);
                } else {
                    byStepIndex.set(
                        event.stepIndex,
                        event.stepIndex === 0 ? 0 : clocks.outputGenClockMs,
                    );
                }
                break;
            }
            default: {
                const _exhaustive: never = event;
                void _exhaustive;
            }
        }
    }
    return byStepIndex;
}

/** 单步便捷访问（测试用）。 */
export function outputGenLegacyPrepMs(
    stepIndex: number,
    events: readonly DagStepPlaybackEvent[],
    clocks: DagStepPlaybackClocks,
    skipOutputGen?: (stepIndex: number) => boolean,
): number {
    return buildOutputGenLegacyPrepMs(events, clocks, skipOutputGen).get(stepIndex) ?? 0;
}

/** {@link buildDagStepPlaybackAppearanceCosts} 的单事件便捷访问（测试用）。 */
export function dagStepPlaybackAppearanceCostMs(
    event: DagStepPlaybackEvent,
    eventIndex: number,
    events: readonly DagStepPlaybackEvent[],
    clocks: DagStepPlaybackClocks,
    toolResponseAppearanceCostMs?: number,
): number {
    return buildDagStepPlaybackAppearanceCosts(events, clocks, toolResponseAppearanceCostMs)[
        eventIndex
    ]!;
}

export type DagStepPlaybackStart = {
    eventIndex: number;
    /** 中途恢复时首段内容立即出现，不再计模拟开销。 */
    skipAppearanceCostForFirstEvent: boolean;
};

/** 从 `nextOutputGenStepIndex`（= `dagPlaybackNextIndex`）映射到事件队列起点。 */
export function resolveDagStepPlaybackStart(
    events: readonly DagStepPlaybackEvent[],
    steps: readonly TokenGenStep[],
    nextOutputGenStepIndex: number,
    includePrompt: boolean,
): DagStepPlaybackStart {
    if (nextOutputGenStepIndex === 0 && includePrompt) {
        return { eventIndex: 0, skipAppearanceCostForFirstEvent: false };
    }
    if (nextOutputGenStepIndex === 0) {
        const eventIndex = events.findIndex((e) => e.kind === 'outputGen' && e.stepIndex === 0);
        return { eventIndex: eventIndex < 0 ? 0 : eventIndex, skipAppearanceCostForFirstEvent: true };
    }
    const i = nextOutputGenStepIndex;
    if (i > 0 && isToolCallingBoundaryBetweenSteps(steps, i - 1)) {
        const eventIndex = events.findIndex((e) => e.kind === 'toolResponse' && e.stepIndex === i);
        return { eventIndex: eventIndex < 0 ? events.length : eventIndex, skipAppearanceCostForFirstEvent: true };
    }
    const eventIndex = events.findIndex((e) => e.kind === 'outputGen' && e.stepIndex === i);
    return { eventIndex: eventIndex < 0 ? events.length : eventIndex, skipAppearanceCostForFirstEvent: true };
}

function createPlaybackDueClock(): { delayMs(intendedMs: number): number; reanchor(): void } {
    let nextDue = performance.now();
    return {
        /** RAF 等不经过 `delayMs` 的间隔后重锚，避免「追进度」把下一拍等待压成 0。 */
        reanchor(): void {
            nextDue = performance.now();
        },
        delayMs(intendedMs: number): number {
            const now = performance.now();
            nextDue += intendedMs;
            let delay = Math.max(0, nextDue - now);
            if (delay === 0) nextDue = now + intendedMs;
            return delay;
        },
    };
}

export type OutputGenPrep = {
    plan: AttentionPlaybackPlan | null;
    prepMs: number;
};

/** 每个 output gen 前的准备阶段：动画用 plan；未勾选 simulate 时 prepMs 为旧版固定时钟。 */
export type ResolveOutputGenPrep = (stepIndex: number) => OutputGenPrep;

/** 勾选 Simulate attention 时，用动画度过准备阶段；`showGen` 在 FFN 前延迟结束后、FFN 后延迟开始前调用。 */
export type PlayOutputGenAttentionPrep = (
    stepIndex: number,
    plan: AttentionPlaybackPlan,
    showGen: () => void,
    advance: () => void,
) => void;

export type DagStepPlaybackOutputGenPrep = {
    resolve: ResolveOutputGenPrep;
    playAnimation?: PlayOutputGenAttentionPrep;
};

export type RunDagStepPlaybackLoopOptions = {
    events: readonly DagStepPlaybackEvent[];
    start: DagStepPlaybackStart;
    clocks: DagStepPlaybackClocks;
    isStale: () => boolean;
    setTimer: (cb: () => void, delayMs: number) => void;
    setToolPendingVisible: (visible: boolean) => void;
    showPrompt: () => void;
    showToolResponse: (stepIndex: number) => void;
    showOutputGen: (stepIndex: number) => void;
    /** 每段内容展示后调用（如步进重放开启 Auto zoom 时 fit 视口）。 */
    afterStepShown?: () => void;
    onOutputGenShown: (stepIndex: number) => void;
    onAllOutputGensShown: () => void;
    /** exclude 命中的 output gen：仍 `showOutputGen`，准备耗时为 0。 */
    skipAppearanceCostForOutputGen?: (stepIndex: number) => boolean;
    outputGenPrep?: DagStepPlaybackOutputGenPrep;
    /** Simulate attention：与 live mock tool 固定等待一致。 */
    toolResponseAppearanceCostMs?: number;
};

/** 从 `start.eventIndex` 起逐事件：0 开销段同步连播，有开销段才 `setTimer`。 */
export function runDagStepPlaybackLoop(opts: RunDagStepPlaybackLoopOptions): void {
    const clock = createPlaybackDueClock();
    const outputGenPrep = opts.outputGenPrep;
    const appearanceCosts = buildDagStepPlaybackAppearanceCosts(
        opts.events,
        opts.clocks,
        opts.toolResponseAppearanceCostMs,
    );

    const showEvent = (event: DagStepPlaybackEvent): void => {
        switch (event.kind) {
            case 'prompt':
                opts.showPrompt();
                break;
            case 'toolResponse':
                opts.showToolResponse(event.stepIndex);
                break;
            case 'outputGen':
                opts.showOutputGen(event.stepIndex);
                opts.onOutputGenShown(event.stepIndex);
                break;
            default: {
                const _exhaustive: never = event;
                void _exhaustive;
            }
        }
    };

    const playFrom = (eventIndex: number, skipAppearanceCost: boolean): void => {
        if (opts.isStale()) return;

        while (eventIndex < opts.events.length) {
            const event = opts.events[eventIndex]!;
            const skipCostThisEvent = skipAppearanceCost;
            let appearanceCostMs = skipCostThisEvent ? 0 : appearanceCosts[eventIndex]!;
            skipAppearanceCost = false;

            if (event.kind === 'outputGen' && outputGenPrep) {
                if (opts.skipAppearanceCostForOutputGen?.(event.stepIndex)) {
                    showEvent(event);
                    opts.afterStepShown?.();
                    eventIndex++;
                    continue;
                }
                const idx = eventIndex;
                const { plan, prepMs: resolvedPrepMs } = outputGenPrep.resolve(event.stepIndex);
                const prepMs = skipCostThisEvent ? 0 : resolvedPrepMs;
                const showGen = (): void => {
                    if (opts.isStale()) return;
                    showEvent(event);
                    opts.afterStepShown?.();
                };
                const advance = (): void => {
                    if (opts.isStale()) return;
                    clock.reanchor();
                    playFrom(idx + 1, false);
                };
                if (outputGenPrep.playAnimation) {
                    if (!plan) {
                        showGen();
                        eventIndex++;
                        continue;
                    }
                    outputGenPrep.playAnimation(event.stepIndex, plan, showGen, advance);
                    return;
                }
                if (prepMs <= 0) {
                    showGen();
                    eventIndex++;
                    continue;
                }
                opts.setTimer(() => {
                    showGen();
                    advance();
                }, clock.delayMs(prepMs));
                return;
            }

            if (appearanceCostMs > 0) {
                const showPendingDuringCost = event.kind === 'toolResponse';
                if (showPendingDuringCost) opts.setToolPendingVisible(true);
                const idx = eventIndex;
                opts.setTimer(() => {
                    if (opts.isStale()) return;
                    if (showPendingDuringCost) opts.setToolPendingVisible(false);
                    showEvent(event);
                    opts.afterStepShown?.();
                    playFrom(idx + 1, false);
                }, clock.delayMs(appearanceCostMs));
                return;
            }

            showEvent(event);
            opts.afterStepShown?.();
            eventIndex++;
        }

        opts.onAllOutputGensShown();
    };

    playFrom(opts.start.eventIndex, opts.start.skipAppearanceCostForFirstEvent);
}
