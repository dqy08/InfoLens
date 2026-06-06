import { D3Sel, calculateSurprisal, calculateSurprisalDensity } from "../core/Util";
import { SimpleEventHandler } from "../core/SimpleEventHandler";
import { GLTR_RenderItem } from "./GLTR_Text_Box";
import type { FrontendToken } from "../../shared/api/GLTR_API";
import * as d3 from "d3";
import { tr } from "../lang/i18n-lite";
import { getTokenRenderStyle } from "../cross/tokenRenderStyle";
import { tooltipTokenDisplayHtml } from "../cross/tokenDisplayUtils";
import {
    buildTooltipPredictionsInnerHtml,
    getFrontendTokenTopkState,
} from '../cross/tooltipPredictionsFromToken';

const SEPARATOR = '─────────────';

/** 贴在定位包含块角落时的留白（px）；{@link ToolTipOptions.placement} `parent-bottom-right` 使用 */
const CORNER_INSET_PX = 0;

export type ToolTipOptions = {
    /** 真实 top-k 下 surprisal 行的标签（默认「信息量」） */
    surprisalRowLabel?: string;
    /**
     * `parent-bottom-right`：`position:absolute`，贴在定位包含块（`offsetParent`）右下角（DAG Top‑K 作为 `#results` 直接子节点时即为 results 内侧右下）。
     * 该 HUD 模式不依赖锚点几何；面板应由页面 CSS（如 `.gen-attr-dag-topk-tooltip`）约束宽高，超出部分裁剪。
     * 默认 `anchor`：沿用原有相对 token rect 的定位。
     */
    placement?: 'anchor' | 'parent-bottom-right';
    /**
     * false：面板不参与命中测试（`pointer-events: none`），避免盖住底层 SVG 时在节点上反复 `mouseleave`/闪动；
     * 同时不注册点击/触摸收起。
     */
    pointerInteractive?: boolean;
};

/** {@link ToolTip.updateData} 可选增补（如 DAG：CI/MI 行紧跟 surprisal 之后） */
export type ToolTipUpdateAugment = {
    /** 在 surprisal / 信息密度行之前渲染（紧跟 token 文字，位于所有 info 行上方） */
    rowsBeforeInfo?: Array<{ label: string; value: string; valueColor?: boolean }>;
    rowsAfterSurprisal?: Array<{ label: string; value: string; valueColor?: boolean }>;
};

type DetailField = { label: string; value: string; valueColor?: boolean };

function renderField(f: DetailField, dc: string, vc: string): string {
    const valColor = f.valueColor !== false ? vc : dc;
    return `<span style="color: ${dc}">${f.label}</span> <span style="color: ${valColor}">${f.value}</span>`;
}

export class ToolTip {
    private predictions: D3Sel;
    private myDetail: D3Sel;
    private currentToken: D3Sel;
    
    // 缓存：d3 formatter（静态，可永久缓存）
    private readonly numF = d3.format('.3f');
    private readonly significantF = d3.format('.3g');
    
    // 缓存：主题颜色（Top-K 表格行已改由 CSS 变量，见 tooltipPredictionsFromToken / topkChartUtils / .predictions-table）
    private themeColors = {
        selectedColor: '#933',
        detailColor: '#666666',
        valueColor: '#333'
    };
    
    // 防抖：pending 的更新任务
    private pendingUpdate: number | null = null;
    private pendingData: {
        ri: GLTR_RenderItem;
        anchorTarget: EventTarget | null;
        augment?: ToolTipUpdateAugment;
    } | null = null;
    
    // 主题监听器
    private themeObserver: MutationObserver | null = null;

    private readonly surprisalRowLabel: string;
    private readonly placement: NonNullable<ToolTipOptions['placement']>;
    private readonly pointerInteractive: boolean;

    constructor(private parent: D3Sel, private eh: SimpleEventHandler, options?: ToolTipOptions) {
        this.surprisalRowLabel = options?.surprisalRowLabel ?? tr('information:');
        this.placement = options?.placement ?? 'anchor';
        this.pointerInteractive = options?.pointerInteractive ?? true;
        if (!this.pointerInteractive) {
            this.parent.classed('tooltip-no-pointer-hit', true);
        }
        const el = this.parent.node() as HTMLElement | null;
        if (el && this.placement === 'parent-bottom-right') {
            el.style.position = 'absolute';
        }
        this._init();
        this._setupThemeObserver();
        this._updateThemeColors();
    }


    private _init() {
        this.predictions = this.parent.select('.predictions');
        this.myDetail = this.parent.select('.myDetail');
        this.currentToken = this.parent.select('.currentToken');

        if (this.pointerInteractive) {
            this.parent.on('click', (event) => {
                event.stopPropagation();
                event.preventDefault();
                this.visibility = false;
            });
            this.parent.on('touchstart', (event) => {
                event.stopPropagation();
                event.preventDefault();
                this.visibility = false;
            });
        }
    }
    
    /**
     * 设置主题变化监听器
     */
    private _setupThemeObserver(): void {
        // 监听 document.documentElement 的 data-theme 属性变化
        this.themeObserver = new MutationObserver(() => {
            this._updateThemeColors();
        });
        
        this.themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
    }
    
    /**
     * 更新主题颜色缓存
     */
    private _updateThemeColors(): void {
        const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
        // 从 CSS 变量获取文本颜色（如果可用，否则使用默认值）
        const textColorLight = getComputedStyle(document.documentElement)
            .getPropertyValue('--text-color-light')
            .trim() || '#e0e0e0';
        this.themeColors = {
            selectedColor: isDark ? '#ff6666' : '#933',
            detailColor: isDark ? '#888' : '#666666',
            valueColor: isDark ? textColorLight : '#333'
        };
    }
    
    /**
     * 获取真实的可见视口尺寸和偏移量
     * 优先使用 visualViewport API（解决 iOS Safari 地址栏动态显示/隐藏问题）
     * 备选方案：使用 document.documentElement.clientHeight（相对稳定）
     */
    private _getViewportInfo(): { 
        width: number; 
        height: number; 
        offsetTop: number; 
        offsetLeft: number;
    } {
        // 优先使用 visualViewport API（iOS Safari 13+, Chrome 61+）
        if (window.visualViewport) {
            return {
                width: window.visualViewport.width,
                height: window.visualViewport.height,
                offsetTop: window.visualViewport.offsetTop || 0,
                offsetLeft: window.visualViewport.offsetLeft || 0
            };
        }
        // 备选方案：使用 document.documentElement.clientHeight
        // 这个值相对稳定，不受地址栏影响
        return {
            width: window.innerWidth,
            height: document.documentElement.clientHeight || window.innerHeight,
            offsetTop: 0,
            offsetLeft: 0
        };
    }
    
    /**
     * 从事件目标解析用于定位的 SVG rect（与指针坐标无关）：rect 自身、或容器 `g` 内首个 `rect`、或向上追溯。
     */
    private _resolveAnchorRectElement(target: EventTarget | null): SVGRectElement | null {
        if (!target || !(target instanceof Element)) return null;
        let element: Element | null = target;
        if (element instanceof SVGRectElement) return element;
        if (element instanceof SVGGElement) {
            return element.querySelector('rect');
        }
        while (element) {
            if (element instanceof SVGRectElement) return element;
            if (element instanceof SVGGElement) {
                const r = element.querySelector('rect');
                if (r) return r;
            }
            element = element.parentElement;
        }
        return null;
    }
    
    /**
     * 清理资源
     */
    dispose(): void {
        if (this.themeObserver) {
            this.themeObserver.disconnect();
            this.themeObserver = null;
        }
        if (this.pendingUpdate !== null) {
            cancelAnimationFrame(this.pendingUpdate);
            this.pendingUpdate = null;
        }
    }

    /**
     * 隐藏并重置位置，避免残留的绝对定位撑高容器
     */
    hideAndReset(): void {
        const node = this.parent.node() as HTMLElement | null;
        if (this.pendingUpdate !== null) {
            cancelAnimationFrame(this.pendingUpdate);
            this.pendingUpdate = null;
        }
        this.pendingData = null;
        this.visibility = false;
        if (node) {
            if (this.placement === 'parent-bottom-right') {
                this._placeParentBottomRight(node);
            } else {
                node.style.top = '0px';
                node.style.left = '0px';
            }
        }
    }

    /** 固定在 offsetParent（含隐藏态占位）右下角 */
    private _placeParentBottomRight(node: HTMLElement): void {
        node.style.position = 'absolute';
        node.style.right = `${CORNER_INSET_PX}px`;
        node.style.left = 'auto';
        node.style.top = 'auto';
        node.style.bottom = `${CORNER_INSET_PX}px`;
    }

    set visibility(vis: boolean) {
        const node = this.parent.node() as HTMLElement | null;
        if (vis == true) {
            node?.classList.add('tooltip-visible');
            node?.style.removeProperty('opacity');
            this.parent.style('pointer-events', this.pointerInteractive ? 'auto' : 'none');
        } else {
            node?.classList.remove('tooltip-visible');
            this.parent.style('opacity', 0);
            this.parent.style('pointer-events', 'none');  // 关闭时禁止点击，让事件穿透
        }
    }


    /**
     * @param eventOrAnchor 指针事件（使用 `target`）或直接传入用作锚点的元素（如 SVG `rect` / `g`）
     */
    updateData(
        ri: GLTR_RenderItem,
        eventOrAnchor?: MouseEvent | TouchEvent | Element | null,
        augment?: ToolTipUpdateAugment
    ) {
        // 防抖：取消之前的更新任务
        if (this.pendingUpdate !== null) {
            cancelAnimationFrame(this.pendingUpdate);
        }

        const anchorTarget =
            eventOrAnchor instanceof Element
                ? eventOrAnchor
                : eventOrAnchor && 'target' in eventOrAnchor
                  ? (eventOrAnchor.target as EventTarget | null)
                  : null;

        // 保存最新的数据
        this.pendingData = { ri, anchorTarget, augment };

        // 先将 tooltip 移到屏幕外，避免在位置计算完成前显示在旧位置
        // 这可以解决 iOS Safari 上触摸时的抖动问题：
        // 如果旧位置在触摸点下方，会触发 tooltip 的 touchstart 导致关闭
        const node = this.parent.node() as HTMLElement;
        if (node) {
            if (this.placement === 'parent-bottom-right') {
                this._placeParentBottomRight(node);
            } else {
                node.style.left = '-9999px';
            }
        }
        this.visibility = true;

        // 使用 requestAnimationFrame 同时处理内容更新和位置计算
        this.pendingUpdate = requestAnimationFrame(() => {
            this.pendingUpdate = null;
            if (!this.pendingData) return;

            const { ri: currentRi, anchorTarget: at, augment } = this.pendingData;
            this.pendingData = null;

            // 更新内容
            this._updateContent(currentRi, augment);

            // 立即计算位置（DOM已更新，getBoundingClientRect 能获取准确值）
            this._updatePosition(at);
        });
    }
    
    /**
     * 更新tooltip内容
     * 统一结构：语义区块（上） + 分隔线 + 信息密度区块（下，含汇总指标 + top-k 表格）
     */
    private _updateContent(ri: GLTR_RenderItem, augment?: ToolTipUpdateAugment): void {
        const { selectedColor, detailColor, valueColor } = this.themeColors;

        // 更新当前token显示（第一行）
        this.currentToken.html(() => {
            const visualizedToken = tooltipTokenDisplayHtml(ri.tokenData.raw);
            return `<span style="color: ${selectedColor};">${visualizedToken}</span>`;
        });

        const tokenData = ri.tokenData as FrontendToken;
        const s = ri.semantic;
        const hasSemantic =
            s &&
            (s.pwScore !== undefined ||
                s.signalProb !== undefined ||
                s.rawScoreNormed !== undefined ||
                s.rawScore !== undefined ||
                (s.chunkIndex !== undefined && s.chunkMatchDegree !== undefined));
        const { hasRealTopk } = getFrontendTokenTopkState(tokenData);

        // 1. 构建上区块：语义行 + rowsBeforeInfo（DAG 归因份额等附加行）
        // 二者在视觉上同属"token 语义信息"，与下方信息密度区块以分隔线隔开
        const topRows: string[] = [];
        if (hasSemantic && s) {
            if (s.pwScore !== undefined) topRows.push(renderField({ label: tr('pw score:'), value: this.numF(s.pwScore) }, detailColor, valueColor));
            if (s.signalProb !== undefined) topRows.push(renderField({ label: tr('signal probability:'), value: this.numF(s.signalProb) }, detailColor, valueColor));
            if (s.rawScoreNormed !== undefined) topRows.push(renderField({ label: tr('raw score normed:'), value: this.numF(s.rawScoreNormed) }, detailColor, valueColor));
            if (s.rawScore !== undefined) topRows.push(renderField({ label: tr('raw score:'), value: d3.format('.6f')(s.rawScore), valueColor: false }, detailColor, valueColor));
            if (s.chunkIndex !== undefined && s.chunkMatchDegree !== undefined) {
                topRows.push(renderField({
                    label: `chunk #${s.chunkIndex} match score:`,
                    value: (s.chunkMatchDegree * 100).toFixed(1) + '%'
                }, detailColor, valueColor));
            }
        }
        for (const f of augment?.rowsBeforeInfo ?? []) {
            topRows.push(renderField(f, detailColor, valueColor));
        }

        // 2. 构建信息密度区块：按明确顺序追加，避免脆弱的 unshift/splice
        const infoRows: string[] = [];
        if (hasRealTopk) {
            const prob = tokenData.real_topk![1];
            const surprisal = calculateSurprisal(prob);
            const isClassic = getTokenRenderStyle() === 'classic';
            if (!isClassic) {
                const informationDensity = calculateSurprisalDensity(tokenData);
                const utf8Size = new TextEncoder().encode(tokenData.raw).length;
                infoRows.push(renderField({ label: tr('information density:'), value: `${this.significantF(informationDensity)} ${tr('bits/Byte')}` }, detailColor, valueColor));
                infoRows.push(renderField({ label: tr('UTF-8 size:'), value: `${utf8Size} ${tr('bytes')}`, valueColor: false }, detailColor, valueColor));
            }
            infoRows.push(renderField({ label: this.surprisalRowLabel, value: `${this.significantF(surprisal)} bits` }, detailColor, valueColor));
        }
        for (const f of augment?.rowsAfterSurprisal ?? []) {
            infoRows.push(renderField(f, detailColor, valueColor));
        }

        // 3. 合并 myDetail：上区块 + 分隔线（仅当两区块都有时） + 信息密度区块
        const detailParts: string[] = [];
        if (topRows.length) detailParts.push(topRows.join('<br/>'));
        if (topRows.length && infoRows.length) detailParts.push(`<span style="color:${detailColor}">${SEPARATOR}</span>`);
        if (infoRows.length) detailParts.push(infoRows.join('<br/>'));
        this.myDetail.html(detailParts.join('<br/>'));

        // 4. 更新 predictions（top-k 属于信息密度区块，与 buildTooltipPredictionsInnerHtml 共用逻辑）
        const predInner = buildTooltipPredictionsInnerHtml(tokenData);
        if (predInner === '') {
            this.predictions.selectAll('.row').data([]).join('div').remove();
        } else {
            this.predictions.html(predInner);
        }
    }

    /**
     * 更新tooltip位置（相对锚点元素几何，不依赖指针坐标）
     */
    private _updatePosition(anchorTarget: EventTarget | null): void {
        const tooltipNode = this.parent.node() as HTMLElement;
        if (!tooltipNode) return;

        if (this.placement === 'parent-bottom-right') {
            this._placeParentBottomRight(tooltipNode);
            return;
        }

        // 获取视口信息（用于边界检查）
        const viewport = this._getViewportInfo();

        // fixed：相对视口；absolute：相对 offsetParent（首页 #results、归因侧栏 #attribution_panel_results 等），
        // 不可写死 #results，否则侧栏 tooltip 的 left/top 会按主栏计算而跑出可视区。
        const isFixedPosition = window.getComputedStyle(tooltipNode).position === 'fixed';

        let anchorRect: { left: number; top: number; width: number; height: number };
        let anchor: HTMLElement | null = null;
        if (isFixedPosition) {
            anchorRect = {
                left: 0,
                top: 0,
                width: viewport.width,
                height: viewport.height,
            };
        } else {
            anchor = tooltipNode.offsetParent as HTMLElement | null;
            if (!anchor) {
                throw new Error(
                    '[ToolTip] position:absolute 的 tooltip 必须有 offsetParent（请为祖先设置 position 等定位上下文）'
                );
            }
            anchorRect = anchor.getBoundingClientRect();
        }

        const tokenRectElement = this._resolveAnchorRectElement(anchorTarget);
        if (!tokenRectElement) {
            throw new Error(
                '[ToolTip] 无法从锚点解析到 SVG rect，请传入 token rect、g 或其它含 rect 的祖先元素'
            );
        }

        let tokenLeft = 0,
            tokenRight = 0,
            tokenTop = 0,
            tokenBottom = 0;
        const tokenRect = tokenRectElement.getBoundingClientRect();
        if (isFixedPosition) {
            tokenLeft = tokenRect.left;
            tokenRight = tokenRect.right;
            tokenTop = tokenRect.top;
            tokenBottom = tokenRect.bottom;
        } else {
            // 祖先滚动在 getBoundingClientRect 差值中已抵消；仅需 offsetParent 自身 scrollTop
            tokenLeft = tokenRect.left - anchorRect.left + anchor!.scrollLeft;
            tokenRight = tokenRect.right - anchorRect.left + anchor!.scrollLeft;
            tokenTop = tokenRect.top - anchorRect.top + anchor!.scrollTop;
            tokenBottom = tokenRect.bottom - anchorRect.top + anchor!.scrollTop;
        }

        // 获取tooltip尺寸
        const tooltipRect = tooltipNode.getBoundingClientRect();
        const tooltipWidth = tooltipRect.width || 250;
        const tooltipHeight = tooltipRect.height || 100;
        
        const offset = 15; // 统一偏移量
        
        // 计算初始位置（token右下方）
        let x = tokenRight + offset;
        let y = tokenBottom + offset;
        
        // 水平方向边界检查
        const containerWidth = isFixedPosition ? viewport.width : anchorRect.width;
        if (x + tooltipWidth > containerWidth) {
            const leftX = tokenLeft - tooltipWidth - offset;
            x = leftX >= 5 ? leftX : containerWidth - tooltipWidth - 5;
        }
        
        // 垂直方向边界检查
        if (isFixedPosition) {
            if (y + tooltipHeight > viewport.height) {
                y = Math.max(5, tokenTop - tooltipHeight - offset);
            }
        } else {
            let yInViewport = anchorRect.top + y - anchor!.scrollTop;
            if (yInViewport + tooltipHeight > viewport.height) {
                y = tokenTop - tooltipHeight - offset;
                yInViewport = anchorRect.top + y - anchor!.scrollTop;
                if (yInViewport < 0) {
                    y = -anchorRect.top + anchor!.scrollTop + 5;
                }
            }
        }
        
        // 应用位置
        this.parent.styles({
            top: y + 'px',
            left: x + 'px',
        });
    }


}