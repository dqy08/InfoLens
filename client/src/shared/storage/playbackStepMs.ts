/**
 * 播放步进间隔（ms）：信息密度扫描与 CosFlow DAG 步进共用 clamp / 读本地存储。
 */

import { lsReadNumber } from './localStorageHelpers';

export const PLAYBACK_STEP_MS_DEFAULT = 200;
export const PLAYBACK_STEP_MS_MIN = 0;
export const PLAYBACK_STEP_MS_MAX = 10000;

export function clampPlaybackStepMs(n: number): number {
    return Math.max(
        PLAYBACK_STEP_MS_MIN,
        Math.min(PLAYBACK_STEP_MS_MAX, Math.round(n))
    );
}

export function readStoredPlaybackStepMs(storageKey: string): number {
    return lsReadNumber(storageKey, PLAYBACK_STEP_MS_DEFAULT, {
        clamp: clampPlaybackStepMs,
    });
}
