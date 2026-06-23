#!/bin/sh
# Docker / HF Spaces 统一入口：INFORADAR_ROLE 区分 default | master | worker。
set -eu

PORT="${INFORADAR_PORT:-7860}"
BASE_MODEL="${INFORADAR_BASE_MODEL:-qwen3-1.7b}"
INSTRUCT_MODEL="${INFORADAR_INSTRUCT_MODEL:-qwen3-1.7b-instruct}"
# 未设置或空字符串 → default
ROLE="${INFORADAR_ROLE:-}"
if [ -z "${ROLE}" ]; then
  ROLE=default
fi

COMMON="--no_auto_load --port ${PORT}"

case "${ROLE}" in
  default)
    exec python run.py ${COMMON} \
      --base_model "${BASE_MODEL}" \
      --instruct_model "${INSTRUCT_MODEL}"
    ;;
  master)
    if [ -z "${INFORADAR_REMOTE_BASE:-}" ]; then
      echo "error: INFORADAR_REMOTE_BASE is required when INFORADAR_ROLE=master" >&2
      exit 2
    fi
    exec python run.py ${COMMON} \
      --slots base,instruct \
      --remote "base=${INFORADAR_REMOTE_BASE}" \
      --base_model "${BASE_MODEL}" \
      --instruct_model "${INSTRUCT_MODEL}"
    ;;
  worker)
    exec python run.py --worker --no_cors ${COMMON} \
      --slots base \
      --base_model "${BASE_MODEL}"
    ;;
  *)
    echo "error: unknown INFORADAR_ROLE=${ROLE} (use default, master, or worker)" >&2
    exit 2
    ;;
esac
