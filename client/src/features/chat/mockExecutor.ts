import type { ToolCatalogMockCandidate, ToolConfig } from './toolConfig';

export function hasMockTool(config: ToolConfig, name: string): boolean {
    return config.entries.some((e) => e.function.name === name);
}

function concatStringArgValues(args: Record<string, unknown>): string {
    const parts: string[] = [];
    for (const v of Object.values(args)) {
        if (typeof v === 'string') parts.push(v);
    }
    return parts.join('');
}

function resolveMockCandidate(
    candidates: ToolCatalogMockCandidate[],
    haystack: string,
): Record<string, unknown> | null {
    if (candidates.length === 0) return null;

    const hasAnyKeyword = candidates.some((c) => c.trigger_keyword !== undefined);
    if (!hasAnyKeyword) {
        return candidates[0]!.response;
    }

    for (const c of candidates) {
        if (c.trigger_keyword !== undefined && haystack.includes(c.trigger_keyword)) {
            return c.response;
        }
    }

    const fallback = candidates.find((c) => c.trigger_keyword === undefined);
    if (fallback) return fallback.response;

    return null;
}

/** 按 tool name 与 arguments 解析 mock；无匹配候选项时返回 null（不执行工具）。 */
export function resolveMockTool(
    config: ToolConfig,
    name: string,
    args: Record<string, unknown>,
): string | null {
    const entry = config.entries.find((e) => e.function.name === name);
    if (!entry) return null;
    const response = resolveMockCandidate(entry.mock_results, concatStringArgValues(args));
    if (!response) return null;
    return JSON.stringify(response);
}
