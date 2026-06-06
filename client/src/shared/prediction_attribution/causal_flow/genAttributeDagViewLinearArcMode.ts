import * as d3 from 'd3';
import { dagStepDownEffectiveCiRatio } from '../../cross/surprisalMath';

/** linear-arc：相邻节点矩形水平方向「外侧边与边之间的空隙」（px，SVG 内部坐标） */
export const LINEAR_ARC_ADJACENT_GAP_DEFAULT = 0;
export const LINEAR_ARC_ADJACENT_GAP_MIN = 0;
export const LINEAR_ARC_ADJACENT_GAP_MAX = 400;

/** prompt→生成 首邻：在 `adjacentGapPx` 之上多出的水平空隙（节点已有 `step`，仅此一处判断） */
const LINEAR_ARC_PROMPT_GEN_EXTRA_GAP_PX = 12;

/**
 * 连边的三次贝塞尔：P1/P2 沿水平边方向向对端内收，相对半跨距的比例，[0,1]。
 * 0 表示控制点与端点同竖线（切线竖直向上）；1 表示收到跨度中点（最圆）。
 */
export const LINEAR_ARC_BEZIER_HANDLE_INSET_FRACTION = 0.25;

/** 首节点中心 x（与 translate(cx - w/2) 一致） */
const LINEAR_ARC_FIRST_CENTER_X = 20;
const LINEAR_ARC_BASELINE_Y = 0;

export function clampLinearArcAdjacentGap(px: number): number {
    return Math.max(
        LINEAR_ARC_ADJACENT_GAP_MIN,
        Math.min(LINEAR_ARC_ADJACENT_GAP_MAX, Math.round(px))
    );
}

type LinearArcNodeLike = { nodeW: number; nodeH: number; ciVisualScale: number };

/** `step === -1` 表示 prompt（与 `genAttributeDagView` 中 `DagNode.step` 约定一致） */
type LinearArcSteppedNode = LinearArcNodeLike & { step: number };

/** 下台阶布局：节点可带 `dagTargetProb`；有效 CI 为 {@link dagStepDownEffectiveCiRatio}（高置信 p>p₁ 为 0；与「关掉 CI 视觉」无关）。 */
export type LinearArcStepDownNode = LinearArcSteppedNode & { dagTargetProb?: number };

export type LinearArcPaintVariant = 'flat' | 'step-down';

/**
 * 下台阶：每档竖直落差 = `LINEAR_ARC_STEP_DOWN_DISTANCE_SCALE × linearArcUnscaledNodeHeight × CI`。
 * 仅代码可调；不对该系数做运行时 clamp。
 */
export const LINEAR_ARC_STEP_DOWN_DISTANCE_SCALE = 1;

/** 未做 CI 视觉放大时的节点高度（SVG 坐标），作下台阶落差的 100% CI 基准 */
export function linearArcUnscaledNodeHeight(n: Pick<LinearArcNodeLike, 'nodeH' | 'ciVisualScale'>): number {
    return n.nodeH / n.ciVisualScale;
}

/**
 * 第 i 个节点相对首节点的累积下移：对每个 j≥1，加上
 * `LINEAR_ARC_STEP_DOWN_DISTANCE_SCALE × linearArcUnscaledNodeHeight × CI`，
 * CI 为 {@link dagStepDownEffectiveCiRatio}(dagTargetProb)。
 */
export function computeLinearArcStepDownOffsetYs(nodes: LinearArcStepDownNode[]): number[] {
    const offsetY: number[] = [];
    let acc = 0;
    for (let i = 0; i < nodes.length; i++) {
        offsetY.push(acc);
        const next = nodes[i + 1];
        if (!next) continue;
        const ratio = dagStepDownEffectiveCiRatio(next.dagTargetProb);
        acc += LINEAR_ARC_STEP_DOWN_DISTANCE_SCALE * linearArcUnscaledNodeHeight(next) * ratio;
    }
    return offsetY;
}

function computeNodeCenterXs(nodes: LinearArcSteppedNode[], adjacentGapPx: number): number[] {
    const xs: number[] = [];
    if (nodes.length === 0) return xs;
    xs.push(LINEAR_ARC_FIRST_CENTER_X);
    for (let i = 1; i < nodes.length; i++) {
        const prev = nodes[i - 1]!;
        const curr = nodes[i]!;
        const gap =
            adjacentGapPx +
            (prev.step === -1 && curr.step !== -1 ? LINEAR_ARC_PROMPT_GEN_EXTRA_GAP_PX : 0);
        xs.push(xs[i - 1]! + prev.nodeW / 2 + gap + curr.nodeW / 2);
    }
    return xs;
}

/** linear-arc 模式：节点线性排布，边使用顶部向上弧线。
 *
 * `nodes` 为参与布局的可见节点子集（可能少于 `nodeSel` 绑定的全量节点）；
 * 不在 `nodes` 中的节点（如被隐藏的 excluded 节点）transform 保持不变——调用方已将它们设为 `display:none`。
 *
 * `variant === 'step-down'`：竖直落差 × {@link LINEAR_ARC_STEP_DOWN_DISTANCE_SCALE} × {@link linearArcUnscaledNodeHeight} × {@link dagStepDownEffectiveCiRatio}。
 */
export function paintLinearArcLayout<
    LinkDatum,
    NodeDatum extends LinearArcSteppedNode,
>(params: {
    linkSel: d3.Selection<SVGGElement, LinkDatum, SVGGElement, unknown>;
    nodeSel: d3.Selection<SVGGElement, NodeDatum, SVGGElement, unknown>;
    nodes: NodeDatum[];
    adjacentGapPx: number;
    getLinkNodes: (link: LinkDatum) => { src: NodeDatum; tgt: NodeDatum };
    variant?: LinearArcPaintVariant;
}): void {
    const { linkSel, nodeSel, nodes, adjacentGapPx, getLinkNodes, variant = 'flat' } = params;

    const centerXs = computeNodeCenterXs(nodes, adjacentGapPx);

    // Map datum → centerX：支持 nodeSel 含超出 nodes 范围的节点（如被隐藏的节点）。
    const centerXByNode = new Map<NodeDatum, number>();
    for (let i = 0; i < nodes.length; i++) {
        centerXByNode.set(nodes[i]!, centerXs[i]!);
    }

    const offsetYs =
        variant === 'step-down' ? computeLinearArcStepDownOffsetYs(nodes as LinearArcStepDownNode[]) : null;
    const offsetYByNode = new Map<NodeDatum, number>();
    if (offsetYs) {
        for (let i = 0; i < nodes.length; i++) {
            offsetYByNode.set(nodes[i]!, offsetYs[i]!);
        }
    }

    const arcTopY = (n: NodeDatum): number => {
        const oy = offsetYByNode.get(n) ?? 0;
        return LINEAR_ARC_BASELINE_Y - n.nodeH / (2 * n.ciVisualScale) + oy;
    };

    const arcPathBetweenNodes = (src: NodeDatum, tgt: NodeDatum): string => {
        const srcCx = centerXByNode.get(src);
        const tgtCx = centerXByNode.get(tgt);
        if (srcCx === undefined || tgtCx === undefined) {
            throw new Error('paintLinearArcLayout: link endpoint not in linear node list');
        }
        const yStart = arcTopY(src);
        const yEnd = arcTopY(tgt);
        const dx = Math.abs(tgtCx - srcCx);
        const arcH = dx * 0.4;
        const upY = Math.min(yStart, yEnd) - arcH;
        const t = Math.max(0, Math.min(1, LINEAR_ARC_BEZIER_HANDLE_INSET_FRACTION));
        const inset = t * (dx / 2);
        const dir = tgtCx >= srcCx ? 1 : -1;
        const p1x = srcCx + dir * inset;
        const p2x = tgtCx - dir * inset;
        return `M ${srcCx} ${yStart} C ${p1x} ${upY}, ${p2x} ${upY}, ${tgtCx} ${yEnd}`;
    };

    linkSel.each(function(d) {
        const { src, tgt } = getLinkNodes(d);
        if (!centerXByNode.has(src) || !centerXByNode.has(tgt)) {
            return; // 端点未参与布局（Hide exclude/inactive 等），路径由 highlight 隐藏
        }
        d3.select(this)
            .selectAll('path.gen-attr-dag-link-visible')
            .attr('d', arcPathBetweenNodes(src, tgt));
    });

    nodeSel.attr('transform', (d) => {
        const cx = centerXByNode.get(d);
        if (cx === undefined) return null; // 不在布局列表中（已 display:none），不更新 transform
        const oy = offsetYByNode.get(d) ?? 0;
        return `translate(${cx - d.nodeW / 2},${LINEAR_ARC_BASELINE_Y - d.nodeH / 2 + oy})`;
    });
}
