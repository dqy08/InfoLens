/**
 * DAG 预处理：delete prompt 区间收集
 * 运行: cd client/src && npx tsx tests/prediction_attribution/genAttributeDagPreprocess.test.ts
 */
import {
    collectDeletePromptIntervals,
    dagExcludeIntervalContextForReplay,
    dedupePromptTokenSpansByOffset,
    isDagGenStepTargetExcluded,
    normalizePromptTokenSpans,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagPreprocess';
import type { TokenGenStep } from '../../shared/prediction_attribution/causal_flow/tokenGenAttributionRunner';

let passed = 0;
let failed = 0;

function assert(label: string, cond: boolean): void {
    if (cond) {
        passed++;
        console.log(`  ✓ ${label}`);
    } else {
        failed++;
        console.log(`  ✗ ${label}`);
    }
}

function assertEq<T>(label: string, actual: T, expected: T): void {
    assert(label, JSON.stringify(actual) === JSON.stringify(expected));
}

const wire = 'PROMPT_END|TOOL_RESPONSE';
const inputRanges: [number, number][] = [
    [0, 11],
    [11, wire.length],
];

console.log('dedupePromptTokenSpansByOffset');

assertEq('empty → []', dedupePromptTokenSpansByOffset([]), []);

assertEq(
    'same offset keeps first',
    dedupePromptTokenSpansByOffset([
        { offset: [299, 300], raw: '做', token_id: 223 },
        { offset: [299, 300], raw: '做', token_id: 248 },
        { offset: [300, 302], raw: '匹配' },
    ]),
    [
        { offset: [299, 300], raw: '做', token_id: 223 },
        { offset: [300, 302], raw: '匹配' },
    ],
);

console.log('normalizePromptTokenSpans');

assertEq('empty → []', normalizePromptTokenSpans([]), []);

assertEq(
    'overlapping spans keep first (longer at same start)',
    normalizePromptTokenSpans([
        { offset: [298, 300], raw: ' 做' },
        { offset: [299, 300], raw: '做', token_id: 223 },
        { offset: [299, 300], raw: '做', token_id: 248 },
        { offset: [300, 302], raw: '匹配' },
    ]),
    [
        { offset: [298, 300], raw: ' 做' },
        { offset: [300, 302], raw: '匹配' },
    ],
);

assertEq(
    'adjacent non-overlapping spans kept',
    normalizePromptTokenSpans([
        { offset: [0, 1], raw: 'a' },
        { offset: [1, 2], raw: 'b' },
    ]),
    [
        { offset: [0, 1], raw: 'a' },
        { offset: [1, 2], raw: 'b' },
    ],
);

console.log('collectDeletePromptIntervals');

assertEq('empty inputRanges → []', collectDeletePromptIntervals(wire, [], 'TOOL'), []);

assertEq(
    'match only in inputRanges[0]',
    collectDeletePromptIntervals(wire, inputRanges, 'PROMPT'),
    [[0, 6]],
);

assertEq(
    'match in later input range',
    collectDeletePromptIntervals(wire, inputRanges, 'TOOL'),
    [[11, 15]],
);

assertEq('empty pattern → []', collectDeletePromptIntervals(wire, inputRanges, ''), []);

console.log('dagExcludeIntervalContextForReplay');

assertEq('empty steps → empty string', dagExcludeIntervalContextForReplay([]), '');

const stepStub = (context: string, token: string): TokenGenStep =>
    ({ context, token }) as TokenGenStep;

assertEq(
    'uses last step context + token',
    dagExcludeIntervalContextForReplay([
        stepStub('ab', 'c'),
        stepStub('abc', 'd'),
    ]),
    'abcd',
);

console.log('isDagGenStepTargetExcluded');

const genStep = (context: string, token: string): Pick<TokenGenStep, 'context' | 'token' | 'inputRanges'> => ({
    context,
    token,
    inputRanges: [[0, context.length]],
});

assert(
    'generated exclude on target token',
    isDagGenStepTargetExcluded(genStep('Hi ', 'there'), 'Hi there', '', 'there'),
);
assert(
    'not excluded when pattern misses',
    !isDagGenStepTargetExcluded(genStep('Hi ', 'there'), 'Hi there', '', 'zzz'),
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
