import * as d3 from 'd3';
import { linkSegmentThroughNodeRects } from './genAttributeDagLinkSegment';

type TextFlowNodeLike = {
    /** 测量层矩形左上角（1×；compactness / CI 只影响绘制偏移与尺寸） */
    x: number;
    y: number;
    nodeW: number;
    nodeH: number;
    ciVisualScale: number;
};

/** 节点在 rootG 下的绘制位姿（translate 左上角；可选统一 scale）。 */
export type DagNodeLayoutPose = {
    id: string;
    x: number;
    y: number;
    nodeW: number;
    nodeH: number;
    /** 相对节点本地原点的额外 scale；默认 1 */
    scale: number;
};

/** 位姿 → SVG transform（含 spiral 首节点的 scale 中心补偿）。 */
export function poseToTransform(p: DagNodeLayoutPose): string {
    if (p.scale !== 1) {
        return `translate(${p.x},${p.y}) scale(${p.scale}) translate(${-p.nodeW / 2},${-p.nodeH / 2})`;
    }
    return `translate(${p.x},${p.y})`;
}

/** 剥掉 CI 后的 compactness 底尺寸。 */
export function dagNodeBaseSize(d: Pick<TextFlowNodeLike, 'nodeW' | 'nodeH' | 'ciVisualScale'>): {
    baseW: number;
    baseH: number;
} {
    return { baseW: d.nodeW / d.ciVisualScale, baseH: d.nodeH / d.ciVisualScale };
}

/** {@link dagNodeBaseSize}.baseW 的简写（子词拼接等）。 */
export function dagNodeBaseWidth(d: Pick<TextFlowNodeLike, 'nodeW' | 'ciVisualScale'>): number {
    return d.nodeW / d.ciVisualScale;
}

/**
 * text-flow 绘制用左上角：
 * - compactness：在测量槽内竖直居中（水平仍贴测量左缘）
 * - CI：相对 compactness 框中心对称外扩
 */
export function dagTextFlowPaintOrigin(
    d: TextFlowNodeLike,
    displayScale: number,
): { x: number; y: number } {
    const { baseW, baseH } = dagNodeBaseSize(d);
    const measureH = baseH / displayScale;
    return {
        x: d.x - (d.nodeW - baseW) / 2,
        y: d.y + (measureH - d.nodeH) / 2,
    };
}

/** text-flow：各节点绘制 translate（左上角）。 */
export function computeTextFlowNodeRects(
    nodes: Array<TextFlowNodeLike & { id: string }>,
    displayScale: number,
): Map<string, DagNodeLayoutPose> {
    const out = new Map<string, DagNodeLayoutPose>();
    for (const d of nodes) {
        const p = dagTextFlowPaintOrigin(d, displayScale);
        out.set(d.id, {
            id: d.id,
            x: p.x,
            y: p.y,
            nodeW: d.nodeW,
            nodeH: d.nodeH,
            scale: 1,
        });
    }
    return out;
}

/** text-flow 模式：节点锚测量左上角，绘制时补偿 compactness / CI。 */
export function paintTextFlowLayout<
    LinkDatum,
    NodeDatum extends TextFlowNodeLike & { id: string },
>(params: {
    linkSel: d3.Selection<SVGGElement, LinkDatum, SVGGElement, unknown>;
    nodeSel: d3.Selection<SVGGElement, NodeDatum, SVGGElement, unknown>;
    linkEndInsetPx: number;
    displayScale: number;
    getLinkNodes: (link: LinkDatum) => { src: NodeDatum; tgt: NodeDatum };
}): void {
    const { linkSel, nodeSel, linkEndInsetPx, displayScale, getLinkNodes } = params;
    const poses = computeTextFlowNodeRects(nodeSel.data(), displayScale);
    linkSel.each(function (d) {
        const { src, tgt } = getLinkNodes(d);
        const ps = poses.get(src.id)!;
        const pt = poses.get(tgt.id)!;
        const seg = linkSegmentThroughNodeRects(
            { cx: ps.x + src.nodeW / 2, cy: ps.y + src.nodeH / 2, nodeW: src.nodeW, nodeH: src.nodeH },
            { cx: pt.x + tgt.nodeW / 2, cy: pt.y + tgt.nodeH / 2, nodeW: tgt.nodeW, nodeH: tgt.nodeH },
            linkEndInsetPx,
        );
        d3.select(this)
            .selectAll('path.gen-attr-dag-link-visible')
            .attr('d', `M ${seg.x1} ${seg.y1} L ${seg.x2} ${seg.y2}`);
    });
    nodeSel.attr('transform', (d) => {
        const p = poses.get(d.id);
        if (!p) return null;
        return `translate(${p.x},${p.y})`;
    });
}
