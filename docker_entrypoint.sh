#!/bin/sh
# Docker / HF Spaces 统一入口：INFORADAR_ROLE = default | light_docker
#
# 角色只描述「本进程算力怎么来」；任何带本地模型的进程都可被动提供算力（同一 port）。
#   default      — 本地 base+instruct
#   light_docker — 无本地模型：base+instruct 均 --remote 到固定 origin（轻量 Docker 后端）
#
# 获益通路：--remote 为固定配置；accelerate 为运行时注册（与 ROLE 正交）。
set -eu

PORT="${INFORADAR_PORT:-7860}"
BASE_MODEL="${INFORADAR_BASE_MODEL:-qwen3-1.7b}"
INSTRUCT_MODEL="${INFORADAR_INSTRUCT_MODEL:-qwen3-1.7b-instruct}"
ROLE="${INFORADAR_ROLE:-}"
if [ -z "${ROLE}" ]; then
  ROLE=default
fi

# 旧名兼容
case "${ROLE}" in
  master|hf)
    echo "warning: INFORADAR_ROLE=${ROLE} is deprecated; use default" >&2
    ROLE=default
    ;;
  worker)
    echo "error: INFORADAR_ROLE=worker removed; use default or light_docker" >&2
    exit 2
    ;;
esac

COMMON="--no_auto_load --port ${PORT}"

case "${ROLE}" in
  default)
    exec python run.py ${COMMON} \
      --base_model "${BASE_MODEL}" \
      --instruct_model "${INSTRUCT_MODEL}"
    ;;
  light_docker)
    REMOTE_ORIGIN="${INFORADAR_REMOTE_ORIGIN:-}"
    if [ -z "${REMOTE_ORIGIN}" ]; then
      echo "error: INFORADAR_REMOTE_ORIGIN is required when INFORADAR_ROLE=light_docker" >&2
      exit 2
    fi
    exec python run.py ${COMMON} \
      --slots base,instruct \
      --remote "base=${REMOTE_ORIGIN}" \
      --remote "instruct=${REMOTE_ORIGIN}" \
      --base_model "${BASE_MODEL}" \
      --instruct_model "${INSTRUCT_MODEL}"
    ;;
  *)
    echo "error: unknown INFORADAR_ROLE=${ROLE} (use default or light_docker)" >&2
    exit 2
    ;;
esac
