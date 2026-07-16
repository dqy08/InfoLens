import {
    postCompletions,
    postCompletionsPrompt,
    type OpenAICompletionsResponse,
    type PostCompletionsOptions,
} from '../../shared/api/completionsClient';
import type { ChatMessage } from './chatMessages';
import type { ChatDisplaySegment, ChatMultiTurnRun } from './chatSegments';
import {
    assistantOutputOffsetForRound,
} from './toolCallParser';
import { tr } from '../../shared/lang/i18n-lite';
import { assertStreamMatchesFinal } from './completionStreamAssert';
import { toolConfigToolsSchema, type ToolConfig } from './toolConfig';
import { TOOL_CALLING_PENDING_LABEL } from './toolCallingPendingUi';
import {
    isAbortError,
    MAX_TOOL_ROUNDS,
    prepareToolRoundContinuation,
} from './wireMultiTurn';

export { MAX_TOOL_ROUNDS } from './wireMultiTurn';
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
            tools: toolConfigToolsSchema(toolConfig),
            enable_thinking: enableThinking,
        },
        { signal }
    );
    return res.prompt_used!;
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
            const assistantOutputOffset = assistantOutputOffsetForRound(
                round,
                firstPrompt.length,
                wire.length
            );

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

            // TF 预先拼在 wire 上、completion 只返回增量 → 按 offset 切片再解析
            const continuation = await prepareToolRoundContinuation({
                assistantTurnText: wire.slice(assistantOutputOffset),
                toolConfig: opts.toolConfig,
                model: opts.model,
                enableThinking: opts.enableThinking,
                signal: opts.signal,
                onMockResolved: () => {
                    segments.push({ kind: 'input', text: TOOL_CALLING_PENDING_LABEL, pending: true });
                    opts.onSegmentsUpdate?.(segments);
                },
            });
            if (continuation.status === 'malformed') {
                throw new Error(tr('Invalid tool_call JSON in model output'));
            }
            if (continuation.status === 'stop') {
                return { segments };
            }

            wire += continuation.incrementalSuffix;
            segments[segments.length - 1] = { kind: 'input', text: continuation.incrementalSuffix };
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
