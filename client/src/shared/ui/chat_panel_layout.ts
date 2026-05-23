import * as d3 from 'd3';
import { isNarrowScreen } from '../core/responsive';
import { readPanelSplitRatio, writePanelSplitRatio } from '../cross/panelSplitStorage';

export type ChatPanelLayoutOptions = {
    /** 各页面独立 key，用于 localStorage 持久化分栏比例 */
    storageKey: string;
};

/**
 * Chat / 归因 / gen_attribute 等：左右分栏拖拽与窗口尺寸同步，不含侧栏逻辑。
 */
export function initChatPanelLayout(options: ChatPanelLayoutOptions): void {
    const resizer = d3.select('#resizer');
    const leftPanel = d3.select('.left_panel');
    if (resizer.empty() || leftPanel.empty()) {
        return;
    }

    const { storageKey } = options;
    let leftPanelRatio = readPanelSplitRatio(storageKey);
    let isResizing = false;
    let startX = 0;
    let startWidth = 0;

    const updateLeftPanelWidth = (containerWidth: number): void => {
        const availableWidth = containerWidth - 8;
        const leftWidth = availableWidth * leftPanelRatio;
        const minWidth = containerWidth * 0.1;
        const maxWidth = containerWidth * 0.9;
        const clampedWidth = Math.max(minWidth, Math.min(maxWidth, leftWidth));
        leftPanelRatio = clampedWidth / availableWidth;
        leftPanel.style('flex-basis', `${clampedWidth}px`);
    };

    const reLayout = (w = window.innerWidth, h = window.innerHeight): void => {
        const mainFrame = d3.selectAll('.main_frame');
        if (isNarrowScreen()) {
            mainFrame.style('height', null).style('width', null);
        } else {
            mainFrame.style('height', `${h - 53}px`).style('width', `${w}px`);
            updateLeftPanelWidth(w);
        }
    };

    reLayout();

    resizer.on('mousedown', (event: MouseEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (isNarrowScreen()) {
            return;
        }

        isResizing = true;
        startX = event.clientX;
        const cw = window.innerWidth;
        const currentFlexBasis = leftPanel.style('flex-basis');
        const parsed = parseInt(currentFlexBasis, 10);
        const availableWidth = cw - 8;
        startWidth = Number.isFinite(parsed)
            ? parsed
            : availableWidth * leftPanelRatio;

        d3.select('body').style('cursor', 'col-resize').style('user-select', 'none');

        d3.select(window)
            .on('mousemove.chatResizer', (ev: MouseEvent) => onMouseMove(ev))
            .on('mouseup.chatResizer', () => onMouseUp());
    });

    const onMouseMove = (event: MouseEvent): void => {
        if (!isResizing) {
            return;
        }
        event.preventDefault();

        const cw = window.innerWidth;
        const availableWidth = cw - 8;
        const deltaX = event.clientX - startX;
        const newWidth = Math.max(
            cw * 0.1,
            Math.min(cw * 0.9, startWidth + deltaX)
        );

        leftPanel.style('flex-basis', `${newWidth}px`);
        leftPanelRatio = newWidth / availableWidth;
    };

    const onMouseUp = (): void => {
        if (!isResizing) {
            return;
        }
        isResizing = false;

        writePanelSplitRatio(storageKey, leftPanelRatio);

        d3.select('body').style('cursor', null).style('user-select', null);

        d3.select(window)
            .on('mousemove.chatResizer', null)
            .on('mouseup.chatResizer', null);
    };

    window.addEventListener('resize', () => {
        reLayout(window.innerWidth, window.innerHeight);
    });
}
