import copy
import json
import os
import tempfile
import threading
import time
from collections import defaultdict
from collections.abc import Mapping
from datetime import datetime, timezone

# page_loads：在 backend.access_log.log_page_load 与 📄「页面访问」同路径累计；不按 IP；
# active_visits：至少上报过一次有效活跃心跳的页面访问（每页首轮有效心跳计一次）。
_WIN = {"page_loads": 0, "active_visits": 0}
_PAGE_SEC = defaultdict(int)
_API = defaultdict(int)
_OS_REPORTS = defaultdict(int)  # 与同页「首轮心跳」(delta_active_sec == total_active_sec) 对齐，仅凭该包附带 client_os 计一次
_VALID_CLIENT_OS = frozenset({"ios", "android", "windows", "macos", "linux", "unknown"})

# RLock：_persist_tick 在已持锁时调用 _sample_locked_counters，同线程需可重入。
_LOCK = threading.RLock()

# Hub 上与 stats_total 对齐的已累计快照；未完成启动加载或未配置 token 时为 {}。
_base: dict = {}

# _load_base 完成时 _WIN 全为 0，全量 merged = _base，直接保留其副本作为启动基线。
_startup_base: dict = {}
_process_start_at: str | None = None

_cached_server_platform: str | None = None

_HF_REPO = "dqy08/info-lens-stats"
_HF_TOKEN = os.environ.get("HF_TOKEN_stats_write")
_HF_TOTAL_FILE = "stats_total.json"
_HF_DELTA_DIR = "stats_delta"
def _stats_record(saved_at: str, body: dict) -> dict:
    """total / delta 磁盘与仓库共用：saved_at + 计数字段 + server_platform（若有）"""
    return {"saved_at": saved_at, **body}


def _get_server_platform() -> str:
    global _cached_server_platform
    if _cached_server_platform is not None:
        return _cached_server_platform
    from backend.runtime_config import detect_platform

    _cached_server_platform = detect_platform(verbose=False)
    return _cached_server_platform


def _serialize_stats_record(record: dict) -> str:
    return json.dumps(record, ensure_ascii=False, indent=2) + "\n"


def _base_int(b: dict, k: str) -> int:
    if k not in b:
        return 0
    try:
        return int(b[k])
    except (TypeError, ValueError):
        return 0


def _delta_time_slug(when: str | None = None) -> str:
    t = when if when is not None else datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    return t.replace(" ", "_").replace(":", "-")


def _delta_repo_path(saved_at: str) -> str:
    return f"{_HF_DELTA_DIR}/{_delta_time_slug(saved_at)}.json"


def _restart_log_repo_path() -> str:
    return f"{_HF_DELTA_DIR}/{_delta_time_slug()}.restart.log"


def _download_stats_total() -> dict | None:
    """从 HF Dataset 读取 stats_total.json，失败返回 None。"""
    if not _HF_TOKEN:
        return None
    try:
        from huggingface_hub import hf_hub_download
        path = hf_hub_download(
            repo_id=_HF_REPO,
            filename=_HF_TOTAL_FILE,
            repo_type="dataset",
            token=_HF_TOKEN,
            force_download=True,
        )
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception as e:
        print(f"[访问统计] 读取 {_HF_TOTAL_FILE} 失败: {e}", flush=True)
        return None


def _upload_local_to_dataset(path_in_repo: str, local_path: str) -> bool:
    """将本地文件上传到 HF Dataset 的 path_in_repo。成功返回 True。"""
    if not _HF_TOKEN:
        return False
    try:
        from huggingface_hub import HfApi

        HfApi().upload_file(
            path_or_fileobj=local_path,
            path_in_repo=path_in_repo,
            repo_id=_HF_REPO,
            repo_type="dataset",
            token=_HF_TOKEN,
        )
        return True
    except Exception as e:
        print(f"[访问统计] 上传 {path_in_repo} 失败: {e}", flush=True)
        return False


def _upload_dataset_record(path_in_repo: str, record: dict) -> bool:
    """将一条 stats 记录写入 Dataset 指定路径；排版与本地一致。成功返回 True。"""
    if not _HF_TOKEN:
        return False
    tmp: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".json") as tf:
            tmp = tf.name
            tf.write(_serialize_stats_record(record))
        return _upload_local_to_dataset(path_in_repo, tmp)
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _report_restart_event() -> None:
    """进程启动后上报 restart 标记：一行文本为 runtime_config.detect_platform() 的平台 ID。"""
    if not _HF_TOKEN:
        return
    platform = _get_server_platform()
    path_in_repo = _restart_log_repo_path()
    tmp: str | None = None
    try:
        with tempfile.NamedTemporaryFile("w", encoding="utf-8", delete=False, suffix=".log") as tf:
            tmp = tf.name
            tf.write(platform + "\n")
        _upload_local_to_dataset(path_in_repo, tmp)
    finally:
        if tmp:
            try:
                os.unlink(tmp)
            except OSError:
                pass


def _increment_nonempty(h: dict) -> bool:
    """是否有尚未写入远端的任意增量。"""
    if h.get("page_loads") or h.get("active_visits"):
        return True
    if h.get("page_sec") or h.get("api") or h.get("os"):
        return True
    return False


def _subtract_defaultdict_int(acc: defaultdict[str, int], committed: Mapping[str, int]) -> None:
    for k, v in committed.items():
        acc[k] -= v
        if acc[k] <= 0:
            del acc[k]


def _apply_persist_success(total_rec: dict, committed_sample: dict) -> None:
    """落盘后 _base ← total_rec，并从会话计数中减去本周期已成功上传的那份快照。"""
    global _base
    with _LOCK:
        _base = copy.deepcopy(total_rec)
        _WIN["page_loads"] -= committed_sample["sw_pl"]
        _WIN["active_visits"] -= committed_sample["sw_av"]
        if _WIN["page_loads"] < 0 or _WIN["active_visits"] < 0:
            raise RuntimeError("visit_stats: session totals underflow after persist")
        _subtract_defaultdict_int(_PAGE_SEC, committed_sample["session_page_sec"])
        _subtract_defaultdict_int(_API, committed_sample["session_api"])
        _subtract_defaultdict_int(_OS_REPORTS, committed_sample["session_os_reports"])


def _load_base():
    global _base
    if not _HF_TOKEN:
        return
    remote = _download_stats_total()
    if remote is None:
        print(f"[访问统计] 启动加载：未拉到 {_HF_TOTAL_FILE}（首次或网络不可用），从零累计。", flush=True)
        return
    with _LOCK:
        _base = copy.deepcopy(remote)
    pl = _base_int(_base, "page_loads")
    av = _base_int(_base, "active_visits")
    print(f"[访问统计] 历史已加载 page_loads={pl} active_visits={av}", flush=True)


def _persist_tick():
    """先读 stats_total 再写：delta 与 total 为同一 record 形状；两次上传均成功后提交 _base，并减去本周期对应会话快照。"""
    global _base
    if _HF_TOKEN:
        remote = _download_stats_total()
        if remote is None:
            print("[访问统计] 周期同步：读取远端失败，跳过本次写盘，内存增量保留。", flush=True)
            return
        with _LOCK:
            _base = copy.deepcopy(remote)
            sample = _sample_locked_counters()
    else:
        with _LOCK:
            sample = _sample_locked_counters()

    _, stats_body, delta_body = _merge_from_sample(sample)
    if not _increment_nonempty(delta_body):
        return
    if not _HF_TOKEN:
        print(
            "[访问统计] 未配置 HF_TOKEN_stats_write，本次周期跳过持久化。",
            flush=True,
        )
        return

    sp = _get_server_platform()
    stats_body["server_platform"] = sp
    delta_body["server_platform"] = sp

    saved_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    delta_rec = _stats_record(saved_at, delta_body)
    total_rec = _stats_record(saved_at, stats_body)

    if not _upload_dataset_record(_delta_repo_path(saved_at), delta_rec):
        print(f"[访问统计] {_HF_DELTA_DIR} 未写入，{_HF_TOTAL_FILE} 未提交，内存增量保留。", flush=True)
        return
    if not _upload_dataset_record(_HF_TOTAL_FILE, total_rec):
        print(
            f"[访问统计] 警告：{_HF_DELTA_DIR} 已写入，但 {_HF_TOTAL_FILE} 上传失败，下次周期将重读远端后重试合并。",
            flush=True,
        )
        return

    _apply_persist_success(total_rec, sample)
    print(
        f"[访问统计] 持久化 {saved_at} "
        f"Δpage_loads={delta_body['page_loads']} Δactive_visits={delta_body['active_visits']} "
        f"→ cum_page_loads={stats_body['page_loads']} cum_active_visits={stats_body['active_visits']}",
        flush=True,
    )


def record_page_load():
    with _LOCK:
        _WIN["page_loads"] += 1


def record_activity_report(
    page_key: str, delta_active_sec: int, total_active_sec: int,
    client_os: str | None = None,
) -> None:
    """累计秒与增量秒相等 ⇔ 本轮第一次有效心跳；活跃访问与 client_os 均仅在此包上计一次。"""
    if total_active_sec < 1 or delta_active_sec < 0:
        return
    if not page_key:
        return
    first_in_nav = delta_active_sec == total_active_sec
    with _LOCK:
        if first_in_nav:
            _WIN["active_visits"] += 1
            if client_os is not None:
                key = client_os.strip().lower()
                nk = key if key in _VALID_CLIENT_OS else "unknown"
                _OS_REPORTS[nk] += 1
        if delta_active_sec > 0:
            _PAGE_SEC[page_key] += delta_active_sec


def bump_api(kind: str):
    with _LOCK:
        _API[kind] += 1


def _sample_locked_counters() -> dict:
    with _LOCK:
        bo = _base.get("os")
        base_os = dict(bo) if isinstance(bo, dict) else {}
        return {
            "sw_pl": _WIN["page_loads"],
            "sw_av": _WIN["active_visits"],
            "session_page_sec": dict(_PAGE_SEC),
            "session_api": dict(_API),
            "session_os_reports": dict(_OS_REPORTS),
            "bp": int(_base_int(_base, "page_loads")),
            "bav": _base_int(_base, "active_visits"),
            "base_page_sec": dict(_base.get("page_sec") or {}),
            "base_api": dict(_base.get("api") or {}),
            "base_os": base_os,
            "saved_at": _base.get("saved_at"),
        }


def _merge_from_sample(s: dict) -> tuple[dict, dict, dict]:
    """(管理员 API 快照, stats_total 的 body 不含 saved_at, stats_delta 的 body)。"""
    sp, sa, so = s["session_page_sec"], s["session_api"], s["session_os_reports"]
    bpp, bpa, bpo = s["base_page_sec"], s["base_api"], s["base_os"]

    total_page_sec = {k: bpp.get(k, 0) + sp.get(k, 0) for k in set(bpp) | set(sp)}
    total_api = {k: bpa.get(k, 0) + sa.get(k, 0) for k in set(bpa) | set(sa)}
    total_os = {
        k: int(bpo.get(k, 0)) + int(so.get(k, 0))
        for k in set(bpo) | set(so)
    }

    tpl, tav = s["bp"] + s["sw_pl"], s["bav"] + s["sw_av"]

    public = {
        "success": True,
        "totals": {"page_loads": tpl, "active_visits": tav},
        "os": total_os,
        "page_sec": total_page_sec,
        "api": total_api,
        "saved_at": s["saved_at"],
    }
    stats_body = {
        "page_loads": tpl,
        "active_visits": tav,
        "page_sec": total_page_sec,
        "api": total_api,
        "os": total_os,
    }
    delta_body = {
        "page_loads": s["sw_pl"],
        "active_visits": s["sw_av"],
        "page_sec": sp,
        "api": sa,
        "os": so,
    }
    return public, stats_body, delta_body


def get_stats_snapshot() -> dict:
    sample = _sample_locked_counters()
    public, _, _ = _merge_from_sample(sample)
    public["server_platform"] = _get_server_platform()
    public["startup_base"] = _startup_base
    if _process_start_at is not None:
        public["process_start_at"] = _process_start_at
    return public


def _daemon_persist_hourly():
    global _startup_base, _process_start_at
    _load_base()
    _startup_base = copy.deepcopy(_base)
    _process_start_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _report_restart_event()
    while True:
        time.sleep(3600)
        _persist_tick()


def register_visit_stats(_app):
    """_app 与 server 注册约定一致；统计线程不依赖应用对象。"""
    threading.Thread(target=_daemon_persist_hourly, daemon=True).start()
