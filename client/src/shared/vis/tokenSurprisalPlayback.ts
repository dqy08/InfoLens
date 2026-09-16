/**
 * 信息密度 token 扫描播放：停留 = surprisal(bits) × 单步 ms（与 CosFlow 传播链 step 节奏同构）。
 */

import type { FrontendToken } from '../api/GLTR_API';
import { calculateSurprisal } from '../core/Util';

export type TokenSurprisalPlaybackPhase = 'idle' | 'playing' | 'paused';

/** 与 tooltipPredictionsFromToken.getFrontendTokenTopkState 的 hasRealTopk 同一规则，避免拉进 i18n。 */
function tokenHasRealSurprisal(token: FrontendToken): boolean {
    const real = token.real_topk;
    if (real == null || !Array.isArray(real)) return false;
    const pred = token.pred_topk ?? [];
    if (real[1] === 1 && pred.length === 0) return false;
    return true;
}

export function tokenSurprisalBits(token: FrontendToken): number {
    if (!tokenHasRealSurprisal(token) || token.real_topk == null) return 0;
    const p = token.real_topk[1];
    if (typeof p !== 'number' || !Number.isFinite(p) || p <= 0) return 0;
    return calculateSurprisal(p);
}

/**
 * 各 token 停留 ms：`round(surprisal × stepMs)`。全为 0 时每步 `stepMs`。
 */
export function surprisalPlaybackDwellsMs(surprisals: readonly number[], stepMs: number): number[] {
    const n = surprisals.length;
    if (n === 0) return [];
    const step = Math.max(0, Math.round(stepMs));
    const weights = surprisals.map((s) => (Number.isFinite(s) && s > 0 ? s : 0));
    if (!weights.some((w) => w > 0)) return weights.map(() => step);
    return weights.map((w) => Math.round(w * step));
}

export type TokenSurprisalPlaybackController = {
    getPhase: () => TokenSurprisalPlaybackPhase;
    getIndex: () => number;
    start: (dwellsMs: readonly number[]) => void;
    /** 回到开头并停留，不自动往下播。 */
    resetPaused: (dwellsMs: readonly number[]) => void;
    pause: () => void;
    resume: () => void;
    stop: () => void;
    toggle: (dwellsMs: readonly number[]) => void;
};

export function createTokenSurprisalPlaybackController(options: {
    onShowToken: (index: number) => void;
    onClear: () => void;
    onPhaseChange: (phase: TokenSurprisalPlaybackPhase) => void;
}): TokenSurprisalPlaybackController {
    let phase: TokenSurprisalPlaybackPhase = 'idle';
    let index = 0;
    let dwells: number[] = [];
    let timer: ReturnType<typeof setTimeout> | null = null;
    let version = 0;

    const setPhase = (next: TokenSurprisalPlaybackPhase): void => {
        if (phase === next) return;
        phase = next;
        options.onPhaseChange(phase);
    };

    const clearTimer = (): void => {
        if (timer === null) return;
        clearTimeout(timer);
        timer = null;
    };

    const nextPlayable = (from: number): number => {
        let i = from;
        while (i < dwells.length && (dwells[i] ?? 0) <= 0) i++;
        return i;
    };

    const stop = (): void => {
        version++;
        clearTimer();
        index = 0;
        dwells = [];
        options.onClear();
        setPhase('idle');
    };

    const scheduleFromCurrent = (captured: number): void => {
        if (version !== captured || phase !== 'playing') return;
        const i = nextPlayable(index);
        if (i >= dwells.length) {
            stop();
            return;
        }
        index = i;
        options.onShowToken(index);
        const dwell = dwells[index] ?? 0;
        timer = setTimeout(() => {
            if (version !== captured) return;
            index = nextPlayable(index + 1);
            scheduleFromCurrent(captured);
        }, dwell);
    };

    const loadDwells = (dwellsMs: readonly number[]): boolean => {
        version++;
        clearTimer();
        dwells = Array.from(dwellsMs);
        index = 0;
        if (dwells.length === 0) {
            options.onClear();
            setPhase('idle');
            return false;
        }
        return true;
    };

    const start = (dwellsMs: readonly number[]): void => {
        if (!loadDwells(dwellsMs)) return;
        setPhase('playing');
        scheduleFromCurrent(version);
    };

    const resetPaused = (dwellsMs: readonly number[]): void => {
        if (!loadDwells(dwellsMs)) return;
        options.onShowToken(0);
        setPhase('paused');
    };

    const pause = (): void => {
        if (phase !== 'playing') return;
        version++;
        clearTimer();
        setPhase('paused');
    };

    const resume = (): void => {
        if (phase !== 'paused') return;
        if (dwells.length === 0) {
            stop();
            return;
        }
        setPhase('playing');
        scheduleFromCurrent(version);
    };

    const toggle = (dwellsMs: readonly number[]): void => {
        if (phase === 'playing') {
            pause();
            return;
        }
        if (phase === 'paused') {
            resume();
            return;
        }
        start(dwellsMs);
    };

    return {
        getPhase: () => phase,
        getIndex: () => index,
        start,
        resetPaused,
        pause,
        resume,
        stop,
        toggle,
    };
}
