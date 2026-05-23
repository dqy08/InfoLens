/**
 * 本地文件 I/O 工具
 * 负责与用户硬盘的交互：导入（读取）和导出（下载）文件
 * 不负责状态管理和持久化
 */

import type { AnalysisData } from '../../shared/api/GLTR_API';
import { validateDemoFormat, ensureJsonExtension } from '../cross/localFileUtils';
import { extractErrorMessage } from '../core/errorUtils';
import { tr } from '../../shared/lang/i18n-lite';

export interface ImportResult {
    success: boolean;
    data?: AnalysisData;
    filename?: string;
    message?: string;
    cancelled?: boolean;  // 用户取消操作
    // 多选模式返回的文件列表
    files?: Array<{
        data: AnalysisData;
        filename: string;
    }>;
}

/**
 * 本地文件 I/O 工具类
 * 提供文件的导入（从硬盘读取）和导出（下载到硬盘）功能
 */
export class LocalFileIO {
    /**
     * 导入文件（弹出文件选择框）
     * @param multiple 是否支持多选，默认 false（单选）
     * @returns 单选模式返回 data 和 filename，多选模式返回 files 数组
     */
    async import(multiple: boolean = false): Promise<ImportResult> {
        return new Promise((resolve) => {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';
            input.multiple = multiple;
            input.style.display = 'none';
            
            const cleanup = () => {
                if (input.parentNode) input.parentNode.removeChild(input);
            };
            
            input.onchange = async (e: Event) => {
                const files = (e.target as HTMLInputElement).files;
                if (!files || files.length === 0) {
                    cleanup();
                    resolve({ success: false, message: tr('No file selected') });
                    return;
                }

                try {
                    if (multiple) {
                        // 多选模式：处理所有文件（即使只有1个文件也返回 files 数组格式）
                        // 逐个处理文件，收集成功和失败的结果
                        const fileResults: Array<{data: AnalysisData; filename: string}> = [];
                        const errors: string[] = [];
                        
                        for (const file of Array.from(files)) {
                            try {
                                const text = await file.text();
                                const data = JSON.parse(text);
                                validateDemoFormat(data);
                                const cleanFilename = ensureJsonExtension(file.name);
                                fileResults.push({
                                    data: data as AnalysisData,
                                    filename: cleanFilename
                                });
                            } catch (err) {
                                const message = extractErrorMessage(err, tr('Read failed'));
                                errors.push(`${file.name}: ${message}`);
                            }
                        }
                        
                        cleanup();
                        
                        // 如果所有文件都失败，返回失败结果
                        if (fileResults.length === 0) {
                            resolve({
                                success: false,
                                message: `${tr('All files failed to read:')}\n${errors.join('\n')}`
                            });
                        } else {
                            // 部分或全部成功，返回成功结果（如果有错误信息，可以包含在message中）
                            resolve({
                                success: true,
                                files: fileResults,
                                message: errors.length > 0 ? `${tr('Partial files failed:')}\n${errors.join('\n')}` : undefined
                            });
                        }
                    } else {
                        // 单选模式：只处理第一个文件（保持向后兼容）
                        const file = files[0];
                        const text = await file.text();
                        const data = JSON.parse(text);
                        validateDemoFormat(data);
                        cleanup();
                        // 确保文件名以 .json 结尾（统一入口处理）
                        const cleanFilename = ensureJsonExtension(file.name);
                        resolve({
                            success: true,
                            data: data as AnalysisData,
                            filename: cleanFilename
                        });
                    }
                } catch (error) {
                    cleanup();
                    const message = extractErrorMessage(error, tr('Failed to read file'));
                    resolve({ success: false, message });
                }
            };

            input.oncancel = () => {
                cleanup();
                resolve({ success: false, message: tr('User cancelled file selection'), cancelled: true });
            };

            document.body.appendChild(input);
            input.click();
        });
    }

    /**
     * 导出文件（触发浏览器下载）
     * @param data 要导出的数据
     * @param filename 文件名
     * @returns 是否成功
     */
    async export(data: AnalysisData, filename: string): Promise<boolean> {
        return exportJsonFile(data, filename);
    }
}

/**
 * 下载任意可 JSON 序列化对象（如 gen_attribute 打包 demo 的 payload），与 {@link LocalFileIO.export} 同形。
 */
export async function exportJsonFile(data: unknown, filename: string): Promise<boolean> {
    try {
        const jsonString = JSON.stringify(data, null, 2);
        const blob = new Blob([jsonString], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = ensureJsonExtension(filename);
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            if (a.parentNode) document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }, 100);
        return true;
    } catch (error) {
        console.error('exportJsonFile failed:', error);
        return false;
    }
}

