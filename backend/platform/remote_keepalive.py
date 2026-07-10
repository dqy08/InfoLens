"""Master → remote Worker 保活：有 --remote 时定期 POST /api/analyze。"""

from __future__ import annotations

import threading
import time

import requests

from backend.platform.model_routing import configured_slots, remote_hf_token, remote_origin

_INITIAL_DELAY_SEC = 10 * 60
_INTERVAL_SEC = 24 * 60 * 60
_KEEPALIVE_TEXT = "just for keep hf space hot"
_API_PATH = "/api/analyze"
_TIMEOUT = 300.0


def _remote_origins() -> list[str]:
    seen: list[str] = []
    for slot in configured_slots():
        origin = remote_origin(slot)
        if origin and origin not in seen:
            seen.append(origin)
    return seen


def _ping(origin: str) -> None:
    token = remote_hf_token()
    if not token:
        raise RuntimeError("INFORADAR_REMOTE_HF_TOKEN is not set")
    url = f"{origin.rstrip('/')}{_API_PATH}"
    resp = requests.post(
        url,
        json={"text": _KEEPALIVE_TEXT, "model": "default"},
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        timeout=_TIMEOUT,
    )
    mark = "ok" if resp.ok else "fail"
    print(
        f"[inforadar] remote keepalive {mark}: {origin} → {resp.status_code}",
        flush=True,
    )


def _daemon() -> None:
    time.sleep(_INITIAL_DELAY_SEC)
    while True:
        for origin in _remote_origins():
            try:
                _ping(origin)
            except Exception as exc:  # noqa: BLE001
                print(f"[inforadar] remote keepalive fail: {origin} → {exc}", flush=True)
        time.sleep(_INTERVAL_SEC)


def start_remote_keepalive() -> None:
    origins = _remote_origins()
    if not origins:
        return
    threading.Thread(target=_daemon, daemon=True, name="RemoteKeepalive").start()
    print(
        f"[inforadar] remote keepalive every 24h: {', '.join(origins)}",
        flush=True,
    )
