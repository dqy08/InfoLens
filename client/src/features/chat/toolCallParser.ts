export type ParsedToolCall = {
    name: string;
    arguments: Record<string, unknown>;
};

export type ToolCallParseResult =
    | { status: 'absent' }
    | { status: 'parsed'; call: ParsedToolCall }
    | { status: 'malformed' };

/** 多轮 wire：本轮开始前 assistant 产出区在 wire 中的起始偏移。 */
export function assistantOutputOffsetForRound(
    round: number,
    firstPromptLength: number,
    wireLengthAtRoundStart: number,
): number {
    return round === 0 ? firstPromptLength : wireLengthAtRoundStart;
}

/** 从 wire 中解析本轮 assistant 产出里的首个 tool call（含首轮 teacher forcing）。 */
export function parseToolCallFromWireRound(
    wire: string,
    assistantOutputOffset: number,
): ToolCallParseResult {
    return parseToolCallFromCompletion(wire.slice(assistantOutputOffset));
}

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
