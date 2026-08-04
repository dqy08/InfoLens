#!/bin/bash
# 切换 apiBase + 图标（unpacked 开发版）：
#   prod  = 官方域名 api.info-lens.app + icons/（正式图标）
#   dev   = *.workers.dev（同一 Worker）+ icons/dev/
# config.js 由本脚本生成（gitignore）；源头为 config.{prod,dev}.js。
# manifest.json 图标路径随本脚本切换（工作树会脏；提交前请切回 dev）。
# 上架包由 pack.sh 直接用 config.prod.js + 正式图标，不依赖本脚本状态。
# 用法：
#   ./dev-env.sh prod
#   ./dev-env.sh dev
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

switch_icons() {
  local mode="$1"
  python3 - "$mode" <<'PY'
import json
import sys
from pathlib import Path

mode = sys.argv[1]
path = Path("manifest.json")
text = path.read_text(encoding="utf-8")
if mode == "prod":
    new = text.replace("icons/dev/", "icons/")
elif mode == "dev":
    new = text if "icons/dev/" in text else text.replace('"icons/', '"icons/dev/')
else:
    sys.exit(f"bad icon mode: {mode}")
json.loads(new)  # 改坏就直接报错
if new != text:
    path.write_text(new, encoding="utf-8")
PY
}

case "${1:-}" in
  prod)
    cp config.prod.js config.js
    switch_icons prod
    echo "已切回 prod：apiBase=api.info-lens.app，图标=icons/。去 chrome://extensions 重新加载生效。"
    ;;
  dev)
    cp config.dev.js config.js
    switch_icons dev
    echo "已切到 dev：apiBase=infolens-api.xiaoyundqy.workers.dev，图标=icons/dev/。去 chrome://extensions 重新加载生效。"
    ;;
  *)
    echo "用法: $0 prod|dev" >&2
    exit 1
    ;;
esac
