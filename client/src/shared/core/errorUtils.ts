/**
 * 错误处理工具函数
 */

import { DemoFormatError } from '../cross/localFileUtils';
import { tr } from '../../shared/lang/i18n-lite';

/**
 * 从错误对象中提取错误消息
 * 支持多种错误类型，提供统一的错误消息提取接口
 *
 * @param error 错误对象（可能是 Error、DemoFormatError、SyntaxError 等）
 * @param defaultMessage 默认错误消息（当无法提取时使用）
 * @returns 错误消息字符串
 */
export function extractErrorMessage(error: unknown, defaultMessage: string): string {
    if (error instanceof DemoFormatError) {
        return error.message;
    }
    if (error instanceof SyntaxError) {
        return tr('File is not a valid JSON format');
    }
    if (error instanceof Error) {
        return error.message;
    }
    return defaultMessage;
}

/**
 * 将可与翻译表精确匹配的 API/后端英文错误转为当前界面语言。
 * 带数字等变化内容的错误一般不翻译，保持服务端返回的英文。
 */
export function translateApiErrorMessage(message: string): string {
    return tr(message);
}
