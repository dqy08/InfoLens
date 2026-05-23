/**
 * 从 {@link FrontendToken} 解析 pred_topk / real_topk 语义，生成与 ToolTip `.predictions` 一致的 HTML。
 * 条形图绘制见 {@link ./topkChartUtils}。
 */

import type { BpeMergeReason, FrontendToken } from '../../shared/api/GLTR_API';
import { tr, trf } from '../../shared/lang/i18n-lite';
import { escapeHtml, tooltipTokenDisplayHtml } from './tokenDisplayUtils';
import {
    prepareTopkDisplayRows,
    renderTopkChartHtml,
    topkDisplaySelection,
} from './topkChartUtils';

const DISPLAY_TOPK = 10;

function bpeMergedInfoMessage(reason: BpeMergeReason): string {
    switch (reason) {
        case 'overlap':
            return tr('BPE overlap merge: overlapping spans were combined.');
        case 'digit':
            return tr('Digit merge: adjacent digit sub-tokens were combined.');
    }
}

const MERGE_PARTS_TOOLTIP_MAX = 8;

/** 合并子片段列表 → tooltip 第二行 HTML（与 ToolTip 当前 token 行同：`tooltipTokenDisplayHtml`） */
function bpeMergePartsTooltipHtml(parts: string[] | undefined): string {
    if (!parts?.length) return '';
    const shown = parts.slice(0, MERGE_PARTS_TOOLTIP_MAX);
    const hidden = parts.length - shown.length;
    const body = shown.map((p) => tooltipTokenDisplayHtml(p)).join('<br/>');
    const more =
        hidden > 0
            ? `<br/>${escapeHtml(trf('(+{n} more)', { n: hidden }))}`
            : '';
    return (
        `<div class="topk-chart-info-parts">` +
        `${escapeHtml(trf('Source fragments ({count}):', { count: parts.length }))}<br/>${body}${more}` +
        `</div>`
    );
}

/**
 * Tooltip / 信息密度汇总 / TopK 条共用的 pred_topk、real_topk 语义：
 * 占位符 `real_topk: [*, 1]` 且空 pred_topk 表示「仅语义、无真实信息密度」。
 */
export function getFrontendTokenTopkState(tokenData: FrontendToken): {
    predTopk: [string, number][];
    isPlaceholderTopk: boolean;
    hasRealTopk: boolean;
} {
    const predTopk = tokenData.pred_topk ?? [];
    const isPlaceholderTopk =
        tokenData.real_topk != null &&
        Array.isArray(tokenData.real_topk) &&
        tokenData.real_topk[1] === 1 &&
        predTopk.length === 0;
    const hasRealTopk =
        tokenData.real_topk != null && Array.isArray(tokenData.real_topk) && !isPlaceholderTopk;
    return { predTopk, isPlaceholderTopk, hasRealTopk };
}

/** 归因弹窗：可点选候选、自定义高亮 token（默认同 tooltip 用 tokenData.raw） */
export type TooltipPredictionsExtraOptions = {
    interactive?: boolean;
    highlightToken?: string;
    /** 与 highlightToken 成对传入时可区分解码同形的多行候选 */
    highlightProb?: number;
};

/**
 * 与 ToolTip 内 `.predictions` 区域 HTML 一致（含条形图红字高亮、bpe 提示、缺失提示）。
 */
export function buildTooltipPredictionsInnerHtml(
    tokenData: FrontendToken | null | undefined,
    extra?: TooltipPredictionsExtraOptions
): string {
    if (!tokenData) return '';

    const { predTopk, hasRealTopk } = getFrontendTokenTopkState(tokenData);
    const hasPredictions = predTopk.length > 0;

    if (!hasPredictions && tokenData.bpe_merged == null) {
        return '';
    }
    if (tokenData.bpe_merged != null) {
        const partsHtml = bpeMergePartsTooltipHtml(tokenData.bpe_merge_parts);
        return (
            `<div class="row info-row topk-chart-info-row">` +
            `<div class="topk-chart-info-msg">${bpeMergedInfoMessage(tokenData.bpe_merged)}</div>` +
            partsHtml +
            `</div>`
        );
    }
    if (!hasPredictions) {
        return (
            `<div class="row info-row topk-chart-info-row">` +
            `<div class="topk-chart-info-msg">${tr('Top-k data not available.')}</div>` +
            `</div>`
        );
    }

    let topkData = predTopk.slice(0, DISPLAY_TOPK).map(([token, prob]) => ({ token, prob }));
    const selection =
        hasRealTopk && tokenData.real_topk != null
            ? topkDisplaySelection(tokenData.raw, tokenData.real_topk[1])
            : undefined;
    topkData = prepareTopkDisplayRows(topkData, selection);
    const highlight = extra?.highlightToken ?? tokenData.raw;
    let selectedProb: number | undefined;
    if (extra?.highlightProb != null && Number.isFinite(extra.highlightProb)) {
        selectedProb = extra.highlightProb;
    } else if (hasRealTopk && highlight === tokenData.raw && tokenData.real_topk != null) {
        selectedProb = tokenData.real_topk[1];
    } else {
        const row = predTopk.find(([t]) => t === highlight);
        if (row) selectedProb = row[1];
    }
    return renderTopkChartHtml(topkData, {
        selectedToken: highlight,
        selectedProb,
        interactivePickable: extra?.interactive === true,
    });
}
