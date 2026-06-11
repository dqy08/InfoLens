/** Chat / Generate & Attribute 共用的「Raw prompt mode」开关 storage key */
export const LS_SKIP_CHAT_TEMPLATE = 'chat_skip_chat_template';

/** Chat 页 Model / Max new tokens（与 Causal Flow 键独立，不共享） */
export const CHAT_MODEL_VARIANT_STORAGE_KEY = 'info_radar_chat_model_variant';
export const CHAT_MAX_NEW_TOKENS_STORAGE_KEY = 'info_radar_chat_max_new_tokens';

/** Causal Flow 页 Model / Max new tokens */
export const GEN_ATTR_MODEL_VARIANT_STORAGE_KEY = 'info_radar_gen_attr_model_variant';
export const GEN_ATTR_MAX_NEW_TOKENS_STORAGE_KEY = 'info_radar_gen_attr_max_tokens';

/** Enable thinking 开关（Chat / Causal Flow 各页独立 key，仅在 Chat template 模式下生效） */
export const CHAT_ENABLE_THINKING_STORAGE_KEY = 'info_radar_chat_enable_thinking';
export const GEN_ATTR_ENABLE_THINKING_STORAGE_KEY = 'info_radar_gen_attr_enable_thinking';

/** Tool calling 开关（Chat / Causal Flow 各页独立 key，仅在 Chat template 模式下生效） */
export const CHAT_ENABLE_TOOL_CALLING_STORAGE_KEY = 'info_radar_chat_enable_tool_calling';
export const CHAT_MULTI_TURN_MOCK_STORAGE_KEY = 'info_radar_chat_multi_turn_mock';
export const GEN_ATTR_ENABLE_TOOL_CALLING_STORAGE_KEY = 'info_radar_gen_attr_enable_tool_calling';
export const GEN_ATTR_ENABLE_MULTI_TURN_STORAGE_KEY = 'info_radar_gen_attr_enable_multi_turn';
