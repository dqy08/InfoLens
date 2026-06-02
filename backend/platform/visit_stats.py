import atexit
import copy
import json
import os
import signal
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
_GEN_ATTR_OPT_SEC = defaultdict(int)  # causal_flow.html 各非默认选项处于激活状态的活跃秒
_VALID_CLIENT_OS = frozenset({"ios", "android", "windows", "macos", "linux", "unknown"})

_STATS_SCHEMA_VERSION = 3

# client/src/ts/utils/settingsMenuManager.ts handleVisitStatsClick：PAGE_ORDER / API_ORDER / OS_ORDER
_STATS_PAGE_ORDER = (
    "index.html",
    "analysis.html",
    "compare.html",
    "chat.html",
    "attribution.html",
    "causal_flow.html",
)
_STATS_API_ORDER = (
    "analyze",
    "analyze_semantic",
    "chat",
    "causal_flow",
    "prediction_attribute",
    "prediction_attribute__attribution.html",
    "prediction_attribute__chat.html",
    "prediction_attribute__analysis.html",
)
_STATS_OS_ORDER = ("ios", "android", "windows", "macos", "linux", "unknown")
# causal_flow* 取代 propagated*；不再上报 propagated_anim（传播链改由 DAG ↯ 显式播放，无独立开关统计）。
_STATS_GEN_ATTR_OPT_ORDER = (
    "layout_linear_arc", "layout_step_down", "layout_spiral",
    "causal_flow", "causal_flow_anim_backward",
    "downstream", "token_tooltip",
)

# RLock：_persist_tick 在已持锁时调用 _sample_locked_counters，同线程需可重入。
_LOCK = threading.RLock()
_shutdown_persist_done = False

# Hub 上与 stats_total 对齐的已累计快照；未完成启动加载或未配置 token 时为 {}。
_base: dict = {}

# _load_base 完成时 _WIN 全为 0，全量 merged = _base，直接保留其副本作为启动基线。
_startup_base: dict = {}
_process_start_at: str | None = None

# 手动 reset 后的快照基线与时间，持久化到 HF，重启后保留。
_reset_base: dict = {}
_reset_at: str | None = None

_cached_server_platform: str | None = None

_HF_REPO = "dqy08/info-lens-stats"
_HF_TOKEN = os.environ.get("HF_TOKEN_stats_write")
_HF_TOTAL_FILE = "stats_total.json"
_HF_RESET_BASE_FILE = "stats_reset_base.json"
_HF_DELTA_DIR = "stats_delta"


def _stats_record(saved_at: str, body: dict) -> dict:
    """total / delta 磁盘与仓库共用：saved_at + 计数字段 + server_platform（若有）"""
    return {"saved_at": saved_at, **body}


def _get_server_platform() -> str:
    global _cached_server_platform
    if _cached_server_platform is not None:
        return _cached_server_platform
    from backend.platform.runtime_config import detect_platform

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


def _ordered_str_int_map(primary: tuple[str, ...], m: Mapping[str, object]) -> dict[str, int]:
    primary_set = frozenset(primary)
    head = [k for k in primary if k in m]
    tail = sorted(k for k in m if k not in primary_set)
    return {k: int(m[k]) for k in (*head, *tail)}


def _migrate_dict_keys(d: Mapping[str, object], migrations: dict[str, str]) -> tuple[dict[str, int], bool]:
    if not isinstance(d, dict):
        return {}, False
    out: dict[str, int] = {}
    changed = False
    for k, v in d.items():
        try:
            n = int(v)
        except (TypeError, ValueError):
            continue
        nk = migrations.get(k, k)
        if nk != k:
            changed = True
        out[nk] = out.get(nk, 0) + n
    return out, changed


_PAGE_SEC_KEY_MIGRATIONS = {
    "gen_attribute.html": "causal_flow.html",
}

_API_KEY_MIGRATIONS = {
    "prediction_attribute__gen_attribute.html": "prediction_attribute__causal_flow",
    "prediction_attribute__attribution": "prediction_attribute__attribution.html",
    "prediction_attribute__chat": "prediction_attribute__chat.html",
    "prediction_attribute__analysis": "prediction_attribute__analysis.html",
}


def _migrate_stats_record(rec: dict) -> tuple[dict, bool]:
    if int(rec.get("stats_schema_version", 1)) >= _STATS_SCHEMA_VERSION:
        return rec, False
    out = copy.deepcopy(rec)
    changed = False
    for field, mig in (("page_sec", _PAGE_SEC_KEY_MIGRATIONS), ("api", _API_KEY_MIGRATIONS)):
        if field in out:
            out[field], c = _migrate_dict_keys(out[field], mig)
            changed |= c
    if int(out.get("stats_schema_version", 1)) < _STATS_SCHEMA_VERSION:
        out["stats_schema_version"] = _STATS_SCHEMA_VERSION
        changed = True
    if changed:
        print(
            f"[访问统计] HF 历史 key 已迁移至 schema v{_STATS_SCHEMA_VERSION}，下次 persist 写回 Hub。",
            flush=True,
        )
    return out, changed


def _ingest_remote_base(remote: dict) -> dict:
    base, _ = _migrate_stats_record(copy.deepcopy(remote))
    return base


def normalize_page_key(page_key: str) -> str:
    if page_key == "gen_attribute.html":
        return "causal_flow.html"
    return page_key


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
    if h.get("page_sec") or h.get("api") or h.get("os") or h.get("gen_attr_opt_sec"):
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
        _subtract_defaultdict_int(_GEN_ATTR_OPT_SEC, committed_sample["session_gen_attr_opt_sec"])


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
        _base, _ = _migrate_stats_record(_base)
    pl = _base_int(_base, "page_loads")
    av = _base_int(_base, "active_visits")
    print(f"[访问统计] 历史已加载 page_loads={pl} active_visits={av}", flush=True)


def _load_reset_base():
    global _reset_base, _reset_at
    if not _HF_TOKEN:
        return
    try:
        from huggingface_hub import hf_hub_download
        path = hf_hub_download(
            repo_id=_HF_REPO,
            filename=_HF_RESET_BASE_FILE,
            repo_type="dataset",
            token=_HF_TOKEN,
            force_download=True,
        )
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        data, _ = _migrate_stats_record(data)
        with _LOCK:
            _reset_base = copy.deepcopy(data)
            _reset_at = data.get("reset_at")
        print(f"[访问统计] delta reset base 已加载 reset_at={_reset_at}", flush=True)
    except Exception as e:
        print(f"[访问统计] 读取 {_HF_RESET_BASE_FILE} 失败（首次或未设置）: {e}", flush=True)


def reset_delta_base() -> bool:
    """先 persist 当前增量，再将落盘后的累计快照保存为 delta reset base。"""
    global _reset_base, _reset_at
    _persist_tick()
    sample = _sample_locked_counters()
    _, stats_body, _ = _merge_from_sample(sample)
    reset_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    reset_rec = {"reset_at": reset_at, **stats_body}
    if _HF_TOKEN and not _upload_dataset_record(_HF_RESET_BASE_FILE, reset_rec):
        print("[访问统计] reset base 持久化失败。", flush=True)
        return False
    with _LOCK:
        _reset_base = copy.deepcopy(reset_rec)
        _reset_at = reset_at
    print(f"[访问统计] delta reset base 已更新 reset_at={reset_at}", flush=True)
    return True


def _persist_tick():
    """先读 stats_total 再写：delta 与 total 为同一 record 形状；两次上传均成功后提交 _base，并减去本周期对应会话快照。"""
    global _base
    if _HF_TOKEN:
        remote = _download_stats_total()
        if remote is None:
            print("[访问统计] 周期同步：读取远端失败，跳过本次写盘，内存增量保留。", flush=True)
            return
        with _LOCK:
            _base = _ingest_remote_base(remote)
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
    stats_body["stats_schema_version"] = _STATS_SCHEMA_VERSION
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
    page_key = normalize_page_key(page_key)
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


def record_gen_attr_opt_sec(delta_sec: int, opts: dict[str, bool]) -> None:
    """累计 causal_flow.html 各非默认选项处于激活状态的活跃秒。"""
    if delta_sec <= 0:
        return
    with _LOCK:
        for k, v in opts.items():
            if v:
                _GEN_ATTR_OPT_SEC[k] += delta_sec


def _sample_locked_counters() -> dict:
    with _LOCK:
        bo = _base.get("os")
        base_os = dict(bo) if isinstance(bo, dict) else {}
        bgo = _base.get("gen_attr_opt_sec")
        base_gen_attr_opt_sec = dict(bgo) if isinstance(bgo, dict) else {}
        return {
            "sw_pl": _WIN["page_loads"],
            "sw_av": _WIN["active_visits"],
            "session_page_sec": dict(_PAGE_SEC),
            "session_api": dict(_API),
            "session_os_reports": dict(_OS_REPORTS),
            "session_gen_attr_opt_sec": dict(_GEN_ATTR_OPT_SEC),
            "bp": int(_base_int(_base, "page_loads")),
            "bav": _base_int(_base, "active_visits"),
            "base_page_sec": dict(_base.get("page_sec") or {}),
            "base_api": dict(_base.get("api") or {}),
            "base_os": base_os,
            "base_gen_attr_opt_sec": base_gen_attr_opt_sec,
            "saved_at": _base.get("saved_at"),
        }


def _merge_from_sample(s: dict) -> tuple[dict, dict, dict]:
    """(管理员 API 快照, stats_total 的 body 不含 saved_at, stats_delta 的 body)。"""
    sp, sa, so = s["session_page_sec"], s["session_api"], s["session_os_reports"]
    bpp, bpa, bpo = s["base_page_sec"], s["base_api"], s["base_os"]
    sg, bgo = s["session_gen_attr_opt_sec"], s["base_gen_attr_opt_sec"]

    total_page_sec = {k: bpp.get(k, 0) + sp.get(k, 0) for k in set(bpp) | set(sp)}
    total_api = {k: bpa.get(k, 0) + sa.get(k, 0) for k in set(bpa) | set(sa)}
    total_os = {
        k: int(bpo.get(k, 0)) + int(so.get(k, 0))
        for k in set(bpo) | set(so)
    }
    total_gen_attr_opt_sec = {k: bgo.get(k, 0) + sg.get(k, 0) for k in set(bgo) | set(sg)}

    total_page_sec = _ordered_str_int_map(_STATS_PAGE_ORDER, total_page_sec)
    total_api = _ordered_str_int_map(_STATS_API_ORDER, total_api)
    total_os = _ordered_str_int_map(_STATS_OS_ORDER, total_os)
    total_gen_attr_opt_sec = _ordered_str_int_map(_STATS_GEN_ATTR_OPT_ORDER, total_gen_attr_opt_sec)
    ord_pg = _ordered_str_int_map(_STATS_PAGE_ORDER, sp)
    ord_api = _ordered_str_int_map(_STATS_API_ORDER, sa)
    ord_os = _ordered_str_int_map(_STATS_OS_ORDER, so)
    ord_gen_attr_opt_sec = _ordered_str_int_map(_STATS_GEN_ATTR_OPT_ORDER, sg)

    tpl, tav = s["bp"] + s["sw_pl"], s["bav"] + s["sw_av"]

    public = {
        "success": True,
        "totals": {"page_loads": tpl, "active_visits": tav},
        "os": total_os,
        "page_sec": total_page_sec,
        "api": total_api,
        "gen_attr_opt_sec": total_gen_attr_opt_sec,
        "saved_at": s["saved_at"],
    }
    stats_body = {
        "page_loads": tpl,
        "active_visits": tav,
        "os": total_os,
        "page_sec": total_page_sec,
        "api": total_api,
        "gen_attr_opt_sec": total_gen_attr_opt_sec,
    }
    delta_body = {
        "page_loads": s["sw_pl"],
        "active_visits": s["sw_av"],
        "os": ord_os,
        "page_sec": ord_pg,
        "api": ord_api,
        "gen_attr_opt_sec": ord_gen_attr_opt_sec,
    }
    return public, stats_body, delta_body


def get_stats_snapshot() -> dict:
    from backend.platform.online_presence import WINDOW_SEC, get_online_now

    sample = _sample_locked_counters()
    public, _, _ = _merge_from_sample(sample)
    public["online_now"] = get_online_now()
    public["online_window_sec"] = WINDOW_SEC
    public["server_platform"] = _get_server_platform()
    public["startup_base"] = _startup_base
    if _process_start_at is not None:
        public["process_start_at"] = _process_start_at
    public["reset_base"] = _reset_base
    public["reset_at"] = _reset_at
    return public


def _daemon_persist_hourly():
    global _startup_base, _process_start_at
    _load_base()
    _load_reset_base()
    _startup_base = copy.deepcopy(_base)
    _process_start_at = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    _report_restart_event()
    while True:
        time.sleep(3600)
        _persist_tick()


def _try_persist_on_shutdown():
    """进程退出路径（atexit / SIGTERM / SIGINT 等）最多尝试一次持久化；失败不阻断退出。"""
    global _shutdown_persist_done
    with _LOCK:
        if _shutdown_persist_done:
            return
        _shutdown_persist_done = True
        sample = _sample_locked_counters()
    _, _, delta_body = _merge_from_sample(sample)
    if not _increment_nonempty(delta_body):
        return
    print("[访问统计] 进程退出：尝试持久化未同步增量。", flush=True)
    try:
        _persist_tick()
    except Exception as e:  # noqa: BLE001
        print(f"[访问统计] 退出持久化失败: {e}", flush=True)


def _chain_shutdown_signal(signum: int) -> None:
    previous = signal.getsignal(signum)

    def _wrapper(sig: int, frame) -> None:
        _try_persist_on_shutdown()
        if callable(previous):
            previous(sig, frame)

    try:
        signal.signal(signum, _wrapper)
    except (ValueError, OSError):
        pass


def _register_shutdown_persist():
    atexit.register(_try_persist_on_shutdown)
    _chain_shutdown_signal(signal.SIGTERM)
    _chain_shutdown_signal(signal.SIGINT)


def register_visit_stats(_app):
    """_app 与 server 注册约定一致；统计线程不依赖应用对象。"""
    _register_shutdown_persist()
    threading.Thread(target=_daemon_persist_hourly, daemon=True).start()
