/**
 * API 根 URL：GitHub Pages 等静态部署用 <meta name="inforadar-api-base">；
 * HF / 本地同域部署不设 meta → 同源 ''；?api= 仅在无 meta 时作备用。
 */
import URLHandler from '../core/URLHandler';

export const INFORADAR_API_BASE_META_NAME = 'inforadar-api-base';

export function normalizeApiBase(url: string): string {
    const s = url.trim();
    if (!s) return '';
    return s.replace(/\/+$/, '');
}

/** 可单测：meta 优先，其次 ?api=，否则同源。 */
export function resolveApiBaseFromSources(apiParam: unknown, metaContent: string | null | undefined): string {
    const fromMeta = metaContent?.trim();
    if (fromMeta) return normalizeApiBase(fromMeta);
    if (apiParam !== undefined && apiParam !== null) {
        const fromParam = String(apiParam).trim();
        if (fromParam) return normalizeApiBase(fromParam);
    }
    return '';
}

export function resolveApiBase(): string {
    const meta =
        typeof document !== 'undefined'
            ? document.querySelector(`meta[name="${INFORADAR_API_BASE_META_NAME}"]`)?.getAttribute('content')
            : null;
    return resolveApiBaseFromSources(URLHandler.parameters['api'], meta);
}

/**
 * 拼接 API 完整 URL。`apiBase` 省略时读 resolveApiBase()；显式传 `''` 表示同源。
 * 所有 fetch / d3.json 请求应经此函数或 TextAnalysisAPI / resolveDemoFileUrl。
 */
export function apiUrl(path: string, apiBase?: string): string {
    const base = apiBase !== undefined ? normalizeApiBase(apiBase) : resolveApiBase();
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return `${base}${normalized}`;
}
