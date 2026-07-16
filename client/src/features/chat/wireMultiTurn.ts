/**
 * Wire-model multi-turn runtime kernel（ADR-0001：前端编排）。
 * Chat / Causal Flow 各自提供「本轮生成」adapter；本模块拥有：
 * 解析 tool call → 解析 mock candidate → pending gap → incremental_suffix。
 */
import { postCompletionsPromptIncremental } from '../../shared/api/completionsClient';
import { resolveMockTool } from './mockExecutor';
import { parseToolCallFromCompletion } from './toolCallParser';
import type { ToolConfig } from './toolConfig';
import {
    runMockToolPendingGap,
    type ToolCallingPendingLine,
} from './toolCallingPendingUi';

export const MAX_TOOL_ROUNDS = 16;

export function isAbortError(err: unknown): boolean {
    return err instanceof DOMException && err.name === 'AbortError';
}

/** 请求 tool response 的 incremental_suffix（POST /v1/completions/prompt-incremental）。 */
export async function fetchIncrementalSuffix(
    model: string,
    enableThinking: boolean,
    toolName: string,
    toolContent: string,
    signal?: AbortSignal,
): Promise<string> {
    const { incremental_suffix } = await postCompletionsPromptIncremental(
        { model, tool_content: toolContent, tool_name: toolName, enable_thinking: enableThinking },
        { signal },
    );
    return incremental_suffix;
}

/** 同步决策：本轮 assistant 产出是否应注入 mock tool response。 */
export type ToolRoundDecision =
    | { status: 'stop' }
    | { status: 'malformed' }
    | { status: 'inject'; toolName: string; mockContent: string };

export function decideToolRoundContinuation(
    assistantTurnText: string,
    toolConfig: ToolConfig,
): ToolRoundDecision {
    const parsed = parseToolCallFromCompletion(assistantTurnText);
    if (parsed.status === 'malformed') return { status: 'malformed' };
    if (parsed.status === 'absent') return { status: 'stop' };

    const mockContent = resolveMockTool(
        toolConfig,
        parsed.call.name,
        parsed.call.arguments,
    );
    if (mockContent === null) return { status: 'stop' };

    return {
        status: 'inject',
        toolName: parsed.call.name,
        mockContent,
    };
}

export type PrepareToolRoundContinuationOptions = {
    assistantTurnText: string;
    toolConfig: ToolConfig;
    model: string;
    enableThinking: boolean;
    signal?: AbortSignal;
    /** Causal Flow SVG pending；Chat 自管 segment 时可省略 */
    mockToolGapUi?: ToolCallingPendingLine;
    /** mock 已解析、pending gap 之前（Chat 推 pending segment） */
    onMockResolved?: () => void;
};

export type ToolRoundContinuation =
    | { status: 'stop' }
    | { status: 'malformed' }
    | { status: 'continue'; incrementalSuffix: string };

/**
 * 在本轮模型产出之后：决定是否继续，并取回应追加到 wire 的 incremental_suffix。
 * 不修改 wire——由调用方追加。
 */
export async function prepareToolRoundContinuation(
    opts: PrepareToolRoundContinuationOptions,
): Promise<ToolRoundContinuation> {
    const decision = decideToolRoundContinuation(opts.assistantTurnText, opts.toolConfig);
    if (decision.status === 'malformed') return { status: 'malformed' };
    if (decision.status === 'stop') return { status: 'stop' };

    opts.onMockResolved?.();
    await runMockToolPendingGap(opts.signal, opts.mockToolGapUi);

    const incrementalSuffix = await fetchIncrementalSuffix(
        opts.model,
        opts.enableThinking,
        decision.toolName,
        decision.mockContent,
        opts.signal,
    );
    return { status: 'continue', incrementalSuffix };
}
