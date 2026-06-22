/**
 * 运行: cd client/src && npx tsx tests/chat/toolCallParser.test.ts
 */
import {
    assistantOutputOffsetForRound,
    parseToolCallFromWireRound,
} from '../../features/chat/toolCallParser';

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

const TOOL_CALL =
    '<tool_call>\n{"name": "get_weather", "arguments": {"city": "北京"}}\n</tool_call>';

assert('round 0 offset = firstPrompt 长度', assistantOutputOffsetForRound(0, 120, 200) === 120);
assert('round > 0 offset = 本轮开始前 wire 长度', assistantOutputOffsetForRound(1, 120, 500) === 500);

const firstPrompt = '<|im_start|>assistant\n';
const teacherForcing = TOOL_CALL;
const wireRound0 = firstPrompt + teacherForcing;

const parsedFromTfOnly = parseToolCallFromWireRound(
    wireRound0,
    assistantOutputOffsetForRound(0, firstPrompt.length, wireRound0.length)
);
assert(
    '首轮 TF 含完整 tool call、无模型续写 → parsed',
    parsedFromTfOnly.status === 'parsed' && parsedFromTfOnly.call.name === 'get_weather'
);

const tfPrefix = '<tool_call>\n{"name": "get_weather", "arguments": {"city": "';
const modelSuffix = '北京"}}\n</tool_call>';
const wireSplit = firstPrompt + tfPrefix + modelSuffix;
const parsedSplit = parseToolCallFromWireRound(
    wireSplit,
    assistantOutputOffsetForRound(0, firstPrompt.length, firstPrompt.length + tfPrefix.length)
);
assert(
    'TF 与模型续写拼成完整 tool call → parsed',
    parsedSplit.status === 'parsed' && parsedSplit.call.name === 'get_weather'
);

const wireRound1 = wireSplit + '<|im_end|>\n<|im_start|>tool\n{}\n<|im_end|>\n<|im_start|>assistant\n';
const round1Output = TOOL_CALL;
const wireAfterRound1 = wireRound1 + round1Output;
const parsedRound1 = parseToolCallFromWireRound(
    wireAfterRound1,
    assistantOutputOffsetForRound(1, firstPrompt.length, wireRound1.length)
);
assert(
    '后续轮仅模型续写含 tool call → parsed',
    parsedRound1.status === 'parsed' && parsedRound1.call.name === 'get_weather'
);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
