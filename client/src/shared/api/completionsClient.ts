import URLHandler from '../core/URLHandler';
import * as completionResultCache from '../../features/chat/completionResultCache';
import type { ChatDisplaySegment } from '../../features/chat/chatSegments';
import { AdminManager } from '../cross/adminManager';
import type { TokenWithOffset } from './generatedSchemas';

function completionsRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json; charset=UTF-8',
    };
    const admin = AdminManager.getInstance();
    const token = admin.isInAdminMode() ? admin.getAdminToken() : null;
    if (token) {
        headers['X-Admin-Token'] = token;
    }
    return headers;
}

/** 与 server.yaml basePath `/api` + `/v1/completions` 一致 */
const COMPLETIONS_PATH = '/api/v1/completions';
const COMPLETIONS_PROMPT_PATH = '/api/v1/completions/prompt';
const COMPLETIONS_PROMPT_INCREMENTAL_PATH = '/api/v1/completions/prompt-incremental';
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
        headers: completionsRequestHeaders(),
        body: '{}'
    }).catch(() => {
        /* 忽略：Stop 与 SSE 并行，失败时生成仍可能靠墙钟或其它路径结束 */
    });
}

export type PostCompletionsPromptOptions = {
    signal?: AbortSignal;
};

export type CompletionsChatMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    name?: string;
};

/**
 * POST /v1/completions/prompt：将 messages 套用 chat template，返回完整 prompt_used。
 */
export async function postCompletionsPrompt(
    body: {
        model: string;
        messages: CompletionsChatMessage[];
        tools?: Record<string, unknown>[];
        enable_thinking?: boolean;
    },
    options: PostCompletionsPromptOptions = {}
): Promise<{ prompt_used: string }> {
    const { signal } = options;
    const url = URLHandler.basicURL() + COMPLETIONS_PROMPT_PATH;
    const payload: Record<string, unknown> = {
        model: body.model,
        messages: body.messages,
    };
    if (body.tools !== undefined && body.tools.length > 0) {
        payload.tools = body.tools;
    }
    if (body.enable_thinking === true) {
        payload.enable_thinking = true;
    }
    const res = await fetch(url, {
        method: 'POST',
        headers: completionsRequestHeaders(),
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

/**
 * POST /v1/completions/prompt-incremental：计算多轮 wire 模式下 tool response 的 incremental_suffix。
 */
export async function postCompletionsPromptIncremental(
    body: {
        model: string;
        tool_content: string;
        tool_name?: string;
        enable_thinking?: boolean;
    },
    options: PostCompletionsPromptOptions = {}
): Promise<{ incremental_suffix: string }> {
    const { signal } = options;
    const url = URLHandler.basicURL() + COMPLETIONS_PROMPT_INCREMENTAL_PATH;
    const payload: Record<string, unknown> = {
        model: body.model,
        tool_content: body.tool_content,
    };
    if (body.tool_name !== undefined) {
        payload.tool_name = body.tool_name;
    }
    if (body.enable_thinking === true) {
        payload.enable_thinking = true;
    }
    const res = await fetch(url, {
        method: 'POST',
        headers: completionsRequestHeaders(),
        body: JSON.stringify(payload),
        signal
    });
    const text = await res.text();
    let parsed: { success?: boolean; message?: string; incremental_suffix?: string };
    try {
        parsed = JSON.parse(text) as typeof parsed;
    } catch {
        throw new Error(`POST ${COMPLETIONS_PROMPT_INCREMENTAL_PATH} failed: ${res.status} ${text.slice(0, 500)}`);
    }
    if (!res.ok) {
        const msg =
            typeof parsed.message === 'string' ? parsed.message : text.slice(0, 500);
        throw new Error(msg || `POST ${COMPLETIONS_PROMPT_INCREMENTAL_PATH} failed: ${res.status}`);
    }
    if (typeof parsed.incremental_suffix !== 'string') {
        throw new Error('completions/prompt-incremental response missing incremental_suffix');
    }
    return { incremental_suffix: parsed.incremental_suffix };
}

export type PostCompletionsOptions = {
    signal?: AbortSignal;
    /** 续写增量文本 */
    onDelta?: (text: string, streamEnd: boolean) => void;
    /** 与请求体 `prompt` 一致（prompt_used）；仅 Chat 等需缓存时传入 */
    cacheKey?: completionResultCache.CompletionResultCacheKey;
    /** 与 cacheKey 一并写入 IndexedDB，加载时还原左侧面板 */
    cacheDraft?: completionResultCache.ChatCompletionDraft;
    /** 为 true 时跳过命中本地缓存，与 Chat 页「Force retry」一致 */
    forceRefresh?: boolean;
};

/** postCompletions 返回值；传入 cacheKey 时 contentKey 与 IndexedDB / `?content=` 一致 */
export type PostCompletionsResult = {
    response: OpenAICompletionsResponse;
    contentKey?: string;
    /** 缓存命中时携带已存 segments（多轮或单轮） */
    cachedSegments?: ChatDisplaySegment[];
};

/**
 * POST /v1/completions：响应恒为 SSE（delta… → result）。
 * 末条 result 的 data 为 OpenAICompletionsResponse；可与拼接的 delta 对照校验。
 */
export async function postCompletions(
    body: OpenAICompletionsRequest,
    options: PostCompletionsOptions = {}
): Promise<PostCompletionsResult> {
    const { signal, onDelta, cacheKey, cacheDraft, forceRefresh } = options;
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

        const finishResolve = (
            response: OpenAICompletionsResponse,
            contentKey?: string,
            cachedSegments?: ChatDisplaySegment[]
        ) => {
            settled = true;
            resolve({ response, contentKey, cachedSegments });
        };

        const safeResolve = async (v: OpenAICompletionsResponse) => {
            if (settled) return;
            if (signal?.aborted) {
                safeReject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            let contentKey: string | undefined;
            if (typeof v.choices?.[0]?.text === 'string' && cacheKey) {
                try {
                    ({ contentKey } = await completionResultCache.save(
                        cacheKey,
                        v,
                        'complete',
                        cacheDraft
                    ));
                } catch (e) {
                    safeReject(e);
                    return;
                }
            }
            if (settled) return;
            if (signal?.aborted) {
                safeReject(new DOMException('Aborted', 'AbortError'));
                return;
            }
            finishResolve(v, contentKey);
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
                    'partial',
                    cacheDraft
                );
            }
            safeReject(new DOMException('Aborted', 'AbortError'));
            return true;
        };

        if (cacheKey) {
            void (async () => {
                try {
                    if (forceRefresh) {
                        await completionResultCache.removeForCacheKey(cacheKey);
                    }
                    const cachedEntry = forceRefresh
                        ? undefined
                        : await completionResultCache.getEntry(cacheKey);
                    if (cachedEntry) {
                        await completionResultCache.touch(cacheKey);
                        queueMicrotask(() => {
                            if (settled) return;
                            if (rejectIfAborted()) return;
                            const cached = cachedEntry.response;
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
                            finishResolve(cached, cachedEntry.contentKey, cachedEntry.segments);
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
            headers: completionsRequestHeaders(),
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
                            void safeResolve(data as OpenAICompletionsResponse);
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
