#!/usr/bin/env python
"""服务入口点

启动 HTTP 服务并加载模型。
"""

import time

print(f"[inforadar] run.py start at {time.strftime('%Y-%m-%d %H:%M:%S')}", flush=True)

import argparse
import logging
import sys
import threading

from model_paths import (
    DEFAULT_BASE_MODEL,
    DEFAULT_INSTRUCT_MODEL,
    INSTRUCT_MODEL_PATHS,
    MODEL_PATHS,
    validate_base_model_id,
    validate_instruct_model_id,
)

ENV_HELP = """
环境变量:
  INFORADAR_ADMIN_TOKEN  管理员 token，用于 check_admin、切换模型、demo 管理；未设置则禁用
  HF_ENDPOINT_MIRROR    可选，公开模型 snapshot 下载镜像（如 https://hf-mirror.com）；勿设 HF_ENDPOINT
  FORCE_CPU=1           强制使用 CPU，忽略 CUDA/MPS
  FORCE_INT8=1          启用 INT8 量化（CPU/CUDA 支持，MPS 不支持）
  CPU_FORCE_BFLOAT16=1  CPU 使用 bfloat16
"""


def _parse_args():
    """解析参数；遇 -h 时打印帮助并 sys.exit(0)，不触发重量级导入。"""
    parser = argparse.ArgumentParser(
        epilog=ENV_HELP,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument(
        "--base_model",
        default=DEFAULT_BASE_MODEL,
        help=(
            f"Base 槽位模型 id (默认: {DEFAULT_BASE_MODEL})。"
            f"可用: {', '.join(MODEL_PATHS.keys())}"
        ),
    )
    parser.add_argument(
        "--instruct_model",
        default=DEFAULT_INSTRUCT_MODEL,
        help=(
            f"Instruct 槽位模型 id (默认: {DEFAULT_INSTRUCT_MODEL})。"
            f"可用: {', '.join(INSTRUCT_MODEL_PATHS.keys())}"
        ),
    )
    parser.add_argument(
        "--logits_gradient_submode",
        default="fill_blank",
        choices=["count", "match_score", "fill_blank"],
        help="logits_gradient 子策略：count=数量；match_score=相关度打分(已废弃)；fill_blank=填空式",
    )
    parser.add_argument(
        "--no-gradient-checkpointing",
        dest="gradient_checkpointing",
        action="store_false",
        help="关闭 gradient checkpointing（默认开启：归因/语义梯度反传省显存）",
    )
    parser.set_defaults(gradient_checkpointing=True)
    parser.add_argument("--address", default="0.0.0.0")
    parser.add_argument("--port", default="5001")
    parser.add_argument("--dir", type=str, default=None)
    parser.add_argument("--no_cors", action="store_true")
    parser.add_argument(
        "--no_auto_load",
        action="store_true",
        help="不在启动时预加载主分析与语义模型，首次相关 API 时再懒加载",
    )
    parser.add_argument(
        "--verbose",
        action="store_true",
        help="输出详细调试信息（如 semantic 分析的推理原文与 top-k）",
    )
    return parser.parse_args()


def _load_and_run(args):
    """加载 server、backend 等依赖并启动服务（parse_args 遇 -h 已退出，不会执行到此）"""
    from flask_compress import Compress
    from flask_cors import CORS

    import server
    from server import app
    from backend.platform.app_context import AppContext
    from backend.demo.data_utils import resolve_data_dir
    from backend.models.model_manager import preload_all_slots

    data_dir = resolve_data_dir(args.dir)
    ctx = AppContext.init(args, data_dir)

    if not ctx.args.no_cors:
        CORS(app.app, headers="Content-Type")

    Compress(app.app)

    if not getattr(ctx.args, "no_auto_load", False):
        def load_model_in_background():
            try:
                preload_all_slots()
            except Exception as exc:  # noqa: BLE001
                logging.getLogger(__name__).warning("后台模型加载失败: %s", exc)
            finally:
                AppContext.get().set_model_loading(False)

        threading.Thread(target=load_model_in_background, daemon=True, name="ModelLoader").start()
    else:
        AppContext.get().set_model_loading(False)

    app.run(port=int(ctx.args.port), host=ctx.args.address, access_log=False)


def main():
    args = _parse_args()
    try:
        args.base_model = validate_base_model_id(args.base_model)
        args.instruct_model = validate_instruct_model_id(args.instruct_model)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        sys.exit(2)
    _load_and_run(args)


if __name__ == "__main__":
    main()
