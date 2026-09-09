# InfoLens Semantic Find（可行性 demo）

Chrome MV3 扩展：对当前网页做语义检索，叠层高亮（chunk 下划线 + token 染色）。
与 `backend/`、`client/` 同仓并列；只消费 API + 操作 DOM。

高亮实现：网页用 CSS Custom Highlight（绑 Range，不做 `getClientRects`）；PDF 因 canvas 字形改 overlay 几何画线（更贵，重测须克制）。详见 `semantic/find.js` 文件头。

Find bar 权威源在 `extension/semantic-highlight/ui/`，站内为手工副本。挂 Shadow DOM；主题跟系统 `prefers-color-scheme`。
正文：Readability 定根 + DOM 映回 + `extractRootPatches` 手动修补；失败即放弃。网页注入：`activeTab` + 手势后再注入。
PDF：http(s) 页内读字节；`file:` 由 SW 读 tab URL（`optional_host_permissions: file:///*`：先开「允许访问文件网址」，再点图标时静默 `permissions.request`——Chrome 对 `file://` 不弹系统窗；无宽 http(s)）→ IndexedDB → 查看器。
暂存保留约 7 天；多份合计软上限 100MB（只剩 1 份时可更大），超限删最旧。

---

## 开发

```bash
./extension/semantic-highlight/dev-env.sh prod   # 或 dev；生成 gitignore 的 config.js 并构建（clone 后至少一次）
```

Chrome → `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `extension/dist/semantic-highlight/`。
普通 `https` 页 → 工具栏图标、右键「Search with Semantic Highlight」、或 `Ctrl+Shift+F`（Mac `⌘⇧F`）→ 输入 query → Enter。
有选区时右键会预填选区文字，不自动搜索。

测试入口见 [TESTING.md](./TESTING.md)。

改配置改源头，再生成（**不要手改** `config.js`）：

```bash
./extension/semantic-highlight/dev-env.sh prod    # apiBase=api.info-lens.app
./extension/semantic-highlight/dev-env.sh dev     # apiBase=*.workers.dev
```

构建会把源目录的 `config.js` 拷进产物（缺失则回落 `config.prod.js`），并打印用了哪份；
`dev-env.sh` 切完会自动重新构建（浏览器加载的是产物，不构建则重载无效）。
上架构建带 `--release`，固定用 `config.prod.js`，不受本地切换状态影响。

改动共享代码或插件源码后执行 `python3 extension/scripts/build_extension.py semantic-highlight`，再重新加载扩展。浮条改 `extension/semantic-highlight/ui/`。

### 上架

```bash
./extension/semantic-highlight/pack.sh
```

构建先将共享源与插件源码装配到 `extension/dist/semantic-highlight/`，再从该目录打 ZIP；构建产物都在 `extension/dist/`（gitignore）。

上传与提交审核见 [PUBLISH.md](./PUBLISH.md)（Chrome Web Store API）。

### 配置字段

| 字段 | 含义 |
|------|------|
| `apiBase` | API 根；prod / dev 由 `dev-env.sh` 切换 |
| `matchThreshold` | 计入 ↑↓ 的 match 阈值 |
| `domDebug` | `true` 只划正文范围 |

### PDF viewer

扩展页用 pdfjs-dist 打开 PDF，渲染全部页（canvas + text layer），拼接全文供语义搜索。  
入口：在 PDF 页点扩展图标 →「Open with InfoLens PDF viewer」→ 页内读入字节写入 IndexedDB 后打开
`chrome-extension://<扩展ID>/pdf/viewer.html?id=<stash>`（同 id 刷新可再读；逾 7 天或超 100MB 多份清理后需重开）。

- 支持原页为 `http(s)` 或 `file:`。http(s) 由页内 fetch 后把字节交给 SW（避免为任意站点申请 host_permissions）；
  `file:`：未开「允许访问文件网址」时打开 `pdf/file-access.html` 只引导开开关；
  开完后再点工具栏图标，手势里静默 `permissions.request(file:///*)`（无系统窗，同意态持久），然后 SW `fetch`。
  unpacked 开关常默认已开，首次点图标即可 request。
- 工具栏图标 / 快捷键 / 右键「Search with…」同一套 `activateTab`：Chrome PDF 宿主页 → 入口按钮；
  自家 viewer 与普通网页 → 始终 `open` 浮条（有选区则预填，不自动搜；关闭靠 × / Esc）。
- 多页 ≈ 网页往下滚：全文进入同一套 32-chunk 搜索窗口；浮条 / 高亮与网页共用 `semantic/find.js`。
- 浏览能力（分析载体，非完备阅读器）：对齐 Chrome 内置 PDF——默认 Automatic Zoom
 （fit-width 且不超过 100%）、预设档 ±（含 Ctrl/⌘+滚轮）、Fit 单按钮在 page/width 间切换、全屏；
  页码只读显示。图标取自 Chromium PDF viewer Material Symbols。
- 资源在 `vendor/pdfjs/`（pdfjs-dist **3.11.174** legacy 官方非压缩 UMD：`pdf.js` + `pdf.worker.js` + LICENSE），pack 打成包内文件。  
  **不要**换成 `*.min.js`、不要 beautify 压缩文件、不要从 CDN 远程加载——Chrome Web Store 会把压缩/混淆 JS 判为违规（Red Titanium）。

### 排查：`Frame with ID 0 was removed`

受限页 / 未加载完 / 标签休眠。换普通文章页 → 加载完 → 重载扩展 → 再点图标。

---

## 目录要点

本插件独有的源码（`extension/semantic-highlight/`）：

```text
manifest.json
icons/icon*.png
pack.sh / dev-env.sh / PUBLISH.md
config.prod.js         # 上架默认 / 官方域名（源头）；--release 打进包
config.dev.js          # Dev 门面 *.workers.dev（源头）
config.js              # gitignore；dev-env 生成
_locales/              # 本插件独有文案（名称/描述/右键菜单/设置页）
ui/                    # Find bar 权威源
semantic/              # DocumentAdapter + semantic find（page/pdf + find.js）
pdf/viewer.html        # 查看器页面骨架（脚本清单是本插件的）
pdf/search.js          # 在查看器里驱动 semantic find
```

与 Info Highlight 共用、构建时装配进来的源码（`extension/shared/`）：

```text
page/articleRoot.js         # Readability 定根
page/extractRootPatches.js  # 定根后的手动修补管线（可追加）
page/collectTextMap.js      # DOM → 文本映射
page/splitTextToChunks.js   # SYNC ← client
pdf/                        # 宿主页入口、暂存、viewer 渲染、file-access 引导
_locales/                   # 上面这些共享页面的文案；构建时与插件自己的 _locales 合并（插件同名 key 优先）
vendor/Readability.js
vendor/pdfjs/               # pdfjs-dist 3.11.174 legacy 官方非压缩（pdf.js + pdf.worker.js + LICENSE）
```

共享层的名字统一用 `IL_` / `il-` 前缀，Info Highlight 自己的代码用 `IH_` / `ih-`；
注入宿主页的高亮类名两边必须错开（同一个页面里会同时存在），扩展自己页面里的 id 不必。
