import { isOffsetSpanFullyExcluded } from '../core/attributionDisplayModel';
import type { DagFocusAttributionState } from './genAttributeDagRecursiveEdgeAnimation';

/** 「Dim inactive tokens」默认阈值（Attribution share Total 比例，含链外视为 0）；默认 1%。 */
export const DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT = 0.01;

/** 控件以百分数展示时的默认值（与 {@link DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT} 对应）。 */
export const DIM_INACTIVE_THRESHOLD_UI_PERCENT_DEFAULT = 1;

/** UI &gt;1% 时 number 输入 step；≤1% 时为 {@link DIM_INACTIVE_THRESHOLD_UI_PERCENT_STEP_FINE}。 */
export const DIM_INACTIVE_THRESHOLD_UI_PERCENT_STEP_COARSE = 1;
export const DIM_INACTIVE_THRESHOLD_UI_PERCENT_STEP_FINE = 0.1;

export function clampDimInactiveTokensThreshold(n: number): number {
    if (!Number.isFinite(n)) {
        throw new Error('genAttributeDagView: dimInactiveTokensThreshold must be finite');
    }
    return Math.max(0, Math.min(1, n));
}

export function dimInactiveThresholdFractionToUiPercent(fraction: number): number {
    return clampDimInactiveTokensThreshold(fraction) * 100;
}

export function dimInactiveThresholdUiPercentToFraction(percent: number): number {
    if (!Number.isFinite(percent)) {
        return DIM_INACTIVE_TOKENS_THRESHOLD_DEFAULT;
    }
    return clampDimInactiveTokensThreshold(percent / 100);
}

export function formatDimInactiveThresholdPercentForInput(percent: number): string {
    const p = Number.isFinite(percent) ? percent : DIM_INACTIVE_THRESHOLD_UI_PERCENT_DEFAULT;
    if (p < 1) {
        const fine = Math.round(p * 10) / 10;
        return Number.isInteger(fine) ? String(fine) : fine.toFixed(1);
    }
    const coarse = Math.round(p * 100) / 100;
    return String(coarse);
}

export function dimInactiveThresholdUiStepForPercent(percent: number): string {
    const p = Number.isFinite(percent) ? percent : DIM_INACTIVE_THRESHOLD_UI_PERCENT_DEFAULT;
    return p <= 1
        ? String(DIM_INACTIVE_THRESHOLD_UI_PERCENT_STEP_FINE)
        : String(DIM_INACTIVE_THRESHOLD_UI_PERCENT_STEP_COARSE);
}

export function dagNodeTotalAttributionShare(
    nodeId: string,
    focusState: DagFocusAttributionState | null,
): number {
    return focusState?.nodeShareById.get(nodeId) ?? 0;
}

/**
 * `share < threshold` 为 inactive；焦点恒为 active；未开 dim / 无焦点 / prompt（`step < 0`）恒为 false。
 */
export function isDagNodeInactiveByTotalShare(
    nodeId: string,
    step: number,
    focusId: string | null,
    focusState: DagFocusAttributionState | null,
    dimInactiveTokens: boolean,
    threshold: number,
): boolean {
    if (!dimInactiveTokens || focusId == null || step < 0 || nodeId === focusId) return false;
    return dagNodeTotalAttributionShare(nodeId, focusState) < threshold;
}

export type DagNodeLowVisibilityReason = 'excluded' | 'inactive';

/**
 * Hide exclude/inactive 用的 0.1 档标记：exclude 命中，或（Causal Flow + dim）inactive。
 * 节点 opacity 先走原有高亮/弱化，再对 inactive 额外压到 0.1（见 genAttributeDagView）。
 */
export function dagNodeLowVisibilityReason(
    nodeId: string,
    start: number,
    end: number,
    step: number,
    excludeIntervals: [number, number][],
    focusId: string | null,
    focusState: DagFocusAttributionState | null,
    dimInactiveTokens: boolean,
    inactiveThreshold: number,
): DagNodeLowVisibilityReason | null {
    if (isOffsetSpanFullyExcluded(start, end, excludeIntervals)) return 'excluded';
    if (
        isDagNodeInactiveByTotalShare(
            nodeId,
            step,
            focusId,
            focusState,
            dimInactiveTokens,
            inactiveThreshold,
        )
    ) {
        return 'inactive';
    }
    return null;
}

export function parseDagLinkEndpointKey(edgeKey: string): { srcId: string; tgtId: string } | null {
    const sep = edgeKey.indexOf('->');
    if (sep < 0) return null;
    return { srcId: edgeKey.slice(0, sep), tgtId: edgeKey.slice(sep + 2) };
}
