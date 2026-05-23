/**
 * 路径导航栏组件
 * 显示面包屑导航，支持点击跳转
 */
import * as d3 from 'd3';
import { tr } from '../../shared/lang/i18n-lite';

export type PathNavigator = {
    update: (path: string) => void;
};

export function createPathNavigator(
    container: d3.Selection<HTMLElement, any, any, any>,
    currentPath: string,
    onPathChange: (path: string) => void,
    onCreateFolder?: () => void
): PathNavigator {
    const navWrapper = container.append('div')
        .attr('class', 'demo-path-nav-wrapper')
        .style('display', 'flex')
        .style('align-items', 'center')
        .style('justify-content', 'space-between')
        .style('gap', '10px');

    const navContainer = navWrapper.append('div')
        .attr('class', 'demo-path-navigator')
        .style('flex', '1')
        .style('font-size', '12px')
        .style('color', 'var(--text-color)');

    // 新建文件夹按钮
    if (onCreateFolder) {
        const createBtn = navWrapper.append('button')
            .attr('class', 'refresh-btn')
            .attr('title', tr('New folder'))
            .style('flex-shrink', '0')
            .text('+')
            .on('click', function() {
                onCreateFolder();
            });
    }

    const update = (path: string) => {
        navContainer.selectAll('*').remove();

        // 解析路径段
        const pathSegments: Array<{ name: string; path: string; isRoot?: boolean }> = [];
        
        // 根目录
        pathSegments.push({ name: '', path: '/', isRoot: true });

        if (path && path !== '/') {
            // 分割路径（去掉开头的 "/"）
            const segments = path.split('/').filter(s => s);
            let currentFullPath = '/';
            
            segments.forEach(segment => {
                // 统一使用 "/" 开头的路径格式
                currentFullPath = currentFullPath === '/' ? `/${segment}` : `${currentFullPath}/${segment}`;
                pathSegments.push({
                    name: decodeURIComponent(segment),
                    path: currentFullPath
                });
            });
        }

        // 渲染路径段
        const pathItems = navContainer.selectAll('.path-segment')
            .data(pathSegments)
            .join('span')
            .attr('class', 'path-segment')
            .style('cursor', 'pointer')
            .style('color', 'var(--text-color)')
            .style('opacity', '0.7')
            .style('transition', 'opacity 0.2s')
            .on('mouseenter', function() {
                d3.select(this).style('opacity', '1');
            })
            .on('mouseleave', function() {
                d3.select(this).style('opacity', '0.7');
            })
            .on('click', function(_, d) {
                onPathChange(d.path);
            })
            .each(function(d) {
                const seg = d3.select(this);
                if (d.isRoot) {
                    seg
                        .attr('title', tr('/(Root)'))
                        .attr('aria-label', tr('/(Root)'))
                        .text('⌂');
                    return;
                }
                seg.text(d.name);
            });

        // 添加分隔符
        const separators = navContainer.selectAll('.path-separator')
            .data(pathSegments.slice(0, -1))
            .join('span')
            .attr('class', 'path-separator')
            .style('margin', '0 6px')
            .style('opacity', '0.5')
            .text(' > ');

        // 重新排序：将分隔符插入到正确位置
        pathItems.each(function(d, i) {
            if (i > 0) {
                const separator = separators.filter((_, idx) => idx === i - 1);
                const separatorNode = separator.node() as HTMLElement | null;
                const thisNode = this as HTMLElement;
                if (separatorNode && thisNode.parentNode) {
                    thisNode.parentNode.insertBefore(separatorNode, thisNode);
                }
            }
        });
    };

    // 初始渲染
    update(currentPath);

    return { update };
}

