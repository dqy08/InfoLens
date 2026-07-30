"""模型槽位路由：本进程启用的槽位与 worker 形态。"""
from __future__ import annotations

from argparse import Namespace

from backend.models.model_manager import ModelSlot

_configured_slots: tuple[ModelSlot, ...] = (ModelSlot.BASE, ModelSlot.INSTRUCT)
_worker_mode: bool = False


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


def configure_from_args(args: Namespace) -> None:
    """解析 CLI 并同步 model_manager.CONFIGURED_SLOTS / LOCAL_SLOTS。"""
    global _configured_slots, _worker_mode

    slots = _parse_slots(getattr(args, "slots", None))
    _configured_slots = slots
    _worker_mode = bool(getattr(args, "worker", False))

    from backend.models import model_manager

    model_manager.CONFIGURED_SLOTS = slots
    model_manager.LOCAL_SLOTS = slots


def configured_slots() -> tuple[ModelSlot, ...]:
    return _configured_slots


def local_slots() -> tuple[ModelSlot, ...]:
    return _configured_slots


def is_worker() -> bool:
    return _worker_mode


def slot_enabled(slot: ModelSlot) -> bool:
    return slot in _configured_slots


def is_local(slot: ModelSlot) -> bool:
    return slot in _configured_slots


def worker_write_forbidden() -> tuple[dict, int]:
    return {"success": False, "message": "not available on worker"}, 501
