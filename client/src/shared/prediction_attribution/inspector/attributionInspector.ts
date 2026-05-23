import * as d3 from 'd3';
import type { D3Sel } from '../../core/Util';
import { GLTR_HoverEvent, GLTR_Mode, GLTR_Text_Box } from '../../../shared/vis/GLTR_Text_Box';
import { ToolTip } from '../../../shared/vis/ToolTip';
import type { SimpleEventHandler } from '../../core/SimpleEventHandler';
import type { AttributionApiResponse } from '../core/attributionResultCache';
import { applySemanticDebugInfoPanel } from '../core/semanticDebugInfo';
import { processCandidateText } from '../../cross/tokenDisplayUtils';
import { addDigitsMergeRenderListener } from '../../cross/digitsMergeManager';
import { buildAttributionDisplayResult, type AttributionDisplayOptions } from '../core/attributionDisplayModel';

/** 插在 `.text-layer` 末尾、与正文同一行。`lmf.update()` 后同步调用一次；全量异步渲染结束时由 GLTR `onFullTextLayerRenderComplete` 再同步（如分栏拖动后重建 text-layer）。 */
function applyInlineGhostPill(resultsRoot: D3Sel, targetToken: string | undefined): void {
    const textLayer = resultsRoot.select('.LMF .text-layer').node() as HTMLElement | null;
    if (!textLayer) return;
    textLayer.querySelector('.attribution-predicted-ghost-pill')?.remove();
    const pill = document.createElement('span');
    pill.className = 'attribution-predicted-ghost-pill';
    pill.innerHTML = processCandidateText(targetToken ?? '');
    textLayer.append(pill);
}

export type AttributionInspectorOptions = {
    resultsRoot: D3Sel;
    eventHandler: SimpleEventHandler;
    /**
     * Tooltip 根节点（默认 `resultsRoot.select('#major_tooltip')`）。
     * 侧栏等场景须传入独立节点，避免与主视图 `#major_tooltip` id 冲突。
     */
    tooltipRoot?: D3Sel;
    /** 挂载 debug 面板的父元素 id，默认与 `resultsRoot` 的节点 id 一致 */
    debugParentId?: string;
    debugPanelElementId?: string;
    /** 点击时收起 tooltip 的根（默认 `body`，侧栏可传入侧栏容器） */
    tooltipHideRoot?: D3Sel;
};

export type AttributionInspectorApi = {
    apply(context: string, response: AttributionApiResponse, displayOptions: AttributionDisplayOptions): void;
    reapply(displayOptions: AttributionDisplayOptions): void;
    getLastPayload(): { context: string; response: AttributionApiResponse } | null;
};

/**
 * 归因结果右栏：GLTR 文本渲染 + Tooltip + debug 面板。与左侧表单解耦，供完整页与后续侧栏共用。
 */
export function createAttributionInspector(options: AttributionInspectorOptions): AttributionInspectorApi {
    const {
        resultsRoot,
        eventHandler,
        tooltipRoot: tooltipRootOpt,
        debugPanelElementId = 'attribution_debug_info',
        tooltipHideRoot = d3.select('body'),
    } = options;
    const debugParentId = options.debugParentId ?? (resultsRoot.node() as HTMLElement | null)?.id ?? 'results';

    const tooltipParent =
        tooltipRootOpt && !tooltipRootOpt.empty() ? tooltipRootOpt : resultsRoot.select('#major_tooltip');
    const toolTip = new ToolTip(tooltipParent, eventHandler);

    let lastPayload: { context: string; response: AttributionApiResponse } | null = null;
    let lastDisplayOptions: AttributionDisplayOptions | null = null;

    const lmf = new GLTR_Text_Box(resultsRoot, eventHandler, {
        onFullTextLayerRenderComplete: () => {
            if (!lastPayload) return;
            applyInlineGhostPill(resultsRoot, lastPayload.response.target_token);
        },
    });
    lmf.updateOptions(
        {
            gltrMode: GLTR_Mode.fract_p,
            enableRenderAnimation: false,
            enableMinimap: false,
            semanticAnalysisMode: true,
            overlayForceDisableInfoDensityRender: true,
        },
        true
    );

    eventHandler.bind(GLTR_Text_Box.events.tokenHovered, (ev: GLTR_HoverEvent) => {
        if (ev.hovered) {
            toolTip.updateData(ev.d, ev.event);
        } else {
            toolTip.visibility = false;
        }
    });

    tooltipHideRoot.on('touchstart.attributionInspector', () => {
        toolTip.hideAndReset();
    });

    function applyInternal(
        context: string,
        response: AttributionApiResponse,
        displayOptions: AttributionDisplayOptions
    ): void {
        lastPayload = { context, response };
        lastDisplayOptions = displayOptions;
        const displayResult = buildAttributionDisplayResult(context, response, displayOptions);
        lmf.update(displayResult);
        applyInlineGhostPill(resultsRoot, response.target_token);
        applySemanticDebugInfoPanel(debugParentId, debugPanelElementId, {
            debugInfo: response.debug_info,
            attributionTarget: { token: response.target_token, prob: response.target_prob },
        });
    }

    addDigitsMergeRenderListener(() => {
        if (!lastPayload || !lastDisplayOptions) return;
        applyInternal(lastPayload.context, lastPayload.response, lastDisplayOptions);
    });

    return {
        apply(context, response, displayOptions) {
            applyInternal(context, response, displayOptions);
        },
        reapply(displayOptions) {
            if (!lastPayload) return;
            const { context, response } = lastPayload;
            applyInternal(context, response, displayOptions);
        },
        getLastPayload() {
            return lastPayload;
        },
    };
}
