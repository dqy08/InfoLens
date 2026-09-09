# 测试

1 和 2 都很快（约一两秒），改插件或口头说「跑测试」时**一起跑**。不要默认跑 3（出网、耗额度）。

上架商店只经过 `./extension/semantic-highlight/pack.sh`，打包前会先跑 1 和 2；推仓库不会上架。级别 3 不进打包。

命令均在仓库根目录执行。

## 1. 本地、不联网

逻辑对不对。

```bash
cd extension/semantic-highlight && npm test
cd cf/facade && npm test
```

`extension/shared/page/splitTextToChunks.js` 是 `client/src/shared/cross/semanticUtils.ts` 的副本，
两份漂移不会有任何报错，改动其中任一份时跑一致性测试（需要 `npx tsx`，故不进打包）：

```bash
cd client/src && npm run test:splitChunksParity
```

## 2. 真浏览器、假接口

扩展能否注入、出现查找栏、画出高亮。加载的是构建产物，所以先 `python3 extension/scripts/build_extension.py semantic-highlight`。首次还要 `cd extension/semantic-highlight && npx playwright install chromium`。

```bash
cd extension/semantic-highlight && npm run test:e2e
```

## 3. 打真实接口

版本、相关度、关键词是否还能通（插件所依赖的接口）。改后端或发布前跑。会出网、耗额度。

```bash
cd cf/facade && npm run test:api
# 默认用 extension/semantic-highlight/config.dev.js 的 apiBase。打主域名：API_BASE=https://api.info-lens.app npm run test:api
```

只检查能返回成功并开始吐流，不断言某个词一定被标上。

## 定时可用性（给机器人）

只确认对外产品还活着。不要和上面 1、2 绑在一起；口头说「跑测试」时也不要跑这些。

网站（首页 + health）：

```bash
node scripts/check-site.mjs
```

插件所依赖的接口（开发域名，同级别 3）：

```bash
cd cf/facade && npm run test:api
```

