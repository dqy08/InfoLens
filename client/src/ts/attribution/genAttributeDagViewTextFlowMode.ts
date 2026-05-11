import * as d3 from 'd3';
import { linkSegmentThroughNodeRects } from './genAttributeDagLinkSegment';

type TextFlowNodeLike = {
    cx: number;
    cy: number;
    nodeW: number;
    nodeH: number;
};

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
    nodeSel.attr('transform', (d) => `translate(${d.cx - d.nodeW / 2},${d.cy - d.nodeH / 2})`);
}
