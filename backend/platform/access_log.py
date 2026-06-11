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
    from backend.platform.visit_stats import bump_api

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


def log_request(event_type: str, details: str = "", client_ip: str = None):
    """打印服务请求日志"""
    timestamp = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    ip = client_ip if client_ip is not None else _get_client_ip()
    
    log_msg = f"[{timestamp}] {ip:15s} | {event_type}"
    if details:
        log_msg += f" | {details}"
    
    print(log_msg)


def _log_str_preview(s: str, max_visible: int) -> str:
    """
    访问日志中的字符串预览：超过 max_visible 时省略中间，前后各保留约一半原文，
    中间统一为 ……（与旧版「仅前缀」使用相同的 max_visible 取值）。
    """
    if max_visible < 1:
        return s
    if len(s) <= max_visible:
        return s
    head = max_visible // 2
    tail = max_visible - head
    return s[:head] + "……" + s[-tail:]


def log_page_load(path: str):
    from backend.platform.app_context import get_verbose
    from backend.platform.visit_stats import record_page_load

    record_page_load()
    if not get_verbose():
        return
    try:
        qs = request.query_string.decode("utf-8", errors="replace")
        combined = f"{path}?{unquote(qs)}" if qs else path
    except RuntimeError:
        combined = path
    log_request("📄 页面访问", f"path={combined!r}")


def log_json_demo(path: str):
    """记录从 data 目录 ``/demo/`` 拉取的服务端 demo JSON。"""
    from backend.platform.app_context import get_verbose
    if not get_verbose():
        return
    log_request("🎯 json demo", f"file='{path}'")


def log_cached_demo(path: str):
    """记录从 ``client/dist`` 拉取的 .json（如打包的 gen_attribute demo）。"""
    from backend.platform.app_context import get_verbose
    if not get_verbose():
        return
    log_request("🎯 cached demo", f"file='{path}'")


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
    raw = text if text else ""
    text_preview = _log_str_preview(raw, preview_length)
    char_count = len(text) if text else 0
    byte_count = len(text.encode('utf-8')) if text else 0
    mode_str = "(stream)" if stream_mode else ""

    details = f"req_id={request_id}, text='{text_preview}', chars={char_count}, bytes={byte_count}"
    log_request(f"📥 收到请求{mode_str}", details, client_ip)

    _hit_api("analyze")
    return request_id


def log_analyze_start(request_id: int, wait_time: float, stream_mode: bool = False):
    """记录开始处理分析请求（内部事件）"""
    from backend.platform.app_context import get_verbose
    if not get_verbose():
        return
    mode_str = "(stream)" if stream_mode else ""
    print(f"\t🔄 API analyze {mode_str} start: req_id={request_id}, wait_time={wait_time:.2f}s")


def log_fetch_url(url: str, char_count: int = None):
    """记录URL抓取请求"""
    details = f"url='{url}'"
    if char_count is not None:
        details += f", chars={char_count}"
    log_request("🌐 URL抓取", details)


def log_check_admin(success: bool, token: str = None):
    """记录管理员权限检查"""
    status = "成功" if success else "失败"
    details = f"结果={status}"
    if not success and token:
        details += f", token='{token}'"
    log_request("🔐 管理员权限检查", details)


def log_analyze_semantic_start(request_id: int, wait_time: float, stream_mode: bool = False):
    """记录开始处理 semantic 分析请求（内部事件）"""
    from backend.platform.app_context import get_verbose
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
    q_preview = _log_str_preview(query, preview)
    t_preview = _log_str_preview(text, preview)
    details = f"req_id={request_id}, query='{q_preview}', text='{t_preview}', chars={len(text)}"
    log_request("📥 semantic 分析请求", details, client_ip)

    _hit_api("analyze_semantic")
    return request_id


def log_openai_completions_start(request_id: int, wait_time: float):
    """记录开始处理 OpenAI completions 请求（内部事件）"""
    from backend.platform.app_context import get_verbose
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
    p_preview = _log_str_preview(prompt, preview)
    details = (
        f"req_id={request_id}, model='{model}', "
        f"prompt='{p_preview}', chars={len(prompt)}"
    )
    log_request("📥 openai completions 请求", details, client_ip)
    _hit_api("chat")
    return request_id


def log_prediction_attribute_request(
    context: str,
    target_prediction: Optional[str],
    target_token_id: Optional[int],
    model: str,
    source_page: str,
    flow_id: Optional[str] = None,
    flow_step: Optional[int] = None,
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

    context_preview = 200
    c_preview = _log_str_preview(context, context_preview)
    if target_token_id is not None:
        target_show = f"<token_id:{target_token_id}>"
    else:
        target_show = "<top-1>" if target_prediction is None else target_prediction
    details = (
        f"req_id={request_id}, model={model!r}, source_page={source_page!r}, "
        f"context='{c_preview}', target='{target_show}', context_chars={len(context)}"
    )
    if flow_id is not None:
        details += f", flow_id={flow_id!r}, flow_step={flow_step}"

    # 连续 flow 第 1 步后不再打印入站请求，避免日志噪声。
    if flow_id is None or flow_step == 0:
        log_request("📥 prediction_attribute 请求", details, client_ip)

    is_flow_request = source_page == "causal_flow"
    if is_flow_request:
        if flow_step == 0:
            _hit_api("causal_flow")
        _hit_api("prediction_attribute")
    else:
        _hit_api(f"prediction_attribute__{source_page}.html")
    return request_id


def log_openai_completions_prompt_request(
    model: str,
    *,
    messages: list,
    enable_thinking: bool = False,
    tools_count: int = 0,
    client_ip: str = None,
) -> None:
    """记录 POST /v1/completions/prompt（仅拼装 chat template，不分配 req_id）。"""
    preview = 50
    user_msgs = [
        m["content"]
        for m in messages
        if isinstance(m, dict) and m.get("role") == "user" and isinstance(m.get("content"), str)
    ]
    last_user = user_msgs[-1] if user_msgs else ""
    flags = (
        f"enable_thinking={enable_thinking}, messages={len(messages)}, tools={tools_count}"
    )
    details = (
        f"model='{model}', {flags}, user_prompt='{_log_str_preview(last_user, preview)}'"
    )
    log_request("📥 openai completions/prompt 请求", details, client_ip)

