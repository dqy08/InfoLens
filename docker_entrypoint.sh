#!/bin/sh
# Docker / HF Spaces 统一入口：本进程本地加载 base+instruct。
#
# INFORADAR_ROLE 仅兼容旧名（default / 已弃用 master|hf）；算力加速由门面 accelerate 登记，与 ROLE 正交。
set -eu

PORT="${INFORADAR_PORT:-7860}"
BASE_MODEL="${INFORADAR_BASE_MODEL:-qwen3-1.7b}"
INSTRUCT_MODEL="${INFORADAR_INSTRUCT_MODEL:-qwen3-1.7b-instruct}"
ROLE="${INFORADAR_ROLE:-default}"

case "${ROLE}" in
  master|hf)
    echo "warning: INFORADAR_ROLE=${ROLE} is deprecated; use default" >&2
    ROLE=default
    ;;
esac

if [ "${ROLE}" != default ]; then
  echo "error: unknown INFORADAR_ROLE=${ROLE} (use default)" >&2
  exit 2
fi

exec python run.py --no_auto_load --port "${PORT}" \
  --base_model "${BASE_MODEL}" \
  --instruct_model "${INSTRUCT_MODEL}"
