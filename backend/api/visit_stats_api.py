"""访问统计 API（仅管理员可用）"""
from backend.visit_stats import get_stats_snapshot
from backend.api.utils import require_admin


@require_admin
def get_visit_stats():
    return get_stats_snapshot(), 200
