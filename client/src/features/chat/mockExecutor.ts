import type { ToolConfig } from './toolConfig';

export function hasMockTool(config: ToolConfig, name: string): boolean {
    return config.mock_results[name] !== undefined;
}

/** 按 tool name 查 mock 表；未配置时抛错（不静默降级）。 */
export function executeMockTool(config: ToolConfig, name: string): string {
    const content = config.mock_results[name];
    if (content === undefined) {
        throw new Error(`No mock result for tool: ${name}`);
    }
    return content;
}
