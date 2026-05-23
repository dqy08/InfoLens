/**
 * 哈希工具函数
 */
import { tr } from '../../shared/lang/i18n-lite';

/**
 * Crypto Subtle 不可用错误
 * 用于标识因 crypto.subtle 不可用导致的错误
 */
export class CryptoSubtleUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CryptoSubtleUnavailableError';
    }
}

/**
 * 验证哈希值格式（4位十六进制）
 * @param hash 待验证的哈希值
 * @returns 是否为有效的4位十六进制哈希
 */
export function isValidHash(hash: string): boolean {
    return /^[0-9a-fA-F]{4}$/.test(hash);
}

/**
 * 检查 crypto.subtle 是否可用
 * @returns 是否可用
 */
function isCryptoSubtleAvailable(): boolean {
    return typeof crypto !== 'undefined' && 
           crypto.subtle !== undefined;
}

/**
 * 计算文件内容的4位哈希值
 * @param data 文件内容
 * @returns 4位十六进制哈希值
 * @throws CryptoSubtleUnavailableError 如果 crypto.subtle 不可用
 */
export async function hashContent(data: any): Promise<string> {
    // 检查 crypto.subtle 是否可用
    if (!isCryptoSubtleAvailable()) {
        const isLocalhost = window.location.hostname === 'localhost' || 
                           window.location.hostname === '127.0.0.1' ||
                           window.location.hostname === '[::1]';
        const protocol = window.location.protocol;
        
        let message = tr('Unable to use encryption API (crypto.subtle), local cache save feature is unavailable.') + '\n\n';
        
        if (protocol === 'http:' && !isLocalhost) {
            message += tr('Reason: Currently accessing via non-HTTPS non-localhost address, browser security policy has disabled encryption API.') + '\n\n';
            message += tr('Solution:') + '\n';
            message += '1. ' + tr('Recommended: Access via http://localhost:port (recommended)') + '\n';
            message += '2. ' + tr('Or: Configure HTTPS access');
        } else if (protocol === 'file:') {
            message += tr('Reason: Opening page via file:// protocol, browser security policy has disabled encryption API.') + '\n\n';
            message += tr('Solution: Please access the application via http://localhost:port');
        } else {
            message += tr('Reason: Browser does not support or has disabled encryption API.') + '\n\n';
            message += tr('Solution:') + '\n';
            message += '1. ' + tr('Use http://localhost:port to access (recommended)') + '\n';
            message += '2. ' + tr('Or configure HTTPS access');
        }
        
        throw new CryptoSubtleUnavailableError(message);
    }
    
    // 序列化数据
    const content = JSON.stringify(data);
    
    // 使用 SubtleCrypto API 计算 SHA-256
    const encoder = new TextEncoder();
    const dataBuffer = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer);
    
    // 转换为十六进制字符串，取前4位
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    
    return hashHex.slice(0, 4);
}

