import * as d3 from 'd3';
import { linkSegmentThroughNodeRects } from './genAttributeDagLinkSegment';
import { poseToTransform, type DagNodeLayoutPose } from './genAttributeDagViewTextFlowMode';

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
export const SPIRAL_FIRST_TOKEN_SCALE = 1.5;
// ────────────────────────────────────────────────────────────────────────────

type SpiralNodeLike = { id: string; nodeW: number; nodeH: number };

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

/**
 * spiral：中心落在螺旋点。
 * - 普通节点：pose.x/y 为矩形左上角，scale=1
 * - 首节点：pose.x/y 为螺旋中心（与 DOM `translate(cx,cy) scale(s) translate(-w/2,-h/2)` 一致），scale=SPIRAL_FIRST_TOKEN_SCALE
 */
export function computeSpiralNodeRects(nodes: SpiralNodeLike[]): Map<string, DagNodeLayoutPose> {
    const rawPos = computeSpiralPositions(nodes.length, SPIRAL_R0, SPIRAL_SPACING, SPIRAL_ARC_STEP, SPIRAL_PHASE);
    const out = new Map<string, DagNodeLayoutPose>();
    for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i]!;
        const pos = rawPos[i]!;
        if (i === 0) {
            out.set(n.id, {
                id: n.id,
                x: pos.cx,
                y: pos.cy,
                nodeW: n.nodeW,
                nodeH: n.nodeH,
                scale: SPIRAL_FIRST_TOKEN_SCALE,
            });
        } else {
            out.set(n.id, {
                id: n.id,
                x: pos.cx - n.nodeW / 2,
                y: pos.cy - n.nodeH / 2,
                nodeW: n.nodeW,
                nodeH: n.nodeH,
                scale: 1,
            });
        }
    }
    return out;
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
    const poses = computeSpiralNodeRects(nodes);
    const firstId = nodes[0]?.id ?? null;

    const centerOf = (id: string): { cx: number; cy: number } | undefined => {
        const p = poses.get(id);
        if (!p) return undefined;
        if (p.scale !== 1) return { cx: p.x, cy: p.y };
        return { cx: p.x + p.nodeW / 2, cy: p.y + p.nodeH / 2 };
    };

    const effNodeSize = (n: NodeDatum) =>
        firstId !== null && n.id === firstId
            ? { nodeW: n.nodeW * SPIRAL_FIRST_TOKEN_SCALE, nodeH: n.nodeH * SPIRAL_FIRST_TOKEN_SCALE }
            : { nodeW: n.nodeW, nodeH: n.nodeH };

    nodeSel.attr('transform', (d) => {
        const p = poses.get(d.id);
        if (p === undefined) return null;
        return poseToTransform(p);
    });

    linkSel.each(function (d) {
        const { src, tgt } = getLinkNodes(d);
        const pa = centerOf(src.id);
        const pb = centerOf(tgt.id);
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
