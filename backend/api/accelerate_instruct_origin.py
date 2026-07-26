"""运行时更新 instruct 加速 origin（admin）。"""
from __future__ import annotations

from backend.api.utils import require_admin
from backend.platform import instruct_accelerate


@require_admin
def get_accelerate_instruct_origin():
    return {
        "success": True,
        "origin": instruct_accelerate.accelerate_origin(),
        "eligible": instruct_accelerate.is_accelerate_eligible(),
        "circuit_open": instruct_accelerate.is_circuit_open(),
        "inflight": instruct_accelerate.inflight_count(),
        "ttl_sec": instruct_accelerate.ttl_sec(),
    }, 200


@require_admin
def put_accelerate_instruct_origin(body):
    """body.origin: HTTPS origin；空字符串或 null 表示关闭加速。成功登记刷新 TTL。"""
    raw = None if body is None else body.get("origin")
    if raw is not None and not isinstance(raw, str):
        return {"success": False, "message": "origin must be a string or null"}, 400
    try:
        origin = instruct_accelerate.set_accelerate_origin(raw)
    except ValueError as exc:
        return {"success": False, "message": str(exc)}, 400
    return {
        "success": True,
        "origin": origin,
        "ttl_sec": instruct_accelerate.ttl_sec(),
    }, 200
