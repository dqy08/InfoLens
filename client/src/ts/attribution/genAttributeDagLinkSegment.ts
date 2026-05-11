/** 轴对齐矩形节点：用于连线从边界起止，以矩形中心坐标表示。 */
export type DagLinkRectNode = {
    cx: number;
    cy: number;
    nodeW: number;
    nodeH: number;
};

function nodeCenter(n: DagLinkRectNode): { cx: number; cy: number } {
    return { cx: n.cx, cy: n.cy };
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

/** 两节点矩形边界之间的线段，端点可再回缩 `outsideInset`（与 text-flow 一致）。 */
export function linkSegmentThroughNodeRects(
    src: DagLinkRectNode,
    tgt: DagLinkRectNode,
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
