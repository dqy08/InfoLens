import { D3Sel, calculateSurprisal, calculateSurprisalDensity } from "../utils/Util";
import { SimpleEventHandler } from "../utils/SimpleEventHandler";
import { GLTR_RenderItem } from "./GLTR_Text_Box";
import type { FrontendToken } from "../api/GLTR_API";
import * as d3 from "d3";
import { tr } from "../lang/i18n-lite";
import { getTokenRenderStyle } from "../utils/tokenRenderStyle";
import { tooltipTokenDisplayHtml } from "../utils/tokenDisplayUtils";
import {
    buildTooltipPredictionsInnerHtml,
    getFrontendTokenTopkState,
} from '../utils/tooltipPredictionsFromToken';

const SEPARATOR = '─────────────';

export type ToolTipOptions = {
    /** 真实 top-k 下 surprisal 行的标签（默认「信息量」） */
    surprisalRowLabel?: string;
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
    private pendingData: { ri: GLTR_RenderItem; event?: MouseEvent } | null = null;
    
    // 主题监听器
    private themeObserver: MutationObserver | null = null;

    private readonly surprisalRowLabel: string;

    constructor(private parent: D3Sel, private eh: SimpleEventHandler, options?: ToolTipOptions) {
        this.surprisalRowLabel = options?.surprisalRowLabel ?? tr('information:');
        this._init();
        this._setupThemeObserver();
        this._updateThemeColors();
    }


    private _init() {
        this.predictions = this.parent.select('.predictions');
        this.myDetail = this.parent.select('.myDetail');
        this.currentToken = this.parent.select('.currentToken');
        
        // 添加点击事件：点击 tooltip 任意位置关闭
        this.parent.on('click', (event) => {
            event.stopPropagation(); // 阻止事件冒泡，避免触发下方元素
            event.preventDefault(); // 阻止默认行为
            this.visibility = false;
        });
        
        // 移动端触摸事件
        this.parent.on('touchstart', (event) => {
            event.stopPropagation(); // 阻止事件冒泡，避免触发 body 的 touchstart
            event.preventDefault(); // 阻止默认行为
            this.visibility = false;
        });
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
     * 从event.target向上查找SVG rect元素，优先找到包含鼠标位置的rect
     * 解决事件绑定在group上时，target可能是group而不是rect的问题
     * @param target 事件目标元素
     * @param mouseX 鼠标X坐标
     * @param mouseY 鼠标Y坐标
     * @returns 找到的SVG rect元素，如果没找到则返回null
     */
    private _findTokenRect(target: EventTarget | null, mouseX: number, mouseY: number): SVGRectElement | null {
        if (!target) return null;
        
        let element = target as Element;
        
        // 如果target本身就是rect，直接返回
        if (element instanceof SVGRectElement) {
            return element;
        }
        
        // 如果target是group，查找包含鼠标位置的rect
        if (element instanceof SVGGElement) {
            const rects = element.querySelectorAll('rect');
            // 优先查找包含鼠标位置的rect
            for (const rect of rects) {
                const rectBounds = rect.getBoundingClientRect();
                if (mouseX >= rectBounds.left && mouseX <= rectBounds.right &&
                    mouseY >= rectBounds.top && mouseY <= rectBounds.bottom) {
                    return rect;
                }
            }
            // 如果没找到包含鼠标的rect，返回第一个rect（fallback）
            return rects[0] || null;
        }
        
        // 如果target是其他元素，向上查找parent
        let parent = element.parentElement;
        while (parent) {
            if (parent instanceof SVGRectElement) {
                return parent;
            }
            if (parent instanceof SVGGElement) {
                // 在group中查找包含鼠标位置的rect
                const rects = parent.querySelectorAll('rect');
                for (const rect of rects) {
                    const rectBounds = rect.getBoundingClientRect();
                    if (mouseX >= rectBounds.left && mouseX <= rectBounds.right &&
                        mouseY >= rectBounds.top && mouseY <= rectBounds.bottom) {
                        return rect;
                    }
                }
                return rects[0] || null;
            }
            parent = parent.parentElement;
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
            node.style.top = '0px';
            node.style.left = '0px';
        }
    }

    set visibility(vis: boolean) {
        if (vis == true) {
            this.parent.style('opacity', 1);
            this.parent.style('pointer-events', 'auto');  // 显示时允许点击
        } else {
            this.parent.style('opacity', 0);
            this.parent.style('pointer-events', 'none');  // 关闭时禁止点击，让事件穿透
        }
    }


    updateData(ri: GLTR_RenderItem, event?: MouseEvent) {
        // 防抖：取消之前的更新任务
        if (this.pendingUpdate !== null) {
            cancelAnimationFrame(this.pendingUpdate);
        }

        // 保存最新的数据
        this.pendingData = { ri, event };

        // 先将 tooltip 移到屏幕外，避免在位置计算完成前显示在旧位置
        // 这可以解决 iOS Safari 上触摸时的抖动问题：
        // 如果旧位置在触摸点下方，会触发 tooltip 的 touchstart 导致关闭
        const node = this.parent.node() as HTMLElement;
        if (node) {
            node.style.left = '-9999px';
        }
        this.visibility = true;

        // 使用 requestAnimationFrame 同时处理内容更新和位置计算
        this.pendingUpdate = requestAnimationFrame(() => {
            this.pendingUpdate = null;
            if (!this.pendingData) return;

            const { ri: currentRi, event: currentEvent } = this.pendingData;
            this.pendingData = null;

            // 更新内容
            this._updateContent(currentRi);

            // 立即计算位置（DOM已更新，getBoundingClientRect 能获取准确值）
            this._updatePosition(currentEvent);
        });
    }
    
    /**
     * 更新tooltip内容
     * 统一结构：语义区块（上） + 分隔线 + 信息密度区块（下，含汇总指标 + top-k 表格）
     */
    private _updateContent(ri: GLTR_RenderItem): void {
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

        // 1. 构建语义区块（pw score = raw_score_normed × P_pw × matchDegree，P_pw: x≤threshold 为 0，x>threshold 为 1；分块用 chunkMatchDegree，非分块用 full_match_degree）
        const semanticRows: string[] = [];
        if (hasSemantic && s) {
            if (s.pwScore !== undefined) semanticRows.push(renderField({ label: tr('pw score:'), value: this.numF(s.pwScore) }, detailColor, valueColor));
            if (s.signalProb !== undefined) semanticRows.push(renderField({ label: tr('signal probability:'), value: this.numF(s.signalProb) }, detailColor, valueColor));
            if (s.rawScoreNormed !== undefined) semanticRows.push(renderField({ label: tr('raw score normed:'), value: this.numF(s.rawScoreNormed) }, detailColor, valueColor));
            if (s.rawScore !== undefined) semanticRows.push(renderField({ label: tr('raw score:'), value: d3.format('.6f')(s.rawScore), valueColor: false }, detailColor, valueColor));
            if (s.chunkIndex !== undefined && s.chunkMatchDegree !== undefined) {
                semanticRows.push(renderField({
                    label: `chunk #${s.chunkIndex} match score:`,
                    value: (s.chunkMatchDegree * 100).toFixed(1) + '%'
                }, detailColor, valueColor));
            }
        }

        // 2. 构建信息密度区块（汇总指标）
        const infoRows: string[] = [];
        if (hasRealTopk) {
            const prob = tokenData.real_topk![1];
            const surprisal = calculateSurprisal(prob);
            const isClassic = getTokenRenderStyle() === 'classic';
            infoRows.push(renderField({ label: this.surprisalRowLabel, value: `${this.significantF(surprisal)} bits` }, detailColor, valueColor));
            if (!isClassic) {
                const informationDensity = calculateSurprisalDensity(tokenData);
                const utf8Size = new TextEncoder().encode(tokenData.raw).length;
                infoRows.unshift(renderField({ label: tr('information density:'), value: `${this.significantF(informationDensity)} ${tr('bits/Byte')}` }, detailColor, valueColor));
                infoRows.splice(1, 0, renderField({ label: tr('UTF-8 size:'), value: `${utf8Size} ${tr('bytes')}`, valueColor: false }, detailColor, valueColor));
            }
        }

        // 3. 合并 myDetail：语义 + 分隔线（仅当两区块都有时） + 信息
        const detailParts: string[] = [];
        if (semanticRows.length) detailParts.push(semanticRows.join('<br/>'));
        if (semanticRows.length && infoRows.length) detailParts.push(`<span style="color:${detailColor}">${SEPARATOR}</span>`);
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
     * 更新tooltip位置
     */
    private _updatePosition(event?: MouseEvent): void {
        const tooltipNode = this.parent.node() as HTMLElement;
        if (!tooltipNode) return;

        // 获取视口信息（用于边界检查）
        const viewport = this._getViewportInfo();

        // fixed：相对视口；absolute：相对 offsetParent（首页 #results、归因侧栏 #attribution_panel_results 等），
        // 不可写死 #results，否则侧栏 tooltip 的 left/top 会按主栏计算而跑出可视区。
        const isFixedPosition = window.getComputedStyle(tooltipNode).position === 'fixed';

        let anchorRect: { left: number; top: number; width: number; height: number };
        if (isFixedPosition) {
            anchorRect = {
                left: 0,
                top: 0,
                width: viewport.width,
                height: viewport.height,
            };
        } else {
            const anchor = tooltipNode.offsetParent as HTMLElement | null;
            if (!anchor) {
                throw new Error(
                    '[ToolTip] position:absolute 的 tooltip 必须有 offsetParent（请为祖先设置 position 等定位上下文）'
                );
            }
            anchorRect = anchor.getBoundingClientRect();
        }

        if (!event) {
            throw new Error('[ToolTip] 更新位置需要 pointer 事件（缺少 MouseEvent）');
        }
        const mouseX = event.clientX;
        const mouseY = event.clientY;
        const tokenRectElement = this._findTokenRect(event.target, mouseX, mouseY);
        if (!tokenRectElement) {
            throw new Error(
                '[ToolTip] 无法从 event.target 解析到 token 的 SVG rect，请检查 GLTR 事件目标与 DOM 结构'
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
            tokenLeft = tokenRect.left - anchorRect.left;
            tokenRight = tokenRect.right - anchorRect.left;
            tokenTop = tokenRect.top - anchorRect.top;
            tokenBottom = tokenRect.bottom - anchorRect.top;
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
            const yInViewport = y + anchorRect.top;
            if (yInViewport + tooltipHeight > viewport.height) {
                y = tokenTop - tooltipHeight - offset;
                const yTopInViewport = y + anchorRect.top;
                if (yTopInViewport < 0) {
                    y = -anchorRect.top + 5;
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