/** Config tools：编辑 tool config 快照的弹窗。 */
import * as d3 from 'd3';
import { tr } from '../../shared/lang/i18n-lite';
import { showDialog } from '../../shared/ui/dialog';
import { cloneCatalogEntry, getCatalogEntryByName, TOOL_CATALOG } from './toolCatalog';
import {
    buildToolConfigFromCheckedJson,
    createBlankToolEntry,
    formatToolCatalogEntryJson,
    nextAvailableNewToolName,
    parseToolCatalogEntryJson,
    type ToolCatalogEntry,
    type ToolConfig,
} from './toolConfig';

type DialogRow = {
    id: string;
    rowKey: string;
    template: ToolCatalogEntry;
    checked: boolean;
    jsonText: string;
    /** 用户拖拽调整后的 textarea 高度（px），全量 re-render 前从 DOM 同步 */
    textareaHeight?: number;
    /** 非 catalog 条目（用户新增或快照游离项） */
    custom: boolean;
};

let dialogRowIdSeq = 0;

function allocDialogRowId(): string {
    dialogRowIdSeq += 1;
    return `tool-dialog-row-${dialogRowIdSeq}`;
}

function buildInitialRows(config: ToolConfig): DialogRow[] {
    const snapshotEntries = isConfigRestorable(config) ? config.entries : [];
    const snapshotNames = new Set(snapshotEntries.map((e) => e.function.name));
    const rows: DialogRow[] = snapshotEntries.map((entry) => ({
        id: allocDialogRowId(),
        rowKey: entry.function.name,
        template: getCatalogEntryByName(entry.function.name) ?? entry,
        checked: true,
        jsonText: formatToolCatalogEntryJson(entry),
        custom: getCatalogEntryByName(entry.function.name) === undefined,
    }));
    for (const catalogEntry of TOOL_CATALOG) {
        if (!snapshotNames.has(catalogEntry.function.name)) {
            rows.push({
                id: allocDialogRowId(),
                rowKey: catalogEntry.function.name,
                template: catalogEntry,
                checked: false,
                jsonText: formatToolCatalogEntryJson(cloneCatalogEntry(catalogEntry)),
                custom: false,
            });
        }
    }
    return rows;
}

function isConfigRestorable(config: ToolConfig): boolean {
    return config.entries.length > 0;
}

function collectUsedToolNames(rows: DialogRow[]): string[] {
    const names: string[] = [];
    for (const row of rows) {
        names.push(row.rowKey);
        const text = row.jsonText.trim();
        if (!text) continue;
        const parsed = parseToolCatalogEntryJson(text);
        if ('entry' in parsed) {
            names.push(parsed.entry.function.name);
        }
    }
    return names;
}

function addCustomToolRow(rows: DialogRow[]): DialogRow {
    const name = nextAvailableNewToolName(collectUsedToolNames(rows));
    const entry = createBlankToolEntry(name);
    const row: DialogRow = {
        id: allocDialogRowId(),
        rowKey: name,
        template: entry,
        checked: true,
        jsonText: formatToolCatalogEntryJson(entry),
        custom: true,
    };
    rows.push(row);
    return row;
}

function resolveRowBaseName(row: DialogRow): string {
    const text = row.jsonText.trim();
    if (text) {
        const parsed = parseToolCatalogEntryJson(text);
        if ('entry' in parsed) {
            return parsed.entry.function.name;
        }
    }
    return row.rowKey;
}

function rowDisplayLabel(row: DialogRow): string {
    const name = resolveRowBaseName(row);
    if (!row.custom) return name;
    if (!row.checked) {
        return `${name} (${tr('custom, will not save')})`;
    }
    return `${name} (${tr('custom')})`;
}

export function showEditableToolConfigDialog(
    config: ToolConfig,
    onConfirm: (next: ToolConfig) => void,
): void {
    dialogRowIdSeq = 0;
    const rows: DialogRow[] = buildInitialRows(config);
    let parsedOnConfirm: ToolConfig | null = null;

    showDialog({
        title: tr('Config tools'),
        width: 'clamp(360px, 94vw, 720px)',
        confirmText: tr('Confirm'),
        cancelText: tr('Cancel'),
        content: (contentRoot) => {
            const form = contentRoot
                .append('div')
                .attr('class', 'dialog-form-container dialog-form-container--fill chat-tool-config-form');

            const errorEl = form
                .append('div')
                .attr('class', 'chat-tool-config-error')
                .style('display', 'none');

            const scrollRegion = form.append('div').attr('class', 'dialog-scroll-region');
            const listEl = scrollRegion.append('div').attr('class', 'chat-tool-config-list');

            const syncTextareasFromDom = (): void => {
                listEl.selectAll<HTMLDivElement, unknown>('.chat-tool-config-item').each(function () {
                    const rowId = this.getAttribute('data-row-id');
                    const row = rows.find((r) => r.id === rowId);
                    const ta = this.querySelector('textarea');
                    if (row && ta) {
                        row.jsonText = ta.value;
                        row.textareaHeight = ta.offsetHeight;
                    }
                });
            };

            let scrollToRowId: string | null = null;

            const render = (): void => {
                syncTextareasFromDom();
                listEl.selectAll('*').remove();
                for (const row of rows) {
                    const item = listEl
                        .append('div')
                        .attr('class', 'chat-tool-config-item')
                        .classed('chat-tool-config-item--expanded', row.checked)
                        .attr('data-row-id', row.id);

                    const head = item.append('label').attr('class', 'chat-tool-config-item-head');
                    head
                        .append('input')
                        .attr('type', 'checkbox')
                        .property('checked', row.checked)
                        .on('change', function () {
                            syncTextareasFromDom();
                            const checked = (this as HTMLInputElement).checked;
                            row.checked = checked;
                            if (checked && !row.jsonText.trim()) {
                                row.jsonText = formatToolCatalogEntryJson(cloneCatalogEntry(row.template));
                            }
                            render();
                        });
                    head.append('span').attr('class', 'chat-tool-config-item-label').text(rowDisplayLabel(row));

                    if (row.checked) {
                        const ta = item
                            .append('textarea')
                            .attr('class', 'dialog-textarea chat-tool-config-entry-json')
                            .attr('spellcheck', 'false')
                            .property('value', row.jsonText)
                            .on('input', function () {
                                row.jsonText = (this as HTMLTextAreaElement).value;
                            });
                        if (row.textareaHeight != null) {
                            ta.style('height', `${row.textareaHeight}px`);
                        }
                    }
                }

                if (scrollToRowId) {
                    const scrollEl = scrollRegion.node();
                    const el = listEl
                        .select(`[data-row-id="${scrollToRowId}"]`)
                        .node() as HTMLElement | null;
                    if (scrollEl && el) {
                        el.scrollIntoView({ block: 'nearest' });
                    }
                    scrollToRowId = null;
                }
            };

            const shell = d3.select(contentRoot.node()!.parentElement!);
            shell
                .select('.dialog-buttons')
                .insert('button', '.dialog-button.cancel')
                .attr('type', 'button')
                .attr('class', 'text-action-btn chat-tool-config-add-btn')
                .text(tr('Add tool'))
                .on('click', () => {
                    syncTextareasFromDom();
                    const added = addCustomToolRow(rows);
                    scrollToRowId = added.id;
                    errorEl.style('display', 'none');
                    render();
                });

            render();

            return {
                validate: () => {
                    syncTextareasFromDom();
                    const checked = rows.filter((r) => r.checked);
                    const built = buildToolConfigFromCheckedJson(
                        checked.map((r) => ({ label: rowDisplayLabel(r), text: r.jsonText })),
                    );
                    if ('error' in built) {
                        errorEl.text(built.error).style('display', 'block');
                        parsedOnConfirm = null;
                        return false;
                    }
                    errorEl.style('display', 'none');
                    parsedOnConfirm = built.config;
                    return true;
                },
                getValue: () => parsedOnConfirm,
            };
        },
        onConfirm: (value: ToolConfig | null) => {
            if (!value) return false;
            onConfirm(value);
        },
    });
}
