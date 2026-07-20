import { easePoly } from 'd3';
import {
    poseToTransform,
    type DagNodeLayoutPose,
} from './genAttributeDagViewTextFlowMode';
import type { DagZoomPose } from './genAttributeDagFitZoom';
import { matrixColElementKey, matrixRowElementKey } from './genAttributeDagViewMatrixMode';

export { poseToTransform };

export const DAG_LAYOUT_TRANSITION_MS = 1000;

/** layout 转场共用 ease：poly InOut，exponent=2（同 easeQuadInOut）。 */
const easeLayoutTransition = easePoly.exponent(2);

/**
 * fly 条数上限：按边强度降序截断，控制转场 DOM。
 * 图↔矩阵、直线边↔直线边共用。
 */
export const DAG_LAYOUT_TRANSITION_FLY_MAX = 512;

/**
 * 边↔格 fly：图侧细条默认厚度（rootG px）。
 * 运行时应以真实边 `stroke-width`（`2 × displayScale`）传入 `thickPx`，避免与稳态边粗细突变。
 * 长度用整条边弦长，再插值到格子边长（见 {@link edgeFlyPoseFromPathTangent}）。
 */
export const DAG_LAYOUT_TRANSITION_EDGE_SEED_THICK_PX = 2;

export function dagLayoutNodeKey(id: string): string {
    return `node:${id}`;
}

export type DagLayoutElementKind = 'graph' | 'matrix';

/** 一次飞位：一个起点元素 → 一个终点元素（1→N 时拆成多条）。 */
export type DagLayoutTransitionPair = {
    fromKey: string;
    toKey: string;
    from: DagNodeLayoutPose;
    to: DagNodeLayoutPose;
};

/**
 * 边↔格 fly 位姿：中心 + 宽高 + 转角（度）+ 亮度 + 箭头显隐 + 色。
 * 局部 x 为条带长边；`angleDeg=0` 时 w 水平。
 * `opacity`：图侧 stroke-opacity、格侧 cell opacity。理论上起终点同源强度应一致；
 * 合成边 / 播放乘数等特例可能不同，故仍插值（开销可忽略）。
 * `color`：图侧 stroke / 格侧 fill（含焦点蓝红与 pattern）；转场中焦点色不变，不插值。
 * `dashed` / `dashOn` / `dashOff`：合成边虚线（见下「合成边虚线」）。
 * `arrowScale`：图侧 1、格侧 0；末端箭头随其缩放淡出（反向淡入）。
 * `arrowTwistDeg`：箭头相对条带的附加转角（弧边末端切线 − 弦角；格侧 0）。
 */
export type DagLayoutFlyPose = {
    id: string;
    cx: number;
    cy: number;
    w: number;
    h: number;
    angleDeg: number;
    opacity: number;
    color: string;
    dashed: boolean;
    dashOn: number;
    dashOff: number;
    arrowScale: number;
    arrowTwistDeg: number;
};

/** fly 默认色（与稳态普通边一致）。 */
export const DAG_LAYOUT_FLY_DEFAULT_COLOR = 'var(--dag-normal-line-color)';

/**
 * 合成边虚线（fly）：
 * - 周期对齐稳态 scss `8×compactness / 6×compactness`，写入 pose 用户单位（非固定 CSS px）。
 * - 与 w/h 一并经 {@link remapFlyPoseAcrossZoom} 乘 sk/ek，钉终态 zoom 后屏幕密度与起点一致。
 * - 边↔格时线宽锁图侧边粗（避免矩阵→图用格高当 stroke-width）；长度/位姿仍插值。
 */
export const DAG_LAYOUT_FLY_DASH_ON_PER_SCALE = 8;
export const DAG_LAYOUT_FLY_DASH_OFF_PER_SCALE = 6;

/** 捕获时本地 zoom 下的虚线周期。 */
export function flySyntheticDashPair(displayScale: number): { dashOn: number; dashOff: number } {
    const s = displayScale > 0 && Number.isFinite(displayScale) ? displayScale : 0.5;
    return {
        dashOn: DAG_LAYOUT_FLY_DASH_ON_PER_SCALE * s,
        dashOff: DAG_LAYOUT_FLY_DASH_OFF_PER_SCALE * s,
    };
}

export type DagLayoutFlyPair = {
    fromKey: string;
    toKey: string;
    from: DagLayoutFlyPose;
    to: DagLayoutFlyPose;
};

export function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

export function lerpPose(from: DagNodeLayoutPose, to: DagNodeLayoutPose, t: number): DagNodeLayoutPose {
    return {
        id: to.id,
        x: lerp(from.x, to.x, t),
        y: lerp(from.y, to.y, t),
        nodeW: lerp(from.nodeW, to.nodeW, t),
        nodeH: lerp(from.nodeH, to.nodeH, t),
        scale: lerp(from.scale, to.scale, t),
    };
}

/**
 * 将 `fromZoom` 下的 rootG 位姿，改写为在 `toZoom` 下屏幕位置与表观尺寸不变的等价位姿。
 * d3 zoom：`translate(tx,ty) scale(k)` ⇒ 屏幕 = (local·k + t)。
 * 用于转场：先钉死终态视口，再在终态坐标系里插值节点（边/格不再随 zoom 漂移）。
 */
export function remapPoseAcrossZoom(
    pose: DagNodeLayoutPose,
    fromZoom: DagZoomPose,
    toZoom: DagZoomPose,
): DagNodeLayoutPose {
    const sk = fromZoom.k;
    const ek = toZoom.k;
    if (!(sk > 0) || !(ek > 0) || !Number.isFinite(sk) || !Number.isFinite(ek)) {
        throw new Error(
            `remapPoseAcrossZoom: invalid zoom k (from=${String(fromZoom.k)}, to=${String(toZoom.k)})`,
        );
    }
    const sizeScale = sk / ek;
    return {
        id: pose.id,
        x: (pose.x * sk + fromZoom.x - toZoom.x) / ek,
        y: (pose.y * sk + fromZoom.y - toZoom.y) / ek,
        nodeW: pose.nodeW * sizeScale,
        nodeH: pose.nodeH * sizeScale,
        scale: pose.scale,
    };
}

export function remapPosesAcrossZoom(
    poses: Map<string, DagNodeLayoutPose>,
    fromZoom: DagZoomPose,
    toZoom: DagZoomPose,
): Map<string, DagNodeLayoutPose> {
    const out = new Map<string, DagNodeLayoutPose>();
    for (const [key, p] of poses) {
        out.set(key, remapPoseAcrossZoom(p, fromZoom, toZoom));
    }
    return out;
}

/** 最短角路径插值（度）。 */
export function lerpAngleDeg(a: number, b: number, t: number): number {
    let delta = b - a;
    while (delta > 180) delta -= 360;
    while (delta < -180) delta += 360;
    return a + delta * t;
}

export function lerpFlyPose(
    from: DagLayoutFlyPose,
    to: DagLayoutFlyPose,
    t: number,
): DagLayoutFlyPose {
    return {
        id: to.id,
        cx: lerp(from.cx, to.cx, t),
        cy: lerp(from.cy, to.cy, t),
        w: lerp(from.w, to.w, t),
        h: lerp(from.h, to.h, t),
        angleDeg: lerpAngleDeg(from.angleDeg, to.angleDeg, t),
        opacity: lerp(from.opacity, to.opacity, t),
        // 焦点色集合不变：取图侧（有箭头）或 from
        color: from.arrowScale >= to.arrowScale ? from.color : to.color,
        dashed: from.dashed || to.dashed,
        dashOn: lerp(from.dashOn, to.dashOn, t),
        dashOff: lerp(from.dashOff, to.dashOff, t),
        arrowScale: lerp(from.arrowScale, to.arrowScale, t),
        arrowTwistDeg: lerpAngleDeg(from.arrowTwistDeg, to.arrowTwistDeg, t),
    };
}

/** 均匀 zoom 下转角与 opacity 不变；中心与尺寸按 sk/ek 改写。 */
export function remapFlyPoseAcrossZoom(
    pose: DagLayoutFlyPose,
    fromZoom: DagZoomPose,
    toZoom: DagZoomPose,
): DagLayoutFlyPose {
    const sk = fromZoom.k;
    const ek = toZoom.k;
    if (!(sk > 0) || !(ek > 0) || !Number.isFinite(sk) || !Number.isFinite(ek)) {
        throw new Error(
            `remapFlyPoseAcrossZoom: invalid zoom k (from=${String(fromZoom.k)}, to=${String(toZoom.k)})`,
        );
    }
    const sizeScale = sk / ek;
    return {
        id: pose.id,
        cx: (pose.cx * sk + fromZoom.x - toZoom.x) / ek,
        cy: (pose.cy * sk + fromZoom.y - toZoom.y) / ek,
        w: pose.w * sizeScale,
        h: pose.h * sizeScale,
        angleDeg: pose.angleDeg,
        opacity: pose.opacity,
        color: pose.color,
        dashed: pose.dashed,
        dashOn: pose.dashOn * sizeScale,
        dashOff: pose.dashOff * sizeScale,
        arrowScale: pose.arrowScale,
        arrowTwistDeg: pose.arrowTwistDeg,
    };
}

export function remapFlyPosesAcrossZoom(
    poses: Map<string, DagLayoutFlyPose>,
    fromZoom: DagZoomPose,
    toZoom: DagZoomPose,
): Map<string, DagLayoutFlyPose> {
    const out = new Map<string, DagLayoutFlyPose>();
    for (const [key, p] of poses) {
        out.set(key, remapFlyPoseAcrossZoom(p, fromZoom, toZoom));
    }
    return out;
}

/** `translate(cx,cy) rotate(θ) translate(-w/2,-h/2)`，供子 rect 用局部 (0,0)-(w,h)。 */
export function flyPoseTransform(p: DagLayoutFlyPose): string {
    return `translate(${p.cx},${p.cy}) rotate(${p.angleDeg}) translate(${-p.w / 2},${-p.h / 2})`;
}

/**
 * fly 末端箭头挂点：原点 = path 终点 `(w,h/2)`（同 marker ref），
 * 再 `rotate(twist) scale(…)`。
 *
 * `layoutThickPx`：创建嵌套 svg 时用的厚度。边↔边时条带 h 会随 zoom remap 从 from→to 变，
 * 须再乘 `p.h / layoutThickPx`，否则末帧箭头仍停在起点厚度，交接真实 marker 会突变。
 * 边↔格时箭头厚度应锁在图侧（创建时已用图侧 h），不要跟格子边长一起胀，故默认不跟 h 缩放。
 */
export function flyArrowTransform(
    p: DagLayoutFlyPose,
    layoutThickPx?: number,
): string {
    const thickScale =
        layoutThickPx != null && layoutThickPx > 0 ? p.h / layoutThickPx : 1;
    return `translate(${p.w},${p.h / 2}) rotate(${p.arrowTwistDeg}) scale(${p.arrowScale * thickScale})`;
}

/** 边↔边（两端皆有箭头）时箭头厚度跟条带 h 走；边↔格则锁创建时厚度。 */
export function flyArrowTracksPoseHeight(from: DagLayoutFlyPose, to: DagLayoutFlyPose): boolean {
    return from.arrowScale > 0 && to.arrowScale > 0;
}

/** 与 view `MARKER_SIZE` / `MARKER_VW` / `MARKER_HALF_H` / `refX=0.8·VW` 对齐 */
export const DAG_LAYOUT_TRANSITION_FLY_ARROW_MARKER_SIZE = 4;
const FLY_ARROW_VW = 10;
const FLY_ARROW_HALF_H = 5;
const FLY_ARROW_REF_X_FRAC = 0.8;

/**
 * 嵌套 svg 复现稳态 `<marker>`：同 viewBox / path / stroke-width，且 overflow 裁切描边。
 * 原点在 path 终点；`x/y/size` 为挂点局部坐标（再经 {@link flyArrowTransform}）。
 */
export function flyArrowMarkerLayout(thickPx: number): {
    x: number;
    y: number;
    size: number;
    viewBox: string;
    pathD: string;
    strokeWidth: number;
} {
    const sw = Math.max(0, thickPx);
    const size = DAG_LAYOUT_TRANSITION_FLY_ARROW_MARKER_SIZE * sw;
    return {
        x: -FLY_ARROW_REF_X_FRAC * size,
        y: -size / 2,
        size,
        viewBox: `0 -${FLY_ARROW_HALF_H} ${FLY_ARROW_VW} ${FLY_ARROW_HALF_H * 2}`,
        pathD: `M0,-${FLY_ARROW_HALF_H} L${FLY_ARROW_VW},0 L0,${FLY_ARROW_HALF_H}`,
        strokeWidth: FLY_ARROW_VW / DAG_LAYOUT_TRANSITION_FLY_ARROW_MARKER_SIZE,
    };
}

/** 弧边：箭头相对弦的扭转角（度）= 末端切线角 − 弦角。 */
export function flyArrowTwistFromAngles(chordAngleDeg: number, endTangentAngleDeg: number): number {
    let d = endTangentAngleDeg - chordAngleDeg;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
}

/**
 * 由边的几何构造图侧细条：长边 = 弦长（端点距），方向 = 端点连线，厚度≈描边。
 * 转场中 `w/h` 会插值到格子尺寸，故长度须用整边而非固定短段。
 * `tangent` 零向量时 angle=0、长度退化为厚度。
 */
export function edgeFlyPoseFromPathTangent(params: {
    id: string;
    midX: number;
    midY: number;
    tanX: number;
    tanY: number;
    /** 边的可视长度（通常为端点弦长） */
    pathLength: number;
    thickPx?: number;
    opacity?: number;
    /** 图侧 stroke（含焦点色）；默认普通边色 */
    color?: string;
    /** 合成边：虚线条带 */
    dashed?: boolean;
    /** 虚线周期（本地用户单位）；`dashed` 时必填正值 */
    dashOn?: number;
    dashOff?: number;
    /** 箭头相对弦的扭转（末端切线 − 弦）；直线边为 0 */
    arrowTwistDeg?: number;
}): DagLayoutFlyPose {
    const thick = params.thickPx ?? DAG_LAYOUT_TRANSITION_EDGE_SEED_THICK_PX;
    const tanLen = Math.hypot(params.tanX, params.tanY);
    const angleDeg =
        tanLen > 1e-6 ? (Math.atan2(params.tanY, params.tanX) * 180) / Math.PI : 0;
    const along = Math.max(thick, params.pathLength);
    const opacity = params.opacity ?? 1;
    const twist = params.arrowTwistDeg ?? 0;
    const dashed = params.dashed === true;
    const dashOn = dashed && params.dashOn != null && params.dashOn > 0 ? params.dashOn : 0;
    const dashOff = dashed && params.dashOff != null && params.dashOff > 0 ? params.dashOff : 0;
    return {
        id: params.id,
        cx: params.midX,
        cy: params.midY,
        w: along,
        h: thick,
        angleDeg,
        opacity: opacity >= 0 && Number.isFinite(opacity) ? opacity : 1,
        color: params.color?.trim() || DAG_LAYOUT_FLY_DEFAULT_COLOR,
        dashed,
        dashOn,
        dashOff,
        arrowScale: 1,
        arrowTwistDeg: Number.isFinite(twist) ? twist : 0,
    };
}

/** 矩阵格子 → 无转角方块（中心制）。 */
export function cellFlyPoseFromRect(params: {
    id: string;
    x: number;
    y: number;
    w: number;
    h: number;
    opacity?: number;
    /** 格侧 fill（含焦点色 / 棋盘 pattern）；默认普通边色 */
    color?: string;
    /** 合成格：转场条带仍用虚线（棋盘稳态另议） */
    dashed?: boolean;
    dashOn?: number;
    dashOff?: number;
}): DagLayoutFlyPose {
    const opacity = params.opacity ?? 1;
    const dashed = params.dashed === true;
    const dashOn = dashed && params.dashOn != null && params.dashOn > 0 ? params.dashOn : 0;
    const dashOff = dashed && params.dashOff != null && params.dashOff > 0 ? params.dashOff : 0;
    return {
        id: params.id,
        cx: params.x + params.w / 2,
        cy: params.y + params.h / 2,
        w: params.w,
        h: params.h,
        angleDeg: 0,
        opacity: opacity >= 0 && Number.isFinite(opacity) ? opacity : 1,
        color: params.color?.trim() || DAG_LAYOUT_FLY_DEFAULT_COLOR,
        dashed,
        dashOn,
        dashOff,
        arrowScale: 0,
        arrowTwistDeg: 0,
    };
}

/** 可注入的样式读取（测试用）；默认 `getComputedStyle`。 */
export type LayoutTransitionCssLookup = (el: Element) => {
    display: string;
    visibility: string;
    opacity: string;
};

function defaultCssLookup(el: Element): {
    display: string;
    visibility: string;
    opacity: string;
} {
    const s = getComputedStyle(el);
    return { display: s.display, visibility: s.visibility, opacity: s.opacity };
}

/**
 * SVG 子树此刻是否画出：沿祖先读 computed `display` / `visibility` / `opacity`。
 * 勿用 `Element.checkVisibility`——Chrome 对 SVG 在祖先 `display:none` 时仍可能返回 true
 *（如 Hide inactive 的 `.gen-attr-dag-links`）。
 * `root`：走到此节点（不含）为止，通常为 svg 根。
 */
export function isSvgVisualPresent(
    el: Element,
    options?: { root?: Element | null; css?: LayoutTransitionCssLookup },
): boolean {
    const css = options?.css ?? defaultCssLookup;
    const root = options?.root ?? null;
    let cur: Element | null = el;
    while (cur && cur !== root) {
        const s = css(cur);
        if (s.display === 'none' || s.visibility === 'hidden') return false;
        if (parseFloat(s.opacity) === 0) return false;
        cur = cur.parentElement;
    }
    return true;
}

/** 填色用不透明度（computed，尊重 `opacity:0 !important` 等）。 */
export function readComputedOpacity(el: Element, css?: LayoutTransitionCssLookup): number {
    const n = parseFloat((css ?? defaultCssLookup)(el).opacity);
    return n >= 0 && Number.isFinite(n) ? n : 1;
}

/**
 * 描边不透明度：presentation attribute 优先，否则 computed `stroke-opacity`。
 * 与 CSS `opacity` 独立（灰边常用 stroke-opacity，Hide inactive 用层 display）。
 */
export function readStrokeOpacity(el: Element): number {
    const raw = el.getAttribute('stroke-opacity') ?? getComputedStyle(el).strokeOpacity;
    const n = parseFloat(raw);
    return n >= 0 && Number.isFinite(n) ? n : 1;
}

/**
 * 转场捕获角色：
 * - `token`：节点/轴 chip（子树可见即可，淡 fill 仍飞位）
 * - `stroke`：图边 path（另需 stroke-opacity > 0）
 * - `fill`：矩阵格等填色（另需自身 computed opacity > 0）
 */
export type SteadyPaintKind = 'token' | 'stroke' | 'fill';

/**
 * 稳态此刻是否画出（转场捕获唯一入口）。
 * 子树可见性见 {@link isSvgVisualPresent}；再按 {@link SteadyPaintKind} 查 paint 通道。
 */
export function isSteadyPainted(
    el: Element,
    kind: SteadyPaintKind,
    options?: { root?: Element | null; css?: LayoutTransitionCssLookup },
): boolean {
    if (!isSvgVisualPresent(el, options)) return false;
    if (kind === 'token') return true;
    if (kind === 'stroke') return readStrokeOpacity(el) > 0;
    return readComputedOpacity(el, options?.css) > 0;
}

/**
 * 稳态 paint 不透明度（与 {@link isSteadyPainted} 同角色）。
 * - stroke → {@link readStrokeOpacity}
 * - fill → {@link readComputedOpacity}
 * - token → attribute opacity，否则 computed
 */
export function readSteadyPaintOpacity(
    el: Element,
    kind: SteadyPaintKind,
    options?: { root?: Element | null; css?: LayoutTransitionCssLookup },
): number {
    if (kind === 'stroke') return readStrokeOpacity(el);
    if (kind === 'fill') return readComputedOpacity(el, options?.css);
    const attr = parseFloat(el.getAttribute('opacity') ?? '');
    if (attr >= 0 && Number.isFinite(attr)) return attr;
    return readComputedOpacity(el, options?.css);
}

/**
 * 从图布局 key 集与矩阵 key 集建立 1↔N 配对。
 * - 图↔图：`node:id` → `node:id`
 * - 图→矩阵：`node:id` → 每个存在的 `matrix-row:id` / `matrix-col:id`
 * - 矩阵→图：每个 `matrix-*:id` → `node:id`
 * - 矩阵→矩阵：同 key 一一对应
 */
export function buildLayoutTransitionPairs(params: {
    fromKind: DagLayoutElementKind;
    toKind: DagLayoutElementKind;
    fromPoses: Map<string, DagNodeLayoutPose>;
    toPoses: Map<string, DagNodeLayoutPose>;
}): DagLayoutTransitionPair[] {
    const { fromKind, toKind, fromPoses, toPoses } = params;
    const pairs: DagLayoutTransitionPair[] = [];

    if (fromKind === 'graph' && toKind === 'graph') {
        for (const [key, from] of fromPoses) {
            const to = toPoses.get(key);
            if (!to) continue;
            pairs.push({ fromKey: key, toKey: key, from, to });
        }
        return pairs;
    }

    if (fromKind === 'graph' && toKind === 'matrix') {
        for (const [fromKey, from] of fromPoses) {
            if (!fromKey.startsWith('node:')) continue;
            const id = fromKey.slice('node:'.length);
            for (const toKey of [matrixRowElementKey(id), matrixColElementKey(id)]) {
                const to = toPoses.get(toKey);
                if (!to) continue;
                pairs.push({ fromKey, toKey, from, to });
            }
        }
        return pairs;
    }

    if (fromKind === 'matrix' && toKind === 'graph') {
        for (const [fromKey, from] of fromPoses) {
            let id: string | null = null;
            if (fromKey.startsWith('matrix-row:')) id = fromKey.slice('matrix-row:'.length);
            else if (fromKey.startsWith('matrix-col:')) id = fromKey.slice('matrix-col:'.length);
            if (id == null) continue;
            const toKey = dagLayoutNodeKey(id);
            const to = toPoses.get(toKey);
            if (!to) continue;
            pairs.push({ fromKey, toKey, from, to });
        }
        return pairs;
    }

    // matrix ↔ matrix
    for (const [key, from] of fromPoses) {
        const to = toPoses.get(key);
        if (!to) continue;
        pairs.push({ fromKey: key, toKey: key, from, to });
    }
    return pairs;
}

/**
 * 图布局是否使用直线边。
 * `text-flow` / `spiral` 为直线；`linear-arc*` 为弧线。
 */
export function dagLayoutModeUsesStraightEdges(mode: string): boolean {
    return mode === 'text-flow' || mode === 'spiral';
}

/**
 * 边/格/节点转场策略（飞位），三选一：
 * - `fly-edge-cell`：直线图 ↔ matrix（弦条带 ↔ 方格）
 * - `fly-edge-edge`：直线图 ↔ 直线图（如 text-flow ↔ spiral）
 * - `crossfade`：任一端为弧线（linear-arc / step-down）时过程中不显示边格，结束瞬显
 */
export type DagLayoutEdgeTransitionKind = 'fly-edge-cell' | 'fly-edge-edge' | 'crossfade';

export function dagLayoutEdgeTransitionKind(
    fromMode: string,
    toMode: string,
): DagLayoutEdgeTransitionKind {
    const fromMatrix = fromMode === 'attribution-matrix';
    const toMatrix = toMode === 'attribution-matrix';
    // 1) 直线图 ↔ matrix
    if (fromMatrix !== toMatrix) {
        const graphMode = fromMatrix ? toMode : fromMode;
        return dagLayoutModeUsesStraightEdges(graphMode) ? 'fly-edge-cell' : 'crossfade';
    }
    // 2) 直线图 ↔ 直线图
    if (
        !fromMatrix &&
        dagLayoutModeUsesStraightEdges(fromMode) &&
        dagLayoutModeUsesStraightEdges(toMode)
    ) {
        return 'fly-edge-edge';
    }
    // 3) 含弧线（或其它非上述）→ 过程中隐藏边格
    return 'crossfade';
}

function flyPairsBySharedKeys(
    fromPoses: Map<string, DagLayoutFlyPose>,
    toPoses: Map<string, DagLayoutFlyPose>,
    maxPairs?: number,
    rankByKey?: Map<string, number>,
): DagLayoutFlyPair[] {
    const keys: string[] = [];
    for (const key of fromPoses.keys()) {
        if (toPoses.has(key)) keys.push(key);
    }
    if (rankByKey) {
        keys.sort((a, b) => (rankByKey.get(b) ?? 0) - (rankByKey.get(a) ?? 0));
    }
    if (maxPairs != null && keys.length > maxPairs) {
        keys.length = maxPairs;
    }
    const pairs: DagLayoutFlyPair[] = [];
    for (const key of keys) {
        pairs.push({ fromKey: key, toKey: key, from: fromPoses.get(key)!, to: toPoses.get(key)! });
    }
    return pairs;
}

/**
 * 图边种子 ↔ 矩阵有边格子：同 key `src->tgt` 一对一飞位。
 * 非 graph↔matrix 返回空；按 `rankByKey` 降序截断至 `maxPairs`（正式路径见 {@link DAG_LAYOUT_TRANSITION_FLY_MAX}）。
 */
export function buildEdgeCellFlyPairs(params: {
    fromKind: DagLayoutElementKind;
    toKind: DagLayoutElementKind;
    /** 图侧：沿边切线的细条（key = src->tgt） */
    edgePoses: Map<string, DagLayoutFlyPose>;
    /** 矩阵侧：有边格子（key = src->tgt） */
    cellPoses: Map<string, DagLayoutFlyPose>;
    maxPairs?: number;
    /** 越大越优先；有 `maxPairs` 时用于截断排序，否则仅影响顺序 */
    rankByKey?: Map<string, number>;
}): DagLayoutFlyPair[] {
    const { fromKind, toKind, edgePoses, cellPoses, rankByKey } = params;
    if (
        !(
            (fromKind === 'graph' && toKind === 'matrix') ||
            (fromKind === 'matrix' && toKind === 'graph')
        )
    ) {
        return [];
    }
    const graphToMatrix = fromKind === 'graph';
    return flyPairsBySharedKeys(
        graphToMatrix ? edgePoses : cellPoses,
        graphToMatrix ? cellPoses : edgePoses,
        params.maxPairs,
        rankByKey,
    );
}

/**
 * 直线边布局 ↔ 直线边布局：同 key `src->tgt` 一对一飞位（弦条带位姿插值）。
 * 调用方须已判定两端均为 {@link dagLayoutModeUsesStraightEdges}；本函数只做配对。
 */
export function buildEdgeEdgeFlyPairs(params: {
    fromEdgePoses: Map<string, DagLayoutFlyPose>;
    toEdgePoses: Map<string, DagLayoutFlyPose>;
    maxPairs?: number;
    rankByKey?: Map<string, number>;
}): DagLayoutFlyPair[] {
    return flyPairsBySharedKeys(
        params.fromEdgePoses,
        params.toEdgePoses,
        params.maxPairs,
        params.rankByKey,
    );
}

/** 1↔N 飞位角色：primary 全程不透明；secondary 在分裂时淡入、合并时淡出，避免叠画亮度突变。 */
export type DagLayoutTransitionCardinality = 'one' | 'split' | 'merge';

export type DagLayoutTransitionFlyRole = {
    pair: DagLayoutTransitionPair;
    cardinality: DagLayoutTransitionCardinality;
    isPrimary: boolean;
};

/** 矩阵语义：col = source，row = target。同组内 source chip 优先作 primary。 */
function isMatrixSourceKey(key: string): boolean {
    return key.startsWith('matrix-col:');
}

function pickPrimaryPairIndex(
    group: DagLayoutTransitionPair[],
    matrixSideKey: (p: DagLayoutTransitionPair) => string,
): number {
    const srcIdx = group.findIndex((p) => isMatrixSourceKey(matrixSideKey(p)));
    return srcIdx >= 0 ? srcIdx : 0;
}

/**
 * 为配对标注 1↔N 角色。
 * - 同 `fromKey` 多条 → split（图→矩阵）
 * - 同 `toKey` 多条 → merge（矩阵→图）
 * - primary：组内优先 `matrix-col`（source）；一对一皆为 primary
 */
export function annotateLayoutTransitionFlyRoles(
    pairs: DagLayoutTransitionPair[],
): DagLayoutTransitionFlyRole[] {
    const byFrom = new Map<string, DagLayoutTransitionPair[]>();
    const byTo = new Map<string, DagLayoutTransitionPair[]>();
    for (const p of pairs) {
        const fromGroup = byFrom.get(p.fromKey);
        if (fromGroup) fromGroup.push(p);
        else byFrom.set(p.fromKey, [p]);
        const toGroup = byTo.get(p.toKey);
        if (toGroup) toGroup.push(p);
        else byTo.set(p.toKey, [p]);
    }

    const primaryPairs = new Set<DagLayoutTransitionPair>();
    const cardinalityByPair = new Map<DagLayoutTransitionPair, DagLayoutTransitionCardinality>();

    for (const group of byFrom.values()) {
        if (group.length <= 1) continue;
        const pri = group[pickPrimaryPairIndex(group, (p) => p.toKey)]!;
        primaryPairs.add(pri);
        for (const p of group) cardinalityByPair.set(p, 'split');
    }
    for (const group of byTo.values()) {
        if (group.length <= 1) continue;
        const pri = group[pickPrimaryPairIndex(group, (p) => p.fromKey)]!;
        primaryPairs.add(pri);
        for (const p of group) cardinalityByPair.set(p, 'merge');
    }

    return pairs.map((pair) => {
        const cardinality = cardinalityByPair.get(pair) ?? 'one';
        const isPrimary = cardinality === 'one' || primaryPairs.has(pair);
        return { pair, cardinality, isPrimary };
    });
}

/**
 * fly 节点角色 opacity：一对一 / primary 恒为 1；
 * split 的 secondary = eased（0→1）；merge 的 secondary = 1−eased（1→0）。
 */
export function layoutTransitionFlyOpacity(
    eased: number,
    role: Pick<DagLayoutTransitionFlyRole, 'cardinality' | 'isPrimary'>,
): number {
    if (role.isPrimary || role.cardinality === 'one') return 1;
    if (role.cardinality === 'split') return eased;
    return 1 - eased;
}

/**
 * fly 节点最终 opacity = 角色系数 × 稳态 fill 插值（尊重焦点置灰 / dim / exclude）。
 * `fromFill`/`toFill` 为起终点元素当前 fill opacity（通常 1 / 0.6 / 0.1）。
 * 理论上同 token 起终点亮度应一致；轴 chip / dim 等特例可能不同，故仍插值（开销可忽略）。
 */
export function layoutTransitionFlyCombinedOpacity(
    eased: number,
    role: Pick<DagLayoutTransitionFlyRole, 'cardinality' | 'isPrimary'>,
    fromFill: number,
    toFill: number,
): number {
    return layoutTransitionFlyOpacity(eased, role) * lerp(fromFill, toFill, eased);
}

export type LayoutTransitionTick = {
    t: number;
    eased: number;
};

/**
 * rAF 驱动的转场时钟；`onDone` 在 t=1 的最后一帧之后调用。
 * 返回 cancel（不调用 onDone）。
 *
 * 约定：只转场节点与边/格（fly / fly-edge-cell|fly-edge-edge；crossfade 过程中不显示边格）；
 * 其它（背景、空格、框线、轴角、Self…）不参与插值，稳态再显。
 * 参与转场的元素共用 `eased`；`t` 仅表示时间比例。
 * 边/格/节点：在稳态可见性下捕获（此刻画出来的才进 fly）；转场压层须在捕获之后。
 * 可见性唯一入口 {@link isSteadyPainted}（勿用 checkVisibility）。
 */
export function runLayoutTransitionClock(params: {
    durationMs: number;
    onTick: (tick: LayoutTransitionTick) => void;
    onDone: () => void;
    now?: () => number;
    requestFrame?: (cb: FrameRequestCallback) => number;
    cancelFrame?: (id: number) => void;
}): () => void {
    const durationMs = Math.max(0, params.durationMs);
    const now = params.now ?? (() => performance.now());
    const requestFrame = params.requestFrame ?? ((cb) => requestAnimationFrame(cb));
    const cancelFrame = params.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    const t0 = now();
    let raf = 0;
    let cancelled = false;

    const frame = (ts: number) => {
        if (cancelled) return;
        const elapsed = ts - t0;
        const t = durationMs <= 0 ? 1 : Math.min(1, elapsed / durationMs);
        const eased = easeLayoutTransition(t);
        params.onTick({ t, eased });
        if (t < 1) {
            raf = requestFrame(frame);
        } else {
            params.onDone();
        }
    };

    if (durationMs <= 0) {
        params.onTick({ t: 1, eased: 1 });
        params.onDone();
        return () => {
            cancelled = true;
        };
    }

    raf = requestFrame(frame);
    return () => {
        cancelled = true;
        cancelFrame(raf);
    };
}

/** 从 SVG transform 字符串解析首个 translate（及可选紧随的 scale）。 */
export function parsePoseFromTransform(
    transform: string | null,
    fallback: Pick<DagNodeLayoutPose, 'id' | 'nodeW' | 'nodeH'>,
): DagNodeLayoutPose {
    const tr = transform ?? '';
    const translateMatch = /translate\(\s*([-\d.eE+]+)\s*,\s*([-\d.eE+]+)\s*\)/.exec(tr);
    const scaleMatch = /scale\(\s*([-\d.eE+]+)\s*\)/.exec(tr);
    const x = translateMatch ? Number(translateMatch[1]) : 0;
    const y = translateMatch ? Number(translateMatch[2]) : 0;
    const scale = scaleMatch ? Number(scaleMatch[1]) : 1;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(scale)) {
        throw new Error(`parsePoseFromTransform: invalid transform "${tr}"`);
    }
    return {
        id: fallback.id,
        x,
        y,
        nodeW: fallback.nodeW,
        nodeH: fallback.nodeH,
        scale,
    };
}
