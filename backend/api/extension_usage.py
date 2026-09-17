"""扩展分析轮次用量（不含页面正文）：计入 visit_stats.api。"""

from backend.api.utils import optional_client_id
from backend.platform.access_log import log_request
from backend.platform.visit_stats import bump_api

_EXTENSIONS = frozenset({"info-highlight"})
_ENGINES = frozenset({"local", "cloud"})
_OUTCOMES = frozenset({"ok", "failed", "cancelled"})
_MAX_SEGMENTS = 512
_MAX_DURATION_MS = 86_400_000


def _nonneg_int(v, default=0) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    if n < 0:
        return default
    return min(n, _MAX_SEGMENTS)


def _optional_duration_ms(v):
    """非法/缺失视为缺省（None），不 400。"""
    if v is None or v == "":
        return None
    if isinstance(v, bool):
        return None
    try:
        n = int(round(float(v)))
    except (TypeError, ValueError):
        return None
    if n < 0:
        return None
    return min(n, _MAX_DURATION_MS)


def extension_usage_report(usage_body=None):
    d = usage_body if isinstance(usage_body, dict) else {}
    extension = str(d.get("extension") or "").strip()
    engine = str(d.get("engine") or "").strip()
    outcome = str(d.get("outcome") or "").strip()
    if extension not in _EXTENSIONS or engine not in _ENGINES or outcome not in _OUTCOMES:
        return {"success": False, "message": "invalid extension, engine, or outcome"}, 400

    segments = _nonneg_int(d.get("segments"))
    if segments < 1:
        return {"success": False, "message": "segments required"}, 400
    segments_ok = min(_nonneg_int(d.get("segments_ok")), segments)
    cached = min(_nonneg_int(d.get("cached")), segments)
    version = str(d.get("version") or "").strip()[:32]
    duration_ms = _optional_duration_ms(d.get("duration_ms"))
    client_id = optional_client_id(d.get("client_id"))

    bump_api("info_highlight_run")
    bump_api(f"info_highlight_run__{engine}")
    if outcome == "cancelled":
        bump_api("info_highlight_run__cancelled")
    elif outcome == "failed":
        bump_api("info_highlight_run__failed")
    if cached > 0:
        bump_api("info_highlight_run__cached")

    details = (
        f"ext={extension} eng={engine} outcome={outcome} "
        f"seg={segments} ok={segments_ok} cached={cached}"
    )
    if version:
        details += f" v={version}"
    if duration_ms is not None:
        details += f" dur={duration_ms}"
    if client_id:
        details += f" cid={client_id}"
    log_request("📊 扩展分析轮次", details)
    return {"success": True}
