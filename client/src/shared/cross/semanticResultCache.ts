/**
 * 语义分析结果缓存：以 text + query + submode 的 hash 为索引。
 * 持久化到 localStorage，刷新后保留。删除查询历史时需调用 removeByQuery 清理对应缓存。
 */

import { lsGet, lsSetCatch } from '../storage/localStorageHelpers';

const MAX_SIZE = 100;
const STORAGE_KEY = 'info_radar_semantic_result_cache';

export type SemanticCacheResult = {
    success: boolean;
    model?: string;
    token_attention?: Array<{ offset: [number, number]; raw: string; score: number }>;
    debug_info?: { abbrev?: string; topk_tokens?: string[]; topk_probs?: number[] };
    full_match_degree?: number;
    message?: string;
};

type StoredEntry = SemanticCacheResult & { _query?: string };

function simpleHash(s: string): string {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) - h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

function buildKey(text: string, query: string, submode?: string): string {
    const parts = [text, query, submode ?? ''];
    return simpleHash(parts.join('\0'));
}

const cache = new Map<string, StoredEntry>();
let keyOrder: string[] = [];

function load(): void {
    try {
        const raw = lsGet(STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as { entries?: Record<string, StoredEntry>; keyOrder?: string[] };
        if (!parsed?.entries || typeof parsed.entries !== 'object') return;
        cache.clear();
        for (const [k, v] of Object.entries(parsed.entries)) {
            if (v && typeof v === 'object') cache.set(k, v);
        }
        keyOrder = Array.isArray(parsed.keyOrder)
            ? parsed.keyOrder.filter((k) => cache.has(k)).slice(-MAX_SIZE)
            : [...cache.keys()];
    } catch {
        cache.clear();
        keyOrder = [];
    }
}

load();

function persist(): void {
    const entries: Record<string, StoredEntry> = {};
    for (const [k, v] of cache) entries[k] = v;
    const err = lsSetCatch(STORAGE_KEY, JSON.stringify({ entries, keyOrder }));
    if (err === undefined) return;
    const reason =
        err instanceof DOMException && err.name === 'QuotaExceededError'
            ? 'localStorage 配额已满（Chrome 约 5MB/域名），建议减少 MAX_SIZE 或清理其他站点数据'
            : String(err);
    console.warn('[semanticResultCache] 持久化失败，刷新后缓存可能丢失。原因:', reason);
}

function evictOne(): void {
    if (keyOrder.length < MAX_SIZE) return;
    const oldest = keyOrder.shift()!;
    cache.delete(oldest);
}

export function get(text: string, query: string, submode?: string): SemanticCacheResult | undefined {
    const key = buildKey(text, query, submode);
    const entry = cache.get(key);
    if (!entry) return undefined;
    const { _query, ...rest } = entry as SemanticCacheResult & { _query?: string };
    return rest;
}

export function set(text: string, query: string, result: SemanticCacheResult, submode?: string): void {
    const key = buildKey(text, query, submode);
    if (cache.has(key)) {
        const idx = keyOrder.indexOf(key);
        if (idx >= 0) keyOrder.splice(idx, 1);
    }
    evictOne();
    cache.set(key, { ...result, _query: query });
    keyOrder.push(key);
    persist();
}

export function removeByQuery(query: string): void {
    const keysToRemove: string[] = [];
    for (const [key, entry] of cache) {
        if (entry._query === query) keysToRemove.push(key);
    }
    for (const key of keysToRemove) {
        cache.delete(key);
        const idx = keyOrder.indexOf(key);
        if (idx >= 0) keyOrder.splice(idx, 1);
    }
    if (keysToRemove.length) persist();
}
