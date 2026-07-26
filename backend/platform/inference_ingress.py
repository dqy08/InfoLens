"""推理 API 统一入口：统计记账 → accelerate / local / remote 分流。"""
from __future__ import annotations

import time
from collections.abc import Callable
from typing import Any

from flask import Response

from backend.models.model_manager import ModelSlot
from backend.platform import instruct_accelerate
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


def _is_unwritten_failure(result: Any) -> bool:
    """代理尚未向客户端承诺成功响应体：error tuple 或非流式上游 5xx。"""
    if isinstance(result, tuple) and len(result) >= 2 and isinstance(result[1], int):
        status = result[1]
        return status >= 500
    return False


def _proxy_remote(
    *,
    slot: ModelSlot,
    api_path: str,
    method: str,
    json_body: dict | None,
    stream: bool,
    timeout: float,
    response_log_fn: Callable[[Any, float, int], None] | None,
    track_remote_completion: bool,
) -> Any:
    origin = remote_origin(slot)
    if not origin:
        return {
            "success": False,
            "message": f"slot {slot.value!r} has no remote origin configured",
        }, 500

    on_close = clear_active_remote_completion_slot if track_remote_completion else None
    if track_remote_completion:
        set_active_remote_completion_slot(slot, origin=origin)

    def _on_response(data: Any, elapsed: float, status_code: int) -> None:
        _emit_response_log(response_log_fn, data, elapsed, status_code)

    try:
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
    except Exception:
        if track_remote_completion:
            clear_active_remote_completion_slot()
        raise


def _proxy_accelerate(
    *,
    origin: str,
    slot: ModelSlot,
    api_path: str,
    method: str,
    json_body: dict | None,
    stream: bool,
    timeout: float,
    response_log_fn: Callable[[Any, float, int], None] | None,
    track_remote_completion: bool,
    fallback_fn: Callable[[], Any],
) -> Any:
    released = False

    def _release() -> None:
        nonlocal released
        if released:
            return
        released = True
        instruct_accelerate.release()
        if track_remote_completion:
            clear_active_remote_completion_slot()

    def _on_response(data: Any, elapsed: float, status_code: int) -> None:
        _emit_response_log(response_log_fn, data, elapsed, status_code)

    def _on_stream_error(_exc: BaseException) -> None:
        instruct_accelerate.trip_circuit()

    if track_remote_completion:
        set_active_remote_completion_slot(slot, origin=origin)

    try:
        result = proxy_request(
            origin,
            method,
            api_path,
            json_body=json_body,
            stream=stream,
            timeout=timeout,
            on_stream_close=_release if stream else None,
            on_response=_on_response,
            on_stream_error=_on_stream_error if stream else None,
        )
    except Exception:
        instruct_accelerate.trip_circuit()
        _release()
        raise

    if _is_unwritten_failure(result):
        instruct_accelerate.trip_circuit()
        _release()
        return fallback_fn()

    if not stream:
        _release()
    return result


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

    分流：accelerate（instruct 合格）→ local → --remote。
    加速失败且未写出时回退到 local / remote 基线；流式已写出则不回退。
    Worker 上未启用的槽位直接 404。
    response_log_fn：远程代理端到端日志；本地执行若已在 handler 打完整日志可传 None。
    """
    if is_worker() and not slot_enabled(slot):
        return _slot_unavailable(slot)

    if log_fn is not None:
        log_fn()

    def baseline() -> Any:
        if is_local(slot):
            return _run_local(local_fn, response_log_fn)
        return _proxy_remote(
            slot=slot,
            api_path=api_path,
            method=method,
            json_body=json_body,
            stream=stream,
            timeout=timeout,
            response_log_fn=response_log_fn,
            track_remote_completion=track_remote_completion,
        )

    if slot == ModelSlot.INSTRUCT and instruct_accelerate.acquire():
        origin = instruct_accelerate.accelerate_origin()
        if origin:
            return _proxy_accelerate(
                origin=origin,
                slot=slot,
                api_path=api_path,
                method=method,
                json_body=json_body,
                stream=stream,
                timeout=timeout,
                response_log_fn=response_log_fn,
                track_remote_completion=track_remote_completion,
                fallback_fn=baseline,
            )
        instruct_accelerate.release()

    return baseline()
