/**
 * 文件夹操作对话框模块
 * 提供移动、重命名、删除操作的对话框
 */
import { showDialog, createSelectContent, createInputContent, showConfirmDialog } from './dialog';
import { tr, trf } from '../../shared/lang/i18n-lite';
import { lsGet, lsSet } from '../../shared/storage/localStorageHelpers';

export function showMoveDialog(
    folders: string[],
    currentPath: string,
    onConfirm: (targetPath: string) => void
): void {
    // 排序文件夹列表：直接按路径名称排序
    const sortedFolders = [...folders].sort((a, b) => {
        // 根目录排在最前面
        if (a === '/' || a === '') {
            if (b === '/' || b === '') return 0;
            return -1;
        }
        if (b === '/' || b === '') return 1;
        
        // 直接按路径字符串排序
        return a.localeCompare(b, 'zh-CN', { numeric: true, sensitivity: 'base' });
    });

    // 转换为选项格式
    const options = sortedFolders.map(folder => ({
        value: folder,
        text: folder === '' || folder === '/' ? tr('/ (Root)') : folder
    }));

    // 获取上次选择的路径（从 localStorage）
    const lastSelectedPathKey = 'lastMoveTargetPath';
    const lastSelectedPath = lsGet(lastSelectedPathKey);
    
    // 设置默认选择：优先使用上次选择的路径，如果不存在则使用当前路径，最后使用根目录
    let defaultPath = '/';
    if (lastSelectedPath && sortedFolders.includes(lastSelectedPath)) {
        defaultPath = lastSelectedPath;
    } else if (currentPath && sortedFolders.includes(currentPath)) {
        defaultPath = currentPath;
    } else if (sortedFolders.length > 0) {
        defaultPath = sortedFolders[0];
    }

    showDialog({
        title: tr('Move to...'),
        content: createSelectContent(tr('Target folder:'), options, defaultPath),
        onConfirm: (targetPath: string) => {
            // 保存选择的路径到 localStorage
            lsSet(lastSelectedPathKey, targetPath);
            onConfirm(targetPath);
        },
        cancelText: tr('Cancel')
    });
}

export function showRenameDialog(
    currentName: string,
    onConfirm: (newName: string) => void
): void {
    showDialog({
        title: tr('Rename'),
        content: createInputContent(tr('New name:'), currentName),
        onConfirm: (newName: string) => {
            if (newName) {
                onConfirm(newName);
            }
        },
        cancelText: tr('Cancel')
    });
}

export function showDeleteConfirm(
    itemName: string,
    itemType: 'file' | 'folder',
    onConfirm: () => void
): void {
    const itemTypeText = itemType === 'folder' ? tr('Folder') : tr('File');
    showConfirmDialog(
        tr('Confirm deletion'),
        `${trf('Are you sure you want to delete {type} "{name}"?', { type: itemTypeText, name: itemName })}\n\n${tr('This action cannot be undone.')}`,
        onConfirm,
        undefined,
        tr('Delete'),
        tr('Cancel')
    );
}

export function showCreateFolderDialog(
    onConfirm: (folderName: string) => void
): void {
    showDialog({
        title: tr('New folder'),
        content: createInputContent(tr('Folder name:'), '', tr('Enter folder name')),
        onConfirm: (folderName: string) => {
            if (folderName) {
                onConfirm(folderName);
            }
        },
        cancelText: tr('Cancel')
    });
}

