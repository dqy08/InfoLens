# Info Highlight

Chrome MV3 extension: click the toolbar icon to heatmap surprisal on the current webpage or PDF. Click again to clear.

This is a separate plugin from Semantic Highlight (`extension/semantic-highlight/`). Shared page/PDF runtime sources live in `extension/shared/`. Build assembles them into a standalone extension artifact.

Store name/description live in `_locales/`. Build merges `extension/shared/_locales/` (local file access help) into the artifact; this plugin's keys win on conflict.

Toolbar icon is a 4-row red mosaic (`icons/render-icons.py`); same RGB as the heatmap.

## Load

```bash
./extension/info-highlight/dev-env.sh prod   # 或 dev；生成 gitignore 的 config.js 并构建（clone 后至少一次）
```

Chrome → `chrome://extensions` → Developer mode → Load unpacked → select `extension/dist/info-highlight/`。
普通 http(s) 文章或 PDF → 点工具栏图标。再点清除。

本机 WebGPU 分析依赖 `@huggingface/transformers`（构建时拷进包，官方非压缩 ORT，不进 git）：

```bash
cd extension/info-highlight && npm install
```

clone 后至少要装一次，再 `dev-env.sh` / `build_extension.py`。选项里可改「自动 / 仅本机 / 仅云端」；本机模型需先在「本地模型初始化」里同意下载。仅本机失败不会改走云端。

受限页（`chrome://`、Web Store、…）无操作。无键盘快捷键。

`file:` PDF 须在扩展详情页打开 “Allow access to file URLs”。

改配置改源头，再生成（**不要手改** `config.js`）：

```bash
./extension/info-highlight/dev-env.sh prod    # apiBase=api.info-lens.app
./extension/info-highlight/dev-env.sh dev     # apiBase=*.workers.dev（不上报）
```

`dev` 与官方域名同一 Worker；`reportUsage: false`，不写 install/update/用量。
构建会把源目录的 `config.js` 拷进产物（缺失则回落 `config.prod.js`），并打印用了哪份；
`dev-env.sh` 切完会自动重新构建（浏览器加载的是产物，不构建则重载无效）。
上架构建带 `--release`，固定用 `config.prod.js`，不受本地切换状态影响。

## Test and package

```bash
npm test
./pack.sh
```

The package command builds with `--release`（固定 `config.prod.js`）, runs tests, and writes `extension/dist/info-highlight-v<version>.zip`.

上传与提交审核见 [PUBLISH.md](./PUBLISH.md)（Chrome Web Store API）。
