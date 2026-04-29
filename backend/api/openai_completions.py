"""OpenAI 兼容 /v1/completions：语义分析同款模型续写，其余响应字段固定。"""

import gc
import queue
import threading
import time
import traceback
from typing import Any, Callable, Dict, List, Optional, Tuple

from backend.model_manager import _inference_lock, get_semantic_model_display_name
from backend.oom import exit_if_oom, is_oom_error
from backend.completion_generator import (
    PromptTooLongError,
    apply_chat_template_for_completion,
    completion_cancel_requested,
    generate_completion_text,
    global_completion_stop_event,
    inference_shutdown_event,
)
from backend.api.analyze import LOCK_WAIT_TIMEOUT, QueueTimeoutError
from backend.api.sse_utils import (
    SSEProgressReporter,
    send_completion_delta_event,
    send_error_event,
    send_result_event,
)
from backend.access_log import get_client_ip

# 单次续写 SSE：从进入流式生成器起算的墙钟上限（含排队等推理锁 + 生成）。
COMPLETION_WALL_CLOCK_TIMEOUT_SEC = 300.0


def _log_cmpl_issue(request_id: int, msg: str) -> None:
    """续写非正常结束时一行说明（与成功时的 ``_log_completion_finished`` 二选一）。"""
    print(f"\t⚠️ openai_completions req_id={request_id}: {msg}")


def _log_request(model: str, prompt: str, client_ip=None):
    from backend.access_log import log_openai_completions_request
    return log_openai_completions_request(model, prompt, client_ip)


def _build_response(
    completion_text: str,
    finish_reason: str,
    prompt_tokens: int,
    completion_tokens: int,
    bpe_strings: List[Dict[str, Any]],
):
    """OpenAICompletionsResponse：choices + usage；info_radar 为续写 token 级数据。"""
    total = prompt_tokens + completion_tokens
    return {
        "id": "cmpl-stub-info-radar",
        "object": "text_completion",
        "created": int(time.time()),
        "model": get_semantic_model_display_name(),
        "choices": [
            {
                "text": completion_text,
                "index": 0,
                "finish_reason": finish_reason,
            }
        ],
        "usage": {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total,
        },
        "info_radar": {
            "bpe_strings": bpe_strings,
        },
    }


# 与 generate_completion_text 返回一致（末项 TTFT 秒；未生成时为 None）
CompletionRunResult = Tuple[str, str, int, int, List[Dict[str, Any]], Optional[float]]


def _completion_inference_after_lock(
    prompt: str,
    request_id: int,
    lock_wait_time: float,
    *,
    stream_delta: Optional[Callable[[str, bool], None]] = None,
    max_tokens: Optional[int] = None,
) -> CompletionRunResult:
    """
    在已持有推理锁的上下文中执行续写（旧版非流式路径的持锁体内逻辑）。
    流式可传 stream_delta；中止由 ``completion_cancel_requested()`` 统一判断。
    """
    from backend.access_log import log_openai_completions_start

    log_openai_completions_start(request_id, lock_wait_time)
    return generate_completion_text(prompt, stream_delta=stream_delta, max_tokens=max_tokens)


def _log_completion_finished(
    request_id: int,
    prompt_tokens: int,
    completion_tokens: int,
    elapsed: float,
    ttft_s: Optional[float],
) -> None:
    """旧非流式分支在返回 JSON 前、流式在发出末条 result 前的同一行日志。

    prompt tokens/s = prompt_tokens / TTFT；generate tokens/s = completion_tokens / (elapsed − TTFT)。
    ``elapsed`` 为 SSE 起点至结束；与 TTFT 计时原点不完全一致时，吞吐率为近似值。
    无 TTFT（``ttft_s`` 为 ``None``）时不输出时间与吞吐字段。
    """
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
    print(
        f"\t📤 API openai_completions response: req_id={request_id}, "
        f"prompt/generate tokens= {prompt_tokens} / {completion_tokens}, "
        f"{tps_part}"
    )


def _generate_completion_events(
    prompt: str,
    request_id: int,
    *,
    max_tokens: Optional[int] = None,
):
    global_completion_stop_event.clear()
    q: queue.Queue = queue.Queue()
    start_time = time.perf_counter()

    def run():
        try:
            lock_wait_start = time.perf_counter()
            lock_acquired = _inference_lock.acquire(timeout=LOCK_WAIT_TIMEOUT)
            if not lock_acquired:
                q.put(("error", QueueTimeoutError(
                    f"排队等待超过 {LOCK_WAIT_TIMEOUT} 秒，服务繁忙，请稍后重试"
                )))
                return
            lock_wait_time = time.perf_counter() - lock_wait_start
            try:
                def stream_delta(text: str, stream_end: bool) -> None:
                    if completion_cancel_requested():
                        return
                    q.put(("delta", text, stream_end))

                result = _completion_inference_after_lock(
                    prompt,
                    request_id,
                    lock_wait_time,
                    stream_delta=stream_delta,
                    max_tokens=max_tokens,
                )
            finally:
                _inference_lock.release()
                gc.collect()
            q.put(("result", result))
        except Exception as e:
            q.put(("error", e))

    worker = threading.Thread(target=run, daemon=True)
    worker.start()

    try:
        while True:
            elapsed = time.perf_counter() - start_time
            if elapsed >= COMPLETION_WALL_CLOCK_TIMEOUT_SEC:
                try:
                    item = q.get_nowait()
                except queue.Empty:
                    global_completion_stop_event.set()
                    _log_cmpl_issue(
                        request_id,
                        f"墙钟超时 {elapsed:.1f}s / 上限 {COMPLETION_WALL_CLOCK_TIMEOUT_SEC:.0f}s",
                    )
                    yield send_error_event(
                        f"续写处理超过 {COMPLETION_WALL_CLOCK_TIMEOUT_SEC:.0f} 秒（墙钟限制），已中止",
                        504,
                    )
                    return
            else:
                try:
                    # 每 100ms 醒一次，检查一次是否到 60 秒
                    item = q.get(timeout=0.1)
                except queue.Empty:
                    continue
            kind = item[0]
            if kind == "delta":
                _, text, stream_end = item
                if text or stream_end:
                    yield send_completion_delta_event(text, stream_end)
            elif kind == "result":
                (
                    _completion_text,
                    finish_reason,
                    prompt_tokens,
                    completion_tokens,
                    bpe_strings,
                    ttft_s,
                ) = item[1]
                elapsed = time.perf_counter() - start_time
                if global_completion_stop_event.is_set() or inference_shutdown_event.is_set():
                    finish_reason = "abort"
                if inference_shutdown_event.is_set():
                    _log_cmpl_issue(
                        request_id,
                        f"进程终止，续写中止 elapsed={elapsed:.2f}s "
                        f"tokens={prompt_tokens}/{completion_tokens}",
                    )
                elif global_completion_stop_event.is_set():
                    _log_cmpl_issue(
                        request_id,
                        f"用户 Stop，续写中止 elapsed={elapsed:.2f}s "
                        f"tokens={prompt_tokens}/{completion_tokens}",
                    )
                else:
                    _log_completion_finished(
                        request_id,
                        prompt_tokens,
                        completion_tokens,
                        elapsed,
                        ttft_s,
                    )
                yield send_result_event(
                    _build_response(
                        _completion_text,
                        finish_reason,
                        prompt_tokens,
                        completion_tokens,
                        bpe_strings,
                    )
                )
                return
            elif kind == "error":
                err = item[1]
                if isinstance(err, PromptTooLongError):
                    _log_cmpl_issue(request_id, f"prompt too long: {err}")
                    yield send_error_event(str(err), 400)
                elif isinstance(err, QueueTimeoutError):
                    _log_cmpl_issue(request_id, f"排队超时: {err}")
                    yield send_error_event(str(err), 503)
                else:
                    exit_if_oom(err, defer_seconds=1)
                    if is_oom_error(err):
                        yield send_error_event(str(err), 500)
                        return
                    _log_cmpl_issue(
                        request_id,
                        "".join(
                            traceback.format_exception(
                                type(err), err, err.__traceback__
                            )
                        ).strip(),
                    )
                    yield send_error_event(str(err), 500)
                return
    finally:
        gc.collect()


def _completions_sse_response(
    prompt: str,
    request_id: int,
    *,
    max_tokens: Optional[int] = None,
):
    return SSEProgressReporter(
        lambda: _generate_completion_events(prompt, request_id, max_tokens=max_tokens)
    ).create_response()


def completions_stop():
    """
    单用户串行：置位全局停止标志，使当前续写在 generate 与 SSE 回调中尽快结束。
    无需 body；新一次 POST /v1/completions 时会在流式生成器入口清除该标志。
    """
    global_completion_stop_event.set()
    return {"ok": True}, 200


def completions_prompt(completions_prompt_request):
    """
    将用户原文套用 chat template，返回实际送入续写接口的完整 prompt 字符串（JSON）。

    Args:
        completions_prompt_request: 含 model、prompt（用户输入），见 server_openai_definitions.yaml

    Returns:
        (dict with prompt_used, 200) 或校验/过长错误
    """
    if not isinstance(completions_prompt_request, dict):
        completions_prompt_request = {}
    model = completions_prompt_request.get("model")
    prompt = completions_prompt_request.get("prompt")

    if not model:
        return {"success": False, "message": "缺少 model 字段"}, 400
    if prompt is None:
        return {"success": False, "message": "缺少 prompt 字段"}, 400
    if not isinstance(prompt, str):
        return {"success": False, "message": "prompt 必须为字符串"}, 400

    system_opt: Optional[str]
    if "system" not in completions_prompt_request:
        system_opt = None
    else:
        system_raw = completions_prompt_request.get("system")
        if not isinstance(system_raw, str):
            return {"success": False, "message": "system 必须为字符串"}, 400
        system_opt = system_raw

    client_ip = get_client_ip()
    from backend.access_log import log_openai_completions_prompt_request

    log_openai_completions_prompt_request(
        model,
        user_prompt=prompt,
        system=system_opt,
        client_ip=client_ip,
    )

    try:
        prompt_used = apply_chat_template_for_completion(prompt, system_opt)
    except PromptTooLongError as e:
        return {"success": False, "message": str(e)}, 400

    return {"prompt_used": prompt_used}, 200


def completions(completions_request):
    """
    文本补写：与 analyze_semantic 共用推理锁与 semantic 模型；响应恒为 text/event-stream（SSE）。
    ``prompt`` 须为已确定的完整模型输入（需 chat template 时请先调 POST /v1/completions/prompt）。

    Args:
        completions_request: 含 model、prompt 等，见 server_openai_definitions.yaml

    Returns:
        SSE Response；校验失败时 (错误体, 400/503/500)
    """
    if not isinstance(completions_request, dict):
        completions_request = {}
    model = completions_request.get("model")
    prompt = completions_request.get("prompt")

    if not model:
        return {"success": False, "message": "缺少 model 字段"}, 400
    if prompt is None:
        return {"success": False, "message": "缺少 prompt 字段"}, 400
    if not isinstance(prompt, str):
        return {"success": False, "message": "prompt 必须为字符串"}, 400

    max_tokens_raw = completions_request.get("max_tokens")
    max_tokens: Optional[int]
    if max_tokens_raw is None:
        max_tokens = None
    elif type(max_tokens_raw) is not int:
        return {"success": False, "message": "max_tokens 须为正整数"}, 400
    elif max_tokens_raw <= 0:
        return {"success": False, "message": "max_tokens 须 > 0"}, 400
    else:
        max_tokens = max_tokens_raw

    client_ip = get_client_ip()
    request_id = _log_request(model, prompt, client_ip)

    return _completions_sse_response(prompt, request_id, max_tokens=max_tokens)
