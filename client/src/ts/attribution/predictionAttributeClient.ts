/**
 * /api/prediction-attribute：统一请求、JSON 解析与归因结果缓存写入。
 * 命中缓存与 MRU 规则见 {@link ./attributionResultCache}。
 */
import type { AttributionApiResponse, PredictionAttributeModelVariant } from './attributionResultCache';
import {
    entryKey,
    removeCachedEntryByContentKey,
    save,
    takeSuccessfulAttributionFromCache,
} from './attributionResultCache';

const JSON_ERROR_SNIPPET_MAX = 160;

export async function fetchPredictionAttribute(
    apiBaseForRequests: string,
    context: string,
    targetPrediction: string | null,
    model: PredictionAttributeModelVariant
): Promise<AttributionApiResponse> {
    const bodyObj: Record<string, unknown> = { context, model };
    if (targetPrediction !== null) {
        bodyObj.target_prediction = targetPrediction;
    }
    const res = await fetch(`${apiBaseForRequests}/api/prediction-attribute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(bodyObj),
    });
    const text = await res.text();
    let json: AttributionApiResponse & { message?: string };
    try {
        json = JSON.parse(text) as AttributionApiResponse & { message?: string };
    } catch {
        const snippet =
            text.slice(0, JSON_ERROR_SNIPPET_MAX) + (text.length > JSON_ERROR_SNIPPET_MAX ? '…' : '');
        throw new Error(
            `Response is not JSON (HTTP ${res.status}). Gateway or proxy may have returned HTML: ${snippet}`
        );
    }
    if (!res.ok) {
        throw new Error(json.message ?? `HTTP ${res.status}`);
    }
    if (!json.success) {
        throw new Error(json.message ?? `Request failed (HTTP ${res.status})`);
    }
    return json;
}

export type LoadPredictionAttributeWithCacheOptions = {
    apiBaseForRequests: string;
    context: string;
    targetPrediction: string;
    model: PredictionAttributeModelVariant;
    /** 与归因页「Force retry」一致：先按 entry 删缓存再请求 */
    forceRefresh?: boolean;
};

/**
 * 未强制刷新时：命中成功缓存则 touch 后返回；否则请求并 save。
 */
export async function loadPredictionAttributeWithCache(
    options: LoadPredictionAttributeWithCacheOptions
): Promise<AttributionApiResponse> {
    const { apiBaseForRequests, context, targetPrediction, model, forceRefresh } = options;
    if (forceRefresh) {
        await removeCachedEntryByContentKey(entryKey(context, targetPrediction));
    }
    if (!forceRefresh) {
        const hit = await takeSuccessfulAttributionFromCache(context, targetPrediction);
        if (hit) {
            return hit;
        }
    }
    const json = await fetchPredictionAttribute(apiBaseForRequests, context, targetPrediction, model);
    await save({ context, targetPrediction }, json, 'complete');
    return json;
}
