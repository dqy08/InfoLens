/**
 * 逐 token 生成归因：基于 /api/prediction-attribute。
 * 默认 `target_prediction` 为空 → 服务端 top-1 贪心；传入 {@link TokenGenAttributionOptions.teacherForcingContinuation} 时按用户续写逐步强制首 token 再归因。
 */
import type { AttributionApiResponse, PredictionAttributeModelVariant } from '../core/attributionResultCache';
import type { PromptTokenSpan } from './genAttributeDagPreprocess';
import type { CompletionFinishReason } from '../../cross/generationEndReasonLabel';
import { fetchPredictionAttribute, fetchTokenize } from '../core/predictionAttributeClient';
import { DEFAULT_MAX_NEW_TOKENS } from '../../cross/maxNewTokensConfig';

/** @deprecated 使用 {@link DEFAULT_MAX_NEW_TOKENS} */
export const TOKEN_GEN_MAX_TOKENS_DEFAULT = DEFAULT_MAX_NEW_TOKENS;

function splitCodePointPrefix(text: string, prefixLength: number): { prefix: string; rest: string } | null {
    if (prefixLength < 0) return null;
    const chars = Array.from(text);
    if (prefixLength > chars.length) return null;
    return {
        prefix: chars.slice(0, prefixLength).join(''),
        rest: chars.slice(prefixLength).join(''),
    };
}

export type CharRange = [number, number];

export type TokenGenStep = {
    /** 本步归因所用的 context（不含新 token） */
    context: string;
    /**
     * 静态初始 prompt 在 `context` 中的 exclusive 结尾下标；`context.slice(0, promptRegionEnd)` 为不含已生成后缀的 prompt。
     */
    promptRegionEnd: number;
    /** `context` 中属于 input（prompt + tool response）的区间；output 为其余部分。 */
    inputRanges: CharRange[];
    response: AttributionApiResponse;
    /** 本步生成的 token 字符串（即 response.target_token） */
    token: string;
    /** 目前已累积的全部生成文本（含本步 token） */
    currentText: string;
};

export type TokenGenAttributionOptions = {
    initialContext: string;
    apiPrefix: string;
    model: PredictionAttributeModelVariant;
    /**
     * 非空则启用 teacher forcing：启动时仅调用一次 `/api/tokenize` 预取 token_id，
     * 后续每步通过 `target_token_id` 指定归因目标，并按 spans 的码点覆盖推进。
     */
    teacherForcingContinuation?: string;
    /**
     * teacher forcing token 用尽后是否停止。
     * `true`：停止；`false`（默认）：切换为 top-1 继续生成，直到 maxTokens 或 EOS。
     */
    stopAfterTeacherForcing?: boolean;
    /** 最大生成 token 数，默认 {@link TOKEN_GEN_MAX_TOKENS_DEFAULT} */
    maxTokens?: number;
    /** 每生成一个 token 后的回调；`stepIndex` 从 0 起，与 {@link TokenGenAttributionHandle.getAllSteps} 下标一致 */
    onStep: (step: TokenGenStep, stepIndex: number) => void;
    onComplete: (reason: CompletionFinishReason) => void;
    onError: (err: Error) => void;
    /** 单次连续生成归因会话 ID；用于后端日志压缩与统计归类。 */
    flowId: string;
};

export type TokenGenAttributionHandle = {
    abort(): void;
    getStep(idx: number): TokenGenStep | undefined;
    getAllSteps(): TokenGenStep[];
    /** 已生成的 token 总数（含进行中步骤） */
    readonly tokenCount: number;
};

export function startTokenGenAttribution(opts: TokenGenAttributionOptions): TokenGenAttributionHandle {
    const {
        initialContext,
        apiPrefix,
        model,
        maxTokens = TOKEN_GEN_MAX_TOKENS_DEFAULT,
        stopAfterTeacherForcing = false,
        flowId,
    } = opts;
    const tfOpt = opts.teacherForcingContinuation;
    const forcingEnabled = typeof tfOpt === 'string' && tfOpt.length > 0;
    const promptRegionEnd = initialContext.length;
    let aborted = false;
    let generatedText = '';
    let remainingForcing = tfOpt ?? '';
    let forcingPieces: Array<{ token: string; tokenId: number }> = [];
    let forcingPieceIndex = 0;
    const steps: TokenGenStep[] = [];

    const loop = async (): Promise<void> => {
        if (forcingEnabled) {
            let spans;
            try {
                spans = await fetchTokenize(apiPrefix, tfOpt, model);
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                opts.onError(error);
                opts.onComplete('error');
                return;
            }
            if (!spans.length) {
                opts.onError(new Error('Teacher forcing tokenize returned empty spans.'));
                opts.onComplete('error');
                return;
            }
            const chars = Array.from(tfOpt);
            let cursor = 0;
            const pieces: Array<{ token: string; tokenId: number }> = [];
            for (const span of spans) {
                const [start, end] = span.offset;
                const tokenId = (span as PromptTokenSpan).token_id;
                if (start < 0 || end <= start || end > chars.length) {
                    opts.onError(
                        new Error(`Teacher forcing tokenize returned invalid span [${start}, ${end}) for continuation.`)
                    );
                    opts.onComplete('error');
                    return;
                }
                if (start > cursor) {
                    opts.onError(
                        new Error(
                            `Teacher forcing tokenize produced gap: span starts at ${start} but consumed cursor is ${cursor}.`
                        )
                    );
                    opts.onComplete('error');
                    return;
                }
                if (end <= cursor) {
                    continue;
                }
                if (typeof tokenId !== 'number' || !Number.isInteger(tokenId) || tokenId < 0) {
                    opts.onError(
                        new Error(
                            `Teacher forcing tokenize span is missing token_id at offset [${start}, ${end}).`
                        )
                    );
                    opts.onComplete('error');
                    return;
                }
                pieces.push({ token: chars.slice(cursor, end).join(''), tokenId });
                cursor = end;
            }
            if (cursor !== chars.length) {
                opts.onError(
                    new Error(
                        `Teacher forcing tokenize did not fully cover continuation: consumed ${cursor}/${chars.length} code points.`
                    )
                );
                opts.onComplete('error');
                return;
            }
            if (!pieces.length) {
                opts.onError(new Error('Teacher forcing tokenize produced no consumable pieces.'));
                opts.onComplete('error');
                return;
            }
            forcingPieces = pieces;
        }

        while (true) {
            if (aborted) {
                opts.onComplete('abort');
                return;
            }
            if (steps.length >= maxTokens) {
                opts.onComplete('length');
                return;
            }
            const forcingExhausted = forcingEnabled && forcingPieceIndex >= forcingPieces.length;
            if (forcingExhausted && stopAfterTeacherForcing) {
                opts.onComplete('stop');
                return;
            }

            const context = initialContext + generatedText;
            const targetTokenId =
                forcingEnabled && !forcingExhausted ? forcingPieces[forcingPieceIndex]!.tokenId : undefined;

            let response: AttributionApiResponse;
            try {
                response = await fetchPredictionAttribute(
                    apiPrefix,
                    context,
                    null,
                    model,
                    'causal_flow',
                    targetTokenId,
                    flowId,
                    steps.length,
                );
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                opts.onError(error);
                opts.onComplete('error');
                return;
            }

            if (aborted) {
                opts.onComplete('abort');
                return;
            }

            let token = response.target_token ?? '';

            if (forcingEnabled && !forcingExhausted) {
                token = forcingPieces[forcingPieceIndex]!.token;
                const sliced = splitCodePointPrefix(remainingForcing, Array.from(token).length);
                if (!sliced) {
                    opts.onError(
                        new Error(
                            `Teacher forcing piece consume failed at step=${forcingPieceIndex}: token="${token}", remaining="${remainingForcing}"`
                        )
                    );
                    opts.onComplete('error');
                    return;
                }
                remainingForcing = sliced.rest;
                forcingPieceIndex++;
            }
            generatedText += token;

            if (aborted) {
                opts.onComplete('abort');
                return;
            }

            const step: TokenGenStep = {
                context,
                promptRegionEnd,
                inputRanges: [[0, promptRegionEnd]],
                response,
                token,
                currentText: generatedText,
            };
            const stepIndex = steps.length;
            steps.push(step);

            try {
                opts.onStep(step, stepIndex);
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                opts.onError(error);
                opts.onComplete('error');
                return;
            }

            if (!token || response.is_eos) {
                opts.onComplete('stop');
                return;
            }
        }
    };

    void loop();

    return {
        abort() {
            aborted = true;
        },
        getStep(idx) {
            return steps[idx];
        },
        getAllSteps() {
            return steps.slice();
        },
        get tokenCount() {
            return steps.length;
        },
    };
}

/** Hydrate a read-only handle for DAG refresh / exclude replay（顺序即步序）。 */
export function createHydratedTokenGenHandle(frozenSteps: TokenGenStep[]): TokenGenAttributionHandle {
    const steps = frozenSteps.slice();
    return {
        abort() {
            /* no-op */
        },
        getStep(idx) {
            return steps[idx];
        },
        getAllSteps() {
            return steps.slice();
        },
        get tokenCount() {
            return steps.length;
        },
    };
}
