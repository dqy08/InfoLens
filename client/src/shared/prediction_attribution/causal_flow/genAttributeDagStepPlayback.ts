/**
 * DAG **步进回放**（▶）事件队列：与传播链动画（↯，`genAttributeDagRecursiveEdgeAnimation`）无关。
 *
 * 每段内容在**出现前**等待其自身模拟开销（`appearanceCostMs`），再 show → 下一事件。
 * 开销为 0 的段（prompt、exclude 命中的 gen 等）在同一次调用栈内连续 show，不用 `setTimer`，避免中间帧闪烁。
 */
import type { TokenGenStep } from './tokenGenAttributionRunner';
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
 * `inputPauseDue`：prompt / tool response 已展示，但「input 后首拍」尚未消费。
 * exclude 命中的 gen 仍 `showOutputGen`，开销为 0，且**不**消费首拍；首拍落在第一个非 exclude 的 gen。
 */
export function buildDagStepPlaybackAppearanceCosts(
    events: readonly DagStepPlaybackEvent[],
    clocks: DagStepPlaybackClocks,
    skipOutputGen?: (stepIndex: number) => boolean,
): number[] {
    let inputPauseDue = false;
    return events.map((event) => {
        switch (event.kind) {
            case 'prompt':
                inputPauseDue = true;
                return 0;
            case 'toolResponse':
                inputPauseDue = true;
                return clocks.toolResponseClockMs;
            case 'outputGen': {
                if (skipOutputGen?.(event.stepIndex)) return 0;
                if (inputPauseDue) {
                    inputPauseDue = false;
                    return clocks.genAfterInputClockMs;
                }
                return event.stepIndex === 0 ? 0 : clocks.outputGenClockMs;
            }
            default: {
                const _exhaustive: never = event;
                return _exhaustive;
            }
        }
    });
}

/** {@link buildDagStepPlaybackAppearanceCosts} 的单事件便捷访问（测试用）。 */
export function dagStepPlaybackAppearanceCostMs(
    event: DagStepPlaybackEvent,
    eventIndex: number,
    events: readonly DagStepPlaybackEvent[],
    clocks: DagStepPlaybackClocks,
    skipAppearanceCostForOutputGen?: (stepIndex: number) => boolean,
): number {
    return buildDagStepPlaybackAppearanceCosts(events, clocks, skipAppearanceCostForOutputGen)[
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
    /** exclude 命中的 output gen：仍 `showOutputGen`，但 appearance 开销为 0。 */
    skipAppearanceCostForOutputGen?: (stepIndex: number) => boolean;
};

/** 从 `start.eventIndex` 起逐事件：0 开销段同步连播，有开销段才 `setTimer`。 */
export function runDagStepPlaybackLoop(opts: RunDagStepPlaybackLoopOptions): void {
    const clock = createPlaybackDueClock();
    const appearanceCosts = buildDagStepPlaybackAppearanceCosts(
        opts.events,
        opts.clocks,
        opts.skipAppearanceCostForOutputGen,
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
            const appearanceCostMs = skipAppearanceCost ? 0 : appearanceCosts[eventIndex]!;
            skipAppearanceCost = false;

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
