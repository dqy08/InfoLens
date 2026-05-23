/**
 * 本地 Demo 缓存 - 浏览器内持久化存储
 * 用于在浏览器中持久化本地加载的 demo 数据，支持刷新后恢复
 */

import type { AnalysisData } from '../../shared/api/GLTR_API';
import type { IDemoStorage, SaveOptions, SaveResult, LoadResult } from './demoStorage';
import { ensureJsonExtension } from '../cross/localFileUtils';
import { extractErrorMessage } from '../core/errorUtils';
import { hashContent, CryptoSubtleUnavailableError } from '../core/hashUtils';

const DB_NAME = 'InfoRadarDB';
const DB_VERSION = 2;
const STORE_NAME = 'demos';

/**
 * 本地 Demo 缓存实现
 * 使用 IndexedDB 持久化本地 demo 数据，支持刷新后恢复
 */
export class LocalDemoCache implements IDemoStorage {
    readonly type = 'local' as const;
    private dbPromise: Promise<IDBDatabase> | null = null;

    /**
     * 检查 IndexedDB 是否可用
     */
    static isAvailable(): boolean {
        return typeof indexedDB !== 'undefined';
    }

    /**
     * 初始化或获取数据库连接
     */
    private async getDB(): Promise<IDBDatabase> {
        if (!LocalDemoCache.isAvailable()) {
            throw new Error('IndexedDB 不可用，可能是浏览器不支持或处于隐私模式');
        }

        if (this.dbPromise) {
            return this.dbPromise;
        }

        this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                reject(new Error('Failed to open IndexedDB'));
            };

            request.onsuccess = () => {
                resolve(request.result);
            };

            request.onupgradeneeded = (event) => {
                const db = (event.target as IDBOpenDBRequest).result;
                
                // 删除旧的对象存储（如果存在）
                if (db.objectStoreNames.contains(STORE_NAME)) {
                    db.deleteObjectStore(STORE_NAME);
                }
                
                // 创建新的对象存储，使用 hash 作为主键
                db.createObjectStore(STORE_NAME, { keyPath: 'key' });
            };
        });

        return this.dbPromise;
    }

    /**
     * 保存 demo 到缓存
     * @param data 要保存的数据
     * @param options 保存选项（符合 IDemoStorage 接口）
     */
    async save(data: AnalysisData, options: SaveOptions): Promise<SaveResult> {
        try {
            // 内部计算内容哈希
            const hash = await hashContent(data);
            
            const db = await this.getDB();
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            const filename = ensureJsonExtension(options.name);
            const key = `${filename}~${hash}`; // 使用 filename~hash 作为 key

            const record = {
                key,
                filename,
                data,
                timestamp: Date.now()
            };

            const request = store.put(record);

            return new Promise((resolve) => {
                request.onsuccess = () => {
                    resolve({
                        success: true,
                        message: 'Saved to local cache',
                        file: filename,
                        hash // 返回计算好的哈希值
                    });
                };

                request.onerror = () => {
                    const error = request.error;
                    if (error && error.name === 'QuotaExceededError') {
                        resolve({
                            success: false,
                            message: 'Storage quota exceeded, please clear cache and try again'
                        });
                    } else {
                        resolve({
                            success: false,
                            message: 'Failed to save to cache'
                        });
                    }
                };
            });
        } catch (error) {
            // CryptoSubtleUnavailableError 需要特殊处理，直接重新抛出让调用方处理
            if (error instanceof CryptoSubtleUnavailableError) {
                throw error;
            }
            if (error instanceof DOMException && error.name === 'QuotaExceededError') {
                return {
                    success: false,
                    message: 'Storage quota exceeded, please clear cache and try again'
                };
            }
            return {
                success: false,
                message: extractErrorMessage(error, 'Save failed')
            };
        }
    }

    /**
     * 从缓存加载 demo
     * @param key 完整的 key，格式为 "filename~hash"
     */
    async load(key?: string): Promise<LoadResult> {
        if (!key) {
            return { success: false, message: 'Key is missing' };
        }

        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);

            const request = store.get(key);

            return new Promise((resolve) => {
                request.onsuccess = () => {
                    const record = request.result;
                    
                    if (!record || !record.data) {
                        resolve({
                            success: false,
                            message: 'File not found in local cache, please open again'
                        });
                        return;
                    }

                    resolve({
                        success: true,
                        data: record.data as AnalysisData
                    });
                };

                request.onerror = () => {
                    const error = request.error;
                    console.error('从缓存读取失败:', error);
                    resolve({
                        success: false,
                        message: 'Failed to read from cache'
                    });
                };
            });
        } catch (error) {
            return {
                success: false,
                message: extractErrorMessage(error, '加载失败')
            };
        }
    }

    /**
     * 删除指定的 demo
     * @param key 完整的 key，格式为 "filename~hash"
     */
    async delete(key: string): Promise<boolean> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            const request = store.delete(key);

            return new Promise((resolve) => {
                request.onsuccess = () => resolve(true);
                request.onerror = () => {
                    console.error('删除失败:', request.error);
                    resolve(false);
                };
            });
        } catch (error) {
            console.error('删除 demo 失败:', error);
            return false;
        }
    }

    /**
     * 清空所有本地缓存
     */
    async clear(): Promise<boolean> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            const request = store.clear();

            return new Promise((resolve) => {
                request.onsuccess = () => resolve(true);
                request.onerror = () => {
                    console.error('清空失败:', request.error);
                    resolve(false);
                };
            });
        } catch (error) {
            console.error('清空缓存失败:', error);
            return false;
        }
    }

    /**
     * 列出所有已缓存的 demo
     */
    async list(): Promise<string[]> {
        try {
            const db = await this.getDB();
            const transaction = db.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);

            const request = store.getAllKeys();

            return new Promise((resolve) => {
                request.onsuccess = () => {
                    resolve(request.result as string[]);
                };
                request.onerror = () => {
                    console.error('列出缓存失败:', request.error);
                    resolve([]);
                };
            });
        } catch (error) {
            console.error('列出缓存失败:', error);
            return [];
        }
    }
}

