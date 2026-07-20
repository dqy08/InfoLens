/**
 * DAG 边高亮投影：灰边强度、焦点蓝/红 stroke、tooltip Link strength。
 * 给定图 + 焦点归因态 → 渲染强度；不拥有 DOM / 焦点写入。
 */
import { DirectedGraph } from 'graphology';
import {
    computeMutualInformationRatio,
    dagPropagationMiRatio,
} from '../../cross/surprisalMath';
import { DAG_NODE_STROKE_OPACITY_BASE } from './genAttributeDagEdgeDisplay';
import { normalizeEdgeRenderOpacity } from './genAttributeDagEdgeRenderStrength';
import type { DagFocusAttributionState } from './genAttributeDagRecursiveEdgeAnimation';
import { maxHighlightEdgeShare } from './genAttributeDagRecursiveEdgeAnimation';

export const CSS_VAR_DAG_NORMAL_LINE_COLOR = '--dag-normal-line-color';
export const CSS_VAR_DAG_HIGHLIGHT_LINE_IN = '--dag-highlight-line-color-in';
export const CSS_VAR_DAG_HIGHLIGHT_LINE_OUT = '--dag-highlight-line-color-out';

export type DagLinkHighlightNode = {
    id: string;
    step: number;
    dagTargetProb?: number;
};

export type DagLinkHighlightLink = {
    source: string;
    target: string;
    normalizedScore?: number;
    attributionShare?: number;
    mutualInformationRatio?: number;
};

export function dagLinkEndpointKey(source: string, target: string): string {
    return `${source}->${target}`;
}

/**
 * 该边的 attribution share：优先 L1 份额；无则回退 max-normalized score。
 */
export function edgeAttributionShare(
    d: Pick<DagLinkHighlightLink, 'attributionShare' | 'normalizedScore'>,
): number {
    const share = d.attributionShare;
    if (typeof share === 'number' && Number.isFinite(share) && share > 0) return share;
    const s = d.normalizedScore ?? 1;
    return Number.isFinite(s) ? Math.max(0, s) : 1;
}

/**
 * 边级 MI 系数（直接归因强度、无焦点灰边）。
 * 「Decay attribution to high-surprisal targets」关闭时恒为 1。
 */
export function effectiveMiRatio(
    miRatio: number | undefined,
    decayAttributionToHighSurprisalTarget: boolean,
): number | undefined {
    if (!decayAttributionToHighSurprisalTarget) return 1;
    if (miRatio === undefined || !Number.isFinite(miRatio)) return undefined;
    return miRatio;
}

export function directAttributionStrength(
    d: Pick<DagLinkHighlightLink, 'attributionShare' | 'normalizedScore' | 'mutualInformationRatio'>,
    decayAttributionToHighSurprisalTarget: boolean,
): number {
    const mi = effectiveMiRatio(d.mutualInformationRatio, decayAttributionToHighSurprisalTarget) ?? 1;
    return edgeAttributionShare(d) * mi;
}

/** 节点 target 端 MI ratio（与 tooltip「Target MI ratio」同源；与 decay 开关无关）。 */
export function nodeTargetMiRatio(node: Pick<DagLinkHighlightNode, 'dagTargetProb'>): number {
    return computeMutualInformationRatio(node.dagTargetProb);
}

/** 节点在递归传播中的传导系数（灰边入边池用）。 */
export function nodePropagationMiRatioForGray(
    node: DagLinkHighlightNode,
    decayAttributionToHighSurprisalTarget: boolean,
): number {
    if (node.step < 0) return 0;
    if (!decayAttributionToHighSurprisalTarget) return 1;
    return dagPropagationMiRatio(node.dagTargetProb);
}

/**
 * 候选归因节点描边透明度：stay / max(stay) → `[{@link DAG_NODE_STROKE_OPACITY_BASE}, 1]`。
 */
export function normalizeNodeStrokeRenderOpacity(share: number, maxShare: number): number {
    if (!Number.isFinite(share) || share <= 0) return 0;
    const scaled =
        !Number.isFinite(maxShare) || maxShare <= 0
            ? Math.min(1, share)
            : Math.min(1, share / maxShare);
    if (scaled <= 0) return 0;
    return DAG_NODE_STROKE_OPACITY_BASE + scaled * (1 - DAG_NODE_STROKE_OPACITY_BASE);
}

/** 焦点在 target 时单条入边份额（直接模式一跳；灰边与此时蓝边共用）。 */
export function perTargetIncomingEdgeShare(
    link: Pick<DagLinkHighlightLink, 'attributionShare' | 'normalizedScore'>,
    targetNode: DagLinkHighlightNode,
    decayAttributionToHighSurprisalTarget: boolean,
): number {
    const upstreamBudget = nodePropagationMiRatioForGray(
        targetNode,
        decayAttributionToHighSurprisalTarget,
    );
    return Math.min(1, upstreamBudget * edgeAttributionShare(link));
}

/** 灰边 stroke-opacity：按各 target 入边池归一。 */
export function buildGrayRenderStrengthByEdgeKey<
    T extends DagLinkHighlightNode,
    L extends DagLinkHighlightLink,
>(
    graph: DirectedGraph<T>,
    incomingLinksByTarget: Map<string, L[]>,
    decayAttributionToHighSurprisalTarget: boolean,
): Map<string, number> {
    const byKey = new Map<string, number>();
    for (const [targetId, links] of incomingLinksByTarget) {
        if (!graph.hasNode(targetId)) continue;
        const targetNode = graph.getNodeAttributes(targetId) as T;
        if (targetNode.step < 0 && (incomingLinksByTarget.get(targetId)?.length ?? 0) === 0) continue;
        let maxShare = 0;
        const rows: Array<{ key: string; share: number }> = [];
        for (const link of links) {
            if (!graph.hasEdge(link.source, link.target)) continue;
            const srcId = String(link.source);
            const share = perTargetIncomingEdgeShare(
                link,
                targetNode,
                decayAttributionToHighSurprisalTarget,
            );
            if (share > maxShare) maxShare = share;
            rows.push({ key: dagLinkEndpointKey(srcId, targetId), share });
        }
        for (const { key, share } of rows) {
            byKey.set(key, normalizeEdgeRenderOpacity(share, maxShare));
        }
    }
    return byKey;
}

/** 递归链候选节点描边强度：stay 池内 max 归一。 */
export function buildNodeStrokeRenderStrengthById(
    stayByNodeId: Map<string, number>,
    maxShareOverride?: number,
): Map<string, number> {
    const maxShare =
        maxShareOverride != null && Number.isFinite(maxShareOverride) && maxShareOverride > 0
            ? maxShareOverride
            : maxHighlightEdgeShare(stayByNodeId);
    const byNodeId = new Map<string, number>();
    for (const [nodeId, stay] of stayByNodeId) {
        byNodeId.set(nodeId, normalizeNodeStrokeRenderOpacity(stay, maxShare));
    }
    return byNodeId;
}

/** tooltip「Link strength」/ Propagated 份额。 */
export function resolveDagLinkTooltipStrengths(
    d: Pick<DagLinkHighlightLink, 'attributionShare' | 'normalizedScore' | 'mutualInformationRatio'>,
    edgeKey: string,
    focusState: DagFocusAttributionState | null,
    recursiveAttributionEnabled: boolean,
    decayAttributionToHighSurprisalTarget: boolean,
): { linkStrength: number; recursiveAttributionShare?: number } {
    const directStrength = directAttributionStrength(d, decayAttributionToHighSurprisalTarget);
    if (focusState) {
        const downstreamStrength = focusState.downstreamEdgeStrengthByKey.get(edgeKey);
        if (downstreamStrength != null) {
            return { linkStrength: downstreamStrength };
        }
        const incomingShare = focusState.incomingEdgeShareByKey.get(edgeKey);
        if (incomingShare != null) {
            return {
                linkStrength: incomingShare,
                recursiveAttributionShare: recursiveAttributionEnabled ? incomingShare : undefined,
            };
        }
    }
    return { linkStrength: directStrength };
}

export type DagLinkHighlightDisplay = {
    stroke: string;
    renderStrength: number;
    linkStrength: number;
    recursiveAttributionShare?: number;
};

/** 焦点下边的视觉规则：传播蓝边向上；可选红边看下游。 */
export function resolveDagLinkHighlightDisplay(
    d: DagLinkHighlightLink,
    edgeKey: string,
    focusState: DagFocusAttributionState | null,
    recursiveAttributionEnabled: boolean,
    grayRenderByKey: Map<string, number>,
    incomingHighlightRenderByKey: Map<string, number>,
    downstreamHighlightRenderByKey: Map<string, number>,
    backwardSlideIncomingRenderByKey: Map<string, number> | null,
    decayAttributionToHighSurprisalTarget: boolean,
): DagLinkHighlightDisplay {
    const directStrength = directAttributionStrength(d, decayAttributionToHighSurprisalTarget);
    const grayRender = grayRenderByKey.get(edgeKey) ?? directStrength;
    const { linkStrength, recursiveAttributionShare } = resolveDagLinkTooltipStrengths(
        d,
        edgeKey,
        focusState,
        recursiveAttributionEnabled,
        decayAttributionToHighSurprisalTarget,
    );

    if (focusState) {
        const downstreamStrength = focusState.downstreamEdgeStrengthByKey.get(edgeKey);
        if (downstreamStrength != null) {
            return {
                stroke: `var(${CSS_VAR_DAG_HIGHLIGHT_LINE_OUT})`,
                renderStrength: downstreamHighlightRenderByKey.get(edgeKey)!,
                linkStrength,
            };
        }

        const incomingShare = focusState.incomingEdgeShareByKey.get(edgeKey);
        if (incomingShare != null) {
            const backwardSlideRender = backwardSlideIncomingRenderByKey?.get(edgeKey);
            return {
                stroke:
                    backwardSlideRender != null
                        ? `var(${CSS_VAR_DAG_HIGHLIGHT_LINE_OUT})`
                        : `var(${CSS_VAR_DAG_HIGHLIGHT_LINE_IN})`,
                renderStrength:
                    backwardSlideRender ?? incomingHighlightRenderByKey.get(edgeKey)!,
                linkStrength,
                recursiveAttributionShare,
            };
        }
    }

    return {
        stroke: `var(${CSS_VAR_DAG_NORMAL_LINE_COLOR})`,
        renderStrength: grayRender,
        linkStrength,
    };
}
