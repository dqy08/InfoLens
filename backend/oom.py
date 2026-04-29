"""OOM 处理：MPS/CUDA 显存或 CPU 内存不足时退出进程，由进程管理器重启"""
import os
import threading
import time


def _check_oom_msg(msg: str) -> bool:
    patterns = (
        "out of memory",
        "out of memory error",
        "memory allocation",
        "cannot allocate memory",
        "insufficient memory",
        "ran out of memory",
        "resource exhausted",
        "cuda error: out of memory",
        "mps backend out of memory",
    )
    return any(p in msg.lower() for p in patterns)


def is_oom_error(e: Exception) -> bool:
    """检测是否为 OOM（含 MPS/CUDA 显存、CPU 内存），此类错误后进程无法恢复，需重启"""
    if isinstance(e, MemoryError):
        return True
    if _check_oom_msg(str(e)):
        return True
    # 检查异常链（如被 RuntimeError 包装的 OOM）
    for exc in (getattr(e, "__cause__", None), getattr(e, "__context__", None)):
        if exc is not None and (isinstance(exc, MemoryError) or _check_oom_msg(str(exc))):
            return True
    return False


def exit_if_oom(e: Exception, defer_seconds: float = 0) -> None:
    """若为 OOM 则退出进程，由进程管理器重启以恢复内存。

    defer_seconds: 延迟退出秒数，用于先返回错误响应再退出（非流式需 > 0）
    """
    if not is_oom_error(e):
        return
    msg = f"🛑 OOM 检测到，进程退出以便重启: {e}"
    if defer_seconds > 0:
        msg = f"🛑 OOM 检测到，{defer_seconds}s 后进程退出以便重启: {e}"
    print(msg)

    def _exit():
        if defer_seconds > 0:
            time.sleep(defer_seconds)
        os._exit(1)

    if defer_seconds > 0:
        threading.Thread(target=_exit, daemon=False).start()
    else:
        os._exit(1)
