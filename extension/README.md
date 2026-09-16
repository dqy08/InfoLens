# 浏览器插件

**Chrome 加载的是 `dist/`，不是源码目录。**  
改 `info-highlight/`、`semantic-highlight/` 或 `shared/` 之后，让人测之前必须先构建，否则扩展里点重新加载也是旧产物。

```bash
python3 extension/scripts/build_extension.py info-highlight
python3 extension/scripts/build_extension.py semantic-highlight
```

改了 `shared/` 且两个都要测，两条都跑。

| 插件 | Chrome Web Store ID | 商店页 |
|------|---------------------|--------|
| [Info Highlight](./info-highlight/README.md) | `gemajnklkebeikmfphiddpjfimahacdk` | [打开](https://chromewebstore.google.com/detail/gemajnklkebeikmfphiddpjfimahacdk) |
| [Semantic Highlight](./semantic-highlight/README.md) | `jnjglfjkbopeiodpcgmlhkfhldjfcdda` | [打开](https://chromewebstore.google.com/detail/jnjglfjkbopeiodpcgmlhkfhldjfcdda) |

上架：各自目录下的 `PUBLISH.md`；本机 `.env` 里用 `CHROME_EXTENSION_ID_INFO_HIGHLIGHT` / `CHROME_EXTENSION_ID_SEMANTIC_HIGHLIGHT`（Publisher 共用）。
