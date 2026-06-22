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
    cx: number;
    cy: number;
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
        cx: start,
        cy: 0,
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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
