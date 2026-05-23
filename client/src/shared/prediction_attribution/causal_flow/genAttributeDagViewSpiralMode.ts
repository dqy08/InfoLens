import * as d3 from 'd3';
import { linkSegmentThroughNodeRects } from './genAttributeDagLinkSegment';

// ── 可配置参数（代码变量，后续可暴露为 UI 控件）────────────────────────────
/** 第一个 token 的起始半径（px）：0 = 正中心，> 0 = 距中心该距离处。 */
const SPIRAL_R0 = 80;
/** 相邻两圈之间的径向间距（px）。 */
const SPIRAL_SPACING = 60;
/** 每个 token 沿螺旋弧长占据的固定步长（px）。 */
const SPIRAL_ARC_STEP = 30;
/** 螺旋旋转相位（弧度）：控制螺旋臂展开方向。0 = 向右，-Math.PI/2 = 向上。 */
const SPIRAL_PHASE = Math.PI * 0.6;
/** 螺旋上第一个（起始位置）token 的相对视觉放大倍数（仅 spiral 布局）。 */
const SPIRAL_FIRST_TOKEN_SCALE = 1.5;
// ────────────────────────────────────────────────────────────────────────────

type SpiralNodeLike = { nodeW: number; nodeH: number };

/**
 * 阿基米德螺旋：r(θ) = b·θ，b = spacing / (2π)。
 *
 * theta 从 r0/b 起步，使第一个 token 位于半径 r0 处。
 * 相位 phase 叠加到 cos/sin 的角度，只旋转螺旋臂方向，不影响 r 的增长。
 * 弧长步进：Δθ ≈ arcStep / sqrt(r² + b²)。
 */
function computeSpiralPositions(
    count: number,
    r0: number,
    spacing: number,
    arcStep: number,
    phase: number,
): { cx: number; cy: number }[] {
    const b = spacing / (2 * Math.PI);
    let theta = r0 / b;
    const positions: { cx: number; cy: number }[] = [];

    for (let i = 0; i < count; i++) {
        const r = b * theta;
        positions.push({
            cx: r * Math.cos(theta + phase),
            cy: r * Math.sin(theta + phase),
        });
        theta += arcStep / Math.sqrt(r * r + b * b);
    }
    return positions;
}

/** spiral 模式：token 中心依次落在阿基米德螺旋上，节点保持水平矩形。 */
export function paintSpiralLayout<
    LinkDatum,
    NodeDatum extends SpiralNodeLike,
>(params: {
    linkSel: d3.Selection<SVGGElement, LinkDatum, SVGGElement, unknown>;
    nodeSel: d3.Selection<SVGGElement, NodeDatum, SVGGElement, unknown>;
    nodes: NodeDatum[];
    linkEndInsetPx: number;
    getLinkNodes: (link: LinkDatum) => { src: NodeDatum; tgt: NodeDatum };
}): void {
    const { linkSel, nodeSel, nodes, linkEndInsetPx, getLinkNodes } = params;

    const rawPos = computeSpiralPositions(nodes.length, SPIRAL_R0, SPIRAL_SPACING, SPIRAL_ARC_STEP, SPIRAL_PHASE);

    const positionByNode = new Map<NodeDatum, { cx: number; cy: number }>();
    for (let i = 0; i < nodes.length; i++) {
        positionByNode.set(nodes[i]!, rawPos[i]!);
    }

    const firstSpiralNode = nodes.length > 0 ? nodes[0]! : null;
    const effNodeSize = (n: NodeDatum) =>
        firstSpiralNode !== null && n === firstSpiralNode
            ? { nodeW: n.nodeW * SPIRAL_FIRST_TOKEN_SCALE, nodeH: n.nodeH * SPIRAL_FIRST_TOKEN_SCALE }
            : { nodeW: n.nodeW, nodeH: n.nodeH };

    // 节点：中心落在螺旋点，矩形保持水平
    nodeSel.attr('transform', (d) => {
        const pos = positionByNode.get(d);
        if (pos === undefined) return null;
        if (firstSpiralNode !== null && d === firstSpiralNode) {
            return `translate(${pos.cx},${pos.cy}) scale(${SPIRAL_FIRST_TOKEN_SCALE}) translate(${-d.nodeW / 2},${-d.nodeH / 2})`;
        }
        return `translate(${pos.cx - d.nodeW / 2},${pos.cy - d.nodeH / 2})`;
    });

    // 边：与 text-flow 相同，从矩形边界起止并回缩
    linkSel.each(function(d) {
        const { src, tgt } = getLinkNodes(d);
        const pa = positionByNode.get(src);
        const pb = positionByNode.get(tgt);
        if (pa === undefined || pb === undefined) return;
        const sw = effNodeSize(src);
        const tw = effNodeSize(tgt);
        const srcRect = { cx: pa.cx, cy: pa.cy, nodeW: sw.nodeW, nodeH: sw.nodeH };
        const tgtRect = { cx: pb.cx, cy: pb.cy, nodeW: tw.nodeW, nodeH: tw.nodeH };
        const seg = linkSegmentThroughNodeRects(srcRect, tgtRect, linkEndInsetPx);
        d3.select(this)
            .selectAll('path.gen-attr-dag-link-visible')
            .attr('d', `M ${seg.x1} ${seg.y1} L ${seg.x2} ${seg.y2}`);
    });
}
