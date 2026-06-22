import { DirectedGraph } from 'graphology';
import { dagPropagationMiRatio } from '../../cross/surprisalMath';
import { DAG_MIN_ATTRIBUTION_SHARE } from './genAttributeDagEdgeDisplay';
import type { DagFocusAttributionState } from './genAttributeDagRecursiveEdgeAnimation';

/** 传播计算所需的最小节点字段（与 {@link genAttributeDagView} 内 DagNode 同形子集）。 */
export type DagFocusAttributionNode = {
    id: string;
    step: number;
    /** 整段 context 中的 `[start, end)`；因果边保证 `offset(src) < offset(tgt)`。 */
    start: number;
    end: number;
    dagTargetProb?: number;
};

export type DagFocusAttributionLink = {
    source: string;
    target: string;
    normalizedScore?: number;
    attributionShare?: number;
    mutualInformationRatio?: number;
};

export type ComputeFocusAttributionOptions = {
    maxIncomingDepth: number;
    includeDownstreamInfluence: boolean;
    allowedEdgeKeys?: ReadonlySet<string>;
    /** 与「Decay attribution to high-surprisal targets」一致；默认 false。 */
    decayAttributionToHighSurprisalTarget?: boolean;
};

function edgeAttributionShare(
    d: Pick<DagFocusAttributionLink, 'attributionShare' | 'normalizedScore'>,
): number {
    const share = d.attributionShare;
    if (typeof share === 'number' && Number.isFinite(share) && share > 0) return share;
    const s = d.normalizedScore ?? 1;
    return Number.isFinite(s) ? Math.max(0, s) : 1;
}

function dagLinkEndpointKey(source: string, target: string): string {
    return `${source}->${target}`;
}

function endpointNode<T extends DagFocusAttributionNode>(
    ref: string | T,
    graph: DirectedGraph<T>,
): T {
    if (typeof ref === 'object' && ref !== null) return ref;
    const id = String(ref);
    if (!graph.hasNode(id)) throw new Error(`genAttributeDagFocusAttribution: unknown node id ${id}`);
    return graph.getNodeAttributes(id) as T;
}

function nodePropagationMiRatio(
    node: DagFocusAttributionNode,
    decayAttributionToHighSurprisalTarget: boolean,
): number {
    if (node.step < 0) return 0;
    if (!decayAttributionToHighSurprisalTarget) return 1;
    return dagPropagationMiRatio(node.dagTargetProb);
}

/** 向上传播时的传导系数：step < 0 时区分 prompt（来源）与 tool_response（合成入边、全量穿透）。 */
export function nodeUpstreamPropagationRatio(
    node: DagFocusAttributionNode,
    incomingLinksByTarget: Map<string, DagFocusAttributionLink[]>,
    decayAttributionToHighSurprisalTarget = false,
): number {
    if (node.step < 0) {
        return (incomingLinksByTarget.get(node.id)?.length ?? 0) > 0 ? 1 : 0;
    }
    return nodePropagationMiRatio(node, decayAttributionToHighSurprisalTarget);
}

function directAttributionStrength(
    d: Pick<DagFocusAttributionLink, 'attributionShare' | 'normalizedScore' | 'mutualInformationRatio'>,
    decayAttributionToHighSurprisalTarget: boolean,
): number {
    const mi =
        !decayAttributionToHighSurprisalTarget
            ? 1
            : d.mutualInformationRatio === undefined || !Number.isFinite(d.mutualInformationRatio)
              ? 1
              : d.mutualInformationRatio;
    return edgeAttributionShare(d) * mi;
}

/** 反向传播处理序：offset 降序（因果边单调 ⇒ 先下游后上游）。 */
function compareNodesByOffsetDesc<T extends DagFocusAttributionNode>(
    graph: DirectedGraph<T>,
    a: string,
    b: string,
): number {
    const na = graph.getNodeAttributes(a) as T;
    const nb = graph.getNodeAttributes(b) as T;
    if (nb.start !== na.start) return nb.start - na.start;
    return nb.end - na.end;
}

/**
 * 从焦点沿入边反向传播归因份额（`start ≤ focus.start` 的节点按 offset 降序单遍）。
 * 前提：每条边 `src → tgt` 满足 `src.start < tgt.start`（context 前缀 + 合成边）。
 */
export function computeFocusAttributionState<T extends DagFocusAttributionNode>(
    graph: DirectedGraph<T>,
    incomingLinksByTarget: Map<string, DagFocusAttributionLink[]>,
    focusId: string,
    options: ComputeFocusAttributionOptions,
): DagFocusAttributionState | null {
    if (!graph.hasNode(focusId)) return null;

    const decay = options.decayAttributionToHighSurprisalTarget ?? false;
    const activeNodeIds = new Set<string>([focusId]);
    const incomingEdgeShareByKey = new Map<string, number>();
    const downstreamEdgeStrengthByKey = new Map<string, number>();
    const nodeShareById = new Map<string, number>([[focusId, 1]]);
    const remainingDepthByNodeId = new Map<string, number>([[focusId, options.maxIncomingDepth]]);

    const focusStart = (graph.getNodeAttributes(focusId) as T).start;
    const processOrder = graph
        .mapNodes((id) => id)
        .filter((id) => (graph.getNodeAttributes(id) as T).start <= focusStart)
        .sort((a, b) => compareNodesByOffsetDesc(graph, a, b));

    for (const nodeId of processOrder) {
        const node = graph.getNodeAttributes(nodeId) as T;
        const nodeShare = Math.min(1, Math.max(0, nodeShareById.get(nodeId) ?? 0));
        const remainingDepth = remainingDepthByNodeId.get(nodeId) ?? 0;

        const propagationRatio = nodeUpstreamPropagationRatio(node, incomingLinksByTarget, decay);
        const upstreamBudget = nodeShare > 0 && remainingDepth > 0 ? nodeShare * propagationRatio : 0;

        for (const link of incomingLinksByTarget.get(nodeId) ?? []) {
            if (!graph.hasEdge(link.source, link.target)) continue;
            const srcId = endpointNode(link.source, graph).id;
            const edgeKey = dagLinkEndpointKey(srcId, nodeId);
            if (options.allowedEdgeKeys && !options.allowedEdgeKeys.has(edgeKey)) continue;

            if (upstreamBudget < DAG_MIN_ATTRIBUTION_SHARE) continue;
            const edgeShare = Math.min(1, upstreamBudget * edgeAttributionShare(link));
            if (edgeShare < DAG_MIN_ATTRIBUTION_SHARE) continue;

            incomingEdgeShareByKey.set(edgeKey, edgeShare);
            activeNodeIds.add(srcId);
            nodeShareById.set(srcId, Math.min(1, (nodeShareById.get(srcId) ?? 0) + edgeShare));
            remainingDepthByNodeId.set(
                srcId,
                Math.max(remainingDepthByNodeId.get(srcId) ?? 0, remainingDepth - 1),
            );
        }
    }

    if (options.includeDownstreamInfluence) {
        graph.forEachOutEdge(focusId, (_edgeId, edgeAttrs, srcId, tgtId) => {
            const link = edgeAttrs as unknown as DagFocusAttributionLink;
            const strength = directAttributionStrength(link, decay);
            if (strength < DAG_MIN_ATTRIBUTION_SHARE) return;
            downstreamEdgeStrengthByKey.set(dagLinkEndpointKey(srcId, tgtId), strength);
            activeNodeIds.add(tgtId);
        });
    }

    return { activeNodeIds, incomingEdgeShareByKey, downstreamEdgeStrengthByKey, nodeShareById };
}
