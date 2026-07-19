/**
 * computeFocusAttributionState：offset 降序传播 + tool_response 合成边
 * 运行: cd client/src && npm run test:dagFocusAttribution
 */
import { DirectedGraph } from 'graphology';
import { computeFocusAttributionState } from '../../shared/prediction_attribution/causal_flow/genAttributeDagFocusAttribution';

type DagLink = {
    source: string;
    target: string;
    normalizedScore?: number;
    attributionShare?: number;
    mutualInformationRatio?: number;
};

type DagNodeAttrs = {
    id: string;
    label: string;
    step: number;
    start: number;
    end: number;
    x: number;
    y: number;
    nodeW: number;
    nodeH: number;
    ciVisualScale: number;
    displayLabel: string;
    dagTargetProb?: number;
};

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

function assertClose(label: string, actual: number, expected: number, eps = 1e-9): void {
    assert(label, Math.abs(actual - expected) <= eps);
}

function assertHas(label: string, set: Set<string>, id: string): void {
    assert(label, set.has(id));
}

function mkNode(
    id: string,
    label: string,
    step: number,
    start: number,
    end: number,
): DagNodeAttrs {
    return {
        id,
        label,
        step,
        start,
        end,
        x: start,
        y: 0,
        nodeW: 10,
        nodeH: 10,
        ciVisualScale: 1,
        displayLabel: label,
    };
}

function addEdge(
    graph: DirectedGraph<DagNodeAttrs>,
    incomingLinksByTarget: Map<string, DagLink[]>,
    link: DagLink,
): void {
    graph.addEdge(link.source, link.target, link);
    const bucket = incomingLinksByTarget.get(link.target) ?? [];
    bucket.push(link);
    incomingLinksByTarget.set(link.target, bucket);
}

/**
 * prompt [0,3) → tool_call [3,8) → tool_response [8,12) → answer [12,15)
 * 合成边 tool_call → tool_response；answer 同时依赖 prompt 与 tool_response。
 */
function buildToolUseFixture(): {
    graph: DirectedGraph<DagNodeAttrs>;
    incomingLinksByTarget: Map<string, DagLink[]>;
    ids: { prompt: string; toolCall: string; toolResponse: string; answer: string };
} {
    const prompt = '0_3';
    const toolCall = '3_8';
    const toolResponse = '8_12';
    const answer = '12_15';

    const graph = new DirectedGraph<DagNodeAttrs>();
    graph.addNode(prompt, mkNode(prompt, 'pr', -1, 0, 3));
    graph.addNode(toolCall, mkNode(toolCall, 'call', 0, 3, 8));
    graph.addNode(toolResponse, mkNode(toolResponse, 'resp', -1, 8, 12));
    graph.addNode(answer, mkNode(answer, 'ans', 1, 12, 15));

    const incomingLinksByTarget = new Map<string, DagLink[]>();
    addEdge(graph, incomingLinksByTarget, {
        source: prompt,
        target: toolCall,
        attributionShare: 1,
        normalizedScore: 1,
    });
    addEdge(graph, incomingLinksByTarget, {
        source: toolCall,
        target: toolResponse,
        attributionShare: 1,
        normalizedScore: 1,
    });
    addEdge(graph, incomingLinksByTarget, {
        source: prompt,
        target: answer,
        attributionShare: 0.5,
        normalizedScore: 0.5,
    });
    addEdge(graph, incomingLinksByTarget, {
        source: toolResponse,
        target: answer,
        attributionShare: 0.5,
        normalizedScore: 0.5,
    });

    return {
        graph,
        incomingLinksByTarget,
        ids: { prompt, toolCall, toolResponse, answer },
    };
}

console.log('1. focus tool_response → 链含 tool_call 与 prompt');
{
    const { graph, incomingLinksByTarget, ids } = buildToolUseFixture();
    const state = computeFocusAttributionState(graph, incomingLinksByTarget, ids.toolResponse, {
        maxIncomingDepth: Number.POSITIVE_INFINITY,
        includeDownstreamInfluence: false,
        decayAttributionToHighSurprisalTarget: false,
    });
    assert('state 非空', state != null);
    if (state) {
        assertHas('active 含 tool_call', state.activeNodeIds, ids.toolCall);
        assertHas('active 含 prompt', state.activeNodeIds, ids.prompt);
        assertClose('tool_call share = 1', state.nodeShareById.get(ids.toolCall) ?? 0, 1);
        assertClose('prompt share = 1', state.nodeShareById.get(ids.prompt) ?? 0, 1);
        const synthKey = `${ids.toolCall}->${ids.toolResponse}`;
        assertClose(
            '合成边 propagated share = 1',
            state.incomingEdgeShareByKey.get(synthKey) ?? 0,
            1,
        );
    }
}

console.log('2. focus answer → 经 tool_response 合成边到达 tool_call');
{
    const { graph, incomingLinksByTarget, ids } = buildToolUseFixture();
    const state = computeFocusAttributionState(graph, incomingLinksByTarget, ids.answer, {
        maxIncomingDepth: Number.POSITIVE_INFINITY,
        includeDownstreamInfluence: false,
        decayAttributionToHighSurprisalTarget: false,
    });
    assert('state 非空', state != null);
    if (state) {
        assertHas('active 含 tool_response', state.activeNodeIds, ids.toolResponse);
        assertHas('active 含 tool_call', state.activeNodeIds, ids.toolCall);
        assertClose('tool_call share = 0.5', state.nodeShareById.get(ids.toolCall) ?? 0, 0.5);
        assertClose('prompt share = 1', state.nodeShareById.get(ids.prompt) ?? 0, 1);
    }
}

console.log('3. 直接归因（一跳）不含 tool_call');
{
    const { graph, incomingLinksByTarget, ids } = buildToolUseFixture();
    const state = computeFocusAttributionState(graph, incomingLinksByTarget, ids.answer, {
        maxIncomingDepth: 1,
        includeDownstreamInfluence: false,
        decayAttributionToHighSurprisalTarget: false,
    });
    assert('state 非空', state != null);
    if (state) {
        assertHas('一跳含 prompt', state.activeNodeIds, ids.prompt);
        assertHas('一跳含 tool_response', state.activeNodeIds, ids.toolResponse);
        assert('一跳不含 tool_call', !state.activeNodeIds.has(ids.toolCall));
    }
}

/**
 * F[0,1) → A[1,2) → B[2,3)
 *          ↘ C[2,4)
 * 传播：FA=0.4；A 出边 AB=0.5、AC=0.3 → 二跳 0.4×0.5 / 0.4×0.3（显示侧另做 per-source max 归一）
 */
function buildDownstreamChainFixture(): {
    graph: DirectedGraph<DagNodeAttrs>;
    incomingLinksByTarget: Map<string, DagLink[]>;
    ids: { f: string; a: string; b: string; c: string };
} {
    const f = '0_1';
    const a = '1_2';
    const b = '2_3';
    const c = '2_4';
    const graph = new DirectedGraph<DagNodeAttrs>();
    graph.addNode(f, mkNode(f, 'F', 0, 0, 1));
    graph.addNode(a, mkNode(a, 'A', 1, 1, 2));
    graph.addNode(b, mkNode(b, 'B', 2, 2, 3));
    graph.addNode(c, mkNode(c, 'C', 3, 2, 4));
    const incomingLinksByTarget = new Map<string, DagLink[]>();
    addEdge(graph, incomingLinksByTarget, {
        source: f,
        target: a,
        attributionShare: 0.4,
        normalizedScore: 0.4,
    });
    addEdge(graph, incomingLinksByTarget, {
        source: a,
        target: b,
        attributionShare: 0.5,
        normalizedScore: 0.5,
    });
    addEdge(graph, incomingLinksByTarget, {
        source: a,
        target: c,
        attributionShare: 0.3,
        normalizedScore: 0.3,
    });
    return { graph, incomingLinksByTarget, ids: { f, a, b, c } };
}

console.log('4. 下游影响一跳：仅焦点出边');
{
    const { graph, incomingLinksByTarget, ids } = buildDownstreamChainFixture();
    const state = computeFocusAttributionState(graph, incomingLinksByTarget, ids.f, {
        maxIncomingDepth: 1,
        includeDownstreamInfluence: true,
        maxOutgoingDepth: 1,
        decayAttributionToHighSurprisalTarget: false,
    });
    assert('state 非空', state != null);
    if (state) {
        assertClose(
            '一跳 F→A = 0.4',
            state.downstreamEdgeStrengthByKey.get(`${ids.f}->${ids.a}`) ?? 0,
            0.4,
        );
        assert('一跳无 A→B', !state.downstreamEdgeStrengthByKey.has(`${ids.a}->${ids.b}`));
        assert('一跳无 A→C', !state.downstreamEdgeStrengthByKey.has(`${ids.a}->${ids.c}`));
        assertHas('active 含 A', state.activeNodeIds, ids.a);
        assert('active 不含 B', !state.activeNodeIds.has(ids.b));
    }
}

console.log('5. 下游影响递归：arrive × 一跳出边，汇合 sum');
{
    const { graph, incomingLinksByTarget, ids } = buildDownstreamChainFixture();
    const state = computeFocusAttributionState(graph, incomingLinksByTarget, ids.f, {
        maxIncomingDepth: Number.POSITIVE_INFINITY,
        includeDownstreamInfluence: true,
        maxOutgoingDepth: Number.POSITIVE_INFINITY,
        decayAttributionToHighSurprisalTarget: false,
    });
    assert('state 非空', state != null);
    if (state) {
        assertClose(
            'F→A = 0.4',
            state.downstreamEdgeStrengthByKey.get(`${ids.f}->${ids.a}`) ?? 0,
            0.4,
        );
        assertClose(
            'A→B = 0.4×0.5',
            state.downstreamEdgeStrengthByKey.get(`${ids.a}->${ids.b}`) ?? 0,
            0.2,
        );
        assertClose(
            'A→C = 0.4×0.3',
            state.downstreamEdgeStrengthByKey.get(`${ids.a}->${ids.c}`) ?? 0,
            0.12,
        );
        assertHas('active 含 B', state.activeNodeIds, ids.b);
        assertHas('active 含 C', state.activeNodeIds, ids.c);
    }
}

console.log('6. 下游递归多路汇合 sum；高惊讶只淡化入边不挡外扩');
{
    // F → A (0.5), F → A2 (0.5), A→B (1), A2→B (1)；再 B→C (0.8)
    // arrive(B)=0.5+0.5=1；B→C = 1×0.8=0.8（即便 B 高惊讶也不乘 prop）
    const f = '0_1';
    const a = '1_2';
    const a2 = '1_3';
    const b = '3_4';
    const c = '4_5';
    const graph = new DirectedGraph<DagNodeAttrs>();
    graph.addNode(f, mkNode(f, 'F', 0, 0, 1));
    graph.addNode(a, mkNode(a, 'A', 1, 1, 2));
    graph.addNode(a2, mkNode(a2, 'A2', 2, 1, 3));
    const bNode = mkNode(b, 'B', 3, 3, 4);
    bNode.dagTargetProb = 0.01; // 高惊讶
    graph.addNode(b, bNode);
    graph.addNode(c, mkNode(c, 'C', 4, 4, 5));
    const incomingLinksByTarget = new Map<string, DagLink[]>();
    addEdge(graph, incomingLinksByTarget, {
        source: f,
        target: a,
        attributionShare: 0.5,
        mutualInformationRatio: 1,
    });
    addEdge(graph, incomingLinksByTarget, {
        source: f,
        target: a2,
        attributionShare: 0.5,
        mutualInformationRatio: 1,
    });
    addEdge(graph, incomingLinksByTarget, {
        source: a,
        target: b,
        attributionShare: 1,
        mutualInformationRatio: 0.2, // 入 B 淡化
    });
    addEdge(graph, incomingLinksByTarget, {
        source: a2,
        target: b,
        attributionShare: 1,
        mutualInformationRatio: 0.2,
    });
    addEdge(graph, incomingLinksByTarget, {
        source: b,
        target: c,
        attributionShare: 0.8,
        mutualInformationRatio: 1,
    });

    const state = computeFocusAttributionState(graph, incomingLinksByTarget, f, {
        maxIncomingDepth: Number.POSITIVE_INFINITY,
        includeDownstreamInfluence: true,
        maxOutgoingDepth: Number.POSITIVE_INFINITY,
        decayAttributionToHighSurprisalTarget: true,
    });
    assert('state 非空', state != null);
    if (state) {
        // A→B = 0.5×(1×0.2)=0.1；A2→B 同理 0.1；arrive(B)=0.2
        assertClose('A→B faded', state.downstreamEdgeStrengthByKey.get(`${a}->${b}`) ?? 0, 0.1);
        assertClose('A2→B faded', state.downstreamEdgeStrengthByKey.get(`${a2}->${b}`) ?? 0, 0.1);
        // B→C = arrive(B)×0.8×1 = 0.2×0.8 = 0.16（不因 B 高惊讶再乘 prop）
        assertClose(
            'B→C = sum(arrive)×out，不乘 prop(B)',
            state.downstreamEdgeStrengthByKey.get(`${b}->${c}`) ?? 0,
            0.16,
        );
        assertClose('arrive(B) = 0.2', state.downstreamArriveById.get(b) ?? 0, 0.2);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
