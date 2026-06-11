import {
    postCompletions,
    postCompletionsPrompt,
    postCompletionsPromptIncremental,
    type OpenAICompletionsResponse,
    type PostCompletionsOptions,
} from '../../shared/api/completionsClient';
import type { ChatMessage } from './chatMessages';
import type { ChatDisplaySegment, ChatMultiTurnRun } from './chatSegments';
import { executeMockTool, hasMockTool } from './mockExecutor';
import { parseToolCallFromCompletion } from './toolCallParser';
import { tr } from '../../shared/lang/i18n-lite';
import { assertStreamMatchesFinal } from './completionStreamAssert';
import type { ToolConfig } from './toolConfig';
import {
    runMockToolPendingGap,
    TOOL_CALLING_PENDING_LABEL,
} from './toolCallingPendingUi';

export const MAX_TOOL_ROUNDS = 16;
export { MOCK_TOOL_STEP_DELAY_MS, TOOL_CALLING_PENDING_LABEL } from './toolCallingPendingUi';

export type RunMultiTurnOptions = {
    model: string;
    messages: ChatMessage[];
    toolConfig: ToolConfig;
    enableThinking: boolean;
    maxTokens: number;
    /** 仅追加到首轮 prompt（Teacher forcing） */
    teacherForcing?: string;
    signal?: AbortSignal;
    onSegmentsUpdate?: (segments: ChatDisplaySegment[]) => void;
    onDelta?: (chunk: string, streamEnd: boolean, roundIndex: number) => void;
    /** Stop 中断时回调（segments 为已完成段；inFlightText 为当前轮已流式文本） */
    onPartialAbort?: (state: {
        segments: ChatDisplaySegment[];
        inFlightText: string;
        inFlightPromptUsed: string;
    }) => void;
};

export type AssembleFirstTurnPromptOptions = {
    model: string;
    messages: ChatMessage[];
    toolConfig: ToolConfig;
    enableThinking: boolean;
    teacherForcing?: string;
    signal?: AbortSignal;
};

/** 拼装首轮完整 prompt，供缓存键与多轮首段展示。 */
export async function assembleFirstTurnPrompt(
    opts: AssembleFirstTurnPromptOptions
): Promise<string> {
    const prompt = await assembleFullPrompt(
        opts.model,
        opts.messages,
        opts.toolConfig,
        opts.enableThinking,
        opts.signal
    );
    return opts.teacherForcing ? prompt + opts.teacherForcing : prompt;
}

function isAbortError(err: unknown): boolean {
    return (
        err instanceof DOMException &&
        err.name === 'AbortError'
    );
}

/** 拼装首轮完整 prompt（模式 B：需 messages，返回 prompt_used）。 */
async function assembleFullPrompt(
    model: string,
    messages: ChatMessage[],
    toolConfig: ToolConfig,
    enableThinking: boolean,
    signal?: AbortSignal
): Promise<string> {
    const res = await postCompletionsPrompt(
        {
            model,
            messages,
            tools: toolConfig.tools_schema,
            enable_thinking: enableThinking,
        },
        { signal }
    );
    return res.prompt_used!;
}

/** 请求 tool response 的 incremental_suffix（POST /v1/completions/prompt-incremental）。 */
async function fetchIncrementalSuffix(
    model: string,
    enableThinking: boolean,
    toolName: string,
    toolContent: string,
    signal?: AbortSignal
): Promise<string> {
    const { incremental_suffix } = await postCompletionsPromptIncremental(
        { model, tool_content: toolContent, tool_name: toolName, enable_thinking: enableThinking },
        { signal }
    );
    return incremental_suffix;
}

async function runCompletion(
    model: string,
    promptUsed: string,
    maxTokens: number,
    options: Pick<PostCompletionsOptions, 'signal' | 'onDelta'>
): Promise<OpenAICompletionsResponse> {
    let streamedText = '';
    const { response } = await postCompletions(
        { model, prompt: promptUsed, max_tokens: maxTokens },
        {
            signal: options.signal,
            onDelta: (chunk, streamEnd) => {
                streamedText += chunk;
                options.onDelta?.(chunk, streamEnd);
            },
        }
    );
    const finalText = response.choices?.[0]?.text;
    if (typeof finalText === 'string') {
        assertStreamMatchesFinal(streamedText, finalText);
    }
    return response;
}

/** 前端运行时：多轮 mock tool calling；无 tool call 或未配置 mock 时自然结束。 */
export async function runMultiTurnToolCalling(
    opts: RunMultiTurnOptions
): Promise<ChatMultiTurnRun> {
    const segments: ChatDisplaySegment[] = [];
    let round = 0;
    let currentRoundStreamed = '';
    // wire：本次多轮对话送入模型的完整字节流（单调增长，只追加）
    let wire = '';

    try {
        // 首轮：从 messages 拼装完整 prompt
        const firstPrompt = await assembleFullPrompt(
            opts.model,
            opts.messages,
            opts.toolConfig,
            opts.enableThinking,
            opts.signal
        );
        wire = opts.teacherForcing ? firstPrompt + opts.teacherForcing : firstPrompt;

        // 首轮 input segment = 完整 wire（首次）
        segments.push({ kind: 'input', text: wire });
        opts.onSegmentsUpdate?.(segments);

        while (round < MAX_TOOL_ROUNDS) {
            currentRoundStreamed = '';
            const promptForRound = wire;

            const res = await runCompletion(
                opts.model,
                wire,
                opts.maxTokens,
                {
                    signal: opts.signal,
                    onDelta: (chunk, streamEnd) => {
                        currentRoundStreamed += chunk;
                        opts.onDelta?.(chunk, streamEnd, round);
                    },
                }
            );
            const text = res.choices?.[0]?.text;
            if (typeof text !== 'string') {
                throw new Error(`Round ${round + 1} completion missing choices[0].text`);
            }

            // 模型输出（含 <|im_end|>）原样追加到 wire
            wire += text;

            segments.push({
                kind: 'output',
                text,
                promptUsed: promptForRound,
                response: res,
                modelName: res.model ?? opts.model,
            });
            opts.onSegmentsUpdate?.(segments);

            const parsed = parseToolCallFromCompletion(text);
            if (parsed.status === 'malformed') {
                throw new Error(tr('Invalid tool_call JSON in model output'));
            }
            if (parsed.status === 'absent' || !hasMockTool(opts.toolConfig, parsed.call.name)) {
                return { segments };
            }

            segments.push({ kind: 'input', text: TOOL_CALLING_PENDING_LABEL, pending: true });
            opts.onSegmentsUpdate?.(segments);

            await runMockToolPendingGap(opts.signal);

            const mockContent = executeMockTool(opts.toolConfig, parsed.call.name);

            // 向后端请求本条 tool response 的 incremental_suffix
            const incremental_suffix = await fetchIncrementalSuffix(
                opts.model,
                opts.enableThinking,
                parsed.call.name,
                mockContent,
                opts.signal
            );

            wire += incremental_suffix;
            segments[segments.length - 1] = { kind: 'input', text: incremental_suffix };
            opts.onSegmentsUpdate?.(segments);

            round += 1;
        }

        return { segments, truncatedAtMaxRounds: true };
    } catch (err: unknown) {
        if (isAbortError(err)) {
            const last = segments[segments.length - 1];
            if (last?.kind === 'input' && last.pending) {
                segments.pop();
            }
            opts.onPartialAbort?.({
                segments: [...segments],
                inFlightText: currentRoundStreamed,
                inFlightPromptUsed: wire,
            });
        }
        throw err;
    }
}
