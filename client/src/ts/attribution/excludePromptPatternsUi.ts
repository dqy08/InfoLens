import {
    DEFAULT_EXCLUDE_GENERATED_PATTERNS_TEXT,
    DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT,
    EXCLUDE_GENERATED_PATTERNS_ENABLED_STORAGE_KEY,
    EXCLUDE_GENERATED_PATTERNS_STORAGE_KEY,
    EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY,
    EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY,
} from './attributionExcludePromptPatternsStorage';

type BindExcludePatternsUiStorageKeys = {
    textKey: string;
    enabledKey: string;
};

type BindExcludePatternsUiOptions = {
    storageKeys: BindExcludePatternsUiStorageKeys;
    textInput: HTMLInputElement | HTMLTextAreaElement | null;
    enableCheckbox: HTMLInputElement | null;
    /** 列表在失焦提交后、或使能变化后触发（如 inspector.reapply） */
    onEffectiveChange: () => void;
    /** 键从未写入（`null`）时填充，与持久化 `''`（用户清空）区分 */
    defaultTextWhenKeyAbsent?: string;
};

export type BindExcludePromptPatternsUiOptions = Omit<BindExcludePatternsUiOptions, 'storageKeys' | 'defaultTextWhenKeyAbsent'>;

/**
 * 从 localStorage 回填、同步文本框禁用态、绑定持久化与回调（多组 key 共用实现）。
 */
function bindExcludePatternsUi(options: BindExcludePatternsUiOptions): void {
    const { storageKeys, textInput, enableCheckbox, onEffectiveChange, defaultTextWhenKeyAbsent } = options;
    const { textKey, enabledKey } = storageKeys;

    try {
        const savedExclude = localStorage.getItem(textKey);
        if (textInput) {
            if (savedExclude !== null) {
                textInput.value = savedExclude;
            } else if (defaultTextWhenKeyAbsent !== undefined) {
                textInput.value = defaultTextWhenKeyAbsent;
            }
        }
        const savedEnabled = localStorage.getItem(enabledKey);
        if (enableCheckbox) {
            enableCheckbox.checked = savedEnabled === null ? true : savedEnabled === '1';
        }
    } catch {
        // 读取失败则保持 HTML 默认
    }

    function syncTextInputDisabled(): void {
        if (!textInput) return;
        textInput.disabled = !enableCheckbox?.checked;
    }
    syncTextInputDisabled();

    enableCheckbox?.addEventListener('change', () => {
        try {
            if (textInput) {
                localStorage.setItem(textKey, textInput.value);
            }
            localStorage.setItem(enabledKey, enableCheckbox.checked ? '1' : '0');
        } catch {
            /* ignore */
        }
        syncTextInputDisabled();
        onEffectiveChange();
    });

    textInput?.addEventListener('blur', () => {
        try {
            localStorage.setItem(textKey, textInput.value);
        } catch {
            /* ignore */
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
            enableCheckbox.checked = event.newValue === null ? true : event.newValue === '1';
        }
        syncTextInputDisabled();
        onEffectiveChange();
    });
}

/**
 * Exclude prompt patterns：Attribution 与 Generate & Attribute 页共用，storage 见 {@link attributionExcludePromptPatternsStorage}。
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

/** Exclude generated patterns：仅 Generate & Attribute 页绑定；storage 键见 {@link attributionExcludePromptPatternsStorage}。 */
export function bindExcludeGeneratedPatternsUi(options: BindExcludePromptPatternsUiOptions): void {
    bindExcludePatternsUi({
        storageKeys: {
            textKey: EXCLUDE_GENERATED_PATTERNS_STORAGE_KEY,
            enabledKey: EXCLUDE_GENERATED_PATTERNS_ENABLED_STORAGE_KEY,
        },
        ...options,
        defaultTextWhenKeyAbsent: DEFAULT_EXCLUDE_GENERATED_PATTERNS_TEXT,
    });
}
