/**
 * Token 文本显示工具：特殊字符可视化、HTML 转义
 * 与 Tooltip、TopK 图表等共享
 */

function escapeHtmlImpl(text: string): string {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function isWhitespaceChar(char: string): boolean {
    return /\p{White_Space}/u.test(char);
}

function isPrintableChar(char: string): boolean {
    if (isWhitespaceChar(char)) return false;
    const codePoint = char.codePointAt(0);
    if (codePoint === undefined) return false;
    if (codePoint >= 32 && codePoint <= 126) return true;
    if (
        (codePoint >= 0x00A0 && codePoint <= 0x00FF) ||
        (codePoint >= 0x0100 && codePoint <= 0x017F) ||
        (codePoint >= 0x0180 && codePoint <= 0x024F) ||
        (codePoint >= 0x2000 && codePoint <= 0x206F) ||
        (codePoint >= 0x2070 && codePoint <= 0x209F) ||
        (codePoint >= 0x20A0 && codePoint <= 0x20CF) ||
        (codePoint >= 0x2100 && codePoint <= 0x214F) ||
        (codePoint >= 0x2190 && codePoint <= 0x21FF) ||
        (codePoint >= 0x2200 && codePoint <= 0x22FF) ||
        (codePoint >= 0x2300 && codePoint <= 0x23FF) ||
        (codePoint >= 0x2400 && codePoint <= 0x243F) ||
        (codePoint >= 0x2E00 && codePoint <= 0x2E7F) ||
        (codePoint >= 0x3000 && codePoint <= 0x303F) ||
        (codePoint >= 0x3040 && codePoint <= 0x309F) ||
        (codePoint >= 0x30A0 && codePoint <= 0x30FF) ||
        (codePoint >= 0x4E00 && codePoint <= 0x9FFF) ||
        (codePoint >= 0xAC00 && codePoint <= 0xD7AF) ||
        (codePoint >= 0xF900 && codePoint <= 0xFAFF) ||
        (codePoint >= 0xFF00 && codePoint <= 0xFFEF)
    ) return true;
    return false;
}

/** {@link visualizeSpecialChars} 可选行为 */
export type VisualizeSpecialCharsOptions = {
    /**
     * 为 true（如 DAG 节点标签）：仅当 ASCII 空格**后面不是** `[A-Za-z0-9]` 时改为 ·；
     * 空格后是 ASCII 字母或数字时保留空格（便于 SVG 显示词界）。
     * 省略或 false：每个 ASCII 空格都变为 ·（与 Tooltip / 候选词等一致）。
     */
    spaceDotExceptBeforeAsciiLetterOrNumber?: boolean;
    /**
     * 为 true（如 DAG 节点 SVG 标签）：不可打印码点显示为 `[]` 而非 `[hex]`。
     * Tooltip 等需辨认码点的场景勿开启。
     */
    omitHexInCodePointLabel?: boolean;
};

function visualizeSpecialCharsImpl(text: string, options?: VisualizeSpecialCharsOptions): string {
    let result = text
        .replace(/\r\n/g, '[CRLF]')
        .replace(/\n/g, '[LF]')
        .replace(/\r/g, '[CR]')
        .replace(/\t/g, '[TAB]')
        .replace(/\u3000/g, '[FS]');
    if (options?.spaceDotExceptBeforeAsciiLetterOrNumber === true) {
        // 须写成 (?![…])，勿写成 (?!=[…])：后者会解析成「否定先行 + 字面量 = + 字符类」，几乎总匹配，导致所有空格都变 ·。
        result = result.replace(/ (?![A-Za-z0-9])/g, '·');
    } else {
        result = result.replace(/ /g, '·');
    }

    const processed: string[] = [];
    let inBracket = false;

    for (let i = 0; i < result.length; i++) {
        const char = result[i];
        if (char === '[') {
            inBracket = true;
            processed.push(char);
        } else if (char === ']' && inBracket) {
            processed.push(char);
            inBracket = false;
        } else if (inBracket) {
            processed.push(char);
        } else {
            // 保留的空格不能走下方「不可打印 → 码点」分支，否则会变成 [0020]
            if (char === ' ') {
                processed.push(char);
            } else if (isPrintableChar(char)) {
                processed.push(char);
            } else {
                const codePoint = char.codePointAt(0);
                if (codePoint !== undefined) {
                    processed.push(options?.omitHexInCodePointLabel === true ? '[]' : `[${codePoint.toString(16).toLowerCase().padStart(4, '0')}]`);
                } else {
                    processed.push(char);
                }
            }
        }
    }
    return processed.join('');
}

/** 处理候选词文本，与主 token 保持一致：先可视化特殊字符，再 HTML 转义 */
export function processCandidateText(text: string): string {
    return escapeHtmlImpl(visualizeSpecialCharsImpl(text));
}

/**
 * Tooltip 内展示的当前 token 与合并子片段共用：与 {@link processCandidateText} 同一管线，
 * 保证与主栏「当前 token」行渲染一致。
 */
export function tooltipTokenDisplayHtml(text: string): string {
    return processCandidateText(text);
}

/** HTML 转义 */
export function escapeHtml(text: string): string {
    return escapeHtmlImpl(text);
}

/** 可视化特殊字符 */
export function visualizeSpecialChars(text: string, options?: VisualizeSpecialCharsOptions): string {
    return visualizeSpecialCharsImpl(text, options);
}
