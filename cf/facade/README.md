# InfoLens facade（Cloudflare Worker）

Worker 名：`infolens-api`（自定义域 `api.info-lens.app`）。

本地：`npm test`（`node:test`，Node 18+）。部署：`npx wrangler deploy`。

## R2 上报流水（`REPORT_LOGS`）

Binding 名：**`REPORT_LOGS`**  
Bucket 名：**`infolens-report-logs`**

扩展流水 **只写 R2**，不再写入 STATE KV：

- `POST /api/extension-usage`（tee 后仍代理 HF/Home，语义不变）
- `POST /api/extension-events`
- `POST /api/extension-feedback`
- `POST /api/extension-local-init`
- `POST /api/extension-analysis-fail`
- `POST /api/extension-local-engine`
- `POST /api/extension-uninstall-survey`

STATE KV 只留 home 白名单 / 健康探活等配置快照。Admin GET（`/facade-extension-*`）仍读 **历史 KV**；新事件在 R2，本次不做查询 UI。

### 部署前建桶

桶必须先存在，否则 `wrangler deploy` 绑 R2 会失败。代码在缺 binding 时对上报 no-op（warn 一次），不改变主路径成功/失败。

```bash
cd cf/facade
npx wrangler r2 bucket create infolens-report-logs
npx wrangler deploy
```

### Key

每事件一个对象（R2 无真正 append）：

```
reports/YYYY-MM-DD/<route-slug>/<ISO8601compact>-<id8>.json
```

例：`reports/2026-09-18/api-extension-usage/20260918T064500123Z-a1b2c3d4.json`

### Object body

```json
{
  "received_at": "2026-09-18T06:45:00.123Z",
  "route": "/api/extension-usage",
  "client_id": "a1b2c3d4-e5f6-4789-8abc-def012345678",
  "extension": "info-highlight",
  "engine": "local",
  "outcome": "ok",
  "segments": 3
}
```

`received_at` / `route` 由 Worker 写入；其余为请求 JSON **原字段**（不剥 `client_id`）。单条序列化超过 64KiB 时不落原文，改为 `{ omitted: "payload_too_large", bytes }` stub。
