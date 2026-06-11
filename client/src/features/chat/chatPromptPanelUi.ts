/**
 * Chat / Gen Attribute 共用 prompt panel：header 内 enable 勾选始终可见，
 * 未勾选时隐藏操作栏与 textarea 区块（与 Teacher forcing 整块 hidden 不同）。
 */
export function syncChatPromptPanelEnableGatedBody(
    panel: HTMLElement | null,
    enabled: boolean,
): void {
    if (!panel) return;
    panel.querySelector<HTMLElement>('.text-action-buttons-top')?.toggleAttribute('hidden', !enabled);
    panel
        .querySelector<HTMLElement>('.textarea-wrapper.chat-prompt-textarea-block')
        ?.toggleAttribute('hidden', !enabled);
}
