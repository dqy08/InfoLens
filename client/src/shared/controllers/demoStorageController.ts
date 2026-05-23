/**
 * Demo存储控制器 - 协调存储层和UI层
 */

import type { AnalysisData } from '../../shared/api/GLTR_API';
import type { IDemoStorage, SaveOptions, SaveResult } from '../../shared/storage/demoStorage';
import { showConfirmDialog, showAlertDialog } from '../../shared/ui/dialog';
import { tr, trf } from '../../shared/lang/i18n-lite';

export interface StorageCallbacks {
    onStart?: () => void;
    onSuccess?: (name?: string, result?: SaveResult) => void;
    onError?: (error: Error) => void;
    setLoading?: (loading: boolean) => void;
    showToast?: (message: string, type: 'success' | 'error') => void;
    /**
     * 是否显示成功提示（使用 toast）
     * 默认为 true，设置为 false 时成功提示由调用者自行处理
     * 注意：错误提示统一使用 alert，不受此参数影响
     */
    showSuccessToast?: boolean;
}

/**
 * Demo存储控制器
 */
export class DemoStorageController {
    constructor(
        private storage: IDemoStorage,
        private callbacks: StorageCallbacks = {}
    ) {}
    
    /**
     * 保存demo
     */
    async save(data: AnalysisData, options: SaveOptions): Promise<SaveResult | null> {
        const { onStart, onSuccess, onError, setLoading, showToast, showSuccessToast = true } = this.callbacks;
        
        onStart?.();
        setLoading?.(true);
        
        try {
            const result = await this._doSave(data, options, false);
            setLoading?.(false);
            
            if (result) {
                onSuccess?.(options.name, result);
                // 成功提示：根据 showSuccessToast 决定是否显示
                if (showSuccessToast) {
                    const hint = this.storage.type === 'local' ? tr('Downloaded to local') : tr('Upload successful');
                    showToast?.(`Demo "${options.name}" ${hint}！`, 'success');
                }
            }
            
            return result;
        } catch (error) {
            setLoading?.(false);
            const err = error instanceof Error ? error : new Error(String(error));
            onError?.(err);
            
            // 错误提示：统一使用 alert
            showAlertDialog(tr('Error'), trf('Save failed: {message}', { message: err.message }));
            return null;
        }
    }
    
    /**
     * 内部保存逻辑，处理覆盖
     */
    private async _doSave(
        data: AnalysisData, 
        options: SaveOptions, 
        overwrite: boolean
    ): Promise<SaveResult | null> {
        const result = await this.storage.save(data, { ...options, overwrite });
        
        // 文件已存在 - 仅服务器需要确认覆盖
        if (!result.success && result.exists && this.storage.type === 'server') {
            return new Promise((resolve) => {
                this.callbacks.setLoading?.(false);
                showConfirmDialog(
                    tr('File already exists'),
                    trf('File "{name}.json" already exists, overwrite?', { name: options.name }),
                    async () => {
                        this.callbacks.setLoading?.(true);
                        const saved = await this._doSave(data, options, true);
                        resolve(saved);
                    },
                    () => {
                        this.callbacks.onError?.(new Error(tr('User cancelled save')));
                        resolve(null);
                    },
                    tr('Overwrite'),
                    tr('Cancel')
                );
            });
        }
        
        if (!result.success) {
            throw new Error(result.message || 'Save failed');
        }
        
        return result;
    }
    
    /**
     * 加载demo
     */
    async load(path?: string): Promise<AnalysisData | null> {
        const { onStart, onSuccess, onError, setLoading } = this.callbacks;
        
        onStart?.();
        setLoading?.(true);
        
        try {
            const result = await this.storage.load(path);
            setLoading?.(false);
            
            if (result.success && result.data) {
                onSuccess?.();
                return result.data;
            } else {
                // 显示错误（这里不涉及用户取消操作）
                if (result.message) {
                    const err = new Error(result.message || 'Load failed');
                    onError?.(err);
                    showAlertDialog(tr('Error'), tr(err.message));
                }
                return null;
            }
        } catch (error) {
            setLoading?.(false);
            const err = error instanceof Error ? error : new Error(String(error));
            onError?.(err);
            showAlertDialog(tr('Error'), trf('Load failed: {message}', { message: err.message }));
            return null;
        }
    }
}

