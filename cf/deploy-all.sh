#!/usr/bin/env bash
# 一键：构建前端 → 部署 Pages → 部署门面 Worker（含 HF_TOKEN）。
#
# 前提：已 wrangler login；仓库根 .env 含 INFORADAR_REMOTE_HF_TOKEN。
# 可选：SKIP_PAGES=1 / SKIP_FACADE=1 只跑一部分。
#
# 用法：
#   ./cf/deploy-all.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use 22 >/dev/null
fi

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "${NODE_MAJOR}" -lt 22 ]; then
  echo "error: need Node >= 22 (current $(node -v)); run: nvm use 22" >&2
  exit 1
fi

PAGES_PROJECT="${INFORADAR_CF_PAGES_PROJECT:-infolens}"
FACADE_URL="${INFORADAR_CF_FACADE_URL:-https://infolens-api.xiaoyundqy.workers.dev}"
PAGES_URL="${INFORADAR_CF_PAGES_URL:-https://infolens.pages.dev}"

if [ "${SKIP_PAGES:-0}" != 1 ]; then
  echo "[deploy-all] build frontend (API → ${FACADE_URL})"
  (
    cd client/src
    INFORADAR_API_BASE="${FACADE_URL}" npm run build:cf
  )
  echo "[deploy-all] deploy Pages → ${PAGES_PROJECT}"
  npx wrangler@latest pages deploy ./client/dist-cf \
    --project-name="${PAGES_PROJECT}" \
    --commit-dirty=true
fi

if [ "${SKIP_FACADE:-0}" != 1 ]; then
  echo "[deploy-all] deploy facade Worker"
  ./cf/deploy-facade.sh
fi

echo "[deploy-all] done"
echo "  pages:  ${PAGES_URL}"
echo "  facade: ${FACADE_URL}"
