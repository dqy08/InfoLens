/**
 * 构建时根据 content/page-meta.json 向 HTML 写入英文标题、副标题、浏览器标题与导航锚文本，
 * 便于爬虫与不执行 JS 的环境读取。页内可见文案带 data-i18n，运行时由 initI18n 按英文 key 翻译；
 * 浏览器标题在构建时由本脚本写入：主标题与副标题与 page-meta 一致；副标题若以 “-” 开头（工具页 tagline）则与标题之间只加一个空格；否则中间加 “ - ”（如首页主副标题）。
 * 中文环境由 <title data-i18n> 在 initI18n 翻译整串 key。
 */

/**
 * @param {string} s
 * @returns {string}
 */
function escapeHtmlText(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/**
 * 浏览器标题与链接 title：title 与 subtitle 拼接（仅 trim 首尾空白）。
 * 副标题已以 “-” 开头时不额外插入横线，避免 “Title - - tagline”；否则插入 “ - ”。
 *
 * @param {{ title: string, subtitle: string }} meta
 */
function documentTitleEn(meta) {
    const title = String(meta.title ?? '').trim();
    const subtitle = String(meta.subtitle ?? '').trim();
    if (!title) return subtitle;
    if (!subtitle) return title;
    const joiner = subtitle.startsWith('-') ? ' ' : ' - ';
    return title + joiner + subtitle;
}

/**
 * 将带 `data-page-*` 的成对标签内容替换为纯文本（英文，已转义）。
 * @param {string} html
 * @param {string} attrToken 如 data-page-title
 * @param {string} text
 */
function injectDataPageBlock(html, attrToken, text) {
    const esc = escapeHtmlText(text);
    const re = new RegExp(
        `<([a-z][a-z0-9]*)([^>]*\\b${attrToken}\\b[^>]*)>([\\s\\S]*?)<\\/\\1>`,
        'gi'
    );
    return html.replace(re, (_m, tag, attrs) => `<${tag}${attrs}>${esc}</${tag}>`);
}

/**
 * @param {string} html
 * @param {string} pageKey
 * @param {{ pages: Record<string, { title: string, subtitle: string, href?: string, heartline?: string, formula?: string }>, navPageKeys: string[] }} doc
 * @returns {string}
 */
function injectPageMeta(html, pageKey, doc) {
    const meta = doc.pages[pageKey];
    if (!meta) {
        throw new Error(`injectPageMeta: unknown pageKey "${pageKey}"`);
    }

    const dt = documentTitleEn(meta);
    html = html.replace(/<title[^>]*>[^<]*<\/title>/i, `<title data-i18n>${escapeHtmlText(dt)}</title>`);

    html = injectDataPageBlock(html, 'data-page-title', meta.title);
    html = injectDataPageBlock(html, 'data-page-subtitle', meta.subtitle);

    const heartlineElRe = /<([a-z][a-z0-9]*)([^>]*\bdata-page-heartline\b[^>]*)>([\s\S]*?)<\/\1>/gi;
    if (meta.heartline) {
        html = html.replace(heartlineElRe, (_m, tag, attrs) => `<${tag}${attrs}>${escapeHtmlText(meta.heartline)}</${tag}>`);
    } else {
        html = html.replace(heartlineElRe, '');
    }

    const formulaElRe = /<([a-z][a-z0-9]*)([^>]*\bdata-page-formula\b[^>]*)>([\s\S]*?)<\/\1>/gi;
    if (meta.formula) {
        html = html.replace(formulaElRe, (_m, tag, attrs) => `<${tag}${attrs}>${escapeHtmlText(meta.formula)}</${tag}>`);
    } else {
        html = html.replace(formulaElRe, '');
    }

    if (pageKey === 'home' && Array.isArray(doc.navPageKeys)) {
        for (const navKey of doc.navPageKeys) {
            const navMeta = doc.pages[navKey];
            if (!navMeta) {
                throw new Error(`injectPageMeta: navPageKeys references missing page "${navKey}"`);
            }
            const navTitle = documentTitleEn(navMeta);
            const re = new RegExp(
                `(<a\\b[^>]*\\bdata-nav-page=["']?${navKey}["']?[^>]*>)([\\s\\S]*?)(<\\/a>)`,
                'i'
            );
            const m = html.match(re);
            if (!m) {
                throw new Error(`injectPageMeta: missing <a data-nav-page="${navKey}"> in home HTML`);
            }
            let openTag = m[1];
            if (navMeta.href) {
                if (/\bhref\s*=/.test(openTag)) {
                    openTag = openTag.replace(
                        /\bhref\s*=\s*("[^"]*"|'[^']*')/i,
                        `href="${escapeHtmlText(navMeta.href)}"`
                    );
                } else {
                    openTag = openTag.replace(/>$/, ` href="${escapeHtmlText(navMeta.href)}">`);
                }
            }
            if (/\btitle\s*=/.test(openTag)) {
                openTag = openTag.replace(/\btitle\s*=\s*("[^"]*"|'[^']*')/i, `title="${escapeHtmlText(navTitle)}"`);
            } else {
                openTag = openTag.replace(/>$/, ` title="${escapeHtmlText(navTitle)}">`);
            }
            const shot =
                navKey === 'genAttribute'
                    ? `<video class="nav-landing-card-shot" muted loop playsinline autoplay preload="metadata" aria-hidden="true"></video>`
                    : `<div class="nav-landing-card-shot" aria-hidden="true"></div>`;
            const inner =
                `<div class="nav-landing-card-text">` +
                `<span class="nav-landing-card-title" data-i18n>${escapeHtmlText(navMeta.title)}</span>` +
                `<span class="nav-landing-card-subtitle" data-i18n>${escapeHtmlText(navMeta.subtitle)}</span>` +
                `</div>` +
                shot;
            html = html.replace(re, `${openTag}${inner}${m[3]}`);
        }
    }

    return html;
}

module.exports = { injectPageMeta, escapeHtmlText, documentTitleEn };
