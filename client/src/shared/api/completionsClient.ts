import URLHandler from '../core/URLHandler';
import * as completionResultCache from '../../features/chat/completionResultCache';
import type { TokenWithOffset } from './generatedSchemas';

/** 与 server.yaml basePath `/api` + `/v1/completions` 一致 */
const COMPLETIONS_PATH = '/api/v1/completions';
const COMPLETIONS_PROMPT_PATH = '/api/v1/completions/prompt';
const COMPLETIONS_STOP_PATH = '/api/v1/completions/stop';

/** 与 server_openai_definitions.yaml OpenAICompletionsRequest 对齐的最小类型 */
export type OpenAICompletionsRequest = {
    model: string;
    prompt: string;
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    stop?: string | string[];
    [key: string]: unknown;
};

export type OpenAICompletionChoice = {
    text?: string;
    index?: number;
    finish_reason?: string | null;
};

/** 与 server_openai_definitions InfoRadarCompletionPayload 对齐 */
export type InfoRadarCompletionPayload = {
    bpe_strings: TokenWithOffset[];
};

/** 与 OpenAICompletionsResponse 对齐（SSE 末条 result 的 data 与此同形） */
export type OpenAICompletionsResponse = {
    id: string;
    object: 'text_completion';
    created: number;
    model: string;
    choices: OpenAICompletionChoice[];
    usage?: {
        prompt_tokens?: number;
        completion_tokens?: number;
        total_tokens?: number;
    };
    /** 续写 token 级 real_topk / pred_topk，与主站信息密度分析字段一致 */
    info_radar?: InfoRadarCompletionPayload;
};

/**
 * 单用户串行：通知后端全局停止续写（不 await，避免阻塞 UI）。
 * Chat 页 Stop 仅调用此函数而不断开 fetch，以便仍收到末条 SSE result（含 info_radar）。
 */
export function postCompletionsStop(): void {
    const url = URLHandler.basicURL() + COMPLETIONS_STOP_PATH;
    void fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: '{}'
    }).catch(() => {
        /* 忽略：Stop 与 SSE 并行，失败时生成仍可能靠墙钟或其它路径结束 */
    });
}

export type PostCompletionsPromptOptions = {
    signal?: AbortSignal;
};

/**
 * POST /v1/completions/prompt：将用户原文套用 chat template，返回实际送入续写的完整 prompt。
 */
export async function postCompletionsPrompt(
    body: { model: string; prompt: string; system?: string; enable_thinking?: boolean },
    options: PostCompletionsPromptOptions = {}
): Promise<{ prompt_used: string }> {
    const { signal } = options;
    const url = URLHandler.basicURL() + COMPLETIONS_PROMPT_PATH;
    const payload: {
        model: string;
        prompt: string;
        system?: string;
        enable_thinking?: boolean;
    } = {
        model: body.model,
        prompt: body.prompt
    };
    if (body.system !== undefined) {
        payload.system = body.system;
    }
    if (body.enable_thinking === true) {
        payload.enable_thinking = true;
    }
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(payload),
        signal
    });
    const text = await res.text();
    let parsed: { success?: boolean; message?: string; prompt_used?: string };
    try {
        parsed = JSON.parse(text) as typeof parsed;
    } catch {
        throw new Error(`POST ${COMPLETIONS_PROMPT_PATH} failed: ${res.status} ${text.slice(0, 500)}`);
    }
    if (!res.ok) {
        const msg =
            typeof parsed.message === 'string' ? parsed.message : text.slice(0, 500);
        throw new Error(msg || `POST ${COMPLETIONS_PROMPT_PATH} failed: ${res.status}`);
    }
    if (typeof parsed.prompt_used !== 'string' || !parsed.prompt_used.length) {
        throw new Error('completions/prompt response missing prompt_used');
    }
    return { prompt_used: parsed.prompt_used };
}

export type PostCompletionsOptions = {
    signal?: AbortSignal;
    /** 续写增量文本 */
    onDelta?: (text: string, streamEnd: boolean) => void;
    /** 与请求体 `prompt` 一致（prompt_used）；仅 Chat 等需缓存时传入 */
    cacheKey?: completionResultCache.CompletionResultCacheKey;
    /** 为 true 时跳过命中本地缓存，与 Chat 页「Force retry」一致 */
    forceRefresh?: boolean;
};

/**
 * POST /v1/completions：响应恒为 SSE（delta… → result）。
 * 末条 result 的 data 为 OpenAICompletionsResponse；可与拼接的 delta 对照校验。
 */
export async function postCompletions(
    body: OpenAICompletionsRequest,
    options: PostCompletionsOptions = {}
): Promise<OpenAICompletionsResponse> {
    const { signal, onDelta, cacheKey, forceRefresh } = options;
    const modelName = body.model;

    return new Promise((resolve, reject) => {
        let settled = false;
        let streamedText = '';

        const safeReject = (e: unknown) => {
            if (!settled) {
                settled = true;
                reject(e);
            }
        };

        const safeResolve = (v: OpenAICompletionsResponse) => {
            if (settled) return;
            if (signal?.aborted) {
                safeReject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            settled = true;
            if (typeof v.choices?.[0]?.text === 'string' && cacheKey) {
                void completionResultCache.save(cacheKey, v, 'complete');
            }
            resolve(v);
        };

        const rejectIfAborted = (): boolean => {
            if (!signal?.aborted) return false;
            if (cacheKey && streamedText.length > 0) {
                void completionResultCache.save(
                    cacheKey,
                    {
                        id: `partial-${Date.now()}`,
                        object: 'text_completion',
                        created: Math.floor(Date.now() / 1000),
                        model: modelName,
                        choices: [{ text: streamedText, index: 0, finish_reason: 'abort' }],
                    },
                    'partial'
                );
            }
            safeReject(new DOMException('Aborted', 'AbortError'));
            return true;
        };

        if (cacheKey) {
            void (async () => {
                try {
                    if (forceRefresh) {
                        await completionResultCache.removeCachedEntryByContentKey(
                            completionResultCache.contentKeyForPrompt(cacheKey.prompt)
                        );
                    }
                    const cached = forceRefresh ? undefined : await completionResultCache.get(cacheKey);
                    if (cached) {
                        await completionResultCache.touch(cacheKey);
                        queueMicrotask(() => {
                            if (settled) return;
                            if (rejectIfAborted()) return;
                            const text = cached.choices?.[0]?.text;
                            if (typeof text !== 'string') {
                                safeReject(new Error('completions cache: invalid choices[0].text'));
                                return;
                            }
                            onDelta?.(text, true);
                            if (settled) return;
                            if (signal?.aborted) {
                                safeReject(new DOMException('Aborted', 'AbortError'));
                                return;
                            }
                            settled = true;
                            resolve(cached);
                        });
                        return;
                    }
                } catch (e) {
                    console.warn('[completions] read cache failed:', e);
                }
                fetchRemote();
            })();
            return;
        }

        fetchRemote();

        function fetchRemote(): void {
        fetch(URLHandler.basicURL() + COMPLETIONS_PATH, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=UTF-8' },
            body: JSON.stringify(body),
            signal
        })
            .then((response) => {
                if (!response.ok) {
                    return response.text().then((t) => {
                        throw new Error(`POST ${COMPLETIONS_PATH} failed: ${response.status} ${t.slice(0, 500)}`);
                    });
                }
                const reader = response.body!.getReader();
                signal?.addEventListener('abort', () => reader.cancel(), { once: true });

                const decoder = new TextDecoder();
                let buffer = '';

                const processDataLine = (jsonStr: string) => {
                    if (settled) return;
                    if (rejectIfAborted()) return;
                    let parsed: {
                        type?: string;
                        text?: string;
                        stream_end?: boolean;
                        data?: OpenAICompletionsResponse;
                        message?: string;
                    };
                    try {
                        parsed = JSON.parse(jsonStr) as typeof parsed;
                    } catch (e) {
                        safeReject(
                            new Error(
                                `SSE event JSON parse failed: ${
                                    e instanceof SyntaxError ? e.message : String(e)
                                }`
                            )
                        );
                        return;
                    }
                    if (parsed.type === 'delta') {
                        const delta = parsed.text ?? '';
                        streamedText += delta;
                        onDelta?.(delta, Boolean(parsed.stream_end));
                    } else if (parsed.type === 'result') {
                        const data = parsed.data;
                        if (data && typeof data === 'object' && 'choices' in data) {
                            safeResolve(data as OpenAICompletionsResponse);
                        } else {
                            safeReject(new Error('completions stream: invalid result payload'));
                        }
                    } else if (parsed.type === 'error') {
                        safeReject(new Error(parsed.message || 'completions stream failed'));
                    }
                };

                const readChunk = (): Promise<void> => {
                    return reader.read().then(({ done, value }) => {
                        if (settled) return;
                        if (rejectIfAborted()) return;
                        if (done) {
                            if (buffer.trim()) {
                                const line = buffer;
                                if (line.startsWith('data: ')) processDataLine(line.slice(6));
                            }
                            if (!settled) {
                                safeReject(new Error('completions stream ended without result'));
                            }
                            return;
                        }
                        buffer += decoder.decode(value, { stream: true });
                        const lines = buffer.split('\n');
                        buffer = lines.pop() || '';
                        for (const line of lines) {
                            if (line.startsWith('data: ')) processDataLine(line.slice(6));
                        }
                        return readChunk();
                    });
                };
                return readChunk();
            })
            .catch((e) => {
                if (!settled) safeReject(e);
            });
        }
    });
}
