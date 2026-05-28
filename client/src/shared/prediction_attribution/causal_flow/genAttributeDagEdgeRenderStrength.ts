import { DAG_EDGE_RENDER_OPACITY_FLOOR } from './genAttributeDagEdgeDisplay';
import { maxHighlightEdgeShare } from './genAttributeDagRecursiveEdgeAnimation';

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
