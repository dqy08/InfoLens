import * as d3 from 'd3';

/** 单元格边长（SVG 内部坐标 px） */
const MATRIX_CELL_SIZE = 18;
/** 格子间隙（0 = 无缝贴合） */
const MATRIX_CELL_GAP = 0;
/** 含间隙的一格步长 */
const MATRIX_CELL_PITCH = MATRIX_CELL_SIZE + MATRIX_CELL_GAP;
/** 轴标签与格子区间距 */
const MATRIX_LABEL_PAD = 6;
/** 交汇角斜分格边长（表格角标式 source / target） */
const MATRIX_AXIS_CORNER = 40;
/** 竖轴 chip 高度固定，宽度贴完整 displayLabel */
const MATRIX_V_CHIP_HEIGHT = MATRIX_CELL_SIZE - 2;
/** 横轴 chip 高度；宽度贴完整 displayLabel，一律 -45° */
const MATRIX_H_CHIP_HEIGHT = MATRIX_CELL_SIZE - 2;
/**
 * 横轴 -45°：顶左齐 / 底右齐后再水平微调（顶←、底→）。
 * 小于半格：半格已过猛。
 */
const MATRIX_H_LABEL_NUDGE = 4;

/** 与 genAttributeDagView 中 `DagNodeOpacityLevel.full` / `.weakened` 同值（矩阵只用高亮/半亮两档）。 */
export const MATRIX_TOKEN_OPACITY_FULL = 1;
export const MATRIX_TOKEN_OPACITY_WEAKENED = 0.6;

export type MatrixNodeLike = {
    id: string;
    displayLabel: string;
    isPrompt: boolean;
};

export type MatrixLinkLike = {
    source: string;
    target: string;
    /** tool_call→tool_response 合成边：矩阵用 2×2 棋盘填充，三色均最强。 */
    synthetic?: boolean;
};

/** 格子高亮态：`gray`（常态，透明度取 `grayOpacityByKey`）由 restyle 兜底，此处只表达「被点亮」两种。 */
export type MatrixCellVisual = { kind: 'blue' | 'red'; opacity: number };

/** 合成格棋盘 pattern id（defs 挂在 matrixG 内；每格 objectBoundingBox 自对齐）。 */
const MATRIX_CHECK_PATTERN = {
    gray: 'gen-attr-dag-matrix-check-gray',
    blue: 'gen-attr-dag-matrix-check-blue',
    red: 'gen-attr-dag-matrix-check-red',
} as const;

/**
 * 合成边 2×2 棋盘：左上+右下为最强色，右上+左下透明。
 * 选 2×2（非 3×3）因 18px 格下子格 9px 仍清晰，且恰好半透明/半实色。
 */
function ensureSyntheticCheckPatterns(
    matrixG: d3.Selection<SVGGElement, unknown, null, undefined>,
): void {
    const defs = matrixG.append('defs').attr('class', 'gen-attr-dag-matrix-defs');
    const specs: { id: string; color: string }[] = [
        { id: MATRIX_CHECK_PATTERN.gray, color: 'var(--dag-normal-line-color)' },
        { id: MATRIX_CHECK_PATTERN.blue, color: 'var(--dag-highlight-line-color-in)' },
        { id: MATRIX_CHECK_PATTERN.red, color: 'var(--dag-highlight-line-color-out)' },
    ];
    for (const { id, color } of specs) {
        const pattern = defs
            .append('pattern')
            .attr('id', id)
            .attr('width', 1)
            .attr('height', 1)
            .attr('patternUnits', 'objectBoundingBox')
            .attr('patternContentUnits', 'objectBoundingBox');
        pattern.append('rect').attr('width', 0.5).attr('height', 0.5).attr('fill', color);
        pattern
            .append('rect')
            .attr('x', 0.5)
            .attr('y', 0.5)
            .attr('width', 0.5)
            .attr('height', 0.5)
            .attr('fill', color);
    }
}

/** 单枚轴 chip 的视觉态；行/列分表维护，同 id 不联动。矩阵暂无多选。 */
export type MatrixTokenVisual = {
    /** solid=焦点/lock（`--selected`）；hover=悬停框（不改归因）。 */
    frame?: 'solid' | 'hover';
    fillOpacity: number;
};

export function attributionMatrixCellKey(srcId: string, tgtId: string): string {
    return `${srcId}->${tgtId}`;
}

/** 解析 `src->tgt`；非法 key 返回 null。 */
export function attributionMatrixEdgeEndpoints(key: string): { srcId: string; tgtId: string } | null {
    const i = key.indexOf('->');
    if (i <= 0 || i >= key.length - 2) return null;
    return { srcId: key.slice(0, i), tgtId: key.slice(i + 2) };
}

export type MatrixInteractionHandlers = {
    onRowEnter: (id: string) => void;
    onRowLeave: (id: string) => void;
    onRowClick: (id: string) => void;
    onColEnter: (id: string) => void;
    onColLeave: (id: string) => void;
    onColClick: (id: string) => void;
    onCellEnter: (srcId: string, tgtId: string) => void;
    onCellLeave: (srcId: string, tgtId: string) => void;
    onCellClick: (srcId: string, tgtId: string) => void;
    onBackgroundClick: () => void;
};

/** 井字坐标命中：相对 grid 原点；四角 / 无边空格 → null。 */
export type MatrixHitTarget =
    | { type: 'cell'; srcId: string; tgtId: string }
    | { type: 'row'; id: string }
    | { type: 'col'; id: string };

type MatrixHitClassifyCtx = {
    /** 目标轴长度（rowNodes）。 */
    nTgts: number;
    /** 源轴长度（colNodes）。 */
    nSrcs: number;
    /** 含 Self 时的完整格子区宽（自 0 起）。 */
    gridW: number;
    /** 含 Self 时的完整格子区高（自 0 起）。 */
    gridH: number;
    /** 主矩阵左上角 x（Self 在左侧时为一步长）。 */
    mainOriginX: number;
    /** 主矩阵左上角 y（Self 在上侧时为一步长）。 */
    mainOriginY: number;
    /** 主矩阵宽（不含 Self）。 */
    mainGridW: number;
    /** 主矩阵高（不含 Self）。 */
    mainGridH: number;
    rowNodes: MatrixNodeLike[];
    colNodes: MatrixNodeLike[];
    validEdgeKeys: ReadonlySet<string>;
    transpose: boolean;
};

function sameMatrixHit(a: MatrixHitTarget | null, b: MatrixHitTarget | null): boolean {
    if (a === b) return true;
    if (a == null || b == null || a.type !== b.type) return false;
    if (a.type === 'cell' && b.type === 'cell') {
        return a.srcId === b.srcId && a.tgtId === b.tgtId;
    }
    return a.type !== 'cell' && b.type !== 'cell' && a.id === b.id;
}

function cellOrigin(index: number): number {
    return index * (MATRIX_CELL_SIZE + MATRIX_CELL_GAP);
}

/** 横轴 -45° 标签：顶左齐 / 底右齐 + 水平微调；`width` 为沿阅读方向的占位宽。 */
function hAxisTiltTransform(
    cx: number,
    cy: number,
    width: number,
    onFarSide: boolean,
): string {
    const alignX = onFarSide ? -width : 0;
    const nudgeX = onFarSide ? MATRIX_H_LABEL_NUDGE : -MATRIX_H_LABEL_NUDGE;
    return `translate(${cx + nudgeX},${cy}) rotate(-45) translate(${alignX},${
        -MATRIX_H_CHIP_HEIGHT / 2
    })`;
}

/**
 * 井字分区（语义）：中=有边格子；源轴带=`col`；目标轴带=`row`；角=null。
 * Self 与源轴标签同侧；命中区含轴两侧外侧。
 */
export function classifyMatrixHit(x: number, y: number, ctx: MatrixHitClassifyCtx): MatrixHitTarget | null {
    const {
        nTgts,
        nSrcs,
        gridW,
        gridH,
        mainOriginX,
        mainOriginY,
        mainGridW,
        mainGridH,
        rowNodes,
        colNodes,
        validEdgeKeys,
        transpose,
    } = ctx;
    if (nTgts === 0 || nSrcs === 0) return null;

    const mainX1 = mainOriginX + mainGridW;
    const mainY1 = mainOriginY + mainGridH;
    const inFullX = x >= 0 && x < gridW;
    const inFullY = y >= 0 && y < gridH;
    const inMainX = x >= mainOriginX && x < mainX1;
    const inMainY = y >= mainOriginY && y < mainY1;

    if (transpose) {
        // 主格：x=tgt，y=src
        if (inMainX && inMainY) {
            const tgtIdx = Math.min(nTgts - 1, Math.floor((x - mainOriginX) / MATRIX_CELL_PITCH));
            const srcIdx = Math.min(nSrcs - 1, Math.floor((y - mainOriginY) / MATRIX_CELL_PITCH));
            const srcId = colNodes[srcIdx]!.id;
            const tgtId = rowNodes[tgtIdx]!.id;
            if (!validEdgeKeys.has(attributionMatrixCellKey(srcId, tgtId))) return null;
            return { type: 'cell', srcId, tgtId };
        }
        // 左/右（标签或 Self）：沿源轴 → col
        if (inFullY && !inMainX) {
            const srcIdx = Math.min(nSrcs - 1, Math.floor(y / MATRIX_CELL_PITCH));
            return { type: 'col', id: colNodes[srcIdx]!.id };
        }
        // 上/下：沿目标轴 → row（不含 Self 列）
        if (inMainX && !inMainY) {
            const tgtIdx = Math.min(nTgts - 1, Math.floor((x - mainOriginX) / MATRIX_CELL_PITCH));
            return { type: 'row', id: rowNodes[tgtIdx]!.id };
        }
        return null;
    }

    // 默认：x=src，y=tgt
    if (inMainX && inMainY) {
        const srcIdx = Math.min(nSrcs - 1, Math.floor((x - mainOriginX) / MATRIX_CELL_PITCH));
        const tgtIdx = Math.min(nTgts - 1, Math.floor((y - mainOriginY) / MATRIX_CELL_PITCH));
        const srcId = colNodes[srcIdx]!.id;
        const tgtId = rowNodes[tgtIdx]!.id;
        if (!validEdgeKeys.has(attributionMatrixCellKey(srcId, tgtId))) return null;
        return { type: 'cell', srcId, tgtId };
    }
    // 左/右：沿目标轴 → row
    if (inMainY && !inMainX) {
        const tgtIdx = Math.min(nTgts - 1, Math.floor((y - mainOriginY) / MATRIX_CELL_PITCH));
        return { type: 'row', id: rowNodes[tgtIdx]!.id };
    }
    // 上或下（含 Self）：沿源轴 → col
    if (inFullX && !inMainY) {
        const srcIdx = Math.min(nSrcs - 1, Math.floor(x / MATRIX_CELL_PITCH));
        return { type: 'col', id: colNodes[srcIdx]!.id };
    }
    return null;
}

let matrixHitDispose: (() => void) | null = null;

/** 卸下 svg 级矩阵命中（切离 matrix / reset / 重 paint 前）。 */
export function disposeMatrixPointerHit(): void {
    matrixHitDispose?.();
    matrixHitDispose = null;
}

function bindMatrixPointerHit(params: {
    svg: SVGSVGElement;
    gridNode: SVGGElement;
    ctx: MatrixHitClassifyCtx;
    handlers: MatrixInteractionHandlers;
}): void {
    disposeMatrixPointerHit();
    const { svg, gridNode, ctx, handlers } = params;
    const svgSel = d3.select(svg);
    let prev: MatrixHitTarget | null = null;

    const leave = (h: MatrixHitTarget | null) => {
        if (h == null) return;
        if (h.type === 'row') handlers.onRowLeave(h.id);
        else if (h.type === 'col') handlers.onColLeave(h.id);
        else handlers.onCellLeave(h.srcId, h.tgtId);
    };
    const enter = (h: MatrixHitTarget | null) => {
        if (h == null) return;
        if (h.type === 'row') handlers.onRowEnter(h.id);
        else if (h.type === 'col') handlers.onColEnter(h.id);
        else handlers.onCellEnter(h.srcId, h.tgtId);
    };
    const setHit = (next: MatrixHitTarget | null) => {
        if (sameMatrixHit(prev, next)) return;
        leave(prev);
        enter(next);
        prev = next;
        svg.style.cursor = next != null ? 'pointer' : '';
    };

    svgSel.on('pointermove.matrixHit', (event: PointerEvent) => {
        const [x, y] = d3.pointer(event, gridNode);
        setHit(classifyMatrixHit(x, y, ctx));
    });
    svgSel.on('pointerleave.matrixHit', () => setHit(null));
    svgSel.on('click.matrixHit', (event: PointerEvent) => {
        event.stopPropagation();
        const [x, y] = d3.pointer(event, gridNode);
        const hit = classifyMatrixHit(x, y, ctx);
        setHit(null);
        if (hit == null) handlers.onBackgroundClick();
        else if (hit.type === 'row') handlers.onRowClick(hit.id);
        else if (hit.type === 'col') handlers.onColClick(hit.id);
        else handlers.onCellClick(hit.srcId, hit.tgtId);
    });

    matrixHitDispose = () => {
        setHit(null);
        svgSel.on('.matrixHit', null);
        svg.style.cursor = '';
    };
}

/**
 * 复用 DAG 节点同一套 class（`.gen-attr-dag-node[--prompt]` + 子元素），令背景色 / 三态描边零新增 CSS 即可对齐；
 * 宽度贴完整 `displayLabel` 实测宽度（与 text-flow 一致，不截断、不加省略号）。
 */
function appendTokenChip(
    parent: d3.Selection<SVGGElement, unknown, null, undefined>,
    node: MatrixNodeLike,
    chipH: number,
): { g: d3.Selection<SVGGElement, unknown, null, undefined>; chipW: number } {
    const g = parent
        .append('g')
        .attr('class', 'gen-attr-dag-node gen-attr-dag-matrix-token')
        .classed('gen-attr-dag-node--prompt', node.isPrompt)
        .attr('data-node-id', node.id)
        .style('pointer-events', 'none');
    const text = g
        .append('text')
        .attr('class', 'gen-attr-dag-node-text')
        .attr('y', chipH / 2)
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'central')
        .text(node.displayLabel);
    const chipW = Math.max(text.node()!.getComputedTextLength(), 4);
    const rx = Math.min(chipW, chipH) / 2;
    // 与 DAG `syncNodeStrokeRects` 同配方：stroke 外扩 pad=半线宽，描边不压 fill；
    // 矩阵 chip 几何固定，线宽固定 2（见 scss），故 pad=1。
    const strokePad = 1;
    g.insert('rect', 'text')
        .attr('class', 'gen-attr-dag-node-stroke')
        .attr('x', -strokePad)
        .attr('y', -strokePad)
        .attr('width', chipW + 2 * strokePad)
        .attr('height', chipH + 2 * strokePad)
        .attr('rx', rx + strokePad)
        .attr('ry', rx + strokePad);
    g.insert('rect', 'text')
        .attr('class', 'gen-attr-dag-node-fill')
        .attr('width', chipW)
        .attr('height', chipH)
        .attr('rx', rx)
        .attr('ry', rx);
    text.attr('x', chipW / 2);
    return { g, chipW };
}

type MatrixEdgeCellDatum = {
    kind: 'edge';
    /** 目标轴索引（rowNodes）。 */
    row: number;
    /** 源轴索引（colNodes）。 */
    col: number;
    srcId: string;
    tgtId: string;
    key: string;
    hasEdge: boolean;
    synthetic: boolean;
};

type MatrixSelfCellDatum = {
    kind: 'self';
    /** 源轴索引（与 {@link restyleAttributionMatrixLayout} `selfCellOpacityByCol` 对齐）。 */
    col: number;
    nodeId: string;
};

type MatrixCellDatum = MatrixEdgeCellDatum | MatrixSelfCellDatum;

type AxisChip = {
    g: d3.Selection<SVGGElement, unknown, null, undefined>;
    chipW: number;
    node: MatrixNodeLike;
    i: number;
};

/**
 * attribution-matrix：行 = 目标（通常仅生成 token），列 = 源（含 prompt）；可矩形。
 * `transpose`：屏幕轴对调（横=目标、纵=源）。语义仍 src→tgt。
 * 轴标签侧：默认近侧（纵左 / 横上）；`switchHorizontalLabel` / `switchVerticalLabel` 翻到远侧（横下 / 纵右）。
 * Self 条带与源轴所在屏幕轴同侧；灰框线贴各轴标签侧；横轴 chip 一律 -45°（顶左齐/底右齐 + 微调）。
 * class 仍按语义 row=目标 / col=源。仅几何 + 交互绑定，不写颜色/透明度（颜色由 {@link restyleAttributionMatrixLayout} 负责）。
 */
/** 第一个语义 source token 在 matrixG 坐标中的锚点（chip 贴轴端）；供播放时视口钉住。 */
export type MatrixFirstSourceAnchor = { x: number; y: number };

export function paintAttributionMatrixLayout(params: {
    matrixG: d3.Selection<SVGGElement, unknown, null, undefined>;
    /** 坐标命中挂在此 svg（pointermove/leave/click）；勿用超大 hit rect以免撑爆 getBBox。 */
    svg: SVGSVGElement;
    rowNodes: MatrixNodeLike[];
    colNodes: MatrixNodeLike[];
    links: MatrixLinkLike[];
    handlers: MatrixInteractionHandlers;
    /** Causal Flow：展示各源 token 的 self（stay）归因；无行焦点时格为空底。 */
    showSelfRow?: boolean;
    /** 对称布局：行/列屏幕轴对调。 */
    transpose?: boolean;
    /** 横轴标签翻到远侧（下）。默认 false = 近侧（上）。 */
    switchHorizontalLabel?: boolean;
    /** 纵轴标签翻到远侧（右）。默认 false = 近侧（左）。 */
    switchVerticalLabel?: boolean;
}): MatrixFirstSourceAnchor | null {
    const {
        matrixG,
        svg,
        rowNodes,
        colNodes,
        links,
        handlers,
        showSelfRow = false,
        transpose = false,
        switchHorizontalLabel = false,
        switchVerticalLabel = false,
    } = params;
    const nTgts = rowNodes.length;
    const nSrcs = colNodes.length;
    const showSelf = showSelfRow;

    disposeMatrixPointerHit();
    matrixG.selectAll('*').remove();
    ensureSyntheticCheckPatterns(matrixG);

    // 列序即因果序；边 src→tgt 要求两者皆在列轴上且 src 更早（tgt 为生成 token 时也在列轴）。
    const colIndexById = new Map<string, number>();
    for (let i = 0; i < nSrcs; i++) colIndexById.set(colNodes[i]!.id, i);
    const rowIndexById = new Map<string, number>();
    for (let i = 0; i < nTgts; i++) rowIndexById.set(rowNodes[i]!.id, i);

    const validEdgeKeys = new Set<string>();
    const syntheticEdgeKeys = new Set<string>();
    for (const link of links) {
        const si = colIndexById.get(link.source);
        const tiCol = colIndexById.get(link.target);
        const tiRow = rowIndexById.get(link.target);
        if (si === undefined || tiCol === undefined || tiRow === undefined || si >= tiCol) continue;
        const key = attributionMatrixCellKey(link.source, link.target);
        validEdgeKeys.add(key);
        if (link.synthetic === true) syntheticEdgeKeys.add(key);
    }

    // 竖轴 / 横轴：样子跟屏幕轴走，class 跟语义走（row=目标，col=源）。
    const vAxisNodes = transpose ? colNodes : rowNodes;
    const hAxisNodes = transpose ? rowNodes : colNodes;
    const vAxisIsRowToken = !transpose;
    const hAxisIsRowToken = transpose;
    // 远侧：纵右 / 横下；近侧：纵左 / 横上。Self 跟源轴所在屏幕轴的标签侧。
    const vOnFarSide = switchVerticalLabel;
    const hOnFarSide = switchHorizontalLabel;
    const selfOnFarSide = transpose ? switchVerticalLabel : switchHorizontalLabel;

    const vLabels = matrixG.append('g').attr('class', 'gen-attr-dag-matrix-row-labels');
    const hLabels = matrixG.append('g').attr('class', 'gen-attr-dag-matrix-col-labels');
    const vChips: AxisChip[] = [];
    const hChips: AxisChip[] = [];
    for (let i = 0; i < vAxisNodes.length; i++) {
        const node = vAxisNodes[i]!;
        const { g, chipW } = appendTokenChip(vLabels, node, MATRIX_V_CHIP_HEIGHT);
        vChips.push({ g, chipW, node, i });
    }
    for (let i = 0; i < hAxisNodes.length; i++) {
        const node = hAxisNodes[i]!;
        const { g, chipW } = appendTokenChip(hLabels, node, MATRIX_H_CHIP_HEIGHT);
        hChips.push({ g, chipW, node, i });
    }

    const mainHCount = transpose ? nSrcs : nTgts;
    const mainWCount = transpose ? nTgts : nSrcs;
    const fullWCount = mainWCount + (showSelf && transpose ? 1 : 0);
    const fullHCount = mainHCount + (showSelf && !transpose ? 1 : 0);

    const mainGridW = mainWCount > 0 ? mainWCount * MATRIX_CELL_PITCH - MATRIX_CELL_GAP : 0;
    const mainGridH = mainHCount > 0 ? mainHCount * MATRIX_CELL_PITCH - MATRIX_CELL_GAP : 0;
    const gridW = fullWCount > 0 ? fullWCount * MATRIX_CELL_PITCH - MATRIX_CELL_GAP : 0;
    const gridH = fullHCount > 0 ? fullHCount * MATRIX_CELL_PITCH - MATRIX_CELL_GAP : 0;
    // Self 在近侧时占满格区起点，主矩阵让出一步长。
    const mainOriginX = showSelf && transpose && !selfOnFarSide ? MATRIX_CELL_PITCH : 0;
    const mainOriginY = showSelf && !transpose && !selfOnFarSide ? MATRIX_CELL_PITCH : 0;
    const selfOriginX = showSelf && transpose ? (selfOnFarSide ? mainGridW + MATRIX_CELL_GAP : 0) : 0;
    const selfOriginY = showSelf && !transpose ? (selfOnFarSide ? mainGridH + MATRIX_CELL_GAP : 0) : 0;

    const grid = matrixG
        .append('g')
        .attr('class', 'gen-attr-dag-matrix-grid');

    // 网格底：空格同色。Hide inactive 时灰格透明，透出此底而非略亮的 stack。
    if (gridW > 0 && gridH > 0) {
        grid
            .append('rect')
            .attr('class', 'gen-attr-dag-matrix-grid-bg')
            .attr('width', gridW)
            .attr('height', gridH)
            .attr('fill', 'var(--gen-attr-dag-matrix-cell-empty)')
            .style('pointer-events', 'none');
    }

    const cells: MatrixCellDatum[] = [];
    for (let row = 0; row < nTgts; row++) {
        for (let col = 0; col < nSrcs; col++) {
            const srcId = colNodes[col]!.id;
            const tgtId = rowNodes[row]!.id;
            const key = attributionMatrixCellKey(srcId, tgtId);
            cells.push({
                kind: 'edge',
                row,
                col,
                srcId,
                tgtId,
                key,
                hasEdge: validEdgeKeys.has(key),
                synthetic: syntheticEdgeKeys.has(key),
            });
        }
    }
    if (showSelf) {
        for (let col = 0; col < nSrcs; col++) {
            cells.push({
                kind: 'self',
                col,
                nodeId: colNodes[col]!.id,
            });
        }
    }

    const edgeCellXY = (srcIdx: number, tgtIdx: number) =>
        transpose
            ? {
                  x: mainOriginX + cellOrigin(tgtIdx),
                  y: mainOriginY + cellOrigin(srcIdx),
              }
            : {
                  x: mainOriginX + cellOrigin(srcIdx),
                  y: mainOriginY + cellOrigin(tgtIdx),
              };
    const selfCellXY = (srcIdx: number) =>
        transpose
            ? { x: selfOriginX, y: cellOrigin(srcIdx) }
            : { x: cellOrigin(srcIdx), y: selfOriginY };

    const edgeCells = cells.filter((d): d is MatrixEdgeCellDatum => d.kind === 'edge');
    const edgeCellSel = grid
        .selectAll<SVGRectElement, MatrixEdgeCellDatum>('rect.gen-attr-dag-matrix-cell--edge')
        .data(edgeCells)
        .join('rect')
        .attr('class', 'gen-attr-dag-matrix-cell')
        .attr('x', (d) => edgeCellXY(d.col, d.row).x)
        .attr('y', (d) => edgeCellXY(d.col, d.row).y)
        .attr('width', MATRIX_CELL_SIZE)
        .attr('height', MATRIX_CELL_SIZE);
    // 命中由 svg 坐标分类；格子仅绘制
    edgeCellSel.style('pointer-events', 'none');

    if (showSelf) {
        const selfCells = cells.filter((d): d is MatrixSelfCellDatum => d.kind === 'self');
        grid
            .selectAll<SVGRectElement, MatrixSelfCellDatum>('rect.gen-attr-dag-matrix-self-cell')
            .data(selfCells)
            .join('rect')
            .attr('class', 'gen-attr-dag-matrix-cell gen-attr-dag-matrix-self-cell')
            .attr('x', (d) => selfCellXY(d.col).x)
            .attr('y', (d) => selfCellXY(d.col).y)
            .attr('width', MATRIX_CELL_SIZE)
            .attr('height', MATRIX_CELL_SIZE)
            .style('pointer-events', 'none');
    }

    if (gridW > 0 && gridH > 0) {
        // 灰框线贴标签侧外缘；Self 分隔线在 Self 与主矩阵交界
        const vFrameX = vOnFarSide ? gridW + 0.5 : -0.5;
        const hFrameY = hOnFarSide ? gridH + 0.5 : -0.5;
        const framePaths = [
            `M ${-0.5} ${hFrameY} H ${gridW + 0.5}`,
            `M ${vFrameX} ${-0.5} V ${gridH + 0.5}`,
        ];
        if (showSelf) {
            if (transpose) {
                const sepX = selfOnFarSide
                    ? mainOriginX + mainGridW - 0.5
                    : MATRIX_CELL_PITCH - 0.5;
                framePaths.push(`M ${sepX} ${-0.5} V ${gridH + 0.5}`);
            } else {
                const sepY = selfOnFarSide
                    ? mainOriginY + mainGridH - 0.5
                    : MATRIX_CELL_PITCH - 0.5;
                framePaths.push(`M ${-0.5} ${sepY} H ${gridW + 0.5}`);
            }
        }
        grid
            .append('path')
            .attr('class', 'gen-attr-dag-matrix-frame')
            .attr('d', framePaths.join(' '))
            .attr('fill', 'none')
            .style('pointer-events', 'none');
    }

    for (const { g, chipW, i } of vChips) {
        const chipX = vOnFarSide
            ? gridW + MATRIX_LABEL_PAD
            : -MATRIX_LABEL_PAD - chipW;
        // 纵轴节点跟主矩阵行对齐（转置时源轴无 Self 纵向偏移）
        const chipY =
            (transpose ? 0 : mainOriginY) +
            cellOrigin(i) +
            (MATRIX_CELL_SIZE - MATRIX_V_CHIP_HEIGHT) / 2;
        g.attr('transform', `translate(${chipX},${chipY})`)
            .classed('gen-attr-dag-matrix-row-token', vAxisIsRowToken)
            .classed('gen-attr-dag-matrix-col-token', !vAxisIsRowToken);
    }

    // 横轴 chip：与 Self 顶/底文案共用 {@link hAxisTiltTransform}
    for (const { g, chipW, i } of hChips) {
        const cx =
            (transpose ? mainOriginX : 0) + cellOrigin(i) + MATRIX_CELL_SIZE / 2;
        const cy = hOnFarSide ? gridH + MATRIX_LABEL_PAD : -MATRIX_LABEL_PAD;
        g.attr('transform', hAxisTiltTransform(cx, cy, chipW, hOnFarSide))
            .classed('gen-attr-dag-matrix-row-token', hAxisIsRowToken)
            .classed('gen-attr-dag-matrix-col-token', !hAxisIsRowToken);
    }

    // 交汇角：45° 斜线分割，靠横轴一侧 / 靠纵轴一侧分标（表格角标）
    if (vChips.length > 0 && hChips.length > 0 && gridW > 0 && gridH > 0) {
        const cornerX = vOnFarSide ? gridW : 0;
        const cornerY = hOnFarSide ? gridH : 0;
        const ox = vOnFarSide ? 1 : -1;
        const oy = hOnFarSide ? 1 : -1;
        const s = MATRIX_AXIS_CORNER;
        const hTitle = transpose ? 'target' : 'source';
        const vTitle = transpose ? 'source' : 'target';
        const cornerG = matrixG
            .append('g')
            .attr('class', 'gen-attr-dag-matrix-axis-corner')
            .style('pointer-events', 'none');
        // 斜线：格子角 → 外侧角（正方形对角，恒 45°；另一对角会把 source/target 分区反掉）
        cornerG
            .append('line')
            .attr('class', 'gen-attr-dag-matrix-axis-corner-line')
            .attr('x1', cornerX)
            .attr('y1', cornerY)
            .attr('x2', cornerX + ox * s)
            .attr('y2', cornerY + oy * s);
        cornerG
            .append('text')
            .attr('class', 'gen-attr-dag-matrix-axis-title')
            .attr('text-anchor', 'middle')
            .attr('dominant-baseline', 'central')
            .attr('x', cornerX + ox * s * 0.36)
            .attr('y', cornerY + oy * s * 0.72)
            .text(hTitle);
        cornerG
            .append('text')
            .attr('class', 'gen-attr-dag-matrix-axis-title')
            .attr('text-anchor', 'middle')
            .attr('dominant-baseline', 'central')
            .attr('x', cornerX + ox * s * 0.72)
            .attr('y', cornerY + oy * s * 0.36)
            .text(vTitle);
    }

    if (showSelf) {
        // Self：顶/底与横轴 token 同一套 tilt；左/右贴纵轴水平排布
        if (transpose) {
            const cx = selfOriginX + MATRIX_CELL_SIZE / 2;
            const cy = hOnFarSide ? gridH + MATRIX_LABEL_PAD : -MATRIX_LABEL_PAD;
            const t = hLabels
                .append('text')
                .attr('class', 'gen-attr-dag-matrix-self-label')
                .attr('text-anchor', 'middle')
                .attr('dominant-baseline', 'central')
                .text('Self');
            const selfW = Math.max(t.node()!.getComputedTextLength(), 4);
            t.attr('x', selfW / 2)
                .attr('y', MATRIX_H_CHIP_HEIGHT / 2)
                .attr('transform', hAxisTiltTransform(cx, cy, selfW, hOnFarSide));
        } else {
            vLabels
                .append('text')
                .attr('class', 'gen-attr-dag-matrix-self-label')
                .attr('text-anchor', vOnFarSide ? 'start' : 'end')
                .attr('dominant-baseline', 'central')
                .attr('x', vOnFarSide ? gridW + MATRIX_LABEL_PAD : -MATRIX_LABEL_PAD)
                .attr('y', selfOriginY + MATRIX_CELL_SIZE / 2)
                .text('Self');
        }
    }

    const gridNode = grid.node();
    if (gridNode == null) {
        throw new Error('paintAttributionMatrixLayout: matrix grid node missing');
    }
    bindMatrixPointerHit({
        svg,
        gridNode,
        ctx: {
            nTgts,
            nSrcs,
            gridW,
            gridH,
            mainOriginX,
            mainOriginY,
            mainGridW,
            mainGridH,
            rowNodes,
            colNodes,
            validEdgeKeys,
            transpose,
        },
        handlers,
    });

    if (nSrcs === 0) return null;
    // source 在横轴：贴轴点为列中心；在纵轴：贴轴点为 chip 靠格子一侧的边。
    return transpose
        ? {
              x: vOnFarSide ? gridW + MATRIX_LABEL_PAD : -MATRIX_LABEL_PAD,
              y: cellOrigin(0) + (MATRIX_CELL_SIZE - MATRIX_V_CHIP_HEIGHT) / 2,
          }
        : {
              x: cellOrigin(0) + MATRIX_CELL_SIZE / 2,
              y: hOnFarSide ? gridH + MATRIX_LABEL_PAD : -MATRIX_LABEL_PAD,
          };
}

/**
 * 按当前交互态重上色：格子 gray/blue/red + 透明度；行/列轴 chip 各用各的 visual（同 id 不联动）。
 * 不重建 DOM，仅由 {@link paintAttributionMatrixLayout} 建立的骨架上按 datum / data-node-id 复选。
 */
export function restyleAttributionMatrixLayout(params: {
    matrixG: d3.Selection<SVGGElement, unknown, null, undefined>;
    grayOpacityByKey: Map<string, number>;
    cellVisualByKey: Map<string, MatrixCellVisual>;
    rowTokenVisualById: Map<string, MatrixTokenVisual>;
    colTokenVisualById: Map<string, MatrixTokenVisual>;
    /** Self：源轴索引 → 蓝格同尺度 opacity（{@link buildMaxNormalizedRenderStrengthByKey}）。 */
    selfCellOpacityByCol?: Map<number, number>;
}): void {
    const {
        matrixG,
        grayOpacityByKey,
        cellVisualByKey,
        rowTokenVisualById,
        colTokenVisualById,
        selfCellOpacityByCol,
    } = params;

    matrixG
        .selectAll<SVGRectElement, MatrixCellDatum>('rect.gen-attr-dag-matrix-cell')
        .each(function (d) {
            const el = d3.select(this);
            if (d.kind === 'self') {
                const opacity = selfCellOpacityByCol?.get(d.col) ?? 0;
                // 不用 --inactive：Hide inactive edges 仅作用于灰格/灰边，Self 始终可见。
                el.classed('gen-attr-dag-matrix-cell--inactive', false);
                if (opacity <= 0) {
                    el.attr('fill', 'var(--gen-attr-dag-matrix-cell-empty)').attr('opacity', 1);
                } else {
                    el.attr('fill', 'var(--dag-highlight-line-color-in)').attr('opacity', opacity);
                }
                return;
            }
            if (!d.hasEdge) {
                el.classed('gen-attr-dag-matrix-cell--inactive', false)
                    .attr('fill', 'var(--gen-attr-dag-matrix-cell-empty)')
                    .attr('opacity', 1);
                return;
            }
            const override = cellVisualByKey.get(d.key);
            if (d.synthetic) {
                // 合成边：灰/蓝/红均最强色 + 2×2 棋盘（半格透明），不跟 API 边透明度公式。
                const kind = override?.kind ?? 'gray';
                el.classed('gen-attr-dag-matrix-cell--inactive', kind === 'gray')
                    .attr('fill', `url(#${MATRIX_CHECK_PATTERN[kind]})`)
                    .attr('opacity', 1);
                return;
            }
            if (override) {
                el.classed('gen-attr-dag-matrix-cell--inactive', false)
                    .attr(
                        'fill',
                        override.kind === 'blue'
                            ? 'var(--dag-highlight-line-color-in)'
                            : 'var(--dag-highlight-line-color-out)',
                    )
                    .attr('opacity', override.opacity);
            } else {
                // 灰格 = text 的 inactive 边；Hide inactive edges 时透明，透出 grid-bg。
                el.classed('gen-attr-dag-matrix-cell--inactive', true)
                    .attr('fill', 'var(--dag-normal-line-color)')
                    .attr('opacity', grayOpacityByKey.get(d.key) ?? 0);
            }
        });

    matrixG.selectAll<SVGGElement, unknown>('g.gen-attr-dag-matrix-token').each(function () {
        const el = d3.select(this);
        const id = el.attr('data-node-id');
        const byAxis = el.classed('gen-attr-dag-matrix-row-token')
            ? rowTokenVisualById
            : el.classed('gen-attr-dag-matrix-col-token')
              ? colTokenVisualById
              : null;
        const visual = byAxis?.get(id) ?? { fillOpacity: MATRIX_TOKEN_OPACITY_FULL };
        el.classed('gen-attr-dag-node--selected', visual.frame === 'solid');
        el.classed('gen-attr-dag-node--hover', visual.frame === 'hover');
        el.select('rect.gen-attr-dag-node-fill').attr('opacity', visual.fillOpacity);
        el.select('text.gen-attr-dag-node-text').attr('opacity', visual.fillOpacity);
    });
}
