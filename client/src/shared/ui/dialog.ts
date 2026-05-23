/**
 * 通用弹框组件
 * 提供统一的弹框样式和行为
 */
import * as d3 from 'd3';
import { countTokenCharacters } from '../core/Util';
import { tr } from '../../shared/lang/i18n-lite';

export type DialogContentBuilder = (
    dialog: d3.Selection<HTMLDivElement, unknown, any, any>,
    setConfirmButtonState?: (enabled: boolean) => void
) => {
    getValue?: () => any;
    validate?: () => boolean;
    focus?: () => void;
};

export interface DialogOptions {
    title: string;
    content: DialogContentBuilder;
    /** 确定按钮存在时点击会调用；省略时等价于未定义返回值（仍会在用户点击确定后关闭弹窗） */
    onConfirm?: (value: any) => boolean | void | Promise<boolean | void>;
    onCancel?: () => void;
    /** null 表示不显示确定按钮 */
    confirmText?: string | null;
    cancelText?: string | null;  // undefined/null 表示不显示取消按钮
    /** 确定按钮处于加载/排队状态时显示的文案，默认「排队中...」 */
    loadingConfirmText?: string;
    width?: string;
    height?: string;
}

export type ConfirmButtonState = 'normal' | 'disabled' | 'queuing';

/**
 * 显示通用弹框
 * @returns 返回包含确定按钮状态更新函数的对象
 */
export function showDialog(options: DialogOptions): {
    setConfirmButtonState: (enabled: boolean, queuing?: boolean) => void;
} {
    const {
        title,
        content,
        onConfirm: onConfirmUser,
        onCancel,
        confirmText = tr('Confirm'),
        cancelText,  // 不设置默认值，undefined/null 表示不显示取消按钮
        loadingConfirmText = tr('Queuing...'),
        width = 'clamp(300px, 90vw, 500px)',
        height
    } = options;

    const onConfirm = onConfirmUser ?? (() => undefined);

    // 创建遮罩层
    // 简单直接：上下各多500px余量，确保完全覆盖屏幕
    const overlay = d3.select('body').append('div')
        .attr('class', 'dialog-overlay');

    // 无需监听视口变化，简单直接
    const cleanup = () => {
        // 无需清理
    };

    // 创建对话框
    const dialog = overlay.append('div')
        .attr('class', 'dialog')
        .style('width', width);
    
    // 如果提供了高度设置，应用它
    if (height) {
        dialog.style('height', height);
    }

    // 标题
    dialog.append('div')
        .attr('class', 'dialog-title')
        .text(title);

    // 内容区域
    const contentArea = dialog.append('div')
        .attr('class', 'dialog-content');

    // 按钮容器（先创建，以便在 content 回调中可以使用 setConfirmButtonState）
    const buttonContainer = dialog.append('div')
        .attr('class', 'dialog-buttons');

    // 取消按钮（如果提供了 cancelText）
    if (cancelText !== undefined && cancelText !== null) {
        const cancelBtn = buttonContainer.append('button')
            .attr('class', 'dialog-button cancel')
            .text(cancelText)
            .on('click', () => {
                cleanup();
                overlay.remove();
                if (onCancel) {
                    onCancel();
                }
            });
    }

    const confirmBtn = confirmText != null
        ? buttonContainer.append('button')
            .attr('class', 'dialog-button confirm')
            .text(confirmText)
        : null;

    // 保存原始按钮文本，确保不依赖按钮内容
    const originalButtonText = confirmText ?? '';

    // 创建确定按钮状态更新函数（在 content 回调之前创建，避免闭包问题）
    // 使用 data 属性来存储状态，不依赖文本内容
    const setConfirmButtonState = (enabled: boolean, queuing: boolean = false) => {
        const btnNode = confirmBtn?.node() as HTMLButtonElement | null;
        if (btnNode) {
            btnNode.disabled = !enabled || queuing;
            if (queuing) {
                btnNode.setAttribute('data-state', 'queuing');
                confirmBtn!.classed('queuing', true);
                btnNode.innerHTML = `
                    <span class="queuing-text">${loadingConfirmText}</span>
                    <span class="queuing-spinner"></span>
                `;
            } else {
                btnNode.setAttribute('data-state', enabled ? 'enabled' : 'disabled');
                confirmBtn!.classed('queuing', false);
                btnNode.textContent = originalButtonText;
            }
        }
    };

    // 构建内容，传递 setConfirmButtonState 函数
    const contentControls = content(contentArea, setConfirmButtonState);

    // 设置确定按钮的点击事件（需要在 contentControls 创建之后）
    confirmBtn?.on('click', async () => {
        // 验证
        if (contentControls.validate && !contentControls.validate()) {
            return;
        }
        // 检查是否处于排队状态
        const btnNode = confirmBtn?.node() as HTMLButtonElement | null;
        if (btnNode && btnNode.getAttribute('data-state') === 'queuing') {
            return; // 排队中，不处理点击
        }
        // 获取值
        const value = contentControls.getValue ? contentControls.getValue() : undefined;
        // 注意：如果 onConfirm 中需要保持弹窗打开（如排队场景），则不应在这里关闭
        // 由 onConfirm 回调决定是否关闭弹窗
        const shouldClose = await onConfirm(value);
        // 如果 onConfirm 返回 false，表示需要保持弹窗打开（排队场景）
        if (shouldClose !== false) {
            cleanup();
            overlay.remove();
        }
    });

    // 阻止点击遮罩层关闭，只能通过按钮关闭
    // 阻止对话框内的点击事件冒泡到遮罩层
    dialog.on('click', function(event) {
        event.stopPropagation();
    });

    // ESC 键关闭（排除中文输入法组合状态）
    const escHandler = (e: KeyboardEvent) => {
        // 如果正在使用输入法组合，则忽略
        if (e.isComposing) {
            return;
        }
        if (e.key === 'Escape') {
            cleanup();
            document.removeEventListener('keydown', escHandler);
            overlay.remove();
            if (onCancel) {
                onCancel();
            }
        }
    };
    document.addEventListener('keydown', escHandler);

    // 自动聚焦
    if (contentControls.focus) {
        contentControls.focus();
    }

    // 返回弹窗控制对象，提供确定按钮状态更新功能
    return {
        setConfirmButtonState
    };
}

/**
 * 创建输入框内容构建器
 */
export function createInputContent(
    label: string,
    defaultValue: string = '',
    placeholder?: string
): DialogContentBuilder {
    return (dialog: d3.Selection<HTMLDivElement, unknown, null, undefined>, setConfirmButtonState?) => {
        const container = dialog.append('div')
            .attr('class', 'dialog-form-container');

        container.append('label')
            .attr('class', 'dialog-label')
            .text(label);

        const input = container.append('input')
            .attr('type', 'text')
            .attr('class', 'dialog-input')
            .attr('value', defaultValue)
            .attr('placeholder', placeholder || '');

        // 回车键确认（排除中文输入法组合状态）
        input.on('keydown', function(event) {
            const keyboardEvent = event as KeyboardEvent;
            // 如果正在使用输入法组合，则忽略
            if (keyboardEvent.isComposing) {
                return;
            }
            if (keyboardEvent.key === 'Enter') {
                const inputNode = input.node() as HTMLInputElement;
                const value = inputNode?.value?.trim() || '';
                if (value) {
                    const dialogElement = dialog.node()?.closest('.dialog');
                    if (dialogElement) {
                        const confirmBtn = dialogElement.querySelector('.dialog-button.confirm') as HTMLButtonElement;
                        if (confirmBtn && !confirmBtn.disabled) {
                            confirmBtn.click();
                        }
                    }
                }
            }
        });

        return {
            getValue: () => {
                const inputNode = input.node() as HTMLInputElement;
                return inputNode?.value?.trim() || '';
            },
            validate: () => {
                const inputNode = input.node() as HTMLInputElement;
                return (inputNode?.value?.trim() || '').length > 0;
            },
            focus: () => {
                const inputNode = input.node() as HTMLInputElement;
                if (inputNode) {
                    inputNode.focus();
                    inputNode.select();
                }
            }
        };
    };
}

/**
 * 创建下拉选择框内容构建器
 */
export function createSelectContent(
    label: string,
    options: Array<{ value: string; text: string }>,
    defaultValue?: string
): DialogContentBuilder {
    return (dialog: d3.Selection<HTMLDivElement, unknown, null, undefined>, setConfirmButtonState?) => {
        const container = dialog.append('div')
            .attr('class', 'dialog-form-container');

        container.append('label')
            .attr('class', 'dialog-label')
            .text(label);

        const select = container.append('select')
            .attr('class', 'dialog-select folder-select');

        // 添加选项
        select.selectAll('option')
            .data(options)
            .join('option')
            .attr('value', d => d.value)
            .text(d => d.text);

        // 设置默认值
        if (defaultValue !== undefined) {
            select.property('value', defaultValue);
        } else if (options.length > 0) {
            select.property('value', options[0].value);
        }

        return {
            getValue: () => {
                return select.property('value') || '';
            },
            validate: () => {
                return select.property('value') !== '';
            }
        };
    };
}

/**
 * 创建确认弹框内容构建器（只显示文本，不需要输入）
 */
export function createConfirmContent(message: string): DialogContentBuilder {
    return (dialog: d3.Selection<HTMLDivElement, unknown, any, any>, setConfirmButtonState?) => {
        dialog.append('div')
            .attr('class', 'dialog-message')
            .text(message);

        return {
            getValue: () => true,
            validate: () => true
        };
    };
}

/**
 * 显示确认弹框（用于删除等危险操作）
 */
export function showConfirmDialog(
    title: string,
    message: string,
    onConfirm: () => void,
    onCancel?: () => void,
    confirmText: string = tr('Confirm'),
    cancelText: string = tr('Cancel')
): void {
    showDialog({
        title,
        content: createConfirmContent(message),
        onConfirm: () => {
            onConfirm();
        },
        onCancel,
        confirmText,
        cancelText
    });
}

/**
 * 显示提示弹框（用于信息提示，只有一个确定按钮）
 */
export function showAlertDialog(
    title: string,
    message: string,
    onClose?: () => void
): void {
    showDialog({
        title,
        content: createConfirmContent(message),
        onConfirm: () => {
            if (onClose) {
                onClose();
            }
        },
        confirmText: tr('OK'),
        cancelText: undefined  // 不显示取消按钮
    });
}

/**
 * 创建组合内容构建器（输入框 + 下拉框）
 */
export function createCombinedContent(
    inputLabel: string,
    inputDefaultValue: string,
    selectLabel: string,
    selectOptions: Array<{ value: string; text: string }>,
    selectDefaultValue?: string
): DialogContentBuilder {
    return (dialog: d3.Selection<HTMLDivElement, unknown, null, undefined>, setConfirmButtonState?) => {
        // 输入框
        const inputContainer = dialog.append('div')
            .attr('class', 'dialog-form-container');

        inputContainer.append('label')
            .attr('class', 'dialog-label')
            .text(inputLabel);

        const input = inputContainer.append('input')
            .attr('type', 'text')
            .attr('class', 'dialog-input')
            .attr('value', inputDefaultValue);

        // 下拉框
        const selectContainer = dialog.append('div')
            .attr('class', 'dialog-form-container');

        selectContainer.append('label')
            .attr('class', 'dialog-label')
            .text(selectLabel);

        const select = selectContainer.append('select')
            .attr('class', 'dialog-select folder-select');

        // 添加选项
        select.selectAll('option')
            .data(selectOptions)
            .join('option')
            .attr('value', d => d.value)
            .text(d => d.text);

        // 设置默认值
        if (selectDefaultValue !== undefined) {
            select.property('value', selectDefaultValue);
        } else if (selectOptions.length > 0) {
            select.property('value', selectOptions[0].value);
        }

        // 回车键确认（排除中文输入法组合状态）
        input.on('keydown', function(event) {
            const keyboardEvent = event as KeyboardEvent;
            // 如果正在使用输入法组合，则忽略
            if (keyboardEvent.isComposing) {
                return;
            }
            if (keyboardEvent.key === 'Enter') {
                const inputNode = input.node() as HTMLInputElement;
                const value = inputNode?.value?.trim() || '';
                if (value) {
                    const dialogElement = dialog.node()?.closest('.dialog');
                    if (dialogElement) {
                        const confirmBtn = dialogElement.querySelector('.dialog-button.confirm') as HTMLButtonElement;
                        if (confirmBtn && !confirmBtn.disabled) {
                            confirmBtn.click();
                        }
                    }
                }
            }
        });

        return {
            getValue: () => {
                const inputNode = input.node() as HTMLInputElement;
                return {
                    input: inputNode?.value?.trim() || '',
                    select: select.property('value') || ''
                };
            },
            validate: () => {
                const inputNode = input.node() as HTMLInputElement;
                return (inputNode?.value?.trim() || '').length > 0;
            },
            focus: () => {
                const inputNode = input.node() as HTMLInputElement;
                if (inputNode) {
                    inputNode.focus();
                    inputNode.select();
                }
            }
        };
    };
}

/**
 * 创建“名称 + 目录 + 文本”复合内容（用于 Analyze&Save）
 */
export function createNamePathTextContent(
    inputLabel: string,
    inputDefaultValue: string,
    selectLabel: string,
    selectOptions: Array<{ value: string; text: string }>,
    selectDefaultValue: string,
    textLabel: string,
    textDefaultValue: string
): DialogContentBuilder {
    return (dialog: d3.Selection<HTMLDivElement, unknown, null, undefined>, setConfirmButtonState?) => {
        // 名称输入
        const inputContainer = dialog.append('div')
            .attr('class', 'dialog-form-container');

        inputContainer.append('label')
            .attr('class', 'dialog-label')
            .text(inputLabel);

        const input = inputContainer.append('input')
            .attr('type', 'text')
            .attr('class', 'dialog-input')
            .attr('value', inputDefaultValue);

        // 目录选择
        const selectContainer = dialog.append('div')
            .attr('class', 'dialog-form-container');

        selectContainer.append('label')
            .attr('class', 'dialog-label')
            .text(selectLabel);

        const select = selectContainer.append('select')
            .attr('class', 'dialog-select folder-select');

        select.selectAll('option')
            .data(selectOptions)
            .join('option')
            .attr('value', d => d.value)
            .text(d => d.text);

        select.property('value', selectDefaultValue || (selectOptions[0]?.value ?? '/'));

        // 文本预览/编辑
        const textContainer = dialog.append('div')
            .attr('class', 'dialog-form-container');

        // 标签和字数显示容器（同一行，左侧标签，右侧字数）
        const labelContainer = textContainer.append('div')
            .attr('class', 'dialog-label-container');

        labelContainer.append('label')
            .attr('class', 'dialog-label')
            .text(textLabel);

        // 字数显示（参照原有文本输入框的实现，放在标签右侧）
        const textCountDisplay = labelContainer.append('div')
            .attr('class', 'dialog-textarea-counter');

        const textarea = textContainer.append('textarea')
            .attr('class', 'dialog-textarea')
            .attr('rows', 6)
            .text(textDefaultValue || '');

        // 更新字数显示的函数
        const updateTextCount = () => {
            const textNode = textarea.node() as HTMLTextAreaElement;
            const textValue = textNode?.value || '';
            const charCount = countTokenCharacters(textValue);
            textCountDisplay.text(`${charCount} 字`);
        };

        // 监听textarea的input事件，实时更新字数
        textarea.on('input', updateTextCount);

        // 初始化时显示字数
        updateTextCount();

        // 回车键确认（排除中文输入法组合状态）
        input.on('keydown', function(event) {
            const keyboardEvent = event as KeyboardEvent;
            // 如果正在使用输入法组合，则忽略
            if (keyboardEvent.isComposing) {
                return;
            }
            if (keyboardEvent.key === 'Enter') {
                const inputNode = input.node() as HTMLInputElement;
                const value = inputNode?.value?.trim() || '';
                if (value) {
                    const dialogElement = dialog.node()?.closest('.dialog');
                    if (dialogElement) {
                        const confirmBtn = dialogElement.querySelector('.dialog-button.confirm') as HTMLButtonElement;
                        if (confirmBtn && !confirmBtn.disabled) {
                            confirmBtn.click();
                        }
                    }
                }
            }
        });

        return {
            getValue: () => {
                const inputNode = input.node() as HTMLInputElement;
                const textNode = textarea.node() as HTMLTextAreaElement;
                return {
                    input: inputNode?.value?.trim() || '',
                    select: select.property('value') || '',
                    text: textNode?.value ?? ''
                };
            },
            validate: () => {
                const inputNode = input.node() as HTMLInputElement;
                return (inputNode?.value?.trim() || '').length > 0;
            },
            focus: () => {
                const inputNode = input.node() as HTMLInputElement;
                if (inputNode) {
                    inputNode.focus();
                    inputNode.select();
                }
            }
        };
    };
}

/**
 * 将地址栏风格的输入转为绝对 URL：缺协议时补 `https://`；`//host/path` 先去掉协议相对前缀再补全。
 * 若无法解析则返回 null。
 */
function normalizeUserFetchUrl(raw: string): string | null {
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    try {
        new URL(trimmed);
        return trimmed;
    } catch {
        if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed)) {
            return null;
        }
        const rest = trimmed.replace(/^\/+/, '');
        if (!rest) {
            return null;
        }
        try {
            return new URL(`https://${rest}`).href;
        } catch {
            return null;
        }
    }
}

/**
 * 创建 URL 输入弹窗内容（URL 输入框）
 */
export function createUrlInputContent(
    label: string,
    defaultValue: string = '',
    placeholder?: string
): DialogContentBuilder {
    return (dialog: d3.Selection<HTMLDivElement, unknown, null, undefined>, setConfirmButtonState?) => {
        const container = dialog.append('div')
            .attr('class', 'dialog-form-container');

        container.append('label')
            .attr('class', 'dialog-label')
            .text(label);

        const input = container.append('input')
            .attr('type', 'text')
            .attr('inputmode', 'url')
            .attr('class', 'dialog-input')
            .attr('value', defaultValue)
            .attr('placeholder', placeholder || 'https://example.com');

        // 回车键确认（排除中文输入法组合状态）
        input.on('keydown', function(event) {
            const keyboardEvent = event as KeyboardEvent;
            // 如果正在使用输入法组合，则忽略
            if (keyboardEvent.isComposing) {
                return;
            }
            if (keyboardEvent.key === 'Enter') {
                const inputNode = input.node() as HTMLInputElement;
                const value = inputNode?.value?.trim() || '';
                if (value) {
                    const dialogElement = dialog.node()?.closest('.dialog');
                    if (dialogElement) {
                        const confirmBtn = dialogElement.querySelector('.dialog-button.confirm') as HTMLButtonElement;
                        if (confirmBtn && !confirmBtn.disabled) {
                            confirmBtn.click();
                        }
                    }
                }
            }
        });

        return {
            getValue: () => {
                const inputNode = input.node() as HTMLInputElement;
                const raw = inputNode?.value?.trim() || '';
                return normalizeUserFetchUrl(raw) ?? '';
            },
            validate: () => {
                const inputNode = input.node() as HTMLInputElement;
                const raw = inputNode?.value?.trim() || '';
                if (raw.length === 0) {
                    showAlertDialog(tr('Invalid input'), tr('Please enter a URL.'));
                    return false;
                }
                if (normalizeUserFetchUrl(raw)) {
                    return true;
                }
                showAlertDialog(tr('Invalid URL'), tr('This does not look like a valid URL. Check for typos.'));
                return false;
            },
            focus: () => {
                const inputNode = input.node() as HTMLInputElement;
                if (inputNode) {
                    inputNode.focus();
                    inputNode.select();
                }
            }
        };
    };
}

