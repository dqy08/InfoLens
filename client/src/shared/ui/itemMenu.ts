/**
 * 菜单按钮组件
 * 为每个demo项或文件夹项提供操作菜单（移动、重命名、删除）
 */
import * as d3 from 'd3';
import { isMobileDevice } from '../core/responsive';
import { tr } from '../../shared/lang/i18n-lite';

// 全局菜单管理器：确保同时只有一个菜单打开
let currentOpenMenu: ItemMenu | null = null;

export type ItemMenu = {
    show: () => void;
    hide: () => void;
    remove: () => void;
    showButton: () => void;
    hideButton: () => void;
};

export function createItemMenu(
    item: { type: 'folder' | 'file', name: string, path: string },
    onMove: () => void,
    onRename: () => void,
    onDelete: () => void,
    buttonNode?: HTMLElement | null  // 可选的按钮节点，用于定位菜单
): ItemMenu {
    let menuVisible = false;
    let menuElement: d3.Selection<HTMLDivElement, any, any, any> | null = null;
    let actualButtonNode: HTMLElement | null = buttonNode || null;

    // 检测是否为移动端
    const isMobile = isMobileDevice();

    // 创建菜单按钮（汉堡图标）
    const menuButton = d3.create('button')
        .attr('class', 'demo-item-menu-btn')
        .html('☰')
        .attr('title', tr('More actions'))
        .style('background', 'transparent')
        .style('border', 'none')
        .style('color', 'var(--text-color)')
        .style('cursor', 'pointer')
        .style('font-size', '16px')
        .style('line-height', '1')
        .style('padding', '0 4px')
        .style('opacity', isMobile ? '0.4' : '0')
        .style('transition', 'opacity 0.2s')
        .style('flex-shrink', '0')
        .style('margin-left', '1px')
        .on('mouseenter', function() {
            if (!menuVisible) {
                d3.select(this).style('opacity', '1');
            }
        })
        .on('mouseleave', function() {
            if (!menuVisible) {
                // 不在这里隐藏按钮，由demo-item的mouseleave事件控制
                d3.select(this).style('opacity', '0.6');
            }
        })
        .on('click', function(event) {
            event.stopPropagation();
            // 更新实际按钮节点
            actualButtonNode = this as HTMLElement;
            if (menuVisible) {
                hide();
            } else {
                show();
            }
        });

    // 创建菜单实例对象（用于全局管理）
    const menuInstance: ItemMenu = {
        show: () => {},
        hide: () => {},
        remove: () => {},
        showButton: () => {},
        hideButton: () => {}
    };

    const show = () => {
        if (menuVisible) return;
        
        // 关闭之前打开的菜单
        if (currentOpenMenu && currentOpenMenu !== menuInstance) {
            currentOpenMenu.hide();
        }
        currentOpenMenu = menuInstance;
        
        menuVisible = true;
        if (actualButtonNode) {
            d3.select(actualButtonNode).style('opacity', '1');
        } else {
            menuButton.style('opacity', '1');
        }

        // 使用实际按钮节点进行定位
        const button = actualButtonNode || menuButton.node();
        if (!button) return;

        const rect = button.getBoundingClientRect();
        const menuWidth = 120; // 菜单宽度
        const spacing = 4; // 间距
        
        // 计算菜单位置：显示在按钮下方，右对齐到按钮
        let left = rect.right - menuWidth;
        let top = rect.bottom + spacing;
        
        // 确保菜单不超出视口边界
        if (left < 0) left = rect.left;
        if (left + menuWidth > window.innerWidth) left = window.innerWidth - menuWidth - spacing;
        if (top < 0) top = spacing;
        
        menuElement = d3.select('body').append('div')
            .attr('class', 'demo-item-menu')
            .style('position', 'fixed')
            .style('background', 'var(--bg-color, #fff)')
            .style('border', '1px solid var(--border-color, #ddd)')
            .style('border-radius', '4px')
            .style('box-shadow', '0 2px 8px rgba(0,0,0,0.15)')
            .style('z-index', '1000')
            .style('min-width', `${menuWidth}px`)
            .style('padding', '4px 0')
            .style('left', `${left}px`)
            .style('top', `${top}px`);

        // 菜单项（简约风格 SVG 图标）
        const menuItems = [
            { 
                icon: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M2 6h8M7 3l3 3-3 3"/></svg>',
                label: tr('Move to...'), 
                action: onMove 
            },
            { 
                icon: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2l2 2-6 6H2V8l6-6z"/></svg>',
                label: tr('Rename'), 
                action: onRename 
            },
            { 
                icon: '<svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l6 6M9 3l-6 6"/></svg>',
                label: tr('Delete'), 
                action: onDelete 
            }
        ];

        const menuItemSelection = menuElement.selectAll('.menu-item')
            .data(menuItems)
            .join('div')
            .attr('class', 'menu-item')
            .style('padding', '6px 16px')
            .style('cursor', 'pointer')
            .style('color', 'var(--text-color)')
            .style('font-size', '13px')
            .style('transition', 'background 0.2s')
            .style('display', 'flex')
            .style('align-items', 'center')
            .style('gap', '8px')
            .on('mouseenter', function() {
                d3.select(this).style('background', 'var(--hover-bg-color, #f0f0f0)');
            })
            .on('mouseleave', function() {
                d3.select(this).style('background', 'transparent');
            })
            .on('click', function(event, d) {
                event.stopPropagation();
                hide();
                d.action();
            });
        
        // 添加图标
        menuItemSelection.each(function(d) {
            const container = d3.select(this);
            container.append('span')
                .style('display', 'inline-flex')
                .style('align-items', 'center')
                .style('opacity', '0.7')
                .html(d.icon);
            container.append('span')
                .text(d.label);
        });

        // 点击外部关闭菜单
        const clickHandler = (event: MouseEvent) => {
            const target = event.target as Node;
            if (menuElement && menuElement.node() && !menuElement.node()?.contains(target) && 
                button && !button.contains(target)) {
                hide();
                document.removeEventListener('click', clickHandler);
            }
        };
        
        // 延迟添加事件监听，避免立即触发
        setTimeout(() => {
            document.addEventListener('click', clickHandler);
        }, 0);
    };

    const hide = () => {
        if (!menuVisible) return;
        menuVisible = false;
        if (actualButtonNode) {
            d3.select(actualButtonNode).style('opacity', '0.6');
        } else {
            menuButton.style('opacity', '0.6');
        }
        if (menuElement) {
            menuElement.remove();
            menuElement = null;
        }
        // 清除全局引用
        if (currentOpenMenu === menuInstance) {
            currentOpenMenu = null;
        }
    };

    const remove = () => {
        hide();
        menuButton.remove();
    };

    const showButton = () => {
        if (menuVisible) return; // 如果菜单已打开，不改变按钮透明度
        if (actualButtonNode) {
            d3.select(actualButtonNode).style('opacity', '0.6');
        } else {
            menuButton.style('opacity', '0.6');
        }
    };

    const hideButton = () => {
        if (menuVisible) return; // 如果菜单已打开，保持按钮可见
        // 移动端不隐藏按钮
        if (isMobile) return;
        if (actualButtonNode) {
            d3.select(actualButtonNode).style('opacity', '0');
        } else {
            menuButton.style('opacity', '0');
        }
    };

    // 更新菜单实例对象
    menuInstance.show = show;
    menuInstance.hide = hide;
    menuInstance.remove = remove;
    menuInstance.showButton = showButton;
    menuInstance.hideButton = hideButton;

    return menuInstance;
}

// 导出菜单按钮的创建函数，供外部使用
export function createMenuButton(
    item: { type: 'folder' | 'file', name: string, path: string },
    onMove: () => void,
    onRename: () => void,
    onDelete: () => void
): { button: d3.Selection<HTMLButtonElement, any, any, any>, menu: ItemMenu } {
    // 检测是否为移动端
    const isMobile = isMobileDevice();
    
    // 创建菜单按钮（汉堡图标）
    const menuButton = d3.create('button')
        .attr('class', 'demo-item-menu-btn')
        .html('☰')
        .attr('title', tr('More actions'))
        .style('background', 'transparent')
        .style('border', 'none')
        .style('color', 'var(--text-color)')
        .style('cursor', 'pointer')
        .style('font-size', '16px')
        .style('line-height', '1')
        .style('padding', '0 4px')
        .style('opacity', isMobile ? '0.4' : '0')
        .style('transition', 'opacity 0.2s')
        .style('flex-shrink', '0')
        .style('margin-left', '1px')
        .on('mouseenter', function() {
            d3.select(this).style('opacity', '1');
        })
        .on('mouseleave', function() {
            // 不在这里隐藏按钮，由demo-item的mouseleave事件控制
            d3.select(this).style('opacity', '0.6');
        });
    
    // 创建菜单，传递按钮节点
    const menu = createItemMenu(item, onMove, onRename, onDelete, menuButton.node());
    
    // 设置按钮点击事件
    menuButton.on('click', function(event) {
        event.stopPropagation();
        menu.show();
    });
    
    return { button: menuButton, menu };
}

