/**
 * 多轮 mock tool calling 的逐 token 归因编排：每轮独立 `startTokenGenAttribution` session，
 * 检测 tool call 后注入 incremental_suffix 并启动下一轮。
 */
import type { PredictionAttributeModelVariant } from '../core/attributionResultCache';
import type { PromptTokenSpan } from './genAttributeDagPreprocess';
import type { CharRange, TokenGenStep } from './tokenGenAttributionRunner';
import { startTokenGenAttribution } from './tokenGenAttributionRunner';
import { fetchTokenize } from '../core/predictionAttributeClient';
import { postCompletionsPromptIncremental } from '../../api/completionsClient';
import type { CompletionFinishReason } from '../../cross/generationEndReasonLabel';
import type { ToolConfig } from '../../../features/chat/toolConfig';
import { executeMockTool, hasMockTool } from '../../../features/chat/mockExecutor';
import { parseToolCallFromCompletion } from '../../../features/chat/toolCallParser';
import { MAX_TOOL_ROUNDS } from '../../../features/chat/multiTurnToolCalling';
import {
    runMockToolPendingGap,
    type ToolCallingPendingLine,
} from '../../../features/chat/toolCallingPendingUi';
import { tr } from '../../lang/i18n-lite';

export type RunMultiTurnAttributionOptions = {
    apiPrefix: string;
    model: PredictionAttributeModelVariant;
    maxTokens: number;
    /** 首轮完整 prompt（`postCompletionsPrompt` 结果，不含 teacher forcing） */
    initialContext: string;
    teacherForcing?: string;
    toolConfig: ToolConfig;
    enableThinking: boolean;
    flowId: string;
    signal?: AbortSignal;
    onStep: (step: TokenGenStep) => void;
    /** 首轮 tokenize 得到的 prompt input spans（不含后续 tool response） */
    getPromptInputSpans: () => PromptTokenSpan[];
    onInputSpansAppended: (allInputSpans: PromptTokenSpan[], fullWire: string, inputRanges: CharRange[]) => void;
    /** mock tool 轮间占位行（Causal Flow 等；Chat 用 segment 自管） */
    mockToolGapUi?: ToolCallingPendingLine;
    onAllComplete: (reason: CompletionFinishReason) => void;
    onError: (err: Error) => void;
};

export type MultiTurnAttributionHandle = {
    abort(): void;
};

function isAbortError(err: unknown): boolean {
    return err instanceof DOMException && err.name === 'AbortError';
}

async function fetchIncrementalSuffix(
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

export function runMultiTurnAttribution(opts: RunMultiTurnAttributionOptions): MultiTurnAttributionHandle {
    let aborted = false;
    let currentRunnerAbort: (() => void) | null = null;

    const run = async (): Promise<void> => {
        let wire = opts.initialContext;
        const originalPromptEnd = opts.initialContext.length;
        let inputRanges: CharRange[] = [[0, originalPromptEnd]];
        let turnIndex = 0;
        let tokensGenerated = 0;
        let appendedInputSpans: PromptTokenSpan[] = [];

        while (turnIndex < MAX_TOOL_ROUNDS) {
            if (aborted || opts.signal?.aborted) {
                opts.onAllComplete('abort');
                return;
            }

            const remaining = opts.maxTokens - tokensGenerated;
            if (remaining <= 0) {
                opts.onAllComplete('length');
                return;
            }

            const turnResult = await new Promise<{
                reason: CompletionFinishReason;
                steps: TokenGenStep[];
            }>((resolve, reject) => {
                const handle = startTokenGenAttribution({
                    initialContext: wire,
                    apiPrefix: opts.apiPrefix,
                    model: opts.model,
                    maxTokens: remaining,
                    flowId: opts.flowId,
                    teacherForcingContinuation: turnIndex === 0 ? opts.teacherForcing : undefined,
                    onStep(step) {
                        opts.onStep({ ...step, inputRanges });
                    },
                    onComplete(reason) {
                        resolve({ reason, steps: handle.getAllSteps() });
                    },
                    onError(err) {
                        reject(err);
                    },
                });
                currentRunnerAbort = () => handle.abort();
            });

            currentRunnerAbort = null;

            if (aborted || opts.signal?.aborted) {
                opts.onAllComplete('abort');
                return;
            }

            const { reason, steps } = turnResult;
            if (reason === 'error') {
                opts.onAllComplete('error');
                return;
            }
            if (steps.length === 0) {
                opts.onAllComplete(reason);
                return;
            }

            tokensGenerated += steps.length;
            if (reason === 'length') {
                opts.onAllComplete('length');
                return;
            }

            const lastStep = steps[steps.length - 1]!;
            wire = lastStep.context + lastStep.token;
            const turnGenerated = lastStep.currentText;

            const parsed = parseToolCallFromCompletion(turnGenerated);
            if (parsed.status === 'malformed') {
                opts.onError(new Error(tr('Invalid tool_call JSON in model output')));
                opts.onAllComplete('error');
                return;
            }
            if (parsed.status === 'absent' || !hasMockTool(opts.toolConfig, parsed.call.name)) {
                opts.onAllComplete(reason);
                return;
            }

            await runMockToolPendingGap(opts.signal, opts.mockToolGapUi);

            const mockContent = executeMockTool(opts.toolConfig, parsed.call.name);
            const incrementalSuffix = await fetchIncrementalSuffix(
                opts.model,
                opts.enableThinking,
                parsed.call.name,
                mockContent,
                opts.signal,
            );

            const suffixStart = wire.length;
            wire += incrementalSuffix;

            const spans = await fetchTokenize(opts.apiPrefix, incrementalSuffix, opts.model);
            const globalSpans: PromptTokenSpan[] = spans.map((s) => ({
                ...s,
                offset: [s.offset[0] + suffixStart, s.offset[1] + suffixStart] as [number, number],
            }));

            inputRanges = [...inputRanges, [suffixStart, wire.length]];
            appendedInputSpans = [...appendedInputSpans, ...globalSpans];
            const allInputSpans = [...opts.getPromptInputSpans(), ...appendedInputSpans];
            opts.onInputSpansAppended(allInputSpans, wire, inputRanges);

            turnIndex += 1;
        }

        opts.onAllComplete('length');
    };

    void run().catch((err: unknown) => {
        if (aborted || isAbortError(err)) {
            opts.onAllComplete('abort');
            return;
        }
        const error = err instanceof Error ? err : new Error(String(err));
        opts.onError(error);
        opts.onAllComplete('error');
    });

    return {
        abort() {
            aborted = true;
            currentRunnerAbort?.();
        },
    };
}
