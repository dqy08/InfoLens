/**
 * 构建时向 HTML <head> 注入 inforadar-api-base meta（仅当 INFORADAR_API_BASE 已设置）。
 * GitHub Pages：`INFORADAR_API_BASE=https://dqy08-infolens-worker1.hf.space npm run build`
 * HF / 本地：不设该变量 → 无 meta → 运行时 resolveApiBase() 为同源 ''。
 */

const { escapeHtmlText } = require('./injectPageMetaIntoHtml.js');

const META_NAME = 'inforadar-api-base';

/**
 * @param {string} html
 * @returns {string}
 */
function injectApiBaseMeta(html) {
    const raw = process.env.INFORADAR_API_BASE?.trim();
    if (!raw) return html;
    const content = escapeHtmlText(raw.replace(/\/+$/, ''));
    if (html.includes(`name="${META_NAME}"`)) return html;
    const tag = `<meta name="${META_NAME}" content="${content}">`;
    if (/<meta\s+charset/i.test(html)) {
        return html.replace(/(<meta\s+charset[^>]*>)/i, `$1\n    ${tag}`);
    }
    return html.replace(/<head>/i, `<head>\n    ${tag}`);
}

module.exports = { injectApiBaseMeta };
