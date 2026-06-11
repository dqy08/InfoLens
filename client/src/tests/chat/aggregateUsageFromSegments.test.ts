/**
 * 运行: cd client/src && npx tsx tests/chat/aggregateUsageFromSegments.test.ts
 */
import { aggregateUsageFromSegments } from '../../features/chat/chatCompletionUsage';
import type { ChatDisplaySegment } from '../../features/chat/chatSegments';
import type { OpenAICompletionsResponse } from '../../shared/api/completionsClient';

let passed = 0;
let failed = 0;

function assert(desc: string, cond: boolean) {
    if (cond) {
        console.log(`  ✓ ${desc}`);
        passed++;
    } else {
        console.error(`  ✗ ${desc}`);
        failed++;
    }
}

function out(usage: OpenAICompletionsResponse['usage']): ChatDisplaySegment {
    return {
        kind: 'output',
        text: 'x',
        promptUsed: 'p',
        modelName: 'm',
        response: { choices: [{ text: 'x', index: 0 }], usage } as OpenAICompletionsResponse,
    };
}

const ok = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };

assert('无 output → null', aggregateUsageFromSegments([]) === null);
assert('完整 → 累计', aggregateUsageFromSegments([out(ok)])?.total_tokens === 15);
assert(
    '多轮完整',
    aggregateUsageFromSegments([
        out({ prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 }),
        out({ prompt_tokens: 200, completion_tokens: 30, total_tokens: 230 }),
    ])?.total_tokens === 350
);
assert(
    '缺字段 → {}',
    Object.keys(aggregateUsageFromSegments([out(ok), out({ prompt_tokens: 1 })]) ?? { x: 1 }).length ===
        0
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
