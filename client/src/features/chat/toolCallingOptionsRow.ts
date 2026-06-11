import { tr } from '../../shared/lang/i18n-lite';
import { lsReadBool, lsWriteBool } from '../../shared/storage/localStorageHelpers';
import { showDialog } from '../../shared/ui/dialog';
import {
    DEFAULT_TOOL_CONFIG,
    cloneToolConfig,
    type ToolConfig,
} from './toolConfig';

const MOUNT_ID = 'tool_calling_options_mount';

export type ToolCallingOptionsRowOptions = {
    enableToolCallingStorageKey: string;
    multiTurnStorageKey: string;
    onStateChange: () => void;
};

/** 缓存 draft 还原；`multiTurnMockEnabled` 为 Chat draft 字段别名。 */
export type ToolCallingDraftRestore = {
    toolCallingEnabled?: boolean;
    multiTurnEnabled?: boolean;
    multiTurnMockEnabled?: boolean;
    toolConfig?: ToolConfig;
};

export type ToolCallingOptionsRowApi = {
    isToolCallingEnabled: () => boolean;
    isMultiTurnEnabled: () => boolean;
    getCurrentToolConfig: () => ToolConfig;
    restoreFromDraft: (draft: ToolCallingDraftRestore) => void;
    syncSubUi: () => void;
};

type ToolCallingRowElements = {
    enableInput: HTMLInputElement;
    multiTurnInput: HTMLInputElement;
    multiTurnRow: HTMLLabelElement;
    configBtn: HTMLButtonElement;
};

function showToolConfigDialog(config: ToolConfig): void {
    showDialog({
        title: tr('Config tools'),
        content: (dialog) => {
            dialog
                .append('pre')
                .attr('class', 'chat-tool-config-readonly')
                .style('white-space', 'pre-wrap')
                .style('font-size', '12px')
                .style('margin', '0')
                .text(JSON.stringify(config, null, 2));
            return {};
        },
        confirmText: null,
        cancelText: tr('Close'),
        width: 'clamp(320px, 92vw, 640px)',
    });
}

function mountToolCallingOptionsRow(mount: HTMLElement): ToolCallingRowElements {
    const row = document.createElement('div');
    row.className = 'semantic-submode-row chat-enable-tool-calling-row';

    const group = document.createElement('span');
    group.className = 'semantic-submode-group';

    const enableLabel = document.createElement('label');
    enableLabel.className = 'semantic-submode-label';

    const enableInput = document.createElement('input');
    enableInput.type = 'checkbox';
    enableInput.id = 'tool_calling_enable';
    enableLabel.htmlFor = enableInput.id;

    const enableText = document.createElement('span');
    enableText.textContent = tr('Tool use');

    enableLabel.append(enableInput, enableText);

    const multiTurnRow = document.createElement('label');
    multiTurnRow.className = 'semantic-submode-label';
    multiTurnRow.id = 'tool_calling_multi_turn_row';
    multiTurnRow.hidden = true;

    const multiTurnInput = document.createElement('input');
    multiTurnInput.type = 'checkbox';
    multiTurnInput.id = 'tool_calling_multi_turn';
    multiTurnInput.checked = true;
    multiTurnRow.htmlFor = multiTurnInput.id;

    const multiTurnText = document.createElement('span');
    multiTurnText.textContent = tr('Multi-turn');

    multiTurnRow.append(multiTurnInput, multiTurnText);

    const configBtn = document.createElement('button');
    configBtn.type = 'button';
    configBtn.id = 'tool_calling_config_btn';
    configBtn.className = 'text-action-btn';
    configBtn.hidden = true;
    configBtn.textContent = tr('Config tools');

    group.append(enableLabel, multiTurnRow, configBtn);
    row.append(group);
    mount.replaceChildren(row);

    return { enableInput, multiTurnInput, multiTurnRow, configBtn };
}

export function createToolCallingOptionsRow(
    options: ToolCallingOptionsRowOptions
): ToolCallingOptionsRowApi {
    const mount = document.getElementById(MOUNT_ID);
    if (!mount) {
        throw new Error(`createToolCallingOptionsRow: missing #${MOUNT_ID}`);
    }

    const { enableInput, multiTurnInput, multiTurnRow, configBtn } =
        mountToolCallingOptionsRow(mount);

    let currentToolConfig: ToolConfig = cloneToolConfig(DEFAULT_TOOL_CONFIG);

    const isToolCallingEnabled = (): boolean => enableInput.checked;
    const isMultiTurnEnabled = (): boolean => multiTurnInput.checked;
    const getCurrentToolConfig = (): ToolConfig => currentToolConfig;

    const syncSubUi = (): void => {
        const on = isToolCallingEnabled();
        configBtn.hidden = !on;
        multiTurnRow.hidden = !on;
    };

    const restoreFromDraft = (draft: ToolCallingDraftRestore): void => {
        enableInput.checked = draft.toolCallingEnabled ?? false;
        lsWriteBool(options.enableToolCallingStorageKey, enableInput.checked);
        const multiTurn = draft.multiTurnEnabled ?? draft.multiTurnMockEnabled ?? true;
        multiTurnInput.checked = multiTurn;
        lsWriteBool(options.multiTurnStorageKey, multiTurnInput.checked);
        currentToolConfig = draft.toolConfig
            ? cloneToolConfig(draft.toolConfig)
            : cloneToolConfig(DEFAULT_TOOL_CONFIG);
        syncSubUi();
    };

    enableInput.checked = lsReadBool(options.enableToolCallingStorageKey, false);
    enableInput.addEventListener('change', () => {
        lsWriteBool(options.enableToolCallingStorageKey, enableInput.checked);
        syncSubUi();
        options.onStateChange();
    });

    multiTurnInput.checked = lsReadBool(options.multiTurnStorageKey, true);
    multiTurnInput.addEventListener('change', () => {
        lsWriteBool(options.multiTurnStorageKey, multiTurnInput.checked);
        options.onStateChange();
    });

    configBtn.addEventListener('click', () => {
        showToolConfigDialog(getCurrentToolConfig());
    });
    syncSubUi();

    return {
        isToolCallingEnabled,
        isMultiTurnEnabled,
        getCurrentToolConfig,
        restoreFromDraft,
        syncSubUi,
    };
}
