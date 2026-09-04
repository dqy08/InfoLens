# Chrome Web Store 发布流程

可复用的打包 → 上传 → 提交审核流程。官方 API：https://developer.chrome.com/docs/webstore/using-api

**本次 API 只更新扩展包，不改商店「产品详情」文案 / 截图等 listing。** Listing 仍在 [Developer Dashboard](https://chrome.google.com/webstore/devconsole/) 手工维护。

商店页：https://chromewebstore.google.com/detail/jnjglfjkbopeiodpcgmlhkfhldjfcdda

---

## 一次性：申请官方凭证

前提：发扩展的 Google 账号已开两步验证。

### 1. 启用 API

[Google Cloud Console](https://console.cloud.google.com/) → 新建或选项目 → 启用 **Chrome Web Store API**。

### 2. OAuth 同意屏幕

[OAuth consent screen](https://console.cloud.google.com/apis/credentials/consent) → **External** → 填应用名与邮箱 → Scopes 可跳过 → 把本账号加入 **Test users**。

建议最后 **Publish to Production**（Testing 下 refresh token 约 7 天过期）。

### 3. OAuth Client

[Credentials](https://console.cloud.google.com/apis/credentials) → Create → **OAuth client ID** → 类型 **Web application** → Authorized redirect URI：

```text
https://developers.google.com/oauthplayground
```

记下 Client ID、Client Secret。

### 4. Refresh Token（OAuth Playground）

1. 打开 https://developers.google.com/oauthplayground/
2. **齿轮** → 勾选 **Use your own OAuth credentials** → 填 Client ID / Secret（Access type 选 Offline）→ 关闭齿轮  
   （Scope **不在**齿轮里。）
3. 左侧 Step 1 → **Input your own scopes** 填：

   ```text
   https://www.googleapis.com/auth/chromewebstore
   ```

4. **Authorize APIs** → 用发扩展的账号登录同意  
5. Step 2 → **Exchange authorization code for tokens** → 复制 `refresh_token`

### 5. 商店侧 ID

| ID | 哪里看 |
|----|--------|
| Extension ID | 商店详情 URL 末段，或 Dashboard 里该扩展 |
| Publisher ID | Dashboard → **Publisher** → **Settings** |

---

## 本机环境变量

写入仓库根目录 `.env`（已 gitignore，**勿提交、勿贴到聊天**）：

```bash
GOOGLE_CLIENT_ID=...
GOOGLE_CLIENT_SECRET=...
GOOGLE_REFRESH_TOKEN=...
CHROME_EXTENSION_ID=jnjglfjkbopeiodpcgmlhkfhldjfcdda
CHROME_PUBLISHER_ID=...
```

代理（国内连 Google 通常需要；端口按本机 Clash / mihomo）：

```bash
export http_proxy=http://127.0.0.1:7890
export https_proxy=http://127.0.0.1:7890
```

自检：浏览器打开 `https://oauth2.googleapis.com/` 出现 **404** 即表示已连通（根路径无页面，404 正常）。

---

## 每次发布

### 1. 升版本

改 `extension/manifest.json` 的 `version`（商店要求每次上传必须升高）。

### 2. 打包

```bash
./extension/pack.sh
```

产出：`extension/dist/info-lens-semantic-highlight-v<version>.zip`（`config.prod.js` → 包内 `config.js`，不改工作树）。

### 3. 上传 + 提交审核

用 **curl**（走系统 / 环境代理）。`chrome-webstore-upload-cli` 的 Node `fetch` **不走** `HTTP_PROXY`，在本机易超时，故不用 CLI。

把下面 `<version>` 换成实际版本号，在仓库根目录执行：

```bash
export http_proxy=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890
set -a && source .env && set +a

ZIP="extension/dist/info-lens-semantic-highlight-v<version>.zip"

# access token
ACCESS=$(curl -sS -x "$http_proxy" "https://oauth2.googleapis.com/token" \
  -d "client_secret=${GOOGLE_CLIENT_SECRET}&grant_type=refresh_token&refresh_token=${GOOGLE_REFRESH_TOKEN}&client_id=${GOOGLE_CLIENT_ID}" \
  | python3 -c 'import sys,json; print(json.load(sys.stdin)["access_token"])')

# 上传包
curl -sS -x "$http_proxy" \
  -H "Authorization: Bearer ${ACCESS}" \
  -H "x-goog-api-version: 2" \
  -X POST -T "$ZIP" \
  "https://chromewebstore.googleapis.com/upload/v2/publishers/${CHROME_PUBLISHER_ID}/items/${CHROME_EXTENSION_ID}:upload"

# 提交发布（进入审核）
curl -sS -x "$http_proxy" \
  -H "Authorization: Bearer ${ACCESS}" \
  -H "x-goog-api-version: 2" \
  -H "Content-Type: application/json" \
  -X POST \
  "https://chromewebstore.googleapis.com/v2/publishers/${CHROME_PUBLISHER_ID}/items/${CHROME_EXTENSION_ID}:publish"
```

期望结果：

- 上传：`"uploadState": "SUCCEEDED"`，`"crxVersion": "<version>"`
- 发布：`"state": "PENDING_REVIEW"`（通过后自动上线；可见性沿用后台已有设置）

---

## 注意

- **Listing**：短名称 / 短描述来自包内 `_locales`；长描述、截图等须在 Dashboard 改，或另走 listing API（本流程未覆盖）。
- **可见性**：若只在 Dashboard 改过可见性却从未用新设置手工发布过一次，API publish 可能失败；先在后台成功发布一次即可。
- **凭证泄露**：refresh token 等同发版权限；泄露后到 Google 账号撤销该 OAuth 应用授权并重新按上文换 token。
