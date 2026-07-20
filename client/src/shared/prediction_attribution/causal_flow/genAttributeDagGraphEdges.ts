/**
 * DAG 图边变更：归因入边 / tool_response 合成边。
 *
 * 拥有「如何从 TokenGenStep 与节点区间建边」；不拥有 SVG / 焦点 / 布局。
 * 调用方持有 graphology 图与 `links` / `incomingLinksByTarget` 缓冲。
 */
import { DirectedGraph } from 'graphology';
import { computeMutualInformationRatio } from '../../cross/surprisalMath';
import { isOffsetSpanFullyExcluded } from '../core/attributionDisplayModel';
import { DAG_EDGE_MIN_NORMALIZED_SCORE } from './genAttributeDagEdgeDisplay';
import {
    alignAndAggregateByNode,
    type NodeInterval,
    type PieceEntry,
} from './genAttributeDagIntervalResolve';
import {
    excludeNodeAggregatedEntries,
    phase2RankAndSparsify,
} from './genAttributeDagPreprocess';
import type { CharRange, TokenGenStep } from './tokenGenAttributionRunner';

/** 建边所需的最小节点字段。 */
export type DagGraphEdgeNode = {
    id: string;
    step: number;
    start: number;
    end: number;
};

/** 与 view 内 DagLink 同形（source/target 为节点 id）。 */
export type DagGraphEdgeLink = {
    source: string;
    target: string;
    normalizedScore?: number;
    mutualInformationRatio?: number;
    attributionShare?: number;
    alignmentNote?: string;
    synthetic?: boolean;
};

/** 清空边集（保留节点）；不碰 SVG / 灰边缓存。 */
export function clearDagGraphEdges(
    graph: DirectedGraph<DagGraphEdgeNode>,
    links: DagGraphEdgeLink[],
    incomingLinksByTarget: Map<string, DagGraphEdgeLink[]>,
): void {
    graph.clearEdges();
    links.length = 0;
    incomingLinksByTarget.clear();
}

export type AddAttributionIncomingEdgesParams<T extends DagGraphEdgeNode> = {
    graph: DirectedGraph<T>;
    links: DagGraphEdgeLink[];
    incomingLinksByTarget: Map<string, DagGraphEdgeLink[]>;
    step: TokenGenStep;
    targetId: string;
    targetStart: number;
    targetEnd: number;
    /** 仅用于对齐告警；须与节点 `step` 一致。 */
    alignStep: number;
    excludeIntervalContext: string | undefined;
    excludeIntervals: [number, number][];
    nodeIntervals: NodeInterval[];
    dagDeleteIntervals: [number, number][];
    edgeTopPCoverage: number;
    decayAttributionToHighSurprisalTarget: boolean;
    excludePromptPatternsText: string;
    excludeGeneratedPatternsText: string;
};

/**
 * 为已有 target 节点按当前 exclude / Top-P / decay 建归因入边。
 * target 已 exclude 则跳过；重复边 / 缺源节点抛错。
 */
export function addAttributionIncomingEdges<T extends DagGraphEdgeNode>(
    params: AddAttributionIncomingEdgesParams<T>,
): void {
    const {
        graph,
        links,
        incomingLinksByTarget,
        step,
        targetId,
        targetStart,
        targetEnd,
        alignStep,
        excludeIntervalContext,
        excludeIntervals,
        nodeIntervals,
        dagDeleteIntervals,
        edgeTopPCoverage,
        decayAttributionToHighSurprisalTarget,
        excludePromptPatternsText,
        excludeGeneratedPatternsText,
    } = params;
    const { token, response } = step;
    if (isOffsetSpanFullyExcluded(targetStart, targetEnd, excludeIntervals)) return;
    const pieces: PieceEntry[] = (response.token_attribution ?? []).map((t) => ({
        offset: t.offset as [number, number],
        raw: t.raw,
        score: t.score,
    }));
    const aggregated = alignAndAggregateByNode(pieces, nodeIntervals, {
        step: alignStep,
        targetToken: token,
        ...(dagDeleteIntervals.length > 0
            ? { skipWarnIfFullyInIntervals: dagDeleteIntervals }
            : {}),
    });
    const afterExclude = excludeNodeAggregatedEntries(
        step,
        aggregated,
        excludeIntervalContext,
        excludePromptPatternsText,
        excludeGeneratedPatternsText,
    );
    const selected = phase2RankAndSparsify(afterExclude, { cumulativeShare: edgeTopPCoverage });

    const mutualInformationRatio = computeMutualInformationRatio(response.target_prob);
    const selectedForDisplay = selected.filter((item) => {
        const normalizedScore = item.score;
        const edgeVisibility =
            (decayAttributionToHighSurprisalTarget ? mutualInformationRatio : 1) * normalizedScore;
        return edgeVisibility >= DAG_EDGE_MIN_NORMALIZED_SCORE;
    });
    const massSum = selectedForDisplay.reduce((acc, t) => acc + Math.max(0, t.poolMassFrac), 0);
    const linksForTarget: DagGraphEdgeLink[] = [];
    for (const item of selectedForDisplay) {
        const srcId = item.nodeId;
        if (!graph.hasNode(srcId)) {
            throw new Error(
                `genAttributeDagGraphEdges: attribution nodeId ${srcId} has no graph node at alignStep=${alignStep} (align/DAG out of sync)`,
            );
        }
        const share = massSum > 0 ? item.poolMassFrac / massSum : undefined;
        const alignmentNote =
            item.alignmentTooltipLines && item.alignmentTooltipLines.length > 0
                ? item.alignmentTooltipLines.join('\n\n')
                : undefined;
        if (graph.hasEdge(srcId, targetId)) {
            throw new Error(
                `genAttributeDagGraphEdges: unexpected duplicate edge ${srcId} -> ${targetId} at alignStep=${alignStep} (duplicate nodeId in selected or repeat update?)`,
            );
        }
        const edgeAttrs = {
            normalizedScore: item.score,
            mutualInformationRatio,
            attributionShare: share,
            ...(alignmentNote ? { alignmentNote } : {}),
        };
        graph.addEdge(srcId, targetId, edgeAttrs);
        const newLink: DagGraphEdgeLink = {
            source: srcId,
            target: targetId,
            ...edgeAttrs,
        };
        links.push(newLink);
        linksForTarget.push(newLink);
    }
    if (linksForTarget.length > 0) incomingLinksByTarget.set(targetId, linksForTarget);
}

export type AddSyntheticEdgesForInputRangesParams<T extends DagGraphEdgeNode> = {
    graph: DirectedGraph<T>;
    links: DagGraphEdgeLink[];
    incomingLinksByTarget: Map<string, DagGraphEdgeLink[]>;
    nodes: readonly T[];
    inputRanges: CharRange[];
    /** 限制 tool_response 候选（增量时仅新增节点）。 */
    trNodeFilter: (n: T) => boolean;
    dagExcludeIntervals: [number, number][];
    /** 写入合成边后回调（如失效灰边缓存）。 */
    onSyntheticEdgesAdded?: () => void;
};

/**
 * 按 inputRanges 为 tool_response 节点建合成入边。
 * tool_response 先于 tool_call 出现时抛错。
 */
export function addSyntheticEdgesForInputRanges<T extends DagGraphEdgeNode>(
    params: AddSyntheticEdgesForInputRangesParams<T>,
): void {
    const {
        graph,
        links,
        incomingLinksByTarget,
        nodes,
        inputRanges,
        trNodeFilter,
        dagExcludeIntervals,
        onSyntheticEdgesAdded,
    } = params;
    if (inputRanges.length <= 1) return;
    for (let k = 1; k < inputRanges.length; k++) {
        const [trStart, trEnd] = inputRanges[k]!;
        const [, prevEnd] = inputRanges[k - 1]!;
        const tcStart = prevEnd;
        const tcEnd = trStart;
        const trNodes = nodes.filter(
            (n) =>
                n.step < 0 &&
                n.start >= trStart &&
                n.end <= trEnd &&
                trNodeFilter(n),
        );
        if (trNodes.length === 0) continue;
        const tcNodes = nodes.filter(
            (n) => n.step >= 0 && n.start >= tcStart && n.end <= tcEnd,
        );
        if (tcNodes.length === 0) {
            throw new Error(
                `genAttributeDagGraphEdges: tool_response input [${trStart}, ${trEnd}) added before tool_call nodes exist in [${tcStart}, ${tcEnd}); check setPromptTokenSpans vs update() ordering`,
            );
        }
        const activeTcNodes =
            dagExcludeIntervals.length === 0
                ? tcNodes
                : tcNodes.filter(
                      (n) => !isOffsetSpanFullyExcluded(n.start, n.end, dagExcludeIntervals),
                  );
        if (activeTcNodes.length === 0) continue;
        const share = 1 / activeTcNodes.length;
        for (const trNode of trNodes) {
            const syntheticLinks: DagGraphEdgeLink[] = [];
            for (const tcNode of activeTcNodes) {
                if (graph.hasEdge(tcNode.id, trNode.id)) continue;
                const edgeAttrs = {
                    normalizedScore: share,
                    attributionShare: share,
                    mutualInformationRatio: 1,
                };
                graph.addEdge(tcNode.id, trNode.id, edgeAttrs);
                syntheticLinks.push({
                    source: tcNode.id,
                    target: trNode.id,
                    synthetic: true,
                    ...edgeAttrs,
                });
            }
            if (syntheticLinks.length > 0) {
                links.push(...syntheticLinks);
                incomingLinksByTarget.set(trNode.id, syntheticLinks);
                onSyntheticEdgesAdded?.();
            }
        }
    }
}
