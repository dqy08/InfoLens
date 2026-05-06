import * as d3 from 'd3';

type TextFlowNodeLike = {
    x: number;
    y: number;
    nodeW: number;
    nodeH: number;
};

function nodeCenter(n: TextFlowNodeLike): { cx: number; cy: number } {
    return { cx: n.x + n.nodeW / 2, cy: n.y + n.nodeH / 2 };
}

/** 轴对齐矩形（半宽 hw、半高 hh）中心沿单位向量 (ux,uy) 到边界的距离。 */
function distCenterToRectEdgeAlongRay(hw: number, hh: number, ux: number, uy: number): number {
    const ax = Math.abs(ux);
    const ay = Math.abs(uy);
    let t = Infinity;
    if (ax > 1e-12) t = Math.min(t, hw / ax);
    if (ay > 1e-12) t = Math.min(t, hh / ay);
    return Number.isFinite(t) ? t : 0;
}

/** text-flow 模式边几何：从两节点矩形边界连线，必要时退化为中心直连。 */
function linkSegmentThroughNodeRects(
    src: TextFlowNodeLike,
    tgt: TextFlowNodeLike,
    outsideInset: number
): { x1: number; y1: number; x2: number; y2: number } {
    const a = nodeCenter(src);
    const b = nodeCenter(tgt);
    const dx = b.cx - a.cx;
    const dy = b.cy - a.cy;
    const L = Math.hypot(dx, dy);
    if (L < 1e-9) return { x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy };
    const ux = dx / L;
    const uy = dy / L;
    const tA = distCenterToRectEdgeAlongRay(src.nodeW / 2, src.nodeH / 2, ux, uy);
    const tB = distCenterToRectEdgeAlongRay(tgt.nodeW / 2, tgt.nodeH / 2, ux, uy);
    const eps = 1e-6;
    let g = outsideInset;
    if (tA + tB + 2 * g >= L - eps) g = 0;
    if (tA + tB + 2 * g >= L - eps) {
        return { x1: a.cx, y1: a.cy, x2: b.cx, y2: b.cy };
    }
    return {
        x1: a.cx + (tA + g) * ux,
        y1: a.cy + (tA + g) * uy,
        x2: b.cx - (tB + g) * ux,
        y2: b.cy - (tB + g) * uy,
    };
}

/** text-flow 模式：节点使用测量层坐标，边按节点矩形几何连接。 */
export function paintTextFlowLayout<LinkDatum, NodeDatum extends TextFlowNodeLike>(params: {
    linkSel: d3.Selection<SVGGElement, LinkDatum, SVGGElement, unknown>;
    nodeSel: d3.Selection<SVGGElement, NodeDatum, SVGGElement, unknown>;
    linkEndInsetPx: number;
    getLinkNodes: (link: LinkDatum) => { src: NodeDatum; tgt: NodeDatum };
}): void {
    const { linkSel, nodeSel, linkEndInsetPx, getLinkNodes } = params;
    linkSel.each(function(d) {
        const { src, tgt } = getLinkNodes(d);
        const seg = linkSegmentThroughNodeRects(src, tgt, linkEndInsetPx);
        d3.select(this)
            .selectAll('path.gen-attr-dag-link-visible')
            .attr('d', `M ${seg.x1} ${seg.y1} L ${seg.x2} ${seg.y2}`);
    });
    nodeSel.attr('transform', (d) => `translate(${d.x},${d.y})`);
}
