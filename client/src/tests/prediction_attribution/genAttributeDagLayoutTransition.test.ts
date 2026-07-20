/**
 * DAG 布局转场：配对、几何、插值
 * 运行: cd client/src && npm run test:dagLayoutTransition
 */
import {
    annotateLayoutTransitionFlyRoles,
    flyArrowMarkerLayout,
    flyArrowTracksPoseHeight,
    flyArrowTransform,
    flyArrowTwistFromAngles,
    buildEdgeCellFlyPairs,
    buildEdgeEdgeFlyPairs,
    buildLayoutTransitionPairs,
    cellFlyPoseFromRect,
    DAG_LAYOUT_FLY_DEFAULT_COLOR,
    dagLayoutModeUsesStraightEdges,
    dagLayoutEdgeTransitionKind,
    dagLayoutNodeKey,
    edgeFlyPoseFromPathTangent,
    flySyntheticDashPair,
    isSteadyPainted,
    isSvgVisualPresent,
    layoutTransitionFlyCombinedOpacity,
    layoutTransitionFlyOpacity,
    lerpAngleDeg,
    lerpFlyPose,
    lerpPose,
    parsePoseFromTransform,
    readSteadyPaintOpacity,
    remapFlyPoseAcrossZoom,
    remapPoseAcrossZoom,
    runLayoutTransitionClock,
    type DagLayoutFlyPose,
    type LayoutTransitionCssLookup,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagLayoutTransition';
import { computeFitZoomTransform } from '../../shared/prediction_attribution/causal_flow/genAttributeDagFitZoom';
import { computeLinearArcNodeRects } from '../../shared/prediction_attribution/causal_flow/genAttributeDagViewLinearArcMode';
import { computeSpiralNodeRects } from '../../shared/prediction_attribution/causal_flow/genAttributeDagViewSpiralMode';
import { computeTextFlowNodeRects } from '../../shared/prediction_attribution/causal_flow/genAttributeDagViewTextFlowMode';
import {
    computeMatrixTokenRects,
    matrixColElementKey,
    matrixRowElementKey,
} from '../../shared/prediction_attribution/causal_flow/genAttributeDagViewMatrixMode';
import type { DagNodeLayoutPose } from '../../shared/prediction_attribution/causal_flow/genAttributeDagViewTextFlowMode';

function assertEq(label: string, actual: unknown, expected: unknown): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
    console.log(`  ✓ ${label}`);
}

function assert(label: string, cond: boolean): void {
    if (!cond) throw new Error(label);
    console.log(`  ✓ ${label}`);
}

function assertClose(label: string, actual: number, expected: number, eps = 1e-6): void {
    if (Math.abs(actual - expected) > eps) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
    console.log(`  ✓ ${label}`);
}

function pose(id: string, x: number, y: number, w = 10, h = 10, scale = 1): DagNodeLayoutPose {
    return { id, x, y, nodeW: w, nodeH: h, scale };
}

console.log('1. buildLayoutTransitionPairs graph↔graph');
{
    const fromPoses = new Map([
        [dagLayoutNodeKey('a'), pose('a', 0, 0)],
        [dagLayoutNodeKey('b'), pose('b', 20, 0)],
    ]);
    const toPoses = new Map([
        [dagLayoutNodeKey('a'), pose('a', 100, 50)],
        [dagLayoutNodeKey('b'), pose('b', 120, 50)],
    ]);
    const pairs = buildLayoutTransitionPairs({
        fromKind: 'graph',
        toKind: 'graph',
        fromPoses,
        toPoses,
    });
    assertEq('pair count', pairs.length, 2);
    assertEq('a→a', pairs.find((p) => p.fromKey === dagLayoutNodeKey('a'))?.toKey, dagLayoutNodeKey('a'));
}

console.log('2. buildLayoutTransitionPairs graph→matrix 1→2');
{
    const fromPoses = new Map([[dagLayoutNodeKey('t'), pose('t', 0, 0)]]);
    const toPoses = new Map([
        [matrixRowElementKey('t'), pose('t', 10, 20)],
        [matrixColElementKey('t'), pose('t', 30, 40)],
    ]);
    const pairs = buildLayoutTransitionPairs({
        fromKind: 'graph',
        toKind: 'matrix',
        fromPoses,
        toPoses,
    });
    assertEq('1→2 pair count', pairs.length, 2);
    assert(
        'targets are row+col',
        pairs.every((p) => p.fromKey === dagLayoutNodeKey('t')) &&
            new Set(pairs.map((p) => p.toKey)).size === 2,
    );
}

console.log('3. buildLayoutTransitionPairs matrix→graph 2→1');
{
    const fromPoses = new Map([
        [matrixRowElementKey('t'), pose('t', 10, 20)],
        [matrixColElementKey('t'), pose('t', 30, 40)],
    ]);
    const toPoses = new Map([[dagLayoutNodeKey('t'), pose('t', 0, 0)]]);
    const pairs = buildLayoutTransitionPairs({
        fromKind: 'matrix',
        toKind: 'graph',
        fromPoses,
        toPoses,
    });
    assertEq('2→1 pair count', pairs.length, 2);
    assert(
        'both land on node',
        pairs.every((p) => p.toKey === dagLayoutNodeKey('t')),
    );
}

function flyPose(
    id: string,
    cx: number,
    cy: number,
    w: number,
    h: number,
    angleDeg = 0,
    opacity = 1,
    arrowScale = 1,
    arrowTwistDeg = 0,
    color = DAG_LAYOUT_FLY_DEFAULT_COLOR,
    dashed = false,
    dashOn = 0,
    dashOff = 0,
): DagLayoutFlyPose {
    return {
        id,
        cx,
        cy,
        w,
        h,
        angleDeg,
        opacity,
        color,
        dashed,
        dashOn,
        dashOff,
        arrowScale,
        arrowTwistDeg,
    };
}

console.log('3b. buildEdgeCellFlyPairs + shape/angle');
{
    const edgePoses = new Map([
        ['a->b', flyPose('a->b', 0, 0, 30, 2.5, 45)],
        ['a->c', flyPose('a->c', 10, 0, 30, 2.5, 10)],
        ['x->y', flyPose('x->y', 20, 0, 30, 2.5, 0)],
    ]);
    const cellPoses = new Map([
        ['a->b', cellFlyPoseFromRect({ id: 'a->b', x: 100, y: 100, w: 18, h: 18 })],
        ['a->c', cellFlyPoseFromRect({ id: 'a->c', x: 120, y: 100, w: 18, h: 18 })],
    ]);
    const forward = buildEdgeCellFlyPairs({
        fromKind: 'graph',
        toKind: 'matrix',
        edgePoses,
        cellPoses,
        rankByKey: new Map([
            ['a->b', 1],
            ['a->c', 3],
        ]),
        maxPairs: 10,
    });
    assertEq('fly only intersecting keys', forward.length, 2);
    assertEq('stronger first', forward[0]!.fromKey, 'a->c');
    assertClose('from is edge cx', forward[0]!.from.cx, 10);
    assertClose('to is cell cx', forward[0]!.to.cx, 129);
    assertClose('cell angle 0', forward[0]!.to.angleDeg, 0);

    const capped = buildEdgeCellFlyPairs({
        fromKind: 'matrix',
        toKind: 'graph',
        edgePoses,
        cellPoses,
        rankByKey: new Map([
            ['a->b', 1],
            ['a->c', 3],
        ]),
        maxPairs: 1,
    });
    assertEq('maxPairs=1', capped.length, 1);
    assertEq('cap keeps strongest', capped[0]!.fromKey, 'a->c');
    assertClose('matrix→graph from is cell cx', capped[0]!.from.cx, 129);

    assertEq(
        'graph↔graph empty',
        buildEdgeCellFlyPairs({
            fromKind: 'graph',
            toKind: 'graph',
            edgePoses,
            cellPoses,
        }).length,
        0,
    );

    const slanted = edgeFlyPoseFromPathTangent({
        id: 'e',
        midX: 0,
        midY: 0,
        tanX: 1,
        tanY: 1,
        pathLength: 100,
    });
    assertClose('edge angle 45°', slanted.angleDeg, 45);
    assertClose('edge seed uses full length', slanted.w, 100);
    assert('edge seed is elongated', slanted.w > slanted.h);
    assertClose('edge has arrow', slanted.arrowScale, 1);
    assertClose('edge twist default 0', slanted.arrowTwistDeg, 0);
    assertEq('edge default color', slanted.color, DAG_LAYOUT_FLY_DEFAULT_COLOR);
    assertEq('edge default solid', slanted.dashed, false);
    const synDash = flySyntheticDashPair(0.5);
    assertClose('dash on@0.5', synDash.dashOn, 4);
    assertClose('dash off@0.5', synDash.dashOff, 3);
    assertEq(
        'edge keeps dashed',
        edgeFlyPoseFromPathTangent({
            id: 'e',
            midX: 0,
            midY: 0,
            tanX: 1,
            tanY: 0,
            pathLength: 10,
            dashed: true,
            dashOn: synDash.dashOn,
            dashOff: synDash.dashOff,
        }).dashed,
        true,
    );
    assertEq(
        'cell keeps dashed',
        cellFlyPoseFromRect({
            id: 'c',
            x: 0,
            y: 0,
            w: 18,
            h: 18,
            dashed: true,
            dashOn: synDash.dashOn,
            dashOff: synDash.dashOff,
        }).dashed,
        true,
    );
    assertEq(
        'lerp keeps dashed if either side',
        lerpFlyPose(
            flyPose('e', 0, 0, 40, 2, 0, 1, 1, 0, DAG_LAYOUT_FLY_DEFAULT_COLOR, true, 4, 3),
            flyPose('e', 10, 10, 18, 18, 0, 1, 0),
            0.5,
        ).dashed,
        true,
    );
    const dashRemapped = remapFlyPoseAcrossZoom(
        flyPose('e', 0, 0, 40, 2, 0, 1, 1, 0, DAG_LAYOUT_FLY_DEFAULT_COLOR, true, 4, 3),
        { x: 0, y: 0, k: 2 },
        { x: 0, y: 0, k: 1 },
    );
    assertClose('remap scales dashOn with sk/ek', dashRemapped.dashOn, 8);
    assertClose('remap scales dashOff with sk/ek', dashRemapped.dashOff, 6);
    assertClose(
        'lerp dash mid',
        lerpFlyPose(
            flyPose('e', 0, 0, 40, 2, 0, 1, 1, 0, DAG_LAYOUT_FLY_DEFAULT_COLOR, true, 8, 6),
            flyPose('e', 0, 0, 18, 18, 0, 1, 0, 0, DAG_LAYOUT_FLY_DEFAULT_COLOR, true, 4, 3),
            0.5,
        ).dashOn,
        6,
    );
    assertClose(
        'cell has no arrow',
        cellFlyPoseFromRect({ id: 'c', x: 0, y: 0, w: 18, h: 18 }).arrowScale,
        0,
    );
    assertEq(
        'edge keeps focus color',
        edgeFlyPoseFromPathTangent({
            id: 'e',
            midX: 0,
            midY: 0,
            tanX: 1,
            tanY: 0,
            pathLength: 10,
            color: 'var(--dag-highlight-line-color-in)',
        }).color,
        'var(--dag-highlight-line-color-in)',
    );
    assertEq(
        'cell keeps fill color',
        cellFlyPoseFromRect({
            id: 'c',
            x: 0,
            y: 0,
            w: 18,
            h: 18,
            color: 'var(--dag-highlight-line-color-out)',
        }).color,
        'var(--dag-highlight-line-color-out)',
    );
    assertEq(
        'lerp prefers graph-side color',
        lerpFlyPose(
            flyPose('e', 0, 0, 40, 2, 0, 1, 1, 0, 'var(--dag-highlight-line-color-in)'),
            flyPose('e', 10, 10, 18, 18, 0, 1, 0, 0, 'var(--dag-normal-line-color)'),
            0.5,
        ).color,
        'var(--dag-highlight-line-color-in)',
    );

    // 稳态 marker：viewport 4·sw、refX=0.8、path/stroke 同形
    const mk = flyArrowMarkerLayout(2);
    assertClose('marker viewport size', mk.size, 8);
    assertClose('marker refX offset', mk.x, -6.4);
    assertClose('marker refY center', mk.y, -4);
    assertEq('marker viewBox', mk.viewBox, '0 -5 10 10');
    assertEq('marker path', mk.pathD, 'M0,-5 L10,0 L0,5');
    assertClose('marker stroke in vb', mk.strokeWidth, 2.5);
    assertClose('arc twist', flyArrowTwistFromAngles(0, 30), 30);
    assertClose('twist wrap', flyArrowTwistFromAngles(170, -170), 20);
    // 边↔边：箭头厚度跟条带 h（zoom remap 后 from.h≠to.h）；边↔格不跟格子边长胀
    assertEq(
        'edge↔edge tracks h',
        flyArrowTracksPoseHeight(
            flyPose('e', 0, 0, 40, 4, 0, 1, 1),
            flyPose('e', 0, 0, 20, 2, 0, 1, 1),
        ),
        true,
    );
    assertEq(
        'edge↔cell locks thick',
        flyArrowTracksPoseHeight(
            flyPose('e', 0, 0, 40, 2, 0, 1, 1),
            flyPose('e', 0, 0, 18, 18, 0, 1, 0),
        ),
        false,
    );
    assertEq(
        'arrow scale at end matches to.h',
        flyArrowTransform(flyPose('e', 0, 0, 20, 2, 0, 1, 1), 4),
        'translate(20,1) rotate(0) scale(0.5)',
    );
    assertEq(
        'arrow without layoutThick ignores h ratio',
        flyArrowTransform(flyPose('e', 0, 0, 20, 2, 0, 1, 1)),
        'translate(20,1) rotate(0) scale(1)',
    );

    assertEq('text-flow straight edges', dagLayoutModeUsesStraightEdges('text-flow'), true);
    assertEq('spiral straight edges', dagLayoutModeUsesStraightEdges('spiral'), true);
    assertEq('linear-arc not straight', dagLayoutModeUsesStraightEdges('linear-arc'), false);
    assertEq('step-down not straight', dagLayoutModeUsesStraightEdges('linear-arc-step-down'), false);
    assertEq('matrix not straight', dagLayoutModeUsesStraightEdges('attribution-matrix'), false);
    // 边/格三策略
    assertEq(
        '1 edge-cell: straight↔matrix',
        dagLayoutEdgeTransitionKind('text-flow', 'attribution-matrix'),
        'fly-edge-cell',
    );
    assertEq(
        '1 edge-cell: matrix↔spiral',
        dagLayoutEdgeTransitionKind('attribution-matrix', 'spiral'),
        'fly-edge-cell',
    );
    assertEq(
        '2 edge-edge: text↔spiral',
        dagLayoutEdgeTransitionKind('text-flow', 'spiral'),
        'fly-edge-edge',
    );
    assertEq(
        '3 crossfade: arc↔matrix',
        dagLayoutEdgeTransitionKind('linear-arc', 'attribution-matrix'),
        'crossfade',
    );
    assertEq(
        '3 crossfade: matrix↔step-down',
        dagLayoutEdgeTransitionKind('attribution-matrix', 'linear-arc-step-down'),
        'crossfade',
    );
    assertEq(
        '3 crossfade: arc↔spiral',
        dagLayoutEdgeTransitionKind('linear-arc', 'spiral'),
        'crossfade',
    );
    assertEq(
        '3 crossfade: arc↔step-down',
        dagLayoutEdgeTransitionKind('linear-arc', 'linear-arc-step-down'),
        'crossfade',
    );

    const edgeEdge = buildEdgeEdgeFlyPairs({
        fromEdgePoses: new Map([
            ['a->b', flyPose('a->b', 0, 0, 40, 2, 0)],
            ['a->c', flyPose('a->c', 5, 5, 50, 2, 30)],
        ]),
        toEdgePoses: new Map([
            ['a->b', flyPose('a->b', 100, 100, 20, 2, 90)],
            ['x->y', flyPose('x->y', 0, 0, 10, 2, 0)],
        ]),
    });
    assertEq('edge↔edge only shared keys', edgeEdge.length, 1);
    assertEq('edge↔edge key', edgeEdge[0]!.fromKey, 'a->b');
    assertClose('edge↔edge from cx', edgeEdge[0]!.from.cx, 0);
    assertClose('edge↔edge to cx', edgeEdge[0]!.to.cx, 100);
    assertClose('edge↔edge keeps arrow', edgeEdge[0]!.to.arrowScale, 1);

    const mid = lerpFlyPose(
        flyPose('e', 0, 0, 40, 2, 90, 0.2, 1, 20),
        flyPose('e', 10, 10, 18, 18, 0, 0.8, 0, 0),
        0.5,
    );
    assertClose('lerp angle shortest', mid.angleDeg, 45);
    assertClose('lerp opacity', mid.opacity, 0.5);
    assertClose('lerp arrowScale', mid.arrowScale, 0.5);
    assertClose('lerp arrowTwist', mid.arrowTwistDeg, 10);
    assertClose('lerpAngle wrap', lerpAngleDeg(170, -170, 0.5), 180);

    const remapped = remapFlyPoseAcrossZoom(
        flyPose('e', 10, 20, 40, 2, 30),
        { x: 0, y: 0, k: 2 },
        { x: 0, y: 0, k: 1 },
    );
    assertClose('remap keeps angle', remapped.angleDeg, 30);
    assertClose('remap scales w', remapped.w, 80);
}

console.log('3c. fly node roles: source(col) primary + opacity');
{
    const fromPoses = new Map([[dagLayoutNodeKey('t'), pose('t', 0, 0)]]);
    const toPoses = new Map([
        [matrixRowElementKey('t'), pose('t', 10, 20)],
        [matrixColElementKey('t'), pose('t', 30, 40)],
    ]);
    const splitRoles = annotateLayoutTransitionFlyRoles(
        buildLayoutTransitionPairs({ fromKind: 'graph', toKind: 'matrix', fromPoses, toPoses }),
    );
    const splitCol = splitRoles.find((r) => r.pair.toKey === matrixColElementKey('t'))!;
    const splitRow = splitRoles.find((r) => r.pair.toKey === matrixRowElementKey('t'))!;
    assert('split: col is primary', splitCol.isPrimary && splitCol.cardinality === 'split');
    assert('split: row is secondary', !splitRow.isPrimary && splitRow.cardinality === 'split');
    assertClose('split primary opacity@0', layoutTransitionFlyOpacity(0, splitCol), 1);
    assertClose('split secondary opacity@0', layoutTransitionFlyOpacity(0, splitRow), 0);
    assertClose('split secondary opacity@1', layoutTransitionFlyOpacity(1, splitRow), 1);
    assertClose(
        'weakened primary stays dim',
        layoutTransitionFlyCombinedOpacity(0, splitCol, 0.6, 0.6),
        0.6,
    );
    assertClose(
        'weakened×secondary@0.5',
        layoutTransitionFlyCombinedOpacity(0.5, splitRow, 0.6, 0.6),
        0.3,
    );

    const mergeRoles = annotateLayoutTransitionFlyRoles(
        buildLayoutTransitionPairs({
            fromKind: 'matrix',
            toKind: 'graph',
            fromPoses: toPoses,
            toPoses: fromPoses,
        }),
    );
    const mergeCol = mergeRoles.find((r) => r.pair.fromKey === matrixColElementKey('t'))!;
    const mergeRow = mergeRoles.find((r) => r.pair.fromKey === matrixRowElementKey('t'))!;
    assert('merge: col is primary', mergeCol.isPrimary && mergeCol.cardinality === 'merge');
    assert('merge: row is secondary', !mergeRow.isPrimary && mergeRow.cardinality === 'merge');
    assertClose('merge secondary opacity@0', layoutTransitionFlyOpacity(0, mergeRow), 1);
    assertClose('merge secondary opacity@1', layoutTransitionFlyOpacity(1, mergeRow), 0);
}

console.log('4. computeLinearArcNodeRects monotonic x');
{
    const nodes = [
        { id: 'p', nodeW: 20, nodeH: 10, ciVisualScale: 1, step: -1 },
        { id: 'g0', nodeW: 20, nodeH: 10, ciVisualScale: 1, step: 0 },
        { id: 'g1', nodeW: 20, nodeH: 10, ciVisualScale: 1, step: 1 },
    ];
    const rects = computeLinearArcNodeRects(nodes, 4, 'flat');
    const xs = nodes.map((n) => rects.get(n.id)!.x);
    assert('x increasing', xs[0]! < xs[1]! && xs[1]! < xs[2]!);
}

console.log('5. computeSpiralNodeRects radius grows');
{
    const nodes = Array.from({ length: 6 }, (_, i) => ({
        id: `n${i}`,
        nodeW: 10,
        nodeH: 10,
    }));
    const rects = computeSpiralNodeRects(nodes);
    const first = rects.get('n0')!;
    assertEq('first scale', first.scale, 1.5);
    const r = (id: string) => {
        const p = rects.get(id)!;
        if (p.scale !== 1) return Math.hypot(p.x, p.y);
        return Math.hypot(p.x + p.nodeW / 2, p.y + p.nodeH / 2);
    };
    assert('r1 < r5', r('n1') < r('n5'));
}

console.log('6. computeTextFlowNodeRects');
{
    const rects = computeTextFlowNodeRects(
        [{ id: 'a', x: 10, y: 20, nodeW: 30, nodeH: 14, ciVisualScale: 1 }],
        1,
    );
    const p = rects.get('a')!;
    assertClose('x', p.x, 10);
    assertClose('y', p.y, 20);
}

console.log('7. computeMatrixTokenRects row/col separated');
{
    const chipWidthById = new Map([
        ['r0', 12],
        ['c0', 12],
        ['c1', 12],
    ]);
    const rects = computeMatrixTokenRects({
        rowNodes: [{ id: 'r0', displayLabel: 'R', isPrompt: false }],
        colNodes: [
            { id: 'c0', displayLabel: 'A', isPrompt: true },
            { id: 'c1', displayLabel: 'B', isPrompt: false },
        ],
        chipWidthById,
    });
    assert('has row', rects.has(matrixRowElementKey('r0')));
    assert('has col0', rects.has(matrixColElementKey('c0')));
    assert('has col1', rects.has(matrixColElementKey('c1')));
    const row = rects.get(matrixRowElementKey('r0'))!;
    const col0 = rects.get(matrixColElementKey('c0'))!;
    assert('row left of grid / col above', row.x < 0 || col0.y < 0);
}

console.log('8. lerp boundaries');
{
    const a = pose('a', 0, 0, 10, 10, 1);
    const b = pose('a', 100, 50, 20, 20, 1.5);
    const mid = lerpPose(a, b, 0.5);
    assertClose('lerp x mid', mid.x, 50);
    assertClose('lerp scale mid', mid.scale, 1.25);
}

console.log('9. parsePoseFromTransform + fit zoom');
{
    const p = parsePoseFromTransform('translate(3,4) scale(1.5) translate(-5,-5)', {
        id: 'x',
        nodeW: 10,
        nodeH: 10,
    });
    assertClose('parse x', p.x, 3);
    assertClose('parse y', p.y, 4);
    assertClose('parse scale', p.scale, 1.5);
    const fit = computeFitZoomTransform({
        mode: 'linear-arc',
        contentBBox: { x: 0, y: -5, width: 200, height: 10 },
        viewportW: 400,
        viewportH: 300,
        k0: 4,
    });
    assert('fit k positive', fit.k > 0 && fit.k <= 4);
}

console.log('9b. remapPoseAcrossZoom preserves screen');
{
    const fromZ = { x: 10, y: 20, k: 2 };
    const toZ = { x: 100, y: 50, k: 4 };
    const local = pose('a', 30, 40, 16, 8, 1);
    const remapped = remapPoseAcrossZoom(local, fromZ, toZ);
    assertClose('screen x', remapped.x * toZ.k + toZ.x, local.x * fromZ.k + fromZ.x);
    assertClose('screen y', remapped.y * toZ.k + toZ.y, local.y * fromZ.k + fromZ.y);
    assertClose('screen w', remapped.nodeW * toZ.k, local.nodeW * fromZ.k);
    assertClose('screen h', remapped.nodeH * toZ.k, local.nodeH * fromZ.k);
}

console.log('10. runLayoutTransitionClock');
{
    const ticks: number[] = [];
    let done = false;
    let tFake = 0;
    const queue: FrameRequestCallback[] = [];
    runLayoutTransitionClock({
        durationMs: 100,
        now: () => 0,
        requestFrame: (cb) => {
            queue.push(cb);
            return queue.length;
        },
        cancelFrame: () => undefined,
        onTick: ({ t }) => ticks.push(t),
        onDone: () => {
            done = true;
        },
    });
    while (queue.length > 0 && !done) {
        tFake += 50;
        const cb = queue.shift()!;
        cb(tFake);
    }
    assert('got ticks', ticks.length >= 1);
    assert('reached done', done);
    assertClose('last t', ticks[ticks.length - 1]!, 1);
}

console.log('11. isSteadyPainted (Hide inactive 类)');
{
    type FakeEl = Element & { _id: string; parentElement: FakeEl | null; getAttribute: (n: string) => string | null };
    const styleById = new Map<string, { display: string; visibility: string; opacity: string }>();
    const css: LayoutTransitionCssLookup = (el) =>
        styleById.get((el as FakeEl)._id) ?? {
            display: 'inline',
            visibility: 'visible',
            opacity: '1',
        };
    const make = (id: string, parent: FakeEl | null = null): FakeEl => {
        const el = {
            _id: id,
            parentElement: parent,
            getAttribute: () => null,
        } as unknown as FakeEl;
        styleById.set(id, { display: 'inline', visibility: 'visible', opacity: '1' });
        return el;
    };
    const layer = make('layer');
    const path = make('path', layer);
    assert('token visible by default', isSteadyPainted(path, 'token', { css }));
    assert('fill visible by default', isSteadyPainted(path, 'fill', { css }));
    styleById.set('layer', { display: 'none', visibility: 'visible', opacity: '1' });
    assert('ancestor display:none → absent', !isSvgVisualPresent(path, { css }));
    assert('fill follows subtree', !isSteadyPainted(path, 'fill', { css }));
    styleById.set('layer', { display: 'inline', visibility: 'visible', opacity: '1' });
    styleById.set('path', { display: 'inline', visibility: 'visible', opacity: '0' });
    assert('self opacity 0 → absent', !isSvgVisualPresent(path, { css }));
    assert('fill opacity 0 → not painted', !isSteadyPainted(path, 'fill', { css }));
    assertClose('readSteadyPaintOpacity fill 0', readSteadyPaintOpacity(path, 'fill', { css }), 0);
    styleById.set('path', { display: 'inline', visibility: 'visible', opacity: '0.5' });
    assert('fill opacity 0.5 painted', isSteadyPainted(path, 'fill', { css }));
    assertClose('readSteadyPaintOpacity fill 0.5', readSteadyPaintOpacity(path, 'fill', { css }), 0.5);
}

console.log('\nAll genAttributeDagLayoutTransition tests passed.');
