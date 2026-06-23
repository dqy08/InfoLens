"""推理 API 统一入口：统计记账 → local / remote 分流。"""
from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from flask import Response

from backend.models.model_manager import ModelSlot
from backend.platform.inference_proxy import (
    clear_active_remote_completion_slot,
    proxy_request,
    set_active_remote_completion_slot,
    wrap_sse_response,
)
from backend.platform.model_routing import is_local, is_worker, remote_origin, slot_enabled


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
    api_path: str,
    method: str = "POST",
    json_body: dict | None = None,
    stream: bool = False,
    timeout: float = 60.0,
    log_fn: Callable[[], Any] | None = None,
    local_fn: Callable[[], Any],
    response_log_fn: Callable[[Any, float, int], None] | None = None,
    track_remote_completion: bool = False,
):
    """
    顺序：access_log / bump_api（log_fn）→ 分流 → response_log_fn（非 worker）。

    Worker 上未启用的槽位直接 404；remote 槽位 HTTP 代理到对应 Space。
    门户本地与代理共用同一 response 日志回调。
    """
    if is_worker() and not slot_enabled(slot):
        return _slot_unavailable(slot)

    if log_fn is not None:
        log_fn()

    if is_local(slot):
        return _run_local(local_fn, response_log_fn)

    origin = remote_origin(slot)
    if not origin:
        return {
            "success": False,
            "message": f"slot {slot.value!r} has no remote origin configured",
        }, 500

    on_close = None
    if track_remote_completion:
        set_active_remote_completion_slot(slot)
        on_close = clear_active_remote_completion_slot

    def _on_response(data: Any, elapsed: float, status_code: int) -> None:
        _emit_response_log(response_log_fn, data, elapsed, status_code)

    return proxy_request(
        origin,
        method,
        api_path,
        json_body=json_body,
        stream=stream,
        timeout=timeout,
        on_stream_close=on_close,
        on_response=_on_response,
    )
