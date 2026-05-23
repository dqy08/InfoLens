/**
 * 路径规范化工具函数
 */

/**
 * 规范化完整路径（用于demo管理器的路径导航）
 * - 确保以 / 开头
 * - 去除多余的连续斜杠
 * - 去除尾部斜杠（除非是根路径 /）
 * 
 * @param path 原始路径
 * @returns 规范化后的路径，如果输入无效则返回 null
 * 
 * @example
 * normalizeFullPath('/folder1//folder2/') => '/folder1/folder2'
 * normalizeFullPath('folder1/folder2') => '/folder1/folder2'
 * normalizeFullPath('/') => '/'
 */
export const normalizeFullPath = (path?: string | null): string | null => {
    if (!path) {
        return null;
    }
    const trimmed = path.trim();
    if (!trimmed) {
        return null;
    }
    const withLeadingSlash = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
    const normalized = withLeadingSlash.replace(/\/{2,}/g, '/');
    return normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
};

/**
 * 规范化demo文件路径（用于文件系统访问）
 * - 去除前导 /
 * - 确保以 .json 结尾
 * 
 * @param path 原始路径
 * @returns 规范化后的相对路径
 * 
 * @example
 * normalizeDemoPath('/demo1.json') => 'demo1.json'
 * normalizeDemoPath('/folder/demo1') => 'folder/demo1.json'
 * normalizeDemoPath('demo1') => 'demo1.json'
 */
export const normalizeDemoPath = (path: string): string => {
    let normalized = path.trim();
    // 去除前导 /
    if (normalized.startsWith('/')) {
        normalized = normalized.substring(1);
    }
    // 确保以 .json 结尾
    if (!normalized.endsWith('.json')) {
        normalized += '.json';
    }
    return normalized;
};

/**
 * 从路径提取demo名称（文件名，不含扩展名和路径）
 * 
 * @param path demo路径
 * @returns demo名称
 * 
 * @example
 * getDemoName('/folder/demo1.json') => 'demo1'
 * getDemoName('demo1.json') => 'demo1'
 */
export const getDemoName = (path: string): string => {
    const normalized = normalizeDemoPath(path);
    // 去除 .json 后缀，提取文件名
    const fileName = normalized.replace(/\.json$/, '');
    // 如果包含路径分隔符，取最后一部分
    const parts = fileName.split('/');
    return parts[parts.length - 1];
};

