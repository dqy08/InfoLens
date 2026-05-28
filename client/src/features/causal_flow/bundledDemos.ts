/**
 * Gen Attribute 打包 demo：大 JSON 在 `dist/assets/demos/causal_flow/`，运行时 fetch；slug 列表构建期内联自 generated 模块。
 */

import {
    isValidGenAttrCachedRunPayload,
    parseGenAttrCachedRunPayload,
    type GenAttrCachedRun,
} from '../../shared/storage/genAttributeRunCache';
import { GEN_ATTRIBUTE_BUNDLED_DEMOS } from './genAttributeBundledDemoManifest.generated';

const BASE = 'assets/demos/causal_flow/';

function baseUrl(): URL {
    return new URL(BASE, window.location.href);
}

function isSafeDemoSlug(s: string): boolean {
    if (s.length === 0 || s.length > 512) return false;
    if (s.includes('..') || s.includes('/') || s.includes('\\')) return false;
    return true;
}

const payloadCache = new Map<string, GenAttrCachedRun>();
const payloadInflight = new Map<string, Promise<GenAttrCachedRun | undefined>>();

export type BundledDemoListEntry = { id: string; label: string; featuredStyle?: string };

/** 构建期固定的 bundled demo 列表（与当前 JS 同版本）。 */
export function getBundledGenAttributeDemoList(): readonly BundledDemoListEntry[] {
    return GEN_ATTRIBUTE_BUNDLED_DEMOS.map(({ slug, label, featured }) => ({
        id: slug,
        label,
        ...(featured ? { featuredStyle: featured } : {}),
    }));
}

/** `?demo=` / 列表 id 为 slug；UI 展示用 order 中的 label，未知 slug 则回退 slug。 */
export function getBundledGenAttributeDemoLabel(slug: string): string {
    const s = slug.trim();
    const hit = GEN_ATTRIBUTE_BUNDLED_DEMOS.find((d) => d.slug === s);
    return hit?.label ?? s;
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
            const parsed = parseGenAttrCachedRunPayload(raw, `bundled demo slug=${s}`);
            if (!parsed) return undefined;
            payloadCache.set(s, parsed);
            return parsed;
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
