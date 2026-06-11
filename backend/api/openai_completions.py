"""OpenAI 兼容 /v1/completions：语义分析同款模型续写，其余响应字段固定。"""

import gc
import queue
import threading
import time
import traceback
from typing import Any, Callable, Dict, List, Optional, Tuple

from backend.models.model_manager import (
    ModelSlot,
    inference_lock,
    get_base_model_display_name,
    get_instruct_model_display_name,
)
from backend.core.prediction_attributor import slot_for_prediction_attr_model
from backend.platform.oom import exit_if_oom, is_oom_error
from backend.api.utils import request_has_valid_admin
from backend.core.completion_generator import (
    ModelContextLimitUnknownError,
    PromptTooLongError,
    apply_chat_template_for_completion,
    compute_tool_append_suffix,
    completion_cancel_requested,
    completion_max_token_length,
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
from backend.platform.access_log import get_client_ip

# 单次续写 SSE：从进入流式生成器起算的墙钟上限（含排队等推理锁 + 生成）。
COMPLETION_WALL_CLOCK_TIMEOUT_SEC = 300.0


def _log_cmpl_issue(request_id: int, msg: str) -> None:
    """续写非正常结束时一行说明（与成功时的 ``_log_completion_finished`` 二选一）。"""
    print(f"\t⚠️ openai_completions req_id={request_id}: {msg}")


def _log_request(model: str, prompt: str, client_ip=None):
    from backend.platform.access_log import log_openai_completions_request
    return log_openai_completions_request(model, prompt, client_ip)


def _model_display_name_for_slot(slot: ModelSlot) -> str:
    if slot == ModelSlot.BASE:
        return get_base_model_display_name()
    return get_instruct_model_display_name()


def _build_response(
    completion_text: str,
    finish_reason: str,
    prompt_tokens: int,
    completion_tokens: int,
    bpe_strings: List[Dict[str, Any]],
    *,
    model_display: str,
):
    """OpenAICompletionsResponse：choices + usage；info_radar 为续写 token 级数据。"""
    total = prompt_tokens + completion_tokens
    return {
        "id": "cmpl-stub-info-radar",
        "object": "text_completion",
        "created": int(time.time()),
        "model": model_display,
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
    slot: ModelSlot,
    stream_delta: Optional[Callable[[str, bool], None]] = None,
    max_tokens: Optional[int] = None,
    bypass_site_context_limit: bool = False,
) -> CompletionRunResult:
    """
    在已持有推理锁的上下文中执行续写（旧版非流式路径的持锁体内逻辑）。
    流式可传 stream_delta；中止由 ``completion_cancel_requested()`` 统一判断。
    """
    from backend.platform.access_log import log_openai_completions_start

    log_openai_completions_start(request_id, lock_wait_time)
    return generate_completion_text(
        prompt,
        stream_delta=stream_delta,
        max_tokens=max_tokens,
        bypass_site_context_limit=bypass_site_context_limit,
        slot=slot,
    )


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
    slot: ModelSlot,
    model_display: str,
    max_tokens: Optional[int] = None,
    bypass_site_context_limit: bool = False,
):
    global_completion_stop_event.clear()
    q: queue.Queue = queue.Queue()
    start_time = time.perf_counter()

    def run():
        try:
            lock_wait_start = time.perf_counter()
            lock_acquired = inference_lock.acquire(timeout=LOCK_WAIT_TIMEOUT)
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
                    slot=slot,
                    stream_delta=stream_delta,
                    max_tokens=max_tokens,
                    bypass_site_context_limit=bypass_site_context_limit,
                )
            finally:
                inference_lock.release()
                gc.collect()
            q.put(("result", result))
        except Exception as e:
            q.put(("error", e))

    worker = threading.Thread(target=run, daemon=True)
    worker.start()

    wall_clock_timed_out = False

    # 墙钟超时与用户 Stop 同路：置位 global_completion_stop_event，等 worker 末条 result（abort）。
    # 正常路径由 completion_cancel_requested + StoppingCriteria 结束 generate；排队仅 LOCK_WAIT_TIMEOUT。
    # 仅在与 Stop 相同的推理僵死（如 CUDA 挂死）时 SSE 可能一直等 result，旧 504 即时断开亦无法回收 worker。
    try:
        while True:
            elapsed = time.perf_counter() - start_time
            if (
                not wall_clock_timed_out
                and elapsed >= COMPLETION_WALL_CLOCK_TIMEOUT_SEC
            ):
                global_completion_stop_event.set()
                wall_clock_timed_out = True
                _log_cmpl_issue(
                    request_id,
                    f"墙钟超时 {elapsed:.1f}s / 上限 {COMPLETION_WALL_CLOCK_TIMEOUT_SEC:.0f}s",
                )
            try:
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
                    stop_label = "墙钟超时" if wall_clock_timed_out else "用户 Stop"
                    _log_cmpl_issue(
                        request_id,
                        f"{stop_label}，续写中止 elapsed={elapsed:.2f}s "
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
                        model_display=model_display,
                    )
                )
                return
            elif kind == "error":
                err = item[1]
                if isinstance(err, (PromptTooLongError, ModelContextLimitUnknownError)):
                    _log_cmpl_issue(request_id, str(err))
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
    slot: ModelSlot,
    model_display: str,
    max_tokens: Optional[int] = None,
    bypass_site_context_limit: bool = False,
):
    return SSEProgressReporter(
        lambda: _generate_completion_events(
            prompt,
            request_id,
            slot=slot,
            model_display=model_display,
            max_tokens=max_tokens,
            bypass_site_context_limit=bypass_site_context_limit,
        )
    ).create_response()


def completions_stop():
    """
    单用户串行：置位全局停止标志，使当前续写在 generate 与 SSE 回调中尽快结束。
    无需 body；新一次 POST /v1/completions 时会在流式生成器入口清除该标志。
    """
    global_completion_stop_event.set()
    return {"ok": True}, 200


def _parse_chat_messages_from_prompt_request(
    body: Dict[str, Any],
) -> Tuple[Optional[List[Dict[str, Any]]], Optional[Dict[str, Any]]]:
    """从 completions/prompt 请求体解析 messages。返回 (messages, error_response)。"""
    raw_messages = body.get("messages")
    if raw_messages is None:
        return None, {"success": False, "message": "缺少 messages 字段"}
    if not isinstance(raw_messages, list) or len(raw_messages) == 0:
        return None, {"success": False, "message": "messages 须为非空数组"}
    messages: List[Dict[str, Any]] = []
    for i, item in enumerate(raw_messages):
        if not isinstance(item, dict):
            return None, {"success": False, "message": f"messages[{i}] 须为对象"}
        role = item.get("role")
        if role not in ("system", "user", "assistant", "tool"):
            return None, {
                "success": False,
                "message": f"messages[{i}].role 无效: {role!r}",
            }
        content = item.get("content")
        if not isinstance(content, str):
            return None, {
                "success": False,
                "message": f"messages[{i}].content 须为字符串",
            }
        msg: Dict[str, Any] = {"role": role, "content": content}
        if role == "tool":
            name = item.get("name")
            if not isinstance(name, str) or not name:
                return None, {
                    "success": False,
                    "message": f"messages[{i}].name 在 role=tool 时必填",
                }
            msg["name"] = name
        messages.append(msg)
    return messages, None


def _parse_tools_from_prompt_request(
    body: Dict[str, Any],
) -> Tuple[Optional[List[Dict[str, Any]]], Optional[Dict[str, Any]]]:
    """解析 tools 数组；``enable_tool_calling`` 已废弃，须显式传 tools。"""
    tools_raw = body.get("tools")
    if tools_raw is None:
        enable_tool_calling_raw = body.get("enable_tool_calling")
        if enable_tool_calling_raw is True:
            return None, {
                "success": False,
                "message": "enable_tool_calling 已废弃，请传 tools 数组",
            }
        return None, None

    if not isinstance(tools_raw, list):
        return None, {"success": False, "message": "tools 须为数组"}
    return tools_raw, None


def completions_prompt(completions_prompt_request):
    """
    将 messages 套用 chat template，返回实际送入续写接口的完整 prompt 字符串（JSON）。

    Args:
        completions_prompt_request: 含 model、messages，见 server_openai_definitions.yaml

    Returns:
        (dict with prompt_used, 200) 或校验/过长错误
    """
    if not isinstance(completions_prompt_request, dict):
        completions_prompt_request = {}
    model = completions_prompt_request.get("model")

    if not model:
        return {"success": False, "message": "缺少 model 字段"}, 400

    messages, msg_err = _parse_chat_messages_from_prompt_request(completions_prompt_request)
    if msg_err is not None:
        return msg_err, 400

    tools, tools_err = _parse_tools_from_prompt_request(completions_prompt_request)
    if tools_err is not None:
        return tools_err, 400

    enable_thinking_raw = completions_prompt_request.get("enable_thinking")
    if enable_thinking_raw is None:
        enable_thinking = False
    elif not isinstance(enable_thinking_raw, bool):
        return {"success": False, "message": "enable_thinking 必须为布尔值"}, 400
    else:
        enable_thinking = enable_thinking_raw

    client_ip = get_client_ip()
    from backend.platform.access_log import log_openai_completions_prompt_request

    log_openai_completions_prompt_request(
        model,
        messages=messages,
        enable_thinking=enable_thinking,
        tools_count=len(tools) if tools else 0,
        client_ip=client_ip,
    )

    try:
        slot = slot_for_prediction_attr_model(model)
    except ValueError as e:
        return {"success": False, "message": str(e)}, 400

    try:
        prompt_used = apply_chat_template_for_completion(
            messages,
            slot=slot,
            enable_thinking=enable_thinking,
            tools=tools,
        )
    except PromptTooLongError as e:
        return {"success": False, "message": str(e)}, 400

    return {"prompt_used": prompt_used}, 200


def completions_prompt_incremental(completions_prompt_incremental_request):
    """
    计算多轮 wire 模式下 tool response 的增量后缀（incremental_suffix）。

    wire 在模型输出 O_n（含 <|im_end|>）后，需追加本函数返回的字符串，
    以构成下一轮生成的完整输入。suffix 仅取决于 tool_content 和 enable_thinking，
    与前序历史内容无关。

    Args:
        completions_prompt_incremental_request: 含 model、tool_content，见 server_openai_definitions.yaml

    Returns:
        (dict with incremental_suffix, 200) 或校验错误
    """
    if not isinstance(completions_prompt_incremental_request, dict):
        completions_prompt_incremental_request = {}
    model = completions_prompt_incremental_request.get("model")

    if not model:
        return {"success": False, "message": "缺少 model 字段"}, 400

    tool_content = completions_prompt_incremental_request.get("tool_content")
    if not isinstance(tool_content, str):
        return {"success": False, "message": "tool_content 须为字符串"}, 400

    tool_name = completions_prompt_incremental_request.get("tool_name")
    if tool_name is not None and not isinstance(tool_name, str):
        return {"success": False, "message": "tool_name 须为字符串"}, 400

    enable_thinking_raw = completions_prompt_incremental_request.get("enable_thinking")
    if enable_thinking_raw is None:
        enable_thinking = False
    elif not isinstance(enable_thinking_raw, bool):
        return {"success": False, "message": "enable_thinking 必须为布尔值"}, 400
    else:
        enable_thinking = enable_thinking_raw

    try:
        slot = slot_for_prediction_attr_model(model)
    except ValueError as e:
        return {"success": False, "message": str(e)}, 400

    try:
        suffix = compute_tool_append_suffix(
            tool_content,
            enable_thinking=enable_thinking,
            tool_name=tool_name or None,
            slot=slot,
        )
    except RuntimeError as e:
        return {"success": False, "message": str(e)}, 500

    return {"incremental_suffix": suffix}, 200


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

    bypass_site = request_has_valid_admin() and max_tokens is not None
    if (
        not bypass_site
        and max_tokens is not None
        and max_tokens > completion_max_token_length
    ):
        return {
            "success": False,
            "message": (
                f"max_tokens 不得超过续写上下文上限 {completion_max_token_length}"
            ),
        }, 400

    try:
        slot = slot_for_prediction_attr_model(model)
    except ValueError as e:
        return {"success": False, "message": str(e)}, 400

    client_ip = get_client_ip()
    request_id = _log_request(model, prompt, client_ip)

    return _completions_sse_response(
        prompt,
        request_id,
        slot=slot,
        model_display=_model_display_name_for_slot(slot),
        max_tokens=max_tokens,
        bypass_site_context_limit=bypass_site,
    )
