#!/bin/bash
# 仅切换 apiBase（local=本机后端 / prod=HF Spaces）。两者都属于 unpacked 开发版，
# 图标与商店版无关：本目录固定用 icons/dev/（绿角标），见 manifest.json。
# config.js 由本脚本生成（gitignore），Chrome unpacked 实际加载它；
# 源头是 config.prod.js / config.local.js。上架包由 pack.sh 直接用 config.prod.js。
# 用法：
#   ./dev-env.sh local   # 生成本地变体
#   ./dev-env.sh prod    # 生成上架默认值
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

case "${1:-}" in
  local)
    cp config.local.js config.js
    echo "已切到 local：apiBase=127.0.0.1:5001。去 chrome://extensions 重新加载生效。"
    ;;
  prod)
    cp config.prod.js config.js
    echo "已切回 prod：apiBase=HF Spaces。去 chrome://extensions 重新加载生效。"
    ;;
  *)
    echo "用法: $0 local|prod" >&2
    exit 1
    ;;
esac
