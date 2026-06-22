/**
 * DAG 步进回放（▶）事件队列
 * 运行: cd client/src && npx tsx tests/prediction_attribution/genAttributeDagStepPlayback.test.ts
 */
import {
    buildDagStepPlaybackAppearanceCosts,
    buildDagStepPlaybackEvents,
    dagStepPlaybackAppearanceCostMs,
    resolveDagStepPlaybackStart,
    runDagStepPlaybackLoop,
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

const clocks = { outputGenClockMs: 200, toolResponseClockMs: 600, genAfterInputClockMs: 600 };

console.log('1. buildDagStepPlaybackEvents');
{
    const steps = [stubStep({ context: 'a' }), stubStep({ context: 'ab' })];
    const withPrompt = buildDagStepPlaybackEvents(steps, true);
    assertEq('含 prompt', withPrompt[0]?.kind, 'prompt');
    assertEq('两步 → 2 outputGen', withPrompt.filter((e) => e.kind === 'outputGen').length, 2);
}

console.log('2. dagStepPlaybackAppearanceCostMs');
{
    const events = buildDagStepPlaybackEvents([stubStep({ context: 'a' })], true);
    assertEq('prompt → 0', dagStepPlaybackAppearanceCostMs(events[0]!, 0, events, clocks), 0);
    assertEq(
        'prompt 后首 gen → 3×',
        dagStepPlaybackAppearanceCostMs(events[1]!, 1, events, clocks),
        600,
    );
    const noPrompt = buildDagStepPlaybackEvents([stubStep({ context: 'a' })], false);
    assertEq(
        '无 prompt 首 gen → 0',
        dagStepPlaybackAppearanceCostMs(noPrompt[0]!, 0, noPrompt, clocks),
        0,
    );
}

console.log('3. tool 边界事件与开销');
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
        'toolResponse 开销 = 3×',
        dagStepPlaybackAppearanceCostMs(toolEv!, events.indexOf(toolEv!), events, clocks),
        600,
    );
    const genAfterTool = events.find((e) => e.kind === 'outputGen' && e.stepIndex === 2);
    assertEq(
        'response 后首 gen → 3×',
        dagStepPlaybackAppearanceCostMs(genAfterTool!, events.indexOf(genAfterTool!), events, clocks),
        600,
    );
}

console.log('4. resolveDagStepPlaybackStart');
{
    const steps = [stubStep({ context: 'a' })];
    const events = buildDagStepPlaybackEvents(steps, true);
    const fromStart = resolveDagStepPlaybackStart(events, steps, 0, true);
    assertEq('从头含 prompt', fromStart.eventIndex, 0);
    assert('从头不 skip 开销', !fromStart.skipAppearanceCostForFirstEvent);
    const resume = resolveDagStepPlaybackStart(events, steps, 0, false);
    assert('中途 resume 首 gen skip 开销', resume.skipAppearanceCostForFirstEvent);
}

console.log('5. excluded outputGen skips appearance cost');
{
    const events = buildDagStepPlaybackEvents([stubStep({ context: 'a' }), stubStep({ context: 'ab' })], false);
    const gen1 = events[1]!;
    assertEq(
        'excluded stepIndex 1 → 0ms',
        dagStepPlaybackAppearanceCostMs(gen1, 1, events, clocks, (i) => i === 1),
        0,
    );
    assertEq(
        'non-excluded stepIndex 1 → normal',
        dagStepPlaybackAppearanceCostMs(gen1, 1, events, clocks, (i) => i === 0),
        200,
    );
}

console.log('5b. input 后首拍落在第一个非 excluded gen');
{
    const steps = [
        stubStep({ context: 'a' }),
        stubStep({ context: 'ab' }),
        stubStep({ context: 'abc' }),
    ];
    const events = buildDagStepPlaybackEvents(steps, true);
    const skip = (i: number) => i < 2;
    const costs = buildDagStepPlaybackAppearanceCosts(events, clocks, skip);
    assertEq('prompt → 0', costs[0], 0);
    assertEq('excluded gen0 → 0', costs[1], 0);
    assertEq('excluded gen1 → 0', costs[2], 0);
    assertEq('first non-excluded gen2 → genAfterInput', costs[3], 600);
}

console.log('5c. prompt → excluded → normal → normal');
{
    const steps = [
        stubStep({ context: 'a' }),
        stubStep({ context: 'ab' }),
        stubStep({ context: 'abc' }),
    ];
    const events = buildDagStepPlaybackEvents(steps, true);
    const costs = buildDagStepPlaybackAppearanceCosts(events, clocks, (i) => i === 0);
    assertEq('excluded gen0 → 0', costs[1], 0);
    assertEq('gen1 gets input beat', costs[2], 600);
    assertEq('gen2 gen gap', costs[3], 200);
}

console.log('6. zero-cost events run synchronously without setTimer');
{
    const steps = [
        stubStep({ context: 'a' }),
        stubStep({ context: 'ab' }),
        stubStep({ context: 'abc' }),
    ];
    const events = buildDagStepPlaybackEvents(steps, false);
    const shown: number[] = [];
    let timerCalls = 0;
    runDagStepPlaybackLoop({
        events,
        start: { eventIndex: 0, skipAppearanceCostForFirstEvent: false },
        clocks,
        isStale: () => false,
        setTimer: (cb) => {
            timerCalls++;
            cb();
        },
        setToolPendingVisible: () => {},
        showPrompt: () => {},
        showToolResponse: () => {},
        showOutputGen: (i) => shown.push(i),
        onOutputGenShown: () => {},
        onAllOutputGensShown: () => {},
        skipAppearanceCostForOutputGen: () => true,
    });
    assertEq('all excluded gens shown in one stack', shown.join(','), '0,1,2');
    assertEq('no setTimer for all-zero-cost run', timerCalls, 0);
}

console.log('7. prompt + excluded burst then timer before first normal gen');
{
    const steps = [
        stubStep({ context: 'a' }),
        stubStep({ context: 'ab' }),
        stubStep({ context: 'abc' }),
    ];
    const events = buildDagStepPlaybackEvents(steps, true);
    const shown: number[] = [];
    const timerDelays: number[] = [];
    runDagStepPlaybackLoop({
        events,
        start: { eventIndex: 0, skipAppearanceCostForFirstEvent: false },
        clocks,
        isStale: () => false,
        setTimer: (cb, delayMs) => {
            timerDelays.push(delayMs);
            cb();
        },
        setToolPendingVisible: () => {},
        showPrompt: () => shown.push(-1),
        showToolResponse: () => {},
        showOutputGen: (i) => shown.push(i),
        onOutputGenShown: () => {},
        onAllOutputGensShown: () => {},
        skipAppearanceCostForOutputGen: (i) => i < 2,
    });
    assertEq('prompt + excluded gens sync before wait', shown.slice(0, 3).join(','), '-1,0,1');
    assertEq('one timer before normal gen2', timerDelays.length, 1);
    assert('timer delay is genAfterInput not gen gap', (timerDelays[0] ?? 0) > 200);
    assertEq('normal gen2 shown after timer', shown[3], 2);
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
