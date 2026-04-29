import * as d3 from 'd3';

export type SettingsDropdownOption<T> = {
    value: T;
    html: string;
};

/** 共享 class，便于 CSS 复用，新增下拉类型时无需改样式 */
const SHARED = {
    container: 'settings-dropdown',
    btn: 'settings-dropdown-btn',
    menu: 'settings-dropdown-menu',
    option: 'settings-dropdown-option',
} as const;

export type CreateSettingsDropdownOptions<T> = {
    container: d3.Selection<Element | d3.BaseType, unknown, HTMLElement, unknown>;
    classPrefix: string;
    options: SettingsDropdownOption<T>[];
    dataAttr: string;
    bodyClickNamespace: string;
    onSelect: (value: T) => void;
};

export type SettingsDropdown<T> = {
    updateCurrent: (value: T) => void;
    dispose: () => void;
};

/**
 * 创建设置菜单内使用的下拉（主题/语言等）共用 DOM 与开合逻辑
 */
export function createSettingsDropdown<T extends string>(
    config: CreateSettingsDropdownOptions<T>
): SettingsDropdown<T> {
    const { container, classPrefix, options, dataAttr, bodyClickNamespace, onSelect } = config;
    const containerClass = `${classPrefix}-dropdown-container`;
    const currentBtnClass = `${classPrefix}-current-btn`;
    const menuClass = `${classPrefix}-dropdown-menu`;
    const optionClass = `${classPrefix}-option`;

    container.html('');
    const dropdownContainer = container.append('div').attr('class', `${containerClass} ${SHARED.container}`);
    const currentButton = dropdownContainer.append('button').attr('class', `${currentBtnClass} ${SHARED.btn}`).attr('type', 'button');
    const dropdownMenu = dropdownContainer.append('div').attr('class', `${menuClass} ${SHARED.menu}`);

    options.forEach(({ value, html }) => {
        const option = dropdownMenu
            .append('button')
            .attr('class', `${optionClass} ${optionClass}-${value} ${SHARED.option}`)
            .attr(dataAttr, value)
            .attr('type', 'button')
            .html(html);
        option.on('click', function (event: MouseEvent) {
            event.stopPropagation();
            if (d3.select(this).classed('active')) return;
            onSelect(d3.select(this).attr(dataAttr) as T);
            closeDropdown();
        });
    });

    const updateCurrent = (value: T) => {
        const opt = options.find((o) => o.value === value);
        if (opt) currentButton.html(opt.html);
        dropdownMenu.selectAll(`.${optionClass}`).classed('active', function () {
            return d3.select(this).attr(dataAttr) === value;
        });
    };

    let isOpen = false;
    const openDropdown = () => {
        isOpen = true;
        dropdownMenu.classed('open', true);
        currentButton.classed('active', true);
    };
    const closeDropdown = () => {
        isOpen = false;
        dropdownMenu.classed('open', false);
        currentButton.classed('active', false);
    };

    currentButton.on('click', (event: MouseEvent) => {
        event.stopPropagation();
        if (isOpen) closeDropdown();
        else openDropdown();
    });

    // 统一处理：点击下拉容器外的任何地方都关闭（包括设置菜单的其他部分）
    const bodyClickHandler = (event: MouseEvent) => {
        if (!isOpen) return;
        const target = event.target as HTMLElement;
        const containerNode = dropdownContainer.node();
        // 如果点击不在下拉容器内，就关闭（包括设置菜单的其他部分和页面其他地方）
        if (containerNode && !containerNode.contains(target)) {
            closeDropdown();
        }
    };
    // 使用捕获阶段监听，确保即使有 stopPropagation 也能捕获到
    setTimeout(() => {
        document.addEventListener('click', bodyClickHandler, true);
    }, 0);

    return {
        updateCurrent,
        dispose: () => {
            document.removeEventListener('click', bodyClickHandler, true);
            container.selectAll('*').remove();
        },
    };
}
