import type { TextAnalysisAPI } from '../../shared/api/GLTR_API';
import type { AnalyzeResponse } from '../../shared/api/GLTR_API';
import { showDialog, createCombinedContent, showAlertDialog, showConfirmDialog } from '../../shared/ui/dialog';
import { createRawSnapshot } from '../cross/tokenUtils';
import { ServerStorage } from '../../shared/storage/demoStorage';
import { DemoStorageController } from './demoStorageController';
import type { IDemoStorage } from '../../shared/storage/demoStorage';
import {
    normalizeFolderPath,
    composeDemoFullPath,
    getDefaultDemoName,
    buildFolderOptions
} from '../../features/demo/demoPathUtils';
import { tr, trf } from '../../shared/lang/i18n-lite';
import { lsGet, lsSet } from '../../shared/storage/localStorageHelpers';

/**
 * 从保存结果中提取文件名，如果不存在则根据名称生成
 */
const extractSavedFileName = (saveResult: any, defaultName: string): string => {
    if (saveResult && typeof saveResult.file === 'string' && saveResult.file.trim()) {
        return saveResult.file.trim();
    }
    const trimmed = defaultName.trim();
    return trimmed.toLowerCase().endsWith('.json') ? trimmed : `${trimmed}.json`;
};

/**
 * 显示 demo 名称输入对话框
 */
export const showDemoNameInput = (
    api: TextAnalysisAPI,
    defaultName: string
): Promise<{ name: string, path: string } | null> => {
    const LAST_SAVE_PATH_KEY = 'lastSaveDemoPath';
    
    return new Promise((resolve) => {
        // 先加载文件夹列表
        api.list_all_folders()
            .then((result: { folders: string[] }) => {
                const folders = result.folders || [];
                
                // 获取上次保存的路径（从 localStorage）
                const lastSavePath = lsGet(LAST_SAVE_PATH_KEY);
                
                // 使用统一的 buildFolderOptions 函数
                const { options: selectOptions, defaultPath } = buildFolderOptions(folders, lastSavePath);

                // 显示弹框
                showDialog({
                    title: tr('Please enter demo name:'),
                    content: createCombinedContent(
                        tr('Demo name:'),
                        defaultName,
                        tr('Save directory:'),
                        selectOptions,
                        defaultPath
                    ),
                    onConfirm: (value: { input: string; select: string }) => {
                        if (value && value.input) {
                            // 保存选择的路径到 localStorage
                            const selectedPath = value.select || '/';
                            lsSet(LAST_SAVE_PATH_KEY, selectedPath);
                            resolve({ name: value.input, path: selectedPath });
                        } else {
                            resolve(null);
                        }
                    },
                    onCancel: () => {
                        resolve(null);
                    },
                    cancelText: tr('Cancel')
                });
            })
            .catch((error) => {
                console.error('加载文件夹列表失败:', error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                showAlertDialog(tr('Error'), trf('Failed to load folder list: {message}', { message: errorMessage }));
                resolve(null);
            });
    });
};

export type ServerDemoSaveOptions = {
    api: TextAnalysisAPI;
    currentData: AnalyzeResponse | null;
    rawApiResponse: AnalyzeResponse | null;
    textFieldValue: string;
    enableDemo: boolean;
    demoManager?: {
        loadDemoByPath: (path: string) => Promise<boolean>;
        highlightDemo: (path: string | null) => void;
        refresh: () => Promise<void>;
    } | null;
    /**
     * 可选：直接传入已选的名称与目录，跳过名称输入弹窗
     */
    presetSaveInfo?: {
        name: string;
        path?: string | null;
    } | null;
    /**
     * 是否显示成功提示（使用 toast）
     * 默认为 true，设置为 false 时成功提示由调用者自行处理
     * 注意：错误提示统一使用 alert，不受此参数影响
     */
    showSuccessToast?: boolean;
    /**
     * 可选的服务器存储实例（用于复用）
     * 如果不提供，将创建新的存储实例
     */
    serverStorage?: IDemoStorage;
    /**
     * 当前文件名（如果有，将作为默认文件名）
     */
    currentFileName?: string | null;
    onSaveStart: () => void;
    onSaveSuccess: (name: string) => void;
    /**
     * 保存成功且后续处理（如自动加载、刷新列表）完成后调用，用于恢复被 renderDemo 重置的状态
     */
    onSaveComplete?: () => void;
    onSaveError: (error: Error) => void;
    setGlobalLoading: (loading: boolean) => void;
    showToast: (message: string, type: 'success' | 'error') => void;
};

/**
 * 处理服务器 demo 保存逻辑
 */
export const handleServerDemoSave = async (options: ServerDemoSaveOptions): Promise<void> => {
    const {
        api,
        currentData,
        rawApiResponse,
        textFieldValue,
        enableDemo,
        demoManager,
        presetSaveInfo = null,
        showSuccessToast = true,
        serverStorage: providedStorage,
        currentFileName = null,
        onSaveStart,
        onSaveSuccess,
        onSaveComplete,
        onSaveError,
        setGlobalLoading,
        showToast
    } = options;

    if (!currentData || !rawApiResponse) {
        showAlertDialog(tr('Info'), tr('No data to save, please analyze text first'));
        return;
    }

    const LAST_SAVE_PATH_KEY = 'lastSaveDemoPath';

    // 获取默认名称并显示输入对话框（或直接使用预设）
    let result: { name: string; path: string } | null = null;
    if (presetSaveInfo && presetSaveInfo.name && presetSaveInfo.name.trim()) {
        const normalizedPath = normalizeFolderPath(presetSaveInfo.path);
        result = { name: presetSaveInfo.name.trim(), path: normalizedPath };
        // 记录最近路径
        if (normalizedPath) {
            lsSet(LAST_SAVE_PATH_KEY, normalizedPath);
        }
    } else {
        const defaultName = getDefaultDemoName(currentData, textFieldValue, currentFileName);
        result = await showDemoNameInput(api, defaultName);
    }

    if (!result || !result.name || result.name.trim() === '') {
        return; // 用户取消或输入为空
    }

    // 使用传入的存储实例或创建新的存储实例
    const savePath = result.path || '/';
    const storage = providedStorage || new ServerStorage(api);
    
    // 创建控制器（回调是动态的，所以每次都需要创建新控制器）
    const serverController = new DemoStorageController(
        storage,
        {
            onStart: onSaveStart,
            onSuccess: async (name, saveResult) => {
                // 保存成功后的处理
                onSaveSuccess(name);
                
                // 注意：成功提示由 demoStorageController 统一处理（根据 showSuccessToast 参数）
                // 如果需要自定义提示，可以设置 showSuccessToast: false 并在 onSaveSuccess 回调中处理
                
                // 保存成功后自动刷新demo列表并重新加载刚保存的demo
                if (enableDemo && demoManager && saveResult) {
                    const savedFileName = extractSavedFileName(saveResult, name);
                    const highlightPath = composeDemoFullPath(savePath, savedFileName);
                    
                    if (highlightPath) {
                        // 保存成功后自动重新加载刚保存的demo
                        try {
                            const success = await demoManager.loadDemoByPath(highlightPath);
                            if (success) {
                                demoManager.highlightDemo(highlightPath);
                            }
                        } catch (err) {
                            console.error('自动加载保存的demo失败:', err);
                        } finally {
                            // 无论加载成功失败，都刷新列表
                            await demoManager.refresh().catch(refreshErr => {
                                console.error('刷新demo列表失败:', refreshErr);
                            });
                        }
                    } else {
                        // 如果没有路径，只刷新列表
                        await demoManager.refresh().catch(err => {
                            console.error('刷新demo列表失败:', err);
                        });
                    }
                }
                onSaveComplete?.();
            },
            onError: onSaveError,
            setLoading: setGlobalLoading,
            showToast,
            showSuccessToast
        }
    );
    
    // 使用统一控制器保存
    await serverController.save(rawApiResponse, {
        name: result.name.trim(),
        path: savePath
    });
};

