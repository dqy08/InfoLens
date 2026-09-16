#!/bin/bash
# 切换 apiBase（unpacked 开发版）：
#   prod  = 官方域名 api.info-lens.app
#   dev   = *.workers.dev（同一 Worker；reportUsage=false）
# config.js 由本脚本生成（gitignore）；源头为 config.{prod,dev}.js。
# 浏览器加载的是构建产物，故切完立即重新构建，否则重载扩展不会生效。
# 上架包由 pack.sh 带 --release 固定用 config.prod.js，不依赖本脚本状态。
# 用法：
#   ./dev-env.sh prod
#   ./dev-env.sh dev
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

case "${1:-}" in
  prod)
    cp config.prod.js config.js
    apiBase=api.info-lens.app
    ;;
  dev)
    cp config.dev.js config.js
    apiBase=infolens-api.xiaoyundqy.workers.dev
    ;;
  *)
    echo "用法: $0 prod|dev" >&2
    exit 1
    ;;
esac

python3 ../scripts/build_extension.py info-highlight
echo "已切到 $1：apiBase=${apiBase}。去 chrome://extensions 重新加载生效。"
