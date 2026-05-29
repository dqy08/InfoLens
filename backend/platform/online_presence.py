"""由 /api/client-activity 心跳估算当前在线（滑动窗口，无会话 ID）。"""

import math
import threading
import time
from collections import deque

WINDOW_SEC = 20
_HEARTBEAT_PERIOD_SEC = 10

_LOCK = threading.Lock()
_beats: deque[float] = deque()


def record_heartbeat() -> None:
    now = time.monotonic()
    with _LOCK:
        _beats.append(now)
        _prune_locked(now)


def get_online_now() -> int:
    now = time.monotonic()
    with _LOCK:
        _prune_locked(now)
        n = len(_beats)
    return math.ceil(n * _HEARTBEAT_PERIOD_SEC / WINDOW_SEC)


def _prune_locked(now: float) -> None:
    cutoff = now - WINDOW_SEC
    while _beats and _beats[0] < cutoff:
        _beats.popleft()
