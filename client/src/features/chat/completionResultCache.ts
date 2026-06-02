import type { OpenAICompletionsResponse } from '../../shared/api/completionsClient';
import type { PredictionAttributeModelVariant } from '../../shared/prediction_attribution/core/attributionResultCache';
import {
    buildContentKeyFromBusinessKey,
    getByContentKey,
    listMru,
    patchPayloadRow,
    type CachedHistoryListRow,
    removeByContentKey,
    touchByContentKey,
    upsertEntry,
} from '../../shared/storage/cachedHistoryStore';

const MAX_SIZE = 50;
const NAMESPACE = 'chat';
const LS_LEGACY_CHAT_CACHE_MIGRATED = 'info_radar_chat_cache_model_key_migrated';

export type CompletionResultCacheKey = {
    prompt: string;
    model: PredictionAttributeModelVariant;
};
/** 生成时左侧面板快照；加载 Cached history / `?content=` 时还原模式、输入与选项 */
export type ChatCompletionDraft = {
    mode: 'raw' | 'chat';
    model?: PredictionAttributeModelVariant;
    maxTokens?: number;
    /** raw 模式：输入框原文 */
    raw?: string;
    /** chat 模板模式 */
    system?: string;
    user?: string;
    useSystem?: boolean;
    enableThinking?: boolean;
};

export type CompletionCachedEntry = {
    promptUsed: string;
    response: OpenAICompletionsResponse;
    /** 新缓存写入；旧条目缺失时 Chat 页按 instruct 处理 */
    modelVariant?: PredictionAttributeModelVariant;
    /** 旧缓存无此字段时仅恢复 promptUsed / modelVariant */
    draft?: ChatCompletionDraft;
};

export function contentKeyForCacheKey(key: CompletionResultCacheKey): string {
    return buildContentKeyFromBusinessKey({ prompt: key.prompt, model: key.model });
}

/** 旧版仅含 prompt 的 businessKey 对应 contentKey（升级前 Ask 缓存） */
export function legacyContentKeyForPrompt(prompt: string): string {
    return buildContentKeyFromBusinessKey({ prompt });
}

function parseLegacyPromptOnlyBusinessKey(businessKeyJson: string): string | undefined {
    try {
        const o = JSON.parse(businessKeyJson) as { prompt?: unknown; model?: unknown };
        if (typeof o.prompt === 'string' && o.model === undefined) {
            return o.prompt;
        }
    } catch {
        /* ignore */
    }
    return undefined;
}

function legacyDraftForEntry(
    entry: CompletionCachedEntry,
    prompt: string
): ChatCompletionDraft {
    return {
        mode: 'raw',
        model: 'instruct',
        raw: entry.promptUsed ?? prompt,
    };
}

/** 一次性：旧条目补 modelVariant + raw/instruct draft；保留 contentKey 以兼容既有 `?content=` */
export async function migrateLegacyChatCacheIfNeeded(): Promise<void> {
    if (localStorage.getItem(LS_LEGACY_CHAT_CACHE_MIGRATED)) {
        return;
    }
    const rows = await listMru<CompletionCachedEntry>(NAMESPACE);
    for (const row of rows) {
        const prompt = parseLegacyPromptOnlyBusinessKey(row.businessKeyJson);
        if (prompt === undefined) continue;
        const entry = row.payload;
        const draft = entry.draft ?? legacyDraftForEntry(entry, prompt);
        const upgraded: CompletionCachedEntry = {
            ...entry,
            modelVariant: entry.modelVariant ?? 'instruct',
            draft,
        };
        const businessKeyJson = JSON.stringify({ prompt, model: 'instruct' as const });
        await patchPayloadRow(NAMESPACE, row.contentKey, {
            businessKeyJson,
            listLabel: listLabelForSave({ prompt, model: 'instruct' }, draft),
            payload: upgraded,
        });
    }
    localStorage.setItem(LS_LEGACY_CHAT_CACHE_MIGRATED, '1');
}

/** 供 completions 客户端：按请求键读响应（instruct 时回退旧 prompt-only 键） */
export async function get(key: CompletionResultCacheKey): Promise<OpenAICompletionsResponse | undefined> {
    const primary = contentKeyForCacheKey(key);
    let row = await getByContentKey<CompletionCachedEntry>(NAMESPACE, primary);
    if (!row && key.model === 'instruct') {
        const legacy = legacyContentKeyForPrompt(key.prompt);
        if (legacy !== primary) {
            row = await getByContentKey<CompletionCachedEntry>(NAMESPACE, legacy);
        }
    }
    return row?.payload.response;
}

export async function getCachedEntryByContentKey(raw: string): Promise<CompletionCachedEntry | undefined> {
    if (!raw) return undefined;
    const entry = await getByContentKey<CompletionCachedEntry>(NAMESPACE, raw);
    return entry?.payload;
}

export async function touch(key: CompletionResultCacheKey): Promise<void> {
    const primary = contentKeyForCacheKey(key);
    await touchByContentKey(NAMESPACE, primary);
    if (key.model === 'instruct') {
        const legacy = legacyContentKeyForPrompt(key.prompt);
        if (legacy !== primary) {
            const row = await getByContentKey<CompletionCachedEntry>(NAMESPACE, legacy);
            if (row) {
                await touchByContentKey(NAMESPACE, legacy);
            }
        }
    }
}

export async function touchCachedEntryByContentKey(contentKey: string): Promise<void> {
    await touchByContentKey(NAMESPACE, contentKey);
}

export async function removeForCacheKey(key: CompletionResultCacheKey): Promise<void> {
    await removeByContentKey(NAMESPACE, contentKeyForCacheKey(key));
    if (key.model === 'instruct') {
        const legacy = legacyContentKeyForPrompt(key.prompt);
        if (legacy !== contentKeyForCacheKey(key)) {
            await removeByContentKey(NAMESPACE, legacy);
        }
    }
}

export async function listCachedHistoryRows(): Promise<CachedHistoryListRow[]> {
    const rows = await listMru<CompletionCachedEntry>(NAMESPACE);
    return rows.map((r) => ({ contentKey: r.contentKey, listLabel: r.listLabel }));
}

function listLabelForSave(key: CompletionResultCacheKey, draft?: ChatCompletionDraft): string {
    if (draft?.mode === 'chat') {
        const u = draft.user?.trim();
        if (u) return u;
    }
    if (draft?.mode === 'raw') {
        const r = draft.raw?.trim();
        if (r) return r;
    }
    return key.prompt;
}

export async function save(
    key: CompletionResultCacheKey,
    response: OpenAICompletionsResponse,
    status: 'partial' | 'complete' = 'complete',
    draft?: ChatCompletionDraft
): Promise<{ contentKey: string }> {
    return upsertEntry({
        namespace: NAMESPACE,
        businessKeyJson: JSON.stringify({ prompt: key.prompt, model: key.model }),
        listLabel: listLabelForSave(key, draft),
        payload: {
            promptUsed: key.prompt,
            response,
            modelVariant: key.model === 'base' ? 'base' : 'instruct',
            draft,
        },
        status,
        maxEntries: MAX_SIZE,
    });
}

export async function removeCachedEntryByContentKey(contentKey: string): Promise<void> {
    await removeByContentKey(NAMESPACE, contentKey);
}
