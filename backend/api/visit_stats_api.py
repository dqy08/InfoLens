"""访问统计 API（仅管理员可用）"""
from backend.platform.visit_stats import get_stats_snapshot, reset_delta_base
from backend.api.utils import require_admin


@require_admin
def get_visit_stats():
    return get_stats_snapshot(), 200


@require_admin
def post_visit_stats_reset():
    if reset_delta_base():
        return {"success": True}, 200
    return {"success": False, "error": "Failed to persist reset base"}, 500
