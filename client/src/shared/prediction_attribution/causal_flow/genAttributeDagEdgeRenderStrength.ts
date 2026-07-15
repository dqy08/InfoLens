import { DAG_EDGE_RENDER_OPACITY_FLOOR } from './genAttributeDagEdgeDisplay';
import { DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS } from './genAttributeDagPropagationPlaybackPacing';
import { maxHighlightEdgeShare } from './genAttributeDagRecursiveEdgeAnimation';

/** 闪电 `min(1, s/τ)` 默认 τ；手动调试起点，越小越多边顶满。 */
export const DAG_LIGHTNING_THRESHOLD_TAU_DEFAULT = 0.35;
export const DAG_LIGHTNING_THRESHOLD_TAU_MIN = 0.05;
export const DAG_LIGHTNING_THRESHOLD_TAU_MAX = 1;

export function clampLightningThresholdTau(n: number): number {
    if (!Number.isFinite(n)) return DAG_LIGHTNING_THRESHOLD_TAU_DEFAULT;
    return Math.max(
        DAG_LIGHTNING_THRESHOLD_TAU_MIN,
        Math.min(DAG_LIGHTNING_THRESHOLD_TAU_MAX, n),
    );
}

/**
 * 闪电动画时序（墙钟 ms，slowMo=1）：
 * - {@link DAG_LIGHTNING_PHASES_MS} 双峰 + 衰减，比例同 100/50/50/300，各段 ×4 便于肉眼跟读。
 * - UI「慢放」叠乘墙钟；{@link lightningTimelineMs} = elapsed ÷ slowMo。
 */
/** UI 慢放输入默认（1×）。 */
export const DAG_LIGHTNING_SLOW_MO_DEFAULT = 1;
export const DAG_LIGHTNING_SLOW_MO_MIN = 1;
export const DAG_LIGHTNING_SLOW_MO_MAX = 10;

export function clampLightningSlowMo(n: number): number {
    if (!Number.isFinite(n)) return DAG_LIGHTNING_SLOW_MO_DEFAULT;
    return Math.max(DAG_LIGHTNING_SLOW_MO_MIN, Math.min(DAG_LIGHTNING_SLOW_MO_MAX, Math.round(n)));
}

/** 墙钟 elapsed ÷ 慢放倍率 → 相位时间轴（slowMo=1 时与配置 ms 一致）。 */
function lightningTimelineMs(elapsedMs: number, uiSlowMo: number): number {
    const m = clampLightningSlowMo(uiSlowMo);
    return Math.max(0, elapsedMs) / m;
}

/** 闪电线性增强：`min(1, renderStrength / τ)`；τ≤0 时退回 1（无增强）。 */
export function lightningEdgeRenderOpacity(renderStrength: number, tau: number): number {
    if (!Number.isFinite(renderStrength) || renderStrength <= 0) return 0;
    const t = clampLightningThresholdTau(tau);
    return Math.min(1, renderStrength / t);
}

/** 双回击四段墙钟时长（slowMo=1）：首击 | 衰减至半稳态 | 回击 | 衰减至稳态。比例 100:50:50:300 ×4。 */
export const DAG_LIGHTNING_PHASES_MS = [400, 200, 200, 1200] as const;

/** slowMo=1 时闪电动画墙钟总时长（= sum {@link DAG_LIGHTNING_PHASES_MS}）。 */
export const DAG_LIGHTNING_ANIMATION_BASE_MS = DAG_LIGHTNING_PHASES_MS.reduce((a, b) => a + b, 0);

/** 正向末帧闪电动画 dwell（不含 slide 前奏）：无闪电为边界基线；有闪电为 {@link DAG_LIGHTNING_ANIMATION_BASE_MS} × 慢放。不计入 Play speed total time。 */
export function lightningBoundaryAnimationDwellMs(
    baseDwellMs: number = DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS,
    lightningEnabled = false,
    uiSlowMo: number = DAG_LIGHTNING_SLOW_MO_DEFAULT,
): number {
    if (!lightningEnabled) return baseDwellMs;
    return DAG_LIGHTNING_ANIMATION_BASE_MS * clampLightningSlowMo(uiSlowMo);
}

/** 正向末帧边界帧 dwell：无闪电为基线；有闪电为基线（slide 停顿）+ 闪电动画 dwell。 */
export function lightningBoundaryFrameDwellMs(
    baseDwellMs: number = DAG_PROPAGATION_BOUNDARY_FRAME_DWELL_MS,
    lightningEnabled = false,
    uiSlowMo: number = DAG_LIGHTNING_SLOW_MO_DEFAULT,
): number {
    if (!lightningEnabled) return baseDwellMs;
    return baseDwellMs + lightningBoundaryAnimationDwellMs(baseDwellMs, true, uiSlowMo);
}

/** 首击前 DAG 闪遮罩：保持 + 淡出墙钟时长（ms，slowMo=1；与相位同 ×4）。 */
export const DAG_LIGHTNING_DAG_FLASH_HOLD_MS = 100;
export const DAG_LIGHTNING_DAG_FLASH_FADE_MS = 100;

/** DAG 区域闪遮罩 opacity：首 {@link DAG_LIGHTNING_DAG_FLASH_HOLD_MS} 为 1，随后线性降至 0；色为 {@link --dag-lightning-line-color} 的 50% 透明度（见 causal_flow.scss）。 */
export function lightningDagFlashOverlayOpacity(
    elapsedMs: number,
    slowMo: number = DAG_LIGHTNING_SLOW_MO_DEFAULT,
): number {
    const t = lightningTimelineMs(elapsedMs, slowMo);
    if (t < DAG_LIGHTNING_DAG_FLASH_HOLD_MS) return 1;
    const fadeEnd = DAG_LIGHTNING_DAG_FLASH_HOLD_MS + DAG_LIGHTNING_DAG_FLASH_FADE_MS;
    if (t >= fadeEnd) return 0;
    return 1 - (t - DAG_LIGHTNING_DAG_FLASH_HOLD_MS) / DAG_LIGHTNING_DAG_FLASH_FADE_MS;
}

/**
 * 双回击闪电 fade [0,1]：0=峰值，1=稳态蓝边。
 * 段长 {@link DAG_LIGHTNING_PHASES_MS}：峰值 | 线性→0.5 | 峰值 | 线性→1
 */
export function lightningBoundaryFadeProgress(
    elapsedMs: number,
    slowMo: number = DAG_LIGHTNING_SLOW_MO_DEFAULT,
): number {
    const [p1, p2, p3, p4] = DAG_LIGHTNING_PHASES_MS;
    const t = lightningTimelineMs(elapsedMs, slowMo);
    const t1 = p1;
    const t2 = t1 + p2;
    const t3 = t2 + p3;
    const total = t3 + p4;
    if (t < t1) return 0;
    if (t < t2) return ((t - t1) / p2) * 0.5;
    if (t < t3) return 0;
    if (t >= total) return 1;
    return (t - t3) / p4;
}

/** 末段（{@link DAG_LIGHTNING_PHASES_MS} 第 4 段）线性显现非闪电内容；0=全遮，1=稳态全显。 */
export function lightningContentRevealProgress(
    elapsedMs: number,
    slowMo: number = DAG_LIGHTNING_SLOW_MO_DEFAULT,
): number {
    const [p1, p2, p3, p4] = DAG_LIGHTNING_PHASES_MS;
    const t = lightningTimelineMs(elapsedMs, slowMo);
    const revealStart = p1 + p2 + p3;
    if (t < revealStart) return 0;
    if (t >= revealStart + p4) return 1;
    return (t - revealStart) / p4;
}

/** 峰值 opacity → 稳态 `finalRenderStrength` 线性混合。 */
export function lightningDecayOpacity(
    peakOpacity: number,
    steadyOpacity: number,
    fadeProgress: number,
): number {
    const t = Math.max(0, Math.min(1, fadeProgress));
    return peakOpacity + (steadyOpacity - peakOpacity) * t;
}

/** 峰值色 CSS 变量 → 稳态蓝入边色变量，`color-mix` 线性过渡。 */
export function lightningDecayStrokeCss(
    fadeProgress: number,
    lightningColorVar: string,
    steadyColorVar: string,
): string {
    const t = Math.max(0, Math.min(1, fadeProgress));
    const peakPct = (1 - t) * 100;
    const steadyPct = t * 100;
    return `color-mix(in srgb, var(${lightningColorVar}) ${peakPct}%, var(${steadyColorVar}) ${steadyPct}%)`;
}

/**
 * 池内 max 归一后的 `stroke-opacity`；最强边刻度为 {@link maxOpacity}（默认 1）。
 * 按实际值计算后，最终不低于 {@link DAG_EDGE_RENDER_OPACITY_FLOOR}，防止过淡不可见。
 */
export function normalizeEdgeRenderOpacity(share: number, maxShare: number, maxOpacity = 1): number {
    if (!Number.isFinite(share) || share <= 0) return 0;
    const cap = Number.isFinite(maxOpacity) && maxOpacity > 0 ? maxOpacity : 1;
    const scaled =
        !Number.isFinite(maxShare) || maxShare <= 0
            ? Math.min(cap, share)
            : Math.min(cap, (share / maxShare) * cap);
    if (scaled <= 0) return 0;
    return Math.max(DAG_EDGE_RENDER_OPACITY_FLOOR, scaled);
}

/**
 * 池内 max 归一后的 render 强度。
 * - 默认：{@link sharesByKey} 全表 max；
 * - {@link maxShareOverride}：蓝入边前沿分母；
 * - {@link onlyKeys}：仅输出这些 key（红入边：集合内 max，忽略 maxShareOverride 外的键）。
 */
export function buildMaxNormalizedRenderStrengthByKey(
    sharesByKey: Map<string, number>,
    maxOpacity = 1,
    maxShareOverride?: number,
    onlyKeys?: ReadonlySet<string>,
): Map<string, number> {
    let maxShare: number;
    if (maxShareOverride != null && Number.isFinite(maxShareOverride) && maxShareOverride > 0) {
        maxShare = maxShareOverride;
    } else if (onlyKeys != null) {
        maxShare = 0;
        for (const key of onlyKeys) {
            const share = sharesByKey.get(key);
            if (share != null && share > maxShare) maxShare = share;
        }
    } else {
        maxShare = maxHighlightEdgeShare(sharesByKey);
    }
    const byKey = new Map<string, number>();
    const keys = onlyKeys ?? sharesByKey.keys();
    for (const key of keys) {
        const share = sharesByKey.get(key);
        if (share != null) {
            byKey.set(key, normalizeEdgeRenderOpacity(share, maxShare, maxOpacity));
        }
    }
    return byKey;
}

/**
 * 下游红边渲染：每源出边 `display = arrive × (raw / maxRaw)`，故最强出边 = arrive；
 * 再对 display 做全表 max 归一得到 opacity。传播原值仍在 `sharesByKey`（tooltip）。
 */
export function buildDownstreamArriveScaledRenderStrengthByKey(
    sharesByKey: Map<string, number>,
    arriveById: ReadonlyMap<string, number>,
    maxOpacity = 1,
): Map<string, number> {
    const maxRawBySource = new Map<string, number>();
    for (const [key, share] of sharesByKey) {
        if (!(share > 0) || !Number.isFinite(share)) continue;
        const sep = key.indexOf('->');
        if (sep <= 0) continue;
        const src = key.slice(0, sep);
        const prev = maxRawBySource.get(src) ?? 0;
        if (share > prev) maxRawBySource.set(src, share);
    }
    const displayByKey = new Map<string, number>();
    for (const [key, share] of sharesByKey) {
        const sep = key.indexOf('->');
        if (sep <= 0) continue;
        const src = key.slice(0, sep);
        const maxRaw = maxRawBySource.get(src) ?? 0;
        if (maxRaw <= 0) continue;
        const arrive = arriveById.get(src) ?? 0;
        if (!(arrive > 0) || !Number.isFinite(arrive)) continue;
        displayByKey.set(key, arrive * (share / maxRaw));
    }
    return buildMaxNormalizedRenderStrengthByKey(displayByKey, maxOpacity);
}
