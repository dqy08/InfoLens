export type ParsedToolCall = {
    name: string;
    arguments: Record<string, unknown>;
};

export type ToolCallParseResult =
    | { status: 'absent' }
    | { status: 'parsed'; call: ParsedToolCall }
    | { status: 'malformed' };

/** 从续写文本中解析首个 Qwen 风格 `<tool_call>` 块。 */
export function parseToolCallFromCompletion(text: string): ToolCallParseResult {
    const match = text.match(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/);
    if (!match) return { status: 'absent' };
    let parsed: unknown;
    try {
        parsed = JSON.parse(match[1]!.trim());
    } catch {
        return { status: 'malformed' };
    }
    if (!parsed || typeof parsed !== 'object') return { status: 'malformed' };
    const name = (parsed as { name?: unknown }).name;
    if (typeof name !== 'string' || !name) return { status: 'malformed' };
    const args = (parsed as { arguments?: unknown }).arguments;
    const argumentsObj =
        args && typeof args === 'object' && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
    return { status: 'parsed', call: { name, arguments: argumentsObj } };
}
