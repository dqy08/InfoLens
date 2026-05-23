import {
    buildContentKeyFromBusinessKey,
    getByContentKey,
    listMru,
    type CachedHistoryListRow,
    removeByContentKey,
    touchByContentKey,
    upsertEntry,
} from '../../../shared/storage/cachedHistoryStore';

/** 与 POST /api/prediction-attribute 请求体 `model` 一致（仅请求层使用，不参与缓存键） */
export type PredictionAttributeModelVariant = 'base' | 'instruct';

export type AttributionApiResponse = {
    success: boolean;
    model?: string;
    target_token?: string;
    target_prob?: number;
    token_attribution?: Array<{ offset: [number, number]; raw: string; score: number }>;
    /** 与语义分析同形：下一 token top10（无 abbrev） */
    debug_info?: { abbrev?: string; topk_tokens?: string[]; topk_probs?: number[] };
    /** target_token 是否为 EOS token，top-1 模式下由服务端填充，客户端据此判断是否终止生成循环 */
    is_eos?: boolean;
};

export type AttributionCachedEntry = {
    context: string;
    targetPrediction: string;
    response: AttributionApiResponse;
};

/** 与 {@link upsertEntry} 的 business 对象字段一致 */
export type AttributionCacheKey = {
    context: string;
    targetPrediction: string;
};

const MAX_SIZE = 100;
const NAMESPACE = 'attribution';

/** 条目短键（哈希） */
export function entryKey(context: string, targetPrediction: string): string {
    return buildContentKeyFromBusinessKey({ context, targetPrediction });
}

function formatAttributionListLabel(context: string, targetPrediction: string): string {
    const maxCtx = 48;
    const c = context.length > maxCtx ? `${context.slice(0, maxCtx)}…` : context;
    return `${c} → ${targetPrediction}`;
}

export function buildCachedContentUrlParam(context: string, targetPrediction: string): string {
    return entryKey(context, targetPrediction);
}

export async function get(key: AttributionCacheKey): Promise<AttributionCachedEntry | undefined> {
    const entry = await getByContentKey<AttributionCachedEntry>(
        NAMESPACE,
        entryKey(key.context, key.targetPrediction)
    );
    return entry?.payload;
}

export async function save(
    key: AttributionCacheKey,
    response: AttributionApiResponse,
    status: 'partial' | 'complete' = response.success ? 'complete' : 'partial'
): Promise<void> {
    await upsertEntry({
        namespace: NAMESPACE,
        businessKeyJson: JSON.stringify({ context: key.context, targetPrediction: key.targetPrediction }),
        listLabel: formatAttributionListLabel(key.context, key.targetPrediction),
        payload: {
            context: key.context,
            targetPrediction: key.targetPrediction,
            response,
        } as AttributionCachedEntry,
        status,
        maxEntries: MAX_SIZE,
    });
}

export async function touch(key: AttributionCacheKey): Promise<void> {
    await touchByContentKey(NAMESPACE, entryKey(key.context, key.targetPrediction));
}

export async function listCachedHistoryRows(): Promise<CachedHistoryListRow[]> {
    const rows = await listMru<AttributionCachedEntry>(NAMESPACE);
    return rows.map((r) => ({ contentKey: r.contentKey, listLabel: r.listLabel }));
}

export async function getCachedEntryByContentKey(key: string): Promise<AttributionCachedEntry | undefined> {
    if (!key) return undefined;
    const entry = await getByContentKey<AttributionCachedEntry>(NAMESPACE, key);
    return entry?.payload;
}

export async function removeCachedEntryByContentKey(key: string): Promise<void> {
    if (!key) return;
    await removeByContentKey(NAMESPACE, key);
}

export async function touchCachedEntryByContentKey(contentKey: string): Promise<void> {
    await touchByContentKey(NAMESPACE, contentKey);
}

/**
 * 若存在 success 缓存则 touch MRU 并返回响应，否则 undefined。
 * 供侧栏与归因页命中缓存路径使用。
 */
export async function takeSuccessfulAttributionFromCache(
    context: string,
    targetPrediction: string
): Promise<AttributionApiResponse | undefined> {
    const cached = await get({ context, targetPrediction });
    if (!cached?.response?.success) {
        return undefined;
    }
    await touch({ context, targetPrediction });
    return cached.response;
}
