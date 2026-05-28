/**
 * 构建前扫描 `assets/demos/causal_flow/*.json`，写入 `features/causal_flow/genAttributeBundledDemoManifest.generated.ts`，供 bundle 内联 demo 列表。
 * 顺序与 UI 名：`order.json` 数组；项为 slug 字符串或 `{ slug, label?, featured? }`（无 label 则 UI 显示 slug；`featured: "bold"` 等样式见 VALID_ORDER_FEATURED）。
 * 目录内存在但尚未列入 order 的 demo 会在构建时自动追加到 order.json 末尾（`slug` 与 `label` 均为文件名 stem，便于人工改 label）。
 * 若 order.json 不存在则按 UTF-16 码元序生成完整列表。manifest 生成时若仍有遗漏则按 UTF-16 追加。
 * order 中的 slug 必须对应目录内已有 demo JSON；重复 slug 亦会在构建时报错。
 */
const path = require('path');
const fs = require('fs');

const REL_DIR = 'assets/demos/causal_flow';
const GENERATED_BASENAME = 'genAttributeBundledDemoManifest.generated.ts';
const ORDER_FILENAME = 'order.json';
const VALID_ORDER_FEATURED = new Set(['bold']);

function utf16Sort(slugs) {
    return [...slugs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function discoverSlugs(srcDir) {
    if (!fs.existsSync(srcDir)) return [];
    return fs
        .readdirSync(srcDir)
        .filter((f) => f.endsWith('.json') && f !== ORDER_FILENAME)
        .map((f) => f.replace(/\.json$/i, ''))
        .filter((s) => s.length > 0);
}

/** @returns {{ slug: string, label: string | null, featured?: string } | null} */
function parseOrderEntry(entry, index) {
    const at = `${ORDER_FILENAME}[${index}]`;
    if (typeof entry === 'string') {
        const slug = entry.trim();
        return slug ? { slug, label: null } : null;
    }
    if (entry && typeof entry === 'object' && typeof entry.slug === 'string') {
        const slug = entry.slug.trim();
        if (!slug) return null;
        const label =
            typeof entry.label === 'string' && entry.label.trim().length > 0
                ? entry.label.trim()
                : null;
        let featured;
        if (entry.featured != null) {
            if (typeof entry.featured !== 'string' || !VALID_ORDER_FEATURED.has(entry.featured)) {
                throw new Error(
                    `${at}: unknown featured ${JSON.stringify(entry.featured)} (supported: ${[...VALID_ORDER_FEATURED].join(', ')})`,
                );
            }
            featured = entry.featured;
        }
        return featured ? { slug, label, featured } : { slug, label };
    }
    throw new Error(
        `${at}: expected a slug string or { "slug": "...", "label"?: "...", "featured"?: "bold" }`
    );
}

function readOrderEntries(srcDir) {
    const orderPath = path.join(srcDir, ORDER_FILENAME);
    if (!fs.existsSync(orderPath)) return null;
    let raw;
    try {
        raw = JSON.parse(fs.readFileSync(orderPath, 'utf8'));
    } catch (e) {
        throw new Error(`${ORDER_FILENAME}: invalid JSON (${e.message})`);
    }
    if (!Array.isArray(raw)) {
        throw new Error(`${ORDER_FILENAME}: expected a JSON array`);
    }
    return raw.map((entry, i) => parseOrderEntry(entry, i)).filter(Boolean);
}

function resolveLabel(slug, label) {
    return label ?? slug;
}

/** @param {{ slug: string, label: string | null, featured?: string }[]} entries */
function serializeOrderFile(entries) {
    const body = entries.map(({ slug, label, featured }) => {
        const row = { slug, label: resolveLabel(slug, label) };
        if (featured) row.featured = featured;
        return row;
    });
    return `${JSON.stringify(body, null, 2)}\n`;
}

/** 将新发现的 demo 追加到 order.json 末尾；无 order 文件时生成完整列表。 */
function syncOrderJson(srcDir) {
    const discovered = discoverSlugs(srcDir);
    if (discovered.length === 0) return;

    const orderPath = path.join(srcDir, ORDER_FILENAME);
    let orderEntries = readOrderEntries(srcDir);
    const seen = new Set((orderEntries ?? []).map((e) => e.slug));
    const missing = utf16Sort(discovered.filter((s) => !seen.has(s)));
    if (missing.length === 0) return;

    if (orderEntries == null) {
        orderEntries = utf16Sort(discovered).map((slug) => ({ slug, label: slug }));
    } else {
        for (const slug of missing) {
            orderEntries.push({ slug, label: slug });
        }
    }

    const next = serializeOrderFile(orderEntries);
    if (fs.existsSync(orderPath) && fs.readFileSync(orderPath, 'utf8') === next) return;
    fs.writeFileSync(orderPath, next, 'utf8');
}

function collectDemoEntries(srcDir) {
    const discovered = new Set(discoverSlugs(srcDir));
    const order = readOrderEntries(srcDir);
    if (order == null) {
        return utf16Sort([...discovered]).map((slug) => ({
            slug,
            label: slug,
        }));
    }
    const seen = new Set();
    const result = [];
    for (const { slug, label, featured } of order) {
        if (seen.has(slug)) {
            throw new Error(`${ORDER_FILENAME}: duplicate slug ${JSON.stringify(slug)}`);
        }
        if (!discovered.has(slug)) {
            throw new Error(
                `${ORDER_FILENAME}: unknown slug ${JSON.stringify(slug)} (no ${slug}.json under ${REL_DIR})`,
            );
        }
        seen.add(slug);
        const row = { slug, label: resolveLabel(slug, label) };
        if (featured) row.featured = featured;
        result.push(row);
    }
    for (const slug of utf16Sort([...discovered].filter((s) => !seen.has(s)))) {
        result.push({ slug, label: slug });
    }
    return result;
}

function writeGeneratedModule(srcDir, outPath) {
    syncOrderJson(srcDir);
    const entries = collectDemoEntries(srcDir);
    const content =
        '/**\n' +
        ' * Generated by GenAttributeDemoManifestPlugin — do not edit.\n' +
        ' */\n' +
        'export type GenAttributeBundledDemoFeaturedStyle = \'bold\';\n' +
        'export type GenAttributeBundledDemoManifestEntry = { readonly slug: string; readonly label: string; readonly featured?: GenAttributeBundledDemoFeaturedStyle };\n' +
        `export const GEN_ATTRIBUTE_BUNDLED_DEMOS: readonly GenAttributeBundledDemoManifestEntry[] = ${JSON.stringify(entries)};\n`;
    if (fs.existsSync(outPath) && fs.readFileSync(outPath, 'utf8') === content) return;
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, content, 'utf8');
}

class GenAttributeDemoManifestPlugin {
    apply(compiler) {
        const srcDir = path.join(__dirname, '..', REL_DIR);
        const outPath = path.join(__dirname, '..', 'features', 'causal_flow', GENERATED_BASENAME);

        compiler.hooks.beforeCompile.tapAsync('GenAttributeDemoManifestPlugin', (_params, callback) => {
            try {
                writeGeneratedModule(srcDir, outPath);
                callback();
            } catch (e) {
                callback(e);
            }
        });

        compiler.hooks.thisCompilation.tap('GenAttributeDemoManifestPlugin', (compilation) => {
            compilation.contextDependencies.add(srcDir);
        });
    }
}

module.exports = {
    GenAttributeDemoManifestPlugin,
    syncOrderJson,
    collectDemoEntries,
    discoverSlugs,
    ORDER_FILENAME,
    REL_DIR,
};
