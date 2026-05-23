import type { CachedHistoryListRow } from '../../shared/storage/cachedHistoryStore';
import { initQueryHistoryDropdown } from './queryHistory';

/** IndexedDB MRU 列表在内存中的镜像，供 {@link initQueryHistoryDropdown} 的同步 `getHistoryEntries` 使用 */
export function createMruListMirror(loadList: () => Promise<CachedHistoryListRow[]>): {
    getEntries: () => CachedHistoryListRow[];
    refresh: () => Promise<void>;
} {
    let rows: CachedHistoryListRow[] = [];
    return {
        getEntries: () => rows,
        refresh: async () => {
            rows = await loadList();
        },
    };
}

export type CachedHistorySelectContext = {
    /** 刷新内存中的 MRU 列表镜像（与打开下拉时一致） */
    refreshList: () => Promise<void>;
};

export type InitCachedHistoryQueryDropdownOptions = {
    dropdownId: string;
    historyButton: HTMLElement | null;
    clickOutsideRoot: HTMLElement | null;
    listMru: () => Promise<CachedHistoryListRow[]>;
    /**
     * 第一参为 {@link CachedHistoryListRow.contentKey}（与 `?content=` 一致）。
     * 第二参恒为 false：列表点击或悬停预览均不 bump MRU，仅 {@link onPromote}（↑）会 touch。
     */
    onSelectEntry: (
        contentKey: string,
        shouldTouch: boolean | undefined,
        ctx: CachedHistorySelectContext
    ) => void | Promise<void>;
    onRemove: (contentKey: string) => void | Promise<void>;
    onPromote: (contentKey: string) => void | Promise<void>;
};

/**
 * 三页 Cached history 共用的「无 input + MRU 异步刷新 + 悬停预览」接线；选中条目不写 MRU。
 * 返回 `refreshList` 供 URL hydrate 等与下拉无关的路径刷新内存列表。
 */
export function initCachedHistoryQueryDropdown(
    options: InitCachedHistoryQueryDropdownOptions
): { refreshList: () => Promise<void> } {
    const mirror = createMruListMirror(options.listMru);
    const ctx: CachedHistorySelectContext = {
        refreshList: () => mirror.refresh(),
    };
    initQueryHistoryDropdown({
        input: null,
        dropdownId: options.dropdownId,
        getHistoryEntries: () =>
            mirror.getEntries().map((r) => ({ id: r.contentKey, label: r.listLabel })),
        refreshHistoryItems: () => mirror.refresh(),
        openDropdownOnFocusInput: false,
        filterHistoryByInput: false,
        onSelect: () => {},
        fillInputOnSelect: false,
        onHistorySelect: (contentKey) => {
            void Promise.resolve(options.onSelectEntry(contentKey, false, ctx));
        },
        onRemove: options.onRemove,
        onPromote: options.onPromote,
        historyButton: options.historyButton,
        clickOutsideRoot: options.clickOutsideRoot,
        applyHistoryOnHover: true,
    });
    void mirror.refresh();
    return { refreshList: ctx.refreshList };
}
