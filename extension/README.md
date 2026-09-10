# 浏览器插件

**Chrome 加载的是 `dist/`，不是源码目录。**  
改 `info-highlight/`、`semantic-highlight/` 或 `shared/` 之后，让人测之前必须先构建，否则扩展里点重新加载也是旧产物。

```bash
python3 extension/scripts/build_extension.py info-highlight
python3 extension/scripts/build_extension.py semantic-highlight
```

改了 `shared/` 且两个都要测，两条都跑。

- [Info Highlight](./info-highlight/README.md)
- [Semantic Highlight](./semantic-highlight/README.md)
