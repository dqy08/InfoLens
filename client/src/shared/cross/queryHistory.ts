/**
 * 查询输入框历史（仅保存字符串）；不同入口通过 storageKey 分库存储。
 */

import { tr } from '../../shared/lang/i18n-lite';
import { lsGet, lsSet } from '../storage/localStorageHelpers';

/** 首页语义搜索等默认使用 */
export const SEMANTIC_QUERY_HISTORY_KEY = 'info_radar_query_search_history';
/** Raw 输入框 input history（仅填充，不与续写缓存联动） */
export const CHAT_RAW_INPUT_HISTORY_KEY = 'info_radar_chat_raw_input_history';
/** Chat 模板模式下「User」输入框 input history（仅填充，不与 completion 缓存联动） */
export const CHAT_USER_INPUT_HISTORY_KEY = 'info_radar_chat_user_input_history';
/** Chat 模板模式下「System」输入框 input history */
export const CHAT_SYSTEM_INPUT_HISTORY_KEY = 'info_radar_chat_system_input_history';
/** Chat 页 Teacher forcing 续写框（拼接到 prompt 后） */
export const CHAT_TEACHER_FORCING_INPUT_HISTORY_KEY = 'info_radar_chat_teacher_forcing_input_history';
/** Generate & Attribute 页 Raw 输入框（与 Chat 分库） */
export const GEN_ATTR_RAW_INPUT_HISTORY_KEY = 'info_radar_gen_attr_raw_input_history';
/** Generate & Attribute 页 User 输入框 */
export const GEN_ATTR_USER_INPUT_HISTORY_KEY = 'info_radar_gen_attr_user_input_history';
/** Generate & Attribute 页 System 输入框 */
export const GEN_ATTR_SYSTEM_INPUT_HISTORY_KEY = 'info_radar_gen_attr_system_input_history';
/** Generate & Attribute 页 Teacher forcing 续写框 */
export const GEN_ATTR_TEACHER_FORCING_INPUT_HISTORY_KEY = 'info_radar_gen_attr_teacher_forcing_input_history';

const MAX = 100;

/**
 * 选中某条历史后是否收起下拉。
 * - `applyHistoryOnHover`：仅「点击」收起，「悬停」不收起（不读 `closeOnSelect`）。
 * - 否则：由 `closeOnSelect` 决定（仅点击路径会触发）。
 */
function shouldHideDropdownAfterSelect(
    closeOnSelect: boolean,
    applyHistoryOnHover: boolean,
    fromHover: boolean
): boolean {
    if (applyHistoryOnHover) {
        return !fromHover;
    }
    return closeOnSelect;
}

/**
 * 是否应对「与历史项关联的缓存」执行 MRU touch（仅 MRU 顺序；表意为「应不应 touch」，不是「是否点击」）。
 * 悬停预览：false；点击主文本：true；未开启悬停应用：恒 true。
 */
function shouldTouchLinkedMru(applyHistoryOnHover: boolean, fromHover: boolean): boolean {
    return applyHistoryOnHover ? !fromHover : true;
}

function load(storageKey: string): string[] {
    try {
        const raw = lsGet(storageKey);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed
            .map((e: unknown) => {
                if (typeof e === 'string') return e;
                if (e && typeof (e as { query?: string }).query === 'string') return (e as { query: string }).query;
                return null;
            })
            .filter((s): s is string => typeof s === 'string')
            .slice(0, MAX);
    } catch {
        return [];
    }
}

function remove(storageKey: string, query: string): void {
    const list = load(storageKey).filter((s) => s !== query);
    lsSet(storageKey, JSON.stringify(list));
}

export function saveHistory(query: string, storageKey: string = SEMANTIC_QUERY_HISTORY_KEY): void {
    const list = [query, ...load(storageKey).filter((s) => s !== query)].slice(0, MAX);
    lsSet(storageKey, JSON.stringify(list));
}

export interface InitQueryHistoryDropdownOptions {
    /**
     * 可为空：仅「历史按钮 + 下拉」、不绑定任何输入框时（如 Cached history）传 null，
     * 此时须提供 {@link historyButton}，且 {@link openDropdownOnFocusInput} 应为 false。
     */
    input: HTMLInputElement | HTMLTextAreaElement | null;
    dropdownId: string;
    /** 无 input 时不会调用（仅绑定在 input 的 input 事件上） */
    onSelect: () => void;
    /**
     * 选中某条历史时回调；第二项 `shouldTouch` 表示**是否应对关联 MRU 执行 touch**（由本组件按悬停/点击推导），
     * 非「事件是否来自点击」的原始标记。
     */
    onHistorySelect?: (query: string, shouldTouch?: boolean) => void;
    /** 删除某条历史时回调，用于同步清理相关缓存（可返回 Promise） */
    onRemove?: (query: string) => void | Promise<void>;
    /** 若提供则在叉号左侧显示 ↑，点击后调用（如 completion 缓存 touch 置顶；可返回 Promise） */
    onPromote?: (query: string) => void | Promise<void>;
    /** 输入框外的按钮：点击后弹出历史下拉（与语义搜索 History 入口一致） */
    historyButton?: HTMLElement | null;
    /**
     * localStorage 键，默认与首页语义搜索共用 {@link SEMANTIC_QUERY_HISTORY_KEY}。
     * 若提供 {@link getHistoryItems} 或 {@link getHistoryEntries}，则不再从 localStorage 读列表（如续写缓存由 IndexedDB MRU 提供）。
     */
    storageKey?: string;
    /** 自定义列表数据源；提供时优先于 {@link storageKey} */
    getHistoryItems?: () => string[];
    /**
     * 与 {@link getHistoryItems} 二选一：每项含稳定 id（如续写缓存的 contentKey）与展示 label。
     * 选中/删除/置顶回调均传递 id。
     */
    getHistoryEntries?: () => Array<{ id: string; label: string; featuredStyle?: string }>;
    /**
     * 每次渲染列表前调用（如打开下拉时从 IndexedDB 刷新内存镜像）。
     * 失败时仍会继续渲染，避免下拉空白。
     */
    refreshHistoryItems?: () => void | Promise<void>;
    /**
     * 为 true（默认）时，聚焦/输入会弹出并过滤历史。
     * 为 false 时仅通过 historyButton 打开；若下拉已打开且 {@link filterHistoryByInput} 为 true，输入仍会刷新过滤。
     */
    openDropdownOnFocusInput?: boolean;
    /** 为 true（默认）时按当前输入过滤列表；为 false 时始终展示全部历史（如 Chat） */
    filterHistoryByInput?: boolean;
    /**
     * 点击外部关闭下拉时使用的根节点；不传则用 input 所在 `.semantic-search-input-wrapper`。
     * 当下拉与 input 不在同一 wrapper 内时（如左下角独立「Cached history」入口）必须传入，以包含下拉与按钮。
     */
    clickOutsideRoot?: HTMLElement | null;
    /**
     * 为 false 时点击列表仅触发 {@link onHistorySelect}，不写入 input（如 Cached history 只刷新右侧）。
     * 默认 true。
     */
    fillInputOnSelect?: boolean;
    /**
     * 为 false 时选中条目后不关闭下拉。
     * 当 {@link applyHistoryOnHover} 为 true 时**忽略本项**，收起规则由悬停/点击在内部处理（悬停不关、点击关）。默认 true。
     */
    closeOnSelect?: boolean;
    /**
     * 为 true 时，在 `(hover: hover) and (pointer: fine)` 环境下指针进入主文本区域即触发与点击相同的选中逻辑（{@link onHistorySelect}、回填 input 等），
     * 但第二参 `shouldTouch` 为 false（不应 bump MRU）；触控等不满足该 media 时仅点击触发。
     * 此模式下不再读取 {@link closeOnSelect}：悬停选中不收起下拉，点击主文本收起。
     * 仅应在 Chat / Attribution 等入口显式开启；首页语义搜索等保持默认 false。
     */
    applyHistoryOnHover?: boolean;
}

export function initQueryHistoryDropdown(options: InitQueryHistoryDropdownOptions): void {
    const {
        input,
        dropdownId,
        onSelect,
        onHistorySelect,
        onRemove,
        onPromote,
        historyButton,
        storageKey = SEMANTIC_QUERY_HISTORY_KEY,
        openDropdownOnFocusInput = true,
        filterHistoryByInput = true,
        clickOutsideRoot = null,
        fillInputOnSelect = true,
        closeOnSelect = true,
        getHistoryItems,
        getHistoryEntries,
        refreshHistoryItems,
        applyHistoryOnHover = false
    } = options;
    const dropdown = document.getElementById(dropdownId);
    if (!dropdown) return;
    if (!input && !historyButton) return;
    if (!input && openDropdownOnFocusInput) return;

    const wrapper =
        input?.closest('.semantic-search-input-wrapper') ??
        historyButton?.closest('.semantic-search-input-wrapper') ??
        null;
    const outsideRoot = clickOutsideRoot ?? wrapper;

    const hideDropdown = () => dropdown.classList.remove('is-visible');

    const buildDropdown = () => {
        /** 仅精细指针且具备真实 hover 的环境挂 pointerenter 预览；触控避免假悬停与双击路径 */
        const pointerFineHover =
            applyHistoryOnHover &&
            typeof window !== 'undefined' &&
            window.matchMedia('(hover: hover) and (pointer: fine)').matches;

        // 列表过滤：与输入框一致不 trim；存盘与选中回填均为完整字符串
        const filter =
            filterHistoryByInput && input ? (input.value ?? '').toLowerCase() : '';
        const useEntries = getHistoryEntries != null;
        const entryRows = useEntries ? getHistoryEntries!() : null;
        const list = !useEntries ? (getHistoryItems ? getHistoryItems() : load(storageKey)) : null;
        const filteredEntries = entryRows
            ? entryRows.filter((e) => !filter || e.label.toLowerCase().includes(filter))
            : null;
        const filteredStrings = list
            ? list.filter((s) => !filter || s.toLowerCase().includes(filter))
            : null;
        dropdown.innerHTML = '';
        const filtered = filteredEntries ?? filteredStrings ?? [];
        if (filtered.length === 0) {
            hideDropdown();
            return;
        }
        dropdown.classList.add('is-visible');
        if (filteredEntries) {
            for (const row of filteredEntries) {
                const q = row.id;
                const display = row.label;
                const li = document.createElement('li');
                const span = document.createElement('span');
                span.className =
                    row.featuredStyle === 'bold'
                        ? 'history-text history-text--bold'
                        : 'history-text';
                span.textContent = display;
                if (!pointerFineHover) span.title = display;
                let promoteBtn: HTMLButtonElement | null = null;
                if (onPromote) {
                    promoteBtn = document.createElement('button');
                    promoteBtn.className = 'demo-history-promote-btn';
                    promoteBtn.type = 'button';
                    promoteBtn.textContent = '↑';
                    promoteBtn.title = tr('Move to top');
                    promoteBtn.onclick = (e) => {
                        e.stopPropagation();
                        void Promise.resolve(onPromote?.(q)).then(() => render());
                    };
                }
                const selectItem = (fromHover: boolean) => {
                    if (shouldHideDropdownAfterSelect(closeOnSelect, applyHistoryOnHover, fromHover)) {
                        hideDropdown();
                    }
                    if (fillInputOnSelect && input) {
                        input.value = display;
                        input.dispatchEvent(new Event('input', { bubbles: true }));
                    }
                    onHistorySelect?.(q, shouldTouchLinkedMru(applyHistoryOnHover, fromHover));
                };
                span.onclick = () => selectItem(false);
                if (pointerFineHover) {
                    span.addEventListener('pointerenter', () => selectItem(true));
                }
                li.appendChild(span);
                if (promoteBtn) li.appendChild(promoteBtn);
                if (onRemove) {
                    const btn = document.createElement('button');
                    btn.className = 'demo-delete-btn';
                    btn.type = 'button';
                    btn.textContent = '×';
                    btn.title = tr('Remove');
                    btn.onclick = (e) => {
                        e.stopPropagation();
                        void Promise.resolve(onRemove(q)).then(() => render());
                    };
                    li.appendChild(btn);
                }
                dropdown.appendChild(li);
            }
            return;
        }
        for (const q of filteredStrings!) {
            const li = document.createElement('li');
            const span = document.createElement('span');
            span.className = 'history-text';
            span.textContent = q;
            if (!pointerFineHover) span.title = q;
            let promoteBtn: HTMLButtonElement | null = null;
            if (onPromote) {
                promoteBtn = document.createElement('button');
                promoteBtn.className = 'demo-history-promote-btn';
                promoteBtn.type = 'button';
                promoteBtn.textContent = '↑';
                promoteBtn.title = tr('Move to top');
                promoteBtn.onclick = (e) => {
                    e.stopPropagation();
                    void Promise.resolve(onPromote?.(q)).then(() => render());
                };
            }
            const btn = document.createElement('button');
            btn.className = 'demo-delete-btn';
            btn.type = 'button';
            btn.textContent = '×';
            btn.title = tr('Remove');
            const selectItem = (fromHover: boolean) => {
                if (shouldHideDropdownAfterSelect(closeOnSelect, applyHistoryOnHover, fromHover)) {
                    hideDropdown();
                }
                if (fillInputOnSelect && input) {
                    input.value = q;
                    // 触发 input，使依赖 input 的统计（如 TextInputController 字数）与 input 监听器中的 onSelect/syncClear 一并更新
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                }
                onHistorySelect?.(q, shouldTouchLinkedMru(applyHistoryOnHover, fromHover));
            };
            span.onclick = () => selectItem(false);
            if (pointerFineHover) {
                span.addEventListener('pointerenter', () => selectItem(true));
            }
            btn.onclick = (e) => {
                e.stopPropagation();
                if (!getHistoryItems && !getHistoryEntries) {
                    remove(storageKey, q);
                }
                void Promise.resolve(onRemove?.(q)).then(() => render());
            };
            li.appendChild(span);
            if (promoteBtn) li.appendChild(promoteBtn);
            li.appendChild(btn);
            dropdown.appendChild(li);
        }
    };

    const render = () => {
        if (refreshHistoryItems) {
            void Promise.resolve(refreshHistoryItems())
                .then(buildDropdown)
                .catch(() => buildDropdown());
        } else {
            buildDropdown();
        }
    };

    const clearBtn = input ? wrapper?.querySelector('.semantic-search-clear') : null;
    const syncClear = () =>
        clearBtn?.classList.toggle('is-visible', (input?.value ?? '').length > 0);

    if (input) {
        if (openDropdownOnFocusInput) {
            input.addEventListener('focus', render);
        }
        input.addEventListener('input', () => {
            onSelect();
            if (openDropdownOnFocusInput) {
                if (input === document.activeElement) render();
            } else if (filterHistoryByInput && dropdown.classList.contains('is-visible')) {
                render();
            }
            syncClear();
        });
    }

    historyButton?.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        input?.focus();
        render();
    });
    document.addEventListener('click', (e) => {
        const t = e.target as Node;
        if (historyButton?.contains(t)) return;
        if (outsideRoot && !outsideRoot.contains(t)) hideDropdown();
    });

    if (clearBtn && input) {
        syncClear();
        clearBtn.addEventListener('click', () => {
            input.value = '';
            input.focus();
            input.dispatchEvent(new Event('input', { bubbles: true }));
        });
    }
}
