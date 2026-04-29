/** 语义匹配度阈值：低于此值视为不匹配，用于 fill_blank 跳过、chunk 显示、匹配度颜色等 */
// 0.6b下count模式0.9以上才实际匹配；更大模型一般是0或1的匹配度
export const SEMANTIC_MATCH_THRESHOLD = 0.1;

// 每个token占用的字节数（qwen bpe分词平均值）为 4-5
export const BYTE_PER_TOKEN = 4;
// 每个chunk最大token数
export const SEMANTIC_CHUNK_TOKEN = 200;
/** 语义搜索分块模式：每块 UTF-8 字节数上限（仅为估算值） */
export const SEMANTIC_CHUNK_BYTES = SEMANTIC_CHUNK_TOKEN * BYTE_PER_TOKEN;