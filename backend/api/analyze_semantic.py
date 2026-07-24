"""Semantic analysis API：返回原文各 token 对 query 的归因 score（字段名 token_attention 为历史遗留）"""
import gc
import json
import queue
import threading
import time
from typing import Optional

from backend.models.model_manager import inference_lock
from backend.platform.oom import exit_if_oom
from backend.core.semantic_analyzer import analyze_semantic as _analyze_semantic
from backend.api.sse_utils import (
    SSEProgressReporter,
    consume_progress_queue,
    send_result_event,
    send_error_event,
)
from backend.platform.access_log import get_client_ip
from backend.api.analyze import QueueTimeoutError, ANALYSIS_TIMEOUT, LOCK_WAIT_TIMEOUT


def _log_request(query, text, client_ip=None, privacy_mode=False):
    from backend.platform.access_log import log_analyze_semantic_request
    return log_analyze_semantic_request(query, text, client_ip, privacy_mode)


def _build_success_response(result, debug_info: bool = False):
    """构建成功响应。debug_info=True 时包含 debug_info 对象（abbrev、topk_tokens、topk_probs）。
    result 为 List 时（批量 full_match_degree_only），返回 {"success", "results": [...]}。
    带 input_token_count：full_match_degree_only 时 token_attention 为空，门户 response 日志靠它打 tokens。
    分析器必须产出该字段；缺则 KeyError，不静默填默认值。"""
    if isinstance(result, list):
        return {
            "success": True,
            "results": [
                {
                    "model": r["model"],
                    "full_match_degree": r["full_match_degree"],
                    "input_token_count": r["input_token_count"],
                }
                for r in result
            ],
        }
    resp = {
        "success": True,
        "model": result["model"],
        "token_attention": result["token_attention"],
        "full_match_degree": result["full_match_degree"],
        "input_token_count": result["input_token_count"],
    }
    if debug_info and "debug_info" in result:
        resp["debug_info"] = result["debug_info"]
    return resp


def _generate_semantic_events(
    query: str, text: str, submode: Optional[str] = None, debug_info: bool = False,
    full_match_degree_only: bool = False, client_ip: Optional[str] = None,
    request_id: Optional[int] = None,
):
    """
    流式语义分析核心：生成 SSE 事件流（progress + result/error）。
    供 _analyze_semantic_with_stream 和 _analyze_semantic_plain 复用。
    client_ip 需在入口处获取并传入，因流式响应时生成器执行时请求上下文已失效。
    """
    if client_ip is None:
        client_ip = get_client_ip()
    start_time = time.perf_counter()
    if request_id is None:
        request_id = _log_request(query, text, client_ip)

    progress_queue = queue.Queue()
    analysis_done = threading.Event()
    analysis_result = None
    analysis_error = None
    lock_wait_time = None

    def progress_callback(step: int, total_steps: int, stage: str, percentage: Optional[int]):
        progress_queue.put(("progress", step, total_steps, stage, percentage))

    def run_analysis():
        nonlocal analysis_result, analysis_error, lock_wait_time
        try:
            lock_wait_start = time.perf_counter()
            lock_acquired = inference_lock.acquire(timeout=LOCK_WAIT_TIMEOUT)
            if not lock_acquired:
                analysis_error = QueueTimeoutError(
                    f"Queue wait exceeded {LOCK_WAIT_TIMEOUT} seconds; server busy, try again later"
                )
                return
            lock_wait_time = time.perf_counter() - lock_wait_start

            try:
                from backend.platform.access_log import log_analyze_semantic_start
                log_analyze_semantic_start(request_id, lock_wait_time, stream_mode=True)
                result = _analyze_semantic(query, text, submode_override=submode, progress_callback=progress_callback, debug_info=debug_info, full_match_degree_only=full_match_degree_only)
                analysis_result = result
            finally:
                inference_lock.release()
        except Exception as e:
            analysis_error = e
        finally:
            analysis_done.set()
            progress_queue.put(("done", None, None))

    try:
        analysis_thread = threading.Thread(target=run_analysis, daemon=True)
        analysis_thread.start()

        timeout_reached = False
        for kind, event_str in consume_progress_queue(
            progress_queue, analysis_done, start_time, ANALYSIS_TIMEOUT, "语义分析"
        ):
            if kind == 'timeout':
                timeout_reached = True
                yield event_str
                break
            if kind == 'progress':
                yield event_str
            elif kind == 'done':
                break

        if timeout_reached:
            gc.collect()
            return

        if analysis_error:
            if isinstance(analysis_error, QueueTimeoutError):
                print(f"⏱️ 排队超时: {analysis_error}")
                yield send_error_event(str(analysis_error), 503)
                gc.collect()
                return
            raise analysis_error

        if analysis_result is None:
            print("⚠️ 语义分析结果为空，但没有错误信息")
            yield send_error_event("Analysis failed: no result", 500)
            gc.collect()
            return

        elapsed = time.perf_counter() - start_time
        from backend.platform.inference_response_log import log_analyze_semantic_response
        from backend.platform.model_routing import is_worker

        # 本地执行机打完整日志（含 wait/processing）；远程代理门户走 response_log_fn
        if isinstance(analysis_result, dict):
            log_result = analysis_result
        else:
            total_tokens = sum(r.get("input_token_count", 0) for r in analysis_result)
            log_result = {"input_token_count": total_tokens}
        log_analyze_semantic_response(
            request_id=request_id,
            result=log_result,
            elapsed=elapsed,
            wait_time=lock_wait_time,
            for_worker=is_worker(),
        )
        yield send_result_event(_build_success_response(analysis_result, debug_info))
    except Exception as e:
        import traceback
        traceback.print_exc()
        exit_if_oom(e, defer_seconds=1)
        yield send_error_event(str(e), 500)
    finally:
        gc.collect()


def _analyze_semantic_with_stream(
    query: str, text: str, submode: Optional[str] = None, debug_info: bool = False,
    full_match_degree_only: bool = False, client_ip: Optional[str] = None,
    request_id: Optional[int] = None,
):
    """流式语义分析，通过 SSE 返回阶段级进度"""
    return SSEProgressReporter(
        lambda: _generate_semantic_events(
            query, text, submode, debug_info, full_match_degree_only, client_ip, request_id
        )
    ).create_response()


def _analyze_semantic_plain(
    query: str, text: str, submode: Optional[str] = None, debug_info: bool = False,
    full_match_degree_only: bool = False, client_ip: Optional[str] = None,
    request_id: Optional[int] = None,
):
    """
    非流式语义分析：封装流式实现，消费事件流后返回 JSON。
    供脚本等简单客户端使用。
    """
    result = None
    error_msg = None
    status_code = 500
    try:
        for event_str in _generate_semantic_events(
            query, text, submode, debug_info, full_match_degree_only, client_ip, request_id
        ):
            if not event_str.startswith('data: '):
                continue
            data = json.loads(event_str[6:].strip())
            t = data.get('type')
            if t == 'result':
                result = data.get('data')
            elif t == 'error':
                error_msg = data.get('message', 'Analysis failed')
                status_code = data.get('status_code', 500)
                break
    except Exception as e:
        import traceback
        traceback.print_exc()
        exit_if_oom(e, defer_seconds=1)
        error_msg = str(e)
    finally:
        gc.collect()

    if error_msg:
        return {"success": False, "message": error_msg}, status_code
    if result is None:
        return {"success": False, "message": "Analysis failed: no result"}, 500
    return result, 200


def analyze_semantic(semantic_request):
    """
    分析原文 token 对 prompt 的关注度。

    Args:
        semantic_request: 包含 query、text、stream（可选）、submode（可选）的字典。
            texts（可选，字符串数组）：批量 full_match_degree_only 预判性能测试用，
            与 text 互斥，且必须搭配 full_match_degree_only=True。

            性能结论（详见 backend/core/semantic_analyzer.py 的
            _analyze_logits_gradient_batch）：
            batching 对模型前向计算本身的加速有限（batch=4 约 1.5x，batch=8 约
            1.6x），线上用客户端总耗时测出的更高加速比主要是摊薄了每次 HTTP
            请求固定的网络/SSE 开销，并非计算变快；因此若追求性能，合并请求本身
            比加大 batch 更有效，batch 也不宜设得过大。

    Returns:
        stream=True 时返回 SSE 响应；否则返回 (响应字典, 状态码) 元组
    """
    query = (semantic_request.get("query") or "")
    text = semantic_request.get("text") or ""
    texts = semantic_request.get("texts")
    stream = semantic_request.get("stream", False)
    submode = (semantic_request.get("submode") or "").strip() or None
    debug_info = bool(semantic_request.get("debug_info", False))
    full_match_degree_only = bool(semantic_request.get("full_match_degree_only", False))
    privacy_mode = bool(semantic_request.get("privacy_mode", False))

    if not query:
        return {"success": False, "message": "Missing query"}, 400

    if texts is not None:
        if not isinstance(texts, list) or not texts or not all(isinstance(t, str) and t for t in texts):
            return {"success": False, "message": "texts must be a non-empty string array"}, 400
        if not full_match_degree_only:
            return {"success": False, "message": "texts batch mode requires full_match_degree_only=True"}, 400
        content = texts
        log_text = f"[批量 x{len(texts)}] " + texts[0]
    else:
        if not text:
            return {"success": False, "message": "Missing text"}, 400
        content = text
        log_text = text

    client_ip = get_client_ip()
    logged: dict = {"request_id": None}

    def log_fn():
        logged["request_id"] = _log_request(query, log_text, client_ip, privacy_mode)

    def local_fn():
        rid = logged["request_id"]
        if stream:
            return _analyze_semantic_with_stream(
                query, content, submode, debug_info, full_match_degree_only, client_ip, rid
            )
        return _analyze_semantic_plain(
            query, content, submode, debug_info, full_match_degree_only, client_ip, rid
        )

    from backend.models.model_manager import ModelSlot
    from backend.platform.inference_ingress import ingress_inference
    from backend.platform.inference_response_log import make_analyze_semantic_response_logger
    from backend.platform.model_routing import is_local

    # 本地执行：handler 已打完整日志；仅远程代理时门户用 response_log_fn 打端到端
    return ingress_inference(
        slot=ModelSlot.INSTRUCT,
        api_path="/api/analyze-semantic",
        json_body=semantic_request,
        stream=bool(stream),
        timeout=60.0,
        log_fn=log_fn,
        local_fn=local_fn,
        response_log_fn=(
            None
            if is_local(ModelSlot.INSTRUCT)
            else make_analyze_semantic_response_logger(logged)
        ),
    )
