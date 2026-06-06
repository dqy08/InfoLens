# syntax=docker/dockerfile:1

# -----------------------------------------------------------------------------
# Frontend build stage (stable Node toolchain for webpack/TS)
# -----------------------------------------------------------------------------
FROM node:20-bookworm-slim AS frontend
WORKDIR /app/client/src

COPY client/src/package.json client/src/package-lock.json ./
RUN npm ci

COPY client/src/ ./
# prebuild 需要读取的 JSON，否则 updateIntroHTML.js 会 ENOENT
COPY data/demo/public/ /app/data/demo/public/
RUN npm run build

# -----------------------------------------------------------------------------
# Runtime stage (Hugging Face Spaces runs container as UID 1000)
# Reference: https://huggingface.co/docs/hub/spaces-sdks-docker
# -----------------------------------------------------------------------------
FROM python:3.10-slim

# System deps (git for Hugging Face Hub downloads, build-essential for triton/AWQ CUDA kernel compilation)
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

# Create a non-root user with UID 1000 (mandatory in Spaces)
RUN useradd -m -u 1000 user
USER user

# 只设置构建时需要的环境变量（pip install 需要这些路径）
ENV HOME=/home/user \
    PATH=/home/user/.local/bin:$PATH

WORKDIR $HOME/app

# pip 依赖是本镜像体积与 HF 冷启动（拉取/解压 layer）的主要瓶颈：site-packages 可达数 GB，
# 其中 torch 依赖的 site-packages/nvidia & triton 占了大部分。
COPY --chown=user:users requirements.txt ./
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# 运行时环境变量移到依赖安装之后（这些变量不影响依赖安装）
ENV PYTHONUNBUFFERED=1

# 启用 hf-transfer 加速下载
ENV HF_HUB_ENABLE_HF_TRANSFER=1

# App source（仅复制运行时需要的路径）
COPY --chown=user:users LICENSE NOTICE *.py *.yaml ./
COPY --chown=user:users backend/ ./backend/
COPY --chown=user:users data/demo/public/ ./data/demo/public/

# Frontend build artifacts
COPY --chown=user:users --from=frontend /app/client/dist ./client/dist

# ENV FORCE_INT8=1

EXPOSE 7860
# 硬件的模型适配：
# 在CPU basic 上使用0.6b模型能达到及格的速度
# 在CPU upgrade 上使用1.7b模型能达到及格的速度
# 在本地M5 16G芯片上使用4b模型能达到及格的速度（瓶颈是内存大小）；M5 16G内存仅能同时支持一种分析模型（信息密度分析或语义分析）
CMD ["python", "run.py", "--no_auto_load", "--port", "7860", "--base_model", "qwen3-1.7b", "--instruct_model", "qwen3-1.7b-instruct"]
# CMD ["python", "run.py", "--no_auto_load", "--port", "7860", "--base_model", "qwen3-0.6b", "--instruct_model", "qwen3-0.6b-instruct"]
