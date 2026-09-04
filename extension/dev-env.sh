#!/bin/bash
# 切换 apiBase（unpacked 开发版）：
#   prod  = 官方域名 api.info-lens.app
#   dev   = *.workers.dev（同一 Worker）
# config.js 由本脚本生成（gitignore）；源头为 config.{prod,dev}.js。
# 上架包由 pack.sh 直接用 config.prod.js，不依赖本脚本状态。
# 用法：
#   ./dev-env.sh prod
#   ./dev-env.sh dev
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

case "${1:-}" in
  prod)
    cp config.prod.js config.js
    echo "已切回 prod：apiBase=api.info-lens.app。去 chrome://extensions 重新加载生效。"
    ;;
  dev)
    cp config.dev.js config.js
    echo "已切到 dev：apiBase=infolens-api.xiaoyundqy.workers.dev。去 chrome://extensions 重新加载生效。"
    ;;
  *)
    echo "用法: $0 prod|dev" >&2
    exit 1
    ;;
esac
