/**
 * Demo存储层 - 统一的存储接口和实现
 * 支持本地文件和服务器两种存储方式
 */

import * as d3 from 'd3';
import type { TextAnalysisAPI, AnalysisData } from '../../shared/api/GLTR_API';
import { createRawSnapshot } from '../cross/tokenUtils';
import { extractErrorMessage } from '../core/errorUtils';
import { DEMO_FILE_ENDPOINT } from '../api/apiConfig';

// ============ 接口定义 ============

export interface SaveOptions {
    name: string;
    path?: string;      // 服务器路径，本地不需要
    overwrite?: boolean; // 服务器覆盖标志，本地不需要
}

export interface SaveResult {
    success: boolean;
    message?: string;
    exists?: boolean;   // 文件已存在（仅服务器）
    file?: string;
    hash?: string;      // 内容哈希值（仅本地缓存）
}

export interface LoadResult {
    success: boolean;
    data?: AnalysisData;
    message?: string;
}

/**
 * Demo存储接口
 */
export interface IDemoStorage {
    save(data: AnalysisData, options: SaveOptions): Promise<SaveResult>;
    load(path?: string): Promise<LoadResult>;
    readonly type: 'local' | 'server';
}

// ============ 本地存储实现 ============
// 注：本地文件 I/O 功能已移至 localFileIO.ts 中的 LocalFileIO 类

// ============ 服务器存储实现 ============

/**
 * 服务器存储
 */
export class ServerStorage implements IDemoStorage {
    readonly type = 'server' as const;
    
    constructor(private api: TextAnalysisAPI) {}
    
    async save(data: AnalysisData, options: SaveOptions): Promise<SaveResult> {
        try {
            const payload = createRawSnapshot(data);
            const result = await this.api.save_demo(
                options.name.trim(),
                payload,
                options.path || '/',
                options.overwrite || false
            );
            
            return {
                success: result.success,
                message: result.message,
                exists: result.exists,
                file: result.file
            };
        } catch (error) {
            return {
                success: false,
                message: extractErrorMessage(error, '保存失败')
            };
        }
    }
    
    async load(path: string): Promise<LoadResult> {
        if (!path) {
            return { success: false, message: 'Demo path is missing' };
        }
        
        try {
            // 使用配置的端点前缀，前端只需关心demo的逻辑路径
            const data = await d3.json(`${DEMO_FILE_ENDPOINT}${path}`);
            
            // 直接返回数据，验证由上层（DemoResourceLoader）统一处理
            return { success: true, data: data as AnalysisData };
        } catch (error) {
            return {
                success: false,
                message: extractErrorMessage(error, '加载失败')
            };
        }
    }
}

