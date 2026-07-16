/** Tool catalog：代码内只读的可用 tool 全集（`toolCatalog.json`）。 */
import catalogJson from './toolCatalog.json';
import type { ToolCatalogEntry } from './toolConfig';

function assertCatalog(entries: unknown): ToolCatalogEntry[] {
    if (!Array.isArray(entries)) {
        throw new Error('toolCatalog.json must be a JSON array');
    }
    return entries as ToolCatalogEntry[];
}

export const TOOL_CATALOG: readonly ToolCatalogEntry[] = assertCatalog(catalogJson);

export function getCatalogEntryByName(name: string): ToolCatalogEntry | undefined {
    return TOOL_CATALOG.find((e) => e.function.name === name);
}

export function cloneCatalogEntry(entry: ToolCatalogEntry): ToolCatalogEntry {
    return JSON.parse(JSON.stringify(entry)) as ToolCatalogEntry;
}
