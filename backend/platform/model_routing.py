"""模型槽位路由：本进程 local_slots vs --remote 转发目标。"""
from __future__ import annotations

import os
from argparse import Namespace

from backend.models.model_manager import ModelSlot

_configured_slots: tuple[ModelSlot, ...] = (ModelSlot.BASE, ModelSlot.INSTRUCT)
_remote_origins: dict[ModelSlot, str] = {}
_worker_mode: bool = False

_REMOTE_TOKEN_ENV = "INFORADAR_REMOTE_HF_TOKEN"


def _parse_slots(raw: str | None) -> tuple[ModelSlot, ...]:
    if raw is None or raw == "":
        return (ModelSlot.BASE, ModelSlot.INSTRUCT)
    names = [s.strip().lower() for s in raw.split(",") if s.strip()]
    if not names:
        raise ValueError("--slots must list at least one slot")
    out: list[ModelSlot] = []
    seen: set[ModelSlot] = set()
    for name in names:
        try:
            slot = ModelSlot(name)
        except ValueError as exc:
            raise ValueError(f"unknown slot {name!r} in --slots") from exc
        if slot not in seen:
            seen.add(slot)
            out.append(slot)
    return tuple(out)


def normalize_origin(origin: str) -> str:
    origin = origin.strip().rstrip("/")
    if not origin.startswith(("http://", "https://")):
        origin = f"https://{origin}"
    return origin


def _parse_remote_spec(spec: str) -> tuple[ModelSlot, str]:
    if "=" not in spec:
        raise ValueError(f"--remote must be slot=origin, got {spec!r}")
    key, origin = spec.split("=", 1)
    key = key.strip().lower()
    origin = normalize_origin(origin)
    try:
        slot = ModelSlot(key)
    except ValueError as exc:
        raise ValueError(f"unknown slot {key!r} in --remote") from exc
    return slot, origin


def configure_from_args(args: Namespace) -> None:
    """解析 CLI 并同步 model_manager.CONFIGURED_SLOTS / LOCAL_SLOTS。"""
    global _configured_slots, _remote_origins, _worker_mode

    worker = bool(getattr(args, "worker", False))
    remote_specs: list[str] = list(getattr(args, "remote", None) or [])
    slots = _parse_slots(getattr(args, "slots", None))

    if worker and remote_specs:
        raise ValueError("--worker and --remote are mutually exclusive")

    remote_map: dict[ModelSlot, str] = {}
    for spec in remote_specs:
        slot, origin = _parse_remote_spec(spec)
        remote_map[slot] = origin

    if remote_map and not os.environ.get(_REMOTE_TOKEN_ENV, "").strip():
        raise ValueError(
            f"{_REMOTE_TOKEN_ENV} is required when --remote is set "
            "(no fallback to HF_TOKEN)"
        )

    for slot in remote_map:
        if slot not in slots:
            raise ValueError(
                f"--remote {slot.value}=... requires {slot.value} in --slots"
            )

    _configured_slots = slots
    _remote_origins = remote_map
    _worker_mode = worker

    from backend.models import model_manager

    model_manager.CONFIGURED_SLOTS = slots
    model_manager.LOCAL_SLOTS = tuple(s for s in slots if s not in remote_map)


def configured_slots() -> tuple[ModelSlot, ...]:
    return _configured_slots


def local_slots() -> tuple[ModelSlot, ...]:
    return tuple(s for s in _configured_slots if s not in _remote_origins)


def is_worker() -> bool:
    return _worker_mode


def slot_enabled(slot: ModelSlot) -> bool:
    return slot in _configured_slots


def is_local(slot: ModelSlot) -> bool:
    return slot in _configured_slots and slot not in _remote_origins


def remote_origin(slot: ModelSlot) -> str | None:
    return _remote_origins.get(slot)


def remote_hf_token() -> str:
    return os.environ.get(_REMOTE_TOKEN_ENV, "").strip()


def worker_write_forbidden() -> tuple[dict, int]:
    return {"success": False, "message": "not available on worker"}, 501
