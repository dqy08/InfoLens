/** 左栏宽度占「主区宽度 − resizer(8px)」的比例，与 LayoutController / chatPanelLayout 内逻辑一致 */

import { lsGet, lsSet } from '../storage/localStorageHelpers';

const DEFAULT_RATIO = 0.5;
const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

export const PANEL_SPLIT_STORAGE_KEY_START = 'info_radar_panel_split_start';
export const PANEL_SPLIT_STORAGE_KEY_CHAT = 'info_radar_panel_split_chat';
export const PANEL_SPLIT_STORAGE_KEY_ATTRIBUTION = 'info_radar_panel_split_attribution';
export const PANEL_SPLIT_STORAGE_KEY_GEN_ATTRIBUTE = 'info_radar_panel_split_gen_attribute';

export function readPanelSplitRatio(storageKey: string): number {
    const raw = lsGet(storageKey);
    if (raw === null) {
        return DEFAULT_RATIO;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
        return DEFAULT_RATIO;
    }
    return Math.max(MIN_RATIO, Math.min(MAX_RATIO, n));
}

export function writePanelSplitRatio(storageKey: string, ratio: number): void {
    const clamped = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
    lsSet(storageKey, String(clamped));
}
