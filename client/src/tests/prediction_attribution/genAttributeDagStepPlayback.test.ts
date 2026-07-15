/**
 * DAG 步进回放（▶）事件队列
 * 运行: cd client/src && npx tsx tests/prediction_attribution/genAttributeDagStepPlayback.test.ts
 */
import {
    buildDagStepPlaybackAppearanceCosts,
    buildDagStepPlaybackEvents,
    buildOutputGenLegacyPrepMs,
    dagStepPlaybackAppearanceCostMs,
    outputGenLegacyPrepMs,
    resolveDagStepPlaybackStart,
    runDagStepPlaybackLoop,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagStepPlayback';
import type { TokenGenStep } from '../../shared/prediction_attribution/causal_flow/tokenGenAttributionRunner';
import { MOCK_TOOL_STEP_DELAY_MS } from '../../features/chat/toolCallingPendingUi';

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
        'outputGen → 0（准备由 outputGenPrep 承担）',
        dagStepPlaybackAppearanceCostMs(events[1]!, 1, events, clocks),
        0,
    );
    const noPrompt = buildDagStepPlaybackEvents([stubStep({ context: 'a' })], false);
    assertEq(
        '无 prompt 首 gen → 0',
        dagStepPlaybackAppearanceCostMs(noPrompt[0]!, 0, noPrompt, clocks),
        0,
    );
}

console.log('2b. outputGenLegacyPrepMs（未勾选 simulate 的固定时钟）');
{
    const events = buildDagStepPlaybackEvents([stubStep({ context: 'a' })], true);
    assertEq('prompt 后首 gen → 3×', outputGenLegacyPrepMs(0, events, clocks), 600);
    const noPrompt = buildDagStepPlaybackEvents([stubStep({ context: 'a' })], false);
    assertEq('无 prompt 首 gen → 0', outputGenLegacyPrepMs(0, noPrompt, clocks), 0);
    const twoGen = buildDagStepPlaybackEvents(
        [stubStep({ context: 'a' }), stubStep({ context: 'ab' })],
        true,
    );
    assertEq('续写 gen → 1×', outputGenLegacyPrepMs(1, twoGen, clocks), 200);
}

console.log('2c. input 后首拍落在第一个非 excluded gen');
{
    const steps = [
        stubStep({ context: 'a' }),
        stubStep({ context: 'ab' }),
        stubStep({ context: 'abc' }),
    ];
    const events = buildDagStepPlaybackEvents(steps, true);
    const legacy = buildOutputGenLegacyPrepMs(events, clocks, (i) => i < 2);
    assertEq('excluded gen0 → 0', legacy.get(0), 0);
    assertEq('excluded gen1 → 0', legacy.get(1), 0);
    assertEq('first non-excluded gen2 → genAfterInput', legacy.get(2), 600);
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
    assertEq(
        'simulate attention → 固定 1s',
        dagStepPlaybackAppearanceCostMs(
            toolEv!,
            events.indexOf(toolEv!),
            events,
            clocks,
            MOCK_TOOL_STEP_DELAY_MS,
        ),
        MOCK_TOOL_STEP_DELAY_MS,
    );
    const genAfterTool = events.find(
        (e): e is { kind: 'outputGen'; stepIndex: number } =>
            e.kind === 'outputGen' && e.stepIndex === 2,
    );
    assertEq(
        'response 后首 gen → 3×（legacy prep）',
        outputGenLegacyPrepMs(genAfterTool!.stepIndex, events, clocks),
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
    assertEq('暂停恢复跳过 prompt 事件', resume.eventIndex, 1);
}

console.log('5. excluded outputGen skips prep');
{
    const events = buildDagStepPlaybackEvents([stubStep({ context: 'a' }), stubStep({ context: 'ab' })], false);
    const shown: number[] = [];
    let timerCalls = 0;
    runDagStepPlaybackLoop({
        events,
        start: { eventIndex: 0, skipAppearanceCostForFirstEvent: false },
        clocks,
        isStale: () => false,
        setTimer: () => {
            timerCalls++;
        },
        setToolPendingVisible: () => {},
        showPrompt: () => {},
        showToolResponse: () => {},
        showOutputGen: (i) => shown.push(i),
        onOutputGenShown: () => {},
        onAllOutputGensShown: () => {},
        skipAppearanceCostForOutputGen: (i) => i === 1,
        outputGenPrep: {
            resolve: (stepIndex) => ({
                plan: null,
                prepMs: stepIndex === 0 ? 0 : 999,
            }),
        },
    });
    assertEq('excluded gen 仍展示、无 prep 等待', shown.join(','), '0,1');
    assertEq('no timer for excluded', timerCalls, 0);
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
        outputGenPrep: {
            resolve: () => ({ plan: null, prepMs: 0 }),
        },
    });
    assertEq('all excluded gens shown in one stack', shown.join(','), '0,1,2');
    assertEq('no setTimer for all-zero-cost run', timerCalls, 0);
}

console.log('7. outputGen prep delay vs animation share the same path');
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
        outputGenPrep: {
            resolve: (stepIndex) => ({
                plan: { kind: 'decode', round: { queryTokenId: 'q', scanIds: ['q'] } },
                prepMs: stepIndex === 2 ? 450 : 0,
            }),
        },
    });
    assertEq('prompt + excluded gens sync before wait', shown.slice(0, 3).join(','), '-1,0,1');
    assertEq('one prep timer before normal gen2', timerDelays.length, 1);
    assert('prep delay from resolve', Math.abs((timerDelays[0] ?? 0) - 450) < 5);
    assertEq('normal gen2 shown after prep', shown[3], 2);
}

console.log('8. playAnimation replaces timer when provided');
{
    const events = buildDagStepPlaybackEvents([stubStep({ context: 'a' })], false);
    const shown: number[] = [];
    let timerCalls = 0;
    let ffnComplete = false;
    runDagStepPlaybackLoop({
        events,
        start: { eventIndex: 0, skipAppearanceCostForFirstEvent: false },
        clocks,
        isStale: () => false,
        setTimer: () => {
            timerCalls++;
        },
        setToolPendingVisible: () => {},
        showPrompt: () => {},
        showToolResponse: () => {},
        showOutputGen: (i) => shown.push(i),
        onOutputGenShown: () => {},
        onAllOutputGensShown: () => {},
        outputGenPrep: {
            resolve: () => ({
                plan: { kind: 'decode', round: { queryTokenId: 'q', scanIds: ['q'] } },
                prepMs: 300,
            }),
            playAnimation: (_i, _plan, showGen, advance) => {
                showGen();
                ffnComplete = true;
                advance();
            },
        },
    });
    assertEq('no setTimer when animating', timerCalls, 0);
    assert('FFN complete shows gen', ffnComplete);
    assertEq('gen shown via animation path', shown.join(','), '0');
}

console.log('9. resume 首段 skip 开销（legacy prep）');
{
    const events = buildDagStepPlaybackEvents([stubStep({ context: 'a' })], false);
    const shown: number[] = [];
    let timerCalls = 0;
    runDagStepPlaybackLoop({
        events,
        start: { eventIndex: 0, skipAppearanceCostForFirstEvent: true },
        clocks,
        isStale: () => false,
        setTimer: () => {
            timerCalls++;
        },
        setToolPendingVisible: () => {},
        showPrompt: () => {},
        showToolResponse: () => {},
        showOutputGen: (i) => shown.push(i),
        onOutputGenShown: () => {},
        onAllOutputGensShown: () => {},
        outputGenPrep: {
            resolve: (stepIndex) => ({
                plan: null,
                prepMs: outputGenLegacyPrepMs(stepIndex, events, clocks),
            }),
        },
    });
    assertEq('resume 首 gen 立即展示', shown.join(','), '0');
    assertEq('resume 不触发 prep timer', timerCalls, 0);
}

console.log('10. toolResponse wait after attention animation (RAF gap) is not collapsed to 0');
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
    const gen1Idx = events.findIndex((e) => e.kind === 'outputGen' && e.stepIndex === 1);
    const plan = { kind: 'decode' as const, round: { queryTokenId: 'q', scanIds: ['q'] } };
    const originalNow = performance.now.bind(performance);
    let fakeNow = originalNow();
    performance.now = () => fakeNow;
    const timerDelays: number[] = [];
    try {
        runDagStepPlaybackLoop({
            events,
            start: { eventIndex: gen1Idx, skipAppearanceCostForFirstEvent: false },
            clocks,
            toolResponseAppearanceCostMs: MOCK_TOOL_STEP_DELAY_MS,
            isStale: () => false,
            setTimer: (_cb, delayMs) => {
                timerDelays.push(delayMs);
            },
            setToolPendingVisible: () => {},
            showPrompt: () => {},
            showToolResponse: () => {},
            showOutputGen: () => {},
            onOutputGenShown: () => {},
            onAllOutputGensShown: () => {},
            outputGenPrep: {
                resolve: () => ({ plan, prepMs: 0 }),
                playAnimation: (_i, _plan, showGen, advance) => {
                    fakeNow += 5000;
                    showGen();
                    advance();
                },
            },
        });
        assert(
            'tool pending delay ≈ 1s after RAF gap',
            timerDelays.length > 0 &&
                Math.abs(timerDelays[0]! - MOCK_TOOL_STEP_DELAY_MS) < 2,
        );
    } finally {
        performance.now = originalNow;
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
