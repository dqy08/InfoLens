/**
 * Demo数据验证工具
 */

import type { AnalysisData } from "../../shared/api/GLTR_API";
import {
    validateTokenPredictions,
    validateTokenProbabilities,
    validateTokenConsistency
} from './dataValidation';
import { tr } from '../../shared/lang/i18n-lite';

/**
 * Demo JSON格式验证错误类型
 */
export class DemoFormatError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'DemoFormatError';
    }
}

/**
 * 验证demo JSON格式是否符合要求
 * 首先检查基本结构（是否像"我们的"json格式），然后复用现有验证函数进行具体合法性校验
 */
export function validateDemoFormat(data: any): data is AnalysisData {
    // 1. 检查基本结构：是否为有效的JSON对象
    if (!data || typeof data !== 'object') {
        throw new DemoFormatError(tr('File content is not a valid JSON object'));
    }

    // 2. 检查request字段：是否存在且为对象
    if (!data.request || typeof data.request !== 'object') {
        throw new DemoFormatError(tr('Missing required "request" field'));
    }

    if (typeof data.request.text !== 'string') {
        throw new DemoFormatError('request.text字段必须是字符串');
    }

    // 3. 检查result字段：是否存在且为对象
    if (!data.result || typeof data.result !== 'object') {
        throw new DemoFormatError(tr('Missing required "result" field'));
    }

    // 4. 检查bpe_strings数组：是否存在且为非空数组
    if (!Array.isArray(data.result.bpe_strings)) {
        throw new DemoFormatError('result.bpe_strings字段必须是数组');
    }

    if (data.result.bpe_strings.length === 0) {
        throw new DemoFormatError('result.bpe_strings数组不能为空');
    }

    // 5. 检查每个token是否为对象（基本类型检查）
    for (let i = 0; i < data.result.bpe_strings.length; i++) {
        const token = data.result.bpe_strings[i];
        if (!token || typeof token !== 'object') {
            throw new DemoFormatError(`result.bpe_strings[${i}]不是有效的对象`);
        }
    }

    // 6. 复用现有验证函数进行具体的合法性校验
    const predTopkError = validateTokenPredictions(
        data.result.bpe_strings as Array<{ pred_topk?: [string, number][] }>
    );
    if (predTopkError) {
        throw new DemoFormatError(predTopkError);
    }

    const probabilityError = validateTokenProbabilities(
        data.result.bpe_strings as Array<{ real_topk?: [number, number] }>
    );
    if (probabilityError) {
        throw new DemoFormatError(probabilityError);
    }

    // 7. 验证token数据的一致性（offset和raw是否匹配）
    const text = data.request.text;
    if (text) {
        const consistencyError = validateTokenConsistency(
            data.result.bpe_strings as Array<{ offset?: [number, number]; raw?: string }>,
            text,
            { allowOverlap: true }
        );
        if (consistencyError) {
            throw new DemoFormatError(consistencyError);
        }
    }

    return true;
}

/**
 * 验证demo JSON格式（返回布尔值版本）
 * 用于需要布尔返回值的场景，内部调用 validateDemoFormat
 */
export function isValidDemoFormat(data: unknown): data is AnalysisData {
    try {
        validateDemoFormat(data);
        return true;
    } catch {
        return false;
    }
}

/**
 * 确保文件名以 .json 结尾
 * 如果文件名已有 .json 后缀，直接返回；否则添加 .json 后缀
 */
export function ensureJsonExtension(filename: string): string {
    return filename.endsWith('.json') ? filename : `${filename}.json`;
}
