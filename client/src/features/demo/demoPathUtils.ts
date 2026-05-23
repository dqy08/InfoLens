/**
 * Demo路径和文件名工具函数
 * 统一管理所有与demo路径、文件名相关的工具函数
 */

import type { AnalyzeResponse } from '../../shared/api/GLTR_API';
import { tr } from '../../shared/lang/i18n-lite';

/**
 * 标准化文件夹路径
 * - 确保以 / 开头
 * - 去除多余的连续斜杠
 * - 去除尾部斜杠（除非是根路径 /）
 * - 空字符串或 null/undefined 返回 '/'
 * 
 * @param path 原始路径
 * @returns 标准化后的路径，空路径返回 '/'
 * 
 * @example
 * normalizeFolderPath('') => '/'
 * normalizeFolderPath(null) => '/'
 * normalizeFolderPath('/folder1//folder2/') => '/folder1/folder2'
 * normalizeFolderPath('folder1/folder2') => '/folder1/folder2'
 */
export const normalizeFolderPath = (path: string | null | undefined): string => {
    if (!path || path.trim() === '' || path === '/') {
        return '/';
    }
    const prefixed = path.startsWith('/') ? path : `/${path}`;
    const condensed = prefixed.replace(/\/{2,}/g, '/');
    return condensed.length > 1 && condensed.endsWith('/') ? condensed.slice(0, -1) : condensed;
};

/**
 * 组合 demo 的完整路径
 * 
 * @param folderPath 文件夹路径
 * @param fileName 文件名（不含扩展名）
 * @returns 完整路径，如果文件名为空则返回 null
 * 
 * @example
 * composeDemoFullPath('/', 'demo1') => '/demo1'
 * composeDemoFullPath('/folder1', 'demo1') => '/folder1/demo1'
 */
export const composeDemoFullPath = (folderPath: string | null | undefined, fileName: string | null | undefined): string | null => {
    if (!fileName || !fileName.trim()) {
        return null;
    }
    const normalizedFolder = normalizeFolderPath(folderPath);
    const safeFileName = fileName.trim();
    return normalizedFolder === '/' ? `/${safeFileName}` : `${normalizedFolder}/${safeFileName}`;
};

/**
 * 验证文件名合法性
 * @param fileName 文件名（不含扩展名）
 * @returns 验证结果：{ valid: boolean, message?: string }
 */
export const validateFileName = (fileName: string): { valid: boolean; message?: string } => {
    if (!fileName || !fileName.trim()) {
        return { valid: false, message: 'File name cannot be empty' };
    }

    const trimmed = fileName.trim();
    
    // 检查长度
    if (trimmed.length > 255) {
        return { valid: false, message: 'File name too long (max 255 characters)' };
    }

    // Windows 和 Unix 系统都不允许的字符
    const illegalChars = /[<>:"|?*\x00-\x1f]/;
    if (illegalChars.test(trimmed)) {
        return { valid: false, message: 'File name contains invalid characters (cannot contain < > : " | ? * or control characters)' };
    }

    // 检查保留名称（Windows）
    const reservedNames = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i;
    if (reservedNames.test(trimmed)) {
        return { valid: false, message: 'File name cannot be a system reserved name' };
    }

    // 检查不能以点或空格开头/结尾（某些系统）
    if (trimmed.startsWith('.') || trimmed.endsWith('.')) {
        return { valid: false, message: 'File name cannot start or end with a dot' };
    }

    // 检查不能包含路径分隔符
    if (trimmed.includes('/') || trimmed.includes('\\')) {
        return { valid: false, message: 'File name cannot contain path separators' };
    }

    return { valid: true };
};

/**
 * 生成 demo 默认名称：优先使用现有文件名，否则取分析文本第一行的前50个字符
 * 
 * @param currentData 当前分析数据
 * @param textFieldValue 文本输入框的值
 * @param existingFileName 可选的现有文件名（如果提供且有效，则优先使用）
 * @returns 默认名称
 */
export const getDefaultDemoName = (
    currentData: AnalyzeResponse | null, 
    textFieldValue: string,
    existingFileName?: string | null
): string => {
    // 如果提供了现有文件名且有效，则使用它（去掉 .json 后缀）
    if (existingFileName && existingFileName.trim() && existingFileName !== '未选择文件') {
        const trimmed = existingFileName.trim();
        // 去掉 .json 后缀（如果存在）
        const nameWithoutExt = trimmed.toLowerCase().endsWith('.json') 
            ? trimmed.slice(0, -5) 
            : trimmed;
        if (nameWithoutExt) {
            return nameWithoutExt;
        }
    }
    
    // 否则，使用第一行逻辑（与主文本框一致不 trim）
    const rawText = currentData ? currentData.request.text : textFieldValue || '';
    if (!rawText) {
        return '新Demo';
    }
    const firstLineBreak = rawText.search(/[\r\n]/);
    const firstLine = firstLineBreak === -1 ? rawText : rawText.slice(0, firstLineBreak);
    return (firstLine.length ? firstLine : '新Demo').slice(0, 50);
};

/**
 * 构建保存目录选项（根目录优先）
 * 统一文件夹排序和选项生成逻辑
 * 
 * @param folders 文件夹列表
 * @param lastPath 上次保存的路径（从 localStorage 获取）
 * @returns 选项列表和默认路径
 */
export const buildFolderOptions = (
    folders: string[],
    lastPath: string | null
): { options: Array<{ value: string; text: string }>, defaultPath: string } => {
    // 排序文件夹列表：根目录排在最前面
    const sorted = [...folders].sort((a, b) => {
        const normA = normalizeFolderPath(a);
        const normB = normalizeFolderPath(b);
        if (normA === '/' && normB !== '/') return -1;
        if (normA !== '/' && normB === '/') return 1;
        return normA.localeCompare(normB, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });
    
    // 转换为选项格式
    const options = sorted.map(folder => ({
        value: folder,
        text: folder === '' || folder === '/' ? tr('/ (Root)') : folder
    }));
    
    // 设置默认路径：优先使用上次保存的路径，如果不存在则使用根目录
    let defaultPath = '/';
    if (lastPath && sorted.includes(lastPath)) {
        defaultPath = lastPath;
    } else if (sorted.length > 0) {
        defaultPath = sorted[0] || '/';
    }
    
    return { options, defaultPath };
};

