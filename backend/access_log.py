"""服务访问日志"""
from datetime import datetime
from typing import Optional
from urllib.parse import unquote

from flask import request
import threading


# 全局请求计数器和锁
_request_counter = 0
_request_counter_lock = threading.Lock()


def _hit_api(kind: str) -> None:
    from backend.visit_stats import bump_api

    bump_api(kind)


def _get_client_ip():
    """获取请求来源IP"""
    try:
        if request.headers.get('X-Forwarded-For'):
            return request.headers.get('X-Forwarded-For').split(',')[0].strip()
        elif request.headers.get('X-Real-IP'):
            return request.headers.get('X-Real-IP')
        else:
            return request.remote_addr
    except RuntimeError as e:
        if "Working outside of request context" in str(e):
            # 在没有请求上下文时返回本地地址
            return "unknown"
        else:
            raise


def get_client_ip():
    """获取客户端IP（供其他模块使用）"""
    return _get_client_ip()


def _log_request(event_type: str, details: str = "", client_ip: str = None):
    """打印服务请求日志"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ip = client_ip if client_ip is not None else _get_client_ip()
    
    log_msg = f"[{timestamp}] {ip:15s} | {event_type}"
    if details:
        log_msg += f" | {details}"
    
    print(log_msg)


def log_page_load(path: str):
    try:
        qs = request.query_string.decode("utf-8", errors="replace")
        combined = f"{path}?{unquote(qs)}" if qs else path
    except RuntimeError:
        combined = path
    _log_request("📄 页面访问", f"path={combined!r}")


def log_demo_file(path: str):
    """记录demo文件请求"""
    _log_request("🎯 demo文件", f"file='{path}'")


def log_analyze_request(text: str, stream_mode: bool = False, client_ip: str = None):
    """
    记录收到分析请求
    
    Returns:
        int: 请求ID
    """
    global _request_counter
    
    # 生成请求ID
    with _request_counter_lock:
        _request_counter += 1
        request_id = _request_counter
    
    preview_length = 100
    text_preview = text[:preview_length] + '......' if text and len(text) > preview_length else (text if text else '')
    char_count = len(text) if text else 0
    byte_count = len(text.encode('utf-8')) if text else 0
    mode_str = "(stream)" if stream_mode else ""

    details = f"req_id={request_id}, text='{text_preview}', chars={char_count}, bytes={byte_count}"
    _log_request(f"📥 收到请求{mode_str}", details, client_ip)

    _hit_api("analyze")
    return request_id


def log_analyze_start(request_id: int, wait_time: float, stream_mode: bool = False):
    """记录开始处理分析请求（内部事件）"""
    from backend.app_context import get_verbose
    if not get_verbose():
        return
    mode_str = "(stream)" if stream_mode else ""
    print(f"\t🔄 API analyze {mode_str} start: req_id={request_id}, wait_time={wait_time:.2f}s")


def log_fetch_url(url: str, char_count: int = None):
    """记录URL抓取请求"""
    details = f"url='{url}'"
    if char_count is not None:
        details += f", chars={char_count}"
    _log_request("🌐 URL抓取", details)


def log_check_admin(success: bool, token: str = None):
    """记录管理员权限检查"""
    status = "成功" if success else "失败"
    details = f"结果={status}"
    if not success and token:
        details += f", token='{token}'"
    _log_request("🔐 管理员权限检查", details)


def log_analyze_semantic_start(request_id: int, wait_time: float, stream_mode: bool = False):
    """记录开始处理 semantic 分析请求（内部事件）"""
    from backend.app_context import get_verbose
    if not get_verbose():
        return
    mode_str = "(stream)" if stream_mode else ""
    print(f"\t🔄 API analyze_semantic {mode_str} start: req_id={request_id}, wait_time={wait_time:.2f}s")


def log_analyze_semantic_request(query: str, text: str, client_ip: str = None):
    """
    记录收到 semantic 分析请求

    Returns:
        int: 请求ID
    """
    global _request_counter

    with _request_counter_lock:
        _request_counter += 1
        request_id = _request_counter

    preview = 50
    q_preview = query[:preview] + "..." if len(query) > preview else query
    t_preview = text[:preview] + "..." if len(text) > preview else text
    details = f"req_id={request_id}, query='{q_preview}', text='{t_preview}', chars={len(text)}"
    _log_request("📥 semantic 分析请求", details, client_ip)

    _hit_api("analyze_semantic")
    return request_id


def log_openai_completions_start(request_id: int, wait_time: float):
    """记录开始处理 OpenAI completions 请求（内部事件）"""
    from backend.app_context import get_verbose
    if not get_verbose():
        return
    print(f"\t🔄 API openai_completions start: req_id={request_id}, wait_time={wait_time:.2f}s")


def log_openai_completions_request(
    model: str, prompt: str, client_ip: str = None,
):
    """
    记录收到 OpenAI completions 请求

    Returns:
        int: 请求ID
    """
    global _request_counter

    with _request_counter_lock:
        _request_counter += 1
        request_id = _request_counter

    preview = 100
    p_preview = prompt[:preview] + "..." if len(prompt) > preview else prompt
    details = (
        f"req_id={request_id}, model='{model}', "
        f"prompt='{p_preview}', chars={len(prompt)}"
    )
    _log_request("📥 openai completions 请求", details, client_ip)
    _hit_api("chat")
    return request_id


def log_prediction_attribute_request(
    context: str,
    target_prediction: Optional[str],
    model: str,
    client_ip: str = None,
) -> int:
    """
    记录收到 prediction_attribute 请求。

    Returns:
        int: 请求 ID（与其它 API 的 req_id 同源递增）
    """
    global _request_counter

    with _request_counter_lock:
        _request_counter += 1
        request_id = _request_counter

    context_preview = 150
    c_preview = (
        context[:context_preview] + "..."
        if len(context) > context_preview
        else context
    )
    target_show = "<top-1>" if target_prediction is None else target_prediction
    details = (
        f"req_id={request_id}, model={model!r}, context='{c_preview}', target='{target_show}', "
        f"context_chars={len(context)}"
    )
    _log_request("📥 prediction_attribute 请求", details, client_ip)

    _hit_api("prediction_attribute")
    return request_id


def log_openai_completions_prompt_request(
    model: str,
    user_prompt: str,
    system: Optional[str] = None,
    client_ip: str = None,
) -> None:
    """记录 POST /v1/completions/prompt（仅拼装 chat template，不分配 req_id）。"""
    preview = 50

    def _pv(s: str) -> str:
        return s[:preview] + "..." if len(s) > preview else s

    up = _pv(user_prompt)
    if system is None:
        details = f"model='{model}', user_prompt='{up}'"
    else:
        details = f"model='{model}', system='{_pv(system)}', user_prompt='{up}'"
    _log_request("📥 openai completions/prompt 请求", details, client_ip)

