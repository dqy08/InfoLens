/**
 * 渲染动画器 - 独立的动态渲染模块
 * 提供分批渲染和顺序动画效果（颜色瞬间变化，但按顺序从上到下显示），不影响主干代码
 */

export interface TokenRenderTask {
    tokenObj: any;
    index: number;
    offset: [number, number];
}

export interface RenderCallback {
    (task: TokenRenderTask, containerText: string, rd: any): void;
}

export interface RenderAnimatorOptions {
    /** 是否启用动画渲染 */
    enabled?: boolean;
    /** 每批处理的token数量（根据总数动态调整） */
    batchSize?: number | ((totalTokens: number) => number);
    /** 每批之间的延迟（毫秒）- 控制渲染速度，值越大越慢 */
    delayBetweenBatches?: number;
}

/**
 * 渲染动画器类
 * 提供分批渲染和顺序动画功能（颜色瞬间变化，按顺序从上到下显示）
 */
export class RenderAnimator {
    private options: Required<RenderAnimatorOptions>;

    constructor(options: RenderAnimatorOptions = {}) {
        this.options = {
            enabled: options.enabled ?? true,
            batchSize: options.batchSize ?? 32,  // 初始批次大小，后续会每次加倍
            delayBetweenBatches: options.delayBetweenBatches ?? 8,
        };
    }

    /**
     * 执行动画渲染
     * @param tasks token渲染任务数组（应该按从后往前的顺序）
     * @param containerText 容器文本
     * @param rd 分析结果数据
     * @param renderCallback 渲染回调函数
     * @param baseNode 容器DOM节点（用于查找token元素）
     * @returns Promise，渲染完成后resolve
     */
    public async renderWithAnimation(
        tasks: TokenRenderTask[],
        containerText: string,
        rd: any,
        renderCallback: RenderCallback,
        baseNode?: Node
    ): Promise<void> {
        if (!this.options.enabled || tasks.length === 0) {
            // 如果禁用动画或没有任务，直接同步渲染
            tasks.forEach(task => {
                renderCallback(task, containerText, rd);
            });
            return;
        }

        const totalTokens = tasks.length;
        // 获取初始批次大小
        const initialBatchSize = typeof this.options.batchSize === 'function' 
            ? this.options.batchSize(totalTokens)
            : this.options.batchSize;

        // 第一步：先按从后往前的顺序同步渲染所有token（避免Range跨越问题）
        // 但保持它们为透明状态（不添加动画类）
        for (let i = tasks.length - 1; i >= 0; i--) {
            renderCallback(tasks[i], containerText, rd);
        }

        // 第二步：按从前往后的顺序（从上到下）分批添加动画效果
        // 批次大小每次加倍，形成越来越快的视觉效果
        let currentIndex = 0;
        let currentBatchSize = initialBatchSize;
        
        // 第一批处理之前也添加延迟
        await new Promise(resolve => setTimeout(resolve, this.options.delayBetweenBatches));
        
        while (currentIndex < tasks.length) {
            const batch: TokenRenderTask[] = [];
            // 收集当前批次的token（从前往后）
            const actualBatchSize = Math.min(currentBatchSize, tasks.length - currentIndex);
            for (let j = 0; j < actualBatchSize; j++) {
                batch.push(tasks[currentIndex + j]);
            }

            // 为当前批次的token瞬间设置颜色（按顺序从上到下）
            this.animateBatch(batch.map(t => t.index), baseNode);

            // 更新索引
            currentIndex += actualBatchSize;
            
            // 如果不是最后一批，等待一段时间再处理下一批，并将批次大小乘以1.5（取整）
            if (currentIndex < tasks.length) {
                await new Promise(resolve => setTimeout(resolve, this.options.delayBetweenBatches));
                currentBatchSize = Math.floor(currentBatchSize * 1.5); // 批次大小乘以1.5并取整，形成加速效果
            }
        }
    }

    /**
     * 为一批token瞬间设置颜色（无过渡动画，只有顺序效果）
     * @param tokenIndices token索引数组
     * @param baseNode 容器DOM节点
     */
    private animateBatch(tokenIndices: number[], baseNode?: Node): void {
        if (!baseNode) return;
        
        // 使用requestAnimationFrame确保DOM已更新
        requestAnimationFrame(() => {
            tokenIndices.forEach(tokenIndex => {
                const tokenElement = (baseNode as Element).querySelector(`[data-token-index="${tokenIndex}"]`) as HTMLElement;
                if (tokenElement) {
                    // 从data属性读取目标颜色
                    const targetColor = tokenElement.getAttribute('data-target-color');
                    if (targetColor) {
                        // 确保没有过渡动画，颜色瞬间变化
                        tokenElement.style.transition = 'none';
                        // 瞬间设置目标背景色
                        tokenElement.style.backgroundColor = targetColor;
                    }
                }
            });
        });
    }

    /**
     * 设置是否启用动画
     */
    public setEnabled(enabled: boolean): void {
        this.options.enabled = enabled;
    }

    /**
     * 获取是否启用动画
     */
    public isEnabled(): boolean {
        return this.options.enabled;
    }
}

