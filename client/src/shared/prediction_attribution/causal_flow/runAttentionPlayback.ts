/**
 * AttentionRound 串行播放：按 {@link RoundDwellMode} 决定相位。
 * - `attendOnly`：仅 attend（prefill 中间轮）
 * - `gen`：attend → FFN前延迟 → onGenAppear → FFN后延迟
 *
 * prefillStyle `random`：query 按 queryBurst 批处理（乱序）、attendBurst 随机高亮，dwell 后末轮 plain sweep。
 *
 * 整场注意力回放仅一次 **dwell 第 0 帧**（1× FFN dwell = `ffnRatio × attendMs`）：`litIds` 为空、无 active query，全上下文压暗后再开始扫（续播第 2+ 个 output gen 时 {@link RunAttentionPlaybackOptions.skipLeadDwell0}）。
 *
 * UI 称 FFN 停留倍率为 dwell ratio；代码仍用 `ffnRatio`。
 */
import {
    ATTEND_BURST_DEFAULT,
    QUERY_BURST_DEFAULT,
    attendDwell0Ms,
    clampAttendBurst,
    randomPrefillLitIds,
    shuffleInPlace,
    type AttentionPlaybackConfig,
    type AttentionPlaybackPlan,
    type AttentionRoundPlan,
    type RoundDwellMode,
} from './genAttributeDagAttentionPlayback';

export type AttentionPlaybackHighlight = {
    queryTokenId: string | null;
    /** random queryBurst>1：本帧并行的 active query（fill 高亮）。 */
    queryTokenIds?: readonly string[];
    litIds: readonly string[];
    phase: 'attend' | 'ffn';
    /** prefill 已完成、K/V 已建立的 query：持久外框；gen 出现前一帧清掉。 */
    kvEstablishedQueryIds?: readonly string[];
} | null;

export type RunAttentionPlaybackOptions = {
    plan: AttentionPlaybackPlan;
    config: AttentionPlaybackConfig;
    setHighlight: (state: AttentionPlaybackHighlight) => void;
    /** FFN 前延迟结束后、FFN 后延迟开始前：展示 gen token 并转移高亮。 */
    onGenAppear?: () => void;
    onDone: () => void;
    setCancel?: (cancel: (() => void) | null) => void;
    isCancelled?: () => boolean;
    /** 续播第 2+ 个 output gen 时为 true，跳过会话首帧 dwell0。 */
    skipLeadDwell0?: boolean;
};

type DriveRoundOptions = {
    round: AttentionRoundPlan;
    config: AttentionPlaybackConfig;
    dwellMode: RoundDwellMode;
    kvEstablishedQueryIds?: readonly string[];
    /** gen 轮 onGenAppear 前清掉 kv 外框（默认 true）。 */
    clearKvEstablishedAfterAttend?: boolean;
    setHighlight: (state: AttentionPlaybackHighlight) => void;
    onGenAppear?: () => void;
    onComplete: () => void;
    setCancel?: (cancel: (() => void) | null) => void;
    isCancelled?: () => boolean;
};

/** attend → ffnBeforeAppear → ffnAfterAppear */
type PlaybackPhase = 'attend' | 'ffnBeforeAppear' | 'ffnAfterAppear';

export function attendLitIdsForBand(
    scanIds: readonly string[],
    fromExclusiveEnd: number,
    toExclusiveEnd: number,
    beatFromExclusive?: number,
): string[] {
    if (toExclusiveEnd <= 0) return [];
    if (fromExclusiveEnd < toExclusiveEnd) {
        return scanIds.slice(fromExclusiveEnd, toExclusiveEnd);
    }
    const holdFrom =
        beatFromExclusive != null
            ? beatFromExclusive
            : Math.max(0, toExclusiveEnd - 1);
    return scanIds.slice(holdFrom, toExclusiveEnd);
}

export function attendLitIdsAccumulative(
    scanIds: readonly string[],
    toExclusiveEnd: number,
): string[] {
    if (toExclusiveEnd <= 0) return [];
    return scanIds.slice(0, toExclusiveEnd);
}

function withKvEstablished(
    state: AttentionPlaybackHighlight,
    kvEstablishedQueryIds: readonly string[] | undefined,
): AttentionPlaybackHighlight {
    if (state == null || !kvEstablishedQueryIds?.length) return state;
    return { ...state, kvEstablishedQueryIds };
}

function delayMs(
    ms: number,
    onComplete: () => void,
    setCancel?: (cancel: (() => void) | null) => void,
    isCancelled?: () => boolean,
): void {
    let elapsed = 0;
    let lastTs: number | null = null;
    let rafId = 0;

    const cancel = (): void => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        setCancel?.(null);
    };

    const tick = (ts: number): void => {
        if (isCancelled?.()) {
            cancel();
            return;
        }
        if (lastTs != null) elapsed += ts - lastTs;
        lastTs = ts;
        if (elapsed >= ms) {
            cancel();
            onComplete();
            return;
        }
        rafId = requestAnimationFrame(tick);
    };

    setCancel?.(cancel);
    rafId = requestAnimationFrame(tick);
}

function driveRoundWithRaf(opts: DriveRoundOptions): void {
    const {
        round,
        config,
        dwellMode,
        kvEstablishedQueryIds,
        clearKvEstablishedAfterAttend = true,
        setHighlight,
        onGenAppear,
        onComplete,
        setCancel,
        isCancelled,
    } = opts;
    let attachKvEstablished = kvEstablishedQueryIds != null && kvEstablishedQueryIds.length > 0;
    const isGenRound = dwellMode === 'gen';
    const emit = (state: AttentionPlaybackHighlight): void => {
        const kv =
            attachKvEstablished && kvEstablishedQueryIds?.length
                ? kvEstablishedQueryIds
                : undefined;
        setHighlight(withKvEstablished(state, kv));
    };
    const clearKvEstablishedForGenFfn = (): void => {
        if (isGenRound && clearKvEstablishedAfterAttend) {
            attachKvEstablished = false;
        }
    };
    const { attendMs, ffnRatio, accumulativeHighlight, attendBurst: attendBurstRaw } = config;
    const attendBurst = clampAttendBurst(attendBurstRaw ?? 1);
    const ffnMs = ffnRatio * attendMs;
    const tokenCount = round.scanIds.length;
    let sweptExclusiveEnd = 0;
    let beatFromExclusive = 0;
    let phase: PlaybackPhase = 'attend';
    let elapsed = 0;
    let lastTs: number | null = null;
    let rafId = 0;
    let stopped = false;

    const cancel = (): void => {
        if (rafId) cancelAnimationFrame(rafId);
        rafId = 0;
        setCancel?.(null);
    };

    const endRound = (): void => {
        stopped = true;
        cancel();
        onComplete();
    };

    const scheduleNext = (ts: number): void => {
        if (stopped) return;
        lastTs = ts;
        rafId = requestAnimationFrame(tick);
    };

    const renderAttendBand = (sweptAtFrameStart: number): void => {
        const litIds = accumulativeHighlight
            ? attendLitIdsAccumulative(round.scanIds, sweptExclusiveEnd)
            : attendLitIdsForBand(
                  round.scanIds,
                  sweptAtFrameStart,
                  sweptExclusiveEnd,
                  beatFromExclusive,
              );
        if (litIds.length === 0) return;
        emit({
            queryTokenId: round.queryTokenId,
            litIds,
            phase: 'attend',
        });
    };

    const highlightQueryFfn = (): void => {
        emit({
            queryTokenId: round.queryTokenId,
            litIds: [round.queryTokenId],
            phase: 'ffn',
        });
    };

    const completeFfnBeforeAppear = (): void => {
        clearKvEstablishedForGenFfn();
        if (onGenAppear) {
            onGenAppear();
        } else {
            emit(null);
        }
        phase = 'ffnAfterAppear';
    };

    const advanceAttendBeats = (): void => {
        while (elapsed >= attendMs) {
            elapsed -= attendMs;
            if (sweptExclusiveEnd < tokenCount) {
                beatFromExclusive = sweptExclusiveEnd;
                sweptExclusiveEnd = Math.min(sweptExclusiveEnd + attendBurst, tokenCount);
            } else if (isGenRound) {
                phase = 'ffnBeforeAppear';
                return;
            } else {
                endRound();
                return;
            }
        }
    };

    const tryCompleteFfnBeforeAppear = (): boolean => {
        if (elapsed < ffnMs) return false;
        elapsed -= ffnMs;
        completeFfnBeforeAppear();
        return true;
    };

    const tryCompleteFfnAfterAppear = (): boolean => {
        if (elapsed < ffnMs) return false;
        elapsed -= ffnMs;
        endRound();
        return true;
    };

    const tick = (ts: number): void => {
        if (isCancelled?.()) {
            cancel();
            return;
        }

        if (lastTs != null) {
            elapsed += ts - lastTs;
        }

        if (phase === 'attend') {
            const sweptAtFrameStart = sweptExclusiveEnd;
            advanceAttendBeats();
            if (stopped) return;
            if (phase === 'attend') {
                renderAttendBand(sweptAtFrameStart);
            } else if (phase === 'ffnBeforeAppear') {
                highlightQueryFfn();
            }
        } else if (phase === 'ffnBeforeAppear') {
            if (tryCompleteFfnBeforeAppear()) {
                scheduleNext(ts);
                return;
            }
            highlightQueryFfn();
        } else if (tryCompleteFfnAfterAppear()) {
            return;
        }

        scheduleNext(ts);
    };

    if (tokenCount > 0) {
        beatFromExclusive = 0;
        sweptExclusiveEnd = Math.min(attendBurst, tokenCount);
        renderAttendBand(0);
    } else if (isGenRound) {
        phase = 'ffnBeforeAppear';
        highlightQueryFfn();
    } else {
        endRound();
        return;
    }

    setCancel?.(cancel);
    rafId = requestAnimationFrame(tick);
}

/** attend 扫掠前的第 0 帧：进入注意力视觉态，但无一 token fill / query 描边。 */
export function attendDwell0Highlight(
    kvEstablishedQueryIds?: readonly string[],
): AttentionPlaybackHighlight {
    return {
        queryTokenId: null,
        litIds: [],
        phase: 'attend',
        kvEstablishedQueryIds:
            kvEstablishedQueryIds != null && kvEstablishedQueryIds.length > 0
                ? kvEstablishedQueryIds
                : undefined,
    };
}

function runAttendDwell0Then(
    config: AttentionPlaybackConfig,
    setHighlight: (state: AttentionPlaybackHighlight) => void,
    kvEstablishedQueryIds: readonly string[] | undefined,
    onContinue: () => void,
    setCancel?: (cancel: (() => void) | null) => void,
    isCancelled?: () => boolean,
): void {
    setHighlight(attendDwell0Highlight(kvEstablishedQueryIds));
    delayMs(
        attendDwell0Ms(config),
        () => {
            if (isCancelled?.()) return;
            onContinue();
        },
        setCancel,
        isCancelled,
    );
}

function runRandomPrefillThenGen(
    rounds: readonly AttentionRoundPlan[],
    config: AttentionPlaybackConfig,
    setHighlight: (state: AttentionPlaybackHighlight) => void,
    onGenAppear: (() => void) | undefined,
    onDone: () => void,
    setCancel?: (cancel: (() => void) | null) => void,
    isCancelled?: () => boolean,
): void {
    const prefillRounds = shuffleInPlace(rounds.slice(0, -1));
    const finalRound = rounds[rounds.length - 1]!;
    const kvEstablished: string[] = [];
    const attendBurst = clampAttendBurst(config.attendBurst ?? ATTEND_BURST_DEFAULT);
    const queryBurst = clampAttendBurst(config.queryBurst ?? QUERY_BURST_DEFAULT);
    const dwellMs = config.ffnRatio * config.attendMs;
    let frameIndex = 0;

    const emit = (state: AttentionPlaybackHighlight): void => {
        if (state == null) {
            setHighlight(null);
            return;
        }
        setHighlight({
            ...state,
            kvEstablishedQueryIds: kvEstablished.length > 0 ? [...kvEstablished] : undefined,
        });
    };

    const startFinalRound = (): void => {
        driveRoundWithRaf({
            round: finalRound,
            config,
            dwellMode: 'gen',
            kvEstablishedQueryIds: kvEstablished,
            setHighlight,
            onGenAppear,
            onComplete: () => {
                if (isCancelled?.()) return;
                setHighlight(null);
                onDone();
            },
            setCancel,
            isCancelled,
        });
    };

    const playFrame = (): void => {
        if (isCancelled?.()) return;
        if (frameIndex >= prefillRounds.length) {
            emit({
                queryTokenId: null,
                litIds: [],
                phase: 'attend',
            });
            delayMs(dwellMs, startFinalRound, setCancel, isCancelled);
            return;
        }
        const batchEnd = Math.min(frameIndex + queryBurst, prefillRounds.length);
        const batch = prefillRounds.slice(frameIndex, batchEnd);
        for (const round of batch) {
            kvEstablished.push(round.queryTokenId);
        }
        emit({
            queryTokenId: batch.length === 1 ? batch[0]!.queryTokenId : null,
            queryTokenIds: batch.length > 1 ? batch.map((round) => round.queryTokenId) : undefined,
            litIds: batch.flatMap((round) => randomPrefillLitIds(round.scanIds, attendBurst)),
            phase: 'attend',
        });
        frameIndex = batchEnd;
        delayMs(config.attendMs, playFrame, setCancel, isCancelled);
    };

    playFrame();
}

function runPrefillRounds(
    rounds: readonly AttentionRoundPlan[],
    config: AttentionPlaybackConfig,
    setHighlight: (state: AttentionPlaybackHighlight) => void,
    roundIndex: number,
    onGenAppear: (() => void) | undefined,
    onDone: () => void,
    setCancel?: (cancel: (() => void) | null) => void,
    isCancelled?: () => boolean,
    kvEstablished: string[] = [],
): void {
    if (roundIndex >= rounds.length) {
        setHighlight(null);
        onDone();
        return;
    }
    const round = rounds[roundIndex]!;
    const isLastRound = roundIndex === rounds.length - 1;
    driveRoundWithRaf({
        round,
        config,
        dwellMode: isLastRound ? 'gen' : 'attendOnly',
        kvEstablishedQueryIds: kvEstablished.length > 0 ? kvEstablished : undefined,
        setHighlight,
        onGenAppear: isLastRound ? onGenAppear : undefined,
        onComplete: () => {
            if (isCancelled?.()) return;
            const nextKv = isLastRound
                ? kvEstablished
                : [...kvEstablished, round.queryTokenId];
            runPrefillRounds(
                rounds,
                config,
                setHighlight,
                roundIndex + 1,
                onGenAppear,
                onDone,
                setCancel,
                isCancelled,
                nextKv,
            );
        },
        setCancel,
        isCancelled,
    });
}

export function runAttentionPlayback(opts: RunAttentionPlaybackOptions): void {
    const { plan, config, setHighlight, onGenAppear, onDone, setCancel, isCancelled, skipLeadDwell0 } =
        opts;
    const beginAfterLeadDwell0 = (begin: () => void): void => {
        if (skipLeadDwell0) {
            begin();
            return;
        }
        runAttendDwell0Then(config, setHighlight, undefined, begin, setCancel, isCancelled);
    };
    if (plan.kind === 'prefill') {
        if (plan.rounds.length === 0) {
            setHighlight(null);
            onDone();
            return;
        }
        if (config.prefillStyle === 'random' && plan.rounds.length > 1) {
            beginAfterLeadDwell0(() =>
                runRandomPrefillThenGen(
                    plan.rounds,
                    config,
                    setHighlight,
                    onGenAppear,
                    onDone,
                    setCancel,
                    isCancelled,
                ),
            );
            return;
        }
        beginAfterLeadDwell0(() =>
            runPrefillRounds(
                plan.rounds,
                config,
                setHighlight,
                0,
                onGenAppear,
                onDone,
                setCancel,
                isCancelled,
            ),
        );
        return;
    }
    beginAfterLeadDwell0(() =>
        driveRoundWithRaf({
            round: plan.round,
            config,
            dwellMode: 'gen',
            setHighlight,
            onGenAppear,
            onComplete: onDone,
            setCancel,
            isCancelled,
        }),
    );
}
