/**
 * 传播链播放计划 / 节奏单元测试
 * 运行: cd client/src && npm run test:dagPropagationPlayback
 */
import {
    batchPlaybackDelayMs,
    computePropagationGroupPacings,
    DAG_PLAYBACK_WAIT_AFTER_INPUT_CLOCKS,
    DAG_PLAYBACK_WAIT_UNTIL_RESPONSE_CLOCKS,
    FORWARD_PROMPT_FRAME_DWELL_MS,
    propagationRunningMaxLookaheadForGroupCount,
    resolveDagStepPlaybackDelays,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagPropagationPlaybackPacing';
import { buildMaxNormalizedRenderStrengthByKey } from '../../shared/prediction_attribution/causal_flow/genAttributeDagEdgeRenderStrength';
import {
    backwardSlideIncomingEdgeKeysForBatch,
    buildPropagationPlaybackPlan,
    createDagRecursiveEdgeAnimationController,
    maxShareInEdgeKeySet,
    tgtIdFromEdgeKey,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagRecursiveEdgeAnimation';

/** 与重构前独立的 `buildMaxNormalizedRenderStrengthForEdgeKeySet` 同公式，用于回归对照。 */
function legacySubsetMaxNormalizedRender(
    sharesByKey: Map<string, number>,
    edgeKeys: ReadonlySet<string>,
    maxOpacity = 1,
): Map<string, number> {
    let maxShare = 0;
    for (const key of edgeKeys) {
        const share = sharesByKey.get(key);
        if (share != null && share > maxShare) maxShare = share;
    }
    const byKey = new Map<string, number>();
    for (const key of edgeKeys) {
        const share = sharesByKey.get(key);
        if (share != null) {
            byKey.set(
                key,
                buildMaxNormalizedRenderStrengthByKey(
                    new Map([[key, share]]),
                    maxOpacity,
                    maxShare,
                ).get(key)!,
            );
        }
    }
    return byKey;
}

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

function assertEq<T>(desc: string, actual: T, expected: T) {
    assert(desc, actual === expected);
}

function assertClose(desc: string, actual: number, expected: number, eps = 1e-9) {
    assert(desc, Math.abs(actual - expected) <= eps);
}

// ── lookahead ───────────────────────────────────────────────────────────────
console.log('1. propagationRunningMaxLookaheadForGroupCount');
assertEq('0 组 → 0', propagationRunningMaxLookaheadForGroupCount(0), 0);
assertEq('1 组 → MIN(2)', propagationRunningMaxLookaheadForGroupCount(1), 2);
assertEq('10 组 → max(2, round(1))', propagationRunningMaxLookaheadForGroupCount(10), 2);
assertEq('30 组 → 3', propagationRunningMaxLookaheadForGroupCount(30), 3);

// ── computePropagationGroupPacings ──────────────────────────────────────────
console.log('2. computePropagationGroupPacings');
{
    const focusId = 'f';
    const nodeShare = new Map([
        ['f', 1],
        ['a', 0.4],
        ['b', 0.2],
        ['c', 0.1],
    ]);
    const groups = [
        { tgtIds: ['a'] },
        { tgtIds: ['b'] },
        { tgtIds: ['c'] },
    ];
    const { groupPreps, weightMax, weightTotal, runningMaxLookahead } = computePropagationGroupPacings(
        groups,
        nodeShare,
        focusId,
    );
    assertClose('weightMax = 非焦点组内 max', weightMax, 0.4);
    assertEq('3 组 lookahead', runningMaxLookahead, 2);
    assert('每组有 propagationWeight', groupPreps.length === 3);
    assert('weightTotal > 0', weightTotal > 0);
    assertClose('首组 shareNorm = 1', groupPreps[0]!.shareNorm ?? -1, 1);
    assert('running max 非降', groupPreps[1]!.runningMaxNorm >= groupPreps[0]!.runningMaxNorm);
    assert(
        'propagationWeight ∈ [0,1]',
        groupPreps.every((p) => p.propagationWeight >= 0 && p.propagationWeight <= 1),
    );
}

{
    const { groupPreps, weightTotal } = computePropagationGroupPacings(
        [{ tgtIds: ['f', 'x'] }, { tgtIds: ['y'] }],
        new Map([
            ['f', 1],
            ['x', 0.5],
            ['y', 0.25],
        ]),
        'f',
    );
    assert('含焦点组无 shareNorm', groupPreps[0]!.shareNorm === undefined);
    assert('weightTotal 可累加', weightTotal >= 0);
}

// ── batchPlaybackDelayMs ────────────────────────────────────────────────────
console.log('3. batchPlaybackDelayMs');
const batch = { propagationWeight: 0.25 };
const plan = { weightTotal: 1 };

assertEq(
    'step：0 权重 → 0ms',
    batchPlaybackDelayMs({ propagationWeight: 0 }, plan, { mode: 'step', stepMs: 500, totalS: 7 }),
    0,
);
assertEq(
    'step：权重连续',
    batchPlaybackDelayMs(batch, plan, { mode: 'step', stepMs: 400, totalS: 7 }),
    100,
);

const totalPacing = { mode: 'total' as const, stepMs: 500, totalS: 7 };
const weightedBudgetMs = 7 * 1000 - FORWARD_PROMPT_FRAME_DWELL_MS;
assertEq(
    'total：按权重占比，预算已扣固定帧',
    batchPlaybackDelayMs(batch, plan, totalPacing),
    Math.round(0.25 * weightedBudgetMs),
);

assertEq(
    'total：权重 0 → 0ms',
    batchPlaybackDelayMs({ propagationWeight: 0 }, plan, totalPacing),
    0,
);

// ── resolveDagStepPlaybackDelays ────────────────────────────────────────────
console.log('3b. resolveDagStepPlaybackDelays');
{
    const step = resolveDagStepPlaybackDelays(10, 1, { mode: 'step', stepMs: 200, totalS: 7 });
    assertEq('step：gen 间隔', step.stepDelayMs, 200);
    assertEq(
        'step：等 response = 3× step',
        step.waitUntilResponseMs,
        200 * DAG_PLAYBACK_WAIT_UNTIL_RESPONSE_CLOCKS,
    );
    assertEq(
        'step：input 后首 gen = 2× step',
        step.waitAfterInputMs,
        200 * DAG_PLAYBACK_WAIT_AFTER_INPUT_CLOCKS,
    );
    const total = resolveDagStepPlaybackDelays(10, 1, { mode: 'total', stepMs: 200, totalS: 7 });
    const weightTotal =
        10 + DAG_PLAYBACK_WAIT_UNTIL_RESPONSE_CLOCKS + DAG_PLAYBACK_WAIT_AFTER_INPUT_CLOCKS;
    assertEq('total：stepDelay 按权重分母', total.stepDelayMs, Math.round(7000 / weightTotal));
    assertEq(
        'total：等 response = 3× step',
        total.waitUntilResponseMs,
        total.stepDelayMs * DAG_PLAYBACK_WAIT_UNTIL_RESPONSE_CLOCKS,
    );
}

// ── buildPropagationPlaybackPlan ────────────────────────────────────────────
console.log('4. buildPropagationPlaybackPlan');
{
    const incoming = new Map<string, number>([
        ['p->a', 0.3],
        ['a->b', 0.2],
        ['b->f', 0.5],
    ]);
    const offsetOf = (id: string) => ({ p: 0, a: 1, b: 2, f: 3 })[id] ?? 0;
    const nodeShare = new Map([
        ['f', 1],
        ['b', 0.4],
        ['a', 0.3],
        ['p', 0.2],
    ]);
    const plan = buildPropagationPlaybackPlan(incoming, offsetOf, nodeShare, 'f');
    assert('非空计划', plan != null);
    if (plan != null) {
        assertEq('批次数 = offset 组数', plan.batches.length, 3);
        assert('播放序 offset 降序', plan.batches[0]!.groupOffset > plan.batches[1]!.groupOffset);
        assertEq(
            'backward batch0 = 焦点侧单组（b->f）',
            plan.backwardFrontierByBatchIndex[0]?.has('b->f') ?? false,
            true,
        );
        assert(
            'forward batch0 前沿 = 全链',
            plan.forwardFrontierByBatchIndex[0]?.size === 3,
        );
        const last = plan.batches.length - 1;
        assertEq(
            'backward 末批前沿 = 全链',
            plan.backwardFrontierByBatchIndex[last]?.size ?? 0,
            3,
        );
        for (const b of plan.batches) {
            for (const key of b.edgeKeys) {
                assertEq('edgeKey 可解析 tgt', tgtIdFromEdgeKey(key) != null, true);
            }
        }
        const textOrder = [...plan.batches].sort((a, b) => a.groupOffset - b.groupOffset);
        assertClose('文序首组 offset 最小', textOrder[0]!.groupOffset, 1);
    }
}

assertEq('空入边 → null', buildPropagationPlaybackPlan(new Map(), () => 0, new Map(), 'f'), null);

// ── buildMaxNormalizedRenderStrengthByKey（重构前后等价 + 蓝/红分母）────────
console.log('5. buildMaxNormalizedRenderStrengthByKey');
{
    const shares = new Map<string, number>([
        ['p->a', 0.3],
        ['a->b', 0.2],
        ['b->f', 0.5],
        ['x->y', 0.9],
    ]);
    const slideKeys = new Set(['a->b', 'p->a']);
    const merged = buildMaxNormalizedRenderStrengthByKey(shares, 0.75, undefined, slideKeys);
    const legacy = legacySubsetMaxNormalizedRender(shares, slideKeys, 0.75);
    assert('onlyKeys 与重构前子集归一一致', merged.size === legacy.size);
    for (const key of slideKeys) {
        assertClose(`onlyKeys[${key}]`, merged.get(key) ?? -1, legacy.get(key) ?? -2);
    }
    assert('onlyKeys 不输出集合外键', !merged.has('b->f'));

    const frontierMax = 0.5;
    const blue = buildMaxNormalizedRenderStrengthByKey(shares, 0.8, frontierMax);
    const red = buildMaxNormalizedRenderStrengthByKey(shares, 0.8, undefined, new Set(['a->b']));
    assertClose('蓝入边用前沿 max', blue.get('a->b') ?? 0, 0.8 * (0.2 / 0.5));
    assertClose('红入边用集合内 max', red.get('a->b') ?? 0, 0.8);
    assert('红边强于同键蓝边（分母更小）', (red.get('a->b') ?? 0) > (blue.get('a->b') ?? 0));
}

// ── backwardSlideIncomingEdgeKeysForBatch + 播放计划前沿 ───────────────────
console.log('6. backwardSlideIncomingEdgeKeysForBatch');
{
    const incoming = new Map<string, number>([
        ['p->a', 0.3],
        ['a->b', 0.2],
        ['b->f', 0.5],
    ]);
    const offsetOf = (id: string) => ({ p: 0, a: 1, b: 2, f: 3 })[id] ?? 0;
    const nodeShare = new Map([
        ['f', 1],
        ['b', 0.4],
        ['a', 0.3],
        ['p', 0.2],
    ]);
    const plan = buildPropagationPlaybackPlan(incoming, offsetOf, nodeShare, 'f');
    assert('计划非空', plan != null);
    if (plan != null) {
        const batch0Keys = backwardSlideIncomingEdgeKeysForBatch(plan, 0, 'f');
        assertEq('batch0 仅焦点入边', batch0Keys.size, 1);
        assert('batch0 含 b->f', batch0Keys.has('b->f'));

        const batch1 = plan.batches[1]!;
        const batch1Keys = backwardSlideIncomingEdgeKeysForBatch(plan, 1, 'f');
        assert('batch1 含指向 slide(b) 的 a->b', batch1Keys.has('a->b'));
        for (const key of batch1Keys) {
            assertEq('batch1 键的 tgt = slide', tgtIdFromEdgeKey(key), batch1.tgtId);
        }

        const frontier = plan.backwardFrontierByBatchIndex[1]!;
        const frontierMax = maxShareInEdgeKeySet(incoming, frontier);
        const mi = 0.6;
        const redMap = buildMaxNormalizedRenderStrengthByKey(incoming, mi, undefined, batch1Keys);
        const blueMap = buildMaxNormalizedRenderStrengthByKey(incoming, mi, frontierMax);
        for (const key of batch1Keys) {
            assert('红图仅含 slide 入边', redMap.has(key));
            assertClose(`红[${key}] 集合内 max`, redMap.get(key) ?? 0, mi);
            assert(
                `红[${key}] ≥ 蓝（前沿 max 归一）`,
                (redMap.get(key) ?? 0) >= (blueMap.get(key) ?? 0) - 1e-9,
            );
        }
    }
}

// ── propagation playback controller pause / resume ───────────────────────────
console.log('6. createDagRecursiveEdgeAnimationController pause/resume');
{
    const focusId = 'f';
    const incoming = new Map<string, number>([
        ['p->a', 0.3],
        ['a->b', 0.2],
        ['b->f', 0.5],
    ]);
    const offsetOf = (id: string) => ({ p: 0, a: 1, b: 2, f: 3 })[id] ?? 0;
    const nodeShare = new Map([
        ['f', 1],
        ['b', 0.4],
        ['a', 0.3],
        ['p', 0.2],
    ]);
    const focusState = {
        activeNodeIds: new Set(['p', 'a', 'b', focusId]),
        incomingEdgeShareByKey: incoming,
        downstreamEdgeStrengthByKey: new Map<string, number>(),
        nodeShareById: nodeShare,
    };
    const ctx = {
        nodesSortedByStepDesc: [
            { id: 'f', step: 3 },
            { id: 'b', step: 2 },
            { id: 'a', step: 1 },
            { id: 'p', step: -1 },
        ],
        incomingLinksByTarget: new Map<string, readonly unknown[]>(),
    };
    let tickCount = 0;
    const ctrl = createDagRecursiveEdgeAnimationController({
        onTick: () => {
            tickCount++;
        },
        computeFocusState: () => focusState,
        computeSteadyStateStayShareById: (m) => new Map(m),
        isRecursiveAttributionEnabled: () => true,
        hasNode: () => true,
        offsetOf,
        tokenLabelOf: (id) => id,
        direction: 'backward',
        getReplayPacing: () => ({ mode: 'step', stepMs: 60_000, totalS: 7 }),
    });
    assert('canStartPlayback', ctrl.canStartPlayback(focusId, ctx));
    ctrl.startPlayback(focusId, ctx);
    assertEq('start → playing', ctrl.getPlaybackPhase(), 'playing');
    assert('onTick after start', tickCount >= 1);
    const ticksAfterStart = tickCount;
    ctrl.pausePlayback();
    assertEq('pause → paused', ctrl.getPlaybackPhase(), 'paused');
    assertEq('pause clears active timer', ctrl.isPlaybackActive(), false);
    ctrl.resumePlayback();
    assertEq('resume → playing', ctrl.getPlaybackPhase(), 'playing');
    assert('resume re-ticks frame', tickCount > ticksAfterStart);
    ctrl.stopPlayback();
    assertEq('stop → idle', ctrl.getPlaybackPhase(), 'idle');
    assertEq('stop clears animation focus', ctrl.getUserAnimationFocusId(), null);
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
