/**
 * 与 Chat 页共用的「Raw prompt mode」开关（localStorage）。
 * 在 Generate & Attribute 与 Chat 之间切换时保持一致。
 */
export const LS_SKIP_CHAT_TEMPLATE = 'chat_skip_chat_template';

export function readSkipChatTemplateFromStorage(): boolean {
    try {
        return localStorage.getItem(LS_SKIP_CHAT_TEMPLATE) === 'true';
    } catch {
        return false;
    }
}

export function writeSkipChatTemplateToStorage(value: boolean): void {
    try {
        localStorage.setItem(LS_SKIP_CHAT_TEMPLATE, value ? 'true' : 'false');
    } catch {
        /* ignore quota / private mode */
    }
}
