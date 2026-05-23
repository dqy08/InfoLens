import * as d3 from 'd3';
import { AnalysisData, TextAnalysisAPI } from '../../shared/api/GLTR_API';
import { createPathNavigator, PathNavigator } from './pathNavigator';
import { createMenuButton } from './itemMenu';
import { showMoveDialog, showRenameDialog, showDeleteConfirm, showCreateFolderDialog } from './folderOperations';
import { showAlertDialog } from './dialog';
import { createToast } from './toast';
// 国际化
import { tr } from '../../shared/lang/i18n-lite';
import URLHandler from '../core/URLHandler';
import { createMultiSelect, type MultiSelect } from './demoMultiSelect';
import { normalizeFullPath } from '../core/pathUtils';
import { isValidDemoFormat } from '../cross/localFileUtils';
import { ServerStorage } from '../../shared/storage/demoStorage';
import { DemoStorageController } from '../../shared/controllers/demoStorageController';

export type DemoManagerOptions = {
    api: TextAnalysisAPI;
    enableDemo: boolean;
    containerSelector: string;
    loaderSelector: string;
    refreshSelector: string;
    onDemoLoaded: (data: AnalysisData, disableAnimation: boolean, isNewDemo?: boolean, path?: string) => void;
    onTextPrefill?: (text: string) => void;
    onDemoLoading?: (loading: boolean) => void;
    onRefreshStart?: () => void;
    onRefreshEnd?: () => void;
    forceMultiSelect?: boolean; // 强制启用多选模式（只读选择场景），默认为 false
    disableFolderOperations?: boolean; // 禁用文件夹操作（新建、移动、重命名、删除），默认为 false
    disableClickLoad?: boolean; // 禁用单击加载（多选模式下，文件按钮点击只切换复选框），默认为 false
    onSelectionChange?: (selectedCount: number) => void; // 选择数量变化时的回调
};

export type DemoManager = {
    refresh: () => Promise<void>;
    highlightDemo: (fullPath: string | null) => void;
    navigateToDemoAndHighlight: (fullPath: string) => Promise<void>; // 导航到demo所在文件夹并高亮（不加载数据）
    loadDemoByPath: (fullPath: string) => Promise<boolean>;
    getSelectedPaths: () => string[]; // 获取选中的demo路径
};

type DemoItem = {
    type: 'folder' | 'file';
    name: string;
    path: string;
};

/**
 * @deprecated 已迁移到 isValidDemoFormat，请使用 utils/localFileUtils 中的函数
 * 保留此导出以保持向后兼容，但新代码应使用 isValidDemoFormat
 */
export { isValidDemoFormat as isValidAnalyzeResponse } from '../cross/localFileUtils';

export function initDemoManager(options: DemoManagerOptions): DemoManager {
    const {
        api,
        enableDemo,
        containerSelector,
        loaderSelector,
        refreshSelector,
        onDemoLoaded,
        onTextPrefill,
        onDemoLoading,
        onRefreshStart,
        onRefreshEnd,
        forceMultiSelect = false,
        disableFolderOperations = false,
        disableClickLoad = false,
        onSelectionChange,
    } = options;

    if (!enableDemo) {
        d3.selectAll('.demo').remove();
        return {
            refresh: () => Promise.resolve(),
            highlightDemo: () => {},
            navigateToDemoAndHighlight: () => Promise.resolve(),
            loadDemoByPath: () => Promise.resolve(false),
            getSelectedPaths: () => [],
        };
    }

    const container = d3.select(containerSelector);
    const loader = d3.select(loaderSelector);
    const refreshBtn = d3.select(refreshSelector);

    // 当前路径状态（统一使用 "/" 开头的格式，"/" 表示根目录）
    let currentPath: string = '/';
    let pathNavigator: PathNavigator | null = null;

    // 创建路径导航容器（在demo列表上方）
    let pathNavContainer: d3.Selection<HTMLDivElement, any, any, any> | null = null;
    const containerNode = container.node() as HTMLElement | null;
    if (containerNode && containerNode.parentElement) {
        pathNavContainer = d3.select(containerNode.parentElement)
            .insert('div', () => containerNode)
            .attr('class', 'demo-path-nav-container');
    }

    // 初始化路径导航器
    if (pathNavContainer) {
        pathNavigator = createPathNavigator(
            pathNavContainer,
            currentPath,
            (newPath: string) => {
                currentPath = newPath;
                pathNavigator?.update(newPath);
                fetchDemoList().catch(err => {
                    console.error('刷新demo列表失败:', err);
                });
            },
            disableFolderOperations ? undefined : () => {
                // 新建文件夹（如果未禁用）
                showCreateFolderDialog(async (folderName: string) => {
                    try {
                        setListLoading(true);
                        const result = await api.create_folder(currentPath, folderName);
                        
                        if (result.success) {
                            await fetchDemoList();
                        } else {
                            showAlertDialog(tr('Error'), tr(result.message || 'Failed to create folder'));
                        }
                    } catch (err) {
                        console.error('创建文件夹失败:', err);
                        showAlertDialog(tr('Error'), tr('Failed to create folder, please check console for details.'));
                    } finally {
                        setListLoading(false);
                    }
                });
            }
        );
        
    }

    // 使用统一的路径规范化函数

    let activeDemoFullPath: string | null = null;
    let lastLoadedDemoPath: string | null = null;  // 记录上次加载的demo路径

    const applyActiveState = () => {
        const buttons = container.selectAll<HTMLDivElement, DemoItem>('.demoBtn, .demo-folder-btn');
        
        buttons.classed('demo-selected', d => {
            return d.type === 'file' && normalizeFullPath(d.path) === activeDemoFullPath;
        });
        
        // 滚动到选中的demo项（使用原生 scrollIntoView）
        if (activeDemoFullPath) {
            const selectedButton = buttons.filter(d => {
                return d.type === 'file' && normalizeFullPath(d.path) === activeDemoFullPath;
            });
            
            if (!selectedButton.empty()) {
                const buttonNode = selectedButton.node() as HTMLElement | null;
                
                if (buttonNode) {
                    // 使用 requestAnimationFrame 确保DOM已更新（包括选中状态的样式）
                    requestAnimationFrame(() => {
                        requestAnimationFrame(() => {
                            // 使用原生 scrollIntoView 方法，浏览器会自动处理滚动
                            // block: 'nearest' - 只在必要时垂直滚动，如果已在可视区域则不滚动
                            // inline: 'nearest' - 只在必要时水平滚动，如果已在可视区域则不滚动
                            buttonNode.scrollIntoView({
                                behavior: 'smooth',
                                block: 'nearest',
                                inline: 'nearest'
                            });
                        });
                    });
                }
            }
        }
    };

    const getItemFullPath = (item: DemoItem): string | null => {
        return normalizeFullPath(item.path);
    };

    // 创建多选模块
    let multiSelect: MultiSelect | null = null;
    const toastController = createToast('#toast');
    const showToast = toastController.show;
    
    // 延迟初始化多选模块，因为需要先创建 pathNavigator
    const initMultiSelect = () => {
        if (multiSelect) return; // 已经初始化
        
        if (!pathNavContainer) return;
        
        multiSelect = createMultiSelect({
            container,
            api,
            getItemFullPath,
            getCurrentPath: () => currentPath,
            setLoading: setListLoading,
            fetchDemoList,
            showToast,
            showAlertDialog,
            onModeChange: () => {
                // 当模式切换时，重新渲染列表
                const items = container.selectAll<HTMLDivElement, DemoItem>('.demo-item').data();
                renderItems(items);
            },
            initialMultiSelectMode: forceMultiSelect, // 传递强制多选配置
            disableModeToggle: forceMultiSelect, // 如果强制多选，则禁用模式切换
            onSelectionChange, // 传递选择变化回调（当用户选择/取消选择demo时触发）
        });
        
        // 初始化 UI（控制栏和切换按钮）
        // 在 forceMultiSelect 模式下也需要控制栏（只显示全选和清空按钮）
        const navWrapper = pathNavContainer.select('.demo-path-nav-wrapper');
        if (!navWrapper.empty()) {
            multiSelect.initUI(navWrapper);
        }
    };

    const highlightDemo = (fullPath: string | null) => {
        activeDemoFullPath = normalizeFullPath(fullPath);
        applyActiveState();
    };

    // ============ 辅助函数：路径提取和导航 ============
    
    // 从完整路径中提取文件夹路径
    const extractFolderPath = (fullPath: string): string => {
        const pathParts = fullPath.split('/').filter(p => p);
        if (pathParts.length <= 1) {
            return '/';
        }
        return '/' + pathParts.slice(0, -1).join('/');
    };

    // 导航到指定文件夹并刷新列表（如果当前不在该文件夹）
    const navigateToFolder = async (targetFolderPath: string): Promise<void> => {
        if (currentPath !== targetFolderPath) {
            currentPath = targetFolderPath;
            if (pathNavigator) {
                pathNavigator.update(targetFolderPath);
            }
            await fetchDemoList();
        }
    };

    // 导航到demo所在文件夹并高亮（不加载数据，用于URL恢复等场景）
    const navigateToDemoAndHighlight = async (fullPath: string): Promise<void> => {
        const normalizedPath = normalizeFullPath(fullPath);
        if (!normalizedPath) {
            return;
        }

        try {
            const targetFolderPath = extractFolderPath(normalizedPath);
            await navigateToFolder(targetFolderPath);
            highlightDemo(normalizedPath);
        } catch (error) {
            console.error('导航到demo失败:', error);
        }
    };

    const setActiveDemo = (fullPath: string | null) => {
        highlightDemo(fullPath);
        
        // 然后同步更新URL参数
        if (activeDemoFullPath) {
            URLHandler.updateURLParam('demo', activeDemoFullPath, false);
        } else {
            // 清除demo参数
            const currentParams = URLHandler.parameters;
            delete currentParams['demo'];
            URLHandler.updateUrl(currentParams, false);
        }
    };

    // setListLoading 只用于demo列表区域的loading指示器（显示/隐藏"正在刷新..."文本）
    // 不触发 onDemoLoading，因为刷新列表和文件夹操作不应该影响统计信息
    const setListLoading = (loading: boolean) => {
        loader.style('display', loading ? null : 'none');
    };

    const disableDemoButtons = (disabled: boolean) => {
        container.selectAll('.demoBtn, .demo-folder-btn')
            .style('opacity', disabled ? '0.5' : '1')
            .style('pointer-events', disabled ? 'none' : null)
            .style('cursor', disabled ? 'not-allowed' : 'pointer');
    };

    // 创建服务器存储控制器（统一加载逻辑）
    const serverStorageController = new DemoStorageController(
        new ServerStorage(api),
        {
            setLoading: (loading: boolean) => {
                onDemoLoading?.(loading);
                disableDemoButtons(loading);
            },
            showToast: (message, type) => {
                // demoManager 使用 alert 显示错误
                if (type === 'error') {
                    showAlertDialog(tr('Error'), message);
                }
            },
            showSuccessToast: false  // 由调用者自行处理成功提示
        }
    );

    const fetchDemoList = async () => {
        disableDemoButtons(true);
        setListLoading(true);
        onRefreshStart?.();
        try {
            const result = await api.list_demos(currentPath);
            // 多选模式下，复选状态不受路径切换影响，保留选择状态
            renderItems(result.items || []);
            if (pathNavigator) {
                pathNavigator.update(result.path || currentPath);
                currentPath = result.path || currentPath;
            }
        } finally {
            setListLoading(false);
            disableDemoButtons(false);
            onRefreshEnd?.();
        }
    };

    const handleMoveItem = async (item: DemoItem) => {
        try {
            setListLoading(true);
            const foldersResult = await api.list_all_folders();
            const folders = foldersResult.folders || [];
            
            // 排除当前项所在的路径及其子路径
            const excludePath = item.path;
            
            const filteredFolders = folders.filter(f => {
                if (f === excludePath) return false;
                if (excludePath && f.startsWith(excludePath + '/')) return false;
                return true;
            });

            showMoveDialog(filteredFolders, currentPath, async (targetPath: string) => {
                try {
                    setListLoading(true);
                    let result;
                    if (item.type === 'file') {
                        result = await api.move_demo(item.path, targetPath);
                    } else {
                        result = await api.move_folder(item.path, targetPath);
                    }
                    
                    if (result.success) {
                        await fetchDemoList();
                    } else {
                        showAlertDialog(tr('Error'), tr(result.message || 'Move failed'));
                    }
                } catch (err) {
                    console.error('移动失败:', err);
                    showAlertDialog(tr('Error'), tr('Move failed, please check console for details.'));
                } finally {
                    setListLoading(false);
                }
            });
        } catch (err) {
            console.error('获取文件夹列表失败:', err);
            showAlertDialog(tr('Error'), tr('Failed to get folder list, please check console for details.'));
        } finally {
            setListLoading(false);
        }
    };

    const handleRenameItem = async (item: DemoItem) => {
        showRenameDialog(item.name, async (newName: string) => {
            try {
                setListLoading(true);
                let result;
                if (item.type === 'file') {
                    result = await api.rename_demo(item.path, newName);
                } else {
                    result = await api.rename_folder(item.path, newName);
                }
                
                if (result.success) {
                    await fetchDemoList();
                } else {
                    showAlertDialog(tr('Error'), tr(result.message || 'Rename failed'));
                }
            } catch (err) {
                console.error('重命名失败:', err);
                showAlertDialog(tr('Error'), tr('Rename failed, please check console for details.'));
            } finally {
                setListLoading(false);
            }
        });
    };

    const handleDeleteItem = async (item: DemoItem) => {
        showDeleteConfirm(item.name, item.type, async () => {
            try {
                setListLoading(true);
                let result;
                if (item.type === 'file') {
                    result = await api.delete_demo(item.path);
                } else {
                    result = await api.delete_folder(item.path);
                }
                
                if (result.success) {
                    await fetchDemoList();
                } else {
                    showAlertDialog(tr('Error'), tr(result.message || 'Delete failed'));
                }
            } catch (err) {
                console.error('删除失败:', err);
                showAlertDialog(tr('Error'), tr('Delete failed, please check console for details.'));
            } finally {
                setListLoading(false);
            }
        });
    };

    const handleFolderClick = (folderPath: string) => {
        currentPath = folderPath;
        if (pathNavigator) {
            pathNavigator.update(folderPath);
        }
        fetchDemoList().catch(err => {
            console.error('刷新demo列表失败:', err);
        });
    };

    const renderItems = (items: DemoItem[]) => {
        // 创建demo项容器，保持原有布局
        const demoItems = container.selectAll<HTMLDivElement, DemoItem>('.demo-item')
            .data(items, (d: DemoItem) => d.path)
            .join('div')
            .attr('class', 'demo-item');

        // 多选模式下，在demo-item最左边添加复选框
        if (multiSelect && multiSelect.shouldShowCheckbox()) {
            const checkboxes = demoItems.selectAll<HTMLInputElement, DemoItem>('.demo-checkbox-inline')
                .data(d => [d])
                .join('input')
                .attr('type', 'checkbox')
                .attr('class', 'demo-checkbox-inline')
                .property('checked', d => multiSelect.isItemSelected(d))
                .property('disabled', d => d.type === 'folder'); // 文件夹的复选框设为不可选
        } else {
            // 非多选模式下，移除复选框
            demoItems.selectAll('.demo-checkbox-inline').remove();
        }

        // Demo按钮（文件夹或文件），保持原有样式
        const buttons = demoItems.selectAll<HTMLDivElement, DemoItem>('.demoBtn, .demo-folder-btn')
            .data(d => [d])
            .join('div')
            .attr('class', d => d.type === 'folder' ? 'demo-folder-btn' : 'demoBtn')
            .style('opacity', '1')
            .style('pointer-events', null)
            .style('cursor', 'pointer')
            .html(d => {
                // 文件夹添加简约风格的SVG图标
                if (d.type === 'folder') {
                    const folderIcon = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="display: inline-block; vertical-align: middle; margin-right: 6px; opacity: 0.7;"><path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-6l-2-2H5a2 2 0 0 0-2 2z"/></svg>';
                    return folderIcon + d.name;
                }
                return d.name;
            });

        // 菜单按钮（替换原来的删除按钮）
        // 在 forceMultiSelect 模式下不显示菜单按钮；
        // 在禁用文件夹操作（非管理员模式）时也不显示菜单按钮
        if (!forceMultiSelect && !disableFolderOperations) {
            const menuContainers = demoItems.selectAll<HTMLDivElement, DemoItem>('.demo-menu-container')
                .data(d => [d])
                .join('div')
                .attr('class', 'demo-menu-container')
                .style('flex-shrink', '0')
                .html(''); // 先清空容器内容，避免重复添加

            // 存储菜单对象，用于悬浮显示/隐藏
            const menuMap = new Map<string, ReturnType<typeof createMenuButton>['menu']>();

            menuContainers.each(function(item) {
                const menuContainer = d3.select(this);
                const { button, menu } = createMenuButton(
                    item,
                    disableFolderOperations ? () => {} : () => handleMoveItem(item),
                    disableFolderOperations ? () => {} : () => handleRenameItem(item),
                    disableFolderOperations ? () => {} : () => handleDeleteItem(item)
                );
                const containerNode = menuContainer.node() as HTMLElement | null;
                const buttonNode = button.node() as HTMLElement | null;
                if (containerNode && buttonNode) {
                    containerNode.appendChild(buttonNode);
                }
                // 存储菜单对象
                const key = item.path || '';
                menuMap.set(key, menu);
            });

            // 在demo项上添加鼠标悬浮事件，显示/隐藏菜单按钮
            demoItems
                .on('mouseenter', function(event, item) {
                    const key = item.path || '';
                    const menu = menuMap.get(key);
                    if (menu) {
                        menu.showButton();
                    }
                })
                .on('mouseleave', function(event, item) {
                    const key = item.path || '';
                    const menu = menuMap.get(key);
                    if (menu) {
                        menu.hideButton();
                    }
                });
        } else {
            // forceMultiSelect 或禁用文件夹操作模式下，移除菜单容器
            demoItems.selectAll('.demo-menu-container').remove();
        }

        buttons.on('click', function(event, item) {
            if (item.type === 'folder') {
                handleFolderClick(item.path);
            } else if (item.type === 'file') {
                // 如果禁用了单击加载且启用了多选模式，则切换复选框状态
                if (disableClickLoad && multiSelect && multiSelect.shouldShowCheckbox()) {
                    const demoItem = d3.select(this.parentElement);
                    const checkbox = demoItem.select<HTMLInputElement>('.demo-checkbox-inline');
                    const checkboxNode = checkbox.node();
                    if (checkboxNode && !checkboxNode.disabled) {
                        checkboxNode.checked = !checkboxNode.checked;
                        // 触发 change 事件以同步到 selectedDemos
                        checkbox.dispatch('change');
                    }
                } else {
                    loadDemoFile(item);
                }
            }
        });
        
        // 为复选框绑定 change 事件，从复选框同步状态到 selectedDemos
        if (multiSelect && multiSelect.shouldShowCheckbox()) {
            demoItems.selectAll<HTMLInputElement, DemoItem>('.demo-checkbox-inline')
                .on('change', function(event, d) {
                    // d 是绑定到复选框的数据（DemoItem），event.target 是复选框元素
                    if (d && event.target instanceof HTMLInputElement && multiSelect) {
                        multiSelect.syncSelectionFromCheckbox(d, event.target);
                    }
                });
        }

        // 已改为竖向布局，不再需要设置column-width
        // 移除原有的列宽计算逻辑（基于按钮宽度）

        applyActiveState();
        
        // 切换路径后，确保复选框状态与 selectedDemos 同步
        if (multiSelect && multiSelect.shouldShowCheckbox()) {
            multiSelect.syncCheckboxFromSelection();
            // 列表渲染完成后，更新控制栏按钮状态（修复初始状态下全选按钮不可用的问题）
            multiSelect.updateBar();
        }
    };

    const loadDemoFile = async (item: DemoItem) => {
        if (!item.path || !item.path.trim()) {
            showAlertDialog(tr('Error'), tr('Cannot find corresponding demo file path, unable to load.'));
            return;
        }
        
        // 使用统一的存储控制器加载（与本地加载保持一致）
        const data = await serverStorageController.load(item.path);
        if (!data) {
            // 错误已在控制器中处理
            return;
        }
        
        // 判断是否是新demo（与上次加载的不同）
        // 使用与setActiveDemo相同的路径规范化逻辑
        const demoPath = item.path;
        const normalizedPath = normalizeFullPath(demoPath);
        const isNewDemo = normalizedPath !== lastLoadedDemoPath;
        if (isNewDemo) {
            lastLoadedDemoPath = normalizedPath;
        }
        
        onTextPrefill?.(data.request.text);
        onDemoLoaded(data, true, isNewDemo, demoPath);
        setActiveDemo(demoPath);
    };

    // 根据完整路径加载demo（用于保存后重新加载等场景）
    const loadDemoByPath = async (fullPath: string): Promise<boolean> => {
        const normalizedPath = normalizeFullPath(fullPath);
        if (!normalizedPath) {
            return false;
        }

        try {
            // 使用辅助函数：导航到文件夹
            const targetFolderPath = extractFolderPath(normalizedPath);
            await navigateToFolder(targetFolderPath);

            // 在当前列表中查找匹配的文件
            const result = await api.list_demos(currentPath);
            const items = result.items || [];
            const targetItem = items.find((item: DemoItem) => {
                if (item.type !== 'file') {
                    return false;
                }
                // 检查item的完整路径是否匹配
                const normalizedItemPath = normalizeFullPath(item.path);
                return normalizedItemPath === normalizedPath;
            });

            if (targetItem && targetItem.type === 'file') {
                await loadDemoFile(targetItem);
                return true;
            }

            return false;
        } catch (err) {
            console.error('根据路径加载demo失败:', err);
            return false;
        }
    };

    refreshBtn.on('click', () => {
        fetchDemoList().catch(err => {
            console.error('刷新demo列表失败:', err);
            showAlertDialog(tr('Error'), tr('Failed to refresh demo list, please check console for details.'));
        });
    });

    // 初始化多选模块（在 pathNavigator 创建之后）
    initMultiSelect();

    // 初次加载
    fetchDemoList().catch(err => {
        console.error('加载demo列表失败:', err);
        showAlertDialog(tr('Error'), tr('Failed to refresh demo list, please check console for details.'));
    });

    return {
        refresh: fetchDemoList,
        highlightDemo: highlightDemo,
        navigateToDemoAndHighlight: navigateToDemoAndHighlight,
        loadDemoByPath: loadDemoByPath,
        getSelectedPaths: () => multiSelect ? multiSelect.getSelectedPaths() : [],
    };
}
