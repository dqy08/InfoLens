import {
    DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT,
    EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY,
    EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY,
} from './attributionExcludePromptPatternsStorage';
import { lsGet, lsReadBool, lsSet, lsWriteBool } from '../../storage/localStorageHelpers';

type BindExcludePatternsUiStorageKeys = {
    textKey: string;
    enabledKey: string;
};

export type BindExcludePatternsUiOptions = {
    storageKeys: BindExcludePatternsUiStorageKeys;
    textInput: HTMLInputElement | HTMLTextAreaElement | null;
    enableCheckbox: HTMLInputElement | null;
    /** 列表在失焦提交后、或使能变化后触发（如 inspector.reapply / DAG 回放） */
    onEffectiveChange: () => void;
    /** 键从未写入（`null`）时填充，与持久化 `''`（用户清空）区分 */
    defaultTextWhenKeyAbsent?: string;
    /** enable 键从未写入时的默认勾选态；缺省 `true`（与 Attribution Exclude 一致） */
    defaultEnabledWhenKeyAbsent?: boolean;
    /** 为 true 时不写 localStorage（由调用方统一 sync，如 Gen Attribute demo UI 面板委托） */
    skipLocalStoragePersist?: boolean;
};

export type BindExcludePromptPatternsUiOptions = Omit<
    BindExcludePatternsUiOptions,
    'storageKeys' | 'defaultTextWhenKeyAbsent' | 'defaultEnabledWhenKeyAbsent'
>;

export function syncEnableGatedTextInputVisibility(
    enableCheckbox: HTMLInputElement | null,
    textInput: HTMLElement | null,
): void {
    if (!textInput) return;
    textInput.hidden = !enableCheckbox?.checked;
}

/**
 * 从 localStorage 回填、同步输入框可见性、绑定持久化与回调（多组 key 共用实现）。
 */
export function bindExcludePatternsUi(options: BindExcludePatternsUiOptions): void {
    const {
        storageKeys,
        textInput,
        enableCheckbox,
        onEffectiveChange,
        defaultTextWhenKeyAbsent,
        defaultEnabledWhenKeyAbsent = true,
        skipLocalStoragePersist = false,
    } = options;
    const { textKey, enabledKey } = storageKeys;

    try {
        const savedExclude = lsGet(textKey);
        if (textInput) {
            if (savedExclude !== null) {
                textInput.value = savedExclude;
            } else if (defaultTextWhenKeyAbsent !== undefined) {
                textInput.value = defaultTextWhenKeyAbsent;
            }
        }
        if (enableCheckbox) {
            enableCheckbox.checked = lsReadBool(enabledKey, defaultEnabledWhenKeyAbsent, {
                encoding: '1',
            });
        }
    } catch {
        // 读取失败则保持 HTML 默认
    }

    syncEnableGatedTextInputVisibility(enableCheckbox, textInput);

    enableCheckbox?.addEventListener('change', () => {
        if (!skipLocalStoragePersist) {
            if (textInput) {
                lsSet(textKey, textInput.value);
            }
            lsWriteBool(enabledKey, enableCheckbox.checked, '1');
        }
        syncEnableGatedTextInputVisibility(enableCheckbox, textInput);
        onEffectiveChange();
    });

    textInput?.addEventListener('blur', () => {
        if (!skipLocalStoragePersist) {
            lsSet(textKey, textInput.value);
        }
        onEffectiveChange();
    });

    window.addEventListener('storage', (event: StorageEvent) => {
        if (event.storageArea !== localStorage) return;
        const k = event.key;
        if (k !== textKey && k !== enabledKey) {
            return;
        }
        if (k === textKey && textInput) textInput.value = event.newValue ?? '';
        if (k === enabledKey && enableCheckbox) {
            enableCheckbox.checked =
                event.newValue === null ? defaultEnabledWhenKeyAbsent : event.newValue === '1';
        }
        syncEnableGatedTextInputVisibility(enableCheckbox, textInput);
        onEffectiveChange();
    });
}

/**
 * Attribution 页 Exclude prompt；键名见 {@link ./attributionExcludePromptPatternsStorage}。
 * Generate & Attribute 三行（Delete / Exclude prompt / Exclude generated）用 {@link bindExcludePatternsUi}。
 */
export function bindExcludePromptPatternsUi(options: BindExcludePromptPatternsUiOptions): void {
    bindExcludePatternsUi({
        storageKeys: {
            textKey: EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY,
            enabledKey: EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY,
        },
        ...options,
        defaultTextWhenKeyAbsent: DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT,
    });
}
