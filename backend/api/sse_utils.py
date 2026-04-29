"""Server-Sent Events (SSE) 工具模块"""
import json
import queue
import time
from typing import Callable, Generator, Optional, Tuple
from flask import Response


class SSEProgressReporter:
    """SSE进度报告器"""
    
    def __init__(self, generator_func: Callable):
        """
        初始化SSE进度报告器
        
        Args:
            generator_func: 生成器函数，用于生成SSE事件
        """
        self.generator_func = generator_func
    
    def generate(self):
        """生成SSE事件流"""
        try:
            for event in self.generator_func():
                yield event
        except Exception as e:
            # 发送错误事件
            error_data = {
                'type': 'error',
                'message': str(e)
            }
            yield f"data: {json.dumps(error_data)}\n\n"
    
    def create_response(self) -> Response:
        """创建SSE响应"""
        return Response(
            self.generate(),
            mimetype='text/event-stream',
            headers={
                'Cache-Control': 'no-cache',
                'X-Accel-Buffering': 'no',  # 禁用nginx缓冲
                'Connection': 'keep-alive'
            }
        )


def send_progress_event(step: int, total_steps: int, stage: str, percentage: Optional[int] = None, message: Optional[str] = None) -> str:
    """
    生成SSE进度事件
    
    Args:
        step: 当前步骤 (1-based)
        total_steps: 总步骤数
        stage: 阶段名称 (encoding, inference, processing)
        percentage: 可选的进度百分比 (0-100)，仅在需要显示百分比的阶段提供
        message: 可选的进度消息
    
    Returns:
        SSE格式的事件字符串
    """
    data = {
        'type': 'progress',
        'step': step,
        'total_steps': total_steps,
        'stage': stage
    }
    if percentage is not None:
        data['percentage'] = percentage
    if message:
        data['message'] = message
    return f"data: {json.dumps(data)}\n\n"


def send_result_event(result: dict) -> str:
    """
    生成SSE结果事件
    
    Args:
        result: 分析结果字典
    
    Returns:
        SSE格式的事件字符串
    """
    data = {
        'type': 'result',
        'data': result
    }
    return f"data: {json.dumps(data)}\n\n"


def send_completion_delta_event(text: str, stream_end: bool) -> str:
    """续写流式：与 analyze 的 progress/result 并列，type=delta。"""
    data = {
        "type": "delta",
        "text": text,
    }
    if stream_end:
        data["stream_end"] = True
    return f"data: {json.dumps(data)}\n\n"


def send_prompt_used_event(prompt_used: str) -> str:
    """续写流式：在首条 delta 之前下发实际送入模型的 prompt 原文。"""
    data = {
        "type": "prompt_used",
        "prompt_used": prompt_used,
    }
    return f"data: {json.dumps(data)}\n\n"


def send_error_event(message: str, status_code: Optional[int] = None) -> str:
    """
    生成SSE错误事件

    Args:
        message: 错误消息
        status_code: 可选 HTTP 状态码，供非流式封装解析

    Returns:
        SSE格式的事件字符串
    """
    data = {'type': 'error', 'message': message}
    if status_code is not None:
        data['status_code'] = status_code
    return f"data: {json.dumps(data)}\n\n"


def consume_progress_queue(
    progress_queue: queue.Queue,
    analysis_done,
    start_time: float,
    timeout_seconds: float,
    timeout_label: str = "分析",
) -> Generator[Tuple[str, str], None, None]:
    """
    消费进度队列，yield (kind, event_str)。
    kind: 'progress' | 'timeout' | 'done'
    event_str: SSE 格式字符串（timeout 时含错误信息，done 时为空）
    """
    done_received = False
    last_progress_info = None

    while True:
        elapsed = time.perf_counter() - start_time
        if elapsed >= timeout_seconds:
            progress_str = f" | {last_progress_info}" if last_progress_info else ""
            print(f"⏱️ {timeout_label}超时: 处理时长 {elapsed:.2f}s 超过限制 {timeout_seconds}s，已放弃{progress_str}")
            yield ('timeout', send_error_event(f"分析超时：处理时长超过 {timeout_seconds} 秒限制，已放弃"))
            return

        try:
            event_data = progress_queue.get(timeout=0.1)
            event_type = event_data[0]
            if event_type == 'progress':
                _, step, total_steps, stage, percentage = event_data
                if total_steps > 0:
                    last_progress_info = f"step={step}/{total_steps}"
                else:
                    last_progress_info = f"step={step}"
                if stage:
                    last_progress_info += f" stage={stage}"
                if percentage is not None:
                    last_progress_info += f" {percentage}%"
                yield ('progress', send_progress_event(step, total_steps, stage, percentage))
            elif event_type == 'done':
                done_received = True
                while not progress_queue.empty():
                    try:
                        remaining = progress_queue.get_nowait()
                        if remaining[0] == 'progress':
                            _, step, total_steps, stage, percentage = remaining
                            yield ('progress', send_progress_event(step, total_steps, stage, percentage))
                    except queue.Empty:
                        break
                yield ('done', '')
                return
        except queue.Empty:
            if analysis_done.is_set() and done_received:
                yield ('done', '')
                return

