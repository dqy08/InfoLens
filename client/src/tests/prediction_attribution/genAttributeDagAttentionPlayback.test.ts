/**
 * Attention 模拟播放计划与预算
 * 运行: cd client/src && npx tsx tests/prediction_attribution/genAttributeDagAttentionPlayback.test.ts
 */
import {
    attentionPlanTotalMs,
    attentionRoundMs,
    attendBeatCount,
    buildAttentionRound,
    buildDecodeRound,
    buildPrefillRounds,
    computeAttentionBudgetBreakdown,
    contextIdsBeforeOutputGen,
    diffNewInputRanges,
    planForOutputGenEvent,
    randomPrefillLitIds,
    resolveApproxAttendMsFromOutputGenClock,
    scanIdsForQueryInContext,
    uncachedIdsBeforeOutputGen,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagAttentionPlayback';
import { attendLitIdsForBand, attendLitIdsAccumulative } from '../../shared/prediction_attribution/causal_flow/runAttentionPlayback';
import { buildDagStepPlaybackEvents } from '../../shared/prediction_attribution/causal_flow/genAttributeDagStepPlayback';
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

const cfg = { attendMs: 10, ffnRatio: 2, attendBurst: 1 };
const emptyCtx = {
    excludeIntervalContext: '',
    excludePromptPatternsText: '',
    excludeGeneratedPatternsText: '',
    deletePromptPatternsText: '',
};

console.log('1. buildPrefillRounds');
{
    const context = ['0_1', '1_2', '2_3'];
    const rounds = buildPrefillRounds(['0_1', '1_2'], context);
    assertEq('2 rounds', rounds.length, 2);
    assertEq('round 1 query', rounds[1]!.queryTokenId, '1_2');
    assertEq('round 1 scan grows with query', rounds[1]!.scanIds.length, 2);
    assertEq('round 1 scan prefix', rounds[1]!.scanIds.join(','), '0_1,1_2');
}

console.log('1b. scanIdsForQueryInContext');
{
    const context = ['0_1', '1_2', '2_3'];
    assertEq('prefix to query', scanIdsForQueryInContext(context, '1_2').join(','), '0_1,1_2');
}

console.log('2. buildDecodeRound');
{
    const round = buildDecodeRound(['0_1', '1_2', '2_3']);
    assertEq('scan len', round?.scanIds.length, 3);
    assertEq('query last', round?.queryTokenId, '2_3');
    assertEq('scan full', round?.scanIds.join(','), '0_1,1_2,2_3');
}

console.log('3. randomPrefillLitIds');
{
    const scan = ['a', 'b', 'c'];
    assertEq('short prefix all', randomPrefillLitIds(scan, 10).sort().join(','), 'a,b,c');
    const lit = randomPrefillLitIds(scan, 2, () => 0);
    assertEq('with replacement', lit.length, 2);
    assertEq('from prefix', lit.every((id) => scan.includes(id)), true);
}

console.log('4. attentionPlanTotalMs random prefill');
{
    const plan = {
        kind: 'prefill' as const,
        rounds: [
            { queryTokenId: 'a', scanIds: ['a', 'b'] },
            { queryTokenId: 'b', scanIds: ['a', 'b'] },
            { queryTokenId: 'c', scanIds: ['a', 'b', 'c'] },
        ],
    };
    const plainMs = attentionPlanTotalMs(plan, { ...cfg, prefillStyle: 'plain' }, { includeLeadDwell0: true });
    const randomMs = attentionPlanTotalMs(plan, { ...cfg, prefillStyle: 'random', queryBurst: 1 }, { includeLeadDwell0: true });
    assertEq('plain not shorter than random', plainMs >= randomMs, true);
    assertEq(
        'random dwell0(ffn) + 2*attend + dwell + gen',
        randomMs,
        2 * 10 + 2 * 10 + 2 * 10 + 70,
    );
    const batchedMs = attentionPlanTotalMs(plan, { ...cfg, prefillStyle: 'random', queryBurst: 3 }, { includeLeadDwell0: true });
    assertEq('random queryBurst 3 one frame', batchedMs, 2 * 10 + 10 + 2 * 10 + 70);
}

console.log('5. attentionRoundMs');
{
    const round = { queryTokenId: '2_3', scanIds: ['0_1', '1_2', '2_3'] };
    assertEq('gen: 3*10 + 2*2*10', attentionRoundMs(round, cfg, 'gen'), 70);
    assertEq('attendOnly: 3*10', attentionRoundMs(round, cfg, 'attendOnly'), 30);
}

console.log('4. computeAttentionBudgetBreakdown');
{
    const steps = [
        stubStep({ context: 'ab', inputRanges: [[0, 2]] }),
        stubStep({ context: 'abc', inputRanges: [[0, 2]] }),
    ];
    const events = buildDagStepPlaybackEvents(steps, true);
    const spans = [
        { offset: [0, 1] as [number, number], raw: 'a' },
        { offset: [1, 2] as [number, number], raw: 'b' },
    ];
    const b = computeAttentionBudgetBreakdown(steps, events, spans, emptyCtx, () => false, false);
    // gen0 prefill: 1+2 scan; gen1 decode: 3 (a,b,c)
    assertEq('scanCount', b.scanCount, 6);
    assertEq('roundCount', b.roundCount, 3);
}

console.log('5. planForOutputGenEvent first gen prefill');
{
    const steps = [stubStep({ context: 'hi', inputRanges: [[0, 2]] })];
    const spans = [
        { offset: [0, 1] as [number, number], raw: 'h' },
        { offset: [1, 2] as [number, number], raw: 'i' },
    ];
    const plan = planForOutputGenEvent(steps, 0, spans, emptyCtx, () => false, false);
    assertEq('prefill', plan?.kind, 'prefill');
    assertEq('2 rounds', plan?.kind === 'prefill' ? plan.rounds.length : 0, 2);
    assertEq(
        'round0 query h',
        plan?.kind === 'prefill' ? plan.rounds[0]!.queryTokenId : '',
        '0_1',
    );
    assertEq(
        'round0 scan prefix',
        plan?.kind === 'prefill' ? plan.rounds[0]!.scanIds.join(',') : '',
        '0_1',
    );
}

console.log('6. planForOutputGenEvent decode');
{
    const steps = [
        stubStep({ context: 'a', token: 'b', inputRanges: [[0, 1]] }),
        stubStep({ context: 'ab', token: 'c', inputRanges: [[0, 1]] }),
    ];
    const spans = [{ offset: [0, 1] as [number, number], raw: 'a' }];
    const plan = planForOutputGenEvent(steps, 1, spans, emptyCtx, () => false, false);
    assertEq('decode', plan?.kind, 'decode');
    assertEq('context len', plan?.kind === 'decode' ? plan.round.scanIds.length : 0, 2);
    assertEq(
        'query prev gen',
        plan?.kind === 'decode' ? plan.round.queryTokenId : '',
        '1_2',
    );
}

console.log('7. planForOutputGenEvent skip prefill');
{
    const steps = [stubStep({ context: 'hi', inputRanges: [[0, 2]] })];
    const spans = [
        { offset: [0, 1] as [number, number], raw: 'h' },
        { offset: [1, 2] as [number, number], raw: 'i' },
    ];
    const plan = planForOutputGenEvent(steps, 0, spans, emptyCtx, () => false, true);
    assertEq('decode', plan?.kind, 'decode');
    assertEq('scan full prompt', plan?.kind === 'decode' ? plan.round.scanIds.length : 0, 2);
    assertEq(
        'query last prompt',
        plan?.kind === 'decode' ? plan.round.queryTokenId : '',
        '1_2',
    );
}

console.log('8. uncached after tool');
{
    const steps = [
        stubStep({ context: 'a', token: 'x', inputRanges: [[0, 1]] }),
        stubStep({
            context: 'axtool',
            token: 'y',
            inputRanges: [
                [0, 1],
                [2, 6],
            ],
        }),
    ];
    const spans = [
        { offset: [0, 1] as [number, number], raw: 'a' },
        { offset: [2, 3] as [number, number], raw: 't' },
        { offset: [3, 4] as [number, number], raw: 'o' },
    ];
    const ids = uncachedIdsBeforeOutputGen(steps, 1, spans, emptyCtx, () => false);
    assertEq('call last + 2 response', ids.length, 3);
    assertEq('starts with call last', ids[0], '1_2');
}

console.log('9. planForOutputGenEvent tool prefill');
{
    const steps = [
        stubStep({ context: 'a', token: 'x', inputRanges: [[0, 1]] }),
        stubStep({
            context: 'axtool',
            token: 'y',
            inputRanges: [
                [0, 1],
                [2, 6],
            ],
        }),
    ];
    const spans = [
        { offset: [0, 1] as [number, number], raw: 'a' },
        { offset: [2, 3] as [number, number], raw: 't' },
        { offset: [3, 4] as [number, number], raw: 'o' },
    ];
    const plan = planForOutputGenEvent(steps, 1, spans, emptyCtx, () => false, false);
    assertEq('prefill', plan?.kind, 'prefill');
    assertEq('3 rounds', plan?.kind === 'prefill' ? plan.rounds.length : 0, 3);
    assertEq(
        'round0 query call last',
        plan?.kind === 'prefill' ? plan.rounds[0]!.queryTokenId : '',
        '1_2',
    );
    assertEq(
        'round0 scan through call last',
        plan?.kind === 'prefill' ? plan.rounds[0]!.scanIds.length : 0,
        2,
    );
}

console.log('10. planForOutputGenEvent tool skip prefill');
{
    const steps = [
        stubStep({ context: 'a', token: 'x', inputRanges: [[0, 1]] }),
        stubStep({
            context: 'axtool',
            token: 'y',
            inputRanges: [
                [0, 1],
                [2, 6],
            ],
        }),
    ];
    const spans = [
        { offset: [0, 1] as [number, number], raw: 'a' },
        { offset: [2, 3] as [number, number], raw: 't' },
        { offset: [3, 4] as [number, number], raw: 'o' },
    ];
    const plan = planForOutputGenEvent(steps, 1, spans, emptyCtx, () => false, true);
    assertEq('decode', plan?.kind, 'decode');
    assertEq('scan through query in context', plan?.kind === 'decode' ? plan.round.scanIds.length : 0, 4);
    assertEq(
        'query last uncached',
        plan?.kind === 'decode' ? plan.round.queryTokenId : '',
        '3_4',
    );
    assertEq(
        'scan same as context',
        plan?.kind === 'decode' ? plan.round.scanIds[plan.round.scanIds.length - 1] : '',
        '3_4',
    );
}

console.log('11. contextIds after tool');
{
    const steps = [
        stubStep({ context: 'a', token: 'x', inputRanges: [[0, 1]] }),
        stubStep({
            context: 'axtool',
            token: 'y',
            inputRanges: [
                [0, 1],
                [2, 6],
            ],
        }),
    ];
    const spans = [
        { offset: [0, 1] as [number, number], raw: 'a' },
        { offset: [2, 3] as [number, number], raw: 't' },
        { offset: [3, 4] as [number, number], raw: 'o' },
    ];
    const ids = contextIdsBeforeOutputGen(steps, 1, spans, emptyCtx, () => false);
    assertEq('prompt + tool call + tool response', ids.length, 4);
    assertEq('query is last context', ids[ids.length - 1], '3_4');
}

console.log('12. delete prompt patterns omit ghost tokens from attention plan');
{
    const wire = 'SYSab';
    const steps = [stubStep({ context: wire, inputRanges: [[0, wire.length]] })];
    const spans = [
        { offset: [0, 1] as [number, number], raw: 'S' },
        { offset: [1, 2] as [number, number], raw: 'Y' },
        { offset: [2, 3] as [number, number], raw: 'S' },
        { offset: [3, 4] as [number, number], raw: 'a' },
        { offset: [4, 5] as [number, number], raw: 'b' },
    ];
    const ctxWithDelete = {
        ...emptyCtx,
        excludeIntervalContext: wire,
        deletePromptPatternsText: 'SYS',
    };
    const uncached = uncachedIdsBeforeOutputGen(steps, 0, spans, ctxWithDelete, () => false);
    assertEq('uncached only DAG-visible prompt', uncached.join(','), '3_4,4_5');
    const plan = planForOutputGenEvent(steps, 0, spans, ctxWithDelete, () => false, false);
    assertEq('prefill', plan?.kind, 'prefill');
    assertEq('2 rounds not 5', plan?.kind === 'prefill' ? plan.rounds.length : 0, 2);
    assertEq(
        'first query is first visible token',
        plan?.kind === 'prefill' ? plan.rounds[0]!.queryTokenId : '',
        '3_4',
    );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
