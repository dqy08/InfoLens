import * as d3 from 'd3';
import { SimpleEventHandler } from '../../core/SimpleEventHandler';
import { GLTR_Text_Box, type GLTR_TokenClickEvent } from '../../../shared/vis/GLTR_Text_Box';
import { showAlertDialog, showDialog } from '../../../shared/ui/dialog';
import type { FrontendAnalyzeResult, FrontendToken } from '../../../shared/api/GLTR_API';
import {
    entryKey,
    takeSuccessfulAttributionFromCache,
    type AttributionApiResponse,
    type PredictionAttributeModelVariant,
} from '../core/attributionResultCache';
import { loadPredictionAttributeWithCache } from '../core/predictionAttributeClient';
import { createAttributionInspector, type AttributionInspectorApi } from '../inspector/attributionInspector';
import { contextAndTargetFromTokenIndex } from '../core/contextTargetFromAnalyze';
import type { AttributionDisplayOptions } from '../core/attributionDisplayModel';
import { DEFAULT_CONTENT_URL_PARAM } from '../../cross/contentUrl';
import { readStoredEffectiveExcludePromptPatternsText } from '../core/attributionExcludePromptPatternsStorage';
import { processCandidateText } from '../../cross/tokenDisplayUtils';
import { buildTooltipPredictionsInnerHtml } from '../../cross/tooltipPredictionsFromToken';
import { isNarrowScreen } from '../../core/responsive';
import { tr } from '../../../shared/lang/i18n-lite';
import { translateApiErrorMessage } from '../../core/errorUtils';

/**
 * @param prefixLength Chat 等场景下拼在原文前的模板前缀长度；为 0 时整段 `context` 均可匹配（与独立归因页一致）。
 */
function attributionPanelDisplayOptions(context: string, prefixLength: number): AttributionDisplayOptions {
    if (prefixLength <= 0) {
        return {
            colorRangeMax: null,
            excludePromptPatternsText: readStoredEffectiveExcludePromptPatternsText(),
        };
    }
    const end = Math.min(prefixLength, context.length);
    return {
        colorRangeMax: null,
        excludePromptPatternsText: readStoredEffectiveExcludePromptPatternsText(),
        excludePromptPatternsRegion: { start: 0, end },
    };
}

const ATTRIBUTION_PANEL_MIN_WIDTH_PX = 200;

function clampAttributionPanelWidth(px: number): number {
    const max = window.innerWidth;
    return Math.max(ATTRIBUTION_PANEL_MIN_WIDTH_PX, Math.min(max, Math.round(px)));
}

/** 桌面：与主区 `.right_panel` 同宽（resizer 右侧）；窄屏：90% 视口宽 */
function computeDefaultAttributionPanelWidth(): number {
    if (isNarrowScreen()) {
        return clampAttributionPanelWidth(window.innerWidth * 0.9);
    }
    const resizer_width = 8;
    const rp = document.querySelector('.right_panel') as HTMLElement | null;
    const w =
        rp && rp.offsetWidth > 0 ? rp.offsetWidth + resizer_width : Math.min(440, window.innerWidth);
    return clampAttributionPanelWidth(w);
}

export type DensityAttributionSidebarOptions = {
    /** 主视图 GLTR 所用（仅订阅 tokenClicked） */
    eventHandler: SimpleEventHandler;
    /** 点击 token 后解析 context 时使用，与当前屏上展示一致 */
    getCurrentAnalyzeResult: () => FrontendAnalyzeResult | null;
    apiPrefix: string;
    /** 与 {@link URLHandler.parameters} 一致：非空则请求走该基址 */
    showToast: (message: string, type: 'success' | 'error' | 'info') => void;
    /**
     * 归因 context 的前缀，拼在 originalText 切片之前。
     * Chat 页传 `() => prompt_used`，首页不传（默认空串）。
     */
    getContextPrefix?: () => string;
    /** 首页 base；Chat 与续写槽位一致时可传 getter */
    predictionModelVariant: PredictionAttributeModelVariant;
    getPredictionModelVariant?: () => PredictionAttributeModelVariant;
    sourcePage: 'analysis' | 'chat';
    /** 为 false 时忽略 token 点击（如首页 Semantic Query 模式）；默认允许 */
    isTokenClickAttributionEnabled?: () => boolean;
};

function resolvePredictionModelVariant(
    options: DensityAttributionSidebarOptions
): PredictionAttributeModelVariant {
    return options.getPredictionModelVariant?.() ?? options.predictionModelVariant;
}

/**
 * 首页信息密度：点击 token → 确认 → 打开右侧归因面板；可跳转完整归因页（带缓存键）。
 */
export function initDensityAttributionSidebar(options: DensityAttributionSidebarOptions): void {
    const { eventHandler, getCurrentAnalyzeResult, showToast } = options;
    const apiBaseForRequests = options.apiPrefix === '' ? '' : String(options.apiPrefix);

    const panel = d3.select('#attribution_side_panel');
    const flowBackdrop = d3.select('#attribution_flow_backdrop');
    const resizeHandle = d3.select('#attribution_side_panel_resize_handle');
    const closeBtn = d3.select('#attribution_side_panel_close');
    const fullPageLink = d3.select('#attribution_open_full_page') as d3.Selection<
        HTMLAnchorElement,
        unknown,
        HTMLElement,
        unknown
    >;

    const panelNode = panel.node() as HTMLElement | null;
    if (!panelNode) {
        console.warn('[densityAttribution] #attribution_side_panel missing, skip init');
        return;
    }

    /** 必须用侧栏根节点而非 `document.body`，否则与主视图共用同一 DOM 事件目标，`tokenHovered` 会在两处 GLTR 同时触发侧栏 Tooltip。 */
    const panelEventHandler = new SimpleEventHandler(panelNode);
    let inspector: AttributionInspectorApi | null = null;

    function getInspector(): AttributionInspectorApi {
        if (!inspector) {
            inspector = createAttributionInspector({
                resultsRoot: d3.select('#attribution_panel_results'),
                eventHandler: panelEventHandler,
                tooltipRoot: d3.select('#attribution_panel_tooltip'),
                debugParentId: 'attribution_panel_results',
                debugPanelElementId: 'attribution_panel_debug_info',
                tooltipHideRoot: d3.select('#attribution_side_panel'),
            });
        }
        return inspector;
    }

    function applyAttributionPanelWidth(px: number): void {
        panelNode.style.width = `${clampAttributionPanelWidth(px)}px`;
    }

    function setFlowBackdropVisible(visible: boolean): void {
        if (flowBackdrop.empty()) return;
        flowBackdrop.classed('attribution-flow-backdrop--visible', visible);
        flowBackdrop.attr('aria-hidden', visible ? 'false' : 'true');
    }

    function setPanelOpen(open: boolean): void {
        if (open) {
            applyAttributionPanelWidth(computeDefaultAttributionPanelWidth());
            const scrollRoot = panelNode.querySelector(
                '.attribution-side-panel-body',
            ) as HTMLElement | null;
            if (scrollRoot) {
                scrollRoot.scrollTop = 0;
                scrollRoot.scrollLeft = 0;
            }
        }
        panel.classed('attribution-side-panel--open', open);
        panel.attr('aria-hidden', open ? 'false' : 'true');
        if (!open) {
            setFlowBackdropVisible(false);
        }
    }

    function onWindowResize(): void {
        if (panel.classed('attribution-side-panel--open')) {
            applyAttributionPanelWidth(panelNode.offsetWidth);
        } else {
            applyAttributionPanelWidth(computeDefaultAttributionPanelWidth());
        }
    }

    applyAttributionPanelWidth(computeDefaultAttributionPanelWidth());
    window.addEventListener('resize', onWindowResize);

    if (!flowBackdrop.empty()) {
        flowBackdrop.on('click', () => {
            if (panel.classed('attribution-side-panel--open')) {
                setPanelOpen(false);
            }
        });
    }

    if (!resizeHandle.empty()) {
        let dragging = false;
        let dragStartX = 0;
        let dragStartWidth = 0;

        resizeHandle.on('mousedown', function (event: MouseEvent) {
            event.preventDefault();
            event.stopPropagation();
            dragging = true;
            dragStartX = event.clientX;
            dragStartWidth = panelNode.offsetWidth;
            d3.select('body').style('cursor', 'col-resize').style('user-select', 'none');
            d3.select(window)
                .on('mousemove.attributionPanelResize', (ev: MouseEvent) => {
                    if (!dragging) return;
                    ev.preventDefault();
                    const delta = ev.clientX - dragStartX;
                    applyAttributionPanelWidth(dragStartWidth - delta);
                })
                .on('mouseup.attributionPanelResize', () => {
                    dragging = false;
                    d3.select('body').style('cursor', null).style('user-select', null);
                    d3.select(window)
                        .on('mousemove.attributionPanelResize', null)
                        .on('mouseup.attributionPanelResize', null);
                });
        });
    }

    function buildFullPageHref(context: string, targetPrediction: string): string {
        const key = entryKey(context, targetPrediction);
        const u = new URL('attribution.html', window.location.href);
        const api = options.apiPrefix === '' ? '' : String(options.apiPrefix);
        if (api) u.searchParams.set('api', api);
        u.searchParams.set(DEFAULT_CONTENT_URL_PARAM, key);
        return u.pathname + u.search + u.hash;
    }

    closeBtn.on('click', () => {
        setPanelOpen(false);
    });

    eventHandler.bind(GLTR_Text_Box.events.tokenClicked, (ev: GLTR_TokenClickEvent) => {
        if (options.isTokenClickAttributionEnabled && !options.isTokenClickAttributionEnabled()) {
            return;
        }
        if (ev.tokenIndex < 0) {
            return;
        }
        const rd = getCurrentAnalyzeResult();
        if (!rd) {
            return;
        }
        const pair = contextAndTargetFromTokenIndex(rd, ev.tokenIndex);
        if (!pair) {
            showToast(tr('Unable to resolve context for this token'), 'error');
            return;
        }
        const prefix = options.getContextPrefix?.() ?? '';
        const { context: rawContext, targetPrediction } = pair;
        const context = prefix + rawContext;
        if (context.length === 0) {
            return;
        }

        let selectedTarget = targetPrediction;
        const tokenForTopk = rd.bpe_strings[ev.tokenIndex] as FrontendToken | undefined;

        const renderTopkForDialog = (): string =>
            buildTooltipPredictionsInnerHtml(tokenForTopk, {
                interactive: true,
                highlightToken: selectedTarget,
            });

        const topkInner = renderTopkForDialog();

        const finish = (json: AttributionApiResponse): void => {
            getInspector().apply(context, json, attributionPanelDisplayOptions(context, prefix.length));
            fullPageLink.attr('href', buildFullPageHref(context, selectedTarget));
            setPanelOpen(true);
        };

        showDialog({
            title: 'Prediction attribution',
            confirmText: 'Analyze',
            cancelText: 'Cancel',
            width: 'clamp(320px, 92vw, 520px)',
            content: (dialog) => {
                dialog
                    .append('div')
                    .attr('class', 'dialog-attribution-confirm-hint')
                    .text(tr('Perform gradient attribution on the target token below.'));
                const targetBlock = dialog
                    .append('div')
                    .attr('class', 'dialog-attribution-confirm-target')
                    .html(
                        `<span class="label">Target prediction</span><code>${processCandidateText(selectedTarget)}</code>`
                    );
                if (topkInner) {
                    const topkBlock = dialog
                        .append('div')
                        .attr('class', 'dialog-attribution-confirm-topk predictions predictions-table')
                        .html(topkInner);
                    topkBlock.on('click', (event: MouseEvent) => {
                        const row = (event.target as HTMLElement | null)?.closest('[data-topk-pick]');
                        if (!row) return;
                        const enc = row.getAttribute('data-topk-pick');
                        if (enc == null) return;
                        let raw: string;
                        try {
                            raw = decodeURIComponent(enc);
                        } catch {
                            return;
                        }
                        event.stopPropagation();
                        selectedTarget = raw;
                        targetBlock.select('code').html(processCandidateText(raw));
                        topkBlock.html(renderTopkForDialog());
                    });
                }
                return {};
            },
            onConfirm: () => {
                setFlowBackdropVisible(true);

                void (async () => {
                    const hit = await takeSuccessfulAttributionFromCache(context, selectedTarget);
                    if (hit) {
                        finish(hit.response);
                        return;
                    }
                    const prevBodyCursor = document.body.style.cursor;
                    document.body.style.cursor = 'wait';
                    try {
                        const { response: json } = await loadPredictionAttributeWithCache({
                            apiBaseForRequests,
                            context,
                            targetPrediction: selectedTarget,
                            model: resolvePredictionModelVariant(options),
                            sourcePage: options.sourcePage,
                            forceRefresh: false,
                        });
                        finish(json);
                    } catch (err: unknown) {
                        setFlowBackdropVisible(false);
                        const msg = err instanceof Error ? err.message : String(err);
                        showAlertDialog(tr('Context Attribution'), translateApiErrorMessage(msg));
                    } finally {
                        document.body.style.cursor = prevBodyCursor;
                    }
                })();

                return true;
            },
        });
    });
}
