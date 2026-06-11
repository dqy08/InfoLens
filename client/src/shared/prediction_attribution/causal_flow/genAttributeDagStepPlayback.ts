/**
 * DAG **步进回放**（▶）事件队列：与传播链动画（↯，`genAttributeDagRecursiveEdgeAnimation`）无关。
 *
 * 每段内容在**出现前**自行计算 `delayBeforeMs`（等到下一段内容），再 delay → show → 调度下一事件。
 */
import type { TokenGenStep } from './tokenGenAttributionRunner';
import {
    resolveDagStepPlaybackDelays,
    type DagRecursiveEdgeReplayPacing,
} from './genAttributeDagPropagationPlaybackPacing';

export type DagStepPlaybackEvent =
    | { kind: 'prompt' }
    | { kind: 'toolResponse'; stepIndex: number }
    | { kind: 'outputGen'; stepIndex: number };

export type DagStepPlaybackDelays = {
    stepDelayMs: number;
    waitUntilResponseMs: number;
    waitAfterInputMs: number;
};

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

export function resolveDagStepPlaybackDelaysFromPacing(
    steps: readonly TokenGenStep[],
    pacing: DagRecursiveEdgeReplayPacing,
): DagStepPlaybackDelays {
    return resolveDagStepPlaybackDelays(steps.length, countToolCallingBoundaries(steps), pacing);
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
 * 本段内容出现前要等的时长（ms）。语义见 `genAttributeDagPropagationPlaybackPacing` 模块注释表。
 */
export function dagStepPlaybackDelayBeforeMs(
    event: DagStepPlaybackEvent,
    eventIndex: number,
    events: readonly DagStepPlaybackEvent[],
    delays: DagStepPlaybackDelays,
): number {
    switch (event.kind) {
        case 'prompt':
            return 0;
        case 'toolResponse':
            return delays.waitUntilResponseMs;
        case 'outputGen': {
            const prev = eventIndex > 0 ? events[eventIndex - 1] : undefined;
            if (prev?.kind === 'prompt' || prev?.kind === 'toolResponse') {
                return delays.waitAfterInputMs;
            }
            if (event.stepIndex === 0) return 0;
            return delays.stepDelayMs;
        }
        default: {
            const _exhaustive: never = event;
            return _exhaustive;
        }
    }
}

export type DagStepPlaybackStart = {
    eventIndex: number;
    /** 中途恢复时首段内容立即出现，不再等 delayBefore。 */
    skipDelayForFirstEvent: boolean;
};

/** 从 `nextOutputGenStepIndex`（= `dagPlaybackNextIndex`）映射到事件队列起点。 */
export function resolveDagStepPlaybackStart(
    events: readonly DagStepPlaybackEvent[],
    steps: readonly TokenGenStep[],
    nextOutputGenStepIndex: number,
    includePrompt: boolean,
): DagStepPlaybackStart {
    if (nextOutputGenStepIndex === 0 && includePrompt) {
        return { eventIndex: 0, skipDelayForFirstEvent: false };
    }
    if (nextOutputGenStepIndex === 0) {
        const eventIndex = events.findIndex((e) => e.kind === 'outputGen' && e.stepIndex === 0);
        return { eventIndex: eventIndex < 0 ? 0 : eventIndex, skipDelayForFirstEvent: true };
    }
    const i = nextOutputGenStepIndex;
    if (i > 0 && isToolCallingBoundaryBetweenSteps(steps, i - 1)) {
        const eventIndex = events.findIndex((e) => e.kind === 'toolResponse' && e.stepIndex === i);
        return { eventIndex: eventIndex < 0 ? events.length : eventIndex, skipDelayForFirstEvent: true };
    }
    const eventIndex = events.findIndex((e) => e.kind === 'outputGen' && e.stepIndex === i);
    return { eventIndex: eventIndex < 0 ? events.length : eventIndex, skipDelayForFirstEvent: true };
}

function createPlaybackDueClock(): { delayMs(intendedMs: number): number } {
    let nextDue = performance.now();
    return {
        delayMs(intendedMs: number): number {
            const now = performance.now();
            nextDue += intendedMs;
            let delay = Math.max(0, nextDue - now);
            if (delay === 0) nextDue = now + intendedMs;
            return delay;
        },
    };
}

export type RunDagStepPlaybackLoopOptions = {
    events: readonly DagStepPlaybackEvent[];
    start: DagStepPlaybackStart;
    delays: DagStepPlaybackDelays;
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
};

/** 从 `start.eventIndex` 起逐事件：delayBefore → show → 下一事件。 */
export function runDagStepPlaybackLoop(opts: RunDagStepPlaybackLoopOptions): void {
    const clock = createPlaybackDueClock();

    const playFrom = (eventIndex: number, skipDelay: boolean): void => {
        if (opts.isStale()) return;
        if (eventIndex >= opts.events.length) return;

        const event = opts.events[eventIndex]!;
        const intendedDelay = skipDelay
            ? 0
            : dagStepPlaybackDelayBeforeMs(event, eventIndex, opts.events, opts.delays);
        const showPendingDuringDelay = event.kind === 'toolResponse' && intendedDelay > 0;
        if (showPendingDuringDelay) opts.setToolPendingVisible(true);

        opts.setTimer(() => {
            if (opts.isStale()) return;
            if (showPendingDuringDelay) opts.setToolPendingVisible(false);

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
            opts.afterStepShown?.();

            const nextIndex = eventIndex + 1;
            if (nextIndex >= opts.events.length) {
                opts.onAllOutputGensShown();
                return;
            }
            playFrom(nextIndex, false);
        }, clock.delayMs(intendedDelay));
    };

    playFrom(opts.start.eventIndex, opts.start.skipDelayForFirstEvent);
}
