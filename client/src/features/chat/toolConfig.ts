/** Tool config：tools schema + mock 返回值，作为整体由运行时持有。 */

export type ToolConfig = {
    tools_schema: Record<string, unknown>[];
    mock_results: Record<string, string>;
};

export const DEFAULT_TOOL_CONFIG: ToolConfig = {
    tools_schema: [
        {
            function: {
                name: 'get_current_temperature',
                parameters: {
                    type: 'object',
                    properties: {
                        location: {
                            type: 'string',
                        },
                    },
                },
            },
        },
    ],
    mock_results: {
        get_current_temperature: JSON.stringify({ temperature: 22, unit: 'celsius' }),
    },
};

export function cloneToolConfig(config: ToolConfig): ToolConfig {
    return {
        tools_schema: JSON.parse(JSON.stringify(config.tools_schema)) as Record<string, unknown>[],
        mock_results: { ...config.mock_results },
    };
}

/** fingerprint 用：稳定序列化 tool config 全文。 */
export function toolConfigFingerprint(config: ToolConfig): string {
    return JSON.stringify(cloneToolConfig(config));
}
