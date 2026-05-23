import type * as d3 from 'd3';

/**
 * 「主操作 + Force retry」在「草稿 vs 已提交快照」下的禁用/样式规则。
 * Context Attribution 与 LLM Raw Chat 共用：idleInputsReady ∧ hasUncommittedDraft → 主钮；
 * idleInputsReady → Force retry；进行中时按页面策略冻结或变为 Stop。
 */
export type SyncDraftCommittedButtonPairOptions = {
    primaryBtn: d3.Selection<any, unknown, any, any>;
    forceRetryBtn: d3.Selection<any, unknown, any, any>;
    inFlight: boolean;
    /** freeze：两钮禁用且不改主钮文案（归因）；stop：主钮可点并换文案（Chat → Stop） */
    primaryInFlightMode: 'freeze' | 'stop';
    /** primaryInFlightMode === 'stop' 时必填 */
    primaryInFlightLabel?: string;
    primaryIdleLabel: string;
    /** 非进行中时，输入是否满足发起请求 */
    idleInputsReady: boolean;
    hasUncommittedDraft: boolean;
};

export function syncDraftCommittedButtonPair(opts: SyncDraftCommittedButtonPairOptions): void {
    const {
        primaryBtn,
        forceRetryBtn,
        inFlight,
        primaryInFlightMode,
        primaryInFlightLabel,
        primaryIdleLabel,
        idleInputsReady,
        hasUncommittedDraft,
    } = opts;

    if (inFlight && primaryInFlightMode === 'stop') {
        if (primaryInFlightLabel === undefined) {
            throw new Error(
                'syncDraftCommittedButtonPair: primaryInFlightLabel is required when primaryInFlightMode is stop'
            );
        }
        primaryBtn.text(primaryInFlightLabel);
        primaryBtn.property('disabled', false);
        primaryBtn.classed('inactive', false);
        forceRetryBtn.property('disabled', true);
        forceRetryBtn.classed('inactive', true);
        return;
    }

    if (inFlight && primaryInFlightMode === 'freeze') {
        primaryBtn.property('disabled', true);
        primaryBtn.classed('inactive', true);
        forceRetryBtn.property('disabled', true);
        forceRetryBtn.classed('inactive', true);
        return;
    }

    primaryBtn.text(primaryIdleLabel);
    if (!idleInputsReady) {
        primaryBtn.property('disabled', true);
        primaryBtn.classed('inactive', true);
        forceRetryBtn.property('disabled', true);
        forceRetryBtn.classed('inactive', true);
        return;
    }

    const enablePrimary = hasUncommittedDraft;
    const enableForceRetry = true;

    primaryBtn.property('disabled', !enablePrimary);
    primaryBtn.classed('inactive', !enablePrimary);
    forceRetryBtn.property('disabled', !enableForceRetry);
    forceRetryBtn.classed('inactive', !enableForceRetry);
}
