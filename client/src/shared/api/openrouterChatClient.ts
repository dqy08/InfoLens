/**
 * 浏览器直连 OpenRouter Chat Completions（实验：LLM Raw Chat 管理员旁路）。
 * 返回形状对齐本地 /v1/completions 的 OpenAICompletionsResponse（无 info_radar 染色）。
 */
import type { CompletionsChatMessage, OpenAICompletionsResponse } from './completionsClient';

const OPENROUTER_CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

export type OpenRouterChatRequest = {
    apiKey: string;
    model: string;
    messages: CompletionsChatMessage[];
    maxTokens: number;
    signal?: AbortSignal;
    onDelta?: (text: string, streamEnd: boolean) => void;
};

export type OpenRouterChatResult = {
    response: OpenAICompletionsResponse;
    /** 对端返回字段汇总（usage / id / model / finish_reason 等），供右侧 JSON 展示 */
    apiMeta: Record<string, unknown>;
};

function finishReasonFromOpenRouter(
    reason: string | null | undefined
): string | null {
    if (reason == null) return null;
    if (reason === 'stop') return 'stop';
    if (reason === 'length') return 'length';
    return reason;
}

/**
 * 流式 POST OpenRouter；拼出完整 assistant 文本，映射为本地 completions 响应形。
 */
export async function postOpenRouterChat(
    req: OpenRouterChatRequest
): Promise<OpenRouterChatResult> {
    const { apiKey, model, messages, maxTokens, signal, onDelta } = req;
    if (!apiKey.trim()) {
        throw new Error('OpenRouter API key is required');
    }
    if (!model.trim()) {
        throw new Error('OpenRouter model id is required');
    }

    const resp = await fetch(OPENROUTER_CHAT_URL, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${apiKey.trim()}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': typeof location !== 'undefined' ? location.origin : 'https://info-radar.local',
            'X-Title': 'info-radar-chat-openrouter',
        },
        body: JSON.stringify({
            model: model.trim(),
            messages: messages.map((m) => ({
                role: m.role,
                content: m.content,
                ...(m.name !== undefined ? { name: m.name } : {}),
            })),
            max_tokens: maxTokens,
            temperature: 0,
            stream: true,
            reasoning: { effort: 'none' },
        }),
        signal,
    });

    if (!resp.ok) {
        const errText = await resp.text().catch(() => '');
        let detail = errText.slice(0, 500);
        try {
            const j = JSON.parse(errText) as { error?: { message?: string } | string };
            const e = j.error;
            if (typeof e === 'string') detail = e;
            else if (e && typeof e.message === 'string') detail = e.message;
        } catch {
            /* keep raw */
        }
        throw new Error(`OpenRouter HTTP ${resp.status}: ${detail}`);
    }

    if (!resp.body) {
        throw new Error('OpenRouter response missing body');
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';
    let finishReason: string | null = null;
    let usage: OpenAICompletionsResponse['usage'];
    let rawModel = model;
    let responseId: string | undefined;
    /** 合并流式 chunk 里除 delta 外的字段，供调试展示 */
    const apiMeta: Record<string, unknown> = {};

    const mergeMetaFromChunk = (chunk: Record<string, unknown>): void => {
        for (const [k, v] of Object.entries(chunk)) {
            if (k === 'choices') continue;
            if (v !== undefined) {
                apiMeta[k] = v;
            }
        }
        const choices = chunk.choices;
        if (!Array.isArray(choices) || choices.length === 0) return;
        const c0 = choices[0] as Record<string, unknown>;
        const choiceMeta: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(c0)) {
            if (k === 'delta' || k === 'text') continue;
            if (v !== undefined && v !== null) {
                choiceMeta[k] = v;
            }
        }
        if (Object.keys(choiceMeta).length > 0) {
            apiMeta.choice = { ...(apiMeta.choice as object | undefined), ...choiceMeta };
        }
    };

    const handleDataPayload = (payload: string): void => {
        if (payload === '[DONE]') return;
        let chunk: Record<string, unknown>;
        try {
            chunk = JSON.parse(payload) as Record<string, unknown>;
        } catch {
            throw new Error(`OpenRouter unparseable SSE chunk: ${payload.slice(0, 200)}`);
        }
        if (chunk.error) {
            const err = chunk.error;
            const msg =
                typeof err === 'string'
                    ? err
                    : err && typeof err === 'object' && 'message' in err
                      ? String((err as { message?: unknown }).message)
                      : JSON.stringify(err);
            throw new Error(`OpenRouter error: ${msg}`);
        }
        mergeMetaFromChunk(chunk);
        if (typeof chunk.id === 'string' && chunk.id) {
            responseId = chunk.id;
        }
        if (typeof chunk.model === 'string' && chunk.model) {
            rawModel = chunk.model;
        }
        if (chunk.usage && typeof chunk.usage === 'object') {
            usage = chunk.usage as OpenAICompletionsResponse['usage'];
        }
        const choices = chunk.choices;
        if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== 'object') {
            return;
        }
        const choice = choices[0] as {
            delta?: { content?: string | null };
            finish_reason?: string | null;
        };
        const piece = choice.delta?.content;
        if (typeof piece === 'string' && piece.length > 0) {
            fullText += piece;
            onDelta?.(piece, false);
        }
        if (choice.finish_reason) {
            finishReason = choice.finish_reason;
        }
    };

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (;;) {
            const nl = buffer.indexOf('\n');
            if (nl < 0) break;
            const line = buffer.slice(0, nl).replace(/\r$/, '');
            buffer = buffer.slice(nl + 1);
            if (!line.startsWith('data:')) continue;
            handleDataPayload(line.slice(5).trimStart());
        }
    }
    if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
            const t = line.replace(/\r$/, '');
            if (!t.startsWith('data:')) continue;
            handleDataPayload(t.slice(5).trimStart());
        }
    }

    onDelta?.('', true);

    const mappedFinish = finishReasonFromOpenRouter(finishReason);
    apiMeta.assistant_text_length = fullText.length;
    if (mappedFinish != null) {
        apiMeta.finish_reason = mappedFinish;
    }

    return {
        response: {
            id: responseId ?? `openrouter-${Date.now()}`,
            object: 'text_completion',
            created: intTime(),
            model: rawModel,
            choices: [
                {
                    text: fullText,
                    index: 0,
                    finish_reason: mappedFinish,
                },
            ],
            usage,
            info_radar: { bpe_strings: [] },
        },
        apiMeta,
    };
}

function intTime(): number {
    return Math.floor(Date.now() / 1000);
}

/** 右侧 input 段展示用：把 messages 打成可读多段文本 */
export function formatOpenRouterMessagesAsPrompt(
    messages: CompletionsChatMessage[]
): string {
    return messages
        .map((m) => `[${m.role}]\n${m.content}`)
        .join('\n\n');
}
