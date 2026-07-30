"""Semantic analysis API

原生接口：
- analyze_semantic_relevance：全文相关度（full_match_degree）
- analyze_semantic_keywords：关键词归因（token_attention）

兼容：analyze_semantic（submode=count|fill_blank）
"""
import gc
import json
import queue
import threading
import time
from typing import Literal, Optional

from backend.models.model_manager import inference_lock
from backend.platform.oom import exit_if_oom
from backend.core.semantic_analyzer import (
    analyze_relevance,
    analyze_relevance_batch,
    analyze_keywords,
)
from backend.api.sse_utils import (
    SSEProgressReporter,
    consume_progress_queue,
    send_result_event,
    send_error_event,
)
from backend.platform.access_log import get_client_ip
from backend.api.analyze import QueueTimeoutError, ANALYSIS_TIMEOUT, LOCK_WAIT_TIMEOUT

ResponseShape = Literal["legacy", "relevance", "keywords"]
SemanticKind = Literal["relevance", "keywords"]

_LEGACY_SUBMODE = {
    "count": "relevance",
    "fill_blank": "keywords",
}


def _log_request(query, text, client_ip=None, privacy_mode=False, kind: Optional[SemanticKind] = None):
    from backend.platform.access_log import log_analyze_semantic_request
    return log_analyze_semantic_request(query, text, client_ip, privacy_mode, kind=kind)


def _build_success_response(
    result,
    debug_info: bool = False,
    shape: ResponseShape = "legacy",
):
    """
    shape:
    - legacy：两字段都带（relevance 补 attention=[]；keywords 补 degree=1）
    - relevance：只带 full_match_degree
    - keywords：只带 token_attention
    """
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
        "input_token_count": result["input_token_count"],
    }
    if shape == "relevance":
        resp["full_match_degree"] = result["full_match_degree"]
    elif shape == "keywords":
        resp["token_attention"] = result["token_attention"]
    else:
        # legacy：原生结果缺哪边补哪边
        resp["full_match_degree"] = result["full_match_degree"] if "full_match_degree" in result else 1.0
        resp["token_attention"] = result["token_attention"] if "token_attention" in result else []
    if debug_info and "debug_info" in result:
        resp["debug_info"] = result["debug_info"]
    return resp


def _run_core(kind: SemanticKind, query: str, text, progress_callback, debug_info: bool):
    if kind == "relevance":
        if isinstance(text, list):
            return analyze_relevance_batch(query, text, progress_callback=progress_callback)
        return analyze_relevance(
            query, text, progress_callback=progress_callback, debug_info=debug_info,
        )
    if isinstance(text, list):
        raise ValueError("keywords does not support batch texts")
    return analyze_keywords(
        query, text, progress_callback=progress_callback, debug_info=debug_info,
    )


def _generate_semantic_events(
    query: str,
    text,
    kind: SemanticKind,
    debug_info: bool = False,
    client_ip: Optional[str] = None,
    request_id: Optional[int] = None,
    shape: ResponseShape = "legacy",
):
    """流式语义分析核心：生成 SSE 事件流（progress + result/error）。"""
    if client_ip is None:
        client_ip = get_client_ip()
    start_time = time.perf_counter()
    log_text = text if isinstance(text, str) else f"[批量 x{len(text)}] " + text[0]
    if request_id is None:
        request_id = _log_request(query, log_text, client_ip, kind=kind)

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
                log_analyze_semantic_start(request_id, lock_wait_time, stream_mode=True, kind=kind)
                analysis_result = _run_core(kind, query, text, progress_callback, debug_info)
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
        for kind_ev, event_str in consume_progress_queue(
            progress_queue, analysis_done, start_time, ANALYSIS_TIMEOUT, "语义分析"
        ):
            if kind_ev == 'timeout':
                timeout_reached = True
                yield event_str
                break
            if kind_ev == 'progress':
                yield event_str
            elif kind_ev == 'done':
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
            kind=kind,
        )
        yield send_result_event(_build_success_response(analysis_result, debug_info, shape=shape))
    except Exception as e:
        import traceback
        traceback.print_exc()
        exit_if_oom(e, defer_seconds=1)
        yield send_error_event(str(e), 500)
    finally:
        gc.collect()


def _analyze_semantic_with_stream(
    query: str, text, kind: SemanticKind, debug_info: bool = False,
    client_ip: Optional[str] = None, request_id: Optional[int] = None,
    shape: ResponseShape = "legacy",
):
    return SSEProgressReporter(
        lambda: _generate_semantic_events(
            query, text, kind, debug_info, client_ip, request_id, shape=shape,
        )
    ).create_response()


def _analyze_semantic_plain(
    query: str, text, kind: SemanticKind, debug_info: bool = False,
    client_ip: Optional[str] = None, request_id: Optional[int] = None,
    shape: ResponseShape = "legacy",
):
    result = None
    error_msg = None
    status_code = 500
    try:
        for event_str in _generate_semantic_events(
            query, text, kind, debug_info, client_ip, request_id, shape=shape,
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


def _ingress_semantic(
    semantic_request: dict,
    *,
    kind: SemanticKind,
    content,
    log_text: str,
    shape: ResponseShape,
):
    query = (semantic_request.get("query") or "")
    stream = semantic_request.get("stream", False)
    debug_info = bool(semantic_request.get("debug_info", False))
    privacy_mode = bool(semantic_request.get("privacy_mode", False))
    client_ip = get_client_ip()
    logged: dict = {"request_id": None}

    def log_fn():
        logged["request_id"] = _log_request(query, log_text, client_ip, privacy_mode, kind=kind)

    def local_fn():
        rid = logged["request_id"]
        if stream:
            return _analyze_semantic_with_stream(
                query, content, kind, debug_info, client_ip, rid, shape=shape,
            )
        return _analyze_semantic_plain(
            query, content, kind, debug_info, client_ip, rid, shape=shape,
        )

    from backend.models.model_manager import ModelSlot
    from backend.platform.inference_ingress import ingress_inference

    return ingress_inference(
        slot=ModelSlot.INSTRUCT,
        log_fn=log_fn,
        local_fn=local_fn,
    )


def _parse_text_or_texts(semantic_request, *, allow_texts: bool):
    """返回 (content, log_text) 或 (None, error_response)。"""
    query = (semantic_request.get("query") or "")
    if not query:
        return None, ({"success": False, "message": "Missing query"}, 400)

    texts = semantic_request.get("texts")
    text = semantic_request.get("text") or ""
    if texts is not None:
        if not allow_texts:
            return None, ({"success": False, "message": "texts is not supported on this endpoint"}, 400)
        if not isinstance(texts, list) or not texts or not all(isinstance(t, str) and t for t in texts):
            return None, ({"success": False, "message": "texts must be a non-empty string array"}, 400)
        return texts, f"[批量 x{len(texts)}] " + texts[0]

    if not text:
        return None, ({"success": False, "message": "Missing text"}, 400)
    return text, text


def analyze_semantic_relevance(semantic_request):
    """全文相关度：只返回 full_match_degree（可批量 texts）。"""
    content, log_or_err = _parse_text_or_texts(semantic_request, allow_texts=True)
    if content is None:
        return log_or_err
    return _ingress_semantic(
        semantic_request,
        kind="relevance",
        content=content,
        log_text=log_or_err,
        shape="relevance",
    )


def analyze_semantic_keywords(semantic_request):
    """关键词归因：只返回 token_attention（单条 text）。"""
    content, log_or_err = _parse_text_or_texts(semantic_request, allow_texts=False)
    if content is None:
        return log_or_err
    return _ingress_semantic(
        semantic_request,
        kind="keywords",
        content=content,
        log_text=log_or_err,
        shape="keywords",
    )


def analyze_semantic(semantic_request):
    """
    兼容旧接口：submode=count|fill_blank（映射到 relevance|keywords）。
    texts 批量仅支持 count（未传 submode 时按 count）。
    """
    texts = semantic_request.get("texts")
    submode = (semantic_request.get("submode") or "").strip() or None

    if submode == "match_score":
        return {"success": False, "message": "submode match_score has been removed"}, 400

    if texts is not None:
        if submode and submode != "count":
            return {"success": False, "message": "texts batch mode only supports submode=count"}, 400
        kind: SemanticKind = "relevance"
    else:
        mapped = _LEGACY_SUBMODE.get(submode or "fill_blank")
        if mapped is None:
            return {"success": False, "message": f"Unknown submode: {submode}"}, 400
        kind = mapped  # type: ignore[assignment]

    content, log_or_err = _parse_text_or_texts(semantic_request, allow_texts=True)
    if content is None:
        return log_or_err

    return _ingress_semantic(
        semantic_request,
        kind=kind,
        content=content,
        log_text=log_or_err,
        shape="legacy",
    )
