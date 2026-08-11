"""Worker 形态：拦截门户专属写操作与非本进程槽位之外的变更 API。"""
from __future__ import annotations

from flask import request

from backend.platform.model_routing import is_worker, worker_write_forbidden

# basePath /api 下的写操作与统计上报（demo 读 list_demos 不在此列）
_BLOCKED_PREFIXES = (
    "/api/save_demo",
    "/api/delete_demo",
    "/api/move_demo",
    "/api/rename_demo",
    "/api/rename_folder",
    "/api/delete_folder",
    "/api/create_folder",
    "/api/switch_model",
    "/api/client-activity",
    "/api/visit_stats",
)


def register_worker_guards(connexion_app) -> None:
    if not is_worker():
        return

    @connexion_app.app.before_request
    def _worker_block_writes():  # noqa: ANN202
        path = request.path.rstrip("/") or request.path
        for prefix in _BLOCKED_PREFIXES:
            if path == prefix.rstrip("/") or path.startswith(prefix.rstrip("/") + "/"):
                body, status = worker_write_forbidden()
                return body, status
        return None
