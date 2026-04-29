/**
 * 逐 token 生成归因：基于 /api/prediction-attribute (top-1 模式) 的贪心解码循环。
 * 每次 API 调用 = 一次前向 pass（贪心解码一个 token）+ 对该 token 的完整归因。
 */
import type { AttributionApiResponse, PredictionAttributeModelVariant } from './attributionResultCache';
import type { CompletionFinishReason } from '../utils/generationEndReasonLabel';
import { fetchPredictionAttribute } from './predictionAttributeClient';

export type TokenGenStep = {
    /** 本步归因所用的 context（不含新 token） */
    context: string;
    /**
     * 静态初始 prompt 在 `context` 中的 exclusive 结尾下标；`context.slice(0, promptRegionEnd)` 为不含已生成后缀的 prompt。
     */
    promptRegionEnd: number;
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
    /** 最大生成 token 数，默认 200 */
    maxTokens?: number;
    /** 每生成一个 token 后的回调；`stepIndex` 从 0 起，与 {@link TokenGenAttributionHandle.getAllSteps} 下标一致 */
    onStep: (step: TokenGenStep, stepIndex: number) => void;
    onComplete: (reason: CompletionFinishReason) => void;
    onError: (err: Error) => void;
};

export type TokenGenAttributionHandle = {
    abort(): void;
    getStep(idx: number): TokenGenStep | undefined;
    getAllSteps(): TokenGenStep[];
    /** 已生成的 token 总数（含进行中步骤） */
    readonly tokenCount: number;
};

export function startTokenGenAttribution(opts: TokenGenAttributionOptions): TokenGenAttributionHandle {
    const { initialContext, apiPrefix, model, maxTokens = 200 } = opts;
    const promptRegionEnd = initialContext.length;
    let aborted = false;
    let generatedText = '';
    const steps: TokenGenStep[] = [];

    const loop = async (): Promise<void> => {
        while (true) {
            if (aborted) {
                opts.onComplete('abort');
                return;
            }
            if (steps.length >= maxTokens) {
                opts.onComplete('length');
                return;
            }

            const context = initialContext + generatedText;
            let response: AttributionApiResponse;
            try {
                // target_prediction 传 null → 服务端 top-1 贪心解码
                response = await fetchPredictionAttribute(apiPrefix, context, null, model);
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

            const token = response.target_token ?? '';
            generatedText += token;

            const step: TokenGenStep = {
                context,
                promptRegionEnd,
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
