/**
 * API配置 - 统一管理API端点路径
 */

import { apiUrl, resolveApiBase } from './resolveApiBase';

/**
 * Demo文件访问路径前缀（相对 API 根；后端路由 `/demo/<path>`）
 */
export const DEMO_FILE_PATH_PREFIX = '/demo';

/** @deprecated 使用 resolveDemoFileUrl；保留仅供路径拼接语义 */
export const DEMO_FILE_ENDPOINT = DEMO_FILE_PATH_PREFIX;

/**
 * Demo JSON 完整 URL：GitHub Pages 等静态部署时走 meta API 根 + /demo。
 */
export function resolveDemoFileUrlFromBase(apiBase: string, path: string): string {
    const normalized = path.startsWith('/') ? path : `/${path}`;
    return apiUrl(`${DEMO_FILE_PATH_PREFIX}${normalized}`, apiBase);
}

export function resolveDemoFileUrl(path: string): string {
    return resolveDemoFileUrlFromBase(resolveApiBase(), path);
}

/**
 * Demo操作API基础路径
 * 用于list_demos, save_demo等操作
 */
export const DEMO_API_BASE = '/api';
