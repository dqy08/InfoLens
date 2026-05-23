/**
 * 语义分析 / 归因页复用：abbrev + topk 条形图（与 Tooltip 一致）。
 * 归因页的 target token/prob 由 text-layer 内 ghost pill 展示；此处仍接收 target 仅用于 top-k 排序与高亮。
 */
import { escapeHtml } from '../../cross/tokenDisplayUtils';
import {
    prepareTopkDisplayRows,
    renderTopkChartFullHtml,
    topkDisplaySelection,
} from '../../cross/topkChartUtils';

export type SemanticDebugInfoPayload = {
    abbrev?: string;
    topk_tokens?: string[];
    topk_probs?: number[];
};

/** 归因：与 ghost pill 同源，仅用于 top-k 行序与条形图选中态 */
export type AttributionTarget = {
    token?: string;
    prob?: number | null;
};

export type BuildSemanticDebugInfoOptions = {
    omitAbbrev?: boolean;
    attributionTarget?: AttributionTarget;
};

/**
 * 生成 `.semantic-debug-info` 内部 HTML（abbrev 可选；有 topk 时含图表）。
 */
export function buildSemanticDebugInfoHtml(
    abbrev: string | undefined,
    top10: Array<{ token: string; prob: number }> | undefined,
    options?: BuildSemanticDebugInfoOptions
): string {
    const showAbbrev = !options?.omitAbbrev && !!abbrev;
    if (!showAbbrev && !top10?.length) {
        return '';
    }
    const parts: string[] = [];
    if (showAbbrev && abbrev) {
        parts.push(`<div class="semantic-debug-abbrev"><pre>${escapeHtml(abbrev)}</pre></div>`);
    }
    if (top10?.length) {
        const at = options?.attributionTarget;
        const tok = at?.token;
        const chartOpts =
            tok !== undefined && tok !== ''
                ? {
                      selectedToken: tok,
                      ...(at?.prob != null && Number.isFinite(at.prob) ? { selectedProb: at.prob } : {}),
                  }
                : undefined;
        parts.push(renderTopkChartFullHtml(top10, chartOpts));
    }
    return parts.join('');
}

export function debugInfoToTop10(
    di: SemanticDebugInfoPayload | undefined
): Array<{ token: string; prob: number }> | undefined {
    if (!di?.topk_tokens?.length || !di?.topk_probs?.length) return undefined;
    return di.topk_tokens.map((token, i) => ({ token, prob: di.topk_probs![i] ?? 0 }));
}

/**
 * 在 `#${parentId}` 内挂载或更新单个 `.semantic-debug-info` 面板（语义分析与归因共用）。
 */
export function applySemanticDebugInfoPanel(
    parentId: string,
    panelElementId: string,
    args: {
        debugInfo?: SemanticDebugInfoPayload;
        /** 与 `args.debugInfo.abbrev` 同时传入时以此处为准 */
        abbrev?: string;
        omitAbbrev?: boolean;
        attributionTarget?: AttributionTarget;
    }
): void {
    const parent = document.getElementById(parentId);
    if (!parent) return;
    let el = document.getElementById(panelElementId);
    if (!el) {
        el = document.createElement('div');
        el.id = panelElementId;
        el.className = 'semantic-debug-info';
        parent.appendChild(el);
    }
    const abbrev = args.abbrev ?? args.debugInfo?.abbrev;
    let top10 = debugInfoToTop10(args.debugInfo);
    const selection = topkDisplaySelection(args.attributionTarget?.token, args.attributionTarget?.prob);
    if (top10?.length) {
        top10 = prepareTopkDisplayRows(top10, selection);
    }
    const inner = buildSemanticDebugInfoHtml(abbrev, top10, {
        omitAbbrev: args.omitAbbrev,
        attributionTarget: args.attributionTarget,
    });
    if (!inner) {
        el.style.display = 'none';
        el.innerHTML = '';
        return;
    }
    el.style.display = 'block';
    el.innerHTML = inner;
}
