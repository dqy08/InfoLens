import * as d3 from 'd3';
import { isNarrowScreen } from '../core/responsive';
import { readPanelSplitRatio, writePanelSplitRatio } from '../cross/panelSplitStorage';

export type LayoutState = {
    sidebar: {
        width: number;
        visible: boolean;
    };
};

export type LayoutControllerOptions = {
    sidebarState: LayoutState['sidebar'];
    sideBar: d3.Selection<any, unknown, any, any>;
    sidebarBtn: d3.Selection<any, unknown, any, any>;
    onSidebarToggle?: (visible: boolean) => void;
    onLayoutChange?: () => void;
    /** 若设置，则从 localStorage 恢复分栏比例，并在用户拖动分割条结束后写回 */
    panelSplitStorageKey?: string;
};

export class LayoutController {
    private options: LayoutControllerOptions;
    private isResizing = false;
    private startX = 0;
    private startWidth = 0;
    private leftPanelRatio = 0.5;

    constructor(options: LayoutControllerOptions) {
        this.options = options;
        const sk = options.panelSplitStorageKey;
        if (sk) {
            this.leftPanelRatio = readPanelSplitRatio(sk);
        }
        this.initialize();
    }

    private initialize(): void {
        this.setupSidebar();
        this.setupWindowResize();
        this.setupPanelResizer();
        this.reLayout(window.innerWidth, window.innerHeight);
    }

    private setupSidebar(): void {
        this.options.sidebarBtn.on('click', () => {
            const sb = this.options.sidebarState;
            sb.visible = !sb.visible;
            
            this.options.sidebarBtn.classed('on', sb.visible);
            this.options.sideBar.classed('hidden', !sb.visible);
            this.options.sideBar.style('right',
                sb.visible ? null : `-${this.options.sidebarState.width}px`);

            if (this.options.onSidebarToggle) {
                this.options.onSidebarToggle(sb.visible);
            }
            
            this.reLayout();
        });
    }

    private setupWindowResize(): void {
        window.onresize = () => {
            const w = window.innerWidth;
            const h = window.innerHeight;
            this.reLayout(w, h);
            if (this.options.onLayoutChange) {
                this.options.onLayoutChange();
            }
        };
    }

    public reLayout(w = window.innerWidth, h = window.innerHeight): void {
        d3.selectAll('.sidenav')
            .style('height', (h - 53) + 'px');

        const sb = this.options.sidebarState;
        const mainWidth = w - (sb.visible ? sb.width : 0);
        
        // 检测是否是移动端/窄屏模式
        const isMobile = isNarrowScreen();
        const mainFrame = d3.selectAll('.main_frame');
        
        if (isMobile) {
            // 移动端：不设置固定高度，让CSS的height: auto生效，允许body滚动
            mainFrame
                .style('height', null)  // 移除内联样式，让CSS生效
                .style('width', null);  // 移除内联宽度样式，让CSS生效
        } else {
            // 桌面端：设置固定高度
            mainFrame
                .style('height', (h - 53) + 'px')
                .style('width', mainWidth + 'px');
            
            // 根据保存的比例重新计算左侧面板宽度
            this.updateLeftPanelWidth(mainWidth);
        }
    }
    
    /**
     * 根据当前窗口宽度和保存的比例更新左侧面板宽度
     */
    private updateLeftPanelWidth(containerWidth: number): void {
        const leftPanel = d3.select('.left_panel');
        if (leftPanel.empty()) return;
        
        // 计算可用宽度（减去分割线宽度8px）
        const availableWidth = containerWidth - 8;
        
        // 根据比例计算左侧面板宽度
        const leftWidth = availableWidth * this.leftPanelRatio;
        
        // 确保宽度在最小和最大限制内
        const minWidth = containerWidth * 0.1;
        const maxWidth = containerWidth * 0.9;
        const clampedWidth = Math.max(minWidth, Math.min(maxWidth, leftWidth));
        
        // 更新比例（如果被限制，则更新比例以保持一致性）
        this.leftPanelRatio = clampedWidth / availableWidth;
        
        leftPanel.style('flex-basis', clampedWidth + 'px');
    }

    private setupPanelResizer(): void {
        const resizer = d3.select('#resizer');
        const leftPanel = d3.select('.left_panel');
        
        // 初始化左侧面板宽度（使用默认比例50%）
        const sb = this.options.sidebarState;
        const mainWidth = window.innerWidth - (sb.visible ? sb.width : 0);
        this.updateLeftPanelWidth(mainWidth);

        resizer.on('mousedown', (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            
            this.isResizing = true;
            this.startX = event.clientX;
            
            // 获取当前左侧面板的实际宽度
            const currentFlexBasis = leftPanel.style('flex-basis');
            this.startWidth = parseInt(currentFlexBasis) || (mainWidth * this.leftPanelRatio);
            
            d3.select('body')
                .style('cursor', 'col-resize')
                .style('user-select', 'none');
            
            d3.select(window)
                .on('mousemove.resizer', (ev: MouseEvent) => this.handleMouseMove(ev, leftPanel))
                .on('mouseup.resizer', () => this.handleMouseUp());
        });
    }

    private handleMouseMove(event: MouseEvent, leftPanel: d3.Selection<any, unknown, any, any>): void {
        if (!this.isResizing) return;
        
        event.preventDefault();
        
        const sb = this.options.sidebarState;
        const containerWidth = window.innerWidth - (sb.visible ? sb.width : 0);
        const availableWidth = containerWidth - 8; // 减去分割线宽度
        
        const deltaX = event.clientX - this.startX;
        const newWidth = Math.max(
            containerWidth * 0.1,
            Math.min(containerWidth * 0.9, this.startWidth + deltaX)
        );
        
        // 更新左侧面板宽度
        leftPanel.style('flex-basis', newWidth + 'px');
        
        // 更新保存的比例
        this.leftPanelRatio = newWidth / availableWidth;
    }

    private handleMouseUp(): void {
        if (!this.isResizing) return;

        this.isResizing = false;

        const sk = this.options.panelSplitStorageKey;
        if (sk) {
            writePanelSplitRatio(sk, this.leftPanelRatio);
        }

        d3.select('body')
            .style('cursor', 'default')
            .style('user-select', 'auto');
        
        d3.select(window)
            .on('mousemove.resizer', null)
            .on('mouseup.resizer', null);
    }
}

