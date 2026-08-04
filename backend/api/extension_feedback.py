"""Extension status-strip feedback → same HF Dataset as visit stats (one JSON per report)."""
from __future__ import annotations

from backend.platform.access_log import get_client_ip, log_request
from backend.platform.visit_stats import record_extension_feedback


def _clip_str(v, max_len: int) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    if not s:
        return None
    return s if len(s) <= max_len else s[: max_len - 1] + "…"


def _clip_obj(v, max_depth: int = 3, max_keys: int = 40):
    """Bound nested client payload size; drop oversized / deep values."""
    if max_depth < 0:
        return None
    if v is None or isinstance(v, (bool, int, float)):
        return v
    if isinstance(v, str):
        return _clip_str(v, 2000)
    if isinstance(v, list):
        return [_clip_obj(x, max_depth - 1, max_keys) for x in v[:max_keys]]
    if isinstance(v, dict):
        out = {}
        for i, (k, val) in enumerate(v.items()):
            if i >= max_keys:
                break
            key = _clip_str(k, 64) or f"k{i}"
            out[key] = _clip_obj(val, max_depth - 1, max_keys)
        return out
    return _clip_str(v, 500)


def post_extension_feedback(feedback_body=None):
    d = feedback_body if isinstance(feedback_body, dict) else {}
    status = d.get("status") if isinstance(d.get("status"), dict) else {}
    progress = d.get("progress") if isinstance(d.get("progress"), dict) else {}
    config = d.get("config") if isinstance(d.get("config"), dict) else {}

    payload = {
        "source": "extension",
        "status": {
            "tone": _clip_str(status.get("tone"), 32),
            "label": _clip_str(status.get("label"), 64),
            "detail": _clip_str(status.get("detail"), 2000),
            # 技术细节（用户 UI 不展示；扩展 Failed 反馈携带）
            "error_detail": _clip_str(status.get("error_detail"), 2000),
        },
        "page_url": _clip_str(d.get("page_url"), 2000),
        "query": _clip_str(d.get("query"), 500),
        "config": _clip_obj(config, max_depth=2, max_keys=24),
        "progress": _clip_obj(progress, max_depth=2, max_keys=24),
        "extension_version": _clip_str(d.get("extension_version"), 32),
        "user_agent": _clip_str(d.get("user_agent"), 400),
    }

    result = record_extension_feedback(payload)
    log_request(
        "📎 extension feedback",
        f"stored={result.get('stored')} path={result.get('path')!r} "
        f"tone={payload['status'].get('tone')!r} label={payload['status'].get('label')!r}",
        client_ip=get_client_ip(),
    )
    return result, 200
