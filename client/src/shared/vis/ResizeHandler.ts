/**
 * Resize处理器
 * 负责监听容器大小变化并智能更新SVG位置
 */

// todo: 接口设计评审改进
export interface ResizeHandlerOptions {
    /** 快速变化阈值（毫秒） */
    rapidResizeThresholdMs?: number;
    /** 快速变化计数阈值 */
    rapidResizeCountThreshold?: number;
    /** 防抖时间（毫秒） */
    resizeDebounceMs?: number;
    /** 位置更新回调 */
    onPositionUpdate: () => void;
    /** 获取当前SVG元素 */
    getCurrentSvg: () => SVGSVGElement | undefined;
    /** 过渡开始回调（快速resize时调用） */
    onTransitionStart?: () => void;
}

export class ResizeHandler {
    private resizeObserver?: ResizeObserver;
    private baseNode: HTMLElement;
    private options: Required<Omit<ResizeHandlerOptions, 'onPositionUpdate' | 'getCurrentSvg'>> & Pick<ResizeHandlerOptions, 'onPositionUpdate' | 'getCurrentSvg'>;
    
    // 智能检测相关状态
    private lastResizeTime = 0;
    private resizeEventCount = 0;
    private resizeEndTimer?: number;
    private positionUpdateTimer?: number;

    constructor(baseNode: HTMLElement, options: ResizeHandlerOptions) {
        this.baseNode = baseNode;
        this.options = {
            rapidResizeThresholdMs: options.rapidResizeThresholdMs ?? 100,
            rapidResizeCountThreshold: options.rapidResizeCountThreshold ?? 3,
            resizeDebounceMs: options.resizeDebounceMs ?? 100,
            onPositionUpdate: options.onPositionUpdate,
            getCurrentSvg: options.getCurrentSvg,
            onTransitionStart: options.onTransitionStart,
        };
    }

    /**
     * 设置ResizeObserver，监听容器大小变化并更新SVG rect位置
     */
    setup(): void {
        // 如果已经设置了，就不重复设置
        if (this.resizeObserver) {
            return;
        }
        
        // 创建ResizeObserver，使用智能检测
        this.resizeObserver = new ResizeObserver((entries) => {
            const now = Date.now();
            const timeSinceLastResize = now - this.lastResizeTime;
            
            // 检测是否是快速连续变化（过渡中）
            const isRapidChange = timeSinceLastResize < this.options.rapidResizeThresholdMs;
            
            if (isRapidChange) {
                // 快速连续变化，增加计数
                this.resizeEventCount++;
            } else {
                // 不是快速连续变化，重置计数
                this.resizeEventCount = 1;
            }
            
            this.lastResizeTime = now;
            
            // 判断是否是"过渡中"（快速连续变化）
            const isInTransition = this.resizeEventCount >= this.options.rapidResizeCountThreshold;
            
            if (isInTransition) {
                this.handleRapidResize();
            } else {
                this.handleSingleResize();
            }
        });
        
        // 开始观察容器
        this.resizeObserver.observe(this.baseNode);
    }

    /**
     * 处理快速连续变化（过渡中）
     */
    private handleRapidResize(): void {
        const svg = this.options.getCurrentSvg();

        // 过渡中：隐藏SVG，等待稳定后更新
        if (svg && svg.style.opacity !== '0') {
            svg.style.opacity = '0';
            svg.style.pointerEvents = 'none';
        }

        // 调用过渡开始回调（隐藏minimap等）
        if (this.options.onTransitionStart) {
            this.options.onTransitionStart();
        }

        // 取消待处理的位置更新
        if (this.positionUpdateTimer !== undefined) {
            cancelAnimationFrame(this.positionUpdateTimer);
            this.positionUpdateTimer = undefined;
        }
        
        // 取消之前的结束检测
        if (this.resizeEndTimer !== undefined) {
            clearTimeout(this.resizeEndTimer);
        }
        
        // 设置结束检测：RESIZE_DEBOUNCE_MS 没有新事件则认为结束
        this.resizeEndTimer = window.setTimeout(() => {
            this.resizeEventCount = 0; // 重置计数
            
            // 立即更新位置
            this.options.onPositionUpdate();
            
            // 显示SVG
            const svg = this.options.getCurrentSvg();
            if (svg) {
                svg.style.opacity = '1';
                svg.style.pointerEvents = '';
            }
            
            this.resizeEndTimer = undefined;
        }, this.options.resizeDebounceMs);
    }

    /**
     * 处理单次变化（如字体改变）
     */
    private handleSingleResize(): void {
        // 单次变化：直接更新，不隐藏
        // 取消之前的结束检测（如果有）
        if (this.resizeEndTimer !== undefined) {
            clearTimeout(this.resizeEndTimer);
            this.resizeEndTimer = undefined;
        }
        
        // 取消待处理的位置更新
        if (this.positionUpdateTimer !== undefined) {
            cancelAnimationFrame(this.positionUpdateTimer);
        }
        
        // 立即更新位置（使用 requestAnimationFrame 确保不阻塞）
        this.positionUpdateTimer = requestAnimationFrame(() => {
            this.options.onPositionUpdate();
            this.positionUpdateTimer = undefined;
        });
    }

    /**
     * 清理资源：停止ResizeObserver并清理定时器
     */
    destroy(): void {
        // 清理ResizeObserver
        if (this.resizeObserver) {
            this.resizeObserver.disconnect();
            this.resizeObserver = undefined;
        }
        
        // 取消待处理的位置更新
        if (this.positionUpdateTimer !== undefined) {
            cancelAnimationFrame(this.positionUpdateTimer);
            this.positionUpdateTimer = undefined;
        }
        
        // 取消resize结束检测定时器
        if (this.resizeEndTimer !== undefined) {
            clearTimeout(this.resizeEndTimer);
            this.resizeEndTimer = undefined;
        }
    }
}

