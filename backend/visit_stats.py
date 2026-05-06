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

# 与 webpack 顶层 HTML（client_activity 上报的 pathname 末段 *.html）一致；无上报也打印秒数 0
_SUMMARY_HTML_PAGES = (
    "index.html",
    "analysis.html",
    "compare.html",
    "chat.html",
    "attribution.html",
    "gen_attribute.html",
)

_SUMMARY_API_KINDS = (
    "analyze",
    "analyze_semantic",
    "chat",
    "prediction_attribute",
)


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
        apis = dict(_api)
        os_cnt = defaultdict(int)
        for aip in _active:
            o = _ip_os.get(aip)
            if o:
                os_cnt[o] += 1
        known_pages = frozenset(_SUMMARY_HTML_PAGES)
        merged_sec = {k: _page_sec.get(k, 0) for k in _SUMMARY_HTML_PAGES}
        for pk, secs in _page_sec.items():
            if pk not in known_pages:
                merged_sec[pk] = secs
        pg = [f"  {k}: {merged_sec[k]}" for k in _SUMMARY_HTML_PAGES]
        pg.extend(
            f"  {k}: {merged_sec[k]}"
            for k in sorted(k for k in merged_sec if k not in known_pages)
        )
    os_order = ("ios", "android", "windows", "macos", "linux", "unknown")
    os_pg = [f"  {k}: {os_cnt[k]}" for k in os_order if os_cnt[k]]
    now = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime())

    body = [f"========== [访问统计] {now} ==========",
            f"进程约 {h:.2f}h | 页面访问IP:{n_ip} | 真实活跃IP:{n_act}", "--- 活跃IP中OS统计 ---",
            *(os_pg or ["  （尚无）"]), "--- 页面活跃时间统计(秒) ---",
            *pg,
            "--- API调用统计 ---",
            *[f"  {k}: {apis.get(k, 0)}" for k in _SUMMARY_API_KINDS],
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
