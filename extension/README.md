# InfoLens Semantic Find（可行性 demo）

Chrome MV3 扩展：对当前网页做语义检索，叠层高亮（chunk 下划线 + token 染色）。  
与 `backend/`、`client/` 同仓并列；只消费 API + 操作 DOM。

Find bar 权威源在 `extension/ui/`，站内为手工副本。挂 Shadow DOM；主题跟系统 `prefers-color-scheme`。  
正文：Readability 定根 + DOM 映回；失败即放弃。权限：`activeTab` + 手势后再注入（无 `<all_urls>`）。

---

## 开发

```bash
./extension/dev-env.sh prod   # 或 local；生成 gitignore 的 config.js（clone 后至少一次）
```

Chrome → `chrome://extensions` → 开发者模式 → 加载已解压 → 选 `extension/`（绿角标 = dev 版）。  
普通 `https` 页 → 工具栏图标或 `Ctrl+Shift+F`（Mac `⌘⇧F`）→ 输入 query → Enter。

改配置改源头，再生成（**不要手改** `config.js`）：

```bash
./extension/dev-env.sh local   # apiBase=127.0.0.1:5001（需本地后端，且未传 --no_cors）
./extension/dev-env.sh prod    # apiBase=HF Spaces
```

改完扩展页「重新加载」。浮条改 `extension/ui/`，需站内一致再手工同步 client。

### 上架

```bash
./extension/pack.sh
```

临时目录打 zip（正式图标 + `config.prod.js` → 包内 `config.js`），不改工作树。产出在 `extension/dist/`（gitignore）。

### 配置字段

| 字段 | 含义 |
|------|------|
| `apiBase` | API 根；local / prod 由 `dev-env.sh` 切换 |
| `chunkBytes` | 分块字节上限 |
| `maxChunks` | demo 最多请求块数 |
| `matchThreshold` | 计入 ↑↓ 的 match 阈值 |
| `pwScorePercentile` | 简化 pw 分位 τ（默认 0.9） |
| `domDebug` | `true` 只划正文范围 |
| `followSearching` | `true` 全程跟随最新 chunk |

### 排查：`Frame with ID 0 was removed`

受限页 / 未加载完 / 标签休眠。换普通文章页 → 加载完 → 重载扩展 → 再点图标。

---

## 目录要点

```text
manifest.json          # unpacked；图标 icons/dev/
icons/icon*.png        # 上架正式图标
pack.sh / dev-env.sh
config.prod.js         # 上架默认（源头）；pack 打进包
config.local.js        # 本地（源头）
config.js              # gitignore；dev-env 生成
ui/                    # Find bar 权威源
articleRoot.js         # Readability 定根
splitTextToChunks.js / mergeTokenSpans.js   # SYNC ← client
vendor/Readability.js
```
