/**
 * /api/prediction-attribute 与 /api/tokenize：统一请求与 JSON 解析。
 * 归因缓存规则见 {@link ./attributionResultCache}。
 */
import type { AttributionApiResponse, PredictionAttributeModelVariant } from './attributionResultCache';
import type { PromptTokenSpan } from '../causal_flow/genAttributeDagPreprocess';
import {
    entryKey,
    removeCachedEntryByContentKey,
    save,
    takeSuccessfulAttributionFromCache,
} from './attributionResultCache';

const JSON_ERROR_SNIPPET_MAX = 160;
export type PredictionAttributeSourcePage =
    | 'analysis'
    | 'chat'
    | 'attribution'
    | 'causal_flow';

export async function fetchPredictionAttribute(
    apiBaseForRequests: string,
    context: string,
    targetPrediction: string | null,
    model: PredictionAttributeModelVariant,
    sourcePage: PredictionAttributeSourcePage,
    targetTokenId?: number,
    flowId?: string,
    flowStep?: number,
): Promise<AttributionApiResponse> {
    const bodyObj: Record<string, unknown> = { context, model, source_page: sourcePage };
    if (targetPrediction !== null) {
        bodyObj.target_prediction = targetPrediction;
    }
    if (typeof targetTokenId === 'number' && Number.isInteger(targetTokenId) && targetTokenId >= 0) {
        bodyObj.target_token_id = targetTokenId;
    }
    if (typeof flowId === 'string' && flowId.length > 0) {
        bodyObj.flow_id = flowId;
    }
    if (typeof flowStep === 'number' && Number.isInteger(flowStep) && flowStep >= 0) {
        bodyObj.flow_step = flowStep;
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
    sourcePage: PredictionAttributeSourcePage;
    /** 与归因页「Force retry」一致：先按 entry 删缓存再请求 */
    forceRefresh?: boolean;
};

export type LoadPredictionAttributeResult = {
    response: AttributionApiResponse;
    /** IndexedDB 条目的 contentKey；与 `?content=` 一致 */
    contentKey: string;
};

/**
 * 未强制刷新时：命中成功缓存则 touch 后返回；否则请求并 save。
 */
export async function loadPredictionAttributeWithCache(
    options: LoadPredictionAttributeWithCacheOptions
): Promise<LoadPredictionAttributeResult> {
    const { apiBaseForRequests, context, targetPrediction, model, sourcePage, forceRefresh } = options;
    if (forceRefresh) {
        await removeCachedEntryByContentKey(entryKey(context, targetPrediction));
    }
    if (!forceRefresh) {
        const hit = await takeSuccessfulAttributionFromCache(context, targetPrediction);
        if (hit) {
            return hit;
        }
    }
    const json = await fetchPredictionAttribute(apiBaseForRequests, context, targetPrediction, model, sourcePage);
    const { contentKey } = await save({ context, targetPrediction }, json, 'complete');
    return { response: json, contentKey };
}

/**
 * POST /api/tokenize：快速分词，返回 prompt 各 token 的 offset + raw。
 * 不占推理锁，响应极快，用于在 DAG 模式流式生成时提前展示 prompt 节点。
 */
export async function fetchTokenize(
    apiBase: string,
    context: string,
    model: PredictionAttributeModelVariant,
): Promise<PromptTokenSpan[]> {
    const res = await fetch(`${apiBase}/api/tokenize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, model }),
    });
    const text = await res.text();
    let json: { success: boolean; spans?: PromptTokenSpan[]; message?: string };
    try {
        json = JSON.parse(text) as typeof json;
    } catch {
        const snippet = text.slice(0, 160) + (text.length > 160 ? '…' : '');
        throw new Error(`/api/tokenize response is not JSON (HTTP ${res.status}): ${snippet}`);
    }
    if (!res.ok || !json.success) {
        throw new Error(json.message ?? `HTTP ${res.status}`);
    }
    return json.spans ?? [];
}
