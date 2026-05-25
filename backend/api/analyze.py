"""文本分析 API"""
import gc
import json
import time
import queue
import threading
from typing import Optional
from backend.platform.schemas import create_empty_analysis_result
from backend.models.model_manager import project_registry, DEFAULT_BASE_MODEL, inference_lock
from model_paths import resolve_hf_path
from backend.platform.oom import exit_if_oom
from backend.api.sse_utils import (
    SSEProgressReporter,
    consume_progress_queue,
    send_result_event,
    send_error_event,
)


# 自定义异常：排队超时
class QueueTimeoutError(Exception):
    """排队等待获取锁超时"""
    pass


# 使用 model_manager 中的统一推理锁（与 analyze_semantic 共用）
# 单次分析的总处理时长限制（秒）
ANALYSIS_TIMEOUT = 60.0
# 等待获取锁的最大时间（秒）- 如果排队时间过长，直接拒绝请求
LOCK_WAIT_TIMEOUT = 10.0


def _analyze_result_model_display(model: Optional[str]) -> Optional[str]:
    """主分析 result.model：对外统一为 HuggingFace 仓库 id（与 model_paths.resolve_hf_path 一致）。"""
    if not model or not str(model).strip():
        return None
    return resolve_hf_path(str(model).strip())


def _build_response(model: str, text: str, result):
    """构建标准响应"""
    # 将 model 添加到 result 中，并确保 model 在最前面
    if not isinstance(result, dict):
        result = {}
    result = result.copy()
    # 如果 result 中已有 model，先移除
    if 'model' in result:
        model_value = result.pop('model')
    else:
        model_value = model
    # 重新构建 result，确保 model 在最前面
    result = {'model': _analyze_result_model_display(model_value), **result}
    return {
        "request": {'text': text},
        "result": result
    }


def _error_response(model: str, text: str, message: str, status_code: int):
    """构建错误响应（统一格式）"""
    # 统一错误格式：包含 success=false 和 message
    result = create_empty_analysis_result(message, _analyze_result_model_display(model))
    return {
        "success": False,
        "message": message,
        "request": {'text': text or ''},
        "result": result
    }, status_code


def _validate_and_prepare_request(analyze_request):
    """
    验证请求并准备参数
    
    Returns:
        (model, text, error_msg, status_code) 元组
        如果验证失败，返回 (None, None, error_msg, status_code)
        如果成功，返回 (model, text, None, None)
    """
    model = analyze_request.get('model')
    text = analyze_request.get('text')
    
    if not text:
        return None, None, "缺少分析文本，请提供 text 字段", 400
    
    # 获取默认模型（使用模块级上下文以获取持久化的当前活动模型）
    from backend.platform.app_context import get_app_context
    context = get_app_context(prefer_module_context=True)
    default_model = context.base_model_id if context.base_model_id else DEFAULT_BASE_MODEL
    
    # 处理 default、None 或空字符串，使用默认模型
    if not model or model == 'default' or model == '':
        model = default_model
    else:
        # 只允许使用默认模型，其他模型请求将被拒绝
        if model != default_model:
            return None, None, f"当前仅支持默认模型 '{default_model}'，不允许使用其他模型", 400
    
    return model, text, None, None


def _load_project_with_error_handling(model):
    """
    获取已加载的模型；若未加载则根据配置进行懒加载或返回错误。
    
    Returns:
        (project_obj, error_msg, status_code) 元组
        如果成功，返回 (project_obj, None, None)
        如果失败，返回 (None, error_msg, status_code)
    """
    # 检查模型是否在注册表中
    if not project_registry.is_available(model):
        available_models = list(project_registry.available_model_names())
        error_msg = f"❌ 模型 '{model}' 未注册。可用模型: {available_models}"
        print(error_msg)
        return None, error_msg, 404
    
    # 检查模型是否已加载
    p = project_registry.get(model)
    if p is None:
        from backend.platform.app_context import get_app_context
        from backend.models.model_manager import ensure_base_slot_ready

        context = get_app_context(prefer_module_context=True)
        if context.model_loading:
            error_msg = f"模型 '{model}' 正在后台加载中，请稍后重试"
            print(f"⚠️ {error_msg}")
            return None, error_msg, 503
        # 懒加载模式 (--no_auto_load)：首次请求仅初始化主槽位（权重 + QwenLM 项目）
        if getattr(context.args, 'no_auto_load', False):
            try:
                ensure_base_slot_ready()
                p = project_registry.get(model)
            except Exception as e:  # noqa: BLE001
                import traceback
                print(f"⚠️ 模型懒加载失败: {e}")
                traceback.print_exc()
                return None, f"模型加载失败: {str(e)}", 500
        if p is None:
            error_msg = f"模型 '{model}' 未加载，请联系管理员"
            print(f"⚠️ {error_msg}")
            return None, error_msg, 503
    return p, None, None


def _log_request(text, stream_mode=False, client_ip=None):
    """
    打印请求日志
    
    Returns:
        int: 请求ID
    """
    from backend.platform.access_log import log_analyze_request
    return log_analyze_request(text, stream_mode, client_ip)


def _log_response(res, char_count, elapsed_time, stream_mode=False, request_id=None, wait_time=None):
    """打印响应日志"""
    tokens = len(res.get('bpe_strings', []))
    text_length = char_count
    mode_str = "(stream)" if stream_mode else ""
    
    # 构建日志消息
    msg = f"\t📤 API analyze {mode_str} response:"
    if request_id is not None:
        msg += f" req_id={request_id},"
    msg += f" tokens={tokens}, text_length={text_length}"
    msg += f", response_time={elapsed_time:.4f}s"
    
    print(msg)


def _validate_and_fix_result(res):
    """验证和修复结果结构"""
    if not isinstance(res, dict):
        res = {'bpe_strings': []}
    if 'bpe_strings' not in res or not isinstance(res.get('bpe_strings'), list):
        res['bpe_strings'] = res.get('bpe_strings', []) if isinstance(res.get('bpe_strings'), list) else []
    return res


def analyze(analyze_request):
    """
    分析文本

    Args:
        analyze_request: 分析请求字典，包含：
            - model: 模型名称
            - text: 要分析的文本
            - stream: 可选，如果为 True 则返回 SSE 流式响应（带进度信息）

    Returns:
        如果 stream=True: SSE 响应对象
        否则: (响应字典, 状态码) 元组
    """
    # 检查模型是否正在加载中（使用模块级上下文）
    from backend.platform.app_context import get_app_context
    context = get_app_context(prefer_module_context=True)
    if context.model_loading:
        return _error_response('', '', '模型正在加载中，请稍后重试', 503)

    # 在请求上下文中获取 client_ip，流式响应时生成器内可能已失效
    from backend.platform.access_log import get_client_ip
    client_ip = get_client_ip()

    # 检查是否启用流式响应
    stream = analyze_request.get('stream', False)
    if stream:
        return _analyze_with_stream(analyze_request, client_ip)
    return _analyze_plain(analyze_request, client_ip)


def _analyze_with_stream(analyze_request, client_ip):
    """
    流式分析文本，通过SSE返回进度和结果（内部函数）

    Args:
        analyze_request: 分析请求字典，包含 model 和 text
        client_ip: 客户端 IP，在入口处获取后传入

    Returns:
        SSE响应对象
    """
    reporter = SSEProgressReporter(lambda: _generate_analyze_events(analyze_request, client_ip))
    return reporter.create_response()


def _analyze_plain(analyze_request, client_ip):
    """
    非流式分析：封装流式实现，消费事件流后返回 JSON。
    供脚本等简单客户端使用。
    """
    result = None
    error_msg = None
    status_code = 500
    try:
        for event_str in _generate_analyze_events(analyze_request, client_ip):
            if not event_str.startswith('data: '):
                continue
            data = json.loads(event_str[6:].strip())
            t = data.get('type')
            if t == 'result':
                result = data.get('data')
            elif t == 'error':
                error_msg = data.get('message', '分析失败')
                status_code = data.get('status_code', 500)
                break
    except Exception as e:
        import traceback
        traceback.print_exc()
        exit_if_oom(e, defer_seconds=1)
        error_msg = f"分析失败: {str(e)}"
    finally:
        gc.collect()

    if error_msg:
        model = analyze_request.get('model') or ''
        text = analyze_request.get('text') or ''
        return _error_response(model, text, error_msg, status_code)
    if result is None:
        return _error_response('', '', '分析失败：未获取到结果', 500)
    return result, 200


def _generate_analyze_events(analyze_request, client_ip):
    """
    流式分析核心：生成 SSE 事件流（progress + result/error）。
    供 _analyze_with_stream 和 _analyze_plain 复用。
    client_ip 需在入口处获取并传入，因流式响应时生成器执行时请求上下文可能已失效。
    """
    # 再次检查模型加载状态（在生成器内部，使用模块级上下文）
    from backend.platform.app_context import get_app_context
    context = get_app_context(prefer_module_context=True)
    if context.model_loading:
        yield send_error_event('模型正在加载中，请稍后重试', 503)
        return

    start_time = time.perf_counter()

    # 验证和准备请求
    model, text, error_msg, status_code = _validate_and_prepare_request(analyze_request)
    if error_msg:
        yield send_error_event(error_msg, status_code or 400)
        return

    # 加载模型
    p, error_msg, status_code = _load_project_with_error_handling(model)
    if error_msg:
        yield send_error_event(error_msg, status_code or 500)
        return

    try:
        char_count = len(text) if text else 0
        request_id = _log_request(text, stream_mode=True, client_ip=client_ip)

        # 创建线程安全的进度队列
        progress_queue = queue.Queue()
        analysis_done = threading.Event()
        analysis_result = None
        analysis_error = None
        lock_wait_time = None  # 记录等待锁的时间

        def progress_callback_func(step: int, total_steps: int, stage: str, percentage: Optional[int]):
            """进度回调函数，将事件加入队列"""
            progress_queue.put(('progress', step, total_steps, stage, percentage))

        def run_analysis():
            """在单独线程中运行分析"""
            nonlocal analysis_result, analysis_error, lock_wait_time
            try:
                # 记录开始等待锁的时间
                lock_wait_start = time.perf_counter()

                # 尝试获取锁，设置超时避免长时间排队
                lock_acquired = inference_lock.acquire(timeout=LOCK_WAIT_TIMEOUT)
                if not lock_acquired:
                    # 获取锁超时，说明前面有任务在执行且耗时较长
                    analysis_error = QueueTimeoutError(
                        f"排队等待超过 {LOCK_WAIT_TIMEOUT} 秒，服务繁忙，请稍后重试"
                    )
                    return

                # 记录等待时间
                lock_wait_time = time.perf_counter() - lock_wait_start

                try:
                    from backend.platform.access_log import log_analyze_start
                    log_analyze_start(request_id, lock_wait_time, stream_mode=True)

                    # 在持有锁的情况下执行分析
                    # 注意：这里的执行时长也会受到 ANALYSIS_TIMEOUT 的监控（在外层循环中）
                    res = p.lm.analyze_text(text, progress_callback=progress_callback_func)
                    analysis_result = res
                finally:
                    # 确保锁一定会被释放
                    inference_lock.release()
            except Exception as e:
                analysis_error = e
            finally:
                analysis_done.set()
                progress_queue.put(('done', None, None))  # 发送完成信号

        # 启动分析线程
        analysis_thread = threading.Thread(target=run_analysis, daemon=True)
        analysis_thread.start()

        # 实时发送进度事件，并检查超时
        timeout_reached = False
        for kind, event_str in consume_progress_queue(
            progress_queue, analysis_done, start_time, ANALYSIS_TIMEOUT, "分析"
        ):
            if kind == 'timeout':
                timeout_reached = True
                yield event_str
                break
            if kind == 'progress':
                yield event_str
            elif kind == 'done':
                break

        # 如果超时，不等待分析完成，直接返回
        if timeout_reached:
            gc.collect()
            return

        # 检查是否有错误
        # 注意：此时已收到 'done' 信号，分析线程已完成其工作（或发生错误）
        # 线程是 daemon 的，会自动清理，无需显式等待
        if analysis_error:
            # 排队超时：返回友好的错误消息
            if isinstance(analysis_error, QueueTimeoutError):
                print(f"⏱️ 排队超时: {analysis_error}")
                yield send_error_event(str(analysis_error), 503)
                gc.collect()
                return
            # 其他错误：抛出异常，由外层的 try-except 处理
            raise analysis_error

        # 检查结果是否为空（理论上不应该发生，因为要么有结果，要么有错误）
        if analysis_result is None:
            print("⚠️ 分析结果为空，但没有错误信息")
            yield send_error_event("分析失败：未获取到结果", 500)
            gc.collect()
            return

        res = analysis_result

        elapsed_time = time.perf_counter() - start_time
        _log_response(res, char_count, elapsed_time, stream_mode=True,
                     request_id=request_id, wait_time=lock_wait_time)

        # 验证和修复结果
        res = _validate_and_fix_result(res)

        # 构建最终响应
        final_response = _build_response(model, text, res)

        # 发送最终结果
        yield send_result_event(final_response)

        # 强制垃圾回收以释放内存
        gc.collect()

    except Exception as e:
        import traceback
        traceback.print_exc()
        exit_if_oom(e, defer_seconds=1)
        yield send_error_event(str(e), 500)
        # 即使出错也进行垃圾回收
        gc.collect()


