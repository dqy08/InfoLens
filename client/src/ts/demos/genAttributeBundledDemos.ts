/**
 * Gen Attribute 打包 demo：JSON 放在 `dist/demos/gen_attribute/`，运行时 fetch，不打入 bundle。
 * 列表来自同目录 `manifest.json`（构建时由 webpack 插件生成）。
 */

import type { GenAttrCachedRun } from '../storage/genAttributeRunCache';
import { isKnownPersistedCompletionReason } from '../utils/generationEndReasonLabel';

const BASE = 'demos/gen_attribute/';

function baseUrl(): URL {
    return new URL(BASE, window.location.href);
}

function isSafeDemoSlug(s: string): boolean {
    if (s.length === 0 || s.length > 512) return false;
    if (s.includes('..') || s.includes('/') || s.includes('\\')) return false;
    return true;
}

function isValidGenAttrCachedRunPayload(v: unknown): v is GenAttrCachedRun {
    if (v == null || typeof v !== 'object') return false;
    const o = v as {
        initialContext?: unknown;
        steps?: unknown;
        completionReason?: unknown;
    };
    if (
        typeof o.initialContext !== 'string' ||
        !Array.isArray(o.steps) ||
        o.steps.length === 0
    ) {
        return false;
    }
    if (o.completionReason !== undefined) {
        if (typeof o.completionReason !== 'string' || !isKnownPersistedCompletionReason(o.completionReason)) {
            return false;
        }
    }
    return true;
}

const payloadCache = new Map<string, GenAttrCachedRun>();
const payloadInflight = new Map<string, Promise<GenAttrCachedRun | undefined>>();

type BundledDemoListEntry = { id: string; label: string };

let manifestListCache: readonly BundledDemoListEntry[] | undefined;
let manifestListInflight: Promise<readonly BundledDemoListEntry[]> | undefined;

/**
 * manifest 构建期固定；本会话内只网络请求一次，并发首次调用会去重。
 */
export async function fetchBundledGenAttributeDemoList(): Promise<readonly BundledDemoListEntry[]> {
    if (manifestListCache) return manifestListCache;
    if (!manifestListInflight) {
        manifestListInflight = fetch(new URL('manifest.json', baseUrl()))
            .then((r) => {
                if (!r.ok) throw new Error(`manifest: ${r.status}`);
                return r.json() as Promise<unknown>;
            })
            .then((j) => {
                const slugs =
                    j != null &&
                    typeof j === 'object' &&
                    'slugs' in j &&
                    Array.isArray((j as { slugs: unknown }).slugs)
                        ? (j as { slugs: unknown[] }).slugs.filter((x): x is string => typeof x === 'string')
                        : [];
                const list = slugs.map((slug) => ({ id: slug, label: slug }));
                manifestListCache = list;
                return list;
            })
            .finally(() => {
                manifestListInflight = undefined;
            });
    }
    return manifestListInflight;
}

/**
 * 按 slug 拉取单份 demo（点击项或 `?demo=`）；本会话内结果缓存 + 同一 slug 并发请求合并。
 */
export async function fetchBundledGenAttributeDemoBySlug(
    slug: string
): Promise<GenAttrCachedRun | undefined> {
    const s = slug.trim();
    if (!s || !isSafeDemoSlug(s)) return undefined;
    const hit = payloadCache.get(s);
    if (hit) return hit;
    let inflight = payloadInflight.get(s);
    if (!inflight) {
        inflight = (async (): Promise<GenAttrCachedRun | undefined> => {
            const fileUrl = new URL(`${encodeURIComponent(s)}.json`, baseUrl());
            const r = await fetch(fileUrl);
            if (!r.ok) return undefined;
            const raw: unknown = await r.json();
            if (!isValidGenAttrCachedRunPayload(raw)) {
                console.warn(`[genAttributeBundledDemos] invalid demo JSON: ${s}`);
                return undefined;
            }
            payloadCache.set(s, raw);
            return raw;
        })().finally(() => {
            payloadInflight.delete(s);
        });
        payloadInflight.set(s, inflight);
    }
    return inflight;
}

export function isGenAttrRunPayloadValidForUi(rec: GenAttrCachedRun | undefined): boolean {
    return rec != null && isValidGenAttrCachedRunPayload(rec);
}
