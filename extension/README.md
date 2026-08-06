# InfoLens Semantic Find（可行性 demo）

Chrome MV3 扩展：对当前网页做语义检索，叠层高亮（chunk 下划线 + token 染色）。  
与 `backend/`、`client/` 同仓并列；只消费 API + 操作 DOM。

Find bar 权威源在 `extension/ui/`，站内为手工副本。挂 Shadow DOM；主题跟系统 `prefers-color-scheme`。  
正文：Readability 定根 + DOM 映回；失败即放弃。权限：`activeTab` + 手势后再注入（无 `<all_urls>`）。

---

## 开发

```bash
./extension/dev-env.sh prod   # 或 dev；生成 gitignore 的 config.js（clone 后至少一次）
```

Chrome → `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `extension/`（`dev` 为绿角标图标）。  
普通 `https` 页 → 工具栏图标或 `Ctrl+Shift+F`（Mac `⌘⇧F`）→ 输入 query → Enter。

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
| `chunkBytes` | 分块字节上限 |
| `maxChunks` | demo 最多请求块数 |
| `matchThreshold` | 计入 ↑↓ 的 match 阈值 |
| `domDebug` | `true` 只划正文范围 |
| `followSearching` | `true` 全程跟随最新 chunk |

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
vendor/Readability.js
```
