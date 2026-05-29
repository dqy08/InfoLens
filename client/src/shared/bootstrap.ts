/**
 * 应用公共初始化逻辑
 * 提供 start.ts 和 compare.ts 共享的基础初始化功能
 */

import * as d3 from 'd3';
import { SimpleEventHandler } from './core/SimpleEventHandler';
import { TextAnalysisAPI } from './api/GLTR_API';
import { initForceNarrowFromStorage } from './core/responsive';
import { getTokenSurprisalColor, getByteSurprisalColor, HISTOGRAM_MIN_ALPHA } from './cross/SurprisalColorConfig';
import { initClientActivityPing } from './core/clientActivityPing';
import { initOnlineCountDisplay } from './cross/onlineCountDisplay';

/**
 * 公共初始化返回对象
 */
export interface CommonAppContext {
    eventHandler: SimpleEventHandler;
    api: TextAnalysisAPI;
    tokenSurprisalColorScale: (value: number) => string;
    byteSurprisalColorScale: (value: number) => string;
    totalSurprisalFormat: (n: number | null) => string;
}

/**
 * 初始化公共应用组件
 * @param apiPrefix API 前缀（默认为空字符串）
 * @param element 事件处理器绑定的元素（默认为 document.body）
 * @returns 初始化后的公共对象
 */
export function initializeCommonApp(apiPrefix: string = '', element?: Element): CommonAppContext {
    initForceNarrowFromStorage();
    initOnlineCountDisplay();
    initClientActivityPing(apiPrefix);

    const api = new TextAnalysisAPI(apiPrefix);

    // 使用传入的元素或默认 body 元素
    const targetElement = element || document.body;
    
    const format = d3.format('.2f');
    return {
        eventHandler: new SimpleEventHandler(targetElement),
        api,
        tokenSurprisalColorScale: (v) => getTokenSurprisalColor(v, HISTOGRAM_MIN_ALPHA),
        byteSurprisalColorScale: (v) => getByteSurprisalColor(v, 1, HISTOGRAM_MIN_ALPHA),
        totalSurprisalFormat: (n: number | null) => n !== null && Number.isFinite(n) ? format(n) : String(n)
    };
}

