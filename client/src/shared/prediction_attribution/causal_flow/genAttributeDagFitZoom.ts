/** 与 {@link DagLayoutMode} 同构；独立文件避免与 view 循环依赖。 */
export type DagFitLayoutMode =
    | 'text-flow'
    | 'linear-arc'
    | 'linear-arc-step-down'
    | 'spiral'
    | 'attribution-matrix';

export type DagZoomPose = { x: number; y: number; k: number };

export type DagContentBBox = { x: number; y: number; width: number; height: number };

/** text-flow / matrix fit 内边距（与 genAttributeDagView 中常量一致）。 */
export const DAG_TEXT_FLOW_FIT_PAD_PX = 24;

/**
 * 由内容 bbox + 视口尺寸计算默认 fit 的 d3 zoom（translate + scale）。
 * 语义与 `fitViewportToContent` 各分支一致；不碰 DOM。
 */
export function computeFitZoomTransform(params: {
    mode: DagFitLayoutMode;
    contentBBox: DagContentBBox;
    viewportW: number;
    viewportH: number;
    /** 最大缩放（通常为 `defaultDagZoomK()`） */
    k0: number;
}): DagZoomPose {
    const { mode, contentBBox: b, viewportW: w, viewportH: h, k0 } = params;
    switch (mode) {
        case 'linear-arc':
        case 'linear-arc-step-down': {
            const pad = 12;
            const innerW = Math.max(w - 2 * pad, 1);
            const innerH = Math.max(h - 2 * pad, 1);
            const bw = Math.max(b.width, 1e-6);
            const kRaw = innerW / bw;
            const k = Math.min(Number.isFinite(kRaw) && kRaw > 0 ? kRaw : k0, k0);
            const tx = pad * 2 - k * b.x;
            const rowMidY = b.y + b.height / 2;
            const ty = pad + innerH / 2 - k * rowMidY;
            return { x: tx, y: ty, k };
        }
        case 'spiral': {
            const pad = 12;
            const innerW = Math.max(w - 2 * pad, 1);
            const innerH = Math.max(h - 2 * pad, 1);
            const xmin = b.x;
            const xmax = b.x + b.width;
            const ymin = b.y;
            const ymax = b.y + b.height;
            const halfW = innerW / 2;
            const halfH = innerH / 2;
            let kFromOrigin = Infinity;
            if (xmax > 0) kFromOrigin = Math.min(kFromOrigin, halfW / xmax);
            if (xmin < 0) kFromOrigin = Math.min(kFromOrigin, halfW / -xmin);
            if (ymax > 0) kFromOrigin = Math.min(kFromOrigin, halfH / ymax);
            if (ymin < 0) kFromOrigin = Math.min(kFromOrigin, halfH / -ymin);
            const bw = Math.max(b.width, 1e-6);
            const bh = Math.max(b.height, 1e-6);
            const kFromSides = Math.min(innerW / bw, innerH / bh);
            const kRaw = Number.isFinite(kFromOrigin) && kFromOrigin > 0 ? kFromOrigin : kFromSides;
            const k = Math.min(kRaw, k0);
            return { x: pad + halfW, y: pad + halfH, k };
        }
        case 'text-flow':
        case 'attribution-matrix': {
            const padTf = DAG_TEXT_FLOW_FIT_PAD_PX;
            const innerWTextFlow = Math.max(w - 2 * padTf, 1);
            const innerHTextFlow = Math.max(h - 2 * padTf, 1);
            const bw = Math.max(b.width, 1e-6);
            const bh = Math.max(b.height, 1e-6);
            const kRaw = Math.min(innerWTextFlow / bw, innerHTextFlow / bh);
            const k = Math.min(Number.isFinite(kRaw) && kRaw > 0 ? kRaw : k0, k0);
            return { x: padTf - k * b.x, y: padTf - k * b.y, k };
        }
        default: {
            const _: never = mode;
            throw new Error(`computeFitZoomTransform: unsupported mode (${String(_)})`);
        }
    }
}
