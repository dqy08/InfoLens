/**
 * GLTR可视化组件的共享类型定义
 */

/**
 * 零宽 Range fragment 在需要画出来时使用的最小可视宽度。
 * TokenFragmentRect.width 保留 Range 原始宽度；占位宽只应在具体可视化/几何语义处应用。
 */
export const ZERO_WIDTH_FRAGMENT_PLACEHOLDER_PX = 10;

/**
 * Token Fragment 的矩形几何信息
 * 一个 token 可能被拆分成多个 fragment（跨行显示），每个 fragment 有独立的矩形
 */
export interface TokenFragmentRect {
    tokenIndex: number;
    fragmentIndex: number;
    fragmentCount: number; // 该token总共有多少个fragment
    rectKey: string;
    x: number;
    y: number;
    /** Range 原始宽度（已除 zoom）；移动端/WebKit 的换行幽灵片会保留为 0。 */
    width: number;
    height: number;
}

/**
 * Rect缓存条目
 */
export interface RectCacheEntry {
    rect: SVGRectElement;
    tokenIndex: number;
}

/**
 * 高亮样式类型
 */
export type HighlightStyle = 'border' | 'underline';

