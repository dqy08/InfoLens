import * as d3 from 'd3';
import { TextAnalysisAPI } from '../../shared/api/GLTR_API';
import { showMoveDialog } from './folderOperations';
import { showAlertDialog } from './dialog';
// 国际化
import { tr } from '../../shared/lang/i18n-lite';

export type DemoItem = {
    type: 'folder' | 'file';
    name: string;
    path: string;
};

export type MultiSelectOptions = {
    container: d3.Selection<d3.BaseType, any, any, any>;
    api: TextAnalysisAPI;
    getItemFullPath: (item: DemoItem) => string | null;
    getCurrentPath: () => string;
    setLoading: (loading: boolean) => void; // 实际是 setListLoading，保持参数名兼容
    fetchDemoList: () => Promise<void>;
    showToast: (message: string, type: 'success' | 'error') => void;
    showAlertDialog: (title: string, message: string) => void;
    onModeChange: () => void; // 当模式切换时，需要重新渲染列表
    initialMultiSelectMode?: boolean; // 初始多选模式状态，默认为 false
    disableModeToggle?: boolean; // 禁用模式切换按钮（只读选择场景），默认为 false
    onSelectionChange?: (selectedCount: number) => void; // 选择数量变化时的回调
};

export type MultiSelect = {
    isMultiSelectMode: () => boolean;
    isItemSelected: (item: DemoItem) => boolean;
    shouldShowCheckbox: () => boolean;
    syncSelectionFromCheckbox: (item: DemoItem, checkboxNode: HTMLInputElement) => void;
    syncCheckboxFromSelection: () => void;
    selectAllItems: (items: DemoItem[]) => void;
    clearSelection: () => void;
    toggleMode: () => void;
    updateBar: () => void;
    initUI: (navWrapper: d3.Selection<d3.BaseType, any, any, any>) => void;
    getSelectedPaths: () => string[]; // 获取所有选中项的路径
};

export function createMultiSelect(options: MultiSelectOptions): MultiSelect {
    const {
        container,
        api,
        getItemFullPath,
        getCurrentPath,
        setLoading,
        fetchDemoList,
        showToast,
        showAlertDialog,
        onModeChange,
        initialMultiSelectMode = false,
        disableModeToggle = false,
        onSelectionChange,
    } = options;

    // 多选模式状态（使用配置的初始值）
    let multiSelectMode: boolean = initialMultiSelectMode;
    const selectedDemos: string[] = []; // 存储选中项的完整路径（按选择顺序）

    // UI元素
    let multiSelectBar: d3.Selection<HTMLDivElement, any, any, any> | null = null;
    let multiSelectToggleBtn: d3.Selection<HTMLButtonElement, any, any, any> | null = null;
    let multiSelectCount: d3.Selection<HTMLSpanElement, any, any, any> | null = null;
    let navWrapper: d3.Selection<d3.BaseType, any, any, any> | null = null;

    // 从复选框同步状态到 selectedDemos
    const syncSelectionFromCheckbox = (item: DemoItem, checkboxNode: HTMLInputElement) => {
        // 如果复选框被禁用，不更新选择状态
        if (checkboxNode.disabled) return;

        const itemPath = getItemFullPath(item);
        if (itemPath === null) return;

        // 直接从复选框读取状态，同步到 selectedDemos
        if (checkboxNode.checked) {
            selectedDemos.push(itemPath);
        } else {
            const index = selectedDemos.indexOf(itemPath);
            if (index !== -1) {
                selectedDemos.splice(index, 1);
            }
        }

        updateBar();
    };

    // 同步 selectedDemos 到复选框状态（用于全选/清空操作）
    const syncCheckboxFromSelection = () => {
        const demoItems = container.selectAll<HTMLDivElement, DemoItem>('.demo-item');
        demoItems.each(function(d) {
            const demoItem = d3.select(this);
            const checkbox = demoItem.select<HTMLInputElement>('.demo-checkbox-inline');
            if (!checkbox.empty()) {
                const itemPath = getItemFullPath(d);
                const shouldBeChecked = itemPath !== null && selectedDemos.includes(itemPath);
                const checkboxNode = checkbox.node();
                if (checkboxNode) {
                    checkboxNode.checked = shouldBeChecked;
                }
            }
        });
    };

    const selectAllItems = (items: DemoItem[]) => {
        items.forEach(item => {
            const itemPath = getItemFullPath(item);
            if (itemPath !== null) {
                selectedDemos.push(itemPath);
            }
        });
        syncCheckboxFromSelection(); // 同步到复选框
        updateBar();
    };

    const clearSelection = () => {
        selectedDemos.length = 0;
        syncCheckboxFromSelection(); // 同步到复选框
        updateBar();
    };

    const toggleMode = () => {
        multiSelectMode = !multiSelectMode;
        // 退出多选模式时清空选择状态
        if (!multiSelectMode) {
            clearSelection();
        }
        updateBar();
        updateToggleBtn();
        onModeChange(); // 通知主模块重新渲染列表
    };

    const updateBar = () => {
        if (!multiSelectBar || !multiSelectCount) return;
        
        if (multiSelectMode) {
            multiSelectBar.style('display', 'flex');
            const selectedCount = selectedDemos.length;
            
            // 基于checkbox原生状态判断全选按钮是否可用
            // 获取当前目录下所有未禁用的checkbox（未禁用的都是文件类型）
            const selectableCheckboxes: HTMLInputElement[] = [];
            container.selectAll<HTMLInputElement, DemoItem>('.demo-checkbox-inline').each(function() {
                const checkbox = this;
                if (!checkbox.disabled) {
                    selectableCheckboxes.push(checkbox);
                }
            });
            
            // 检查是否所有可选择的checkbox都已选中
            const allSelected = selectableCheckboxes.length > 0 && 
                selectableCheckboxes.every(checkbox => checkbox.checked);
            const hasUnselected = !allSelected; // 有未选中项时全选按钮可用
            
            multiSelectCount.text(selectedCount > 0 ? tr('Selected {count}').replace('{count}', String(selectedCount)) : tr('No selection'));
            
            // 更新所有按钮的可用状态
            multiSelectBar.selectAll('.refresh-btn').each(function() {
                const btn = d3.select(this);
                const action = btn.attr('data-action');
                let isActive = false;
                
                if (action === 'select-all') {
                    isActive = hasUnselected; // 有未选中项时可用
                } else if (action === 'clear' || action === 'delete' || action === 'move') {
                    isActive = selectedCount > 0; // 有选中项时可用
                }
                
                btn.classed('inactive', !isActive);
            });
            
            // 通知外部选择数量已变化（用于更新弹窗确定按钮等）
            if (onSelectionChange) {
                onSelectionChange(selectedCount);
            }
        } else {
            multiSelectBar.style('display', 'none');
        }
    };

    const updateToggleBtn = () => {
        if (multiSelectToggleBtn) {
            if (multiSelectMode) {
                // 多选模式：显示选中图标
                multiSelectToggleBtn
                    .attr('title', tr('Exit multi-select mode'))
                    .text('☑');
            } else {
                // 非多选模式：显示未选中图标
                multiSelectToggleBtn
                    .attr('title', tr('Multi-select mode'))
                    .text('☐');
            }
        }
    };

    const handleBatchDelete = async () => {
        const selectedItems: DemoItem[] = [];
        const currentPath = getCurrentPath();
        const result = await api.list_demos(currentPath);
        const allItems = result.items || [];
        
        allItems.forEach((item: DemoItem) => {
            const itemPath = getItemFullPath(item);
            if (itemPath !== null && selectedDemos.includes(itemPath)) {
                selectedItems.push(item);
            }
        });

        if (selectedItems.length === 0) {
            showAlertDialog(tr('Info'), tr('Please select items to delete first'));
            return;
        }

        const itemNames = selectedItems.map(item => item.name).join('\n');
        const confirmMessage = tr('Are you sure you want to delete the following {count} items?').replace('{count}', String(selectedItems.length)) + '\n\n' + itemNames;
        
        if (!confirm(confirmMessage)) {
            return;
        }

        try {
            setLoading(true);
            let successCount = 0;
            let failCount = 0;
            const errors: string[] = [];

            for (const item of selectedItems) {
                try {
                    let result;
                    if (item.type === 'file') {
                        result = await api.delete_demo(item.path);
                    } else {
                        result = await api.delete_folder(item.path);
                    }
                    
                    if (result.success) {
                        successCount++;
                    } else {
                        failCount++;
                        errors.push(`${item.name}: ${tr(result.message || 'Delete failed')}`);
                    }
                } catch (err) {
                    failCount++;
                    errors.push(`${item.name}: ${err instanceof Error ? tr(err.message) : tr('Delete failed')}`);
                }
            }

            // 刷新列表
            await fetchDemoList();
            
            // 清空选择
            clearSelection();

            // 显示结果
            if (failCount === 0) {
                showToast(tr('Successfully deleted {count} items').replace('{count}', String(successCount)), 'success');
            } else {
                const errorMsg = errors.length > 0 ? `\n\n${tr('Failed items:')}\n${errors.slice(0, 5).join('\n')}${errors.length > 5 ? `\n${tr('... and {count} more items failed').replace('{count}', String(errors.length - 5))}` : ''}` : '';
                const message = tr('Successfully deleted {success} items, failed {fail} items')
                    .replace('{success}', String(successCount))
                    .replace('{fail}', String(failCount)) + errorMsg;
                showAlertDialog(tr('Partial success'), message);
            }
        } catch (err) {
            console.error('批量删除失败:', err);
            showAlertDialog(tr('Error'), tr('Batch delete failed, please check console for details.'));
        } finally {
            setLoading(false);
        }
    };

    const handleBatchMove = async () => {
        const selectedItems: DemoItem[] = [];
        const currentPath = getCurrentPath();
        const result = await api.list_demos(currentPath);
        const allItems = result.items || [];
        
        allItems.forEach((item: DemoItem) => {
            const itemPath = getItemFullPath(item);
            if (itemPath !== null && selectedDemos.includes(itemPath)) {
                selectedItems.push(item);
            }
        });

        if (selectedItems.length === 0) {
            showAlertDialog(tr('Info'), tr('Please select items to move first'));
            return;
        }

        try {
            setLoading(true);
            const foldersResult = await api.list_all_folders();
            const folders = foldersResult.folders || [];
            
            // 排除所有选中项所在的路径及其子路径
            const excludePaths = new Set<string>();
            selectedItems.forEach(item => {
                const excludePath = item.path;
                if (excludePath) {
                    excludePaths.add(excludePath);
                }
            });
            
            const filteredFolders = folders.filter(f => {
                if (excludePaths.has(f)) return false;
                for (const excludePath of excludePaths) {
                    if (f.startsWith(excludePath + '/')) return false;
                }
                return true;
            });

            showMoveDialog(filteredFolders, currentPath, async (targetPath: string) => {
                try {
                    setLoading(true);
                    let successCount = 0;
                    let failCount = 0;
                    const errors: string[] = [];

                    for (const item of selectedItems) {
                        try {
                            let result;
                            if (item.type === 'file') {
                                result = await api.move_demo(item.path, targetPath);
                            } else {
                                result = await api.move_folder(item.path, targetPath);
                            }
                            
                            if (result.success) {
                                successCount++;
                            } else {
                                failCount++;
                                errors.push(`${item.name}: ${tr(result.message || 'Move failed')}`);
                            }
                        } catch (err) {
                            failCount++;
                            errors.push(`${item.name}: ${err instanceof Error ? tr(err.message) : tr('Move failed')}`);
                        }
                    }

                    // 刷新列表
                    await fetchDemoList();
                    
                    // 清空选择
                    clearSelection();

                    // 显示结果
                    if (failCount === 0) {
                        showToast(tr('Successfully moved {count} items').replace('{count}', String(successCount)), 'success');
                    } else {
                        const errorMsg = errors.length > 0 ? `\n\n${tr('Failed items:')}\n${errors.slice(0, 5).join('\n')}${errors.length > 5 ? `\n${tr('... and {count} more items failed').replace('{count}', String(errors.length - 5))}` : ''}` : '';
                        const message = tr('Successfully moved {success} items, failed {fail} items')
                            .replace('{success}', String(successCount))
                            .replace('{fail}', String(failCount)) + errorMsg;
                        showAlertDialog(tr('Partial success'), message);
                    }
                } catch (err) {
                    console.error('批量移动失败:', err);
                    showAlertDialog(tr('Error'), tr('Batch move failed, please check console for details.'));
                } finally {
                    setLoading(false);
                }
            });
        } catch (err) {
            console.error('获取文件夹列表失败:', err);
            showAlertDialog(tr('Error'), tr('Failed to get folder list, please check console for details.'));
        } finally {
            setLoading(false);
        }
    };

    // 初始化UI
    const initUI = (
        navWrapperParam: d3.Selection<d3.BaseType, any, any, any>
    ) => {
        // 保存navWrapper引用，用于宽度检测
        navWrapper = navWrapperParam;
        
        // 在内部查找 createFolderBtn
        const createFolderBtn = navWrapper.select(`button[title="${tr('New folder')}"]`);
        
        // 创建多选模式控制栏
        // 如果有新建文件夹按钮，则在它之前插入；否则直接放在 navWrapper 末尾
        if (!createFolderBtn.empty()) {
            const createFolderBtnNode = createFolderBtn.node();
            if (createFolderBtnNode && createFolderBtnNode instanceof HTMLElement) {
                multiSelectBar = d3.select(createFolderBtnNode.parentElement)
                    .insert('div', () => createFolderBtnNode)
                    .attr('class', 'demo-multiselect-bar-center')
                    .style('display', 'none')
                    .style('flex-shrink', '0');
            }
        } else {
            multiSelectBar = navWrapper.append('div')
                .attr('class', 'demo-multiselect-bar-center')
                .style('display', 'none')
                .style('flex-shrink', '0');
        }

        // 在多选控制栏的右边添加多选切换按钮（如果未禁用）
        if (!disableModeToggle && !createFolderBtn.empty()) {
            const createFolderBtnNode = createFolderBtn.node();
            if (createFolderBtnNode && createFolderBtnNode instanceof HTMLElement) {
                multiSelectToggleBtn = d3.select(createFolderBtnNode.parentElement)
                    .insert('button', () => createFolderBtnNode)
                    .attr('class', 'refresh-btn')
                    .attr('title', tr('Multi-select mode'))
                    .text('☐')  // 初始状态：未选中
                    .style('flex-shrink', '0')
                    .on('click', toggleMode);
                
                // 初始化按钮状态
                updateToggleBtn();
            }
        }

        // 初始化多选模式控制栏（按钮样式与新建文件夹按钮一致）
        if (multiSelectBar) {
            // 不再在控制栏中显示退出按钮，使用固定的切换按钮
            multiSelectCount = multiSelectBar.append('span')
                .attr('class', 'multiselect-count')
                .style('font-size', '9pt')
                .style('color', 'var(--text-muted)')
                .style('margin-left', '0px')
                .style('margin-right', '6px')  // 减少30%：8px → 6px
                .text(tr('No selection'));
            
            multiSelectBar.append('button')
                .attr('class', 'refresh-btn')
                .attr('data-action', 'select-all')
                .attr('title', tr('Select all'))
                .text(tr('Select all'))
                .on('click', () => {
                    // 获取所有demo项，但只选择未被禁用的项
                    const allItems: DemoItem[] = [];
                    container.selectAll<HTMLDivElement, DemoItem>('.demo-item').each(function(d) {
                        const demoItem = d3.select(this);
                        const checkbox = demoItem.select<HTMLInputElement>('.demo-checkbox-inline');
                        if (!checkbox.empty()) {
                            const checkboxNode = checkbox.node();
                            // 只添加未被禁用的项
                            if (checkboxNode && !checkboxNode.disabled) {
                                allItems.push(d);
                            }
                        }
                    });
                    selectAllItems(allItems);
                });
            
            multiSelectBar.append('button')
                .attr('class', 'refresh-btn')
                .attr('data-action', 'clear')
                .attr('title', tr('Clear'))
                .text(tr('Clear'))
                .on('click', clearSelection);
            
            // 只在非只读模式下显示删除和移动按钮
            if (!disableModeToggle) {
                multiSelectBar.append('button')
                    .attr('class', 'refresh-btn')
                    .attr('data-action', 'delete')
                    .attr('title', tr('Delete'))
                    .text(tr('Delete'))
                    .on('click', handleBatchDelete);
                
                multiSelectBar.append('button')
                    .attr('class', 'refresh-btn')
                    .attr('data-action', 'move')
                    .attr('title', tr('Move'))
                    .text(tr('Move'))
                    .on('click', handleBatchMove);
            }
            
            // 初始化控制栏显示状态（在 forceMultiSelect 模式下需要显示）
            updateBar();
        }
    };

    const getSelectedPaths = (): string[] => {
        return [...selectedDemos];
    };

    return {
        isMultiSelectMode: () => multiSelectMode,
        isItemSelected: (item: DemoItem) => {
            const itemPath = getItemFullPath(item);
            return itemPath !== null && selectedDemos.includes(itemPath);
        },
        shouldShowCheckbox: () => multiSelectMode,
        syncSelectionFromCheckbox,
        syncCheckboxFromSelection,
        selectAllItems,
        clearSelection,
        toggleMode,
        updateBar,
        initUI,
        getSelectedPaths,
    };
}

