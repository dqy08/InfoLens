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
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

# page_loads：在 backend.access_log.log_page_load 与 📄「页面访问」同路径累计；不按 IP；
# active_visits：至少上报过一次有效活跃心跳的页面访问（每页首轮有效心跳计一次）。
_WIN = {"page_loads": 0, "active_visits": 0}
_PAGE_SEC = defaultdict(int)
_API = defaultdict(int)
_OS_REPORTS = defaultdict(int)  # 与同页「首轮心跳」(delta_active_sec == total_active_sec) 对齐，仅凭该包附带 client_os 计一次
_GEN_ATTR_OPT_SEC = defaultdict(int)  # causal_flow.html 各非默认选项处于激活状态的活跃秒
_VALID_CLIENT_OS = frozenset({"ios", "android", "windows", "macos", "linux", "unknown"})

_STATS_SCHEMA_VERSION = 3

# client/src/shared/cross/visitStatsContract.ts：STATS_PERIOD_* / STATS_UTC_HOUR_FMT
# client/src/shared/cross/settingsMenuManager.ts handleVisitStatsClick：PAGE_ORDER / API_ORDER / OS_ORDER
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
_HF_TIMELINE_CACHE_DIR = "stats_timeline_cache"
_HF_TIMELINE_CACHE_FILE = f"{_HF_TIMELINE_CACHE_DIR}/bins.json"
_TIMELINE_CACHE_SCHEMA = 4  # v4：仅 active_visits / active_sec 小时桶
_TIMELINE_CACHE_SCHEMA_LEGACY = frozenset({2, 3, 4})  # Hub 上可能存在的旧 bins.json
_DELTA_DL_WORKERS = 32
# client/src/shared/cross/visitStatsContract.ts — STATS_PERIOD_HOURS / STATS_UTC_HOUR_FMT
_STATS_PERIOD_HOURS = 1
_STATS_UTC_HOUR_FMT = "%Y-%m-%dT%H:%M:%SZ"
_STATS_PERIOD = timedelta(hours=_STATS_PERIOD_HOURS)


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
    t = when if when is not None else datetime.now(timezone.utc).strftime(_STATS_UTC_HOUR_FMT)
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
    """Hub 上 v1/v2 等旧 stats 记录在内存中升到 v3；下次 persist 写回。"""
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

        from backend.platform.hf_hub_endpoint import hf_hub_endpoint

        path = hf_hub_download(
            repo_id=_HF_REPO,
            filename=_HF_TOTAL_FILE,
            repo_type="dataset",
            token=_HF_TOKEN,
            force_download=True,
            endpoint=hf_hub_endpoint(),
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
        from backend.platform.hf_hub_endpoint import hf_api

        hf_api().upload_file(
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

        from backend.platform.hf_hub_endpoint import hf_hub_endpoint

        path = hf_hub_download(
            repo_id=_HF_REPO,
            filename=_HF_RESET_BASE_FILE,
            repo_type="dataset",
            token=_HF_TOKEN,
            force_download=True,
            endpoint=hf_hub_endpoint(),
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
    reset_at = datetime.now(timezone.utc).strftime(_STATS_UTC_HOUR_FMT)
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

    saved_at = datetime.now(timezone.utc).strftime(_STATS_UTC_HOUR_FMT)
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


def _delta_slug_to_saved_at(slug: str) -> str:
    """_delta_time_slug 的逆：2026-05-07_17-00-52 或 2026-05-08T04-55-41Z → 2026-05-08T04:55:41Z"""
    slug = slug.strip()
    if "T" in slug:
        date, rest = slug.split("T", 1)
    elif "_" in slug:
        date, rest = slug.split("_", 1)
    else:
        raise ValueError(f"unsupported delta filename slug: {slug!r}")
    rest = rest.replace("-", ":")
    if not rest.endswith("Z"):
        rest += "Z"
    return f"{date}T{rest}"


_SAVED_AT_FMTS = (_STATS_UTC_HOUR_FMT, "%Y-%m-%d %H:%M:%S")  # 现行 / 早期 persist


def _parse_utc_ts(s: str) -> datetime:
    """saved_at（UTC）：现行 T…Z，早期空格分隔无 Z。"""
    raw = str(s).strip()
    for fmt in _SAVED_AT_FMTS:
        try:
            return datetime.strptime(raw, fmt).replace(tzinfo=timezone.utc)
        except ValueError:
            continue
    raise ValueError(f"unsupported saved_at: {raw!r}")


def _saved_at_from_delta_path(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    if not name.endswith(".json"):
        raise ValueError(f"not a stats delta json path: {path!r}")
    return _delta_slug_to_saved_at(name[:-5])


def _delta_path_after_through(path: str, through_ts: datetime) -> bool:
    """增量筛选：文件名时间 > through；无法从文件名解析时仍下载（用 body saved_at）。"""
    try:
        return _parse_utc_ts(_saved_at_from_delta_path(path)) > through_ts
    except ValueError:
        return True


def _utc_hour_key(dt: datetime) -> str:
    floored = dt.astimezone(timezone.utc).replace(minute=0, second=0, microsecond=0)
    return floored.strftime(_STATS_UTC_HOUR_FMT)


def _sum_page_sec(page_sec) -> int:
    if not isinstance(page_sec, dict):
        return 0
    total = 0
    for v in page_sec.values():
        try:
            total += int(v or 0)
        except (TypeError, ValueError):
            continue
    return total


def _distribute_count_to_hours(start: datetime, end: datetime, count: int) -> dict[str, int]:
    """将 (start, end] 区间内的 count 按与 UTC 桶的重叠比例分配为整数（visits、active_sec 等）。"""
    start = start.astimezone(timezone.utc)
    end = end.astimezone(timezone.utc)
    if count <= 0 or end <= start:
        return {}
    total_sec = (end - start).total_seconds()
    frac: dict[str, float] = defaultdict(float)
    t = _parse_utc_ts(_utc_hour_key(start))
    while t < end:
        h_end = t + _STATS_PERIOD
        overlap_start = max(start, t)
        overlap_end = min(end, h_end)
        if overlap_end > overlap_start:
            key = _utc_hour_key(t)
            frac[key] += count * (overlap_end - overlap_start).total_seconds() / total_sec
        t = h_end
    if not frac:
        return {}
    keys = list(frac.keys())
    out = {k: int(frac[k]) for k in keys}
    remainder = count - sum(out.values())
    if remainder > 0:
        for k in sorted(keys, key=lambda k: frac[k] - out[k], reverse=True)[:remainder]:
            out[k] += 1
    return {k: v for k, v in out.items() if v > 0}


def _list_stats_delta_paths() -> list[str]:
    if not _HF_TOKEN:
        return []
    try:
        from backend.platform.hf_hub_endpoint import hf_api

        paths = hf_api().list_repo_files(
            repo_id=_HF_REPO, repo_type="dataset", token=_HF_TOKEN,
        )
    except Exception as e:
        print(f"[访问统计] 列出 stats_delta 失败: {e}", flush=True)
        return []
    return sorted(
        p for p in paths
        if p.startswith(f"{_HF_DELTA_DIR}/") and p.endswith(".json")
    )


class TimelineCacheLoadError(Exception):
    """时间线 bins 缓存读取失败（非「文件不存在」）。"""


def _load_timeline_cache() -> dict | None:
    """读取 Hub 上合并后的时间线缓存；不存在或无效返回 None；其它错误抛出 TimelineCacheLoadError。"""
    if not _HF_TOKEN:
        return None
    try:
        from huggingface_hub import hf_hub_download
        from huggingface_hub.errors import EntryNotFoundError

        from backend.platform.hf_hub_endpoint import hf_hub_endpoint

        path = hf_hub_download(
            repo_id=_HF_REPO,
            filename=_HF_TIMELINE_CACHE_FILE,
            repo_type="dataset",
            token=_HF_TOKEN,
            endpoint=hf_hub_endpoint(),
        )
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
    except EntryNotFoundError:
        return None
    except json.JSONDecodeError as e:
        print(f"[访问统计] 时间线缓存 JSON 无效: {e}", flush=True)
        return None
    except Exception as e:
        print(f"[访问统计] 读取时间线缓存失败: {e}", flush=True)
        raise TimelineCacheLoadError(str(e)) from e
    ver = data.get("schema_version")
    if ver not in _TIMELINE_CACHE_SCHEMA_LEGACY:
        return None
    through = data.get("through_saved_at")
    prev_end = data.get("prev_end")
    av = data.get("active_visits_by_hour")
    active_sec = data.get("active_sec_by_hour")
    if not through or not prev_end or not isinstance(av, dict):
        return None
    if not isinstance(active_sec, dict):
        active_sec = {}
    try:
        _parse_utc_ts(str(through))
        _parse_utc_ts(str(prev_end))
    except ValueError:
        return None
    if ver != _TIMELINE_CACHE_SCHEMA:
        print(
            f"[访问统计] 时间线缓存 schema v{ver} → v{_TIMELINE_CACHE_SCHEMA}（读入后下次写入升级）",
            flush=True,
        )
    return {
        "through_saved_at": through,
        "prev_end": prev_end,
        "active_visits_by_hour": av,
        "active_sec_by_hour": active_sec,
    }


def _save_timeline_cache(
    through_saved_at: str,
    prev_end: datetime,
    merged_av: Mapping[str, int],
    merged_as: Mapping[str, int],
) -> bool:
    """将 Hub delta 合并结果写入缓存（不含本进程 pending）；同路径 upload 覆盖 bins.json。"""
    record = {
        "schema_version": _TIMELINE_CACHE_SCHEMA,
        "through_saved_at": through_saved_at,
        "prev_end": prev_end.strftime(_STATS_UTC_HOUR_FMT),
        "active_visits_by_hour": {k: int(v) for k, v in merged_av.items()},
        "active_sec_by_hour": {k: int(v) for k, v in merged_as.items()},
    }
    ok = _upload_dataset_record(_HF_TIMELINE_CACHE_FILE, record)
    if ok:
        print(
            f"[访问统计] 时间线缓存已更新 through={through_saved_at} "
            f"hours={len(set(merged_av) | set(merged_as))}",
            flush=True,
        )
    return ok


def _merge_delta_records_into_timeline(
    records: list[dict],
    merged_av: dict[str, int],
    merged_as: dict[str, int],
    prev_end: datetime | None,
) -> tuple[datetime | None, str | None]:
    """将 delta 记录摊入小时桶；返回 (prev_end, 最后一条 saved_at)。

    区间 (start, end] 对应自上次 persist 以来的增量；persist 可能因无增量而跳过，
    故相邻 delta 间隔可 >1h，不得用 end - _STATS_PERIOD 截断窗口。
    """
    through: str | None = None
    for rec in sorted(records, key=lambda r: r["saved_at"]):
        end = _parse_utc_ts(rec["saved_at"])
        start = end - _STATS_PERIOD if prev_end is None else prev_end
        for k, v in _distribute_count_to_hours(start, end, rec["active_visits"]).items():
            merged_av[k] += v
        for k, v in _distribute_count_to_hours(start, end, rec["active_sec"]).items():
            merged_as[k] += v
        prev_end = end
        through = rec["saved_at"]
    return prev_end, through


def _read_one_stats_delta(path: str) -> dict | None:
    try:
        from huggingface_hub import hf_hub_download

        from backend.platform.hf_hub_endpoint import hf_hub_endpoint

        local = hf_hub_download(
            repo_id=_HF_REPO,
            filename=path,
            repo_type="dataset",
            token=_HF_TOKEN,
            endpoint=hf_hub_endpoint(),
        )
        with open(local, encoding="utf-8") as f:
            rec = json.load(f)
        raw_saved_at = rec.get("saved_at")
        saved_at = (
            str(raw_saved_at).strip()
            if raw_saved_at
            else _saved_at_from_delta_path(path)
        )
        saved_at_norm = _parse_utc_ts(saved_at).strftime(_STATS_UTC_HOUR_FMT)
        return {
            "saved_at": saved_at_norm,
            "active_visits": int(rec.get("active_visits") or 0),
            "active_sec": _sum_page_sec(rec.get("page_sec")),
        }
    except Exception as e:
        print(f"[访问统计] 读取 {path} 失败: {e}", flush=True)
        return None


def _load_stats_delta_records(delta_paths: list[str]) -> tuple[list[dict], bool]:
    """下载指定 stats_delta 路径，按 saved_at 升序返回；(records, 是否全部成功)。"""
    if not _HF_TOKEN or not delta_paths:
        return [], True
    workers = min(_DELTA_DL_WORKERS, len(delta_paths))
    records: list[dict] = []
    failed = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {pool.submit(_read_one_stats_delta, path): path for path in delta_paths}
        for fut in as_completed(futures):
            rec = fut.result()
            if rec is not None:
                records.append(rec)
            else:
                failed += 1
    records.sort(key=lambda r: r["saved_at"])
    return records, failed == 0


def get_active_visits_timeline() -> dict:
    """按 UTC 整点小时汇总 active_visits / active_sec（stats_delta + 本进程未持久化增量）。"""
    if not _HF_TOKEN:
        return {"success": False, "error": "HF_TOKEN_stats_write not configured"}

    try:
        cache = _load_timeline_cache()
    except TimelineCacheLoadError as e:
        return {"success": False, "error": f"timeline cache load failed: {e}"}

    all_delta_paths = _list_stats_delta_paths()
    merged_av: dict[str, int] = defaultdict(int)
    merged_as: dict[str, int] = defaultdict(int)
    prev_end: datetime | None = None

    if cache:
        merged_av.update({k: int(v) for k, v in cache["active_visits_by_hour"].items()})
        merged_as.update({k: int(v) for k, v in cache["active_sec_by_hour"].items()})
        prev_end = _parse_utc_ts(str(cache["prev_end"]))
        through_ts = _parse_utc_ts(str(cache["through_saved_at"]))
        paths_to_load = [p for p in all_delta_paths if _delta_path_after_through(p, through_ts)]
        if paths_to_load:
            print(
                f"[访问统计] 时间线：缓存 through={cache['through_saved_at']}，"
                f"增量 {len(paths_to_load)}/{len(all_delta_paths)} 个 delta",
                flush=True,
            )
    else:
        paths_to_load = all_delta_paths
        if all_delta_paths:
            print(
                f"[访问统计] 时间线：无缓存，全量 {len(all_delta_paths)} 个 delta",
                flush=True,
            )

    hub_through_before = str(cache["through_saved_at"]) if cache else None
    if paths_to_load:
        new_records, deltas_ok = _load_stats_delta_records(paths_to_load)
        if not deltas_ok:
            n_fail = len(paths_to_load) - len(new_records)
            print(f"[访问统计] 时间线：{n_fail} 个 delta 读取失败", flush=True)
            return {
                "success": False,
                "error": f"stats_delta load incomplete ({n_fail} failed)",
            }
        prev_end, hub_through = _merge_delta_records_into_timeline(
            new_records, merged_av, merged_as, prev_end,
        )
        if (
            hub_through is not None
            and prev_end is not None
            and hub_through != hub_through_before
            and not _save_timeline_cache(hub_through, prev_end, merged_av, merged_as)
        ):
            print(f"[访问统计] 时间线缓存写入失败 through={hub_through}", flush=True)
            return {
                "success": False,
                "error": "timeline cache persist failed",
            }

    sample = _sample_locked_counters()
    now = datetime.now(timezone.utc)
    raw_start = _base.get("saved_at") or _process_start_at
    pending_start = (
        _parse_utc_ts(str(raw_start)) if raw_start else (now - _STATS_PERIOD)
    )
    pending_av = sample["sw_av"]
    if pending_av > 0:
        for k, v in _distribute_count_to_hours(pending_start, now, pending_av).items():
            merged_av[k] += v
    pending_as = _sum_page_sec(sample["session_page_sec"])
    if pending_as > 0:
        for k, v in _distribute_count_to_hours(pending_start, now, pending_as).items():
            merged_as[k] += v

    hours = sorted(set(merged_av) | set(merged_as))
    bins = [
        {
            "hour": h,
            "active_visits": merged_av.get(h, 0),
            "active_sec": merged_as.get(h, 0),
        }
        for h in hours
    ]
    return {"success": True, "bins": bins}


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
    _process_start_at = datetime.now(timezone.utc).strftime(_STATS_UTC_HOUR_FMT)
    _report_restart_event()
    while True:
        time.sleep(_STATS_PERIOD.total_seconds())
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
