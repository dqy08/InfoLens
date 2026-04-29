/**
 * 构建时展开 HTML 中的 <!-- INCLUDE path/to/partial.html -->（path 相对 client/src）。
 * 由 webpack CopyWebpackPlugin 的 transform 调用；源 HTML 仅保留占位符，不写入展开结果。
 */

const fs = require('fs');
const path = require('path');

/** 含行首空白，避免占位行缩进与 partial 首行缩进叠加 */
const INCLUDE_RE = /[ \t]*<!--\s*INCLUDE\s+(\S+)\s*-->/g;

/**
 * @param {string} html
 * @param {string} srcRoot 绝对路径，一般为 client/src
 * @returns {string}
 */
function expandHtmlIncludes(html, srcRoot) {
    return html.replace(INCLUDE_RE, (_match, relPath) => {
        const full = path.resolve(srcRoot, relPath);
        if (!fs.existsSync(full)) {
            throw new Error(`includeHtmlPartials: missing file ${full} (INCLUDE ${relPath})`);
        }
        return fs.readFileSync(full, 'utf8');
    });
}

module.exports = { expandHtmlIncludes };
