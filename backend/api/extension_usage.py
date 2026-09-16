"""扩展分析轮次用量（不含页面正文）：计入 visit_stats.api。"""

from backend.platform.access_log import log_request
from backend.platform.visit_stats import bump_api

_EXTENSIONS = frozenset({"info-highlight"})
_ENGINES = frozenset({"local", "cloud"})
_OUTCOMES = frozenset({"ok", "failed", "cancelled"})
_MAX_SEGMENTS = 512


def _nonneg_int(v, default=0) -> int:
    try:
        n = int(v)
    except (TypeError, ValueError):
        return default
    if n < 0:
        return default
    return min(n, _MAX_SEGMENTS)


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
    log_request("📊 扩展分析轮次", details)
    return {"success": True}
