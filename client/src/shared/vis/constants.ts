/**
 * GLTR可视化组件的常量定义
 */

/**
 * 高亮相关的CSS类名和样式常量
 */
export const HIGHLIGHT_CONSTANTS = {
    /** 高亮CSS类名 */
    HIGHLIGHT_CLASS: 'bin-highlighted',
    /** 下划线CSS类名 */
    UNDERLINE_CLASS: 'bin-highlight-underline',
    /** chunk 字符半开区间下划线（由 DOM Range 推算，不依赖 token rect） */
    INTERVAL_UNDERLINE_CLASS: 'chunk-interval-underline',
    /** 高亮边框颜色（CSS变量） */
    HIGHLIGHT_COLOR: 'var(--accent-color, #1e6fff)',
    /** 边框宽度 */
    BORDER_WIDTH: '1.5',
    /** 下划线宽度 */
    UNDERLINE_WIDTH: '2',
    /** chunk 进度图跳转：滚动结束后保持高亮时长 */
    CHUNK_HIGHLIGHT_HOLD_MS: 1000,
    /** chunk 进度图跳转：保持结束后的淡出时长 */
    CHUNK_HIGHLIGHT_FADE_MS: 1400,
} as const;

/** 分块语义搜索：每块上色后、滚到下一块前的停留时长 */
export const CHUNK_SEARCH_HOLD_MS = 400;

/** 分块语义搜索跟随：chunk 起点在视口中的纵向位置（0=顶，1=底） */
export const CHUNK_SEARCH_FOLLOW_VIEWPORT_Y_RATIO = 0.6;

