"""推理 API 统一入口：统计记账 → 本地执行。"""
from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from flask import Response

from backend.models.model_manager import ModelSlot
from backend.platform.inference_proxy import wrap_sse_response
from backend.platform.model_routing import is_worker, slot_enabled


def _slot_unavailable(slot: ModelSlot) -> tuple[dict, int]:
    return {
        "success": False,
        "message": f"slot {slot.value!r} is not available on this server",
    }, 404


def _emit_response_log(
    response_log_fn: Callable[[Any, float, int], None] | None,
    data: Any,
    elapsed: float,
    status_code: int,
) -> None:
    if is_worker() or response_log_fn is None or status_code >= 400:
        return
    response_log_fn(data, elapsed, status_code)


def _run_local(
    local_fn: Callable[[], Any],
    response_log_fn: Callable[[Any, float, int], None] | None,
) -> Any:
    started = time.perf_counter()
    out = local_fn()
    if is_worker() or response_log_fn is None:
        return out
    if isinstance(out, Response):
        return wrap_sse_response(
            out,
            lambda data, elapsed, status: _emit_response_log(
                response_log_fn, data, elapsed, status
            ),
            started,
        )
    if isinstance(out, tuple) and len(out) >= 2:
        body, status = out[0], out[1]
        status_code = status if isinstance(status, int) else 200
        _emit_response_log(response_log_fn, body, time.perf_counter() - started, status_code)
    return out


def ingress_inference(
    *,
    slot: ModelSlot,
    log_fn: Callable[[], Any] | None = None,
    local_fn: Callable[[], Any],
    response_log_fn: Callable[[Any, float, int], None] | None = None,
):
    """
    顺序：access_log / bump_api（log_fn）→ 本地执行 → response_log_fn（非 worker）。

    Worker 上未启用的槽位直接 404。
    response_log_fn：本地执行若已在 handler 打完整日志可传 None。
    """
    if is_worker() and not slot_enabled(slot):
        return _slot_unavailable(slot)

    if log_fn is not None:
        log_fn()

    return _run_local(local_fn, response_log_fn)
