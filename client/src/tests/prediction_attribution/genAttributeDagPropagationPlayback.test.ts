/**
 * 传播链播放计划 / 节奏单元测试
 * 运行: cd client/src && npm run test:dagPropagationPlayback
 */
import {
    batchAppearanceCostMs,
    computePropagationGroupPacings,
    DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS,
    DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS,
    effectivePropagationWeightTotal,
    DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS,
    propagationRunningMaxLookaheadForGroupCount,
    propagationUniformWeightedFrameCount,
    resolveDagStepPlaybackClocks,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagPropagationPlaybackPacing';
import { buildMaxNormalizedRenderStrengthByKey } from '../../shared/prediction_attribution/causal_flow/genAttributeDagEdgeRenderStrength';
import {
    backwardSlideIncomingEdgeKeysForBatch,
    buildPropagationPlaybackPlan,
    createDagRecursiveEdgeAnimationController,
    lastNonFirstPromptRegionBatchIndex,
    markFirstPromptRegionGroupsInTextOrder,
    maxShareInEdgeKeySet,
    resolveRecursiveEdgeAnimationRenderOverlay,
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

{
    const focusId = 'f';
    const nodeShare = new Map([
        ['f', 1],
        ['p', 0.9],
        ['a', 0.3],
        ['b', 0.4],
    ]);
    const { groupPreps, weightMax } = computePropagationGroupPacings(
        [
            { tgtIds: ['p'], isFirstPromptRegion: true },
            { tgtIds: ['a'] },
            { tgtIds: ['b'] },
        ],
        nodeShare,
        focusId,
    );
    assertClose('weightMax 不含首个 prompt', weightMax, 0.4);
    assertClose('单个 prompt 区内归一 weight=1', groupPreps[0]!.propagationWeight, 1);
    assertEq('prompt 无 runningMaxNorm', groupPreps[0]!.runningMaxNorm, undefined);
    assertClose('gen 组 shareNorm 不受 prompt 稀释', groupPreps[1]!.shareNorm ?? -1, 0.75);
}

{
    const focusId = 'f';
    const nodeShare = new Map([
        ['f', 1],
        ['p0', 0.5],
        ['p1', 0.6],
        ['a', 0.3],
    ]);
    const { groupPreps, weightMax, promptRegionMax } = computePropagationGroupPacings(
        [
            { tgtIds: ['p0'], isFirstPromptRegion: true },
            { tgtIds: ['p1'], isFirstPromptRegion: true },
            { tgtIds: ['a'] },
        ],
        nodeShare,
        focusId,
    );
    assertClose('weightMax 不含 prompt 区', weightMax, 0.3);
    assertClose('promptRegionMax', promptRegionMax, 0.6);
    assertClose('prompt 区内归一 p0', groupPreps[0]!.propagationWeight, 0.5 / 0.6);
    assertClose('prompt 区内归一 p1', groupPreps[1]!.propagationWeight, 1);
    assertEq('prompt 批无 runningMaxNorm', groupPreps[0]!.runningMaxNorm, undefined);
    assertEq('prompt 批无 runningMaxNorm (2)', groupPreps[1]!.runningMaxNorm, undefined);
}

// ── markFirstPromptRegionGroupsInTextOrder ───────────────────────────────────
console.log('2b. markFirstPromptRegionGroupsInTextOrder');
{
    const isPrompt = (id: string) => id.startsWith('p');
    const groups = new Map([
        [0, { edgeKeys: [] as string[], nodeIds: new Set(['p0']) }],
        [1, { edgeKeys: [] as string[], nodeIds: new Set(['p1']) }],
        [2, { edgeKeys: ['p1->a'], nodeIds: new Set(['a']) }],
    ]);
    const flags = markFirstPromptRegionGroupsInTextOrder([0, 1, 2], (o) => groups.get(o)!, isPrompt);
    assertEq('首部连续 prompt 均标记', flags.join(','), 'true,true,false');
}

// ── batchAppearanceCostMs ────────────────────────────────────────────────────
console.log('3. batchAppearanceCostMs');
const batch = { propagationWeight: 0.25 };
const plan = { weightTotal: 1, chainWeightTotal: 1, batches: [{}, {}, {}] };

assertEq(
    'step：0 权重 → 0ms',
    batchAppearanceCostMs({ propagationWeight: 0 }, plan, { mode: 'step', stepMs: 500, totalS: 7 }),
    0,
);
assertEq(
    'step：权重连续',
    batchAppearanceCostMs(batch, plan, { mode: 'step', stepMs: 400, totalS: 7 }),
    100,
);

const totalPacing = { mode: 'total' as const, stepMs: 500, totalS: 7 };
const weightedBudgetMs = 7 * 1000 - DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS;
assertEq(
    'total：按权重占比，预算已扣固定帧',
    batchAppearanceCostMs(batch, plan, totalPacing),
    Math.round(0.25 * weightedBudgetMs),
);

assertEq(
    'total：权重 0 → 0ms',
    batchAppearanceCostMs({ propagationWeight: 0 }, plan, totalPacing),
    0,
);

{
    const mixedPlan = { weightTotal: 1.5, chainWeightTotal: 1, batches: [{}, {}, {}] };
    const chainBatch = { propagationWeight: 0.5 };
    assertEq(
        'effective：forward 未 slide → chain',
        effectivePropagationWeightTotal(mixedPlan, {
            direction: 'forward',
            forwardSlideSharedNodes: false,
        }),
        1,
    );
    assertEq(
        'effective：forward slide → 全量',
        effectivePropagationWeightTotal(mixedPlan, {
            direction: 'forward',
            forwardSlideSharedNodes: true,
        }),
        1.5,
    );
    assertEq(
        'effective：backward → chain（不含 prompt 区）',
        effectivePropagationWeightTotal(mixedPlan, {
            direction: 'backward',
            forwardSlideSharedNodes: false,
        }),
        1,
    );
    assertEq(
        'effective：backward 忽略 slide prompt 选项',
        effectivePropagationWeightTotal(mixedPlan, {
            direction: 'backward',
            forwardSlideSharedNodes: true,
        }),
        1,
    );
    assertEq(
        'total：forward 未 slide 用 chain 分母',
        batchAppearanceCostMs(chainBatch, mixedPlan, totalPacing, {
            direction: 'forward',
            forwardSlideSharedNodes: false,
        }),
        Math.round(0.5 * weightedBudgetMs),
    );
    assertEq(
        'total：forward slide 用全量分母',
        batchAppearanceCostMs(chainBatch, mixedPlan, totalPacing, {
            direction: 'forward',
            forwardSlideSharedNodes: true,
        }),
        Math.round((0.5 / 1.5) * weightedBudgetMs),
    );
}

// ── uniform propagation intervals ─────────────────────────────────────────────
console.log('3c. disableSmartStepTime');
{
    const uniformPlan = {
        weightTotal: 1,
        chainWeightTotal: 1,
        batches: [{ isFirstPromptRegion: true }, {}, {}],
    };
    const stepUniform = {
        mode: 'step' as const,
        stepMs: 400,
        totalS: 7,
        disableSmartStepTime: true,
    };
    assertEq(
        'uniform step：忽略权重',
        batchAppearanceCostMs({ propagationWeight: 0.25 }, uniformPlan, stepUniform),
        400,
    );
    assertEq(
        'uniform step：权重 0 仍为 stepMs',
        batchAppearanceCostMs({ propagationWeight: 0 }, uniformPlan, stepUniform),
        400,
    );
    const totalUniform = {
        mode: 'total' as const,
        stepMs: 400,
        totalS: 7,
        disableSmartStepTime: true,
    };
    const backwardScope = { direction: 'backward' as const, forwardSlideSharedNodes: false };
    const frameCount = propagationUniformWeightedFrameCount(uniformPlan, backwardScope);
    assertEq('uniform total：backward 计时节拍', frameCount, 2);
    const weightedBudgetMs = 7 * 1000 - DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS;
    assertEq(
        'uniform total：均分预算',
        batchAppearanceCostMs(batch, uniformPlan, totalUniform, backwardScope),
        Math.round(weightedBudgetMs / frameCount),
    );
    const forwardNoSlideScope = { direction: 'forward' as const, forwardSlideSharedNodes: false };
    const promptThenGenPlan = {
        weightTotal: 1,
        chainWeightTotal: 1,
        batches: [{ isFirstPromptRegion: true }, {}],
    };
    assertEq(
        'uniform total：forward 未 slide 跳过 prompt 区',
        propagationUniformWeightedFrameCount(promptThenGenPlan, forwardNoSlideScope),
        1,
    );
}

// ── resolveDagStepPlaybackClocks ────────────────────────────────────────────
console.log('3b. resolveDagStepPlaybackClocks');
{
    const step = resolveDagStepPlaybackClocks(10, 1, { mode: 'step', stepMs: 200, totalS: 7 });
    assertEq('step：output gen 1× 时钟', step.outputGenClockMs, 200);
    assertEq(
        'step：tool response = 3×',
        step.toolResponseClockMs,
        200 * DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS,
    );
    assertEq(
        'step：input 后首 gen = 3×',
        step.genAfterInputClockMs,
        200 * DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS,
    );
    const total = resolveDagStepPlaybackClocks(10, 1, { mode: 'total', stepMs: 200, totalS: 7 });
    const weightTotal =
        10 + DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS + DAG_PLAYBACK_GEN_AFTER_INPUT_CLOCKS;
    assertEq('total：outputGenClock 按权重分母', total.outputGenClockMs, Math.round(7000 / weightTotal));
    assertEq(
        'total：tool response = 3×',
        total.toolResponseClockMs,
        total.outputGenClockMs * DAG_PLAYBACK_TOOL_RESPONSE_CLOCKS,
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
    const plan = buildPropagationPlaybackPlan(incoming, offsetOf, nodeShare, 'f', (id) => id === 'p');
    assert('非空计划', plan != null);
    if (plan != null) {
        assertEq('批次数 = offset 组数（含仅 src 的 prompt）', plan.batches.length, 4);
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
        assertEq('forward 首帧 = 文序最远组（prompt）', plan.batches[last]!.tgtId, 'p');
        assertEq('prompt 批无入边', plan.batches[last]!.edgeKeys.length, 0);
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
        assertClose('文序首组 offset 最小（prompt）', textOrder[0]!.groupOffset, 0);
        assertClose('prompt 区内归一 weight', textOrder[0]!.propagationWeight, 1);
        assertEq('prompt 批 runningMaxNorm 为 undefined', textOrder[0]!.runningMaxNorm, undefined);
        assertClose('weightMax 不含 prompt', plan.weightMax, 0.4);
        assertClose('promptRegionMax', plan.promptRegionMax, 0.2);
    }
}

console.log('4b. buildPropagationPlaybackPlan 多 prompt token');
{
    const incoming = new Map<string, number>([
        ['p0->a', 0.1],
        ['p1->a', 0.05],
        ['a->b', 0.2],
        ['b->f', 0.5],
    ]);
    const offsetOf = (id: string) => ({ p0: 0, p1: 1, a: 2, b: 3, f: 4 })[id] ?? 0;
    const nodeShare = new Map([
        ['f', 1],
        ['b', 0.4],
        ['a', 0.3],
        ['p0', 0.25],
        ['p1', 0.15],
    ]);
    const isPrompt = (id: string) => id === 'p0' || id === 'p1';
    const plan = buildPropagationPlaybackPlan(incoming, offsetOf, nodeShare, 'f', isPrompt);
    assert('计划非空', plan != null);
    if (plan != null) {
        const textOrder = [...plan.batches].sort((a, b) => a.groupOffset - b.groupOffset);
        assertEq('两个 prompt 批均属 prompt 区', textOrder[0]!.isFirstPromptRegion, true);
        assertEq('两个 prompt 批均属 prompt 区 (2)', textOrder[1]!.isFirstPromptRegion, true);
        assertEq('gen 批不在 prompt 区', textOrder[2]!.isFirstPromptRegion ?? false, false);
        assertClose('p0 区内归一 weight', textOrder[0]!.propagationWeight, 1);
        assertClose('p1 区内归一 weight', textOrder[1]!.propagationWeight, 0.15 / 0.25);
        assertClose('promptRegionMax', plan.promptRegionMax, 0.25);
    }
}

assertEq('空入边 → null', buildPropagationPlaybackPlan(new Map(), () => 0, new Map(), 'f', () => false), null);

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
    const plan = buildPropagationPlaybackPlan(incoming, offsetOf, nodeShare, 'f', (id) => id === 'p');
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
        isPromptNode: (id) => id === 'p',
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

// ── backward 跳过首个 prompt 区 slide ───────────────────────────────────────
console.log('7. backward skips first prompt region slide');
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
    const focusId = 'f';
    const plan = buildPropagationPlaybackPlan(incoming, offsetOf, nodeShare, focusId, (id) => id === 'p');
    assert('计划非空', plan != null);
    if (plan != null) {
        const lastBatch = plan.batches.length - 1;
        const lastAnim = lastNonFirstPromptRegionBatchIndex(plan);
        assertEq('末批为 prompt', plan.batches[lastBatch]!.isFirstPromptRegion, true);
        assertEq('lastAnim 在 prompt 之前', lastAnim, lastBatch - 1);

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
        const overlayArgs = {
            effectiveFocusId: focusId,
            focusState,
            userAnimationFocusId: focusId,
            recursiveAttributionEnabled: true,
            computeFocusState: () => focusState,
            computeSteadyStateStayShareById: (m: Map<string, number>) => new Map(m),
            ctx,
        };

        const promptBatchAnim = {
            plan,
            direction: 'backward' as const,
            batchIndex: lastBatch,
            forwardPromptPreamblePending: false,
            weightScope: { direction: 'backward' as const, forwardSlideSharedNodes: true },
        };
        const promptOverlay = resolveRecursiveEdgeAnimationRenderOverlay({
            ...overlayArgs,
            animation: promptBatchAnim,
        });
        assertEq(
            'prompt 批（若落到）无 slide',
            promptOverlay.propagationSlideTgtId,
            null,
        );

        const genBatchAnim = {
            ...promptBatchAnim,
            batchIndex: lastAnim,
        };
        const genOverlay = resolveRecursiveEdgeAnimationRenderOverlay({
            ...overlayArgs,
            animation: genBatchAnim,
        });
        assertEq(
            '末个 gen 批 slide 为代表 token',
            genOverlay.propagationSlideTgtId,
            plan.batches[lastAnim]!.tgtId,
        );
        assert(
            'slide 不是 prompt',
            genOverlay.propagationSlideTgtId !== 'p',
        );

        const forwardPromptSlideAnim = {
            plan,
            direction: 'forward' as const,
            batchIndex: lastBatch,
            forwardPromptPreamblePending: false,
            weightScope: { direction: 'forward' as const, forwardSlideSharedNodes: true },
        };
        const forwardPromptOverlay = resolveRecursiveEdgeAnimationRenderOverlay({
            ...overlayArgs,
            animation: forwardPromptSlideAnim,
        });
        assertEq(
            'forward slide prompt：prompt 批有 slide',
            forwardPromptOverlay.propagationSlideTgtId,
            'p',
        );
    }
}

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
