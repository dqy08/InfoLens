"""推理 API 响应日志。

- 远程代理：门户 ingress `response_log_fn` 打端到端。
- 本地执行（门户本地槽位或 worker）：handler 内打完整日志（可含 wait/processing）；
  用 `for_worker` 区分进程，避免与门户回调重复。
"""
from __future__ import annotations

from collections.abc import Callable, Mapping
from typing import Any, Optional

from backend.platform.model_routing import is_worker

PortalResponseLogger = Callable[[Any, float, int], None]


def _should_emit(*, for_worker: bool) -> bool:
    return is_worker() if for_worker else not is_worker()


def _req_id_part(request_id: int | None) -> str:
    if request_id is None:
        return ""
    return f" req_id={request_id},"


def log_analyze_response(
    *,
    request_id: int | None,
    char_count: int,
    result: dict,
    elapsed: float,
    stream: bool = False,
    for_worker: bool = False,
) -> None:
    if not _should_emit(for_worker=for_worker):
        return
    tokens = len(result.get("bpe_strings", []))
    mode_str = "(stream)" if stream else ""
    msg = f"\t📤 API analyze {mode_str} response:"
    msg += _req_id_part(request_id)
    msg += f" tokens={tokens}, text_length={char_count}, response_time={elapsed:.4f}s"
    print(msg)


def log_analyze_semantic_response(
    *,
    request_id: int | None,
    result: dict,
    elapsed: float,
    wait_time: float | None = None,
    for_worker: bool = False,
) -> None:
    if not _should_emit(for_worker=for_worker):
        return
    tokens = result.get("input_token_count", len(result.get("token_attention", [])))
    msg = f"\t📤 API analyze_semantic (stream) response:"
    msg += _req_id_part(request_id)
    msg += f" tokens={tokens}, response_time={elapsed:.4f}s"
    if wait_time is not None:
        msg += f" (wait={wait_time:.4f}s, processing={elapsed - wait_time:.4f}s)"
    print(msg)


def log_prediction_attribute_response(
    *,
    request_id: int | None,
    result: dict,
    elapsed: float,
    flow_id: str | None = None,
    flow_step: int | None = None,
    for_worker: bool = False,
) -> None:
    if not _should_emit(for_worker=for_worker):
        return
    tokens = len(result.get("token_attribution", []))
    target_token = result.get("target_token")
    msg = f"\t📤 API prediction_attribute response:"
    msg += _req_id_part(request_id)
    if flow_id is not None:
        msg += f" flow_id={flow_id!r}, flow_step={flow_step},"
    msg += f" target={target_token!r}, tokens={tokens}, response_time={elapsed:.4f}s"
    print(msg)


def log_openai_completions_response(
    *,
    request_id: int | None,
    prompt_tokens: int,
    completion_tokens: int,
    elapsed: float,
    ttft_s: Optional[float],
    for_worker: bool = False,
) -> None:
    if not _should_emit(for_worker=for_worker):
        return
    if ttft_s is None:
        tps_part = ""
    else:
        decode_s = elapsed - ttft_s
        prompt_time_s = f"{ttft_s:.4f}" if ttft_s > 0 else "n/a"
        gen_time_s = f"{decode_s:.4f}" if decode_s > 0 else "n/a"
        prompt_part = f"{prompt_tokens / ttft_s:.2f}" if ttft_s > 0 else "n/a"
        gen_part = (
            f"{completion_tokens / decode_s:.2f}"
            if completion_tokens and decode_s > 0
            else "n/a"
        )
        tps_part = (
            f", time= {prompt_time_s} / {gen_time_s}s, "
            f"tokens/s= {prompt_part} / {gen_part}"
        )
    msg = f"\t📤 API openai_completions response:"
    msg += _req_id_part(request_id)
    msg += f" prompt/generate tokens= {prompt_tokens} / {completion_tokens}"
    msg += tps_part
    print(msg)


def log_openai_completions_issue(message: str, *, request_id: int | None = None) -> None:
    """续写非正常结束；门户与单机模式打印，Worker 不重复。"""
    if is_worker():
        return
    rid = f"req_id={request_id}, " if request_id is not None else ""
    print(f"\t⚠️ openai_completions {rid}{message}")


def extract_analyze_result_metrics(data: Any) -> tuple[dict, int]:
    """从 JSON 或 SSE result 事件 data 提取 result 与 char_count。"""
    if not isinstance(data, dict):
        return {}, 0
    text_len = 0
    req = data.get("request")
    if isinstance(req, dict) and isinstance(req.get("text"), str):
        text_len = len(req["text"])
    inner = data.get("result", data)
    if isinstance(inner, dict) and "result" in inner and isinstance(inner["result"], dict):
        inner = inner["result"]
    if not isinstance(inner, dict):
        inner = {}
    return inner, text_len


def extract_completions_usage(data: Any) -> tuple[int, int, Optional[float]]:
    """从 SSE result 事件 data 提取 prompt/completion tokens 与 TTFT（若有）。"""
    if not isinstance(data, dict):
        return 0, 0, None
    usage = data.get("usage") if isinstance(data.get("usage"), dict) else {}
    prompt_tokens = int(usage.get("prompt_tokens") or 0)
    completion_tokens = int(usage.get("completion_tokens") or 0)
    ttft = data.get("info_radar", {}).get("ttft_s") if isinstance(data.get("info_radar"), dict) else None
    if ttft is not None:
        try:
            ttft = float(ttft)
        except (TypeError, ValueError):
            ttft = None
    return prompt_tokens, completion_tokens, ttft


def make_analyze_response_logger(
    logged: Mapping[str, int | None],
    *,
    text_len: int,
    stream: bool = False,
) -> PortalResponseLogger:
    def _log(data: Any, elapsed: float, _status: int) -> None:
        result, char_count = extract_analyze_result_metrics(data)
        log_analyze_response(
            request_id=logged.get("request_id"),
            char_count=char_count or text_len,
            result=result,
            elapsed=elapsed,
            stream=stream,
        )

    return _log


def make_analyze_semantic_response_logger(
    logged: Mapping[str, int | None],
) -> PortalResponseLogger:
    """远程代理路径：从响应体取 input_token_count（含批量 results 汇总），无 wait。"""

    def _log(data: Any, elapsed: float, _status: int) -> None:
        if not isinstance(data, dict):
            return
        results = data.get("results")
        if isinstance(results, list):
            total = sum(
                r.get("input_token_count", 0) for r in results if isinstance(r, dict)
            )
            result = {"input_token_count": total}
        else:
            result = data
        log_analyze_semantic_response(
            request_id=logged.get("request_id"),
            result=result,
            elapsed=elapsed,
        )

    return _log


def make_prediction_attribute_response_logger(
    logged: Mapping[str, int | None],
    *,
    flow_id: str | None,
    flow_step: int | None,
) -> PortalResponseLogger:
    def _log(data: Any, elapsed: float, _status: int) -> None:
        if not isinstance(data, dict) or not data.get("success", True):
            return
        log_prediction_attribute_response(
            request_id=logged.get("request_id"),
            result=data,
            elapsed=elapsed,
            flow_id=flow_id,
            flow_step=flow_step,
        )

    return _log


def make_completions_response_logger(
    logged: Mapping[str, int | None],
) -> PortalResponseLogger:
    def _log(data: Any, elapsed: float, _status: int) -> None:
        prompt_tokens, completion_tokens, ttft_s = extract_completions_usage(data)
        log_openai_completions_response(
            request_id=logged.get("request_id"),
            prompt_tokens=prompt_tokens,
            completion_tokens=completion_tokens,
            elapsed=elapsed,
            ttft_s=ttft_s,
        )

    return _log
