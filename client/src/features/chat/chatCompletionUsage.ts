import type { OpenAICompletionsResponse } from '../../shared/api/completionsClient';
import type { ChatDisplaySegment } from './chatSegments';

type ApiTokenUsage = NonNullable<OpenAICompletionsResponse['usage']>;

/**
 * 累计各 output 段的 API usage。
 * - 无 output：null（不刷新指标）
 * - 任一段缺 usage 三字段：{}（展示层全 `-`）
 */
export function aggregateUsageFromSegments(
    segments: ChatDisplaySegment[]
): ApiTokenUsage | null {
    let prompt_tokens = 0;
    let completion_tokens = 0;
    let total_tokens = 0;
    let count = 0;

    for (const seg of segments) {
        if (seg.kind !== 'output') continue;
        const u = seg.response.usage;
        if (
            typeof u?.prompt_tokens !== 'number' ||
            typeof u?.completion_tokens !== 'number' ||
            typeof u?.total_tokens !== 'number'
        ) {
            return {};
        }
        prompt_tokens += u.prompt_tokens;
        completion_tokens += u.completion_tokens;
        total_tokens += u.total_tokens;
        count++;
    }

    return count > 0 ? { prompt_tokens, completion_tokens, total_tokens } : null;
}
