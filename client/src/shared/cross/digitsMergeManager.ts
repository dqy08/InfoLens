/** 数字段合并（digit merge）开关，与 BPE overlap 合并独立；默认开启以保持既有行为 */
import { lsGet, lsWriteBool } from '../storage/localStorageHelpers';

export const DIGITS_MERGE_STORAGE_KEY = 'info_radar_digits_merge_enabled';

const renderListeners = new Set<() => void>();

function invokeRenderListener(cb: () => void): void {
    try {
        cb();
    } catch (e) {
        console.error('[digitsMerge] render listener failed', e);
    }
}

function notifyDigitsMergeRenderListeners(): void {
    for (const cb of Array.from(renderListeners)) {
        invokeRenderListener(cb);
    }
}

let storageListenerAttached = false;

function ensureStorageListener(): void {
    if (storageListenerAttached) return;
    storageListenerAttached = true;
    window.addEventListener('storage', (e: StorageEvent) => {
        if (e.key !== DIGITS_MERGE_STORAGE_KEY) return;
        notifyDigitsMergeRenderListeners();
    });
}

/**
 * 注册 digit merge 变更后的重绘：
 * - **其它标签页**改 `localStorage` 时走 `storage`（同页 `setItem` 不会触发 `storage`，见 HTML 规范）；
 * - **同页**改开关须走 {@link setDigitsMergeEnabled}，写入后会调用此处注册的回调。
 */
export function addDigitsMergeRenderListener(callback: () => void): void {
    renderListeners.add(callback);
    ensureStorageListener();
}

export function getDigitsMergeEnabled(): boolean {
    const v = lsGet(DIGITS_MERGE_STORAGE_KEY);
    if (v === null) return true;
    return v === 'true';
}

export function setDigitsMergeEnabled(enabled: boolean): void {
    lsWriteBool(DIGITS_MERGE_STORAGE_KEY, enabled);
    notifyDigitsMergeRenderListeners();
}
