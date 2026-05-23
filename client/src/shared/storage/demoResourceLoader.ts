/**
 * Demo 资源加载器 - 统一资源路由
 * 
 * 支持两种资源协议：
 * 1. `/path/to/demo.json` - 服务器资源
 * 2. `local://filename.json` - 本地缓存资源（浏览器缓存）
 */

import type { AnalysisData } from '../../shared/api/GLTR_API';
import type { IDemoStorage, LoadResult } from './demoStorage';
import { ServerStorage } from './demoStorage';
import { LocalDemoCache } from './localDemoCache';
import type { TextAnalysisAPI } from '../../shared/api/GLTR_API';
import { ensureJsonExtension, validateDemoFormat } from '../cross/localFileUtils';
import { extractErrorMessage } from '../core/errorUtils';
import { isValidHash } from '../core/hashUtils';
import { trf } from '../../shared/lang/i18n-lite';

export type ResourceIdentifier = string; // "/path/file.json" 或 "local://file.json"

/**
 * 解析资源标识符
 * 本地资源格式: local://filename.json~hash
 * 使用最后一个 ~ 作为分隔符，解决文件名中包含 ~ 的冲突
 */
function parseResourceIdentifier(identifier: ResourceIdentifier): {
    type: 'server' | 'local';
    path: string;
    hash?: string;
    filename?: string;
} {
    if (identifier.startsWith('local://')) {
        const rest = identifier.substring('local://'.length);
        // 使用最后一个 ~ 作为分隔符，解决文件名中包含 ~ 的冲突
        const hashIndex = rest.lastIndexOf('~');
        
        if (hashIndex >= 0) {
            const filename = rest.substring(0, hashIndex);
            const hash = rest.substring(hashIndex + 1);
            
            // 验证 hash 格式（4位十六进制）
            if (!isValidHash(hash)) {
                throw new Error(trf('Invalid hash format: "{hash}", expected 4 hexadecimal characters', { hash }));
            }
            
            return {
                type: 'local',
                path: hash, // 本地资源使用 hash 作为 path
                hash,
                filename
            };
        }
        
        // 没有 hash，视为无效（不再兼容）
        throw new Error(trf('Local resource identifier missing hash: "{identifier}", format should be local://filename.json~hash', { identifier }));
    }
    
    return {
        type: 'server',
        path: identifier
    };
}

/**
 * 统一资源加载器
 * 根据资源标识符路由到相应的存储层
 */
export class DemoResourceLoader {
    private serverStorage: ServerStorage;
    private localDemoCache: LocalDemoCache;

    constructor(api: TextAnalysisAPI) {
        this.serverStorage = new ServerStorage(api);
        this.localDemoCache = new LocalDemoCache();
    }

    /**
     * 加载资源（统一入口，包含验证）
     * @param identifier 资源标识符（"/path/file.json" 或 "local://file.json~hash"）
     */
    async load(identifier: ResourceIdentifier): Promise<LoadResult> {
        const { type, path, hash, filename } = parseResourceIdentifier(identifier);

        const storage: IDemoStorage = type === 'local' 
            ? this.localDemoCache 
            : this.serverStorage;

        // 对于本地资源，构造完整的 key: filename~hash
        // 如果解析失败（缺少 hash 或格式无效），parseResourceIdentifier 会抛出错误
        const loadKey = type === 'local' && filename && hash 
            ? `${filename}~${hash}` 
            : path;

        // 调用底层存储加载数据
        const result = await storage.load(loadKey);

        // 统一验证数据格式（在此层进行，避免各存储层重复验证）
        if (result.success && result.data) {
            try {
                validateDemoFormat(result.data);
            } catch (error) {
                const errorMessage = extractErrorMessage(error, '数据格式无效');
                console.error(`资源验证失败 [${identifier}]:`, error);
                return {
                    success: false,
                    message: `数据格式无效: ${errorMessage}`
                };
            }
        }

        return result;
    }

    /**
     * 获取本地 Demo 缓存实例（用于保存和管理本地缓存）
     */
    getLocalDemoCache(): LocalDemoCache {
        return this.localDemoCache;
    }

    /**
     * 获取服务器存储实例（用于保存到服务器）
     */
    getServerStorage(): ServerStorage {
        return this.serverStorage;
    }

    /**
     * 检查标识符是否为本地资源
     */
    static isLocalResource(identifier: ResourceIdentifier): boolean {
        return identifier.startsWith('local://');
    }

    /**
     * 创建本地资源标识符
     * @param filename 文件名
     * @param hash 4位哈希值
     */
    static createLocalIdentifier(filename: string, hash: string): ResourceIdentifier {
        const name = ensureJsonExtension(filename);
        return `local://${name}~${hash}`;
    }

    /**
     * 从本地资源标识符中提取文件名和哈希
     * @throws 如果标识符格式无效或缺少哈希值
     */
    static extractLocalInfo(identifier: ResourceIdentifier): { filename: string; hash: string } {
        const parsed = parseResourceIdentifier(identifier);
        if (parsed.type === 'local' && parsed.hash && parsed.filename) {
            return {
                filename: parsed.filename,
                hash: parsed.hash
            };
        }
        throw new Error(trf('Unable to extract local resource info: "{identifier}"', { identifier }));
    }
}

