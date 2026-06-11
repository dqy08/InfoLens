import type { OpenAICompletionsResponse } from '../../shared/api/completionsClient';
import type { PredictionAttributeModelVariant } from '../../shared/prediction_attribution/core/attributionResultCache';
import type { ChatDisplaySegment } from './chatSegments';
import type { ToolConfig } from './toolConfig';
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
    /** true = 多轮 mock；省略或 false = 单轮 tool calling */
    multiTurn?: boolean;
};

function businessObjectForCacheKey(key: CompletionResultCacheKey) {
    return {
        prompt: key.prompt,
        model: key.model,
        multiTurn: key.multiTurn ?? false,
    };
}

function businessKeyJsonForCacheKey(key: CompletionResultCacheKey): string {
    return JSON.stringify(businessObjectForCacheKey(key));
}

function entryMatchesCacheKey(
    entry: CompletionCachedEntry,
    key: CompletionResultCacheKey
): boolean {
    const wantMulti = key.multiTurn === true;
    const draftMulti = entry.draft?.multiTurnMockEnabled === true;
    if (wantMulti !== draftMulti) {
        return false;
    }
    return true;
}
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
    toolCallingEnabled?: boolean;
    multiTurnMockEnabled?: boolean;
    toolConfig?: ToolConfig;
    /** 非空表示启用：拼接到 prompt 后的强制续写原文 */
    teacherForcing?: string;
};

export type CompletionCachedEntry = {
    promptUsed: string;
    response: OpenAICompletionsResponse;
    /** 多段展示（多轮 input/output）；旧缓存无此字段时按单轮 prompt+response 还原 */
    segments?: ChatDisplaySegment[];
    /** 新缓存写入；旧条目缺失时 Chat 页按 instruct 处理 */
    modelVariant?: PredictionAttributeModelVariant;
    /** 旧缓存无此字段时仅恢复 promptUsed / modelVariant */
    draft?: ChatCompletionDraft;
};

export function contentKeyForCacheKey(key: CompletionResultCacheKey): string {
    return buildContentKeyFromBusinessKey(businessObjectForCacheKey(key));
}

export function buildCompletionCacheKey(
    prompt: string,
    model: PredictionAttributeModelVariant,
    multiTurn: boolean
): CompletionResultCacheKey {
    return { prompt, model, multiTurn };
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

async function lookupEntryRow(
    key: CompletionResultCacheKey
): Promise<{ contentKey: string; payload: CompletionCachedEntry } | undefined> {
    const contentKeysToTry: string[] = [contentKeyForCacheKey(key)];
    if (!key.multiTurn) {
        const legacyModelKey = buildContentKeyFromBusinessKey({
            prompt: key.prompt,
            model: key.model,
        });
        if (legacyModelKey !== contentKeysToTry[0]) {
            contentKeysToTry.push(legacyModelKey);
        }
        if (key.model === 'instruct') {
            const legacyPromptOnly = legacyContentKeyForPrompt(key.prompt);
            if (!contentKeysToTry.includes(legacyPromptOnly)) {
                contentKeysToTry.push(legacyPromptOnly);
            }
        }
    }
    for (const ck of contentKeysToTry) {
        const row = await getByContentKey<CompletionCachedEntry>(NAMESPACE, ck);
        if (row && entryMatchesCacheKey(row.payload, key)) {
            return { contentKey: ck, payload: row.payload };
        }
    }
    return undefined;
}

/** 供 completions 客户端：按请求键读响应（单轮时回退旧 businessKey） */
export async function get(key: CompletionResultCacheKey): Promise<OpenAICompletionsResponse | undefined> {
    return (await lookupEntryRow(key))?.payload.response;
}

/** 读完整缓存条目（含 segments、draft） */
export async function getEntry(
    key: CompletionResultCacheKey
): Promise<(CompletionCachedEntry & { contentKey: string }) | undefined> {
    const row = await lookupEntryRow(key);
    if (!row) return undefined;
    return { ...row.payload, contentKey: row.contentKey };
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
    draft?: ChatCompletionDraft,
    entryExtra?: Pick<CompletionCachedEntry, 'segments'>
): Promise<{ contentKey: string }> {
    return upsertEntry({
        namespace: NAMESPACE,
        businessKeyJson: businessKeyJsonForCacheKey(key),
        listLabel: listLabelForSave(key, draft),
        payload: {
            promptUsed: key.prompt,
            response,
            modelVariant: key.model === 'base' ? 'base' : 'instruct',
            draft,
            ...entryExtra,
        },
        status,
        maxEntries: MAX_SIZE,
    });
}

export async function removeCachedEntryByContentKey(contentKey: string): Promise<void> {
    await removeByContentKey(NAMESPACE, contentKey);
}
