/**
 * Token位置计算器
 * 负责计算token在DOM中的像素位置，处理Unicode/UTF-16转换
 */

import {FrontendAnalyzeResult} from "../../shared/api/GLTR_API";
import {TokenFragmentRect} from "./types";

interface TextNodeIndexEntry {
    node: Text;
    startOffset: number;      // Unicode字符偏移起始位置
    endOffset: number;        // Unicode字符偏移结束位置
    utf16Start: number;       // UTF-16代码单元起始位置
    utf16End: number;         // UTF-16代码单元结束位置
    charToUtf16Map: number[]; // 字符偏移到UTF-16偏移的映射表
}

export class TokenPositionCalculator {
    private textNodeIndex?: TextNodeIndexEntry[];
    private baseNode: HTMLElement;

    constructor(baseNode: HTMLElement) {
        this.baseNode = baseNode;
    }

    /** 与 calculateTokenPositions 一致的累积 zoom（Range → 覆盖层坐标） */
    getZoom(): number {
        return this.getAccumulatedZoom(this.baseNode);
    }

    /**
     * 获取元素及其祖先的累积 zoom 值
     * CSS zoom 会影响 getBoundingClientRect() 但不影响 clientWidth/clientHeight
     * 
     * 注意事项：
     * - CSS zoom 不是标准属性（Chrome/Safari 支持，Firefox 126+ 支持）
     * 
     * @param element 目标元素
     * @returns 累积的 zoom 值
     */
    private getAccumulatedZoom(element: HTMLElement): number {
        let zoom = 1;
        let current: HTMLElement | null = element;
        let depth = 0;
        const MAX_DEPTH = 50; // 防止无限循环
        
        while (current && depth < MAX_DEPTH) {
            const style = window.getComputedStyle(current);
            
            // 检查浏览器是否支持 zoom 属性（兼容性处理）
            if (typeof style.zoom === 'string' && style.zoom !== '' && style.zoom !== 'normal') {
                const elementZoom = parseFloat(style.zoom);
                
                if (!isNaN(elementZoom) && elementZoom > 0) {
                    zoom *= elementZoom;
                } else if (!isNaN(elementZoom) && elementZoom <= 0) {
                    console.warn(`[TokenPositionCalculator] Invalid zoom value: ${style.zoom}`, current);
                    // 忽略无效 zoom 值，继续使用当前累积值
                }
            }
            
            current = current.parentElement;
            depth++;
        }
        
        if (depth >= MAX_DEPTH) {
            console.warn(`[TokenPositionCalculator] DOM depth exceeded ${MAX_DEPTH}, stopping zoom calculation`);
        }
        
        return zoom;
    }

    /**
     * 计算token的像素位置（一次性计算，避免重复遍历）
     * @param rd 分析结果数据
     * @param fromTokenIndex 只计算 index >= fromTokenIndex 的 token，默认 0（全量）
     * @returns token位置数组
     */
    calculateTokenPositions(rd: FrontendAnalyzeResult, fromTokenIndex = 0): TokenFragmentRect[] {
        if (!this.baseNode) return [];

        const positions: TokenFragmentRect[] = [];
        const containerRect = this.baseNode.getBoundingClientRect();
        
        // 获取累积的 zoom 值，用于将 getBoundingClientRect 坐标转换回未缩放坐标
        // 这样输出的坐标与 clientWidth/clientHeight 一致
        const zoom = this.getAccumulatedZoom(this.baseNode);

        // 过滤有效token（跳过已处理的旧 token）
        const validTokens = rd.bpe_strings.map((tokenObj, index) => ({
            tokenObj,
            index,
            offset: tokenObj.offset
        })).filter(({ index, offset }) => {
            if (index < fromTokenIndex) return false;
            const [start, end] = offset;
            return !(start === end || start < 0 || end < 0 || end <= start);
        });

        // 一次性计算所有token位置
        validTokens.forEach(({ tokenObj, index, offset }) => {
            const [start, end] = offset;
            
            // 使用findNodeAndOffset找到文本节点和偏移
            const startResult = this.findNodeAndOffset(start);
            const endResult = this.findNodeAndOffset(end);
            
            if (!startResult || !endResult) {
                console.warn(`⚠️ 无法找到token ${index} 的位置 (${start}, ${end})`);
                return;
            }

            // 创建Range对象
            const range = document.createRange();
            range.setStart(startResult.node, startResult.offset);
            range.setEnd(endResult.node, endResult.offset);

            // 获取各段像素坐标（token可能被拆到多行）
            const rectList = Array.from(range.getClientRects());
            const fragments = rectList.length > 0 ? rectList : [range.getBoundingClientRect()];

            fragments.forEach((rect, fragmentIndex) => {
                if (!rect || rect.height === 0) {
                    return;
                }
                const hScaled = rect.height / zoom;
                if (hScaled <= 0) {
                    return;
                }
                // 保留 Range 的真实宽度。iOS/WebKit 在换行后的 token 前可能返回上一行行尾的
                // 零宽 rect；如果这里提前改成占位宽，DAG 等下游就无法识别并过滤这个幽灵片。
                const wRaw = rect.width / zoom;
                // 将 getBoundingClientRect 的缩放坐标转换回未缩放坐标（与 clientWidth/clientHeight 一致）
                const tokenPos = {
                    tokenIndex: index,
                    fragmentIndex,
                    fragmentCount: fragments.length,
                    rectKey: `${index}-${fragmentIndex}`,
                    x: (rect.left - containerRect.left) / zoom,
                    y: (rect.top - containerRect.top) / zoom,
                    width: wRaw,
                    height: hScaled
                };
                positions.push(tokenPos);
            });
        });

        return positions;
    }

    /**
     * 构建文本节点索引，用于优化findNodeAndOffset的查找性能
     * 从O(n)的线性遍历优化为O(log n)的二分查找
     */
    buildTextNodeIndex(): void {
        if (!this.baseNode) {
            this.textNodeIndex = undefined;
            return;
        }

        const index: TextNodeIndexEntry[] = [];

        let currentCharOffset = 0;  // Unicode字符偏移（code points）
        let currentUtf16Offset = 0;  // UTF-16代码单元偏移

        // 遍历所有文本节点
        const walker = document.createTreeWalker(
            this.baseNode,
            NodeFilter.SHOW_TEXT,
            null
        );

        let node: Text;
        while (node = walker.nextNode() as Text) {
            const nodeText = node.textContent || '';
            // 使用Array.from()将字符串转换为字符数组（正确处理Unicode字符）
            // 注意：这里只在构建索引时执行一次，后续查找时不再执行
            const nodeChars = Array.from(nodeText);
            const nodeCharLength = nodeChars.length;  // Unicode字符数
            const nodeUtf16Length = nodeText.length;   // UTF-16代码单元长度（相对于当前节点）

            const startOffset = currentCharOffset;
            const endOffset = currentCharOffset + nodeCharLength;
            const utf16Start = currentUtf16Offset;
            const utf16End = currentUtf16Offset + nodeUtf16Length;

            // 预计算字符偏移到UTF-16偏移的映射表
            // charToUtf16Map[i] 表示第i个字符（Unicode字符）在「当前文本节点内部」对应的UTF-16偏移
            const charToUtf16Map: number[] = new Array(nodeCharLength + 1); // +1 用于包含末尾位置
            let utf16Pos = 0;
            
            // 对于每个字符位置，计算其对应的UTF-16偏移
            for (let i = 0; i <= nodeCharLength; i++) {
                charToUtf16Map[i] = utf16Pos;
                if (i < nodeCharLength) {
                    // 当前字符的UTF-16长度
                    const char = nodeChars[i];
                    utf16Pos += char.length; // 字符的UTF-16长度（对于emoji可能是2）
                }
            }

            index.push({
                node,
                startOffset,
                endOffset,
                utf16Start,
                utf16End,
                charToUtf16Map
            });

            currentCharOffset += nodeCharLength;
            currentUtf16Offset += nodeUtf16Length;
        }

        this.textNodeIndex = index;
    }

    /**
     * 根据全局字符偏移找到对应的文本节点和局部偏移
     * 使用二分查找优化性能：从O(n)优化为O(log n)
     * 正确处理Unicode字符（包括emoji）：将Unicode字符偏移转换为UTF-16代码单元偏移
     * 
     * @param globalOffset Unicode字符偏移（code points），来自Python的offset_mapping
     * @returns 文本节点和UTF-16代码单元偏移（Range API需要）
     */
    findNodeAndOffset(globalOffset: number): { node: Text, offset: number } | null {
        // 如果索引不存在或为空，回退到构建索引
        if (!this.textNodeIndex || this.textNodeIndex.length === 0) {
            this.buildTextNodeIndex();
            if (!this.textNodeIndex || this.textNodeIndex.length === 0) {
                return null;
            }
        }

        const index = this.textNodeIndex;

        // 二分查找：找到包含globalOffset的节点
        let left = 0;
        let right = index.length - 1;
        let foundIndex = -1;

        while (left <= right) {
            const mid = Math.floor((left + right) / 2);
            const entry = index[mid];

            if (globalOffset >= entry.startOffset && globalOffset < entry.endOffset) {
                foundIndex = mid;
                break;
            } else if (globalOffset < entry.startOffset) {
                right = mid - 1;
            } else {
                left = mid + 1;
            }
        }

        // 处理边界情况：globalOffset正好等于最后一个节点的结束位置
        if (foundIndex === -1 && index.length > 0) {
            const lastEntry = index[index.length - 1];
            if (globalOffset === lastEntry.endOffset) {
                foundIndex = index.length - 1;
                // 使用预计算的映射表获取末尾位置的UTF-16偏移
                const lastLocalCharOffset = lastEntry.endOffset - lastEntry.startOffset;
                const utf16Offset = lastEntry.charToUtf16Map[lastLocalCharOffset];
                return { node: lastEntry.node, offset: utf16Offset };
            }
            return null;
        }

        if (foundIndex === -1) {
            return null;
        }

        const entry = index[foundIndex];
        const localCharOffset = globalOffset - entry.startOffset;

        // 使用预计算的映射表直接查表，避免重复的Array.from、slice、join操作
        // 这是性能优化的关键：从O(n)的字符串操作优化为O(1)的数组查表
        const utf16Offset = entry.charToUtf16Map[localCharOffset];

        // 注意：Range.setStart/End 需要的是「相对于当前文本节点」的UTF-16偏移
        // charToUtf16Map 已经存的是局部偏移，无需再加上 utf16Start
        return { node: entry.node, offset: utf16Offset };
    }

    /**
     * 重置索引（当文本内容变化时调用）
     */
    resetIndex(): void {
        this.textNodeIndex = undefined;
    }
}

