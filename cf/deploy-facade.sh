#!/usr/bin/env bash
# 只部署门面 Worker（含更新 HF_TOKEN）。
# HF_TOKEN 来自仓库根 .env 的 INFORADAR_REMOTE_HF_TOKEN。
#
# 用法：
#   ./cf/deploy-facade.sh
# 全量（前端+门面）：
#   ./cf/deploy-all.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ -s "${NVM_DIR:-$HOME/.nvm}/nvm.sh" ]; then
  # shellcheck disable=SC1091
  . "${NVM_DIR:-$HOME/.nvm}/nvm.sh"
  nvm use 22 >/dev/null
fi

if [ ! -f .env ]; then
  echo "error: missing ${ROOT}/.env" >&2
  exit 1
fi
set -a
# shellcheck disable=SC1091
source .env
set +a
: "${INFORADAR_REMOTE_HF_TOKEN:?missing INFORADAR_REMOTE_HF_TOKEN in .env}"

npx wrangler@latest deploy --config cf/facade/wrangler.jsonc
printf '%s' "$INFORADAR_REMOTE_HF_TOKEN" | npx wrangler@latest secret put HF_TOKEN --config cf/facade/wrangler.jsonc
echo "facade: ${INFORADAR_CF_FACADE_URL:-https://infolens-api.xiaoyundqy.workers.dev}"
