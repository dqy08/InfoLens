#!/usr/bin/env python
"""API 模块

定义 Connexion 应用和 API 函数，供 server.yaml 引用。
"""

import os

from workaround_env_fix import diagnose_and_fix_thread_env_vars

# 放此处：server 为应用入口（run.py 或 gunicorn 均会加载），须在 import connexion/backend 前执行
diagnose_and_fix_thread_env_vars()

os.environ["TOKENIZERS_PARALLELISM"] = "false"

import connexion
from backend.logging_config import configure_logging
from backend.api.static import register_static_routes
from backend.visit_stats import register_visit_stats

# 导入 API 函数供 server.yaml 使用
from backend.api.analyze import analyze  # noqa: F401
from backend.api.demo import (  # noqa: F401
    list_demos,
    save_demo,
    delete_demo,
    move_demo,
    rename_demo,
    check_admin,
)
from backend.api.folder import (  # noqa: F401
    rename_folder_api as rename_folder,
    delete_folder_api as delete_folder,
    list_all_folders,
    create_folder_api,
)
from backend.api.fetch_url import fetch_url  # noqa: F401
from backend.api.client_activity import client_activity_report  # noqa: F401
from backend.api.analyze_semantic import analyze_semantic  # noqa: F401
from backend.api.prediction_attribute import prediction_attribute  # noqa: F401
from backend.api.tokenize import tokenize  # noqa: F401
from backend.api.model_switch import (  # noqa: F401
    get_available_models,
    get_current_model,
    switch_model,
)
from backend.api.visit_stats_api import get_visit_stats  # noqa: F401
from backend.api.openai_completions import (  # noqa: F401
    completions,
    completions_prompt,
    completions_stop,
)
from backend.completion_generator import register_inference_shutdown_handlers

register_inference_shutdown_handlers()

# 创建 Connexion 应用
app = connexion.App(__name__)

# 配置日志
configure_logging(app)
register_visit_stats(app)

# 注册路由
register_static_routes(app)
app.add_api('server.yaml')


def _log_500_handler(request, exc):
    """未捕获异常时打印完整 traceback 到 stdout，便于 Docker 日志排查"""
    import traceback
    from connexion.problem import problem
    # 只处理非 HTTP 异常（404/400 等应保持原状态码）
    if hasattr(exc, 'status_code') and 400 <= getattr(exc, 'status_code', 0) < 500:
        raise exc
    print("=" * 60)
    print("❌ 500 Internal Server Error")
    traceback.print_exc()
    print("=" * 60)
    return problem(
        status=500,
        title="Internal Server Error",
        detail=str(exc),
    )


app.add_error_handler(Exception, _log_500_handler)
