"""Portal → Private Worker HTTP 代理（含 SSE 透传）。"""
from __future__ import annotations

import json
import threading
import time
from collections.abc import Callable, Iterator
from typing import Any

import requests
from flask import Response, stream_with_context

from backend.platform.model_routing import remote_hf_token

_active_remote_completion_slot: Any = None
_active_remote_lock = threading.Lock()


def set_active_remote_completion_slot(slot) -> None:
    with _active_remote_lock:
        global _active_remote_completion_slot
        _active_remote_completion_slot = slot


def get_active_remote_completion_slot():
    with _active_remote_lock:
        return _active_remote_completion_slot


def clear_active_remote_completion_slot() -> None:
    with _active_remote_lock:
        global _active_remote_completion_slot
        _active_remote_completion_slot = None


def _notify_sse_block(
    block: bytes,
    on_response: Callable[[Any, float, int], None],
    started: float,
    status_code: int,
) -> None:
    for line in block.decode("utf-8", errors="replace").split("\n"):
        if not line.startswith("data: "):
            continue
        try:
            payload = json.loads(line[6:].strip())
        except json.JSONDecodeError:
            continue
        if payload.get("type") == "result":
            on_response(payload.get("data"), time.perf_counter() - started, status_code)
        elif payload.get("type") == "error":
            on_response(payload, time.perf_counter() - started, payload.get("status_code", 500))


def _tap_chunk_stream(
    chunks: Iterator,
    on_response: Callable[[Any, float, int], None] | None,
    started: float,
    status_code: int,
):
    if on_response is None:
        yield from chunks
        return
    pending = b""
    for chunk in chunks:
        if not chunk:
            continue
        yield chunk
        pending += chunk if isinstance(chunk, bytes) else chunk.encode("utf-8")
        while b"\n\n" in pending:
            block, pending = pending.split(b"\n\n", 1)
            _notify_sse_block(block, on_response, started, status_code)


def wrap_sse_response(
    response: Response,
    on_response: Callable[[Any, float, int], None],
    started: float,
) -> Response:
    """本地 SSE 响应：透传 chunk 并在 result 事件时回调（与代理路径一致）。"""
    status_code = response.status_code

    def generating():
        yield from _tap_chunk_stream(
            response.response, on_response, started, status_code
        )

    return Response(
        stream_with_context(generating()),
        status=status_code,
        headers=dict(response.headers),
        mimetype=response.mimetype,
    )


def _auth_headers() -> dict[str, str]:
    token = remote_hf_token()
    if not token:
        raise RuntimeError("INFORADAR_REMOTE_HF_TOKEN is not set")
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _upstream_error(exc: requests.RequestException) -> tuple[dict, int]:
    if isinstance(exc, requests.Timeout):
        return {"success": False, "message": f"upstream timeout: {exc}"}, 504
    return {"success": False, "message": f"upstream unreachable: {exc}"}, 502


def _response_from_requests(resp: requests.Response):
    content_type = resp.headers.get("Content-Type", "")
    if "application/json" in content_type:
        try:
            return resp.json(), resp.status_code
        except ValueError:
            pass
    return Response(
        resp.content,
        status=resp.status_code,
        headers={"Content-Type": content_type or "application/octet-stream"},
    )


def proxy_request(
    origin: str,
    method: str,
    path: str,
    *,
    json_body: dict | None = None,
    stream: bool = False,
    timeout: float = 60.0,
    on_stream_close: Callable[[], None] | None = None,
    on_response: Callable[[Any, float, int], None] | None = None,
):
    url = f"{origin.rstrip('/')}{path}"
    try:
        headers = _auth_headers()
    except RuntimeError as exc:
        if on_stream_close is not None:
            on_stream_close()
        return {"success": False, "message": str(exc)}, 500

    started = time.perf_counter()

    if stream:
        return _proxy_streaming(
            url, method, headers, json_body, timeout, on_stream_close, on_response, started
        )
    try:
        resp = requests.request(
            method,
            url,
            headers=headers,
            json=json_body,
            timeout=timeout,
        )
    except requests.RequestException as exc:
        return _upstream_error(exc)
    elapsed = time.perf_counter() - started
    if on_response is not None:
        body = None
        if "application/json" in resp.headers.get("Content-Type", ""):
            try:
                body = resp.json()
            except ValueError:
                body = None
        on_response(body, elapsed, resp.status_code)
    return _response_from_requests(resp)


def _proxy_streaming(
    url: str,
    method: str,
    headers: dict[str, str],
    json_body: dict | None,
    timeout: float,
    on_stream_close: Callable[[], None] | None,
    on_response: Callable[[Any, float, int], None] | None,
    started: float,
):
    try:
        upstream = requests.request(
            method,
            url,
            headers=headers,
            json=json_body,
            timeout=timeout,
            stream=True,
        )
    except requests.RequestException as exc:
        if on_stream_close is not None:
            on_stream_close()
        return _upstream_error(exc)

    def _handle_sse_block(block: bytes) -> None:
        if on_response is None:
            return
        _notify_sse_block(block, on_response, started, upstream.status_code)

    def generate():
        pending = b""
        try:
            for chunk in upstream.iter_content(chunk_size=None):
                if not chunk:
                    continue
                yield chunk
                pending += chunk
                while b"\n\n" in pending:
                    block, pending = pending.split(b"\n\n", 1)
                    _handle_sse_block(block)
        finally:
            upstream.close()
            if on_stream_close is not None:
                on_stream_close()

    resp_headers: dict[str, str] = {}
    content_type = upstream.headers.get("Content-Type")
    if content_type:
        resp_headers["Content-Type"] = content_type

    return Response(
        stream_with_context(generate()),
        status=upstream.status_code,
        headers=resp_headers,
    )
