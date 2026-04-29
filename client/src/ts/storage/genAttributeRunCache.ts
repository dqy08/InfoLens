import type { TokenGenStep } from '../attribution/tokenGenAttributionRunner';
import {
    canonicalizeCompletionFinishReason,
    isCompletionFinishReason,
    type CompletionFinishReason,
} from '../utils/generationEndReasonLabel';
import {
    buildContentKeyFromBusinessKey,
    getByContentKey,
    listMru,
    type CachedHistoryListRow,
    removeByContentKey,
    touchByContentKey,
    upsertEntry,
} from './cachedHistoryStore';

const NAMESPACE = 'gen_attr';
const MAX_ENTRIES = 50;

export type GenAttrCachedRun = {
    initialContext: string;
    steps: TokenGenStep[];
    /** 与 OpenAI `finish_reason` 子集一致，见 {@link CompletionFinishReason} */
    completionReason?: CompletionFinishReason;
};

export type GenAttrCacheKey = {
    initialContext: string;
};

function keyHashForContext(initialContext: string): string {
    return buildContentKeyFromBusinessKey({ initialContext });
}

export async function save(
    key: GenAttrCacheKey,
    steps: TokenGenStep[],
    status: 'partial' | 'complete' = steps.length > 0 ? 'partial' : 'complete',
    completionReason?: CompletionFinishReason
): Promise<void> {
    const { initialContext } = key;
    let reasonToStore: CompletionFinishReason | undefined;
    if (completionReason !== undefined) {
        const c = canonicalizeCompletionFinishReason(completionReason);
        if (!isCompletionFinishReason(c)) {
            throw new Error(`gen_attr cache: invalid completionReason: ${completionReason}`);
        }
        reasonToStore = c;
    }
    const payload: GenAttrCachedRun = {
        initialContext,
        steps,
        ...(reasonToStore !== undefined ? { completionReason: reasonToStore } : {}),
    };
    await upsertEntry({
        namespace: NAMESPACE,
        businessKeyJson: JSON.stringify({ initialContext }),
        listLabel: initialContext,
        payload,
        status,
        maxEntries: MAX_ENTRIES,
    });
}

export async function get(key: GenAttrCacheKey): Promise<GenAttrCachedRun | undefined> {
    const row = await getByContentKey<GenAttrCachedRun>(NAMESPACE, keyHashForContext(key.initialContext));
    return row?.payload;
}

export async function getCachedEntryByContentKey(raw: string): Promise<GenAttrCachedRun | undefined> {
    if (!raw) return undefined;
    const row = await getByContentKey<GenAttrCachedRun>(NAMESPACE, raw);
    return row?.payload;
}

export function buildCachedContentUrlParam(initialContext: string): string {
    return keyHashForContext(initialContext);
}

export async function removeCachedEntryByContentKey(contentKey: string): Promise<void> {
    await removeByContentKey(NAMESPACE, contentKey);
}

export async function touchCachedEntryByContentKey(contentKey: string): Promise<void> {
    await touchByContentKey(NAMESPACE, contentKey);
}

export async function listCachedHistoryRows(): Promise<CachedHistoryListRow[]> {
    const rows = await listMru<GenAttrCachedRun>(NAMESPACE);
    return rows.map((r) => ({ contentKey: r.contentKey, listLabel: r.listLabel }));
}
