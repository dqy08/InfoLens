import { lsReadBool, lsWriteBool } from '../../shared/storage/localStorageHelpers';
import { SURPRISAL_MAX_ALPHA } from '../../shared/cross/SurprisalColorConfig';

/** 勾选弱化时文本 surprisal 底色的终点 alpha（默认 {@link SURPRISAL_MAX_ALPHA} 为 0.7） */
const WEAKENED_SURPRISAL_MAX_ALPHA = 0.5;

/** 为 true 时文本 surprisal 底色映射的终点 alpha 降为 {@link WEAKENED_SURPRISAL_MAX_ALPHA} */
export const SURPRISAL_COLOR_WEAKEN_KEY = 'info_radar_weaken_surprisal_color';

export function getSurprisalColorWeakened(): boolean {
    return lsReadBool(SURPRISAL_COLOR_WEAKEN_KEY, false);
}

export function setSurprisalColorWeakened(weakened: boolean): void {
    lsWriteBool(SURPRISAL_COLOR_WEAKEN_KEY, weakened);
}

export function getSurprisalRenderMaxAlpha(): number {
    return getSurprisalColorWeakened() ? WEAKENED_SURPRISAL_MAX_ALPHA : SURPRISAL_MAX_ALPHA;
}
