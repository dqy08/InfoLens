import type { OpenAICompletionsResponse } from '../api/completionsClient';
import {
    buildContentKeyFromBusinessKey,
    getByContentKey,
    listMru,
    type CachedHistoryListRow,
    removeByContentKey,
    touchByContentKey,
    upsertEntry,
} from '../storage/cachedHistoryStore';

const MAX_SIZE = 50;
const NAMESPACE = 'chat';

export type CompletionResultCacheKey = {
    prompt: string;
};
export type CompletionCachedEntry = {
    promptUsed: string;
    response: OpenAICompletionsResponse;
};

export function contentKeyForPrompt(promptUsed: string): string {
    return buildContentKeyFromBusinessKey({ prompt: promptUsed });
}

export function buildCachedContentUrlParam(promptUsed: string): string {
    return contentKeyForPrompt(promptUsed);
}

/** 供 completions 客户端：按请求键读响应 */
export async function get(key: CompletionResultCacheKey): Promise<OpenAICompletionsResponse | undefined> {
    const entry = await getByContentKey<CompletionCachedEntry>(NAMESPACE, contentKeyForPrompt(key.prompt));
    return entry?.payload.response;
}

export async function getCachedEntryByContentKey(raw: string): Promise<CompletionCachedEntry | undefined> {
    if (!raw) return undefined;
    const entry = await getByContentKey<CompletionCachedEntry>(NAMESPACE, raw);
    return entry?.payload;
}

export async function touch(key: CompletionResultCacheKey): Promise<void> {
    await touchByContentKey(NAMESPACE, contentKeyForPrompt(key.prompt));
}

export async function touchCachedEntryByContentKey(contentKey: string): Promise<void> {
    await touchByContentKey(NAMESPACE, contentKey);
}

export async function listCachedHistoryRows(): Promise<CachedHistoryListRow[]> {
    const rows = await listMru<CompletionCachedEntry>(NAMESPACE);
    return rows.map((r) => ({ contentKey: r.contentKey, listLabel: r.listLabel }));
}

export async function save(
    key: CompletionResultCacheKey,
    response: OpenAICompletionsResponse,
    status: 'partial' | 'complete' = 'complete'
): Promise<void> {
    await upsertEntry({
        namespace: NAMESPACE,
        businessKeyJson: JSON.stringify({ prompt: key.prompt }),
        listLabel: key.prompt,
        payload: { promptUsed: key.prompt, response },
        status,
        maxEntries: MAX_SIZE,
    });
}

export async function removeCachedEntryByContentKey(contentKey: string): Promise<void> {
    await removeByContentKey(NAMESPACE, contentKey);
}
