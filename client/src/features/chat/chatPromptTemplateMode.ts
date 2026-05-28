/** Chat / Generate & Attribute 共用的「Raw prompt mode」开关 storage key */
export const LS_SKIP_CHAT_TEMPLATE = 'chat_skip_chat_template';

/** Chat 页 Max new tokens（与 Causal Flow 的 gen_attr 键独立，不共享） */
export const CHAT_MAX_NEW_TOKENS_STORAGE_KEY = 'info_radar_chat_max_new_tokens';

/** Enable thinking 开关（Chat / Causal Flow 各页独立 key，仅在 Chat template 模式下生效） */
export const CHAT_ENABLE_THINKING_STORAGE_KEY = 'info_radar_chat_enable_thinking';
export const GEN_ATTR_ENABLE_THINKING_STORAGE_KEY = 'info_radar_gen_attr_enable_thinking';
