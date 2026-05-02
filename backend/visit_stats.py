import threading
import time
from collections import defaultdict

from flask import request

from backend.access_log import get_client_ip

_LOCK = threading.Lock()
_t0 = time.monotonic()
_seen: set = set()
_active: set = set()
_page_sec = defaultdict(int)
_api = defaultdict(int)
_ip_os: dict[str, str] = {}
_VALID_CLIENT_OS = frozenset({"ios", "android", "windows", "macos", "linux", "unknown"})


def _is_page_route_request() -> bool:
    """与 static 中首页重定向、HTML 页面下发一致，不把 /api、静态 js/css 等算进访问 IP。"""
    if request.method != "GET":
        return False
    path = request.path or ""
    if path == "/":
        return True
    if path.startswith("/client/"):
        return path.endswith(".html")
    return False


def record_incoming_ip():
    with _LOCK:
        _seen.add(get_client_ip())


def record_page_active(ip: str, page_key: str, delta: int, cum: int, client_os: str | None = None):
    if cum < 1 or delta < 0 or not ip:
        return
    with _LOCK:
        _active.add(ip)
        if delta > 0:
            _page_sec[page_key] += delta
        if ip not in _ip_os and client_os is not None:
            key = client_os.strip().lower()
            _ip_os[ip] = key if key in _VALID_CLIENT_OS else "unknown"


def bump_api(kind: str):
    with _LOCK:
        _api[kind] += 1


def print_visit_summary():
    with _LOCK:
        h = (time.monotonic() - _t0) / 3600
        n_ip, n_act = len(_seen), len(_active)
        pg = [f"  {k}: {v}" for k, v in sorted(_page_sec.items(), key=lambda kv: (-kv[1], kv[0]))]
        apis = dict(_api)
        os_cnt = defaultdict(int)
        for aip in _active:
            o = _ip_os.get(aip)
            if o:
                os_cnt[o] += 1
    os_order = ("ios", "android", "windows", "macos", "linux", "unknown")
    os_pg = [f"  {k}: {os_cnt[k]}" for k in os_order if os_cnt[k]]

    body = ["========== [访问统计] ==========",
            f"进程约 {h:.2f}h | 页面访问IP:{n_ip} | 真实活跃IP:{n_act}", "--- 活跃IP中OS统计 ---",
            *(os_pg or ["  （尚无）"]), "--- 页面活跃时间统计(秒) ---",
            *(pg or ["  （尚无）"]), "--- 分析API调用统计 ---",
            *[f"  {k}: {apis.get(k, 0)}" for k in ("analyze", "analyze_semantic", "prediction_attribute")],
            "=" * 42]
    print("\n".join(body), flush=True)


def _hourly():
    while True:
        time.sleep(3600)
        print_visit_summary()


def register_visit_stats(app):
    @app.app.before_request
    def _():
        if _is_page_route_request():
            record_incoming_ip()

    threading.Thread(target=_hourly, daemon=True).start()
