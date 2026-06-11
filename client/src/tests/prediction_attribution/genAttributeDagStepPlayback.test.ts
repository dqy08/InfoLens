/**
 * DAG 步进回放（▶）事件队列
 * 运行: cd client/src && npx tsx tests/prediction_attribution/genAttributeDagStepPlayback.test.ts
 */
import {
    buildDagStepPlaybackEvents,
    dagStepPlaybackDelayBeforeMs,
    resolveDagStepPlaybackStart,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagStepPlayback';
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
    assert(label, actual === expected);
}

function stubStep(overrides: Partial<TokenGenStep> & Pick<TokenGenStep, 'context'>): TokenGenStep {
    return {
        promptRegionEnd: 0,
        inputRanges: [[0, overrides.context.length]],
        response: {} as TokenGenStep['response'],
        token: 't',
        currentText: 't',
        ...overrides,
    };
}

const delays = { stepDelayMs: 200, waitUntilResponseMs: 600, waitAfterInputMs: 400 };

console.log('1. buildDagStepPlaybackEvents');
{
    const steps = [stubStep({ context: 'a' }), stubStep({ context: 'ab' })];
    const withPrompt = buildDagStepPlaybackEvents(steps, true);
    assertEq('含 prompt', withPrompt[0]?.kind, 'prompt');
    assertEq('两步 → 2 outputGen', withPrompt.filter((e) => e.kind === 'outputGen').length, 2);
}

console.log('2. dagStepPlaybackDelayBeforeMs');
{
    const events = buildDagStepPlaybackEvents([stubStep({ context: 'a' })], true);
    assertEq('prompt → 0', dagStepPlaybackDelayBeforeMs(events[0]!, 0, events, delays), 0);
    assertEq(
        'prompt 后首 gen → 2×',
        dagStepPlaybackDelayBeforeMs(events[1]!, 1, events, delays),
        400,
    );
    const noPrompt = buildDagStepPlaybackEvents([stubStep({ context: 'a' })], false);
    assertEq(
        '无 prompt 首 gen → 0',
        dagStepPlaybackDelayBeforeMs(noPrompt[0]!, 0, noPrompt, delays),
        0,
    );
}

console.log('3. tool 边界事件与 delay');
{
    const steps = [
        stubStep({ context: 'a', inputRanges: [[0, 1]] }),
        stubStep({ context: 'ab', inputRanges: [[0, 1]] }),
        stubStep({
            context: 'tool',
            inputRanges: [
                [0, 1],
                [2, 4],
            ],
        }),
    ];
    const events = buildDagStepPlaybackEvents(steps, false);
    const toolEv = events.find((e) => e.kind === 'toolResponse');
    assert('含 toolResponse', toolEv?.kind === 'toolResponse');
    assertEq(
        'toolResponse delay = 3×',
        dagStepPlaybackDelayBeforeMs(toolEv!, events.indexOf(toolEv!), events, delays),
        600,
    );
    const genAfterTool = events.find((e) => e.kind === 'outputGen' && e.stepIndex === 2);
    assertEq(
        'response 后首 gen → 2×',
        dagStepPlaybackDelayBeforeMs(genAfterTool!, events.indexOf(genAfterTool!), events, delays),
        400,
    );
}

console.log('4. resolveDagStepPlaybackStart');
{
    const steps = [stubStep({ context: 'a' })];
    const events = buildDagStepPlaybackEvents(steps, true);
    const fromStart = resolveDagStepPlaybackStart(events, steps, 0, true);
    assertEq('从头含 prompt', fromStart.eventIndex, 0);
    assert('从头不 skip delay', !fromStart.skipDelayForFirstEvent);
    const resume = resolveDagStepPlaybackStart(events, steps, 0, false);
    assert('中途 resume 首 gen skip delay', resume.skipDelayForFirstEvent);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
