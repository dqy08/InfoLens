# InfoLens Semantic Find（可行性 demo）

Chrome MV3 扩展：对当前网页做语义检索，叠层高亮（chunk 下划线 + token 染色）。  
与 `backend/`、`client/` 同仓并列；只消费 API + 操作 DOM。

Find bar 权威源在 `extension/ui/`，站内为手工副本。挂 Shadow DOM；主题跟系统 `prefers-color-scheme`。  
正文：Readability 定根 + DOM 映回；失败即放弃。网页注入：`activeTab` + 手势后再注入。  
PDF：http(s) 页内读字节；`file:` 由 SW 读 tab URL（`optional_host_permissions: file:///*`：先开「允许访问文件网址」，再点图标时静默 `permissions.request`——Chrome 对 `file://` 不弹系统窗；无宽 http(s)）→ IndexedDB → 查看器。
暂存保留约 7 天；多份合计软上限 100MB（只剩 1 份时可更大），超限删最旧。

---

## 开发

```bash
./extension/dev-env.sh prod   # 或 dev；生成 gitignore 的 config.js（clone 后至少一次）
```

Chrome → `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `extension/`（`dev` 为绿角标图标）。  
普通 `https` 页 → 工具栏图标、右键「Search with Semantic Highlight」、或 `Ctrl+Shift+F`（Mac `⌘⇧F`）→ 输入 query → Enter。
有选区时右键会预填选区文字，不自动搜索。

改配置改源头，再生成（**不要手改** `config.js`；图标路径会改 `manifest.json`，提交前请切回 `dev`）：

```bash
./extension/dev-env.sh prod    # apiBase=api.info-lens.app + 正式图标
./extension/dev-env.sh dev     # apiBase=*.workers.dev + icons/dev/
```

改完扩展页「重新加载」。浮条改 `extension/ui/`，需站内一致再手工同步 client。

### 上架

```bash
./extension/pack.sh
```

临时目录打 zip（正式图标 + `config.prod.js` → 包内 `config.js`），不改工作树。产出在 `extension/dist/`（gitignore）。

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
- 资源在 `vendor/pdfjs/`（pdfjs-dist 3.11.174 legacy UMD + LICENSE），pack 打成包内文件。

### 排查：`Frame with ID 0 was removed`

受限页 / 未加载完 / 标签休眠。换普通文章页 → 加载完 → 重载扩展 → 再点图标。

---

## 目录要点

```text
manifest.json          # unpacked；图标由 dev-env 在 icons/dev/ ↔ icons/ 间切换
icons/icon*.png        # 正式图标（prod / 上架）
icons/dev/icon*.png    # unpack 开发图标
pack.sh / dev-env.sh / PUBLISH.md
config.prod.js         # 上架默认 / 官方域名（源头）；pack 打进包
config.dev.js          # Dev 门面 *.workers.dev（源头）
config.js              # gitignore；dev-env 生成
ui/                    # Find bar 权威源
articleRoot.js         # Readability 定根
splitTextToChunks.js   # SYNC ← client
semantic/              # DocumentAdapter + 共享 semantic find（page/pdf + find.js）
vendor/Readability.js
pdf/                   # PDF：宿主页入口、暂存、viewer、file-access 引导
vendor/pdfjs/          # pdfjs-dist 3.11.174 legacy（pdf.min.js + worker + LICENSE）
```
