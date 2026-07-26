"""Master → 本机 instruct 条件加速：TTL 登记、in-flight、熔断。

探活由登记方负责；本模块不主动探 origin。
"""
from __future__ import annotations

import os
import threading
import time

from backend.platform.model_routing import normalize_origin

_MAX_INFLIGHT_ENV = "INFORADAR_ACCELERATE_INSTRUCT_MAX_INFLIGHT"
_TTL_ENV = "INFORADAR_ACCELERATE_INSTRUCT_TTL_SEC"

_DEFAULT_MAX_INFLIGHT = 5
_DEFAULT_TTL_SEC = 90

_origin: str | None = None
_expires_at: float = 0.0  # time.monotonic()
_max_inflight: int = _DEFAULT_MAX_INFLIGHT
_ttl_sec: int = _DEFAULT_TTL_SEC

_lock = threading.Lock()
_inflight = 0
_circuit_open = False


def reset_for_tests() -> None:
    """测试用：清空模块状态。"""
    global _origin, _expires_at, _max_inflight, _ttl_sec
    global _inflight, _circuit_open
    with _lock:
        _origin = None
        _expires_at = 0.0
        _max_inflight = _DEFAULT_MAX_INFLIGHT
        _ttl_sec = _DEFAULT_TTL_SEC
        _inflight = 0
        _circuit_open = False


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return int(raw)


def configure() -> None:
    """从 env 注入加速门控（origin 仅运行时 set_accelerate_origin）。"""
    global _max_inflight, _ttl_sec, _inflight, _circuit_open

    max_inflight = _env_int(_MAX_INFLIGHT_ENV, _DEFAULT_MAX_INFLIGHT)
    ttl_sec = max(1, _env_int(_TTL_ENV, _DEFAULT_TTL_SEC))

    with _lock:
        _max_inflight = max(1, max_inflight)
        _ttl_sec = ttl_sec
        _inflight = 0
        _circuit_open = False


def ttl_sec() -> int:
    with _lock:
        return _ttl_sec


def _clear_expired_unlocked(now: float) -> None:
    global _origin, _expires_at
    if _origin is not None and now >= _expires_at:
        _origin = None
        _expires_at = 0.0


def accelerate_origin() -> str | None:
    with _lock:
        _clear_expired_unlocked(time.monotonic())
        return _origin


def set_accelerate_origin(origin: str | None) -> str | None:
    """运行时更新加速 origin（空 / None 表示关闭）。成功登记会刷新 TTL 并解除熔断。"""
    global _origin, _expires_at, _circuit_open

    raw = (origin or "").strip()
    normalized = normalize_origin(raw) if raw else None

    with _lock:
        if normalized:
            _origin = normalized
            _expires_at = time.monotonic() + float(_ttl_sec)
            # 同 origin 续期也会解熔断。登记方探活路径≠Master→origin，极端下可能短周期抖动；可接受。
            _circuit_open = False
        else:
            _origin = None
            _expires_at = 0.0

    if normalized:
        print(
            f"[inforadar] accelerate origin set: {normalized} (ttl={_ttl_sec}s)",
            flush=True,
        )
    else:
        print("[inforadar] accelerate origin cleared", flush=True)
    return normalized


def is_circuit_open() -> bool:
    with _lock:
        return _circuit_open


def inflight_count() -> int:
    with _lock:
        return _inflight


def _eligible_unlocked(now: float) -> bool:
    _clear_expired_unlocked(now)
    if not _origin or _circuit_open:
        return False
    return _inflight < _max_inflight


def is_accelerate_eligible() -> bool:
    with _lock:
        return _eligible_unlocked(time.monotonic())


def acquire() -> bool:
    """尝试占用一条加速 in-flight；成功返回 True 且 +1。"""
    with _lock:
        if not _eligible_unlocked(time.monotonic()):
            return False
        global _inflight
        _inflight += 1
        return True


def release() -> None:
    with _lock:
        global _inflight
        if _inflight > 0:
            _inflight -= 1


def trip_circuit() -> None:
    with _lock:
        global _circuit_open
        _circuit_open = True
