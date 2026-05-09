import type { TokenGenStep } from '../attribution/tokenGenAttributionRunner';
import type { PromptTokenSpan } from '../attribution/genAttributeDagPreprocess';
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

/** 生成时左侧输入面板的状态快照，随缓存一起存储，加载缓存时据此还原输入模式与内容。 */
export type GenAttrRunDraft = {
    mode: 'raw' | 'chat';
    /** 生成所用的 model 槽位 */
    model?: string;
    /** 生成时的 maxTokens 上限 */
    maxTokens?: number;
    /** chat 模式：system prompt 原文 */
    system?: string;
    /** chat 模式：user prompt 原文 */
    user?: string;
    /** chat 模式：是否启用 system prompt */
    useSystem?: boolean;
    /** Teacher forcing 续写原文；非空则表示已启用 teacher forcing。旧缓存无此字段时从根级 teacherForcingContinuation 降级读取。 */
    teacherForcing?: string;
    /** teacher forcing 结束后是否停止（而非继续 top-1 生成）。 */
    stopAfterTeacherForcing?: boolean;
};

export type GenAttrCachedRun = {
    initialContext: string;
    steps: TokenGenStep[];
    /** 完整 prompt token spans（offset + raw），与 /api/tokenize 同源；旧缓存无此字段时由调用方从 step 0 归因降级。 */
    promptSpans?: PromptTokenSpan[];
    /** 与 OpenAI `finish_reason` 子集一致，见 {@link CompletionFinishReason} */
    completionReason?: CompletionFinishReason;
    /** 生成时输入面板快照；旧缓存无此字段时回退到 raw 模式展示 initialContext。 */
    draft?: GenAttrRunDraft;
};

/**
 * 缓存业务 key：涵盖所有影响 steps 内容的生成参数。
 * 原则：draft 中存储的可变参数均纳入 key，同参数不同结果不应互相覆盖。
 */
export type GenAttrCacheKey = {
    initialContext: string;
    model: string;
    maxTokens: number;
    /** teacher forcing 续写文本，无则省略 */
    teacherForcing?: string;
    /** teacher forcing 用尽后是否停止，仅在 teacherForcing 非空时有意义 */
    stopAfterTeacherForcing?: boolean;
};

/** 规范化 key，去除对结果无影响的冗余字段，保证相同语义的 key 生成相同 hash。 */
function normalizeKey(key: GenAttrCacheKey): object {
    const tf = key.teacherForcing && key.teacherForcing.length > 0 ? key.teacherForcing : undefined;
    return {
        initialContext: key.initialContext,
        model: key.model,
        maxTokens: key.maxTokens,
        ...(tf !== undefined ? { teacherForcing: tf, stopAfterTeacherForcing: key.stopAfterTeacherForcing ?? false } : {}),
    };
}

function keyHash(key: GenAttrCacheKey): string {
    return buildContentKeyFromBusinessKey(normalizeKey(key));
}

export async function save(
    key: GenAttrCacheKey,
    steps: TokenGenStep[],
    promptSpans: PromptTokenSpan[],
    status: 'partial' | 'complete' = steps.length > 0 ? 'partial' : 'complete',
    completionReason?: CompletionFinishReason,
    draft?: GenAttrRunDraft
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
        ...(promptSpans.length > 0 ? { promptSpans } : {}),
        ...(reasonToStore !== undefined ? { completionReason: reasonToStore } : {}),
        ...(draft !== undefined ? { draft } : {}),
    };
    await upsertEntry({
        namespace: NAMESPACE,
        businessKeyJson: JSON.stringify(normalizeKey(key)),
        listLabel: initialContext,
        payload,
        status,
        maxEntries: MAX_ENTRIES,
    });
}

export async function get(key: GenAttrCacheKey): Promise<GenAttrCachedRun | undefined> {
    const row = await getByContentKey<GenAttrCachedRun>(NAMESPACE, keyHash(key));
    return row?.payload;
}

export async function getCachedEntryByContentKey(raw: string): Promise<GenAttrCachedRun | undefined> {
    if (!raw) return undefined;
    const row = await getByContentKey<GenAttrCachedRun>(NAMESPACE, raw);
    return row?.payload;
}

export function buildCachedContentUrlParam(key: GenAttrCacheKey): string {
    return keyHash(key);
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
