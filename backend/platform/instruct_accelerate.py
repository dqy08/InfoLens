"""Master → 本机 instruct 条件加速：RTT 探针、in-flight、熔断。"""
from __future__ import annotations

import logging
import os
import statistics
import threading
import time
from argparse import Namespace
from collections import deque

import requests

from backend.platform.model_routing import normalize_origin, remote_hf_token

_logger = logging.getLogger(__name__)

_MAX_RTT_ENV = "INFORADAR_ACCELERATE_INSTRUCT_MAX_RTT_MS"
_MAX_INFLIGHT_ENV = "INFORADAR_ACCELERATE_INSTRUCT_MAX_INFLIGHT"
_PROVIDER_PORT_ENV = "INFORADAR_ACCELERATE_INSTRUCT_PROVIDER_PORT"

_DEFAULT_MAX_RTT_MS = 1000
_DEFAULT_MAX_INFLIGHT = 5
_PROBE_INTERVAL_SEC = 20.0
_PROBE_TIMEOUT_SEC = 5.0
_RTT_SAMPLES = 5
_HEALTH_PATH = "/api/health"

_origin: str | None = None
_max_rtt_ms: float = _DEFAULT_MAX_RTT_MS
_max_inflight: int = _DEFAULT_MAX_INFLIGHT
_provider_port: int | None = None

_lock = threading.Lock()
_inflight = 0
_circuit_open = False
_rtt_ms: deque[float] = deque(maxlen=_RTT_SAMPLES)
_probe_started = False


def reset_for_tests() -> None:
    """测试用：清空模块状态。"""
    global _origin, _max_rtt_ms, _max_inflight, _provider_port
    global _inflight, _circuit_open, _probe_started
    with _lock:
        _origin = None
        _max_rtt_ms = _DEFAULT_MAX_RTT_MS
        _max_inflight = _DEFAULT_MAX_INFLIGHT
        _provider_port = None
        _inflight = 0
        _circuit_open = False
        _rtt_ms.clear()
        _probe_started = False


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return int(raw)


def configure_from_args(args: Namespace) -> None:
    """从 CLI/env 注入加速门控与本机提供口（origin 仅运行时 set_accelerate_origin）。"""
    global _max_rtt_ms, _max_inflight, _provider_port, _inflight, _circuit_open

    max_rtt = _env_int(_MAX_RTT_ENV, _DEFAULT_MAX_RTT_MS)
    max_inflight = _env_int(_MAX_INFLIGHT_ENV, _DEFAULT_MAX_INFLIGHT)

    cli_port = getattr(args, "accelerate_instruct_provider_port", None)
    port_raw = (
        str(cli_port).strip()
        if cli_port is not None and str(cli_port).strip()
        else os.environ.get(_PROVIDER_PORT_ENV, "").strip()
    )
    provider_port = int(port_raw) if port_raw else None

    if provider_port is not None and not remote_hf_token():
        raise ValueError(
            "INFORADAR_REMOTE_HF_TOKEN is required when "
            f"{_PROVIDER_PORT_ENV} / --accelerate_instruct_provider_port is set"
        )

    with _lock:
        _max_rtt_ms = float(max_rtt)
        _max_inflight = max(1, max_inflight)
        _provider_port = provider_port
        _inflight = 0
        _circuit_open = False
        _rtt_ms.clear()


def accelerate_origin() -> str | None:
    return _origin


def set_accelerate_origin(origin: str | None) -> str | None:
    """运行时更新加速 origin（空 / None 表示关闭）。会清空 RTT 样本并解除熔断。"""
    global _origin, _circuit_open

    raw = (origin or "").strip()
    normalized = normalize_origin(raw) if raw else None
    if normalized and not remote_hf_token():
        raise ValueError(
            "INFORADAR_REMOTE_HF_TOKEN is required when setting accelerate origin"
        )

    with _lock:
        _origin = normalized
        _circuit_open = False
        _rtt_ms.clear()

    if normalized:
        print(f"[inforadar] accelerate origin set: {normalized}", flush=True)
        start_probe_loop()
    else:
        print("[inforadar] accelerate origin cleared", flush=True)
    return normalized


def provider_port() -> int | None:
    return _provider_port


def median_rtt_ms() -> float | None:
    with _lock:
        if not _rtt_ms:
            return None
        return float(statistics.median(_rtt_ms))


def is_circuit_open() -> bool:
    with _lock:
        return _circuit_open


def inflight_count() -> int:
    with _lock:
        return _inflight


def _eligible_unlocked() -> bool:
    if not _origin or _circuit_open or not _rtt_ms:
        return False
    if statistics.median(_rtt_ms) >= _max_rtt_ms:
        return False
    return _inflight < _max_inflight


def is_accelerate_eligible() -> bool:
    with _lock:
        return _eligible_unlocked()


def acquire() -> bool:
    """尝试占用一条加速 in-flight；成功返回 True 且 +1。"""
    with _lock:
        if not _eligible_unlocked():
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


def record_probe_success(rtt_ms: float) -> None:
    with _lock:
        global _circuit_open
        _rtt_ms.append(rtt_ms)
        _circuit_open = False


def record_probe_failure() -> None:
    with _lock:
        global _circuit_open
        _circuit_open = True


def _probe_once() -> None:
    origin = accelerate_origin()
    if not origin:
        return
    token = remote_hf_token()
    if not token:
        record_probe_failure()
        return
    url = f"{origin.rstrip('/')}{_HEALTH_PATH}"
    started = time.perf_counter()
    try:
        resp = requests.get(
            url,
            headers={"Authorization": f"Bearer {token}"},
            timeout=_PROBE_TIMEOUT_SEC,
        )
        rtt_ms = (time.perf_counter() - started) * 1000.0
        if resp.ok:
            record_probe_success(rtt_ms)
            return
        record_probe_failure()
        _logger.warning("accelerate probe fail: %s → %s", origin, resp.status_code)
    except Exception as exc:  # noqa: BLE001
        record_probe_failure()
        _logger.warning("accelerate probe fail: %s → %s", origin, exc)


def _probe_daemon() -> None:
    while True:
        try:
            _probe_once()
        except Exception as exc:  # noqa: BLE001
            _logger.warning("accelerate probe loop error: %s", exc)
        time.sleep(_PROBE_INTERVAL_SEC)


def start_probe_loop() -> None:
    global _probe_started
    if not accelerate_origin():
        return
    with _lock:
        if _probe_started:
            return
        _probe_started = True
    threading.Thread(target=_probe_daemon, daemon=True, name="InstructAccelerateProbe").start()
    print(
        f"[inforadar] instruct accelerate probe every {_PROBE_INTERVAL_SEC:.0f}s: "
        f"{accelerate_origin()}",
        flush=True,
    )
