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

/** text-flow 模式：节点锚测量左上角，绘制时补偿 compactness / CI。 */
export function paintTextFlowLayout<LinkDatum, NodeDatum extends TextFlowNodeLike>(params: {
    linkSel: d3.Selection<SVGGElement, LinkDatum, SVGGElement, unknown>;
    nodeSel: d3.Selection<SVGGElement, NodeDatum, SVGGElement, unknown>;
    linkEndInsetPx: number;
    displayScale: number;
    getLinkNodes: (link: LinkDatum) => { src: NodeDatum; tgt: NodeDatum };
}): void {
    const { linkSel, nodeSel, linkEndInsetPx, displayScale, getLinkNodes } = params;
    linkSel.each(function(d) {
        const { src, tgt } = getLinkNodes(d);
        const ps = dagTextFlowPaintOrigin(src, displayScale);
        const pt = dagTextFlowPaintOrigin(tgt, displayScale);
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
        const p = dagTextFlowPaintOrigin(d, displayScale);
        return `translate(${p.x},${p.y})`;
    });
}
