/**
 * DAG 预处理：delete prompt 区间收集
 * 运行: cd client/src && npx tsx tests/prediction_attribution/genAttributeDagPreprocess.test.ts
 */
import { collectDeletePromptIntervals } from '../../shared/prediction_attribution/causal_flow/genAttributeDagPreprocess';

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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
