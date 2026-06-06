/**
 * 高亮管理器：直方图 token 高亮（边框/下划线）+ chunk 字符区间下划线（独立 SVG 线段）
 */

import {HighlightStyle, RectCacheEntry} from "./types";
import {HIGHLIGHT_CONSTANTS} from "./constants";

/** 字符区间下划线线段（与 SVG overlay 坐标系一致） */
export type CharIntervalUnderlineSeg = { x1: number; x2: number; y: number };

export class HighlightManager {
    private rectCache: Map<string, RectCacheEntry>;
    private underlineCache: Map<string, SVGLineElement>;
    private svgOverlay: SVGSVGElement;
    private currentStyle: HighlightStyle = 'border';
    private readonly MAX_RETRY_ATTEMPTS = 10;
    /** rect 缓存未就绪时的重试计数（与直方图 / 区间下划线分开，避免互相打断） */
    private rectCacheWait = { indices: 0, interval: 0 };
    private intervalUnderlineLines: SVGLineElement[] = [];
    private charIntervalFadeTimeout: number | undefined;

    constructor(
        svgOverlay: SVGSVGElement,
        rectCache: Map<string, RectCacheEntry>,
        underlineCache: Map<string, SVGLineElement>
    ) {
        this.svgOverlay = svgOverlay;
        this.rectCache = rectCache;
        this.underlineCache = underlineCache;
    }

    /**
     * 设置需要高亮的token索引
     * @param indices 需要高亮的token索引集合
     * @param highlightStyle 高亮样式：'border' 使用边框，'underline' 使用下划线
     */
    setHighlightedIndices(indices: Set<number>, highlightStyle: HighlightStyle = 'border'): void {
        this.whenRectCacheReady('indices', 'HighlightManager: token 高亮缓存未就绪，已达最大重试', () => {
            this.removeIntervalSvgLines();

            if (this.currentStyle !== highlightStyle) {
                this.clearPreviousStyle(this.currentStyle);
            }
            this.currentStyle = highlightStyle;

            const highlightedRects: SVGRectElement[] = [];

            this.rectCache.forEach(({ rect, tokenIndex }, rectKey) => {
                const currentClass = rect.getAttribute('class') || '';
                const isHighlighted = indices.has(tokenIndex);

                if (highlightStyle === 'underline') {
                    this.applyUnderlineHighlight(rect, rectKey, isHighlighted, currentClass);
                } else {
                    this.applyBorderHighlight(rect, rectKey, isHighlighted, currentClass, highlightedRects);
                }
            });

            if (highlightStyle === 'border' && highlightedRects.length > 0) {
                highlightedRects.forEach(rect => {
                    if (rect.parentNode === this.svgOverlay) {
                        this.svgOverlay.appendChild(rect);
                    }
                });
            }
        });
    }

    /**
     * 应用下划线高亮样式
     */
    private applyUnderlineHighlight(
        rect: SVGRectElement,
        rectKey: string,
        isHighlighted: boolean,
        currentClass: string
    ): void {
        if (isHighlighted) {
            // 移除边框样式
            this.removeBorderStyle(rect);

            // 创建或更新下划线
            let underline = this.underlineCache.get(rectKey);
            if (!underline) {
                underline = this.createUnderline(rectKey);
            }

            // 更新下划线位置（rect底部）
            this.updateUnderlinePosition(rect, underline);

            // 更新class
            this.updateHighlightClass(rect, true);
        } else {
            // 移除下划线
            const underline = this.underlineCache.get(rectKey);
            if (underline) {
                underline.style.display = 'none';
            }

            // 确保没有边框
            this.removeBorderStyle(rect);

            // 移除class
            this.updateHighlightClass(rect, false);
        }
    }

    /**
     * 应用边框高亮样式
     */
    private applyBorderHighlight(
        rect: SVGRectElement,
        rectKey: string,
        isHighlighted: boolean,
        currentClass: string,
        highlightedRects: SVGRectElement[]
    ): void {
        if (isHighlighted) {
            // 先移除可能存在的下划线
            const underline = this.underlineCache.get(rectKey);
            if (underline) {
                underline.style.display = 'none';
            }

            // 添加高亮样式：统一色值的实线边框，无外发光
            rect.setAttribute('stroke', HIGHLIGHT_CONSTANTS.HIGHLIGHT_COLOR);
            rect.setAttribute('stroke-width', HIGHLIGHT_CONSTANTS.BORDER_WIDTH);
            rect.setAttribute('stroke-opacity', '1');
            rect.removeAttribute('stroke-dasharray');

            // 添加class
            this.updateHighlightClass(rect, true);

            // 收集需要移到末尾的rect
            highlightedRects.push(rect);
        } else {
            // 移除高亮样式
            this.removeBorderStyle(rect);

            // 确保移除下划线（如果存在）
            const underline = this.underlineCache.get(rectKey);
            if (underline) {
                underline.style.display = 'none';
            }

            // 移除class
            this.updateHighlightClass(rect, false);
        }
    }

    /**
     * 清除所有高亮（token 边框/下划线 + 字符区间下划线）
     */
    clearHighlight(): void {
        this.cancelCharIntervalFade();
        this.clearRectHighlightsOnly();
        this.removeIntervalSvgLines();
    }

    /** 仅清除 token 矩形上的高亮样式（保留字符区间线，供内部组合使用） */
    private clearRectHighlightsOnly(): void {
        this.rectCache.forEach(({ rect }, rectKey) => {
            this.removeBorderStyle(rect);
            this.updateHighlightClass(rect, false);
            const underline = this.underlineCache.get(rectKey);
            if (underline) {
                underline.style.display = 'none';
            }
        });
    }

    private removeIntervalSvgLines(): void {
        for (const line of this.intervalUnderlineLines) {
            line.remove();
        }
        this.intervalUnderlineLines = [];
    }

    /** 仅移除 chunk 字符区间下划线（不碰直方图 token 高亮） */
    clearCharIntervalUnderlines(): void {
        this.cancelCharIntervalFade();
        this.removeIntervalSvgLines();
    }

    cancelCharIntervalFade(): void {
        if (this.charIntervalFadeTimeout !== undefined) {
            window.clearTimeout(this.charIntervalFadeTimeout);
            this.charIntervalFadeTimeout = undefined;
        }
    }

    /** 字符区间下划线缓慢淡出后移除 */
    fadeOutCharIntervalUnderlines(durationMs: number, onComplete?: () => void): void {
        this.cancelCharIntervalFade();
        const lines = this.intervalUnderlineLines;
        if (lines.length === 0) {
            onComplete?.();
            return;
        }
        for (const line of lines) {
            line.style.transition = '';
            line.setAttribute('stroke-opacity', '1');
        }
        requestAnimationFrame(() => {
            for (const line of lines) {
                line.style.transition = `stroke-opacity ${durationMs}ms ease-out`;
                line.setAttribute('stroke-opacity', '0');
            }
            this.charIntervalFadeTimeout = window.setTimeout(() => {
                this.charIntervalFadeTimeout = undefined;
                this.removeIntervalSvgLines();
                onComplete?.();
            }, durationMs);
        });
    }

    /**
     * 按字符区间对应的 overlay 线段绘制下划线；并清除直方图 token 高亮。
     */
    setCharIntervalUnderlines(segments: CharIntervalUnderlineSeg[]): void {
        this.whenRectCacheReady('interval', 'HighlightManager: 区间下划线缓存未就绪，已达最大重试', () => {
            this.cancelCharIntervalFade();
            this.clearRectHighlightsOnly();
            this.removeIntervalSvgLines();
            this.appendIntervalUnderlineLines(segments);
        });
    }

    /** 布局变化时只刷新区间线几何 */
    updateCharIntervalUnderlines(segments: CharIntervalUnderlineSeg[]): void {
        this.removeIntervalSvgLines();
        this.appendIntervalUnderlineLines(segments);
    }

    /**
     * rect 缓存就绪后执行；未就绪则短暂重试（SVG 与缓存稍晚于组件构造）。
     */
    private whenRectCacheReady(
        slot: 'indices' | 'interval',
        warnMessage: string,
        run: () => void
    ): void {
        if (this.rectCache.size > 0) {
            this.rectCacheWait[slot] = 0;
            run();
            return;
        }
        if (this.rectCacheWait[slot] < this.MAX_RETRY_ATTEMPTS) {
            this.rectCacheWait[slot] += 1;
            setTimeout(() => this.whenRectCacheReady(slot, warnMessage, run), 50);
            return;
        }
        console.warn(warnMessage);
        this.rectCacheWait[slot] = 0;
    }

    private static underlineStrokeAttrs(line: SVGLineElement, cssClass: string): void {
        line.setAttribute('stroke', HIGHLIGHT_CONSTANTS.HIGHLIGHT_COLOR);
        line.setAttribute('stroke-width', HIGHLIGHT_CONSTANTS.UNDERLINE_WIDTH);
        line.setAttribute('stroke-opacity', '1');
        line.setAttribute('class', cssClass);
    }

    private appendIntervalUnderlineLines(segments: CharIntervalUnderlineSeg[]): void {
        const ns = 'http://www.w3.org/2000/svg';
        for (const s of segments) {
            const line = document.createElementNS(ns, 'line');
            HighlightManager.underlineStrokeAttrs(line, HIGHLIGHT_CONSTANTS.INTERVAL_UNDERLINE_CLASS);
            line.setAttribute('x1', String(s.x1));
            line.setAttribute('x2', String(s.x2));
            line.setAttribute('y1', String(s.y));
            line.setAttribute('y2', String(s.y));
            this.svgOverlay.appendChild(line);
            this.intervalUnderlineLines.push(line);
        }
    }

    /**
     * 清除之前的样式（切换样式时使用）
     */
    private clearPreviousStyle(previousStyle: HighlightStyle): void {
        if (previousStyle === 'underline') {
            // 从下划线模式切换到边框模式：清除所有下划线
            this.underlineCache.forEach((underline) => {
                underline.style.display = 'none';
            });
        } else if (previousStyle === 'border') {
            // 从边框模式切换到下划线模式：清除所有边框
            this.rectCache.forEach(({ rect }) => {
                this.removeBorderStyle(rect);
            });
        }
    }

    /**
     * 移除边框样式
     */
    private removeBorderStyle(rect: SVGRectElement): void {
        rect.removeAttribute('stroke');
        rect.removeAttribute('stroke-width');
        rect.removeAttribute('stroke-opacity');
        rect.removeAttribute('stroke-dasharray');
    }

    /**
     * 创建下划线元素
     */
    private createUnderline(rectKey: string): SVGLineElement {
        const underline = document.createElementNS('http://www.w3.org/2000/svg', 'line');
        HighlightManager.underlineStrokeAttrs(underline, HIGHLIGHT_CONSTANTS.UNDERLINE_CLASS);
        this.svgOverlay.appendChild(underline);
        this.underlineCache.set(rectKey, underline);
        return underline;
    }

    /**
     * 更新高亮class（工具方法）
     */
    private updateHighlightClass(rect: SVGRectElement, isHighlighted: boolean): void {
        const currentClass = rect.getAttribute('class') || '';
        if (isHighlighted) {
            if (!currentClass.includes(HIGHLIGHT_CONSTANTS.HIGHLIGHT_CLASS)) {
                rect.setAttribute('class', (currentClass + ' ' + HIGHLIGHT_CONSTANTS.HIGHLIGHT_CLASS).trim());
            }
        } else {
            const newClass = currentClass.replace(new RegExp(`\\b${HIGHLIGHT_CONSTANTS.HIGHLIGHT_CLASS}\\b`, 'g'), '').trim();
            rect.setAttribute('class', newClass);
        }
    }

    /**
     * 更新下划线位置
     */
    private updateUnderlinePosition(rect: SVGRectElement, underline: SVGLineElement): void {
        const x = parseFloat(rect.getAttribute('x') || '0');
        const y = parseFloat(rect.getAttribute('y') || '0');
        const width = parseFloat(rect.getAttribute('width') || '0');
        const height = parseFloat(rect.getAttribute('height') || '0');
        const bottomY = y + height;

        underline.setAttribute('x1', x.toString());
        underline.setAttribute('x2', (x + width).toString());
        underline.setAttribute('y1', bottomY.toString());
        underline.setAttribute('y2', bottomY.toString());
        underline.style.display = '';
    }

    /**
     * 更新下划线位置（当rect位置变化时调用）
     */
    updateUnderlinePositions(): void {
        this.rectCache.forEach(({ rect }, rectKey) => {
            const underline = this.underlineCache.get(rectKey);
            if (underline && underline.style.display !== 'none') {
                this.updateUnderlinePosition(rect, underline);
            }
        });
    }
}

