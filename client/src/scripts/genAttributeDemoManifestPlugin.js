/**
 * 构建时扫描 `demos/gen_attribute/*.json`（源目录），在产物中生成 `demos/gen_attribute/manifest.json`（仅列 slug），供运行时用 fetch 拉列表。
 * 不随 JS bundle 内联大 JSON。
 */
const path = require('path');
const fs = require('fs');
const webpack = require('webpack');

const REL_DIR = 'demos/gen_attribute';

class GenAttributeDemoManifestPlugin {
    apply(compiler) {
        const srcDir = path.join(__dirname, '..', REL_DIR);
        compiler.hooks.thisCompilation.tap('GenAttributeDemoManifestPlugin', (compilation) => {
            compilation.hooks.processAssets.tap(
                {
                    name: 'GenAttributeDemoManifestPlugin',
                    stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONS,
                },
                () => {
                    let slugs = [];
                    if (fs.existsSync(srcDir)) {
                        const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.json'));
                        slugs = files
                            .map((f) => f.replace(/\.json$/i, ''))
                            .filter((s) => s.length > 0);
                        slugs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
                    }
                    const json = JSON.stringify({ slugs });
                    compilation.emitAsset(
                        path.posix.join(REL_DIR, 'manifest.json'),
                        new webpack.sources.RawSource(json)
                    );
                }
            );
        });
    }
}

module.exports = { GenAttributeDemoManifestPlugin };
