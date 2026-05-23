/**
 * 归因页 Exclude prompt：`bindExcludePromptPatternsUi` / {@link readStoredEffectiveExcludePromptPatternsText} 共用键名。
 * Prompt 键名保留历史前缀 `exclude_tokens`。Generate & Attribute 页的排除正则使用独立 `info_radar_gen_attr_exclude_*`，与此处解耦。
 */
export const EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY = 'info_radar_attribution_exclude_tokens';
export const EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY = 'info_radar_attribution_exclude_tokens_enabled';

/**
 * 首次使用（`exclude_tokens` 键从未写入）时 UI 与生效逻辑采用的默认行；`''` 表示用户已显式清空，不再使用本默认。
 * 与 {@link readStoredEffectiveExcludePromptPatternsText} 的 `null` / 有值区分一致。
 */
export const DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT = [
    "#comment# use '#comment#' to comment lines; support regex",
    '<\\|im_start\\|>system\\n',
    '<\\|im_start\\|>user\\n',
    '<\\|im_start\\|>assistant\\n',
    '<\\|im_start\\|>assistant\\n\\n',
    '<\\|im_end\\|>\\n',
    '<think>\\n\\n',
    '</think>\\n\\n',
    '<\\|im_start\\|>system\\n[\\s\\S]*?<\\|im_end\\|>#comment# all system prompt',
].join('\n');

/**
 * Generate & Attribute「Exclude generated」占位默认文案；该页的存储键前缀为 `info_radar_gen_attr_exclude_generated_*`。
 */
export const DEFAULT_EXCLUDE_GENERATED_PATTERNS_TEXT = [
    '<think>\\n',
    '</think>\\n\\n',
].join('\n');

/**
 * 与归因页「Exclude prompt patterns」展示逻辑一致：读 localStorage；未持久化使能键时默认开启（与页内 try 块一致）。
 * 未持久化文本键（`null`）时使用 {@link DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT}；已持久化空串表示用户选择排除零条模式。
 */
export function readStoredEffectiveExcludePromptPatternsText(): string {
    try {
        const enabledRaw = localStorage.getItem(EXCLUDE_PROMPT_PATTERNS_ENABLED_STORAGE_KEY);
        const enabled = enabledRaw === null ? true : enabledRaw === '1';
        if (!enabled) return '';
        const raw = localStorage.getItem(EXCLUDE_PROMPT_PATTERNS_STORAGE_KEY);
        if (raw === null) return DEFAULT_EXCLUDE_PROMPT_PATTERNS_TEXT;
        return raw;
    } catch {
        return '';
    }
}
