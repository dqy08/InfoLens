import type { CompletionsChatMessage } from '../../shared/api/completionsClient';

export type ChatMessage = CompletionsChatMessage;

export function buildInitialChatMessages(options: {
    user: string;
    system?: string;
    useSystem: boolean;
}): ChatMessage[] {
    const messages: ChatMessage[] = [];
    if (options.useSystem) {
        messages.push({ role: 'system', content: options.system ?? '' });
    }
    messages.push({ role: 'user', content: options.user });
    return messages;
}
