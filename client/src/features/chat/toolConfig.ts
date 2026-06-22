/** Tool config：catalog 形状条目的快照，由运行时持有。 */

import { lsGet, lsSet } from '../../shared/storage/localStorageHelpers';

export type ToolCatalogMockCandidate = {
    response: Record<string, unknown>;
    trigger_keyword?: string;
};

export type ToolCatalogEntry = {
    function: Record<string, unknown> & { name: string };
    mock_results: ToolCatalogMockCandidate[];
};

export type ToolConfig = {
    entries: ToolCatalogEntry[];
};

type LegacyToolConfig = {
    tools_schema: Record<string, unknown>[];
    mock_results: Record<string, string>;
};

export const EMPTY_TOOL_CONFIG: ToolConfig = {
    entries: [],
};

export function toolConfigToolsSchema(config: ToolConfig): Record<string, unknown>[] {
    return config.entries.map((e) => ({ function: e.function }));
}

export function cloneToolConfig(config: unknown): ToolConfig {
    const normalized = normalizeToolConfig(config);
    if (!normalized) return JSON.parse(JSON.stringify(EMPTY_TOOL_CONFIG)) as ToolConfig;
    return JSON.parse(JSON.stringify(normalized)) as ToolConfig;
}

export function isToolConfigEmpty(config: ToolConfig): boolean {
    return config.entries.length === 0;
}

function parseMockResultsValue(mockStr: string, toolName: string): ToolCatalogMockCandidate[] {
    let parsed: unknown;
    try {
        parsed = JSON.parse(mockStr);
    } catch {
        throw new Error(`invalid mock JSON for ${toolName}`);
    }
    if (Array.isArray(parsed)) {
        return parsed.map((item, i) => {
            const candidate = validateMockCandidate(item, i);
            if ('error' in candidate) {
                throw new Error(`${toolName}: ${candidate.error}`);
            }
            return candidate;
        });
    }
    if (!parsed || typeof parsed !== 'object') {
        throw new Error(`invalid mock JSON for ${toolName}`);
    }
    return [{ response: parsed as Record<string, unknown> }];
}

function migrateLegacyToolConfig(legacy: LegacyToolConfig): ToolConfig {
    const entries: ToolCatalogEntry[] = legacy.tools_schema.map((schemaItem) => {
        const fn = (schemaItem as { function: ToolCatalogEntry['function'] }).function;
        if (!fn?.name) {
            throw new Error('tools_schema item missing function.name');
        }
        const mockStr = legacy.mock_results[fn.name];
        if (mockStr === undefined) {
            throw new Error(`tool config missing mock_results for ${fn.name}`);
        }
        return {
            function: JSON.parse(JSON.stringify(fn)) as ToolCatalogEntry['function'],
            mock_results: parseMockResultsValue(mockStr, fn.name),
        };
    });
    return { entries };
}

function validateMockCandidate(
    item: unknown,
    index: number,
): ToolCatalogMockCandidate | { error: string } {
    if (!item || typeof item !== 'object') {
        return { error: `mock_results[${index}] must be an object` };
    }
    const o = item as Record<string, unknown>;
    const response = o.response;
    if (!response || typeof response !== 'object' || Array.isArray(response)) {
        return { error: `mock_results[${index}].response must be a JSON object` };
    }
    const kw = o.trigger_keyword;
    if (kw !== undefined) {
        if (typeof kw !== 'string' || kw.length === 0) {
            return { error: `mock_results[${index}].trigger_keyword must be a non-empty string` };
        }
    }
    return {
        response: response as Record<string, unknown>,
        ...(kw !== undefined ? { trigger_keyword: kw as string } : {}),
    };
}

function validateEntry(entry: unknown): ToolCatalogEntry | null {
    if (!entry || typeof entry !== 'object') return null;
    const o = entry as Record<string, unknown>;
    const fn = o.function;
    if (!fn || typeof fn !== 'object') return null;
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) return null;
    const mockResults = o.mock_results;
    if (!Array.isArray(mockResults) || mockResults.length === 0) return null;
    const candidates: ToolCatalogMockCandidate[] = [];
    for (let i = 0; i < mockResults.length; i++) {
        const result = validateMockCandidate(mockResults[i], i);
        if ('error' in result) return null;
        candidates.push(result);
    }
    return {
        function: fn as ToolCatalogEntry['function'],
        mock_results: candidates,
    };
}

export function normalizeToolConfig(value: unknown): ToolConfig | null {
    if (!value || typeof value !== 'object') return null;
    const o = value as Record<string, unknown>;

    if (Array.isArray(o.entries)) {
        const entries: ToolCatalogEntry[] = [];
        for (const item of o.entries) {
            const entry = validateEntry(item);
            if (!entry) return null;
            entries.push(entry);
        }
        return { entries };
    }

    if (Array.isArray(o.tools_schema) && o.mock_results != null && typeof o.mock_results === 'object') {
        try {
            return migrateLegacyToolConfig(o as LegacyToolConfig);
        } catch {
            return null;
        }
    }

    return null;
}

export function isValidToolConfig(value: unknown): value is ToolConfig {
    return normalizeToolConfig(value) !== null;
}

export function readToolConfigFromLs(key: string): ToolConfig {
    const raw = lsGet(key);
    if (!raw) return cloneToolConfig(EMPTY_TOOL_CONFIG);
    try {
        const parsed: unknown = JSON.parse(raw);
        const normalized = normalizeToolConfig(parsed);
        if (normalized) return cloneToolConfig(normalized);
    } catch {
        /* invalid */
    }
    return cloneToolConfig(EMPTY_TOOL_CONFIG);
}

export function writeToolConfigToLs(key: string, config: ToolConfig): void {
    lsSet(key, JSON.stringify(cloneToolConfig(config)));
}

export function formatToolCatalogEntryJson(entry: ToolCatalogEntry): string {
    return JSON.stringify(entry, null, 2);
}

export function createBlankToolEntry(name: string): ToolCatalogEntry {
    return {
        function: {
            name,
            parameters: { type: 'object', properties: {} },
        },
        mock_results: [{ response: {} }],
    };
}

export function nextAvailableNewToolName(existingNames: Iterable<string>): string {
    const used = new Set(existingNames);
    if (!used.has('new_tool')) return 'new_tool';
    let n = 2;
    while (used.has(`new_tool_${n}`)) n += 1;
    return `new_tool_${n}`;
}

export function toolConfigToEntries(config: ToolConfig): ToolCatalogEntry[] {
    return JSON.parse(JSON.stringify(config.entries)) as ToolCatalogEntry[];
}

export function entriesToToolConfig(entries: ToolCatalogEntry[]): ToolConfig {
    return cloneToolConfig({ entries });
}

export function parseToolCatalogEntryJson(
    text: string,
): { entry: ToolCatalogEntry } | { error: string } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        return { error: 'Invalid JSON' };
    }
    if (!parsed || typeof parsed !== 'object') {
        return { error: 'Entry must be a JSON object' };
    }
    const o = parsed as Record<string, unknown>;
    const fn = o.function;
    if (!fn || typeof fn !== 'object') {
        return { error: 'Missing function' };
    }
    const name = (fn as { name?: unknown }).name;
    if (typeof name !== 'string' || name.length === 0) {
        return { error: 'function.name is required' };
    }
    const mockResults = o.mock_results;
    if (!Array.isArray(mockResults) || mockResults.length === 0) {
        return { error: 'mock_results must be a non-empty array' };
    }
    const candidates: ToolCatalogMockCandidate[] = [];
    for (let i = 0; i < mockResults.length; i++) {
        const result = validateMockCandidate(mockResults[i], i);
        if ('error' in result) return result;
        candidates.push(result);
    }
    return {
        entry: {
            function: fn as ToolCatalogEntry['function'],
            mock_results: candidates,
        },
    };
}

/** 从已勾选条目的 JSON 文本构建 ToolConfig；失败返回英文错误信息（UI 层可 tr）。 */
export function buildToolConfigFromCheckedJson(
    checkedTexts: { label: string; text: string }[],
): { config: ToolConfig } | { error: string } {
    if (checkedTexts.length === 0) {
        return { config: cloneToolConfig(EMPTY_TOOL_CONFIG) };
    }
    const entries: ToolCatalogEntry[] = [];
    const seen = new Set<string>();
    for (const { label, text } of checkedTexts) {
        const parsed = parseToolCatalogEntryJson(text);
        if ('error' in parsed) {
            return { error: `${label}: ${parsed.error}` };
        }
        const name = parsed.entry.function.name;
        if (seen.has(name)) {
            return { error: `Duplicate function.name: ${name}` };
        }
        seen.add(name);
        entries.push(parsed.entry);
    }
    return { config: entriesToToolConfig(entries) };
}

/** fingerprint 用：稳定序列化 tool config 全文。 */
export function toolConfigFingerprint(config: ToolConfig): string {
    return JSON.stringify(cloneToolConfig(config));
}

/**
 * 多轮 mock 时 tool config 影响后续轮次，须纳入缓存 business key。
 * 单轮时 tools_schema 已编入 prompt / initialContext，无需重复。
 */
export function toolConfigCacheKeyFields(
    multiTurn: boolean,
    config: ToolConfig,
): { toolConfigFingerprint?: string } {
    if (!multiTurn) return {};
    return { toolConfigFingerprint: toolConfigFingerprint(config) };
}
