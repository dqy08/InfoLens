/**
 * URL 工具函数
 */

/**
 * 验证 URL 格式
 * @param url 待验证的 URL 字符串
 * @returns 是否为有效的 URL
 */
export function isValidUrl(url: string): boolean {
    if (!url || typeof url !== 'string') {
        return false;
    }
    
    try {
        const urlObj = new URL(url.trim());
        return urlObj.protocol === 'http:' || urlObj.protocol === 'https:';
    } catch {
        return false;
    }
}

/**
 * 检测文本中是否包含 URL
 * @param text 待检测的文本
 * @returns 找到的第一个 URL，如果没有则返回 null
 */
export function extractUrl(text: string): string | null {
    if (!text || typeof text !== 'string') {
        return null;
    }
    
    // 简单的 URL 正则匹配
    const urlPattern = /https?:\/\/[^\s]+/gi;
    const match = text.trim().match(urlPattern);
    
    if (match && match.length > 0) {
        const url = match[0].replace(/[.,;:!?]+$/, ''); // 移除末尾的标点符号
        return isValidUrl(url) ? url : null;
    }
    
    return null;
}

/**
 * 检查文本是否为纯 URL（没有其他内容）
 * @param text 待检查的文本
 * @returns 是否为纯 URL
 */
export function isPureUrl(text: string): boolean {
    if (!text) {
        return false;
    }
    
    const trimmed = text.trim();
    return isValidUrl(trimmed) && trimmed.split(/\s+/).length === 1;
}
