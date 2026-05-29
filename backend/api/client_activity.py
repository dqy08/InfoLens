from urllib.parse import unquote

from backend.api.utils import request_has_valid_admin
from backend.platform.access_log import log_request
from backend.platform.online_presence import WINDOW_SEC, get_online_now, record_heartbeat
from backend.platform.visit_stats import normalize_page_key, record_activity_report, record_gen_attr_opt_sec


def _activity_response() -> dict:
    return {"ok": True, "online_now": get_online_now(), "online_window_sec": WINDOW_SEC}


def _sparse_page_activity_log_cum(cum: int) -> bool:
    """无服务端状态：累计秒为 2、10、20（前 20s 内与前端档位一致）或 40、80、160…（40·2^k）时打访问日志。"""
    if cum in (2, 10, 20):
        return True
    if cum < 40 or cum % 40:
        return False
    q = cum // 40
    return q > 0 and (q & (q - 1)) == 0


def client_activity_report(activity_body=None):
    d = activity_body if isinstance(activity_body, dict) else {}
    p = str(d.get("page_path") or "")[:512].strip()
    try:
        cum = int(d.get("total_active_sec"))
        dlt = int(d.get("delta_active_sec"))
        if not p or cum < 1 or dlt < 0:
            return _activity_response()
    except (TypeError, ValueError):
        return _activity_response()
    path_only = p.split("?", 1)[0].split("#", 1)[0].strip()
    page_key = path_only.rstrip("/").split("/")[-1] or path_only
    if not page_key:
        return _activity_response()
    if "?" in p:
        qs = p.split("?", 1)[1].split("#", 1)[0]
        log_path = f"{page_key}?{unquote(qs)}" if qs else page_key
    else:
        log_path = page_key

    page_key = normalize_page_key(page_key)

    if not request_has_valid_admin():
        raw_os = d.get("client_os")
        client_os = str(raw_os).strip() if raw_os is not None else None

        record_heartbeat()
        record_activity_report(page_key, dlt, cum, client_os)
        if page_key == "causal_flow.html":
            raw_opts = d.get("page_opts")
            if isinstance(raw_opts, dict):
                record_gen_attr_opt_sec(dlt, {k: bool(v) for k, v in raw_opts.items() if isinstance(k, str)})
        if _sparse_page_activity_log_cum(cum):
            log_request(
                "📄 页面活跃",
                f"path(sampled)={log_path!r} total_sec={cum} delta_sec={dlt}",
            )
    return _activity_response()
