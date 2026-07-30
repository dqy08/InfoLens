"""本地 SSE 响应包装（透传 chunk 并在 result 事件时回调）。"""
from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterator
from typing import Any

from flask import Response, stream_with_context


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
    """本地 SSE 响应：透传 chunk 并在 result 事件时回调。"""
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
