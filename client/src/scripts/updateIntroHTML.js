/**
 * 构建时脚本：从JSON生成带颜色的HTML
 */

const fs = require('fs');
const path = require('path');

// 文件路径配置
const paths = {
    en: {
        json: path.resolve(__dirname, '../../../data/demo/public/InfoHighlight-intro.json'),
        html: path.resolve(__dirname, '../assets/content/home.en.html')
    },
    zh: {
        json: path.resolve(__dirname, '../../../data/demo/public/CN/InfoHighlight-介绍.json'),
        html: path.resolve(__dirname, '../assets/content/home.zh.html')
    }
};

// ==========================================
// 颜色计算逻辑（从 SurprisalColorConfig.ts 复制）
// ==========================================

const TOKEN_SURPRISAL_MAX = 18;

/**
 * 计算 surprisal（信息量）
 */
function calculateSurprisal(probability) {
    return -Math.log2(Math.max(probability, Number.EPSILON));
}

/** RGB 部分，通过 CSS 变量复用 */
const INTRO_RGB = '255, 71, 64';

/** alpha 小数位数 */
const ALPHA_PRECISION = 2;

/**
 * 根据 surprisal 计算 alpha（0–0.7），保留指定位数
 */
function getTokenAlpha(surprisal) {
    const normalizedValue = surprisal < 0 ? 0 :
                           surprisal >= TOKEN_SURPRISAL_MAX ? 1 :
                           surprisal / TOKEN_SURPRISAL_MAX;
    const alpha = Math.max(0, Math.min(1, normalizedValue)) * 0.7;
    return alpha.toFixed(ALPHA_PRECISION);
}

// ==========================================
// HTML 生成逻辑
// ==========================================

/**
 * 转义HTML特殊字符
 */
function escapeHtml(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/**
 * 从JSON生成带颜色的HTML（使用 CSS 变量 --intro-rgb，span 仅写 alpha）
 */
function generateColoredHTML(jsonPath) {
    try {
        const content = fs.readFileSync(jsonPath, 'utf-8');
        const data = JSON.parse(content);

        let html = '';
        for (const token of data.result.bpe_strings) {
            const text = token.raw;
            const prob = token.real_topk[1];
            const surprisal = calculateSurprisal(prob);
            const alpha = getTokenAlpha(surprisal);

            const escapedText = escapeHtml(text);

            if (text.includes('\n')) {
                const parts = text.split(/(\n)/);
                for (const part of parts) {
                    if (part === '\n') {
                        html += '<br>';
                    } else if (part) {
                        html += `<span class="intro-token" style="--a:${alpha}">${escapeHtml(part)}</span>`;
                    }
                }
            } else {
                html += `<span class="intro-token" style="--a:${alpha}">${escapedText}</span>`;
            }
        }

        return html;
    } catch (error) {
        console.error(`Failed to generate HTML from JSON: ${jsonPath}`, error);
        return null;
    }
}

/**
 * 计算替换后的 HTML；若与原文一致则无需写入。
 * @returns {{ ok: true, changed: boolean, nextHtml: string } | { ok: false }}
 */
function buildIntroHtml(htmlPath, coloredHTML) {
    try {
        const original = fs.readFileSync(htmlPath, 'utf-8');

        // 匹配 <div class="intro-brief" ...> 到 </div> 之间的内容
        const regex = /(<div class="intro-brief"[^>]*>)([\s\S]*?)(<\/div>)/;

        if (!regex.test(original)) {
            console.error(`intro-brief not found in ${htmlPath}`);
            return { ok: false };
        }

        // 替换为带颜色的HTML，容器上定义 CSS 变量供 span 复用
        const replacement = `<div class="intro-brief" style="--intro-rgb: ${INTRO_RGB}">\n    ${coloredHTML}\n</div>`;
        const nextHtml = original.replace(regex, replacement);
        const changed = nextHtml !== original;

        return { ok: true, changed, nextHtml };
    } catch (error) {
        console.error(`Failed to read/update HTML file: ${htmlPath}`, error);
        return { ok: false };
    }
}

/**
 * 主函数
 */
function main() {
    const enHTML = generateColoredHTML(paths.en.json);
    if (!enHTML) {
        console.error('\n✗ Some generation failed');
        process.exit(1);
    }

    const en = buildIntroHtml(paths.en.html, enHTML);
    if (!en.ok) {
        console.error('\n✗ Some generation failed');
        process.exit(1);
    }

    const zhHTML = generateColoredHTML(paths.zh.json);
    if (!zhHTML) {
        console.error('\n✗ Some generation failed');
        process.exit(1);
    }

    const zh = buildIntroHtml(paths.zh.html, zhHTML);
    if (!zh.ok) {
        console.error('\n✗ Some generation failed');
        process.exit(1);
    }

    if (!en.changed && !zh.changed) {
        return;
    }

    console.log('Generating colored intro HTML from JSON...\n');

    if (en.changed) {
        fs.writeFileSync(paths.en.html, en.nextHtml, 'utf-8');
        console.log(`✓ Updated ${path.basename(paths.en.html)}`);
    }
    if (zh.changed) {
        fs.writeFileSync(paths.zh.html, zh.nextHtml, 'utf-8');
        console.log(`✓ Updated ${path.basename(paths.zh.html)}`);
    }

    console.log('\n✓ All intro HTML files generated successfully');
}

// 执行
main();
