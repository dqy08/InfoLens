/**
 * 播放步进间隔（ms）：信息密度扫描与 CosFlow DAG 步进共用读本地存储；clamp 范围各自独立。
 */

import { lsReadNumber } from './localStorageHelpers';

export const PLAYBACK_STEP_MS_DEFAULT = 200;
export const PLAYBACK_STEP_MS_MIN = 0;
export const PLAYBACK_STEP_MS_MAX = 10000;

/** 信息密度逐词舞台：最大 surprisal 对应的停留 ms */
export const INFO_DENSITY_PLAYBACK_STEP_MS_DEFAULT = 1000;
export const INFO_DENSITY_PLAYBACK_STEP_MS_MIN = 200;
export const INFO_DENSITY_PLAYBACK_STEP_MS_MAX = 5000;

export function clampPlaybackStepMs(n: number): number {
    return Math.max(
        PLAYBACK_STEP_MS_MIN,
        Math.min(PLAYBACK_STEP_MS_MAX, Math.round(n))
    );
}

export function clampInfoDensityPlaybackStepMs(n: number): number {
    return Math.max(
        INFO_DENSITY_PLAYBACK_STEP_MS_MIN,
        Math.min(INFO_DENSITY_PLAYBACK_STEP_MS_MAX, Math.round(n))
    );
}

export function readStoredPlaybackStepMs(
    storageKey: string,
    defaultMs: number = PLAYBACK_STEP_MS_DEFAULT,
    clamp: (n: number) => number = clampPlaybackStepMs
): number {
    return lsReadNumber(storageKey, defaultMs, { clamp });
}
