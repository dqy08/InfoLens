import * as d3 from 'd3';

export type ColumnMoveDirection = 'left' | 'right' | 'first' | 'last';

/** 禁用首列左移/移到最左、末列右移/移到最右 */
export function updateEditButtonsState(
    container: d3.Selection<any, any, any, any>
): void {
    const columns = container.selectAll<HTMLElement, unknown>('.compare-column');
    const columnNodes = columns.nodes();

    columns.each(function (_d, i) {
        const columnElement = d3.select(this);
        const moveToFirstBtn = columnElement.select('.move-to-first-btn');
        const moveLeftBtn = columnElement.select('.move-left-btn');
        const moveRightBtn = columnElement.select('.move-right-btn');
        const moveToLastBtn = columnElement.select('.move-to-last-btn');

        const isFirst = i === 0;
        moveToFirstBtn.property('disabled', isFirst);
        moveLeftBtn.property('disabled', isFirst);

        const isLast = i === columnNodes.length - 1;
        moveRightBtn.property('disabled', isLast);
        moveToLastBtn.property('disabled', isLast);
    });
}

/**
 * 按方向调整列在 #compare-container 中的 DOM 顺序。
 * @returns 是否发生了移动
 */
export function moveColumnInDom(
    containerNode: HTMLElement,
    columnId: string,
    direction: ColumnMoveDirection
): boolean {
    const columnNode = containerNode.querySelector(
        `[data-column-id="${columnId}"]`
    ) as HTMLElement | null;
    if (!columnNode) {
        return false;
    }

    const allColumns = Array.from(
        containerNode.querySelectorAll('.compare-column')
    ) as HTMLElement[];
    const currentIndex = allColumns.indexOf(columnNode);
    if (currentIndex === -1) {
        return false;
    }

    const columnParent = columnNode.parentElement;
    if (!columnParent) {
        return false;
    }

    if (direction === 'first') {
        if (currentIndex === 0) {
            return false;
        }
        const firstColumnParent = allColumns[0].parentElement;
        if (!firstColumnParent) {
            return false;
        }
        containerNode.insertBefore(columnParent, firstColumnParent);
        return true;
    }

    if (direction === 'last') {
        if (currentIndex === allColumns.length - 1) {
            return false;
        }
        containerNode.appendChild(columnParent);
        return true;
    }

    if (direction === 'left') {
        if (currentIndex === 0) {
            return false;
        }
        const targetParent = allColumns[currentIndex - 1]?.parentElement;
        if (!targetParent || columnParent === targetParent) {
            if (columnParent === targetParent) {
                console.error('DOM 结构异常：两个列在同一个父容器中');
            }
            return false;
        }
        containerNode.insertBefore(columnParent, targetParent);
        return true;
    }

    // direction === 'right'
    if (currentIndex === allColumns.length - 1) {
        return false;
    }
    const targetParent = allColumns[currentIndex + 1]?.parentElement;
    if (!targetParent || columnParent === targetParent) {
        if (columnParent === targetParent) {
            console.error('DOM 结构异常：两个列在同一个父容器中');
        }
        return false;
    }
    if (targetParent.nextSibling) {
        containerNode.insertBefore(columnParent, targetParent.nextSibling);
    } else {
        containerNode.appendChild(columnParent);
    }
    return true;
}
