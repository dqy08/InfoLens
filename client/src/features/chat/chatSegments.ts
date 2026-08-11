import type { OpenAICompletionsResponse } from '../../shared/api/completionsClient';

export type ChatInputSegment = {
    kind: 'input';
    text: string;
    /** mock tool 等待占位，完成后替换为真实 incremental_suffix */
    pending?: boolean;
};

export type ChatOutputSegment = {
    kind: 'output';
    text: string;
    /** 该轮送入续写接口的完整 prompt；旧缓存无此字段时归因回退为拼接前缀 */
    promptUsed?: string;
    response: OpenAICompletionsResponse;
    modelName: string;
    /** 实验旁路：追加在正文后的 API 元数据（usage 等），不参与 GLTR */
    metaJson?: unknown;
};

export type ChatDisplaySegment = ChatInputSegment | ChatOutputSegment;

export type ChatMultiTurnRun = {
    segments: ChatDisplaySegment[];
    /** 达到 MAX_TOOL_ROUNDS 上限而结束 */
    truncatedAtMaxRounds?: boolean;
};
